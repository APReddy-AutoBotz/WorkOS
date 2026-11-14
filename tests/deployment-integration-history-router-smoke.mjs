import assert from 'node:assert/strict';
import express from 'express';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from '../server/api/v1/error-contract.mjs';
import {createIntegrationHistoryRouter} from '../server/modules/integrations/integration-history-router.mjs';

const app = express();
app.use('/api', createRequestContextMiddleware({idFactory: () => 'deployment-integration-correlation'}));
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json());

const deploymentRows = [
  {
    id: 'deployment-entra-rejected',
    provider: 'entra',
    event_type: 'EntraLoginRejected',
    entity_type: 'IdentityProviderLink',
    entity_id: 'provider-subject-private',
    status: 'Failed',
    request_payload: {
      provider_subject: 'provider-subject-private',
      provider_upn: 'private-user@example.test',
      reason: 'No linked identity matched',
    },
    response_payload: {entra_object_id: 'object-private', status: 'Rejected'},
    organization_id: null,
    legal_entity_id: null,
    created_at: '2026-10-01T12:00:00.000Z',
  },
  {
    id: 'deployment-teams-delivered',
    provider: 'teams',
    event_type: 'TeamsNotificationDelivered',
    entity_type: 'NotificationEvent',
    entity_id: 'deployment-notification',
    status: 'Success',
    request_payload: null,
    response_payload: {
      statusCode: 202,
      teamsUser: 'private-teams-user@example.test',
      activityType: 'systemDefault',
    },
    organization_id: null,
    legal_entity_id: null,
    created_at: '2026-10-01T11:30:00.000Z',
  },
  {
    id: 'deployment-teams-action',
    provider: 'teams',
    event_type: 'TeamsActionNotificationSent',
    entity_type: 'PortalLink',
    entity_id: 'portal-link-opaque',
    status: 'Success',
    request_payload: {action: 'open_portal'},
    response_payload: {
      actionUrl: 'https://example.test/teams/actions/secret-bearer-token',
    },
    organization_id: null,
    legal_entity_id: null,
    created_at: '2026-10-01T11:00:00.000Z',
  },
];
const scopedRows = [
  {
    id: 'tenant-scoped-event',
    provider: 'entra',
    event_type: 'EntraLoginSucceeded',
    entity_id: 'tenant-link',
    status: 'Success',
    organization_id: 'org-a',
    legal_entity_id: 'legal-a',
  },
  {
    id: 'half-null-event',
    provider: 'entra',
    event_type: 'LegacyEvent',
    entity_id: 'half-null',
    status: 'Failed',
    organization_id: null,
    legal_entity_id: 'legal-a',
  },
];

const assignments = new Set([
  'designated-auditor:Employee',
  'no-grant-user:Admin',
  'role-default-only:Admin',
  'stale-role-auditor:Employee',
]);
const grants = new Set(['designated-auditor', 'disabled-auditor', 'stale-role-auditor']);
const identities = new Map([
  ['Bearer designated-auditor', {sub: 'designated-auditor', activeRole: 'Employee'}],
  ['Bearer no-grant-user', {sub: 'no-grant-user', activeRole: 'Admin'}],
  ['Bearer role-default-only', {sub: 'role-default-only', activeRole: 'Admin'}],
  ['Bearer disabled-auditor', {sub: 'disabled-auditor', activeRole: 'Employee'}],
  ['Bearer stale-role-auditor', {sub: 'stale-role-auditor', activeRole: 'Admin'}],
]);
const poolQueries = [];
const loggedErrors = [];
let denyFinalRead = false;
let failQuery = false;
const pool = {
  async query(sql, params) {
    poolQueries.push({sql, params});
    if (failQuery && sql.includes('iel.organization_id is null')) {
      throw new Error('synthetic deployment integration database detail');
    }
    if (sql.includes('where user_id=$1 and permission_key=$2')) {
      const rows = grants.has(params[0]) && params[1] === 'audit.deployment.view'
        ? [{permission_key: params[1]}]
        : [];
      return {rows, rowCount: rows.length};
    }
    if (sql.includes('iel.organization_id is null and iel.legal_entity_id is null')) {
      assert.deepEqual(params, ['designated-auditor', 'Employee', 'audit.deployment.view'],
        'the data query must bind the verified identity, current role and explicit protected permission');
      const rows = denyFinalRead
        ? []
        : [...deploymentRows, ...scopedRows].filter(row => row.organization_id === null && row.legal_entity_id === null);
      return {rows, rowCount: rows.length};
    }
    if (sql.includes('where u.id::text=$1 and u.status=\'Active\' and r.name=$2')) {
      const rows = assignments.has(`${params[0]}:${params[1]}`) ? [{exists: 1}] : [];
      return {rows, rowCount: rows.length};
    }
    throw new Error(`Unexpected query in deployment integration history test: ${sql}`);
  },
};

const requireDatabase = (_req, _res, next) => next();
const requireAuth = (_req, _res, next) => next();
const requireIdentity = (req, res, next) => {
  const identity = identities.get(req.get('authorization'));
  if (!identity) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  req.user = identity;
  assert.equal(req.organizationScope, undefined,
    'a deployment reader must authenticate without resolving or requiring an organization scope');
  next();
};
const permissionChecks = [];
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push({permission, userId: req.user.sub});
  if (req.get('x-deny-permission') === 'true') {
    res.status(403).json({error: 'Insufficient permission privileges'});
    return;
  }
  next();
};

const router = createIntegrationHistoryRouter({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  logError: error => loggedErrors.push(error.message),
});
app.use('/api', router);
app.use('/api/v1', router);
app.use('/api/v1', versionedApiErrorHandler);

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const designatedHeaders = {
  Authorization: 'Bearer designated-auditor',
  // Selectors are deliberately ignored by this explicit deployment-wide view.
  'X-Organization-ID': 'org-a',
  'X-Legal-Entity-ID': 'legal-a',
};

try {
  const [legacyResponse, versionedResponse] = await Promise.all([
    fetch(`${baseUrl}/api/deployment-integration-events`, {headers: designatedHeaders}),
    fetch(`${baseUrl}/api/v1/deployment-integration-events`, {headers: designatedHeaders}),
  ]);
  assert.equal(legacyResponse.status, 200);
  assert.equal(versionedResponse.status, 200);
  const legacyRows = await legacyResponse.json();
  const versionedRows = await versionedResponse.json();
  assert.deepEqual(versionedRows, legacyRows,
    'legacy and versioned deployment readers must use one redacted payload contract');
  assert.deepEqual(legacyRows.map(row => row.id), [
    'deployment-entra-rejected', 'deployment-teams-delivered', 'deployment-teams-action',
  ],
    'the deployment view must return exact null/null events and exclude tenant-scoped and half-null rows');
  assert.equal(legacyRows[0].entity_id, null,
    'unmatched Entra login failures must not expose their provider subject as an entity identifier');
  assert.deepEqual(legacyRows[0].request_payload, {reason: 'No linked identity matched'},
    'the deployment view must apply shared recursive identity-field redaction');
  assert.deepEqual(legacyRows[0].response_payload, {status: 'Rejected'});
  assert.deepEqual(legacyRows[1].response_payload, {statusCode: 202, activityType: 'systemDefault'},
    'Teams delivery history must retain operational status while removing the provider user ID or UPN');
  assert.deepEqual(legacyRows[2].response_payload, {},
    'bearer URLs must be redacted from deployment integration events');
  assert(!JSON.stringify(legacyRows).includes('provider-subject-private'));
  assert(!JSON.stringify(legacyRows).includes('private-user@example.test'));
  assert(!JSON.stringify(legacyRows).includes('object-private'));
  assert(!JSON.stringify(legacyRows).includes('secret-bearer-token'));
  assert(!JSON.stringify(legacyRows).includes('private-teams-user@example.test'),
    'provider Teams user IDs and UPNs must not be exposed in deployment history');

  const finalQueries = poolQueries.filter(query => query.sql.includes('iel.organization_id is null'));
  assert.equal(finalQueries.length, 2);
  assert(finalQueries.every(({sql}) => sql.replace(/\s+/g, ' ').trim()
    === `select iel.* from integration_event_logs iel where iel.organization_id is null and iel.legal_entity_id is null and exists ( select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id join user_permission_grants upg on upg.user_id=u.id where u.id::text=$1 and u.status='Active' and r.name=$2 and upg.permission_key=$3 ) order by iel.created_at desc limit 300`),
  'the final query must require exact null/null ownership, active identity, currently assigned role, explicit grant and bounded ordering');
  assert.deepEqual(permissionChecks, [
    {permission: 'audit.deployment.view', userId: 'designated-auditor'},
    {permission: 'audit.deployment.view', userId: 'designated-auditor'},
  ], 'both aliases must preserve the existing protected deployment audit permission');

  const queriesBeforeDeniedReads = poolQueries.length;
  const denied = await Promise.all([
    fetch(`${baseUrl}/api/deployment-integration-events`, {headers: {Authorization: 'Bearer unknown-user'}}),
    fetch(`${baseUrl}/api/v1/deployment-integration-events`, {
      headers: {...designatedHeaders, 'x-deny-permission': 'true'},
    }),
    fetch(`${baseUrl}/api/deployment-integration-events`, {headers: {Authorization: 'Bearer no-grant-user'}}),
    fetch(`${baseUrl}/api/v1/deployment-integration-events`, {headers: {Authorization: 'Bearer role-default-only'}}),
    fetch(`${baseUrl}/api/deployment-integration-events`, {headers: {Authorization: 'Bearer disabled-auditor'}}),
    fetch(`${baseUrl}/api/v1/deployment-integration-events`, {headers: {Authorization: 'Bearer stale-role-auditor'}}),
  ]);
  assert.deepEqual(denied.map(response => response.status), [401, 403, 403, 403, 403, 403],
    'unauthenticated users, permission denials, missing explicit grants, role-default-only access, disabled accounts and stale roles must be denied');
  assert.equal(poolQueries.filter(query => query.sql.includes('iel.organization_id is null')).length, 2,
    'a denied request must not run the deployment event query');

  denyFinalRead = true;
  const revokedBetweenChecks = await fetch(`${baseUrl}/api/deployment-integration-events`, {headers: designatedHeaders});
  assert.equal(revokedBetweenChecks.status, 200);
  assert.deepEqual(await revokedBetweenChecks.json(), [],
    'the final data query must return no rows if the designation is no longer active at read time');
  denyFinalRead = false;

  failQuery = true;
  const [legacyFailure, versionedFailure] = await Promise.all([
    fetch(`${baseUrl}/api/deployment-integration-events`, {headers: designatedHeaders}),
    fetch(`${baseUrl}/api/v1/deployment-integration-events`, {headers: designatedHeaders}),
  ]);
  assert.equal(legacyFailure.status, 500);
  assert.deepEqual(await legacyFailure.json(), {error: 'Database operation failed'},
    'the legacy route must not expose database diagnostics');
  assert.equal(versionedFailure.status, 500);
  const versionedError = await versionedFailure.json();
  assert.equal(versionedError.error.code, 'INTERNAL_ERROR');
  assert.equal(versionedError.error.message, 'The request could not be completed.');
  assert.equal(versionedError.error.correlationId, versionedFailure.headers.get('x-correlation-id'));
  assert(loggedErrors.every(message => message === 'synthetic deployment integration database detail'));
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Deployment integration history router smoke tests passed.');
