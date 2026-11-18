// Return only the authenticated recipient's retained in-app notice in scope.
export const setInvoiceExportNoticeReadContext = (c, r) =>
  c.query("select set_config('workos.invoice_notice_read_context',$1,true)", [
    JSON.stringify({
      actorId: r.user.sub,
      activeRole: r.user.activeRole,
      organizationId: r.organizationScope.organizationId,
      legalEntityId: r.organizationScope.legalEntityId,
    }),
  ]);
export const invoiceExportInboxRows = async (c, r, { after = null, id = null } = {}) => {
  if (!(await c.query("select to_regclass('public.invoice_export_notice_recipients') t")).rows[0]?.t)
    return [];
  return (
    await c.query(
      `select 'invoice-export' kind,rec.id,ev.id "eventId",b.id "batchId",ev.event_key "eventKey",ev.policy_class "policyClass",ev.policy_id "templateId",ev.operation_id "operationId",ev.locale,ev.title,ev.body,rec.reasons,rec.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",ev.created_at "createdAt",rd.read_at "readAt" from invoice_export_notice_recipients rec join invoice_export_notice_events ev on ev.id=rec.event_id join invoice_draft_batches b on b.id=ev.batch_id join invoice_export_notice_deliveries d on d.recipient_id=rec.id left join invoice_export_notice_reads rd on rd.recipient_id=rec.id and rd.user_id=rec.user_id where rec.user_id=$1 and b.organization_id=$2 and b.legal_entity_id=$3 and rec.in_app and($4::uuid is null or rec.id>$4)and($5::uuid is null or rec.id=$5) order by rec.id limit 21`,
      [r.user.sub, r.organizationScope.organizationId, r.organizationScope.legalEntityId, after, id],
    )
  ).rows;
};
