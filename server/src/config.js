// Server configuration, read once from the environment (server/.env in development).
// Secrets such as GROQ_API_KEY live only here and are never sent to the browser.

function bool(value) {
  return String(value || '').toLowerCase() === 'true';
}

/** Express "trust proxy" setting: how many proxy hops sit in front of the server (default 1). */
function trustProxy(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 1;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    nodeEnv,
    port: Number(env.PORT) || 5055,
    groqApiKey: (env.GROQ_API_KEY || '').trim(),
    groqModel: (env.GROQ_MODEL || 'openai/gpt-oss-120b').trim(),
    groqReasoningEffort: (env.GROQ_REASONING_EFFORT || 'low').trim(),
    firebaseProjectId: (env.FIREBASE_PROJECT_ID || '').trim(),
    // Test money without a payment provider. Only honoured outside production AND against the
    // Firestore emulator, so it can never credit a real (staging or production) database.
    allowDevWalletCredit: bool(env.ALLOW_DEV_WALLET_CREDIT) && nodeEnv !== 'production' && Boolean(env.FIRESTORE_EMULATOR_HOST),
    devWalletCreditRequested: bool(env.ALLOW_DEV_WALLET_CREDIT),
    // Comma-separated browser origins allowed to call the API (only needed when not served same-origin).
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Rate limits use the client IP; set this to the number of proxies in front of the server.
    trustProxy: trustProxy(env.TRUST_PROXY),
  };
}

module.exports = { loadConfig };
