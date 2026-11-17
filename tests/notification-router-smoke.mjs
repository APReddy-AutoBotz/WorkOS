import assert from 'node:assert/strict';
import express from 'express';
import {createNotificationRouter} from '../server/modules/notifications/notification-router.mjs';

const permissionChecks = [];
const queries = [];
const auditEvents = [];
const deliveries = [];
const loggedErrors = [];
let connects = 0;
let clientQueries = [];
let failReadUpdate = false;
let failDelivery = false;
const pool = {
  async query(sql, params = []) {
    queries.push({sql, params});
    if (sql.includes('from notification_events ne') && sql.includes('order by ne.created_at')) return {rows: [{id: 'visible', recipient_name: 'Synthetic Employee'}]};
    if (sql.includes('update notification_events ne')) {
      if (failReadUpdate) throw new Error('synthetic notification database detail');
      return {rows: params[0] === 'visible' ? [{id: 'visible', read_at: '2026-10-01T00:00:00.000Z'}] : []};
    }
    if (sql.includes('select * from notification_templates order by')) return {rows: [{id: 'template-a'}]};
    if (sql.includes('select np.*, e.name as employee_name')) return {rows: [{id: 'preference-a'}]};
    if (sql.includes('from notification_delivery_attempts nda')) return {rows: [{id: 'delivery-a'}]};
    throw new Error(`Unexpected notification query: ${sql}`);
  },
  async connect() {
    connects += 1;
    clientQueries = [];
    return {
      async query(sql, params = []) {
        clientQueries.push({sql, params});
        if (['begin', 'commit', 'rollback'].includes(sql)) return {rows: []};
        if (sql.includes('from employees e') && sql.includes('e.id = $1 or e.employee_id = $1')) {
          return {rows: params[0] === 'E-1' ? [{id: 'employee-row-1', employee_id: 'E-1'}] : []};
        }
        if (sql.includes('select * from notification_preferences')) return {rows: []};
        if (sql.includes('insert into notification_preferences')) {
          return {rows: [{id: 'preference-created', employee_id: params[1], event_type: params[2], in_app: params[3], email: params[4], teams: params[5]}]};
        }
        if (sql.includes('insert into notification_templates')) {
          return {rows: [{id: 'template-created', event_type: params[1], channel: params[2], subject: params[3], body: params[4], active: params[5]}]};
        }
        throw new Error(`Unexpected notification transaction query: ${sql}`);
      },
      release() {},
    };
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireAuth = (req, _res, next) => {
  req.user = {activeRole: req.get('x-active-role') || 'Admin', employeeRecordId: 'employee-row-1', employeeId: 'E-1', username: 'synthetic-user'};
  req.organizationScope = {organizationId: 'org-a', legalEntityId: 'legal-a'};
  next();
};
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  if (req.get('x-deny-permission') === 'true') return res.status(403).json({error: 'Insufficient permission privileges'});
  next();
};
const buildEmployeeScopeWhere = (req, params, alias = 'e') => {
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  const ownership = `${alias}.organization_id = $${params.length - 1} and ${alias}.legal_entity_id = $${params.length}`;
  if (req.user.activeRole !== 'Employee') return ownership;
  params.push(req.user.employeeRecordId, req.user.employeeId);
  return `(${ownership}) and (${alias}.id = $${params.length - 1} or ${alias}.employee_id = $${params.length})`;
};
const run = async (res, sql, params = []) => {
  try { res.json((await pool.query(sql, params)).rows); }
  catch { res.status(500).json({error: 'Database operation failed'}); }
};
const audit = async (_client, _req, event) => auditEvents.push(event);
const sendNotification = async (_client, _req, event) => {
  if (failDelivery) throw new Error('synthetic delivery failure');
  deliveries.push(event);
  return {id: 'test-delivery-event', event_type: event.eventType};
};

const app = express();
app.use(express.json());
app.use('/api', createNotificationRouter({pool, run, requireDatabase, requireAuth, requirePermission, buildEmployeeScopeWhere, audit, sendNotification, logError: error => loggedErrors.push(error.message)}));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
const request = (path, {method = 'GET', body, role = 'Admin', headers = {}} = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {'content-type': 'application/json', 'x-active-role': role, ...headers},
  body: body === undefined ? undefined : JSON.stringify(body),
});

try {
  const feed = await request('/notifications', {role: 'Employee'});
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), [{id: 'visible', recipient_name: 'Synthetic Employee'}]);
  assert.deepEqual(queries.at(-1).params, ['org-a', 'legal-a', 'employee-row-1', 'E-1']);
  assert.match(queries.at(-1).sql, /e\.id = \$3 or e\.employee_id = \$4/);
  const queriesBeforePermissionDenial = queries.length;
  const permissionDenied = await request('/notifications', {role: 'Employee', headers: {'x-deny-permission': 'true'}});
  assert.equal(permissionDenied.status, 403);
  assert.equal(queries.length, queriesBeforePermissionDenial, 'permission denial must occur before database access');

  const read = await request('/notifications/visible/read', {method: 'PATCH', role: 'Employee'});
  assert.equal(read.status, 200);
  assert.deepEqual(queries.at(-1).params, ['visible', 'org-a', 'legal-a', 'employee-row-1', 'E-1']);
  assert.equal((await request('/notifications/hidden/read', {method: 'PATCH', role: 'Employee'})).status, 404);
  failReadUpdate = true;
  const readFailure = await request('/notifications/visible/read', {method: 'PATCH', role: 'Employee'});
  assert.equal(readFailure.status, 500);
  assert.deepEqual(await readFailure.json(), {error: 'Notification read update failed'});
  assert.deepEqual(loggedErrors, ['synthetic notification database detail']);
  failReadUpdate = false;

  assert.equal((await request('/notification-templates')).status, 200);
  assert.equal((await request('/notification-templates', {method: 'POST', body: {event_type: 'Test', channel: 'InApp'}})).status, 400);
  const template = await request('/notification-templates', {method: 'POST', body: {
    event_type: 'Test', channel: 'InApp', subject: 'Synthetic subject', body: 'Synthetic body',
  }});
  assert.equal(template.status, 200);
  assert.equal(auditEvents.at(-1).action, 'Create Notification Template');
  assert.equal(auditEvents.at(-1).organizationScope, null);
  assert(clientQueries.some(({sql}) => sql === 'commit'));

  assert.equal((await request('/notification-preferences', {role: 'Employee'})).status, 200);
  assert.deepEqual(queries.at(-1).params, ['org-a', 'legal-a', 'employee-row-1', 'E-1']);
  const beforeSelfDenial = connects;
  const otherPreference = await request('/notification-preferences', {
    method: 'POST', role: 'Employee', body: {employee_id: 'E-2', event_type: 'Test'},
  });
  assert.equal(otherPreference.status, 403);
  assert.equal(connects, beforeSelfDenial, 'self-only denial must occur before opening a transaction');
  const ownPreference = await request('/notification-preferences', {
    method: 'POST', role: 'Employee', body: {employee_id: 'E-1', event_type: 'Test', email: true},
  });
  assert.equal(ownPreference.status, 200);
  assert.equal((await ownPreference.json()).employee_id, 'employee-row-1');
  assert.deepEqual(clientQueries.find(({sql}) => sql.includes('select e.*') && sql.includes('from employees e')).params,
    ['E-1', 'org-a', 'legal-a', 'employee-row-1', 'E-1']);
  assert.equal(auditEvents.at(-1).action, 'Update Notification Preference');
  assert.equal(auditEvents.at(-1).newValue.id, 'preference-created');

  assert.equal((await request('/notification-delivery-attempts')).status, 200);
  assert.equal(deliveries.length, 0);
  assert.equal((await request('/notifications/test-delivery', {method: 'POST', body: {employee_id: 'OUTSIDE'}})).status, 403);
  assert.equal(deliveries.length, 0, 'out-of-scope recipient must never reach the delivery adapter');
  const delivery = await request('/notifications/test-delivery', {method: 'POST', body: {employee_id: 'E-1', channels: ['InApp']}});
  assert.equal(delivery.status, 200);
  assert.deepEqual(await delivery.json(), {id: 'test-delivery-event', event_type: 'TestDelivery'});
  assert.equal(deliveries.at(-1).recipientEmployeeId, 'employee-row-1');
  failDelivery = true;
  const deliveryFailure = await request('/notifications/test-delivery', {method: 'POST', body: {employee_id: 'E-1', channels: ['InApp']}});
  assert.equal(deliveryFailure.status, 500);
  assert.deepEqual(await deliveryFailure.json(), {error: 'Notification test delivery failed'});
  assert(clientQueries.some(({sql}) => sql === 'rollback'), 'delivery failures must roll back the transaction');
  assert(loggedErrors.includes('synthetic delivery failure'));
  failDelivery = false;
  assert.deepEqual(permissionChecks, [
    'notifications.view', 'notifications.view', 'notifications.view', 'notifications.view', 'notifications.view',
    'notifications.manage', 'notifications.manage', 'notifications.manage',
    'notifications.view', 'notifications.view', 'notifications.view',
    'notifications.manage', 'notifications.manage', 'notifications.manage', 'notifications.manage',
  ]);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log(JSON.stringify({status: 'passed', notificationRouter: true, routes: 8, scopedMutations: true}, null, 2));
