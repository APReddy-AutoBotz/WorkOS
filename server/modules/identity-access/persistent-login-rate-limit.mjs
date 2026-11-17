import {createHash} from 'node:crypto';
import {loginRateLimitOptions} from './login-rate-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = res => {
  res.setHeader('Retry-After', '1');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(503).json({error: 'Authentication protection is temporarily unavailable. Please try again later.'});
};

// The caller supplies a bounded, connection-timeout-configured pool. The local
// admission cap bounds waiting requests; it never substitutes for shared state.
export const createPersistentLoginRateLimit = ({pool, maxConcurrent = 32, ...options}) => {
  const {maxAttempts, maxIpAttempts, maxEntries, windowMs} = loginRateLimitOptions(options);
  if (!pool || typeof pool.connect !== 'function') throw new Error('Authentication throttle storage is required.');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Authentication throttle concurrency must be a positive safe integer.');
  let inFlight = 0;
  const consumeShared = async (req, callback) => {
    let client, failed = false;
    const onConnectionError = () => { failed = true; };
    try {
      client = await pool.connect();
      client.on('error', onConnectionError);
      await client.query('begin isolation level read committed');
      await client.query("set local lock_timeout='1000ms'");
      await client.query("set local statement_timeout='2000ms'");
      // Separate statements are essential: the post-lock READ COMMITTED snapshot
      // must include the last replica's commit, even with a different DB default.
      await client.query("select pg_advisory_xact_lock(hashtextextended('workos-auth-throttle-v1',0))");
      const time = (await client.query('select clock_timestamp() as time')).rows[0].time;
      await client.query('delete from authentication_rate_buckets where reset_at <= $1', [time]);
      const usage = (await client.query('select count(*)::int as size,min(reset_at) as earliest from authentication_rate_buckets')).rows[0];
      let size = usage.size;
      let deniedUntil;
      const charge = async (key, limit) => {
        const entry = (await client.query('select attempts,reset_at from authentication_rate_buckets where bucket_key=$1',[key])).rows[0];
        if (entry) {
          if (Number(entry.attempts) >= limit) { deniedUntil = entry.reset_at; return false; }
          await client.query('update authentication_rate_buckets set attempts=attempts+1 where bucket_key=$1',[key]);
        } else {
          if (size >= maxEntries) { deniedUntil = usage.earliest ?? new Date(time.getTime()+windowMs); return false; }
          await client.query('insert into authentication_rate_buckets(bucket_key,attempts,reset_at) values($1,1,$2)',[key,new Date(time.getTime()+windowMs)]);
          size++;
        }
        return true;
      };
      const ipKey = hash(String(req.ip || req.socket?.remoteAddress || 'unknown'));
      let allowed = await charge(ipKey, maxIpAttempts);
      if (allowed) {
        // Preserve IP-first processing, route-owned callback identity and local
        // input normalization without storing reversible identity representations.
        const username = !callback && typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
        allowed = await charge(hash(`${ipKey}:${callback ? 'callback' : 'local'}:${hash(username)}`), maxAttempts);
      }
      // Intentional denials retain the aggregate IP charge, as the bounded local
      // limiter did. Storage errors roll back; no handler runs before commit.
      await client.query('commit');
      return {allowed, retryAfter: allowed ? null : Math.max(1,Math.ceil((deniedUntil.getTime()-time.getTime())/1000))};
    } catch (error) {
      failed = true;
      // Destroying this connection rolls back its transaction, including when a network read timed out.
      throw error;
    } finally {
      if (client) {
        client.removeListener('error', onConnectionError);
        client.release(failed);
      }
    }
  };
  const consume = async (req, res, next, callback) => {
    if (inFlight >= maxConcurrent) return unavailable(res);
    inFlight++;
    let decision;
    try { decision = await consumeShared(req,callback); }
    catch { return unavailable(res); }
    finally { inFlight--; }
    if (decision.allowed) return next();
    res.setHeader('Retry-After', String(decision.retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({error: 'Too many login attempts. Please try again later.'});
  };
  const middleware = (req,res,next) => consume(req,res,next,false);
  middleware.callback = (req,res,next) => consume(req,res,next,true);
  return middleware;
};
