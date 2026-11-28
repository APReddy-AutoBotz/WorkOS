import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// These suites use a private database. Compare every row so an unexpected
// replacement approval, line, reservation or export also changes the result.
const retainedTables = [
  'approval_records', 'invoice_batch_approval_instances', 'invoice_batch_approval_transitions',
  'invoice_batch_approval_invalidations', 'invoice_draft_batches', 'invoice_draft_lines',
  'invoice_draft_occupancies', 'invoice_draft_cancellations', 'invoice_csv_artifacts',
  'invoice_csv_failures', 'invoice_csv_request_keys', 'invoice_batch_confirmations',
];
const snapshotQuery = 'select ' + retainedTables.map(table =>
  `(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)), '[]'::jsonb) from ${table} t) as ${table}`,
).join(', ');

export async function assertFinalInvoiceReview({pool, request, batchId, instanceId, requester, ownerKey, state}) {
  const snapshot = async () => (await pool.query(snapshotQuery)).rows[0];
  const before = await snapshot();
  const readBatch = () => request('/api/v1/invoice-drafts/batches/' + batchId);
  const current = await readBatch();
  assert.equal(current.status, 200);
  assert.equal(current.body.batch.state, state);
  assert.ok(before.invoice_draft_batches.some(batch => batch.id === batchId));
  assert.ok(before.invoice_batch_approval_instances.some(row => row.id === instanceId && row.batch_id === batchId));
  const command = {expectedOwnerKey: ownerKey, requestId: randomUUID(), reason: 'Verify final batch review'};
  const withdraw = body => request('/api/v1/invoice-batch-approvals/instances/' + instanceId + '/withdrawals', {
    method: 'POST', identity: requester, body,
  });
  const concurrent = await Promise.all([withdraw(command), withdraw({...command, requestId: randomUUID()})]);
  const replay = await withdraw(command);
  for (const response of [...concurrent, replay]) {
    assert.equal(response.status, 409, state + ': ' + JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'INVOICE_APPROVAL_STALE', state);
    assert.equal(response.body.error.message, concurrent[0].body.error.message);
  }
  assert.equal((await readBatch()).body.batch.state, state);
  assert.deepEqual(await snapshot(), before, 'A refused withdrawal must preserve all retained evidence for ' + state);
}
