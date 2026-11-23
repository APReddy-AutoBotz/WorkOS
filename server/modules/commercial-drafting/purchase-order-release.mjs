import { z } from 'zod';
import { assertCommercialAuthority } from './service.mjs';
import { fail } from './contracts.mjs';

export const releaseSchema = z.object({
  contractVersionId: z.string().min(1).max(200),
  approvalReference: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export async function purchaseOrderRelease(client, req, command, audit) {
  const args = [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId];
  const {rows:[order]} = await client.query(
    `select p.contract_version_id as "contractVersionId", r.actor_id as "actorId", r.active_role as role,
      r.approval_reference as reference, r.reason, r.created_at as "releasedAt"
     from commercial_purchase_orders p left join commercial_purchase_order_releases r
       on r.purchase_order_id=p.id and r.organization_id=p.organization_id and r.legal_entity_id=p.legal_entity_id
     where p.id=$1 and p.organization_id=$2 and p.legal_entity_id=$3`, args);
  if (!order) fail(404,'COMMERCIAL_NOT_FOUND','The scoped purchase order was not found.');
  const response = {orderId:req.params.id, contractVersionId:order.contractVersionId,
    release:order.actorId ? {actorId:order.actorId, activeRole:order.role, approvalReference:order.reference,
      reason:order.reason, releasedAt:order.releasedAt} : null};
  if (!command) return response;
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  if (command.contractVersionId !== order.contractVersionId)
    fail(409,'COMMERCIAL_TERMS_MISMATCH','Reload the purchase order and verify its terms.');
  if (response.release) {
    if (order.actorId === req.user.sub && order.role === req.user.activeRole &&
        order.reason === command.reason && order.reference === command.approvalReference) return response;
    fail(409,'COMMERCIAL_ALREADY_RELEASED','This purchase order already has a release.');
  }
  await client.query("select set_config('workos.po_release_operation',$1,true)",[req.operationId]);
  try {
    await client.query(`insert into commercial_purchase_order_releases
      (purchase_order_id,organization_id,legal_entity_id,actor_id,active_role,approval_reference,reason,operation_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [...args, req.user.sub,req.user.activeRole,command.approvalReference,command.reason,req.operationId]);
  } catch (error) {
    if (error.code==='POR02') fail(403,'COMMERCIAL_RELEASE_DENIED','Independent purchase order release authority is required.');
    if (error.code==='POR01') fail(409,'COMMERCIAL_RELEASE_UNAVAILABLE','The order must have positive value and cover today under the active contract terms.');
    throw error;
  }
  await audit(client,req,{module:'Commercial Drafting',action:'Release',entityType:'Purchase Order',
    entityId:req.params.id,oldValue:{status:'Draft'},newValue:{status:'Released',purchaseOrderId:req.params.id},
    reason:'Commercial approval reference retained in protected release history.',source:'Web',details:'Independent purchase order release recorded.'});
  return purchaseOrderRelease(client,req,null);
}

export async function purchaseOrderBalance(client, req) {
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  await assertCommercialAuthority(client,req,'commercial.purchase_orders.release');
  const {rows:[balance]}=await client.query(
    `select p.id as "orderId",p.contract_version_id as "contractVersionId",p.currency,
      b.committed::text committed,b.consumed::text consumed,b.remaining::text remaining,b.warning
     from commercial_purchase_orders p join commercial_purchase_order_releases r on r.purchase_order_id=p.id
     cross join lateral commercial_po_balance(p.id) b
     where p.id=$1 and p.organization_id=$2 and p.legal_entity_id=$3`,
    [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId]);
  if (!balance) fail(404,'PO_UNAVAILABLE','This released purchase order is unavailable.');
  return balance;
}

export const purchaseOrderRiskQuery=z.object({
  expiresBy:z.string().date(),view:z.literal('routing').optional(),after:z.string().min(1).max(200).optional()
}).strict();

export async function purchaseOrderRisks(client,req,{expiresBy,after,view}) {
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  await assertCommercialAuthority(client,req,'commercial.purchase_orders.release');
  const {organizationId,legalEntityId}=req.organizationScope;
  const asOf=(await client.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
  if (expiresBy<asOf) fail(400,'PO_RISK_DATE','Choose today or a future expiry date.');
  const {rows}=await client.query(`select p.id,p.number,p.ends_on::text "endsOn",p.currency,p.contract_version_id "contractVersionId",
    b.committed::text committed,b.consumed::text consumed,b.remaining::text remaining,b.warning,
    b.remaining<=0 exhausted,p.ends_on<$4::date expired,p.ends_on between $4::date and $3::date as "expiresInWindow"
    ${view? ', routing.assigned as "assignedCount",routing.unavailable as "unavailableOwners"':''}
    from commercial_purchase_orders p join commercial_purchase_order_releases r
      on r.organization_id=p.organization_id and r.legal_entity_id=p.legal_entity_id and r.purchase_order_id=p.id
    cross join lateral commercial_po_balance(p.id) b
    ${view?'cross join lateral(select count(*)::int assigned,count(*) filter(where user_id is null)::int unavailable from po_risk_engagement_owners($1,$2,p.id)) routing':''}
    where p.organization_id=$1 and p.legal_entity_id=$2 and ($5::text is null or p.id collate "C">$5 collate "C")
      and ${view?'(routing.assigned=0 or routing.unavailable>0)':'(p.ends_on<=$3::date or b.warning or b.remaining<=0)'}
    order by p.id collate "C" limit 51`,[organizationId,legalEntityId,expiresBy,asOf,after??null]);
  return {asOf,expiresBy,orders:rows.slice(0,50),nextAfter:rows.length>50?rows[49].id:null};
}

export const purchaseOrderHistoryQuery=z.object({after:z.string().uuid().optional()}).strict();

export async function purchaseOrderRiskHistory(client,req,{after}) {
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  await assertCommercialAuthority(client,req,'commercial.purchase_orders.release');
  const scope=[req.organizationScope.organizationId,req.organizationScope.legalEntityId,req.params.id];
  const {rows:[order]}=await client.query(`select p.id,p.currency,p.value::text value,p.warning_threshold_percent::text threshold,
    case when p.ends_on<(now() at time zone 'UTC')::date then (p.ends_on+1)::text end as "expiredOn",
    (select count(*)::int from commercial_po_line_commitments c where c.purchase_order_id=p.id
      and c.organization_id=p.organization_id and c.legal_entity_id=p.legal_entity_id and c.available_before is null) as "priorCommitments"
    from commercial_purchase_orders p join commercial_purchase_order_releases r on r.organization_id=p.organization_id
      and r.legal_entity_id=p.legal_entity_id and r.purchase_order_id=p.id
    where p.organization_id=$1 and p.legal_entity_id=$2 and p.id=$3`,scope);
  if (!order) fail(404,'PO_UNAVAILABLE','This released purchase order is unavailable.');
  const {rows}=await client.query(`with movements as (
    select c.line_id id,c.created_at as "recordedAt",c.available_before::text as "availableBefore",
      c.available_after::text as "availableAfter",c.available_after=0 exhausted,
      (c.available_before=$4::numeric or ($4::numeric-c.available_before)*100<$4::numeric*$5::numeric)
        and ($4::numeric-c.available_after)*100>=$4::numeric*$5::numeric as warning
    from commercial_po_line_commitments c where c.organization_id=$1 and c.legal_entity_id=$2 and c.purchase_order_id=$3
      and c.available_before is not null and ($6::uuid is null or c.line_id>$6)
    ) select * from movements where warning or exhausted order by id limit 51`,[...scope,order.value,order.threshold,after??null]);
  return {orderId:order.id,currency:order.currency,threshold:order.threshold,expiredOn:order.expiredOn,
    priorCommitments:order.priorCommitments,movements:rows.slice(0,50),nextAfter:rows.length>50?rows[49].id:null};
}
