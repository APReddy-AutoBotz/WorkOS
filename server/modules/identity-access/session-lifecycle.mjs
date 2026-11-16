import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
// Pre-upgrade tokens cannot be grouped across past refreshes. Require a new
// sign-in instead of claiming that a hash of one legacy token revokes siblings.
export const sessionFamily = payload => typeof payload?.sid === 'string'
  && /^[a-zA-Z0-9_-]{16,128}$/.test(payload.sid) ? payload.sid : null;
export const sessionHash = family => digest(`session:${family}`);

export const createSessionLogoutHandler = ({pool, verifyToken, readCookie, audit, secure}) => async (req, res) => {
  res.clearCookie?.('workos_session', {httpOnly: true, sameSite: 'lax', secure});
  const header = req.headers?.authorization || '';
  // A tab bearer and a shared browser cookie can belong to different sessions.
  // Revoke every presented valid family, including duplicate-path cookies.
  const cookies = String(req.headers?.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith('workos_session=')).map(part => part.slice('workos_session='.length));
  const tokens = [header.startsWith('Bearer ') ? header.slice(7) : '', readCookie(req, 'workos_session'), ...cookies];
  const sessions = new Map();
  for (const token of new Set(tokens.filter(Boolean))) {
    const payload = verifyToken(token);
    if (!payload?.sub || !payload.activeRole || !Number.isFinite(payload.exp)) continue;
    const family = sessionFamily(payload);
    if (family) {
      const hash = sessionHash(family);
      // Match authenticated-request precedence when role variants share a family.
      if (!sessions.has(hash)) sessions.set(hash, payload);
    }
  }
  if (!sessions.size) return res.json({status: 'ok'});
  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    // Stable ordering avoids deadlocks when two requests contain the same families.
    for (const [hash, payload] of [...sessions].sort(([left], [right]) => left.localeCompare(right))) {
      const inserted = await client.query(`insert into session_revocations(session_hash,user_id,active_role,expires_at,operation_id)
        values($1,$2,$3,to_timestamp($4::double precision/1000),$5) on conflict(session_hash) do nothing returning session_hash`,
      [hash, payload.sub, payload.activeRole, payload.exp, req.operationId || null]);
      if (inserted.rowCount) {
        req.user = payload;
        await audit(client, req, {module: 'Auth', action: 'Logout', entityType: 'Session', entityId: hash,
          oldValue: {revoked: false}, newValue: {revoked: true}, details: 'Revoked the signed session family.'});
      }
    }
    await client.query('commit');
    res.json({status: 'ok'});
  } catch {
    await client?.query('rollback').catch(() => {});
    res.status(503).json({error: 'Server sign-out could not be confirmed.', code: 'SESSION_REVOCATION_UNCONFIRMED'});
  } finally { client?.release(); }
};
