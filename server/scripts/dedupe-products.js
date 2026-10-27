#!/usr/bin/env node
// Finds product documents that are exact copies of each other (every field identical, including
// fields such as colour or gender that the app may not show) and, with --apply, deletes all but one
// copy of each. The copy kept is the one with the smallest document id, which is also the copy the
// app displays. Products that share a name but differ in any field are reported and left alone.
//
// Dry run by default: reads products, users' carts/wishlists and orders, changes nothing.
// --report <file> also writes a JSON review: each group of copies and the copy kept, every product
// name stored in several *different* versions with the fields that differ (left alone: a person must
// decide), the cart/wishlist/order lines that point at copies that would go, and the reads and
// writes the run needs. It holds document ids and counts, no customer details.
// --apply needs --confirm-project <id> matching FIREBASE_PROJECT_ID, and then, in this order:
//   1. writes every document it will delete (and the carts/wishlists it will change) to
//      server/backups/ and stops if that fails;
//   2. re-points cart and wishlist lines from deleted copies to the kept copy;
//   3. deletes the extra copies.
// Make a full Firestore export as well before applying (see DEPLOYMENT.md).
//
//   npm run dedupe-products                                   # report only
//   npm run dedupe-products -- --report dedupe-review.json    # report, plus the JSON review
//   npm run dedupe-products -- --apply --confirm-project <id> # back up, re-point carts, delete the copies
//
// Orders are never changed: each order line keeps its own name, size, colour and price, so an order
// that names a deleted copy's id still reads correctly; the review counts such lines.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initFirebaseAdmin } = require('../src/firebaseAdmin');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const BATCH_LIMIT = 400;

/** Key-order independent JSON, so two documents match only when every field is identical. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.toMillis === 'function') return `ts:${value.seconds}.${value.nanoseconds}`;
    if (typeof value.path === 'string' && value.firestore) return `ref:${value.path}`;
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const linesOf = (data) => [...(Array.isArray(data.cart) ? data.cart : []), ...(Array.isArray(data.wishlist) ? data.wishlist : [])];

// Fields compared when one name is stored in several different versions.
const REVIEW_FIELDS = {
  price: (d) => d.price ?? null,
  brand: (d) => (Array.isArray(d.category) ? d.category[2] ?? null : null),
  category: (d) => d.category ?? null,
  sizes: (d) => d.size ?? null,
  colors: (d) => d.color ?? null,
  stock: (d) => d.stock ?? null,
  images: (d) => d.image ?? null,
  description: (d) => d.description ?? null,
  rating: (d) => d.rating ?? null,
};

/** Every name stored in more than one distinct version, with the fields that differ between them. */
function versionsToReview(groups) {
  const byName = new Map();
  for (const docs of groups.values()) {
    const name = docs[0].data().name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(docs);
  }
  const review = [];
  for (const [name, versions] of byName) {
    if (versions.length < 2) continue;
    const values = versions.map((docs) => Object.fromEntries(Object.entries(REVIEW_FIELDS).map(([f, get]) => [f, get(docs[0].data())])));
    const differingFields = Object.keys(REVIEW_FIELDS).filter((f) => new Set(values.map((v) => stableStringify(v[f]))).size > 1);
    review.push({
      name,
      differingFields,
      versions: versions.map((docs, i) => ({
        ids: docs.map((d) => d.id).sort(),
        ...Object.fromEntries(differingFields.map((f) => [f, f === 'description' && typeof values[i][f] === 'string' ? `${values[i][f].slice(0, 80)}…` : values[i][f]])),
      })),
    });
  }
  return review.sort((a, b) => (a.name < b.name ? -1 : 1));
}
const repoint = (list, keptFor) =>
  Array.isArray(list) ? list.map((l) => (l && keptFor.has(l.id) ? { ...l, id: keptFor.get(l.id) } : l)) : list;

async function runDedupe(db, { apply = false, backupDir = BACKUP_DIR, log = console.log, warn = console.warn, now = () => new Date() } = {}) {
  const snap = await db.collection('products').get();
  const groups = new Map();
  for (const doc of snap.docs) {
    const key = stableStringify(doc.data());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  const keptFor = new Map(); // deleted id -> kept id
  const toDelete = [];
  for (const docs of groups.values()) {
    if (docs.length < 2) continue;
    docs.sort((a, b) => (a.id < b.id ? -1 : 1));
    const [keep, ...remove] = docs;
    remove.forEach((d) => {
      keptFor.set(d.id, keep.id);
      toDelete.push(d);
    });
    log(`${keep.data().name}: keeping ${keep.id}, ${apply ? 'deleting' : 'would delete'} ${remove.length} identical cop${remove.length === 1 ? 'y' : 'ies'}`);
  }

  const review = versionsToReview(groups);
  review.forEach((r) => {
    warn(`! "${r.name}" exists in ${r.versions.length} different versions (differing: ${r.differingFields.join(', ')}); review these by hand.`);
  });

  // Carts and wishlists that point at a copy that would be deleted.
  const users = await db.collection('users').get();
  const affected = users.docs
    .map((doc) => ({ doc, lines: linesOf(doc.data()).filter((l) => l && keptFor.has(l.id)).length }))
    .filter((a) => a.lines > 0);
  const referencingLines = affected.reduce((n, a) => n + a.lines, 0);

  // Orders are not changed; count the order lines that name a copy that would be deleted.
  const orders = await db.collection('orders').get();
  const orderLines = orders.docs.reduce((n, o) => n + (Array.isArray(o.data().items) ? o.data().items.filter((l) => l && keptFor.has(l.productId)).length : 0), 0);

  const summary = {
    documents: snap.size,
    distinct: groups.size,
    duplicates: toDelete.length,
    referencingProfiles: affected.length,
    referencingLines,
    orderLines,
    namesToReview: review.length,
    backupFile: null,
    applied: false,
    report: {
      groups: [...groups.values()].filter((docs) => docs.length > 1).map((docs) => {
        const ids = docs.map((d) => d.id).sort();
        return { name: docs[0].data().name, keep: ids[0], remove: ids.slice(1) };
      }),
      review,
      references: { cartAndWishlistLines: referencingLines, profiles: affected.map((a) => a.doc.id), orderLines },
      // Firestore bills one read per document returned; writes are the profile updates and deletions --apply makes.
      estimate: { reads: snap.size + users.size + orders.size, writes: affected.length + toDelete.length },
    },
  };
  log(`${referencingLines} cart/wishlist line(s) in ${affected.length} profile(s) point at copies that would be deleted; --apply re-points them to the kept copy.`);
  log(`${orderLines} order line(s) name a copy that would be deleted; orders are not changed (each line keeps its own name and price).`);
  log(`This run read ${summary.report.estimate.reads} documents; --apply would write ${summary.report.estimate.writes}.`);

  if (!apply || toDelete.length === 0) {
    log(`${snap.size} product documents, ${groups.size} distinct products, ${toDelete.length} duplicate cop${toDelete.length === 1 ? 'y' : 'ies'} (${apply ? 'nothing to delete' : 'dry run; nothing was changed. Pass --apply to delete'}).`);
    return summary;
  }

  // 1. Local backup first; writing it must succeed before anything is changed.
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `products-dedupe-${now().toISOString().replace(/[:.]/g, '-')}.json`);
  const backup = {
    createdAt: now().toISOString(),
    deletedProducts: toDelete.map((d) => ({ id: d.id, keptId: keptFor.get(d.id), data: d.data() })),
    changedProfiles: affected.map(({ doc }) => ({ id: doc.id, cart: doc.data().cart ?? null, wishlist: doc.data().wishlist ?? null })),
  };
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
  summary.backupFile = file;
  log(`Backup written to ${file}`);

  // 2. Re-point carts/wishlists before deleting, so no line ever points at a missing product.
  for (const { doc } of affected) {
    await db.runTransaction(async (t) => {
      const data = (await t.get(doc.ref)).data() || {};
      const update = {};
      if (Array.isArray(data.cart)) update.cart = repoint(data.cart, keptFor);
      if (Array.isArray(data.wishlist)) update.wishlist = repoint(data.wishlist, keptFor);
      t.update(doc.ref, update);
    });
  }

  // 3. Delete the extra copies.
  for (let i = 0; i < toDelete.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    toDelete.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  summary.applied = true;
  log(`${snap.size} product documents, ${groups.size} distinct products, ${toDelete.length} duplicate cop${toDelete.length === 1 ? 'y' : 'ies'} deleted; ${affected.length} profile(s) re-pointed.`);
  return summary;
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const reportFile = argValue('--report');
  const project = (process.env.FIREBASE_PROJECT_ID || '').trim();
  if (apply && (!project || argValue('--confirm-project') !== project)) {
    console.error('Refusing to change data: --apply needs FIREBASE_PROJECT_ID set and --confirm-project <the same id>.');
    process.exit(1);
  }
  const firebase = initFirebaseAdmin();
  if (!firebase) {
    console.error('Firebase Admin is not configured. Set FIREBASE_ADMIN_USE_ADC=true or GOOGLE_APPLICATION_CREDENTIALS in server/.env.');
    process.exit(1);
  }
  console.log(`Project: ${process.env.FIREBASE_PROJECT_ID || '(from credentials)'}${apply ? ' - APPLYING CHANGES' : ' - dry run'}`);
  const summary = await runDedupe(firebase.db, { apply });
  if (reportFile !== null) {
    if (!reportFile) throw new Error('--report needs a file name.');
    fs.writeFileSync(reportFile, JSON.stringify({ project: project || null, createdAt: new Date().toISOString(), applied: summary.applied, ...summary.report }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Review written to ${reportFile}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { stableStringify, runDedupe };
