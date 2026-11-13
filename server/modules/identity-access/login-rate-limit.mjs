import {createHash} from 'node:crypto';

export const requireLocalLoginEnabled = (req, res, next) => {
  if (process.env.NODE_ENV === 'production' || process.env.LOCAL_LOGIN_ENABLED === 'false') {
    return res.status(404).json({error: 'Not found'});
  }
  next();
};

export const createLoginRateLimit = ({maxAttempts = 8, maxIpAttempts = 64,
  maxEntries = 10000, windowMs = 15 * 60 * 1000, now = Date.now} = {}) => {
  for (const value of [maxAttempts, maxIpAttempts, maxEntries, windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Login rate limits must be positive safe integers.');
  }
  const entries = new Map();
  const reject = (res, resetAt, time) => {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - time) / 1000))));
    return res.status(429).json({error: 'Too many login attempts. Please try again later.'});
  };
  const middleware = (req, res, next) => {
    const time = now();
    // Fixed windows retain insertion order: expiry is amortized over created entries.
    for (const [key, value] of entries) {
      if (value.resetAt > time) break;
      entries.delete(key);
    }
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const ipKey = createHash('sha256').update(ip).digest('hex');
    const accountKey = `${ipKey}:${createHash('sha256').update(username).digest('hex')}`;
    // Charge the IP before validating username so malformed attempts cannot bypass its budget.
    for (const [key, limit] of [[ipKey, maxIpAttempts], [accountKey, maxAttempts]]) {
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxEntries) return reject(res, entries.values().next().value.resetAt, time);
        entry = {count: 0, resetAt: time + windowMs};
        entries.set(key, entry);
      }
      if (entry.count >= limit) return reject(res, entry.resetAt, time);
      entry.count += 1;
    }
    next();
  };
  // Bounded diagnostics for tests and future internal metrics; never exposes key material.
  Object.defineProperty(middleware, 'entryCount', {get: () => entries.size});
  return middleware;
};
