// scripts/dedupe-products.js against the Firestore emulator (never a real project).
process.env.FIREBASE_PROJECT_ID = 'demo-voicecart';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initFirebaseAdmin } = require('../../src/firebaseAdmin');
const { runDedupe, stableStringify } = require('../../scripts/dedupe-products');

const { db } = initFirebaseAdmin();
const quiet = { log: () => {}, warn: () => {} };
const shoe = { name: 'Vans Old Skool', price: 4000, category: ['shoes', 'casual', 'vans'], image: ['/images/vans1.PNG'], description: 'd', size: ['7', '8'] };
const exists = async (id) => (await db.collection('products').doc(id).get()).exists;

test.before(async () => {
  // Start from an empty database so the counts below are exact.
  const res = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-voicecart/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  await db.collection('products').doc('a1').set(shoe);
  await db.collection('products').doc('a2').set({ ...shoe });
  await db.collection('products').doc('a3').set({ description: 'd', ...shoe }); // same fields, different key order
  // Differ only in a field the old fingerprint ignored: both must survive.
  await db.collection('products').doc('c1').set({ ...shoe, name: 'Nike Blazer', color: ['black'] });
  await db.collection('products').doc('c2').set({ ...shoe, name: 'Nike Blazer', color: ['white'] });
  await db.collection('users').doc('u1').set({
    uid: 'u1', email: 'u1@example.com', name: 'U', wallet: 0, purchaseHistory: [],
    cart: [{ id: 'a3', name: shoe.name, size: '8', quantity: 1 }, { id: 'c2', name: 'Nike Blazer', quantity: 1 }],
    wishlist: [{ id: 'a2', name: shoe.name }],
  });
  await db.collection('orders').doc('u1_k1').set({ uid: 'u1', items: [{ productId: 'a2', name: shoe.name, unitPrice: 4000, quantity: 1 }] });
});

test('field order does not change the fingerprint', () => {
  assert.equal(stableStringify({ a: 1, b: [1, { c: 2, d: 3 }] }), stableStringify({ b: [1, { d: 3, c: 2 }], a: 1 }));
});

test('dry run reports exact copies and affected carts but changes nothing', async () => {
  const summary = await runDedupe(db, { ...quiet });
  assert.deepEqual(
    { documents: summary.documents, distinct: summary.distinct, duplicates: summary.duplicates, lines: summary.referencingLines, profiles: summary.referencingProfiles, applied: summary.applied },
    { documents: 5, distinct: 3, duplicates: 2, lines: 2, profiles: 1, applied: false }
  );
  // The review: which copy stays, what needs a person, what points at the copies, and the cost.
  assert.deepEqual(summary.report.groups, [{ name: 'Vans Old Skool', keep: 'a1', remove: ['a2', 'a3'] }]);
  assert.deepEqual(summary.report.review, [{
    name: 'Nike Blazer', differingFields: ['colors'], versions: [{ ids: ['c1'], colors: ['black'] }, { ids: ['c2'], colors: ['white'] }],
  }]);
  assert.equal(summary.orderLines, 1);
  assert.deepEqual(summary.report.references, { cartAndWishlistLines: 2, profiles: ['u1'], orderLines: 1 });
  assert.deepEqual(summary.report.estimate, { reads: 5 + 1 + 1, writes: 1 + 2 });
  assert.doesNotMatch(JSON.stringify(summary.report), /u1@example\.com/);
  for (const id of ['a1', 'a2', 'a3', 'c1', 'c2']) assert.equal(await exists(id), true, id);
  assert.equal((await db.collection('users').doc('u1').get()).data().cart[0].id, 'a3');
});

test('apply backs up first, re-points carts and wishlists, then deletes only identical copies', async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
  const summary = await runDedupe(db, { ...quiet, apply: true, backupDir });
  assert.equal(summary.applied, true);
  assert.deepEqual([await exists('a1'), await exists('a2'), await exists('a3'), await exists('c1'), await exists('c2')], [true, false, false, true, true]);

  const profile = (await db.collection('users').doc('u1').get()).data();
  assert.deepEqual(profile.cart.map((l) => l.id), ['a1', 'c2']);
  assert.equal(profile.cart[0].size, '8');
  assert.deepEqual(profile.wishlist.map((l) => l.id), ['a1']);

  const backup = JSON.parse(fs.readFileSync(summary.backupFile, 'utf8'));
  assert.deepEqual(backup.deletedProducts.map((p) => [p.id, p.keptId]).sort(), [['a2', 'a1'], ['a3', 'a1']]);
  assert.deepEqual(backup.deletedProducts[0].data.size, ['7', '8']);
  assert.equal(backup.changedProfiles[0].cart[0].id, 'a3');
  assert.equal(fs.statSync(summary.backupFile).mode & 0o777, 0o600);

  // Running again finds nothing to do.
  assert.equal((await runDedupe(db, { ...quiet, apply: true, backupDir })).duplicates, 0);
  fs.rmSync(backupDir, { recursive: true, force: true });
});
