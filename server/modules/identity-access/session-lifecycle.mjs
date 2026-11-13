import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
// Pre-upgrade tokens acquire a stable family on first use; copies of the original
// token and every subsequent refresh/role variant share the same revocation key.
export const sessionFamily = (payload, token) => typeof payload.sid === 'string' && payload.sid.length <= 128
  ? payload.sid : digest(token);
export const sessionHash = family => digest(`session:${family}`);

export const createSessionLogoutHandler = ({pool, verifyToken, readCookie, audit, secure}) => async (req, res) => {
  res.clearCookie?.('workos_session', {httpOnly: true, sameSite: 'lax', secure});
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : readCookie(req, 'workos_session');
  const payload = verifyToken(token);
  if (!payload?.sub || !payload.activeRole || !Number.isFinite(payload.exp)) return res.json({status: 'ok'});
  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    const hash = sessionHash(sessionFamily(payload, token));
    const inserted = await client.query(`insert into session_revocations(session_hash,user_id,active_role,expires_at,operation_id)
      values($1,$2,$3,to_timestamp($4::double precision/1000),$5) on conflict(session_hash) do nothing returning session_hash`,
    [hash, payload.sub, payload.activeRole, payload.exp, req.operationId || null]);
    if (inserted.rowCount) {
      req.user = payload;
      await audit(client, req, {module: 'Auth', action: 'Logout', entityType: 'Session', entityId: hash,
        oldValue: {revoked: false}, newValue: {revoked: true}, details: 'Revoked the signed session family.'});
    }
    await client.query('commit');
    res.json({status: 'ok'});
  } catch {
    await client?.query('rollback').catch(() => {});
    res.status(503).json({error: 'Server sign-out could not be confirmed.', code: 'SESSION_REVOCATION_UNCONFIRMED'});
  } finally { client?.release(); }
};
