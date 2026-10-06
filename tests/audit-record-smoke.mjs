import assert from 'node:assert/strict';
import {AUDIT_INSERT_SQL, recordAuditEvent} from '../server/modules/audit/audit-record.mjs';

assert.match(AUDIT_INSERT_SQL, /correlation_id, operation_id/);
assert.match(AUDIT_INSERT_SQL, /values \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14,\$15,\$16,\$17\)/);
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
  'trace-test-01', 'operation-test-01',
]);

await recordAuditEvent(client, undefined, {
  module: 'Platform', action: 'System Maintenance', entityType: 'System', entityId: 'workos', details: 'Synthetic system event',
});
assert.equal(captured.values[0], 'system');
assert.equal(captured.values[14], null);
assert.equal(captured.values[15], null, 'system events without request context do not invent correlation IDs');
assert.equal(captured.values[16], null, 'system events without request context do not invent operation IDs');

console.log('Audit record contract smoke tests passed.');
