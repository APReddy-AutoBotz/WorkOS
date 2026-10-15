import assert from 'node:assert/strict';
import {
  createScopedEntityLockKey,
  createScopedIdempotencyLockKey,
  createProjectCodeLockKey,
  hashImportRequest,
  normalizeIdempotencyKey,
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
