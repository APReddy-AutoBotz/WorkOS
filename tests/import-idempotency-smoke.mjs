import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {
  createScopedEntityLockKey,
  createScopedIdempotencyLockKey,
  createProjectCodeLockKey,
  hashEmployeeImportRequest,
  hashImportRequest,
  normalizeEmployeeImportClientErrors,
  normalizeIdempotencyKey,
  redactCredentialEchoes,
  stableJsonStringify,
} from '../server/modules/imports/idempotency.mjs';

assert.equal(normalizeIdempotencyKey('project-import-01'), 'project-import-01');
assert.equal(normalizeIdempotencyKey('a'.repeat(128)), 'a'.repeat(128));
assert.equal(normalizeIdempotencyKey(''), null);
assert.equal(normalizeIdempotencyKey('has spaces'), null);
assert.equal(normalizeIdempotencyKey('idempotency\nkey'), null);
assert.equal(normalizeIdempotencyKey('a'.repeat(129)), null);
assert.equal(normalizeIdempotencyKey('💾'), null);

const first = {
  schemaVersion: 'project-master/1',
  fileName: 'projects.csv',
  dryRun: false,
  rows: [{projectCode: 'P-1', name: 'Project One', details: {country: 'US', client: 'Client A'}}],
};
const reordered = {
  rows: [{name: 'Project One', projectCode: 'P-1', details: {client: 'Client A', country: 'US'}}],
  dryRun: false,
  fileName: 'projects.csv',
  schemaVersion: 'project-master/1',
};
assert.equal(stableJsonStringify(first), stableJsonStringify(reordered),
  'JSON object property order must not affect canonical request identity');
assert.equal(hashImportRequest(first), hashImportRequest(reordered),
  'equivalent request objects must have the same payload hash');
assert.equal(hashImportRequest(first).length, 64, 'request hashes must be SHA-256 hex digests');
assert.notEqual(hashImportRequest(first), hashImportRequest({...first, dryRun: true}),
  'dry-run mode must be part of the idempotency payload identity');
assert.notEqual(hashImportRequest(first), hashImportRequest({...first, schemaVersion: 'project-master/2'}),
  'schema version must be part of the idempotency payload identity');
assert.notEqual(
  hashImportRequest({...first, rows: [...first.rows, {projectCode: 'P-2', name: 'Project Two'}]}),
  hashImportRequest(first),
  'row order and row contents must be part of the idempotency payload identity',
);

const initialPasswordOne = randomBytes(32).toString('base64url');
const initialPasswordTwo = randomBytes(32).toString('base64url');
const employeeImport = {
  schemaVersion: 'employee-master/1',
  fileName: `synthetic-employees-${initialPasswordOne}.csv`,
  totalRows: 1,
  clientErrors: [{rowNumber: 2, field: 'mappedCountryDirectorIds', message: `Country director ${initialPasswordOne} does not exist.`}],
  rows: [{employeeId: 'EMP-SYNTHETIC-1', name: 'Synthetic Employee', email: 'synthetic@example.test', initialPassword: initialPasswordOne}],
};
const employeeRetryWithChangedPassword = {
  ...employeeImport,
  rows: [{...employeeImport.rows[0], initialPassword: initialPasswordTwo}],
};
assert.equal(hashEmployeeImportRequest(employeeImport), hashEmployeeImportRequest(employeeRetryWithChangedPassword),
  'a password-only retry must replay the first result when unchanged filename and diagnostics still echo the first password');
assert.equal(hashEmployeeImportRequest(employeeImport), hashEmployeeImportRequest({
  ...employeeImport,
  fileName: 'renamed-employees.csv',
  clientErrors: [{rowNumber: 2, field: 'mappedCountryDirectorIds', message: 'Different untrusted browser text.', sourceIdentifier: 'different-id'}],
  rows: [{...employeeImport.rows[0], initialPassword: initialPasswordTwo}],
}), 'filename, free-form messages and client source IDs are not authoritative Employee retry identity');
assert.notEqual(hashEmployeeImportRequest(employeeImport), hashEmployeeImportRequest({
  ...employeeImport,
  clientErrors: [{rowNumber: 3, field: 'mappedCountryDirectorIds', message: 'Different untrusted browser text.'}],
}), 'the original row number remains part of Employee retry identity because it controls source-row mapping');
assert.notEqual(hashEmployeeImportRequest(employeeImport), hashEmployeeImportRequest({
  ...employeeImport,
  clientErrors: [{rowNumber: 2, field: 'name', message: 'Different untrusted browser text.'}],
}), 'allowlisted structured error fields remain part of Employee retry identity');
assert.notEqual(hashEmployeeImportRequest(employeeImport), hashEmployeeImportRequest({
  ...employeeImport,
  rows: [{...employeeImport.rows[0], name: 'Changed Synthetic Employee'}],
}), 'other canonical Employee Master fields must remain part of retry identity');
assert.notEqual(hashEmployeeImportRequest(employeeImport), hashImportRequest(employeeImport),
  'durable Employee Master request identity must exclude initialPassword rather than hash it');
assert(!hashEmployeeImportRequest(employeeImport).includes(initialPasswordOne));
assert(!hashEmployeeImportRequest(employeeRetryWithChangedPassword).includes(initialPasswordTwo));
assert.deepEqual(normalizeEmployeeImportClientErrors(employeeImport.clientErrors), [{
  rowNumber: 2,
  field: 'mappedCountryDirectorIds',
  message: 'The Employee Master row failed preflight validation.',
}], 'versioned Employee errors retain safe row/field observations and use a server-controlled message');
assert.equal(redactCredentialEchoes(employeeImport.clientErrors, [initialPasswordOne])[0].message,
  'Country director  does not exist.', 'legacy Employee diagnostics must still remove exact submitted credential echoes');

const lockKey = createScopedIdempotencyLockKey({
  organizationId: 'org-a',
  legalEntityId: 'legal-a',
  actorId: 'actor-a',
  channel: 'Project Master',
  idempotencyKey: 'key-a',
});
assert.notEqual(lockKey, createScopedIdempotencyLockKey({
  organizationId: 'org-b',
  legalEntityId: 'legal-a',
  actorId: 'actor-a',
  channel: 'Project Master',
  idempotencyKey: 'key-a',
}), 'organization scope must isolate idempotency locks');
assert.notEqual(lockKey, createScopedIdempotencyLockKey({
  organizationId: 'org-a',
  legalEntityId: 'legal-a',
  actorId: 'actor-b',
  channel: 'Project Master',
  idempotencyKey: 'key-a',
}), 'actor identity must isolate idempotency locks');
const projectCodeLockKey = createScopedEntityLockKey({
  organizationId: 'org-a',
  entityType: 'ProjectCode',
  entityKey: 'project-1',
});
assert.equal(createProjectCodeLockKey({organizationId: 'org-a', projectCode: ' PROJECT-1 '}), projectCodeLockKey,
  'project create, import and update paths must share the normalized organization-scoped lock key');
assert.notEqual(projectCodeLockKey, createScopedEntityLockKey({
  organizationId: 'org-b',
  entityType: 'ProjectCode',
  entityKey: 'project-1',
}), 'project-code locks must be isolated by organization');
assert.equal(projectCodeLockKey, createScopedEntityLockKey({
  organizationId: 'org-a',
  entityType: 'ProjectCode',
  entityKey: 'project-1',
}), 'the same organization resource must derive a stable project-code lock key');

console.log('Import idempotency helper smoke tests passed.');
