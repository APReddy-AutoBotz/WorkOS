import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {adminService} from '../src/services/api.ts';
import {authService} from '../src/services/authService.ts';
import {ApiClientError, checkBackend, resetBackendCheck} from '../src/services/apiClient.ts';
import {DeploymentAuditStatus} from '../src/components/audit/DeploymentAuditHistory.tsx';
const storage = new Map();
globalThis.sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
globalThis.localStorage = {getItem: () => { throw new Error('Deployment evidence must not use local storage'); }, setItem: () => {}, removeItem: () => {}};
globalThis.window = {location: {pathname: '/audit-trail'}};
let allowed = true;
authService.getCurrentUser = () => ({id: 'deployment-reader-synthetic', employeeId: 'DEPLOYMENT-TEST', role: 'HR', permissionRole: 'HR', permissions: allowed ? ['audit.deployment.view'] : []});
let status = 503;
let network = false;
let empty = false;
let malformed = false;
let health = 'connected';
const calls = [];
const privateMessage = '<script>private-password-token</script>';
const audit = {id: 'deployment-audit', user_id: 'reader', user_name: 'Synthetic Reader', user_role: 'HR', action: 'Update', module: 'System', details: 'Synthetic evidence', created_at: '2026-10-18T00:00:00Z'};
const event = {id: 'deployment-event', provider: 'synthetic', event_type: 'SyntheticDelivered', status: 'Success', response_payload: {deliveryStatus: 'Delivered'}, created_at: '2026-10-18T00:00:00Z'};
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') return new Response(JSON.stringify({database: health}), {status: 200});
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['X-Organization-Id'], undefined);
  assert.equal(init.headers['X-Legal-Entity-Id'], undefined);
  assert(url === '/api/deployment-audit-logs' || url === '/api/v1/deployment-integration-events');
  if (network) throw new TypeError(privateMessage);
  return new Response(JSON.stringify(status === 200 ? malformed ? {} : empty ? [] : [url === '/api/deployment-audit-logs' ? audit : event] : {error: privateMessage}), {status});
};
const readers = [adminService.getDeploymentAuditLogsForHistory, adminService.getDeploymentIntegrationEventsForHistory];
for (const reader of readers) {
  for (const failure of [401, 403, 404, 503]) {
    status = failure;
    await assert.rejects(reader(), error => error instanceof ApiClientError && error.status === failure);
  }
  network = true;
  await assert.rejects(reader(), TypeError);
  network = false;
  status = 200;
  malformed = true;
  await assert.rejects(reader(), TypeError, 'malformed successful payload must not become empty evidence');
  malformed = false;
  empty = true;
  assert.deepEqual(await reader(), []);
  empty = false;
}
assert.equal((await readers[0]())[0].userName, 'Synthetic Reader');
assert.equal((await readers[1]())[0].eventType, 'SyntheticDelivered');
assert.deepEqual((await readers[1]())[0].responsePayload, {deliveryStatus: 'Delivered'});
status = 503;
resetBackendCheck();
assert.deepEqual(await adminService.getDeploymentAuditLogs(), [], 'legacy audit compatibility reader remains unchanged');
assert.deepEqual(await adminService.getDeploymentIntegrationEvents(), [], 'legacy integration compatibility reader remains unchanged');
let before = calls.length;
allowed = false;
for (const reader of readers) await assert.rejects(reader(), error => error instanceof ApiClientError && error.status === 403);
assert.equal(calls.length, before, 'missing effective deployment permission causes no request');
allowed = true;
status = 200;
health = 'offline';
resetBackendCheck();
await checkBackend().catch(() => {});
before = calls.length;
for (const reader of readers) assert.equal((await reader()).length, 1, 'strict API-only retry bypasses cached failed health without local fallback');
assert.equal(calls.length, before + 2);
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'));
for (const kind of ['audit', 'integration']) for (const state of ['blocked', 'loading', 'access', 'error', 'ready']) {
  const markup = renderToStaticMarkup(createElement(DeploymentAuditStatus, {kind, status: state, rowCount: 0, unfilteredCount: 0, refresh: () => {}}));
  assert(!markup.includes(privateMessage));
  if (state !== 'ready') assert(!markup.includes(`No deployment ${kind} records were returned`));
  if (state === 'ready') assert(markup.includes(`No deployment ${kind} records were returned`));
  if (state === 'access' || state === 'error') { assert(markup.includes('role="alert"')); assert(markup.includes(`Retry deployment ${kind}`)); }
}
const filtered = renderToStaticMarkup(createElement(DeploymentAuditStatus, {kind: 'audit', status: 'ready', rowCount: 0, unfilteredCount: 1, refresh: () => {}}));
assert(filtered.includes('match the current filters'));
console.log('Deployment audit/integration strict scope-free reads, compatibility, failure/empty, permission denial, health retry and safe status checks passed.');
