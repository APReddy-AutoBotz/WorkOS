// Only the authenticated named recipient may see the sanitized canonical event.
export const setTmBillingInboxContext = (c, r) =>
  c.query("select set_config('workos.tm_billing_context',$1,true)", [
    JSON.stringify({
      actorId: r.user.sub,
      activeRole: r.user.activeRole,
      operationId: r.operationId,
      organizationId: r.organizationScope.organizationId,
      legalEntityId: r.organizationScope.legalEntityId,
      instanceId: null,
    }),
  ]);
export const tmBillingInboxRows = async (c, r, { after = null, id = null } = {}) => {
  if (!(await c.query("select to_regclass('public.tm_billing_eligibility_recipients') t")).rows[0]?.t)
    return [];
  return (
    await c.query(
      `select 'tm-billing-eligibility' kind,rec.id,rec.event_id "eventId",i.id "instanceId",i.snapshot_id "snapshotId",e.transition_sequence "transitionSequence",e.event_key "eventKey",e.policy_class "policyClass",e.policy_id "templateId",e.operation_id "operationId",e.locale,e.title,e.body,rec.reasons,rec.channel_decision "channelDecision",d.id "deliveryId",d.status "deliveryStatus",e.created_at "createdAt",rd.read_at "readAt" from tm_billing_eligibility_recipients rec join tm_billing_eligibility_notices e on e.id=rec.event_id join tm_billing_eligibility_instances i on i.id=e.instance_id join tm_billing_eligibility_deliveries d on d.recipient_id=rec.id left join tm_billing_eligibility_reads rd on rd.recipient_id=rec.id and rd.user_id=rec.user_id where rec.user_id=$1 and i.organization_id=$2 and i.legal_entity_id=$3 and rec.in_app and ($4::uuid is null or rec.id>$4) and ($5::uuid is null or rec.id=$5) order by rec.id limit 21`,
      [r.user.sub, r.organizationScope.organizationId, r.organizationScope.legalEntityId, after, id],
    )
  ).rows;
};
