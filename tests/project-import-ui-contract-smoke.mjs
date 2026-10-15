import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {adminService, employeeService} from '../src/services/api.ts';
import {resetBackendCheck} from '../src/services/apiClient.ts';
import {filterAcceptedImportRows, redactCredentialEchoes} from '../src/lib/importOperation.ts';
import {downloadAuditedCsv, downloadReportExport} from '../src/lib/reportExport.ts';

const sessionValues = new Map([
  ['workos_api_token', 'synthetic-api-token'],
  ['workos_organization_scope', JSON.stringify({organizationId: 'org-synthetic', legalEntityId: 'entity-synthetic'})],
]);
globalThis.sessionStorage = {
  getItem: key => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: key => sessionValues.delete(key),
};
globalThis.localStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
globalThis.window = {location: {pathname: '/import-export'}, dispatchEvent: () => {}};

const calls = [];
let deferNextHealthCheck = false;
let resolveHealthStarted;
let releaseHealthCheck;
let healthCheckStarted = Promise.resolve();
let healthCheckGate = Promise.resolve();
let deferNextHistoryWrite = false;
let resolveHistoryWriteStarted;
let releaseHistoryWrite;
let historyWriteStarted = Promise.resolve();
let historyWriteGate = Promise.resolve();
let failNextAuditWrite = false;
const downloadedFiles = [];
globalThis.document = {createElement: () => ({
  click() { downloadedFiles.push(this.download); },
  href: '',
  download: '',
})};
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = () => 'blob:synthetic-export';
URL.revokeObjectURL = () => {};
const prepareDeferredHealthCheck = () => {
  deferNextHealthCheck = true;
  healthCheckStarted = new Promise(resolve => { resolveHealthStarted = resolve; });
  healthCheckGate = new Promise(resolve => { releaseHealthCheck = resolve; });
};
const prepareDeferredHistoryWrite = () => {
  deferNextHistoryWrite = true;
  historyWriteStarted = new Promise(resolve => { resolveHistoryWriteStarted = resolve; });
  historyWriteGate = new Promise(resolve => { releaseHistoryWrite = resolve; });
};
globalThis.fetch = async (url, init = {}) => {
  if (url === '/api/health') {
    if (deferNextHealthCheck) {
      deferNextHealthCheck = false;
      resolveHealthStarted();
      await healthCheckGate;
    }
    return new Response(JSON.stringify({database: 'connected'}), {status: 200, headers: {'Content-Type': 'application/json'}});
  }
  const body = JSON.parse(init.body);
  calls.push({url, init, body});
  if (url === '/api/audit-events' && failNextAuditWrite) {
    failNextAuditWrite = false;
    calls.at(-1).failed = true;
    return new Response(JSON.stringify({error: {code: 'SYNTHETIC_AUDIT_FAILURE', message: 'Synthetic audit failure.'}}), {
      status: 503, headers: {'Content-Type': 'application/json'},
    });
  }
  if (url === '/api/import-export-logs' && deferNextHistoryWrite) {
    deferNextHistoryWrite = false;
    resolveHistoryWriteStarted();
    await historyWriteGate;
  }
  const channel = ({
    'client-master/1': 'Client Master',
    'project-master/1': 'Project Master',
    'allocation-control/1': 'Allocation Control',
    'timesheet-import/1': 'Timesheet Import',
    'employee-master/1': 'Employee Master',
  })[body.schemaVersion];
  return new Response(JSON.stringify({
    status: body.dryRun ? 'Dry Run' : 'Success',
    totalRows: 2,
    validRows: 1,
    errorRows: 1,
    errors: [{rowNumber: 3, field: 'managerId', message: 'Manager was not found.'}],
    ...(body.schemaVersion === 'employee-master/1' ? {replayed: true} : {}),
    log: {id: 'batch-synthetic', file_name: body.fileName, operation: 'Import', channel,
      status: body.dryRun ? 'Dry Run' : 'Success', total_rows: 2, valid_rows: 1, error_rows: 1,
      schema_version: body.schemaVersion, dry_run: body.dryRun},
  }), {status: 200, headers: {'Content-Type': 'application/json'}});
};

const rowOne = {projectCode: 'PROJECT-101', name: 'Synthetic Project 101'};
const rowTwo = {projectCode: 'PROJECT-102', name: 'Synthetic Project 102'};
const dryRunRequest = {
  fileName: 'projects.csv', rows: [rowOne, rowTwo], clientErrors: [], totalRows: 2,
  dryRun: true, idempotencyKey: 'same-dry-run-retry-key',
};
const firstPreview = await adminService.runVersionedProjectImport(dryRunRequest);
const retriedPreview = await adminService.runVersionedProjectImport(dryRunRequest);
const applied = await adminService.runVersionedProjectImport({
  ...dryRunRequest,
  rows: [rowOne],
  clientErrors: [{rowNumber: 3, field: 'managerId', message: 'Manager was not found.'}],
  dryRun: false,
  idempotencyKey: 'new-apply-key',
});
const clientPreview = await adminService.runVersionedClientImport({
  fileName: 'clients.csv', rows: [{id: 'CLIENT-101', name: 'Synthetic Client 101'}], clientErrors: [], totalRows: 1,
  dryRun: true, idempotencyKey: 'client-dry-run-key',
});
const allocationPreview = await adminService.runVersionedAllocationImport({
  fileName: 'allocations.csv', rows: [{employeeId: 'EMP-101', projectId: 'PROJ-101', percentage: 25}],
  clientErrors: [], totalRows: 1, dryRun: true, idempotencyKey: 'allocation-dry-run-key',
});
const timesheetPreview = await adminService.runVersionedTimesheetImport({
  fileName: 'timesheets.csv', rows: [{employeeId: 'EMP-101', weekEnding: '2026-09-27', date: '2026-09-25', workType: 'Client Misc Task', clientName: 'Synthetic Client', hours: 7.5}],
  clientErrors: [], totalRows: 1, dryRun: true, idempotencyKey: 'timesheet-dry-run-key',
});
const employeePreviewCredential = 'Synthetic-Preview-Credential-19af';
const extraPasswordColumn = 'Synthetic-Extra-Password-Column-4d1';
const extraTokenColumn = 'Synthetic-Extra-Token-Column-8b2';
const employeePreview = await adminService.runVersionedEmployeeImport({
  rows: [{employeeId: 'EMP-101', name: 'Synthetic Employee', email: 'employee@example.test', designation: 'Consultant',
    department: 'Engineering', password: extraPasswordColumn, accessToken: extraTokenColumn,
    initialPassword: employeePreviewCredential}],
  clientErrors: [{rowNumber: 3, field: 'email', message: `Old diagnostic ${employeePreviewCredential}`, sourceIdentifier: employeePreviewCredential}],
  totalRows: 1,
  idempotencyKey: 'employee-dry-run-key',
});
const employeeApply = await adminService.applyEmployeeImport(
  'employees.csv', [{employeeId: 'EMP-101', name: 'Synthetic Employee', email: 'employee@example.test'}],
  'employee-apply-key', [], 1,
);

assert.equal(calls.length, 8);
const projectCalls = calls.filter(call => call.url === '/api/v1/imports/projects/apply');
assert.equal(projectCalls.length, 3, 'the project import service must use the versioned API');
assert.deepEqual(projectCalls.map(call => call.init.headers['Idempotency-Key']), [
  'same-dry-run-retry-key', 'same-dry-run-retry-key', 'new-apply-key',
], 'an identical dry-run retry reuses its key and apply uses a distinct key');
assert.deepEqual(projectCalls.map(call => call.body.dryRun), [true, true, false]);
assert.ok(projectCalls.every(call => call.body.schemaVersion === 'project-master/1'));
assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer synthetic-api-token'));
assert.ok(calls.every(call => call.init.headers['X-Organization-Id'] === 'org-synthetic'));
assert.ok(calls.every(call => call.init.headers['X-Legal-Entity-Id'] === 'entity-synthetic'));
assert.equal(firstPreview?.dryRun, true);
assert.equal(firstPreview?.schemaVersion, 'project-master/1');
assert.equal(retriedPreview?.dryRun, true);
assert.equal(applied?.dryRun, false);
assert.equal(clientPreview?.dryRun, true);
assert.equal(clientPreview?.schemaVersion, 'client-master/1');
const clientCall = calls.find(call => call.url === '/api/v1/imports/clients/apply');
assert.deepEqual(clientCall.body, {
  schemaVersion: 'client-master/1', dryRun: true, fileName: 'clients.csv',
  rows: [{id: 'CLIENT-101', name: 'Synthetic Client 101'}], totalRows: 1, clientErrors: [],
}, 'the client import service sends the canonical versioned dry-run payload');
assert.equal(clientCall.init.headers['Idempotency-Key'], 'client-dry-run-key');
const allocationCall = calls.find(call => call.url === '/api/v1/imports/allocations/apply');
assert.ok(allocationCall, 'Allocation Control uses the versioned API');
assert.equal(allocationCall.body.schemaVersion, 'allocation-control/1');
assert.equal(allocationCall.body.dryRun, true);
assert.equal(allocationCall.init.headers['Idempotency-Key'], 'allocation-dry-run-key');
assert.equal(allocationPreview?.schemaVersion, 'allocation-control/1');
assert.equal(allocationPreview?.dryRun, true);
const timesheetCall = calls.find(call => call.url === '/api/v1/imports/timesheets/apply');
assert.ok(timesheetCall, 'Timesheet Import uses the versioned API');
assert.equal(timesheetCall.body.schemaVersion, 'timesheet-import/1');
assert.equal(timesheetCall.body.dryRun, true);
assert.equal(timesheetCall.init.headers['Idempotency-Key'], 'timesheet-dry-run-key');
assert.equal(timesheetPreview?.schemaVersion, 'timesheet-import/1');
assert.equal(employeePreview?.schemaVersion, 'employee-master/1');
assert.equal(employeePreview?.dryRun, true);
assert.equal(employeePreview?.replayed, true);
const employeePreviewCall = calls.find(call => call.url === '/api/v1/imports/employees/apply' && call.body.dryRun === true);
assert.ok(employeePreviewCall, 'Employee Master dry-run uses the versioned API');
assert.deepEqual(employeePreviewCall.body, {
  schemaVersion: 'employee-master/1', dryRun: true, fileName: 'Employee Master import.csv',
  rows: [{employeeId: 'EMP-101', name: 'Synthetic Employee', email: 'employee@example.test',
    designation: 'Consultant', department: 'Engineering', initialPasswordPresent: true}],
  totalRows: 1,
  clientErrors: [{rowNumber: 3, field: 'email', message: 'The Employee Master row failed preflight validation.'}],
}, 'Employee preview sends only nonsecret business rows, a credential-presence indicator and generic diagnostics');
assert.equal(JSON.stringify(employeePreviewCall.body).includes(employeePreviewCredential), false,
  'the Employee preview request must not transmit the credential or stale diagnostic/source-ID echo');
for (const [field, value] of [['password', extraPasswordColumn], ['accessToken', extraTokenColumn]]) {
  assert.equal(Object.hasOwn(employeePreviewCall.body.rows[0], field), false,
    `unrecognized Employee CSV credential column ${field} is removed before fetch`);
  assert.equal(JSON.stringify(employeePreviewCall.body).includes(value), false,
    `unrecognized Employee CSV credential value from ${field} never reaches fetch`);
}
assert.equal(employeePreviewCall.init.headers['Idempotency-Key'], 'employee-dry-run-key');
assert.equal(timesheetPreview?.dryRun, true);
assert.equal(employeeApply?.validRows, 1);
assert.equal(employeeApply?.replayed, true, 'Employee v1 retry response exposes the first-result replay status');
const employeeCall = calls.find(call => call.url === '/api/v1/imports/employees/apply' && call.body.dryRun !== true);
assert.ok(employeeCall, 'Employee Master uses the versioned API');
assert.deepEqual(employeeCall.body, {
  schemaVersion: 'employee-master/1', fileName: 'employees.csv',
  rows: [{employeeId: 'EMP-101', name: 'Synthetic Employee', email: 'employee@example.test'}],
  totalRows: 1, clientErrors: [],
});
assert.equal(employeeCall.init.headers['Idempotency-Key'], 'employee-apply-key');

const rowThree = {projectCode: 'PROJECT-103', name: 'Synthetic Project 103'};
assert.deepEqual(filterAcceptedImportRows([rowOne, rowTwo, rowThree], [rowOne, rowThree], [{rowNumber: 4}]), [rowOne],
  'server errors filter only submitted rows using their original CSV row numbers');
assert.deepEqual(filterAcceptedImportRows([rowOne], [], [{rowNumber: 1}]), [],
  'a header-level error does not reintroduce rows excluded from the server dry run');
const employeeCredential = 'Synthetic-Initial-Password-7ac43';
assert.deepEqual(redactCredentialEchoes({
  fileName: `employees-${employeeCredential}.csv`,
  errors: [{message: `Country director ${employeeCredential} does not exist.`}],
}, [employeeCredential]), {
  fileName: 'employees-.csv',
  errors: [{message: 'Country director  does not exist.'}],
}, 'Employee client preflight filenames and diagnostics must remove exact initial-password echoes');

const page = readFileSync('src/pages/ImportExport.tsx', 'utf8');
const apiSource = readFileSync('src/services/api.ts', 'utf8');
assert.match(page, /dryRunKey:\s*crypto\.randomUUID\(\)/, 'a newly uploaded project CSV gets a fresh dry-run key');
assert.match(page, /applyKey:\s*crypto\.randomUUID\(\)/, 'a newly uploaded project CSV gets a distinct apply key');
assert.match(page, /idempotencyKey:\s*basePending\.versionedOperation!\.dryRunKey/, 'initial dry run uses the pending operation key');
assert.match(page, /idempotencyKey:\s*snapshot\.versionedOperation\.dryRunKey/, 'validation retry reuses the same key and snapshot');
assert.match(page, /idempotencyKey:\s*operation\.applyKey/, 'apply retry reuses the same apply key');
assert.match(page, /IDEMPOTENCY_KEY_REUSED/, 'a changed-payload/key conflict requires a fresh import');
assert.match(page, /const isCurrentRequest = \(\) => importRequestIsCurrent\(requestVersion, scopeKey\)/, 'stale upload responses cannot replace the latest pending import or cross organization scope');
assert.match(page, /workos:organization-scope-changed/, 'organization/entity scope changes invalidate pending imports and in-flight response state');
assert.match(page, /scopeKey === currentImportScopeKey\(\)/, 'late import responses are ignored if selected scope changed without using the event');
assert.match(page, /runVersionedImport\([\s\S]*\}, scope\)/, 'versioned dry runs carry the original scope snapshot');
assert.match(page, /pendingImport\.rows\.length,[\s\S]*pendingImport\.scope/, 'Employee apply carries its scope snapshot');
assert.match(page, /filterAcceptedImportRows\(rows, validRows, serverErrors\)/, 'only client-approved, server-approved rows remain eligible for apply');
assert.match(page, /client-master\/1/, 'Client Master is bound to its explicit schema version in the UI');
assert.match(page, /employees: 'employee-master\/1'/, 'Employee Master is included in the versioned server-preview contract');
assert.match(page, /runVersionedEmployeeImport/, 'Employee preview uses the dedicated credential-safe API method');
assert.match(apiSource, /initialPasswordPresent: Boolean\(row\.initialPassword\)/, 'Employee preview sends a nonsecret credential-presence indicator only');
assert.match(apiSource, /employeePreviewRowFields\.reduce/, 'Employee preview builds rows from an explicit canonical allowlist before fetch');
assert.match(page, /employeeImportOperation:\s*\{[\s\S]*applyKey:\s*crypto\.randomUUID\(\)/,
  'a newly selected Employee Master CSV gets a fresh in-memory apply key');
assert.match(page, /operation\.applyKey,[\s\S]*pendingImport\.errors,[\s\S]*pendingImport\.rows\.length/,
  'Employee Master retry uses the same pending key and request data');
assert.match(page, /will not change credentials/i,
  'Employee Master UI explains that retry replays the first accepted result without changing credentials');
assert.match(page, /redactCredentialEchoes\(preflightErrors, employeeCredentials\)/,
  'Employee preflight history must sanitize diagnostics before generic log persistence');
assert.match(page, /const readLabel = id === 'employees' \? `\$\{termTitle\('employee'\)\} Master CSV` : file\.name/,
  'Employee upload loading and read errors must use a generic label before the credential column has been parsed');
assert.match(page, /setLastResult\(`Reading \$\{readLabel\}…`\)/,
  'Employee loading status must not render an unparsed filename');
assert.match(page, /Could not read \$\{readLabel\}\. Choose the file again to retry\./,
  'Employee file-read failures must not render an unparsed filename');

resetBackendCheck();
prepareDeferredHealthCheck();
const originalScope = JSON.parse(sessionValues.get('workos_organization_scope'));
const scopeBoundPreview = adminService.runVersionedProjectImport(dryRunRequest, originalScope);
await healthCheckStarted;
sessionValues.set('workos_organization_scope', JSON.stringify({organizationId: 'org-changed', legalEntityId: 'entity-changed'}));
releaseHealthCheck();
await assert.rejects(scopeBoundPreview, /scope changed before the import request was sent/i,
  'an organization/entity change during the async health check blocks sending the import to a different scope');
assert.equal(calls.length, 8, 'scope mismatch after health check sends no import POST');

resetBackendCheck();
prepareDeferredHealthCheck();
const scopeBoundLegacyLog = adminService.saveImportExportLog({
  operation: 'Import', channel: 'Employee Master', fileName: 'employees-synthetic.csv', status: 'Dry Run',
  totalRows: 1, validRows: 1, errorRows: 0, errors: [],
}, originalScope);
await healthCheckStarted;
releaseHealthCheck();
await assert.rejects(scopeBoundLegacyLog, /scope changed before the import request was sent/i,
  'a generic import-history write remains bound to the captured organization/entity after async health detection');
assert.equal(calls.length, 8, 'a stale-scope generic import-history write sends no POST');

assert.equal(await downloadAuditedCsv('stale-export.csv', [], 'Synthetic Export', 'Success', originalScope), 'cancelled',
  'a generic CSV export must not start after its expected organization/entity scope changed');
assert.equal(downloadedFiles.length, 0, 'a pre-download scope mismatch does not start a file download');

sessionValues.set('workos_organization_scope', JSON.stringify(originalScope));
resetBackendCheck();
prepareDeferredHistoryWrite();
const scopedCsvExport = downloadAuditedCsv('scope-bound-export.csv', [{id: 'synthetic'}], 'Synthetic Export', 'Success', originalScope);
await historyWriteStarted;
assert.deepEqual(downloadedFiles, ['scope-bound-export.csv'], 'the CSV download begins before history persistence completes');
sessionValues.set('workos_organization_scope', JSON.stringify({organizationId: 'org-export-changed', legalEntityId: 'entity-export-changed'}));
releaseHistoryWrite();
assert.equal(await scopedCsvExport, 'completed-original-scope',
  'a scope switch during history persistence reports the completed export in its captured original scope');
const scopedHistoryWrite = calls.find(call => call.url === '/api/import-export-logs');
const scopedAuditWrite = calls.find(call => call.url === '/api/audit-events');
assert.equal(scopedHistoryWrite.init.headers['X-Organization-Id'], originalScope.organizationId);
assert.equal(scopedHistoryWrite.init.headers['X-Legal-Entity-Id'], originalScope.legalEntityId);
assert.equal(scopedAuditWrite.init.headers['X-Organization-Id'], originalScope.organizationId,
  'the audit event stays in the scope that owns the captured export history row');
assert.equal(scopedAuditWrite.init.headers['X-Legal-Entity-Id'], originalScope.legalEntityId);

sessionValues.set('workos_organization_scope', JSON.stringify(originalScope));
failNextAuditWrite = true;
await adminService.saveImportExportLog({
  operation: 'Import', channel: 'Employee Master', fileName: 'employees-legacy-synthetic.csv', status: 'Dry Run',
  totalRows: 1, validRows: 1, errorRows: 0, errors: [],
}, originalScope);
assert.equal(calls.at(-1).url, '/api/audit-events');
assert.equal(calls.at(-1).failed, true,
  'legacy import/preflight history preserves its existing success behavior when the separate audit request fails');

failNextAuditWrite = true;
assert.equal(await downloadAuditedCsv('audit-unconfirmed-export.csv', [], 'Synthetic Export', 'Success', originalScope), 'history-unconfirmed',
  'an export requires audit confirmation and reports uncertainty if the paired audit write fails');
assert.equal(downloadedFiles.at(-1), 'audit-unconfirmed-export.csv',
  'audit failure is reported as unconfirmed after the browser download has started');

sessionValues.set('workos_organization_scope', JSON.stringify(originalScope));
resetBackendCheck();
prepareDeferredHealthCheck();
const unconfirmedCsvExport = downloadAuditedCsv('unconfirmed-export.csv', [], 'Synthetic Export', 'Success', originalScope);
await healthCheckStarted;
sessionValues.set('workos_organization_scope', JSON.stringify({organizationId: 'org-export-health-change', legalEntityId: 'entity-export-health-change'}));
releaseHealthCheck();
assert.equal(await unconfirmedCsvExport, 'history-unconfirmed',
  'a scope switch during async history health detection reports the already-started download with unconfirmed history');
assert.deepEqual(downloadedFiles, ['scope-bound-export.csv', 'audit-unconfirmed-export.csv', 'unconfirmed-export.csv']);

sessionValues.set('workos_organization_scope', JSON.stringify(originalScope));
const originalEmployeeGetAll = employeeService.getAll;
let resolveEmployeeReadStarted;
let resolveEmployeeRows;
const employeeReadStarted = new Promise(resolve => { resolveEmployeeReadStarted = resolve; });
employeeService.getAll = () => {
  resolveEmployeeReadStarted();
  return new Promise(resolve => { resolveEmployeeRows = resolve; });
};
try {
  const scopeBoundReportExport = downloadReportExport('master_emp');
  await employeeReadStarted;
  sessionValues.set('workos_organization_scope', JSON.stringify({organizationId: 'org-export-changed', legalEntityId: 'entity-export-changed'}));
  resolveEmployeeRows([]);
  assert.equal(await scopeBoundReportExport, 'cancelled',
    'an export whose scoped read finishes after a scope change is discarded before download or history write');
} finally {
  employeeService.getAll = originalEmployeeGetAll;
}
assert.equal(calls.filter(call => call.url === '/api/import-export-logs').length, 3,
  'the completed export and two intentional audit-failure cases each write a scoped history row');
assert.equal(calls.filter(call => call.url === '/api/audit-events').length, 3,
  'each test history row attempts its paired audit event, including the report export failure case');
assert.equal(calls.filter(call => call.url === '/api/audit-events' && call.failed).length, 2,
  'a failed separate audit is tolerated for legacy import history but surfaced for report exports');

URL.createObjectURL = originalCreateObjectURL;
URL.revokeObjectURL = originalRevokeObjectURL;

console.log('Project import UI/API contract smoke tests passed.');
