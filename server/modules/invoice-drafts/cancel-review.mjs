import {randomUUID} from 'node:crypto';

export async function cancelInvoiceReview(c,r,batchId,d,digest,audit,expectedReviewId) {
  const i = (
    await c.query(
      'select * from invoice_batch_approval_instances where batch_id=$1 order by sequence desc limit 1',
      [batchId],
    )
  ).rows[0];
  if (!i || (expectedReviewId && i.id!==expectedReviewId)) throw Object.assign(new Error('Active review changed.'),{statusCode:409,code:'INVOICE_DRAFT_SOURCE'});
  const invalidationId = randomUUID();
  await c.query("select set_config('workos.invoice_batch_approval_context',$1,true)", [
    JSON.stringify({
      organizationId: r.organizationScope.organizationId,
      legalEntityId: r.organizationScope.legalEntityId,
      actorId: r.user.sub,
      activeRole: r.user.activeRole,
      operationId: r.operationId,
      batchId,
      instanceId: i.id,
      invalidationId,
    }),
  ]);
  await c.query(
    'insert into invoice_batch_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
    [invalidationId, i.id, r.user.sub, r.user.activeRole, d.requestId, digest, d.reason, r.operationId],
  );
  await c.query(
    "update approval_records set status='Cancelled',updated_at=now() where entity_type='InvoiceBatchApproval' and entity_id=$1",
    [i.id],
  );
  await audit(c, r, {
    module: 'Invoice Batch Approval',
    action: 'Cancel Review',
    entityType: 'InvoiceBatchApproval',
    entityId: invalidationId,
    newValue: { invalidationId, instanceId: i.id, batchId },
    reason: 'Scoped review cancellation.',
    details: 'No financial amount in general audit.',
  });
}
