export async function retainerRiskInboxRows(client,req,{after=null,id=null}={}) {
  const {rows:[tables]}=await client.query("select to_regclass('public.retainer_risk_inbox') inbox");
  if (!tables.inbox) return [];
  const {organizationId,legalEntityId}=req.organizationScope;
  const {rows}=await client.query(`select 'retainer-risk' kind,i.id,e.id "eventId",e.version_id "versionId",e.starts_on::text "startsOn",e.ends_on::text "endsOn",e.kind as metric,
    'commercial.risk_threshold_breached' "eventKey",'CONTROL_MANDATORY' "policyClass",p.id "templateId",
    e.id "operationId",p.locale,p.title,p.body,i.reasons,'Required' "channelDecision",i.id "deliveryId",
    'Delivered' "deliveryStatus",d.delivered_at "createdAt",rd.read_at "readAt"
    from retainer_risk_inbox i join retainer_risk_events e on e.id=i.event_id
    join retainer_risk_dispatch d on d.event_id=i.event_id join retainer_risk_notice_policies p on p.id=d.policy_id
    left join retainer_risk_reads rd on rd.recipient_id=i.id and rd.user_id=i.user_id
    where i.user_id=$1 and e.organization_id=$2 and e.legal_entity_id=$3 and ($4::uuid is null or i.id>$4)
      and ($5::uuid is null or i.id=$5) and retainer_risk_receipt_visible(i.id,$1,$6,$2,$3) order by i.id limit 21`,
    [req.user.sub,organizationId,legalEntityId,after,id,req.user.activeRole]);
  return rows;
}
