#!/usr/bin/env node
// Grants or revokes the trusted `admin` custom claim. Run by a project owner with
// service-account credentials; the browser can never set this claim.
//
//   npm run set-admin -- someone@example.com            # grant
//   npm run set-admin -- someone@example.com --revoke   # revoke (also ends their sessions)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initFirebaseAdmin } = require('../src/firebaseAdmin');

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: npm run set-admin -- <email> [--revoke]');
    process.exit(1);
  }
  const firebase = initFirebaseAdmin();
  if (!firebase) {
    console.error('Firebase Admin is not configured. Set FIREBASE_ADMIN_USE_ADC=true or GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }
  const revoke = flag === '--revoke';
  console.log(`Project: ${process.env.FIREBASE_PROJECT_ID || '(from credentials)'}`);
  const user = await firebase.auth.getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (revoke) delete claims.admin;
  else claims.admin = true;
  await firebase.auth.setCustomUserClaims(user.uid, claims);
  if (revoke) await firebase.auth.revokeRefreshTokens(user.uid);
  console.log(`${revoke ? 'Revoked' : 'Granted'} admin for ${email} (uid ${user.uid}).`);
  console.log(revoke ? 'Their existing sessions were ended.' : 'They must sign out and in again (or wait up to 1 hour) to get admin access.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
