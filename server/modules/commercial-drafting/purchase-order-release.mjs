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
