// Firestore Security Rules tests. Run with: npm run test:emulator (needs Java for the emulator).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc } = require('firebase/firestore');

const PROJECT_ID = 'demo-voicecart';
let env;

const profile = (uid, extra = {}) => ({
  uid, email: `${uid}@example.com`, name: uid, cart: [], wishlist: [], wallet: 0, purchaseHistory: [], ...extra,
});

test.before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'firestore.rules'), 'utf8'), host, port: Number(port) },
  });
});

test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'alice'), profile('alice', { wallet: 500 }));
    await setDoc(doc(db, 'users', 'legacyRandomId'), profile('bob', { wallet: 300, admin: false }));
    await setDoc(doc(db, 'products', 'p1'), { name: 'Nike Air Force 1', price: 9000, category: ['shoes', 'casual', 'nike'], image: [], description: 'd', rating: 5 });
    await setDoc(doc(db, 'orders', 'alice_order1'), { uid: 'alice', total: 10 });
  });
});

test.after(async () => {
  await env.cleanup();
});

const as = (uid, claims = {}) => env.authenticatedContext(uid, { email: `${uid}@example.com`, ...claims }).firestore();

test('guests can read products but not users, orders or write anything', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(db, 'products', 'p1')));
  await assertFails(getDoc(doc(db, 'users', 'alice')));
  await assertFails(getDoc(doc(db, 'orders', 'alice_order1')));
  await assertFails(setDoc(doc(db, 'products', 'p2'), { name: 'x' }));
});

test('users read only their own profile, including legacy random-id profiles', async () => {
  await assertSucceeds(getDoc(doc(as('alice'), 'users', 'alice')));
  await assertFails(getDoc(doc(as('alice'), 'users', 'legacyRandomId')));
  await assertSucceeds(getDocs(query(collection(as('bob'), 'users'), where('uid', '==', 'bob'))));
  await assertFails(getDocs(collection(as('alice'), 'users')));
  // A new user can check for a not-yet-created profile, but not someone else's.
  await assertSucceeds(getDoc(doc(as('newbie'), 'users', 'newbie')));
  await assertFails(getDoc(doc(as('newbie'), 'users', 'alice')));
});

test('users cannot make themselves admin or change their wallet or purchase history', async () => {
  const db = as('alice');
  await assertFails(updateDoc(doc(db, 'users', 'alice'), { admin: true }));
  await assertFails(updateDoc(doc(db, 'users', 'alice'), { wallet: 1000000 }));
  await assertFails(updateDoc(doc(db, 'users', 'alice'), { purchaseHistory: [{ name: 'free' }] }));
  await assertFails(updateDoc(doc(db, 'users', 'alice'), { uid: 'bob' }));
  await assertFails(updateDoc(doc(as('bob'), 'users', 'legacyRandomId'), { admin: true }));
  await assertFails(deleteDoc(doc(db, 'users', 'alice')));
});

test('users can update their own cart, wishlist and name only', async () => {
  await assertSucceeds(updateDoc(doc(as('alice'), 'users', 'alice'), { cart: [{ id: 'p1', name: 'Nike Air Force 1', quantity: 2 }] }));
  await assertSucceeds(updateDoc(doc(as('bob'), 'users', 'legacyRandomId'), { wishlist: [{ name: 'x' }], name: 'Bob' }));
  await assertFails(updateDoc(doc(as('alice'), 'users', 'legacyRandomId'), { cart: [] }));
});

test('older profiles missing fields can still update their cart, but limits still apply', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'oldDoc'), { uid: 'olduser', email: 'o@example.com', cart: [], wallet: 50 });
  });
  await assertSucceeds(updateDoc(doc(as('olduser'), 'users', 'oldDoc'), { cart: [{ name: 'x', quantity: 1 }] }));
  await assertSucceeds(updateDoc(doc(as('olduser'), 'users', 'oldDoc'), { wishlist: [] }));
  await assertFails(updateDoc(doc(as('olduser'), 'users', 'oldDoc'), { cart: Array.from({ length: 51 }, () => ({ name: 'x' })) }));
  await assertFails(updateDoc(doc(as('olduser'), 'users', 'oldDoc'), { name: 'n'.repeat(81) }));
});

test('profile creation: own uid only, zero wallet, no admin field', async () => {
  await assertSucceeds(setDoc(doc(as('carol'), 'users', 'carol'), profile('carol')));
  await assertFails(setDoc(doc(as('dave'), 'users', 'dave'), profile('dave', { wallet: 1000 })));
  await assertFails(setDoc(doc(as('dave'), 'users', 'dave'), profile('dave', { admin: true })));
  await assertFails(setDoc(doc(as('dave'), 'users', 'erin'), profile('erin')));
  await assertFails(setDoc(doc(as('dave'), 'users', 'dave'), profile('dave', { email: 'someone-else@example.com' })));
  await assertFails(addDoc(collection(as('dave'), 'users'), profile('dave')));
});

test('only the admin claim can manage products and read all users', async () => {
  const product = { name: 'New', price: 10, category: ['food', 'snacks', 'x'], image: [], description: 'd', rating: 4 };
  await assertFails(setDoc(doc(as('alice'), 'products', 'p9'), product));
  await assertFails(updateDoc(doc(as('alice'), 'products', 'p1'), { price: 1 }));
  await assertFails(deleteDoc(doc(as('alice'), 'products', 'p1')));

  const admin = as('root', { admin: true });
  await assertSucceeds(setDoc(doc(admin, 'products', 'p9'), product));
  await assertFails(setDoc(doc(admin, 'products', 'p10'), { ...product, price: -1 }));
  await assertSucceeds(deleteDoc(doc(admin, 'products', 'p9')));
  await assertSucceeds(getDocs(collection(admin, 'users')));
});

test('nobody can write orders or wallet transactions from the browser', async () => {
  await assertFails(setDoc(doc(as('alice'), 'orders', 'x'), { uid: 'alice', total: 0 }));
  await assertFails(setDoc(doc(as('root', { admin: true }), 'orders', 'x'), { uid: 'alice', total: 0 }));
  await assertFails(setDoc(doc(as('alice'), 'walletTransactions', 'x'), { uid: 'alice', amount: 1000 }));
  await assertSucceeds(getDoc(doc(as('alice'), 'orders', 'alice_order1')));
  await assertFails(getDoc(doc(as('bob'), 'orders', 'alice_order1')));
});
