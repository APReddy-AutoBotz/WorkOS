// Only the authenticated named recipient sees sanitized canonical event data.
export const setInvoiceBatchInboxContext = (c, r) =>
  c.query("select set_config('workos.invoice_batch_approval_context',$1,true)", [
    JSON.stringify({
      actorId: r.user.sub,
      activeRole: r.user.activeRole,
      operationId: r.operationId,
      organizationId: r.organizationScope.organizationId,
      legalEntityId: r.organizationScope.legalEntityId,
    }),
  ]);
export const invoiceBatchInboxRows = async (c, r, { after = null, id = null } = {}) => {
  if (!(await c.query("select to_regclass('public.invoice_batch_approval_recipients') t")).rows[0]?.t)
    return [];
  return (
    await c.query(
      `select 'invoice-batch-approval' kind,rec.id,rec.event_id "eventId",i.id "instanceId",i.batch_id "batchId",e.transition_sequence "transitionSequence",e.event_key "eventKey",e.policy_class "policyClass",e.policy_id "templateId",e.operation_id "operationId",e.locale,e.title,e.body,rec.reasons,rec.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",e.created_at "createdAt",rd.read_at "readAt" from invoice_batch_approval_recipients rec join invoice_batch_approval_notices e on e.id=rec.event_id join invoice_batch_approval_instances i on i.id=e.instance_id join invoice_batch_approval_deliveries d on d.recipient_id=rec.id left join invoice_batch_approval_reads rd on rd.recipient_id=rec.id and rd.user_id=rec.user_id where rec.user_id=$1 and i.organization_id=$2 and i.legal_entity_id=$3 and rec.in_app and ($4::uuid is null or rec.id>$4) and ($5::uuid is null or rec.id=$5) order by rec.id limit 21`,
      [r.user.sub, r.organizationScope.organizationId, r.organizationScope.legalEntityId, after, id],
    )
  ).rows;
};
