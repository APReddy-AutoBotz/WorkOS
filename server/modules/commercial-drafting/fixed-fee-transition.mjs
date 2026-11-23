import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';
import {policyRevenue} from './fixed-fee-earned-revenue.mjs';
import {fail} from './contracts.mjs';

export const transitionGrant='commercial.fixed_fee_transition.approve';
export const transitionCommand=z.object({policyId:z.string().min(1).max(200),snapshotId:z.string().uuid(),reason:z.string().trim().min(3).max(1000)}).strict();

export async function approveFixedFeeTransition(client,req,input,scope,audit) {
  await assertElapsedReadScope(client,req,scope);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id];
  const {rows:[engagement]}=await client.query(`select currency,(now() at time zone 'UTC')::date::text today from commercial_engagements
    where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='fixed_fee'`,args);
  if (!engagement) fail(404,'COMMERCIAL_NOT_FOUND','Fixed-fee engagement unavailable.');
  const review=await policyRevenue(client,req,scope,[...args,engagement.today],engagement.currency,null);
  const proposal=review.scheduled??review.preview;
  if (!proposal || proposal.policyId!==input.policyId || proposal.snapshotId!==input.snapshotId)
    fail(409,'TRANSITION_SOURCE_CHANGED','Inspect the verified closing snapshot and approved schedule again.');
  if (proposal.approvalId) {
    const {rowCount}=await client.query('select 1 from commercial_fixed_fee_transition_approvals where id=$1 and actor_id=$2 and reason=$3',
      [proposal.approvalId,req.user.sub,input.reason]);
    if (!rowCount) fail(409,'TRANSITION_ALREADY_APPROVED','The verified schedule already has a finance approval.');
    return {approvalId:proposal.approvalId};
  }
  const id=randomUUID();
  await client.query(`insert into commercial_fixed_fee_transition_approvals
    (id,organization_id,legal_entity_id,engagement_id,policy_id,snapshot_id,reason,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,...args,input.policyId,input.snapshotId,input.reason,req.user.sub,req.user.activeRole,req.operationId]);
  await audit(client,req,{module:'Commercial Drafting',entityType:'Fixed Fee Transition',entityId:id,action:'Approved',source:'Web',oldValue:null,
    newValue:{...proposal,approvalId:id,engagementId:req.params.id,currency:engagement.currency,reason:input.reason},details:'Approved residual fixed-fee valuation schedule.'});
  return {approvalId:id};
}
