import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const assignmentCommand=z.object({
  expectedVersion:z.number().int().nonnegative(),engagementIds:z.array(z.string().min(1).max(200)).max(200)
    .refine(ids=>new Set(ids).size===ids.length),reason:z.string().trim().min(3).max(1000)
}).strict();

export async function orderAssignments(client,req,command,audit) {
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  await assertCommercialAuthority(client,req,'commercial.purchase_orders.release');
  const {organizationId,legalEntityId}=req.organizationScope;
  const scope=[organizationId,legalEntityId,req.params.id];
  const order=await client.query(`select 1 from commercial_purchase_order_releases where organization_id=$1 and legal_entity_id=$2 and purchase_order_id=$3`,scope);
  if (!order.rowCount) fail(404,'PO_UNAVAILABLE','The released order is unavailable.');
  const {rows:[last]}=await client.query(`select id,version,engagement_ids,actor_id,active_role,reason from po_risk_engagement_assignments
    where organization_id=$1 and legal_entity_id=$2 and purchase_order_id=$3 order by version desc limit 1`,scope);
  const version=last?.version??0;
  if (command) {
    const ids=[...command.engagementIds].sort(),id=randomUUID();
    if (version!==command.expectedVersion) {
      if (!(version===command.expectedVersion+1 && last.actor_id===req.user.sub && last.active_role===req.user.activeRole
        && last.reason===command.reason && JSON.stringify(ids)===JSON.stringify(last.engagement_ids)))
        fail(409,'PO_ASSIGNMENTS_CHANGED','Reload the current engagement assignments.');
    } else {
      await client.query("select set_config('workos.po_risk_assignment_context',$1,true)",[JSON.stringify({
        order:req.params.id,actor:req.user.sub,role:req.user.activeRole,operation:req.operationId,organization:organizationId,entity:legalEntityId})]);
      await client.query(`insert into po_risk_engagement_assignments(id,organization_id,legal_entity_id,purchase_order_id,version,engagement_ids,actor_id,active_role,operation_id,reason)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,...scope,version+1,ids,req.user.sub,req.user.activeRole,req.operationId,command.reason]);
      await audit(client,req,{module:'Commercial Notifications',action:'Assign PO Risk Engagements',entityType:'Purchase Order Risk Assignment',
        entityId:id,oldValue:last?{versionId:last.id}:null,newValue:{versionId:id},details:'Scoped engagement relationships retained in the assignment version.',
        reason:'Buyer reason retained on the protected assignment.'});
    }
    return orderAssignments(client,req);
  }
  const {rows}=await client.query(`select engagement_id as "engagementId",user_id is not null as "ownerAvailable"
    from po_risk_engagement_owners($1,$2,$3) order by engagement_id collate "C"`,scope);
  return {orderId:req.params.id,version,assignments:rows};
}
