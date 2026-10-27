// Initializes the Firebase Admin SDK when credentials (or emulators) are available.
// Returns null otherwise, and the API answers account/checkout requests with 503
// instead of pretending they worked.
//
// Credentials, in order of preference for hosted servers:
//  - FIREBASE_ADMIN_USE_ADC=true: Application Default Credentials, e.g. the service account
//    attached to a Cloud Run service (no key file to leak);
//  - GOOGLE_APPLICATION_CREDENTIALS: path to a service-account JSON key file.

const admin = require('firebase-admin');

function initFirebaseAdmin(env = process.env) {
  const usingEmulator = Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST);
  const hasCredentials = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS) || String(env.FIREBASE_ADMIN_USE_ADC).toLowerCase() === 'true';
  if (!usingEmulator && !hasCredentials) return null;

  const options = { projectId: env.FIREBASE_PROJECT_ID || undefined };
  if (hasCredentials && !usingEmulator) options.credential = admin.credential.applicationDefault();
  const app = admin.apps.length ? admin.app() : admin.initializeApp(options);

  return {
    app,
    auth: app.auth(),
    db: app.firestore(),
    FieldValue: admin.firestore.FieldValue,
  };
}

module.exports = { initFirebaseAdmin };
