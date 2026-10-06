import {Router} from 'express';

/** Shared identity-read routes mounted through legacy and versioned prefixes. */
export const createIdentityReadRouter = ({
  requireDatabase,
  requireIdentity,
  listOrganizationScopes,
  refreshSession,
}) => {
  if (![requireDatabase, requireIdentity, listOrganizationScopes, refreshSession].every(value => typeof value === 'function')) {
    throw new TypeError('Identity read routes require database, identity, scope-list and session handlers.');
  }

  const router = Router();
  router.get('/organization-scopes', requireDatabase, requireIdentity, listOrganizationScopes);
  router.get('/me', requireDatabase, requireIdentity, refreshSession);
  return router;
};
