#!/usr/bin/env node
// Copies the public product catalog of one Firebase project (read through the public Firestore
// REST API, no credentials) into the project configured in the server environment, for example to
// fill a staging project. Document ids are kept, existing target documents are never overwritten,
// and copying into the source project itself is refused. Nothing but products is copied.
// Dry run by default.
//
//   FIREBASE_PROJECT_ID=<staging> npm run copy-catalog -- --from e-commerce-website-69
//   FIREBASE_PROJECT_ID=<staging> npm run copy-catalog -- --from e-commerce-website-69 --apply

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initFirebaseAdmin } = require('../src/firebaseAdmin');

const BATCH_LIMIT = 400;

/** Converts a Firestore REST value to a plain value; unknown types stop the copy instead of corrupting data. */
function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  throw new Error(`Unsupported field type ${Object.keys(v).join(', ')}; copy this catalog with a Firestore export instead.`);
}

const decodeFields = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));

async function fetchPublicProducts(sourceProject, fetchImpl = fetch) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(sourceProject)}/databases/(default)/documents/products?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Reading products from ${sourceProject} failed (HTTP ${res.status}).`);
    const page = await res.json();
    for (const d of page.documents || []) docs.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields || {}) });
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function copyCatalog(db, { sourceProject, targetProject, apply = false, fetchImpl = fetch, log = console.log }) {
  if (!sourceProject) throw new Error('Pass --from <source-project-id>.');
  if (!targetProject) throw new Error('Set FIREBASE_PROJECT_ID to the target (e.g. staging) project.');
  if (sourceProject === targetProject) throw new Error('Source and target are the same project; refusing to copy.');

  const source = await fetchPublicProducts(sourceProject, fetchImpl);
  const existing = new Set((await db.collection('products').select().get()).docs.map((d) => d.id));
  const toCopy = source.filter((d) => !existing.has(d.id));
  log(`${source.length} products in ${sourceProject}; ${existing.size} already in ${targetProject}; ${toCopy.length} to copy${apply ? '' : ' (dry run; pass --apply to write)'}.`);
  if (!apply) return { source: source.length, skipped: source.length - toCopy.length, copied: 0 };

  for (let i = 0; i < toCopy.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    toCopy.slice(i, i + BATCH_LIMIT).forEach((d) => batch.create(db.collection('products').doc(d.id), d.data));
    await batch.commit();
  }
  log(`Copied ${toCopy.length} products into ${targetProject}.`);
  return { source: source.length, skipped: source.length - toCopy.length, copied: toCopy.length };
}

async function main() {
  const args = process.argv.slice(2);
  const from = args[args.indexOf('--from') + 1];
  const firebase = initFirebaseAdmin();
  if (!firebase) {
    console.error('Firebase Admin is not configured. Set FIREBASE_ADMIN_USE_ADC=true or GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }
  await copyCatalog(firebase.db, {
    sourceProject: args.includes('--from') ? from : '',
    targetProject: process.env.FIREBASE_PROJECT_ID,
    apply: args.includes('--apply'),
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { copyCatalog, decodeValue };
