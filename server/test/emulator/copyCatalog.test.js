// scripts/copy-catalog.js against the Firestore emulator, with a fake source project.
process.env.FIREBASE_PROJECT_ID = 'demo-voicecart';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initFirebaseAdmin } = require('../../src/firebaseAdmin');
const { copyCatalog, decodeValue } = require('../../scripts/copy-catalog');

const { db } = initFirebaseAdmin();
const quiet = { log: () => {} };
const restDoc = (id, name, price) => ({
  name: `projects/source/databases/(default)/documents/products/${id}`,
  fields: {
    name: { stringValue: name },
    price: { integerValue: String(price) },
    rating: { doubleValue: 4.5 },
    size: { arrayValue: { values: [{ stringValue: '7' }, { stringValue: '8' }] } },
    category: { arrayValue: { values: [{ stringValue: 'shoes' }, { stringValue: 'casual' }, { stringValue: 'vans' }] } },
  },
});
// Two pages, like the real REST API.
const fakeFetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => (url.includes('pageToken=')
    ? { documents: [restDoc('cp2', 'Copy Two', 200)] }
    : { documents: [restDoc('cp1', 'Copy One', 100), restDoc('cpKeep', 'Source Version', 1)], nextPageToken: 'next' }),
});

test('refuses to copy a project into itself or without a source', async () => {
  await assert.rejects(copyCatalog(db, { ...quiet, sourceProject: 'demo-voicecart', targetProject: 'demo-voicecart', fetchImpl: fakeFetch }), /same project/);
  await assert.rejects(copyCatalog(db, { ...quiet, sourceProject: '', targetProject: 'demo-voicecart', fetchImpl: fakeFetch }), /--from/);
});

test('unknown REST field types stop the copy', () => {
  assert.throws(() => decodeValue({ geoPointValue: { latitude: 1, longitude: 2 } }), /Unsupported/);
});

test('dry run writes nothing; apply copies missing products with their ids and never overwrites', async () => {
  await db.collection('products').doc('cpKeep').set({ name: 'Target Version', price: 999 });

  const dry = await copyCatalog(db, { ...quiet, sourceProject: 'source', targetProject: 'demo-voicecart', fetchImpl: fakeFetch });
  assert.deepEqual(dry, { source: 3, skipped: 1, copied: 0 });
  assert.equal((await db.collection('products').doc('cp1').get()).exists, false);

  const applied = await copyCatalog(db, { ...quiet, sourceProject: 'source', targetProject: 'demo-voicecart', fetchImpl: fakeFetch, apply: true });
  assert.deepEqual(applied, { source: 3, skipped: 1, copied: 2 });
  const cp1 = (await db.collection('products').doc('cp1').get()).data();
  assert.deepEqual(cp1, { name: 'Copy One', price: 100, rating: 4.5, size: ['7', '8'], category: ['shoes', 'casual', 'vans'] });
  assert.equal((await db.collection('products').doc('cp2').get()).data().name, 'Copy Two');
  assert.equal((await db.collection('products').doc('cpKeep').get()).data().name, 'Target Version');
});
