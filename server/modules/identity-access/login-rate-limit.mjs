import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

export const requireLocalLoginEnabled = (req, res, next) => {
  if (process.env.NODE_ENV === 'production' || process.env.LOCAL_LOGIN_ENABLED === 'false') {
    return res.status(404).json({error: 'Not found'});
  }
  next();
};

export const createLoginRateLimit = ({maxAttempts = 8, maxIpAttempts = 64,
  maxEntries = 10000, windowMs = 15 * 60 * 1000, now = () => performance.now()} = {}) => {
  for (const value of [maxAttempts, maxIpAttempts, maxEntries, windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Login rate limits must be positive safe integers.');
  }
  if (windowMs > 86400000) throw new Error('Login rate window must not exceed one day.');
  const entries = new Map();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const reject = (res, resetAt, time) => {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - time) / 1000))));
    return res.status(429).json({error: 'Too many login attempts. Please try again later.'});
  };
  const consume = (req, res, next, callback) => {
    const time = now();
    // Monotonic fixed windows preserve insertion/expiry order and bounded reclamation.
    for (const [key, value] of entries) {
      if (value.resetAt > time) break;
      entries.delete(key);
    }
    const ipKey = hash(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    const charge = (key, limit) => {
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxEntries) {reject(res, entries.values().next().value.resetAt, time);return false;}
        entry = {count: 0, resetAt: time + windowMs};
        entries.set(key, entry);
      }
      if (entry.count >= limit) {reject(res, entry.resetAt, time);return false;}
      entry.count += 1;
      return true;
    };
    // Reject exhausted IPs before normalizing/hashing potentially large usernames.
    if (!charge(ipKey, maxIpAttempts)) return;
    // Callback state has its own fixed bucket. GET bodies cannot select a new account.
    const username = !callback && typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const accountKey = `${ipKey}:${callback ? 'callback' : 'local'}:${hash(username)}`;
    if (!charge(accountKey, maxAttempts)) return;
    next();
  };
  const middleware = (req, res, next) => consume(req, res, next, false);
  middleware.callback = (req, res, next) => consume(req, res, next, true);
  Object.defineProperty(middleware, 'entryCount', {get: () => entries.size});
  return middleware;
};
