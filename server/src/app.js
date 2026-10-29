const express = require('express');
const { HttpError, asyncRoute, authenticate, requireAdmin, rateLimit } = require('./http');
const { parseVoiceRequest, classifyWithGroq } = require('./voice');
const { transcribeWithGroqWhisper } = require('./transcribe');
const { placeOrder, quoteCart } = require('./checkout');
const { requestRefill } = require('./wallet');
const { createUser, setUserDisabled, deleteUser } = require('./adminUsers');

// gRPC status codes from the Firestore Admin SDK, with how long clients should wait (seconds).
const FIRESTORE_BUSY = {
  4: { name: 'DEADLINE_EXCEEDED', retryAfter: 5 },
  8: { name: 'RESOURCE_EXHAUSTED', retryAfter: 60 },
  14: { name: 'UNAVAILABLE', retryAfter: 5 },
};

/**
 * Builds the API. Dependencies are injected so tests can use emulators or fakes.
 * firebase: { auth, db, FieldValue } or null when Firebase Admin is not configured.
 */
function createApp({ config, firebase = null, fetchImpl = fetch }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32kb' }));
  // API responses are per-user: never let a CDN or browser cache them.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  if (config.allowedOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.allowedOrigins.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  const auth = firebase ? firebase.auth : null;
  const needFirebase = (req, res, next) =>
    firebase ? next() : next(new HttpError(503, 'server_not_configured', 'Account services are not configured on the server.'));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, ai: Boolean(config.groqApiKey), firebase: Boolean(firebase), devWalletCredit: config.allowDevWalletCredit });
  });

  // Voice intent: guests may use it, so auth is optional; rate limited per user/IP.
  app.post(
    '/api/voice/intent',
    authenticate(auth, { required: false }),
    rateLimit({ windowMs: 60 * 1000, max: 30 }),
    asyncRoute(async (req, res) => {
      const input = parseVoiceRequest(req.body);
      const action = await classifyWithGroq(input, { apiKey: config.groqApiKey, model: config.groqModel, reasoningEffort: config.groqReasoningEffort, fetchImpl });
      res.json({ action });
    })
  );

  // One recorded utterance, uploaded as raw audio (not JSON). Mounted only on this route so the
  // 32kb JSON limit above stays tight for every other endpoint. The size cap is a byte budget for
  // one short command, not a general file upload allowance.
  const audioBody = express.raw({
    type: ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'],
    limit: '4mb',
  });

  // Guests may use the mic too; rate limited per user/IP, tighter than text intent since
  // transcription is slower and costlier per request.
  app.post(
    '/api/voice/transcribe',
    audioBody,
    authenticate(auth, { required: false }),
    rateLimit({ windowMs: 60 * 1000, max: 15 }),
    asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, 'invalid_input', 'No audio was received.');
      }
      const { text } = await transcribeWithGroqWhisper({
        audio: req.body,
        mimeType: req.get('content-type'),
        apiKey: config.groqApiKey,
        model: config.groqWhisperModel,
        fetchImpl,
      });
      res.json({ text });
    })
  );

  app.post(
    '/api/checkout/quote',
    needFirebase,
    authenticate(auth),
    rateLimit({ windowMs: 60 * 1000, max: 30 }),
    asyncRoute(async (req, res) => {
      res.json(await quoteCart(firebase.db, { uid: req.user.uid }));
    })
  );

  app.post(
    '/api/checkout',
    needFirebase,
    authenticate(auth),
    rateLimit({ windowMs: 60 * 1000, max: 10 }),
    asyncRoute(async (req, res) => {
      const order = await placeOrder(firebase.db, {
        uid: req.user.uid,
        idempotencyKey: req.body && req.body.idempotencyKey,
        shipping: req.body && req.body.shipping,
        FieldValue: firebase.FieldValue,
      });
      res.status(order.duplicate ? 200 : 201).json({ order });
    })
  );

  app.post(
    '/api/wallet/refill',
    needFirebase,
    authenticate(auth),
    rateLimit({ windowMs: 60 * 1000, max: 10 }),
    asyncRoute(async (req, res) => {
      const result = await requestRefill(firebase.db, {
        uid: req.user.uid,
        amount: req.body && req.body.amount,
        idempotencyKey: req.body && req.body.idempotencyKey,
        config,
      });
      res.json({ transaction: result });
    })
  );

  const admin = [needFirebase, authenticate(auth), requireAdmin, rateLimit({ windowMs: 60 * 1000, max: 60 })];

  app.post('/api/admin/users', ...admin, asyncRoute(async (req, res) => {
    res.status(201).json({ user: await createUser(firebase, req.body || {}) });
  }));

  app.post('/api/admin/users/:uid/disable', ...admin, asyncRoute(async (req, res) => {
    const disabled = !(req.body && req.body.disabled === false);
    res.json({ user: await setUserDisabled(firebase, { uid: req.params.uid, disabled, callerUid: req.user.uid }) });
  }));

  app.delete('/api/admin/users/:uid', ...admin, asyncRoute(async (req, res) => {
    res.json({ user: await deleteUser(firebase, { uid: req.params.uid, callerUid: req.user.uid }) });
  }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Unknown API endpoint.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      err = new HttpError(400, 'invalid_input', 'The request could not be read.');
    }
    // Firestore over quota or unreachable: a temporary condition, not a server bug. Clients keep
    // their checkout request id, so trying again later cannot create a second order.
    if (!(err instanceof HttpError) && err && FIRESTORE_BUSY[err.code]) {
      console.error('Firestore unavailable:', FIRESTORE_BUSY[err.code].name);
      res.set('Retry-After', String(FIRESTORE_BUSY[err.code].retryAfter));
      err = new HttpError(503, 'temporarily_unavailable', 'The store database is busy or unavailable right now. Please try again in a moment.');
    }
    if (!(err instanceof HttpError)) {
      console.error('Unhandled server error:', err && err.message);
      err = new HttpError(500, 'internal', 'Something went wrong on the server. Please try again.');
    }
    const body = { error: { code: err.code, message: err.message } };
    if (err.fields) body.error.fields = err.fields;
    res.status(err.status).json(body);
  });

  return app;
}

module.exports = { createApp };
