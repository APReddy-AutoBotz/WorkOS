import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {normalizeAuditLog} from '../src/services/apiClient.ts';
import {AuditProvenanceDetails, readAuditProvenance} from '../src/components/audit/AuditProvenanceDetails.tsx';
import {redactAuditHistoryRows} from '../server/modules/audit/scoped-history-view.mjs';

const saved = {active_role: 'HR', source: 'Import', correlation_id: 'saved-correlation:one',
  operation_id: 'saved-operation:one', import_batch_id: 'saved-batch:one',
  source_identifier: 'SYN-EMPLOYEE-001', import_processing_result: 'Dry Run'};
const raw = {id: 'synthetic-audit', user_id: 'synthetic-user', user_name: 'Synthetic Actor', user_role: 'HR',
  action: 'Validate', module: 'Import', details: 'Synthetic saved evidence', created_at: '2026-10-18T00:00:00Z', ...saved};
const expected = {source: 'Import', activeRole: 'HR', correlationId: saved.correlation_id,
  operationId: saved.operation_id, importBatchId: saved.import_batch_id,
  sourceIdentifier: saved.source_identifier, importProcessingResult: 'Dry Run'};
assert.deepEqual(readAuditProvenance(normalizeAuditLog(raw)), expected);
assert.equal(readAuditProvenance({correlationId: 'a'.repeat(128)}).correlationId?.length, 128);
assert.equal(readAuditProvenance({correlationId: 'a'.repeat(129)}).correlationId, undefined);
assert.equal(readAuditProvenance({sourceIdentifier: 'a'.repeat(256)}).sourceIdentifier?.length, 256);
assert.equal(readAuditProvenance({sourceIdentifier: 'a'.repeat(257)}).sourceIdentifier, undefined);
const withoutSavedContext = normalizeAuditLog({...raw, active_role: null, correlation_id: null, operation_id: null,
  correlationId: 'history-read-correlation', operationId: 'history-read-operation', viewerRole: 'current-viewer-role'});
assert.equal(readAuditProvenance(withoutSavedContext).activeRole, undefined);
assert.equal(readAuditProvenance(withoutSavedContext).correlationId, undefined);
assert.equal(readAuditProvenance(withoutSavedContext).operationId, undefined);
const render = value => renderToStaticMarkup(createElement(AuditProvenanceDetails, {provenance: value}));
const html = render(normalizeAuditLog(raw));
for (const value of Object.values(expected)) assert(html.includes(value));
assert(html.includes('Saved event context'));
assert(html.includes('not proof of identity'));
assert(!html.includes('<a ') && !html.includes('<button') && !html.includes('<input'));
assert(!html.includes('Success'), 'a recorded dry run must never be presented as a successful apply');
assert(!html.includes('history-read-correlation') && !html.includes('current-viewer-role'));

const names = ['active_role', 'source', 'correlation_id', 'operation_id', 'import_batch_id', 'source_identifier', 'import_processing_result'];
for (const value of [undefined, null, '', 1, true, {}, ['synthetic']]) {
  const normalized = normalizeAuditLog({...raw, ...Object.fromEntries(names.map(name => [name, value]))});
  assert(Object.values(readAuditProvenance(normalized)).every(item => item === undefined));
  assert(render(normalized).includes('Not recorded or unavailable'));
  assert(!render(normalized).includes('[object Object]'));
}
for (const value of [' x ', '\u0000secret', 'x'.repeat(300), 'https://synthetic.invalid/teams/actions/bearer-token', '/teams/actions/bearer-token', 'Bearer synthetic-token']) {
  const context = Object.fromEntries(Object.keys(expected).map(name => [name, value]));
  assert(Object.values(readAuditProvenance(context)).every(item => item === undefined), `unsafe saved context must be absent: ${JSON.stringify(value)}`);
  assert(!render(context).includes('bearer-token'));
}
for (const value of ['has spaces', '<script>not-a-reference</script>', 'with/slash', 'with?query']) {
  const projected = readAuditProvenance({correlationId: value, operationId: value, importBatchId: value});
  assert.equal(projected.correlationId, undefined); assert.equal(projected.operationId, undefined); assert.equal(projected.importBatchId, undefined);
}
const escaped = render({sourceIdentifier: '<img src=x onerror=synthetic()>'});
assert(!escaped.includes('<img') && escaped.includes('&lt;img'), 'plain diagnostic text cannot create executable markup');

// Exercise the existing server redactor before the real API normalizer/projector.
const [redacted] = redactAuditHistoryRows([{...raw, source_identifier: 'provider-subject-synthetic',
  old_value: {providerSubject: 'provider-subject-synthetic'}, new_value: {upn: 'synthetic@example.invalid'}}]);
assert.equal(readAuditProvenance(normalizeAuditLog(redacted)).sourceIdentifier, undefined);
assert(!render(normalizeAuditLog(redacted)).includes('provider-subject-synthetic'));
const [opaque] = redactAuditHistoryRows([{...raw, source_identifier: 'identity-link:opaque-synthetic',
  old_value: {providerSubject: 'provider-subject-synthetic'}}]);
assert.equal(readAuditProvenance(normalizeAuditLog(opaque)).sourceIdentifier, 'identity-link:opaque-synthetic');
assert.equal(readAuditProvenance(normalizeAuditLog({...raw, source_identifier: null})).sourceIdentifier, undefined,
  'an absent timesheet source identifier must stay absent');
console.log('Saved audit provenance normalization, safe read-only rendering, missing/malformed context, redaction and non-inference passed.');
