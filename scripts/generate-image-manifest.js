#!/usr/bin/env node
// Writes src/imageManifest.json: lower-case file name -> real file name for public/images.
// Product records in Firestore use ".png" while many files are ".PNG"; Linux hosting is
// case-sensitive, so the app maps paths through this manifest (see src/services/images.js).
// Runs automatically before `npm start`, `npm run build` and `npm test`.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'images');
const manifest = {};
for (const file of fs.readdirSync(dir).sort()) {
    if (!file.startsWith('.')) manifest[file.toLowerCase()] = file;
}
// Written only when the files changed: rewriting it makes every running dev server recompile.
const target = path.join(__dirname, '..', 'src', 'imageManifest.json');
const content = `${JSON.stringify(manifest, null, 2)}\n`;
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
if (current !== content) fs.writeFileSync(target, content);
console.log(`Image manifest: ${Object.keys(manifest).length} files${current === content ? ' (unchanged)' : ''}.`);
