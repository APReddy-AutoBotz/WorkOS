export async function purchaseOrderRiskInboxRows(client,req,{after=null,id=null}={}) {
  const {rows:[tables]}=await client.query("select to_regclass('public.po_risk_inbox') inbox");
  if (!tables.inbox) return [];
  const {organizationId,legalEntityId}=req.organizationScope;
  const {rows}=await client.query(`select 'purchase-order-risk' kind,i.id,e.id "eventId",e.purchase_order_id "orderId",e.kind as metric,
    'commercial.risk_threshold_breached' "eventKey",'CONTROL_MANDATORY' "policyClass",p.id "templateId",
    e.id "operationId",p.locale,p.title,p.body,i.reasons,'Required' "channelDecision",i.id "deliveryId",
    'Delivered' "deliveryStatus",d.delivered_at "createdAt",rd.read_at "readAt"
    from po_risk_inbox i join po_risk_events e on e.id=i.event_id
    join po_risk_dispatch d on d.event_id=i.event_id join po_risk_notice_policies p on p.id=d.policy_id
    left join po_risk_reads rd on rd.recipient_id=i.id and rd.user_id=i.user_id
    where i.user_id=$1 and e.organization_id=$2 and e.legal_entity_id=$3 and ($4::uuid is null or i.id>$4)
      and ($5::uuid is null or i.id=$5) and po_risk_receipt_visible(i.id,$1,$6,$2,$3) order by i.id limit 21`,
    [req.user.sub,organizationId,legalEntityId,after,id,req.user.activeRole]);
  return rows;
}
