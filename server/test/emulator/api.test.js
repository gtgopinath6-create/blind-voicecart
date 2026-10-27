// End-to-end API tests against the Firestore and Auth emulators.
// Run with: npm run test:emulator (needs Java for the emulators).
process.env.FIREBASE_PROJECT_ID = 'demo-voicecart';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFirebaseAdmin } = require('../../src/firebaseAdmin');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');

const firebase = initFirebaseAdmin();
const { db, auth } = firebase;
let server;
let base;

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const shipping = { customerMobile: '9876543210', customerAddress: '12 MG Road', customerCity: 'Pune', customerState: 'MH', customerPincode: '411001' };
const key = (s) => `test-key-${s}-${Math.random().toString(36).slice(2, 10)}`;

async function idTokenFor(email, password = 'password123') {
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!data.idToken) throw new Error(`sign-in failed: ${JSON.stringify(data)}`);
  return data.idToken;
}

async function makeUser(name, { wallet = 0, cart = [], admin = false, legacyId = null } = {}) {
  const email = `${name}-${Date.now()}@example.com`;
  const user = await auth.createUser({ email, password: 'password123', displayName: name });
  if (admin) await auth.setCustomUserClaims(user.uid, { admin: true });
  const docId = legacyId || user.uid;
  await db.collection('users').doc(docId).set({ uid: user.uid, email, name, cart, wishlist: [], wallet, purchaseHistory: [] });
  return { uid: user.uid, email, docId, token: await idTokenFor(email) };
}

const call = (method, path, token, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const wallet = async (docId) => (await db.collection('users').doc(docId).get()).data().wallet;
const ordersOf = async (uid) => (await db.collection('orders').where('uid', '==', uid).get()).size;

test.before(async () => {
  await db.collection('products').doc('af1').set({ name: 'Nike Air Force 1', price: 9000, category: ['shoes', 'casual', 'nike'], image: [], description: 'd' });
  await db.collection('products').doc('chips').set({ name: 'Chilli Chatka', price: 15, stock: 3, category: ['food', 'dry snacks', 'kurkure'], image: [], description: 'd' });
  const app = createApp({ config: loadConfig({ ALLOW_DEV_WALLET_CREDIT: 'true', FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST }), firebase });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('checkout uses server prices, not the price stored in the cart by the browser', async () => {
  const u = await makeUser('pricetamper', { wallet: 20000, cart: [{ id: 'af1', name: 'Nike Air Force 1', price: 1, quantity: 1 }] });
  const res = await call('POST', '/api/checkout', u.token, { idempotencyKey: key('a'), shipping });
  assert.equal(res.status, 201);
  const { order } = await res.json();
  assert.equal(order.subtotal, 9000);
  assert.equal(order.total, 10620);
  assert.equal(await wallet(u.docId), 20000 - 10620);
  const profile = (await db.collection('users').doc(u.docId).get()).data();
  assert.deepEqual(profile.cart, []);
  assert.equal(profile.purchaseHistory.length, 1);
});

test('repeated and concurrent checkout requests with one key create one order and one charge', async () => {
  const u = await makeUser('doubleclick', { wallet: 50000, cart: [{ id: 'af1', name: 'Nike Air Force 1', quantity: 1 }] });
  const k = key('dup');
  const results = await Promise.all([1, 2, 3].map(() => call('POST', '/api/checkout', u.token, { idempotencyKey: k, shipping })));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), results.map((r) => r.status).join());
  const again = await call('POST', '/api/checkout', u.token, { idempotencyKey: k, shipping });
  assert.equal((await again.json()).order.duplicate, true);
  assert.equal(await ordersOf(u.uid), 1);
  assert.equal(await wallet(u.docId), 50000 - 10620);
});

test('checkout rejects empty carts, invalid products, bad quantities, low balance, stock and bad shipping', async () => {
  const empty = await makeUser('empty', { wallet: 100 });
  assert.equal((await call('POST', '/api/checkout', empty.token, { idempotencyKey: key('e'), shipping })).status, 400);

  const ghost = await makeUser('ghost', { wallet: 100000, cart: [{ id: 'does-not-exist', name: 'Imaginary Shoe', price: 1, quantity: 1 }] });
  assert.equal((await call('POST', '/api/checkout', ghost.token, { idempotencyKey: key('g'), shipping })).status, 409);

  const qty = await makeUser('qty', { wallet: 100000, cart: [{ id: 'af1', name: 'Nike Air Force 1', quantity: -2 }] });
  assert.equal((await call('POST', '/api/checkout', qty.token, { idempotencyKey: key('q'), shipping })).status, 400);

  const poor = await makeUser('poor', { wallet: 100, cart: [{ id: 'af1', name: 'Nike Air Force 1', quantity: 1 }] });
  assert.equal((await call('POST', '/api/checkout', poor.token, { idempotencyKey: key('p'), shipping })).status, 402);
  assert.equal(await wallet(poor.docId), 100);

  const greedy = await makeUser('greedy', { wallet: 1000, cart: [{ id: 'chips', name: 'Chilli Chatka', quantity: 4 }] });
  assert.equal((await call('POST', '/api/checkout', greedy.token, { idempotencyKey: key('s'), shipping })).status, 409);

  const noAddress = await makeUser('noaddr', { wallet: 100000, cart: [{ id: 'af1', name: 'Nike Air Force 1', quantity: 1 }] });
  const bad = await call('POST', '/api/checkout', noAddress.token, { idempotencyKey: key('n'), shipping: { ...shipping, customerPincode: '1' } });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error.fields.customerPincode);
  assert.equal(await ordersOf(noAddress.uid), 0);
});

test('stock is decremented and legacy random-id profiles with name-only cart lines still work', async () => {
  const u = await makeUser('legacy', { wallet: 1000, cart: [{ name: 'Chilli Chatka', price: 0, quantity: 2 }], legacyId: 'randomLegacyDoc123' });
  const res = await call('POST', '/api/checkout', u.token, { idempotencyKey: key('l'), shipping });
  assert.equal(res.status, 201);
  assert.equal((await db.collection('products').doc('chips').get()).data().stock, 1);
  assert.equal(await wallet('randomLegacyDoc123'), Math.round((1000 - 35.4) * 100) / 100);
});

test('name-only cart lines: identical duplicates are accepted, same name with different prices is rejected', async () => {
  await db.collection('products').doc('dupA').set({ name: 'Puffcorn', price: 20, category: ['food', 'dry snacks', 'kurkure'], image: [], description: 'd' });
  await db.collection('products').doc('dupB').set({ name: 'Puffcorn', price: 20, category: ['food', 'dry snacks', 'kurkure'], image: [], description: 'd' });
  const ok = await makeUser('dupok', { wallet: 1000, cart: [{ name: 'Puffcorn', quantity: 1 }] });
  assert.equal((await call('POST', '/api/checkout', ok.token, { idempotencyKey: key('d1'), shipping })).status, 201);

  await db.collection('products').doc('conflict1').set({ name: 'Mystery Box', price: 100, category: ['food', 'x', 'y'], image: [], description: 'd' });
  await db.collection('products').doc('conflict2').set({ name: 'Mystery Box', price: 5, category: ['food', 'x', 'y'], image: [], description: 'd' });
  const bad = await makeUser('dupbad', { wallet: 1000, cart: [{ name: 'Mystery Box', quantity: 1 }] });
  assert.equal((await call('POST', '/api/checkout', bad.token, { idempotencyKey: key('d2'), shipping })).status, 409);
});

test('products with size/colour options need a valid choice of each', async () => {
  await db.collection('products').doc('shoeV').set({ name: 'Variant Shoe', price: 1000, size: ['6', '7'], color: ['red', 'black'], category: ['shoes', 'casual', 'x'], image: [], description: 'd' });
  const missing = await makeUser('nosize', { wallet: 5000, cart: [{ id: 'shoeV', name: 'Variant Shoe', quantity: 1, color: 'red' }] });
  const r1 = await call('POST', '/api/checkout', missing.token, { idempotencyKey: key('v1'), shipping });
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).error.code, 'variant_required');

  const invalid = await makeUser('badcolor', { wallet: 5000, cart: [{ id: 'shoeV', name: 'Variant Shoe', quantity: 1, size: '7', color: 'purple' }] });
  const r2 = await call('POST', '/api/checkout', invalid.token, { idempotencyKey: key('v2'), shipping });
  assert.equal((await r2.json()).error.code, 'invalid_variant');

  const ok = await makeUser('goodvariant', { wallet: 5000, cart: [{ id: 'shoeV', name: 'Variant Shoe', quantity: 1, size: '7', color: 'black' }] });
  const r3 = await call('POST', '/api/checkout', ok.token, { idempotencyKey: key('v3'), shipping });
  assert.equal(r3.status, 201);
  assert.deepEqual((({ size, color }) => ({ size, color }))((await r3.json()).order.items[0]), { size: '7', color: 'black' });

  const quote = await call('POST', '/api/checkout/quote', missing.token, {});
  assert.match((await quote.json()).problems.join(' '), /choose a size/i);
});

test('wallet refill (dev mock) validates amounts and never credits twice for one request', async () => {
  const u = await makeUser('refill', { wallet: 0 });
  for (const amount of [0, -100, 10.5, '500']) {
    assert.equal((await call('POST', '/api/wallet/refill', u.token, { amount, idempotencyKey: key('bad') })).status, 400, String(amount));
  }
  const k = key('r');
  const results = await Promise.all([1, 2].map(() => call('POST', '/api/wallet/refill', u.token, { amount: 500, idempotencyKey: k })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(await wallet(u.docId), 500);
  assert.equal((await db.collection('walletTransactions').where('uid', '==', u.uid).get()).size, 1);
});

test('admin user management: claim required, creation keeps caller session, deletion removes login and profile but keeps orders', async () => {
  const normal = await makeUser('normal');
  const admin = await makeUser('boss', { admin: true });
  assert.equal((await call('POST', '/api/admin/users', normal.token, { name: 'X', email: 'x@example.com', password: 'password123' })).status, 403);

  const created = await call('POST', '/api/admin/users', admin.token, { name: 'New Person', email: `new-${Date.now()}@example.com`, password: 'password123' });
  assert.equal(created.status, 201);
  const { user } = await created.json();
  const newProfile = (await db.collection('users').doc(user.uid).get()).data();
  assert.equal(newProfile.wallet, 0);
  assert.equal(newProfile.admin, undefined);
  // The admin's own token still works after creating someone.
  assert.equal((await call('POST', `/api/admin/users/${user.uid}/disable`, admin.token, {})).status, 200);
  assert.equal((await auth.getUser(user.uid)).disabled, true);

  await db.collection('orders').doc(`${user.uid}_keep`).set({ uid: user.uid, total: 1 });
  assert.equal((await call('DELETE', `/api/admin/users/${user.uid}`, admin.token)).status, 200);
  await assert.rejects(auth.getUser(user.uid));
  assert.equal((await db.collection('users').doc(user.uid).get()).exists, false);
  assert.equal((await db.collection('orders').doc(`${user.uid}_keep`).get()).exists, true);

  assert.equal((await call('DELETE', `/api/admin/users/${admin.uid}`, admin.token)).status, 400);
});

test('revoking the admin claim takes effect immediately', async () => {
  const admin = await makeUser('former', { admin: true });
  // Revocation time has 1-second resolution, so let the token's issue time fall behind it.
  await new Promise((r) => setTimeout(r, 1100));
  await auth.setCustomUserClaims(admin.uid, {});
  await auth.revokeRefreshTokens(admin.uid);
  const res = await call('POST', '/api/admin/users', admin.token, { name: 'X', email: 'y@example.com', password: 'password123' });
  assert.equal(res.status, 401);
});
