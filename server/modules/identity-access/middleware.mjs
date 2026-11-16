import {sessionFamily, sessionHash} from './session-lifecycle.mjs';
import {qualifiedDirectorSql} from './workforce-authority.mjs';

export const readCookie = (req, name) => {
  const cookieHeader = req.headers?.cookie || '';
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
};

// Only consume these claims after signature verification. They originate from
// the verified Entra ID token at login, never a request body or role selector.
export const sessionEntraGroups = payload => payload?.identityProvider === 'entra'
  && Array.isArray(payload.entraGroups) && payload.entraGroups.length <= 200
  && payload.entraGroups.every(group => typeof group === 'string' && group.length > 0 && group.length <= 200)
  ? [...new Set(payload.entraGroups)] : [];

/**
 * Create the shared identity and organization-scope guards used by legacy and
 * versioned API routers. Scope discovery intentionally uses requireIdentity;
 * organization data still requires requireAuth and a unique authorized scope.
 */
export const createIdentityAccessMiddleware = ({
  verifyToken,
  database,
  resolveOrganizationScope,
  allowTestFallback = () => false,
  sessionCookieName = 'workos_session',
}) => {
  if (typeof verifyToken !== 'function' || !database || typeof resolveOrganizationScope !== 'function') {
    throw new TypeError('Identity access middleware requires token verification, a database, and scope resolution.');
  }

  const attachVerifiedIdentity = async (req, res) => {
    const authHeader = req.headers?.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    const cookieToken = readCookie(req, sessionCookieName);
    const token = bearerToken || cookieToken;
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({error: 'Authentication required'});
      return false;
    }
    // A signature proves issuance, not that the account still holds this role.
    // Apply this before both scope discovery/session refresh and scoped routes.
    let currentIdentity;
    try {
      const current = await database.query(`select e.employee_id,e.id as employee_record_id,
        ${qualifiedDirectorSql('e')} as country_director_id from users u
        left join employees e on e.id=u.employee_record_id
        where u.id = $1 and u.status = 'Active' and (
          exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
            where ur.user_id = u.id and r.name = $2)
          or exists (select 1 from entra_group_role_mappings m
            where m.active = true and m.role_name = $2 and m.group_id = any($3::text[])))`,
      [payload.sub, payload.activeRole, sessionEntraGroups(payload)]);
      if (!current.rowCount) {
        res.status(403).json({error: 'The session role is no longer assigned to an active account', code: 'SESSION_ROLE_REVOKED'});
        return false;
      }
      currentIdentity = current.rows[0];
    } catch {
      res.status(503).json({error: 'Current identity authority is unavailable', code: 'IDENTITY_AUTHORITY_UNAVAILABLE'});
      return false;
    }
    const sid = sessionFamily(payload);
    if (!sid) {
      res.status(401).json({error: 'Invalid session identity', code: 'SESSION_INVALID'});
      return false;
    }
    try {
      const revoked = await database.query('select 1 from session_revocations where session_hash=$1', [sessionHash(sid)]);
      if (revoked.rowCount) {
        res.status(401).json({error: 'This session has been signed out', code: 'SESSION_REVOKED'});
        return false;
      }
    } catch {
      res.status(503).json({error: 'Session authority is unavailable', code: 'SESSION_AUTHORITY_UNAVAILABLE'});
      return false;
    }
    req.user = {...payload, sid,employeeId:currentIdentity.employee_id,
      employeeRecordId:currentIdentity.employee_record_id,countryDirectorId:currentIdentity.country_director_id,
      cdId:currentIdentity.country_director_id};
    return true;
  };

  const requireIdentity = async (req, res, next) => {
    if (await attachVerifiedIdentity(req, res)) next();
  };

  const requireAuth = async (req, res, next) => {
    if (!await attachVerifiedIdentity(req, res)) return;
    try {
      const scope = await resolveOrganizationScope(database, req);
      req.organizationScope = scope;
      req.user.organizationId = scope.organizationId;
      req.user.legalEntityId = scope.legalEntityId;
      next();
    } catch (error) {
      if (allowTestFallback() && error?.code === '42P01') {
        req.organizationScope = {organizationId: 'org-default', legalEntityId: 'legal-default'};
        next();
        return;
      }
      res.status(error?.statusCode || 503).json({
        error: 'Authoritative organization scope is unavailable',
        code: error?.code || 'ORG_SCOPE_UNAVAILABLE',
      });
    }
  };

  return {requireIdentity, requireAuth};
};
