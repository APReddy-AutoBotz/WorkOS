import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {registerOrganizationSetupRoutes} from '../server/organization-setup.mjs';

const app = express();
let generatedId = 0;
app.use('/api', createRequestContextMiddleware({idFactory: () => `org-setup-${++generatedId}`}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json({limit: '1mb'}));

const context = {
  organization_id: 'org-test',
  organization_code: 'ORG-TEST',
  organization_name: 'Test Organization',
  legal_entity_id: 'legal-test',
  legal_entity_code: 'LEGAL-TEST',
  legal_entity_name: 'Test Legal Entity',
};
const pool = {
  async query(sql) {
    if (sql.includes('from user_organization_scopes s')) {
      return {rows: [{organization_id: 'org-test', legal_entity_id: 'legal-test'}]};
    }
    if (sql.includes('select o.id organization_id,o.code organization_code')) return {rows: [context]};
    throw new Error(`Unexpected organization setup test query: ${sql.slice(0, 120)}`);
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireAuth = (req, res, next) => {
  if (req.get('authorization') !== 'Bearer authorized-test') {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  req.user = {sub: 'user-test', activeRole: 'Admin'};
  next();
};
const requirePermission = () => (_req, _res, next) => next();
registerOrganizationSetupRoutes({
  app,
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  audit: async () => {},
  mountPaths: ['/api/organization-setup', '/api/v1/organization-setup'],
});
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const deniedResponses = await Promise.all([
    fetch(`${baseUrl}/api/organization-setup/context`),
    fetch(`${baseUrl}/api/v1/organization-setup/context`),
  ]);
  assert.deepEqual(deniedResponses.map(response => response.status), [401, 401],
    'both compatibility prefixes enforce the same authentication guard');
  assert.deepEqual(await deniedResponses[0].json(), {error: 'Authentication required'},
    'legacy organization setup keeps its legacy error shape');
  const versionedDenial = await deniedResponses[1].json();
  assert.equal(versionedDenial.error.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(versionedDenial.error.message, 'Authentication required');
  assert.equal(versionedDenial.error.correlationId, deniedResponses[1].headers.get('x-correlation-id'));

  const headers = {
    Authorization: 'Bearer authorized-test',
    'X-Organization-ID': 'org-test',
    'X-Legal-Entity-ID': 'legal-test',
  };
  const legacy = await fetch(`${baseUrl}/api/organization-setup/context`, {headers});
  const versioned = await fetch(`${baseUrl}/api/v1/organization-setup/context`, {headers});
  assert.equal(legacy.status, 200);
  assert.equal(versioned.status, 200);
  assert.deepEqual(await legacy.json(), context, 'legacy context response remains unchanged');
  assert.deepEqual(await versioned.json(), context, 'v1 compatibility alias uses the same guarded route contract');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Organization setup v1 compatibility smoke tests passed.');
