import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {adminService} from '../src/services/api.ts';
import {authService} from '../src/services/authService.ts';
import {ApiClientError, checkBackend, resetBackendCheck} from '../src/services/apiClient.ts';
import {OrganizationAuditDiscoveryStatus, OrganizationAuditHistoryStatus} from '../src/components/audit/OrganizationAuditHistory.tsx';

const values = new Map();
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
globalThis.localStorage = {getItem: () => { throw new Error('Designated evidence must not use local storage'); }, setItem: () => {}, removeItem: () => {}};
globalThis.window = {location: {pathname: '/audit-trail'}};
let allowed = true;
authService.getCurrentUser = () => ({id: 'reader-synthetic', employeeId: 'AUDIT-ORG-TEST', role: 'HR', permissionRole: 'HR', permissions: allowed ? ['audit.organization.view'] : []});
let status = 503;
let network = false;
let health = 'connected';
let empty = false;
const calls = [];
const privateMessage = '<script>private-password-token</script>';
const scope = {organization_id: 'org-synthetic', organization_code: 'SYN', organization_name: 'Synthetic organization', status: 'Active'};
const log = {id: 'organization-evidence', user_id: 'reader', user_name: 'Synthetic Reader', user_role: 'HR', action: 'Update', module: 'Organization', details: 'Synthetic evidence', created_at: '2026-10-18T00:00:00Z'};
globalThis.fetch = async (url, init = {}) => {
  calls.push({url, init});
  if (url === '/api/health') return new Response(JSON.stringify({database: health}), {status: 200});
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['X-Organization-Id'], undefined, 'designated organization reads work without selected legal-entity scope');
  assert.equal(init.headers['X-Legal-Entity-Id'], undefined);
  if (network) throw new TypeError(privateMessage);
  const data = empty ? [] : url === '/api/organization-audit-scopes' ? [scope] : [log];
  assert(url === '/api/organization-audit-scopes' || url.startsWith('/api/organization-audit-logs?organizationId='));
  return new Response(JSON.stringify(status === 200 ? data : {error: privateMessage}), {status});
};
const readers = [() => adminService.getOrganizationAuditScopesForHistory(), () => adminService.getOrganizationAuditLogsForHistory('org-synthetic')];
for (const reader of readers) {
  for (const failure of [401, 403, 404, 503]) {
    status = failure;
    await assert.rejects(reader(), error => error instanceof ApiClientError && error.status === failure);
  }
  network = true;
  await assert.rejects(reader(), TypeError);
  network = false;
  status = 200;
  empty = true;
  assert.deepEqual(await reader(), [], 'only successful empty evidence resolves to []');
  empty = false;
}
const scopes = await adminService.getOrganizationAuditScopesForHistory();
assert.deepEqual(scopes, [{organizationId: 'org-synthetic', organizationCode: 'SYN', organizationName: 'Synthetic organization', status: 'Active'}]);
assert.equal((await adminService.getOrganizationAuditLogsForHistory('org-synthetic'))[0].id, log.id);
await adminService.getOrganizationAuditLogsForHistory('synthetic/id?part=a&b');
assert(calls.at(-1).url.endsWith('organizationId=synthetic%2Fid%3Fpart%3Da%26b'), 'selected IDs remain safely URL encoded');
let before = calls.length;
for (const id of ['', '  ', null, {}, 1]) await assert.rejects(adminService.getOrganizationAuditLogsForHistory(id), error => error instanceof ApiClientError && error.status === 400);
assert.equal(calls.length, before);
allowed = false;
for (const reader of readers) await assert.rejects(reader(), error => error instanceof ApiClientError && error.status === 403);
assert.equal(calls.length, before, 'missing effective organization permission makes no request');
allowed = true;
health = 'offline';
resetBackendCheck();
await checkBackend().catch(() => {});
before = calls.length;
for (const reader of readers) assert.equal((await reader()).length, 1, 'strict designated retries reach the API after cached failed health');
assert.equal(calls.length, before + 2);
assert(calls.every(call => call.init.method === undefined || call.init.method === 'GET'));
for (const state of ['blocked', 'loading', 'access', 'error', 'ready']) {
  const discovery = renderToStaticMarkup(createElement(OrganizationAuditDiscoveryStatus, {status: state, count: 0, refresh: () => {}}));
  const history = renderToStaticMarkup(createElement(OrganizationAuditHistoryStatus, {status: state, rowCount: 0, unfilteredCount: 0, retry: () => {}}));
  assert(!discovery.includes(privateMessage) && !history.includes(privateMessage));
  if (state !== 'ready') { assert(!discovery.includes('No organization audit designations')); assert(!history.includes('No audit records were returned')); }
  if (state === 'ready') { assert(discovery.includes('No organization audit designations')); assert(history.includes('No audit records were returned')); }
  if (state === 'access' || state === 'error') { assert(discovery.includes('role="alert"')); assert(history.includes('role="alert"')); }
  if (state === 'access') { assert(history.includes('access is unavailable')); assert(history.includes('Refresh audit designations')); assert(!history.includes('does not exist')); }
}
console.log('Organization audit strict scope-free reads, error/empty distinction, permission denial, cached-health retry and safe presentation passed.');
