// Small HTTP helpers: typed errors, auth middleware and an in-memory rate limiter.

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Wraps an async route handler so thrown errors reach the error middleware. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Verifies the Firebase ID token in "Authorization: Bearer <token>".
 * With required=false, anonymous requests pass through with req.user = null.
 */
function authenticate(auth, { required = true } = {}) {
  return asyncRoute(async (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      if (required) throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
      req.user = null;
      return next();
    }
    if (!auth) throw new HttpError(503, 'server_not_configured', 'Account services are not configured on the server.');
    try {
      // checkRevoked=true so revoked sessions (e.g. removed admins, deleted users) stop working immediately.
      req.user = await auth.verifyIdToken(token, true);
    } catch (e) {
      throw new HttpError(401, 'invalid_token', 'Your session has expired. Please sign in again.');
    }
    next();
  });
}

/** Requires the trusted `admin` custom claim, which only the Admin SDK can set. */
function requireAdmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in to continue.'));
  if (req.user.admin !== true) return next(new HttpError(403, 'forbidden', 'Administrator access is required.'));
  next();
}

/** Fixed-window rate limiter keyed by user id, falling back to IP address. */
function rateLimit({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = (req.user && req.user.uid) || req.ip || 'unknown';
    const t = now();
    let entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      entry = { start: t, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - t) / 1000)));
      return next(new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.'));
    }
    next();
  };
}

module.exports = { HttpError, asyncRoute, authenticate, requireAdmin, rateLimit };
