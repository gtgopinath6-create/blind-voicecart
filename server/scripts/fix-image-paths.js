#!/usr/bin/env node
// Fixes product image paths whose letter case does not match the files in public/images
// (e.g. "/images/vans1.png" vs "vans1.PNG"), which break on case-sensitive Linux hosting.
// Dry run by default; pass --apply to write the changes.
//
//   npm run fix-image-paths            # show what would change
//   npm run fix-image-paths -- --apply # update Firestore

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initFirebaseAdmin } = require('../src/firebaseAdmin');

const IMAGES_DIR = path.join(__dirname, '..', '..', 'public', 'images');

function buildFileIndex() {
  const index = new Map();
  for (const file of fs.readdirSync(IMAGES_DIR)) index.set(file.toLowerCase(), file);
  return index;
}

/** Returns the correctly cased path, the original path if it already exists, or null if no file matches. */
function resolvePath(imagePath, index) {
  if (typeof imagePath !== 'string' || !imagePath.startsWith('/images/')) return imagePath;
  const name = imagePath.slice('/images/'.length);
  const actual = index.get(name.toLowerCase());
  return actual ? `/images/${actual}` : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const firebase = initFirebaseAdmin();
  if (!firebase) {
    console.error('Firebase Admin is not configured. Set GOOGLE_APPLICATION_CREDENTIALS in server/.env.');
    process.exit(1);
  }
  const index = buildFileIndex();
  const snap = await firebase.db.collection('products').get();
  let changed = 0;
  for (const doc of snap.docs) {
    const images = Array.isArray(doc.data().image) ? doc.data().image : [];
    const fixed = images.map((p) => resolvePath(p, index));
    const missing = images.filter((p, i) => fixed[i] === null);
    if (missing.length) console.warn(`! ${doc.data().name}: no file for ${missing.join(', ')} (left unchanged)`);
    const next = fixed.map((p, i) => (p === null ? images[i] : p));
    if (next.some((p, i) => p !== images[i])) {
      changed += 1;
      console.log(`${apply ? 'Updating' : 'Would update'} ${doc.data().name}: ${images.join(', ')} -> ${next.join(', ')}`);
      if (apply) await doc.ref.update({ image: next });
    }
  }
  console.log(`${changed} product(s) ${apply ? 'updated' : 'need updating (dry run; pass --apply to write)'}.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { resolvePath, buildFileIndex };
