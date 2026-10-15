import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {adminService} from '../src/services/api.ts';
import {filterAcceptedProjectRows} from '../src/lib/projectImportOperation.ts';

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
globalThis.fetch = async (url, init = {}) => {
  if (url === '/api/health') {
    return new Response(JSON.stringify({database: 'connected'}), {status: 200, headers: {'Content-Type': 'application/json'}});
  }
  const body = JSON.parse(init.body);
  calls.push({url, init, body});
  return new Response(JSON.stringify({
    status: body.dryRun ? 'Dry Run' : 'Success',
    totalRows: 2,
    validRows: 1,
    errorRows: 1,
    errors: [{rowNumber: 3, field: 'managerId', message: 'Manager was not found.'}],
    log: {id: 'batch-synthetic', file_name: 'projects.csv', operation: 'Import', channel: 'Project Master',
      status: body.dryRun ? 'Dry Run' : 'Success', total_rows: 2, valid_rows: 1, error_rows: 1,
      schema_version: 'project-master/1', dry_run: body.dryRun},
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

assert.equal(calls.length, 3);
assert.ok(calls.every(call => call.url === '/api/v1/imports/projects/apply'), 'the project import service must use the versioned API');
assert.deepEqual(calls.map(call => call.init.headers['Idempotency-Key']), [
  'same-dry-run-retry-key', 'same-dry-run-retry-key', 'new-apply-key',
], 'an identical dry-run retry reuses its key and apply uses a distinct key');
assert.deepEqual(calls.map(call => call.body.dryRun), [true, true, false]);
assert.ok(calls.every(call => call.body.schemaVersion === 'project-master/1'));
assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer synthetic-api-token'));
assert.ok(calls.every(call => call.init.headers['X-Organization-Id'] === 'org-synthetic'));
assert.ok(calls.every(call => call.init.headers['X-Legal-Entity-Id'] === 'entity-synthetic'));
assert.equal(firstPreview?.dryRun, true);
assert.equal(firstPreview?.schemaVersion, 'project-master/1');
assert.equal(retriedPreview?.dryRun, true);
assert.equal(applied?.dryRun, false);

const rowThree = {projectCode: 'PROJECT-103', name: 'Synthetic Project 103'};
assert.deepEqual(filterAcceptedProjectRows([rowOne, rowTwo, rowThree], [rowOne, rowThree], [{rowNumber: 4}]), [rowOne],
  'server errors filter only submitted rows using their original CSV row numbers');
assert.deepEqual(filterAcceptedProjectRows([rowOne], [], [{rowNumber: 1}]), [],
  'a header-level error does not reintroduce rows excluded from the server dry run');

const page = readFileSync('src/pages/ImportExport.tsx', 'utf8');
assert.match(page, /dryRunKey:\s*crypto\.randomUUID\(\)/, 'a newly uploaded project CSV gets a fresh dry-run key');
assert.match(page, /applyKey:\s*crypto\.randomUUID\(\)/, 'a newly uploaded project CSV gets a distinct apply key');
assert.match(page, /idempotencyKey:\s*basePending\.projectOperation!\.dryRunKey/, 'initial dry run uses the pending operation key');
assert.match(page, /idempotencyKey:\s*snapshot\.projectOperation\.dryRunKey/, 'validation retry reuses the same key and snapshot');
assert.match(page, /idempotencyKey:\s*operation\.applyKey/, 'apply retry reuses the same apply key');
assert.match(page, /IDEMPOTENCY_KEY_REUSED/, 'a changed-payload/key conflict requires a fresh import');
assert.match(page, /requestVersion !== importRequestVersion\.current/, 'stale upload responses cannot replace the latest pending import');
assert.match(page, /filterAcceptedProjectRows\(rows, validRows, serverErrors\)/, 'only client-approved, server-approved project rows remain eligible for apply');

console.log('Project import UI/API contract smoke tests passed.');
