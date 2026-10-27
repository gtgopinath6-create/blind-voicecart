const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { normalizeAction, parseVoiceRequest } = require('../../src/voice');
const { validateShipping, validateRefillAmount, isValidIdempotencyKey } = require('../../src/validation');
const { rateLimit, requireAdmin } = require('../../src/http');

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const groqReply = (content, status = 200) => async () => ({
  ok: status === 200,
  status,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
});

// Fake Admin Auth: token "user" is an ordinary user, "admin" carries the admin claim.
const fakeAuth = {
  verifyIdToken: async (token) => {
    if (token === 'user') return { uid: 'u1' };
    if (token === 'admin') return { uid: 'a1', admin: true };
    throw new Error('bad token');
  },
};
const fakeFirebase = { auth: fakeAuth, db: {}, FieldValue: {} };

test('voice: model output is restricted to known intents and pages', () => {
  assert.equal(normalizeAction({ intent: 'DELETE_ALL_USERS', target: 'x' }), null);
  assert.equal(normalizeAction({ intent: 'NAVIGATE', target: 'https://evil.example' }), null);
  assert.equal(normalizeAction({ intent: 'NAVIGATE', target: '/categories/shoes' }).target, '/categories/Shoes');
  assert.equal(normalizeAction({ intent: 'ADD_TO_CART', target: null }), null);
  assert.equal(normalizeAction({ intent: 'SET_QUANTITY', target: 'x', quantity: 500 }), null);
  assert.equal(normalizeAction({ intent: 'SET_QUANTITY', target: null, quantity: 2 }).quantity, 2);
});

test('voice: Zoro entities are hints, validated and bounded; unknown fields are dropped', () => {
  const action = normalizeAction({
    intent: 'FIND_PRODUCT', target: null,
    entities: {
      category: 'shoes', productType: 'gym', color: 'black', size: '9', sizeSystem: 'uk', budgetMax: '5000', quantity: 2,
      confirmation: 'maybe', correction: 'yes', price: 1, productId: 'invented-id', password: 'secret',
    },
  });
  assert.equal(action.intent, 'FIND_PRODUCT');
  assert.deepEqual(action.entities, { productType: 'gym', color: 'black', size: '9', category: 'Shoes', sizeSystem: 'UK', budgetMax: 5000, quantity: 2 });
  assert.deepEqual(normalizeAction({ intent: 'FIND_PRODUCT', entities: { category: 'Weapons', budgetMax: -5, quantity: 500 } }).entities, {});
  assert.equal(normalizeAction({ intent: 'SIGN_IN' }).intent, 'SIGN_IN');
  assert.equal(normalizeAction({ intent: 'LOG_IN_AS_ADMIN' }), null);
});

test('voice: request text and product list are bounded', () => {
  assert.throws(() => parseVoiceRequest({ text: '' }), /No command/);
  assert.throws(() => parseVoiceRequest({ text: 'a'.repeat(301) }), /too long/);
  const parsed = parseVoiceRequest({ text: 'hi', products: Array.from({ length: 500 }, (_, i) => ({ name: `P${i}` })) });
  assert.equal(parsed.products.length, 150);
});

test('POST /api/voice/intent returns a validated action without exposing the key', async () => {
  let sentAuth = null;
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentAuth = init.headers.Authorization;
    sentBody = JSON.parse(init.body);
    return groqReply({ intent: 'ADD_TO_CART', target: 'Nike Air Force 1', speechResponse: 'ok' })();
  };
  const app = createApp({ config: loadConfig({ GROQ_API_KEY: 'secret-test-key' }), fetchImpl });
  await withServer(app, async (base) => {
    const res = await post(`${base}/api/voice/intent`, { text: 'add air force one', products: [{ name: 'Nike Air Force 1' }] });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(text).action.intent, 'ADD_TO_CART');
    assert.ok(!text.includes('secret-test-key'));
  });
  assert.equal(sentAuth, 'Bearer secret-test-key');
  assert.equal(sentBody.reasoning_effort, 'low');
});

test('voice: provider failures and missing key return errors so the browser falls back', async () => {
  const failing = createApp({ config: loadConfig({ GROQ_API_KEY: 'k' }), fetchImpl: groqReply({}, 500) });
  await withServer(failing, async (base) => {
    const res = await post(`${base}/api/voice/intent`, { text: 'open shoes' });
    assert.equal(res.status, 502);
  });
  const limited = createApp({ config: loadConfig({ GROQ_API_KEY: 'k' }), fetchImpl: groqReply({}, 429) });
  await withServer(limited, async (base) => {
    const res = await post(`${base}/api/voice/intent`, { text: 'open shoes' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'ai_rate_limited');
  });
  const garbage = createApp({ config: loadConfig({ GROQ_API_KEY: 'k' }), fetchImpl: groqReply({ intent: 'RUN_JS', target: 'alert(1)' }) });
  await withServer(garbage, async (base) => {
    assert.equal((await post(`${base}/api/voice/intent`, { text: 'open shoes' })).status, 502);
  });
  const noKey = createApp({ config: loadConfig({}) });
  await withServer(noKey, async (base) => {
    assert.equal((await post(`${base}/api/voice/intent`, { text: 'open shoes' })).status, 503);
  });
});

test('voice endpoint is rate limited', async () => {
  const app = createApp({ config: loadConfig({ GROQ_API_KEY: 'k' }), fetchImpl: groqReply({ intent: 'UNKNOWN', speechResponse: '' }) });
  await withServer(app, async (base) => {
    const statuses = [];
    for (let i = 0; i < 32; i++) statuses.push((await post(`${base}/api/voice/intent`, { text: 'hello' })).status);
    assert.equal(statuses.filter((s) => s === 200).length, 30);
    assert.equal(statuses[31], 429);
  });
});

test('guests and ordinary users cannot call admin endpoints', async () => {
  const app = createApp({ config: loadConfig({}), firebase: fakeFirebase });
  await withServer(app, async (base) => {
    assert.equal((await post(`${base}/api/admin/users`, { name: 'x' })).status, 401);
    assert.equal((await post(`${base}/api/admin/users`, { name: 'x' }, { Authorization: 'Bearer user' })).status, 403);
    assert.equal((await post(`${base}/api/admin/users`, { name: 'x' }, { Authorization: 'Bearer forged' })).status, 401);
    const del = await fetch(`${base}/api/admin/users/u2`, { method: 'DELETE', headers: { Authorization: 'Bearer user' } });
    assert.equal(del.status, 403);
  });
});

test('checkout and wallet require sign-in, and refills are refused without a payment provider', async () => {
  const app = createApp({ config: loadConfig({ ALLOW_DEV_WALLET_CREDIT: 'true', NODE_ENV: 'production' }), firebase: fakeFirebase });
  await withServer(app, async (base) => {
    assert.equal((await post(`${base}/api/checkout`, {})).status, 401);
    assert.equal((await post(`${base}/api/wallet/refill`, { amount: 100 })).status, 401);
    const refill = await post(`${base}/api/wallet/refill`, { amount: 100, idempotencyKey: 'abcdefghijklmnop' }, { Authorization: 'Bearer user' });
    assert.equal(refill.status, 501);
  });
});

test('account endpoints report 503 instead of fake success when Firebase Admin is not configured', async () => {
  const app = createApp({ config: loadConfig({}) });
  await withServer(app, async (base) => {
    assert.equal((await post(`${base}/api/checkout`, {})).status, 503);
  });
});

test('dev wallet credit works only outside production and only against the Firestore emulator', () => {
  const emulator = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8181' };
  assert.equal(loadConfig({ ...emulator, ALLOW_DEV_WALLET_CREDIT: 'true', NODE_ENV: 'production' }).allowDevWalletCredit, false);
  // Real Firebase project (no emulator), even in development: refused, so no fake money reaches real data.
  assert.equal(loadConfig({ ALLOW_DEV_WALLET_CREDIT: 'true' }).allowDevWalletCredit, false);
  assert.equal(loadConfig({ ALLOW_DEV_WALLET_CREDIT: 'true', NODE_ENV: 'development' }).allowDevWalletCredit, false);
  assert.equal(loadConfig({ ...emulator, ALLOW_DEV_WALLET_CREDIT: 'true' }).allowDevWalletCredit, true);
  assert.equal(loadConfig({ ...emulator }).allowDevWalletCredit, false);
});

test('trust proxy is configurable and defaults to one hop', () => {
  assert.equal(loadConfig({}).trustProxy, 1);
  assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
});

test('API responses are not cacheable and CORS is closed unless origins are listed', async () => {
  const closed = createApp({ config: loadConfig({}) });
  await withServer(closed, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
  const open = createApp({ config: loadConfig({ ALLOWED_ORIGINS: 'https://shop.example' }) });
  await withServer(open, async (base) => {
    const ok = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { Origin: 'https://shop.example' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.example');
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);
    const other = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});

test('validation: refill amounts, shipping and idempotency keys', () => {
  for (const bad of [0, -5, 1.5, '100', NaN, null, undefined, 100001]) assert.ok(validateRefillAmount(bad), String(bad));
  assert.equal(validateRefillAmount(500), null);

  const { errors } = validateShipping({ customerMobile: '12345', customerAddress: '', customerCity: 'P', customerState: '', customerPincode: '12' });
  assert.deepEqual(Object.keys(errors).sort(), ['customerAddress', 'customerCity', 'customerMobile', 'customerPincode', 'customerState']);
  const ok = validateShipping({ customerMobile: '98765 43210', customerAddress: '12 MG Road', customerCity: 'Pune', customerState: 'MH', customerPincode: '411001' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.customerMobile, '9876543210');

  assert.equal(isValidIdempotencyKey('short'), false);
  assert.equal(isValidIdempotencyKey('../../etc/passwd-aaaaaaaaaa'), false);
  assert.equal(isValidIdempotencyKey('a1b2c3d4e5f6g7h8i9'), true);
});

test('requireAdmin only accepts the trusted claim', () => {
  const run = (user) => {
    let error;
    requireAdmin({ user }, {}, (e) => { error = e; });
    return error ? error.status : 200;
  };
  assert.equal(run(null), 401);
  assert.equal(run({ uid: 'u', admin: 'true' }), 403);
  assert.equal(run({ uid: 'u', admin: true }), 200);
});

test('rateLimit resets after the window', () => {
  let t = 0;
  const limiter = rateLimit({ windowMs: 1000, max: 1, now: () => t });
  const call = () => { let s = 200; limiter({ ip: 'x' }, { set() {} }, (e) => { if (e) s = e.status; }); return s; };
  assert.equal(call(), 200);
  assert.equal(call(), 429);
  t = 1000;
  assert.equal(call(), 200);
});

test('Firestore quota and outage errors become 503 with Retry-After, never a generic 500', async () => {
  const quotaDb = { runTransaction: async () => { throw Object.assign(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.'), { code: 8 }); } };
  const app = createApp({ config: loadConfig({}), firebase: { ...fakeFirebase, db: quotaDb } });
  const errors = console.error;
  console.error = () => {};
  try {
    await withServer(app, async (base) => {
      const res = await post(`${base}/api/checkout/quote`, {}, { Authorization: 'Bearer user' });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '60');
      const body = await res.json();
      assert.equal(body.error.code, 'temporarily_unavailable');
      assert.doesNotMatch(body.error.message, /quota exceeded|RESOURCE_EXHAUSTED/i);
    });
  } finally {
    console.error = errors;
  }
});
