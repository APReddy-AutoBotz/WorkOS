import assert from 'node:assert/strict';
import {AUDIT_INSERT_SQL, recordAuditEvent} from '../server/modules/audit/audit-record.mjs';

assert.match(AUDIT_INSERT_SQL, /correlation_id, operation_id,[\s\n]+import_batch_id, source_identifier, import_processing_result, organization_id, legal_entity_id/);
assert.match(AUDIT_INSERT_SQL, /values \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15,\$16,\$17,\$18,\$19,\$20,\$21,\$22\)/);
assert.match(AUDIT_INSERT_SQL.trim().toLowerCase(), /^insert into audit_logs/);
assert.doesNotMatch(AUDIT_INSERT_SQL.trim().toLowerCase(), /\b(update|delete)\s+audit_logs\b/);

let captured;
const client = {query: async (sql, values) => { captured = {sql, values}; }};
await recordAuditEvent(client, {
  user: {sub: 'user-test', username: 'synthetic', activeRole: 'Admin'},
  headers: {'x-forwarded-for': '203.0.113.14, proxy.internal'},
  ip: '127.0.0.1',
  correlationId: 'trace-test-01',
  operationId: 'operation-test-01',
}, {
  module: 'Organization Setup',
  action: 'Update Profile',
  entityType: 'Organization',
  entityId: 'org-test',
  oldValue: {name: 'Before'},
  newValue: {name: 'After'},
  details: 'Versioned organization profile',
  reason: 'Synthetic test correction',
});

assert.equal(captured.sql, AUDIT_INSERT_SQL);
assert.deepEqual(captured.values, [
  'user-test', 'synthetic', 'Admin', 'Admin', 'Web', 'Organization Setup', 'Update Profile',
  'Organization', 'org-test', JSON.stringify({name: 'Before'}), JSON.stringify({name: 'After'}),
  'Versioned organization profile', 'Synthetic test correction', '203.0.113.14', 'user-test',
  'trace-test-01', 'operation-test-01', null, null, null, null, null,
]);

await recordAuditEvent(client, {
  user: {sub: 'user-test', username: 'synthetic', activeRole: 'Admin'},
}, {
  module: 'Import',
  action: 'Import Create Employee',
  entityType: 'Employee',
  entityId: 'employee-record-test',
  details: 'Employee master record from CSV import',
  source: 'Employee Master CSV',
  importBatchId: '11111111-1111-4111-8111-111111111111',
  sourceIdentifier: 'EMP-SYNTHETIC-001',
  importProcessingResult: 'Success',
});
assert.equal(captured.values[4], 'Employee Master CSV');
assert.equal(captured.values[5], 'Import');
assert.equal(captured.values[7], 'Employee');
assert.equal(captured.values[17], '11111111-1111-4111-8111-111111111111');
assert.equal(captured.values[18], 'EMP-SYNTHETIC-001');
assert.equal(captured.values[19], 'Success');
assert.equal(captured.values[20], null, 'audit rows without verified request scope remain unscoped');
assert.equal(captured.values[21], null, 'audit rows without verified legal-entity scope remain unscoped');

await recordAuditEvent(client, {
  user: {sub: 'user-test', username: 'synthetic', activeRole: 'Admin'},
  organizationScope: {organizationId: 'org-test', legalEntityId: 'legal-test'},
}, {
  module: 'Integrations',
  action: 'Create Link',
  entityType: 'IdentityProviderLink',
  entityId: 'identity-link-test',
  details: 'Created an identity link',
});
assert.equal(captured.values[20], 'org-test', 'audit scope comes from verified server request context');
assert.equal(captured.values[21], 'legal-test', 'audit legal-entity scope comes from verified server request context');

await recordAuditEvent(client, undefined, {
  module: 'Platform', action: 'System Maintenance', entityType: 'System', entityId: 'workos', details: 'Synthetic system event',
});
assert.equal(captured.values[0], 'system');
assert.equal(captured.values[14], null);
assert.equal(captured.values[15], null, 'system events without request context do not invent correlation IDs');
assert.equal(captured.values[16], null, 'system events without request context do not invent operation IDs');
assert.equal(captured.values[17], null, 'non-import events do not invent import batch IDs');
assert.equal(captured.values[18], null, 'non-import events do not invent source identifiers');
assert.equal(captured.values[19], null, 'non-import events do not invent import processing results');
assert.equal(captured.values[20], null, 'system events without verified scope remain unscoped');
assert.equal(captured.values[21], null, 'system events without verified legal entity remain unscoped');

console.log('Audit record contract smoke tests passed.');
