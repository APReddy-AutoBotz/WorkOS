import assert from 'node:assert/strict';
import {syntheticCredential} from './support/synthetic-values.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { applyPersistedTerminology, getConfiguredTerminologyValue, productConfig, resolveTerminologyValue } from '../src/config/productConfig.ts';
import { displayEntityType, termHelpText, termPlural, termPluralTitle, termTitle } from '../src/config/terminology.ts';
import { getReportExportOptions } from '../src/lib/reportExport.ts';
import { loadRuntimeTerminology } from '../src/config/RuntimeTerminology.tsx';
import { getOrganizationScope, getToken } from '../src/services/apiClient.ts';

// The real runtime captures the current actor, permissions, token and scope before its first await.
// Supply an actual synthetic session so failure/ownership tests exercise fetching rather than an early exit.
const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem: key => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
const runtimeUser = {
  id: 'worker-synthetic-runtime-one', employeeId: 'SYN-RUNTIME-ONE', role: 'HR', permissionRole: 'HR',
  permissions: ['settings.manage', 'employees.view'], name: 'Synthetic Runtime Operator',
};
const runtimeScope = {organizationId: 'org-synthetic-runtime-one', legalEntityId: 'legal-synthetic-runtime-one'};
const runtimeToken = syntheticCredential();
const setRuntimeUser = user => sessionValues.set('workos_session', JSON.stringify(user));
const setRuntimeScope = scope => sessionValues.set('workos_organization_scope', JSON.stringify(scope));
const resetRuntimeSession = () => {
  sessionValues.clear();
  setRuntimeUser(structuredClone(runtimeUser));
  setRuntimeScope(runtimeScope);
  sessionValues.set('workos_api_token', runtimeToken);
};
resetRuntimeSession();

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
const synthetic = Object.fromEntries(keys.map((key, index) => [key, {
  singular: `scope alpha ${key} ${index}`, plural: `scope alpha ${key} ${index} plural`, helpText: `Help for ${key}`,
}]));

applyPersistedTerminology(synthetic);
for (const key of keys) assert.equal(productConfig.terminology[key], synthetic[key].singular, `${key} must accept persisted runtime terminology`);
assert.equal(termTitle('project'), 'Scope Alpha Project 7');
assert.equal(termPluralTitle('employee'), 'Scope Alpha Employee 0 Plural');
assert.equal(termHelpText('employee'), 'Help for employee');
assert.equal(displayEntityType('Timesheet'), 'Scope Alpha Worklog 8');

applyPersistedTerminology({ ...synthetic, employee:{ singular:'person', plural:'people', helpText:'People who perform work.' }, manager:{ singular:'staff', plural:'staff', helpText:'' } });
assert.equal(termPlural('employee'), 'people', 'structured irregular plural must be authoritative');
assert.equal(termPlural('manager'), 'staff', 'structured uncountable plural must be authoritative');
assert.equal(termHelpText('employee'), 'People who perform work.', 'structured help text must reach runtime helpers');

applyPersistedTerminology({ employee:'person' });
assert.equal(termTitle('employee'), 'Person');
assert.equal(termPlural('employee'), 'persons', 'legacy persisted scalar uses the exact pre-change plural rule');
assert.equal(termHelpText('employee'), '');
assert.deepEqual(resolveTerminologyValue({ VITE_TERM_EMPLOYEE:'person' }, 'VITE_TERM_EMPLOYEE', 'resource'),
  { singular:'person', plural:'persons', helpText:'' }, 'legacy scalar environment override derives its plural');
assert.deepEqual(resolveTerminologyValue({ VITE_TERM_EMPLOYEE:'person', VITE_TERM_EMPLOYEE_PLURAL:'people', VITE_TERM_EMPLOYEE_HELP_TEXT:'Approved label.' }, 'VITE_TERM_EMPLOYEE', 'resource'),
  { singular:'person', plural:'people', helpText:'Approved label.' }, 'explicit plural and help environment overrides are authoritative');

applyPersistedTerminology(synthetic);
const reports = getReportExportOptions();
assert.match(reports.find(option => option.id === 'master_emp').title, /Scope Alpha Employee 0/);
assert.match(reports.find(option => option.id === 'master_prj').description, /scope alpha engagement 6/);
assert.match(reports.find(option => option.id === 'timesheet_logs').title, /Scope Alpha Worklog 8/);
assert.equal(reports.find(option => option.id === 'timesheet_logs').fileName, 'timesheets.csv', 'CSV filenames remain canonical');

applyPersistedTerminology(Object.fromEntries(keys.map(key => [key, `scope beta ${key}`])));
assert.equal(termTitle('employee'), 'Scope Beta Employee', 'scope refresh changes labels without a rebuild');
applyPersistedTerminology({});
assert.notEqual(termTitle('employee'), 'Scope Beta Employee', 'missing/fetch-failed terms restore configured defaults');
applyPersistedTerminology({ employee: 'unsafe stale label' });
await loadRuntimeTerminology(true, async () => { throw new Error('synthetic fetch failure'); });
assert.notEqual(termTitle('employee'), 'Unsafe Stale Label', 'fetch failure clears stale persisted terms');
await loadRuntimeTerminology(false, async () => ({ terms: synthetic }));
assert.notEqual(termTitle('employee'), 'Scope Alpha Employee 0', 'unauthenticated loading never applies persisted terms');

// Actual async ownership checks: a late success cannot replace another owner's labels,
// and a late failure cannot clear that owner's successfully loaded labels.
const deferredRuntime = () => {
  let resolve;
  let reject;
  const promise = new Promise((release, fail) => { resolve = release; reject = fail; });
  return {promise, resolve, reject};
};
const currentTerms = Object.fromEntries(keys.map(key => [key, {
  singular: `current ${key}`, plural: `current ${key} plural`, helpText: `Current ${key} help.`,
}]));
const runtimeSnapshot = () => keys.map(key => ({singular: productConfig.terminology[key], plural: termPlural(key), helpText: termHelpText(key)}));
const runtimeContextChanges = [
  ['actor ID', () => setRuntimeUser({...runtimeUser, id: 'worker-synthetic-runtime-two'})],
  ['employee ID', () => setRuntimeUser({...runtimeUser, employeeId: 'SYN-RUNTIME-TWO'})],
  ['active role', () => setRuntimeUser({...runtimeUser, role: 'Admin'})],
  ['permission role', () => setRuntimeUser({...runtimeUser, permissionRole: undefined})],
  ['effective permission set', () => setRuntimeUser({...runtimeUser, permissions: [...runtimeUser.permissions, 'projects.view']})],
  ['permission removal', () => setRuntimeUser({...runtimeUser, permissions: []})],
  ['bearer token', () => sessionValues.set('workos_api_token', 'synthetic-runtime-session-two')],
  ['bearer token removal', () => sessionValues.delete('workos_api_token')],
  ['organization', () => setRuntimeScope({...runtimeScope, organizationId: 'org-synthetic-runtime-two'})],
  ['legal entity', () => setRuntimeScope({...runtimeScope, legalEntityId: 'legal-synthetic-runtime-two'})],
  ['scope removal', () => sessionValues.delete('workos_organization_scope')],
  ['logout', () => setRuntimeUser(null)],
];
for (const [reason, change] of runtimeContextChanges) {
  for (const outcome of ['success', 'failure']) {
    resetRuntimeSession();
    applyPersistedTerminology(synthetic);
    const gate = deferredRuntime();
    let fetched = 0;
    const pending = loadRuntimeTerminology(undefined, () => { ++fetched; return gate.promise; });
    assert.equal(fetched, 1, 'ownership is captured before the real asynchronous fetch is dispatched');
    change();
    applyPersistedTerminology(currentTerms);
    const replacementLabels = runtimeSnapshot();
    const replacementSession = [...sessionValues];
    if (outcome === 'success') gate.resolve({terms: synthetic});
    else gate.reject(new Error('Synthetic late runtime failure'));
    assert.equal(await pending, false, `stale ${outcome} after ${reason} cannot signal a runtime remount`);
    assert.deepEqual(runtimeSnapshot(), replacementLabels, `stale ${outcome} after ${reason} cannot apply or clear replacement labels`);
    assert.deepEqual([...sessionValues], replacementSession, 'runtime ownership checks are session-neutral');
  }
}

// The supplied guard represents both route-generation replacement and effect cleanup/unmount.
for (const invalidation of ['new generation', 'unmount']) {
  for (const outcome of ['success', 'failure']) {
    resetRuntimeSession();
    let active = true;
    let generation = 1;
    const request = generation;
    const gate = deferredRuntime();
    const pending = loadRuntimeTerminology(undefined, () => gate.promise, () => active && generation === request);
    if (invalidation === 'new generation') ++generation;
    else active = false;
    applyPersistedTerminology(currentTerms);
    const before = runtimeSnapshot();
    if (outcome === 'success') gate.resolve({terms: synthetic});
    else gate.reject(new Error('Synthetic obsolete generation failure'));
    assert.equal(await pending, false, `${invalidation} suppresses ${outcome} completion`);
    assert.deepEqual(runtimeSnapshot(), before);
  }
}
resetRuntimeSession();
let runtimeGeneration = 1;
const earlier = deferredRuntime();
const first = loadRuntimeTerminology(undefined, () => earlier.promise, () => runtimeGeneration === 1);
++runtimeGeneration;
assert.equal(await loadRuntimeTerminology(undefined, async () => ({terms: currentTerms}), () => runtimeGeneration === 2), true);
const newest = runtimeSnapshot();
earlier.resolve({terms: synthetic});
assert.equal(await first, false);
assert.deepEqual(runtimeSnapshot(), newest, 'a same-identity out-of-order request cannot overwrite the newest runtime generation');

// Current ownership applies all structured values; unrelated display metadata and permission ordering are stable.
resetRuntimeSession();
const successful = deferredRuntime();
const currentLoad = loadRuntimeTerminology(undefined, () => successful.promise);
setRuntimeUser({...runtimeUser, name: 'Revised Synthetic Display Name', permissions: [...runtimeUser.permissions].reverse()});
successful.resolve({terms: synthetic});
assert.equal(await currentLoad, true);
for (const key of keys) {
  assert.equal(productConfig.terminology[key], synthetic[key].singular);
  assert.equal(termPlural(key), synthetic[key].plural);
  assert.equal(termHelpText(key), synthetic[key].helpText);
}
resetRuntimeSession();
applyPersistedTerminology(synthetic);
let currentFailures = 0;
assert.equal(await loadRuntimeTerminology(undefined, async () => { ++currentFailures; throw new Error('Synthetic current failure'); }), true);
assert.equal(currentFailures, 1, 'current failure actually fetches, rather than passing through a missing-scope shortcut');
for (const key of keys) assert.equal(productConfig.terminology[key], getConfiguredTerminologyValue(key).singular);
applyPersistedTerminology(synthetic);
assert.equal(await loadRuntimeTerminology(undefined, async () => ({})), true);
for (const key of keys) assert.equal(productConfig.terminology[key], getConfiguredTerminologyValue(key).singular, 'current empty server result restores configured defaults');

for (const missing of ['authentication', 'scope']) {
  resetRuntimeSession();
  if (missing === 'authentication') setRuntimeUser(null);
  else sessionValues.delete('workos_organization_scope');
  applyPersistedTerminology(synthetic);
  let fetched = false;
  assert.equal(await loadRuntimeTerminology(undefined, async () => { fetched = true; return {terms: synthetic}; }), true);
  assert.equal(fetched, false, `missing ${missing} never dispatches a terminology read`);
  for (const key of keys) assert.equal(productConfig.terminology[key], getConfiguredTerminologyValue(key).singular);
}
resetRuntimeSession();
applyPersistedTerminology(currentTerms);
const guardedBefore = runtimeSnapshot();
assert.equal(await loadRuntimeTerminology(false, async () => ({terms: synthetic}), () => false), false);
assert.deepEqual(runtimeSnapshot(), guardedBefore, 'an invalidated unauthenticated generation cannot clear current labels');

// Exercise the real scoped transport too: default runtime reads pin the dispatch scope and
// suppress the global 401 flow, including when a replacement login arrives before completion.
const originalFetch = globalThis.fetch;
const runtimeRequests = [];
const runtimeWindow = globalThis.window;
globalThis.window = {location: {pathname: '/terminology', href: '/terminology'}};
try {
  for (const status of [200, 401]) {
    resetRuntimeSession();
    const gate = deferredRuntime();
    globalThis.fetch = async (url, init) => {
      runtimeRequests.push({url, init: {...init, headers: {...init.headers}}});
      await gate.promise;
      return new Response(JSON.stringify(status === 200 ? {terms: synthetic} : {error: 'Synthetic runtime unauthorized'}), {status, headers: {'Content-Type': 'application/json'}});
    };
    const pending = loadRuntimeTerminology();
    const request = runtimeRequests.at(-1);
    assert.deepEqual(request, {url: '/api/organization-setup/terminology', init: {
      method: 'GET', credentials: 'include', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${runtimeToken}`,
        'X-Organization-Id': runtimeScope.organizationId, 'X-Legal-Entity-Id': runtimeScope.legalEntityId,
      },
    }});
    setRuntimeUser({...runtimeUser, id: 'worker-synthetic-runtime-replacement'});
    setRuntimeScope({organizationId: 'org-synthetic-runtime-replacement', legalEntityId: 'legal-synthetic-runtime-replacement'});
    sessionValues.set('workos_api_token', 'synthetic-runtime-replacement-session');
    applyPersistedTerminology(currentTerms);
    const replacement = runtimeSnapshot();
    const replacementScope = getOrganizationScope();
    gate.resolve();
    assert.equal(await pending, false);
    assert.deepEqual(runtimeSnapshot(), replacement);
    assert.equal(getToken(), 'synthetic-runtime-replacement-session');
    assert.deepEqual(getOrganizationScope(), replacementScope);
    assert.equal(window.location.href, '/terminology', 'stale runtime 401 cannot globally redirect the replacement login');
  }
  assert.equal(runtimeRequests.length, 2, 'each default runtime load dispatches exactly one scoped read');
  for (const status of [200, 401]) {
    resetRuntimeSession();
    applyPersistedTerminology(currentTerms);
    const beforeSession = [...sessionValues];
    globalThis.fetch = async () => new Response(JSON.stringify(status === 200 ? {terms: synthetic} : {error: 'Synthetic current runtime unauthorized'}), {status, headers: {'Content-Type': 'application/json'}});
    assert.equal(await loadRuntimeTerminology(), true, 'a current default transport completion allows the runtime refresh');
    for (const key of keys) assert.equal(productConfig.terminology[key], status === 200 ? synthetic[key].singular : getConfiguredTerminologyValue(key).singular);
    assert.deepEqual([...sessionValues], beforeSession, 'even a current scoped 401 never invokes the global logout flow');
    assert.equal(window.location.href, '/terminology');
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.window = runtimeWindow;
  resetRuntimeSession();
  applyPersistedTerminology({});
}

const surfaces = {
  employee: ['src/components/Layout/Sidebar.tsx', 'src/components/forms/EmployeeForm.tsx'],
  manager: ['src/components/forms/EmployeeForm.tsx', 'src/components/forms/ProjectForm.tsx'],
  teamLead: ['src/components/forms/ProjectForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  businessUnit: ['src/components/forms/EmployeeForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  region: ['src/components/forms/EmployeeForm.tsx', 'src/components/employee/OrgChartView.tsx'],
  regionalOwner: ['src/components/forms/EmployeeForm.tsx', 'src/lib/reportExport.ts'],
  engagement: ['src/pages/ProjectDetail.tsx', 'src/lib/reportExport.ts'],
  project: ['src/components/Layout/Sidebar.tsx', 'src/components/forms/ProjectForm.tsx'],
  worklog: ['src/lib/reportExport.ts', 'src/services/api.ts'],
};
for (const [key, files] of Object.entries(surfaces)) {
  assert(files.some(file => read(file).includes(`'${key}'`)), `${key} must be consumed on a covered display surface`);
}

const runtime = read('src/config/RuntimeTerminology.tsx');
assert.match(runtime, /workos:organization-scope-changed/);
assert.match(runtime, /applyPersistedTerminology\(\{\}\)/, 'unauthenticated/fetch failure fallback remains deterministic');
const configSource = read('src/config/productConfig.ts');
assert.match(configSource, /envValue \? legacyPluralize\(singular\) : fallbackPlural/, 'legacy scalar environment overrides derive the pre-change plural');
assert.match(configSource, /explicitPlural \|\|/, 'an explicit structured plural environment value takes precedence');

const canonical = [
  ['src/components/Layout/Sidebar.tsx', "path: '/employees'"],
  ['src/components/Layout/Sidebar.tsx', "path: '/projects'"],
  ['src/services/api.ts', "eventType: 'ApprovalRequested'"],
  ['src/services/api.ts', 'entityType: next.entityType'],
  ['src/lib/reportExport.ts', "fileName: 'timesheets.csv'"],
];
for (const [file, token] of canonical) assert(read(file).includes(token), `canonical token changed: ${file} ${token}`);

const literalBypassAllowList = new Set([
  'src/components/ui/PageHeader.tsx', // canonical breadcrumb-to-route mapping
  'src/services/permissions.ts', // stable permission registry documentation
]);
for (const file of literalBypassAllowList) assert(fs.existsSync(path.join(root, file)));

const coveredLiteralScan = {
  'src/components/Layout/Sidebar.tsx': ['Employee Directory', 'Project Master'],
  'src/components/forms/EmployeeForm.tsx': ['Employee ID is required', '>Employee ID<', '>Region<', '>Business Unit<', '>Reporting Manager<'],
  'src/components/forms/ProjectForm.tsx': ['Project Name is required', 'Project Code is required', '>Project Manager<'],
  'src/lib/reportExport.ts': ['Employee Master Export', 'Project Master Export', 'Timesheet Audit Export', 'Employee-project assignments'],
};
for (const [file, literals] of Object.entries(coveredLiteralScan)) {
  const source = read(file);
  for (const literal of literals) assert(!source.includes(literal), `covered display literal bypasses terminology: ${file}: ${literal}`);
}

console.log('Runtime terminology smoke checks passed: structured display consumers and stable canonical contracts; actual asynchronous current/stale success and failure across actor, role, permissions, token, scope, generation and unmount; pinned scoped GET and replacement-session 401 isolation.');
