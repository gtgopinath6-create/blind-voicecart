const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadConfig } = require('./config');
const { initFirebaseAdmin } = require('./firebaseAdmin');
const { createApp } = require('./app');

const config = loadConfig();
const firebase = initFirebaseAdmin();
const app = createApp({ config, firebase });

app.listen(config.port, () => {
  console.log(`VoiceCart API listening on port ${config.port} (${config.nodeEnv})`);
  console.log(`  AI assistant: ${config.groqApiKey ? `enabled (${config.groqModel})` : 'disabled (GROQ_API_KEY not set)'}`);
  console.log(`  Firebase Admin: ${firebase ? `enabled (project ${config.firebaseProjectId || 'from credentials'})` : 'disabled (set FIREBASE_ADMIN_USE_ADC=true or GOOGLE_APPLICATION_CREDENTIALS)'}`);
  console.log(`  Wallet refill: ${config.allowDevWalletCredit ? 'DEV MOCK on the emulator (no real payment)' : 'unavailable (no payment provider)'}`);
  if (config.devWalletCreditRequested && !config.allowDevWalletCredit) {
    console.warn('  ALLOW_DEV_WALLET_CREDIT is ignored: it only works outside production against the Firestore emulator.');
  }
  if (config.nodeEnv === 'production' && !firebase) {
    console.warn('  WARNING: production without Firebase Admin. Checkout, wallet and admin requests will fail with 503.');
  }
  if (config.nodeEnv === 'production' && !config.firebaseProjectId) {
    console.warn('  WARNING: FIREBASE_PROJECT_ID is not set. It must match the projectId of the frontend build.');
  }
});
