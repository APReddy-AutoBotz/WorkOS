const readCookie = (req, name) => {
  const cookieHeader = req.headers?.cookie || '';
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
};

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

  const attachVerifiedIdentity = (req, res) => {
    const authHeader = req.headers?.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    const cookieToken = readCookie(req, sessionCookieName);
    const payload = verifyToken(bearerToken || cookieToken);
    if (!payload) {
      res.status(401).json({error: 'Authentication required'});
      return false;
    }
    req.user = payload;
    return true;
  };

  const requireIdentity = (req, res, next) => {
    if (attachVerifiedIdentity(req, res)) next();
  };

  const requireAuth = async (req, res, next) => {
    if (!attachVerifiedIdentity(req, res)) return;
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
