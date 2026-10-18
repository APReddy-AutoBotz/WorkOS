import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {adminService} from '../src/services/api.ts';
import {authService} from '../src/services/authService.ts';
import {ApiClientError, checkBackend, isDemoFallbackAllowed, resetBackendCheck} from '../src/services/apiClient.ts';
import {ScopedAuditHistoryStatus} from '../src/components/audit/ScopedAuditHistory.tsx';

const values = new Map([['workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'})]]);
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
globalThis.localStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
globalThis.window = {location: {pathname: '/audit-trail'}};
let allowed = true;
authService.getCurrentUser = () => ({id: 'synthetic-reader', employeeId: 'AUDIT-TEST', role: 'HR', permissionRole: 'HR', permissions: allowed ? ['audit.view'] : []});
const calls = [];
let status = 503;
let networkFailure = false;
let health = 'connected';
const privateMessage = '<script>private-password-token</script>';
const row = {id: 'synthetic-audit', user_id: 'reader', user_name: 'Synthetic Reader', user_role: 'HR', action: 'Update', module: 'Employee', details: 'Synthetic evidence', created_at: '2026-10-18T00:00:00Z'};
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') return new Response(JSON.stringify({database: health}), {status: 200});
  assert.equal(url, '/api/audit-logs');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['X-Organization-Id'], 'org-synthetic');
  assert.equal(init.headers['X-Legal-Entity-Id'], 'entity-synthetic');
  if (networkFailure) throw new TypeError(privateMessage);
  return new Response(JSON.stringify(status === 200 ? [row] : status === 204 ? [] : {error: {code: 'SYNTHETIC_FAILURE', message: privateMessage}}), {status: status === 204 ? 200 : status});
};
resetBackendCheck();
for (const failure of [403, 503]) {
  status = failure;
  await assert.rejects(adminService.getScopedAuditHistory(), error => error instanceof ApiClientError && error.status === failure);
  assert.deepEqual(await adminService.getAuditLogs(), [], 'legacy Dashboard/report-export reader retains its existing error fallback');
}
networkFailure = true;
await assert.rejects(adminService.getScopedAuditHistory(), TypeError);
networkFailure = false;
status = 200;
const loaded = await adminService.getScopedAuditHistory();
assert.equal(loaded[0].id, row.id, 'a subsequent read recovers and normalizes authoritative API evidence');
assert.equal(loaded[0].userName, 'Synthetic Reader');
status = 204;
assert.deepEqual(await adminService.getScopedAuditHistory(), [], 'successful empty differs from rejected reads');
const beforeDenied = calls.length;
allowed = false;
await assert.rejects(adminService.getScopedAuditHistory(), error => error instanceof ApiClientError && error.status === 403);
assert.equal(calls.length, beforeDenied, 'denied local permission makes no request');
allowed = true;
values.delete('workos_organization_scope');
// HR demo mode intentionally supports the existing synthetic unscoped fallback; production must refuse it.
if (!isDemoFallbackAllowed()) {
  await assert.rejects(adminService.getScopedAuditHistory(), error => error instanceof ApiClientError && error.status === 403);
  assert.equal(calls.length, beforeDenied, 'production missing-scope denial makes no request');
}
values.set('workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'}));
if (!isDemoFallbackAllowed()) {
  health = 'offline';
  resetBackendCheck();
  await assert.rejects(checkBackend());
  status = 503;
  await assert.rejects(adminService.getScopedAuditHistory(), error => error instanceof ApiClientError && error.status === 503);
  status = 200;
  assert.equal((await adminService.getScopedAuditHistory())[0].id, row.id, 'strict production retries are not trapped by a cached health failure');
}
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'), 'reader tests never mutate evidence');
for (const state of ['loading', 'blocked', 'denied', 'error', 'ready']) {
  const markup = renderToStaticMarkup(createElement(ScopedAuditHistoryStatus, {status: state, hasPermission: true, rowCount: 0, unfilteredCount: 0, retry: () => {}}));
  assert(!markup.includes(privateMessage));
  if (state === 'loading') { assert(markup.includes('Loading selected-scope')); assert(!markup.includes('No audit records')); }
  if (state === 'error' || state === 'denied') { assert(markup.includes('role="alert"')); assert(markup.includes('Retry audit history')); assert(!markup.includes('No audit records')); }
  if (state === 'ready') assert(markup.includes('No audit records were returned'));
}
const denied = renderToStaticMarkup(createElement(ScopedAuditHistoryStatus, {status: 'blocked', hasPermission: false, rowCount: 0, unfilteredCount: 0, retry: () => {}}));
assert(denied.includes('do not have access'));
const filtered = renderToStaticMarkup(createElement(ScopedAuditHistoryStatus, {status: 'ready', hasPermission: true, rowCount: 0, unfilteredCount: 1, retry: () => {}}));
assert(filtered.includes('match the current filters'));
assert.match(readFileSync('src/pages/Dashboard.tsx', 'utf8'), /adminService\.getAuditLogs\(\)/);
assert.match(readFileSync('src/lib/reportExport.ts', 'utf8'), /adminService\.getAuditLogs\(\)/);
if (!process.env.WORKOS_AUDIT_PRODUCTION_CHILD) {
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/scoped-audit-history-smoke.mjs'], {stdio: 'inherit', env: {...process.env, APP_MODE: 'production', VITE_APP_MODE: 'production', VITE_ALLOW_TEST_FALLBACK: 'false', WORKOS_AUDIT_PRODUCTION_CHILD: '1'}});
}
console.log('Selected-scope audit history strict read, fallback compatibility, failure/empty states and production retry checks passed.');
