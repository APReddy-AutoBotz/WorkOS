import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './contracts.mjs';
import {assertCommercialAuthority} from './service.mjs';

export const effortCostGrant='commercial.service_cost.record';
export const effortCostCommand=z.object({reviewId:z.string().uuid(),adoptionId:z.string().uuid()}).strict();
const fields=`review_id as "reviewId",adoption_id as "adoptionId",candidate_id as "candidateId",
  effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",currency,priority,resolution_rule as "resolutionRule",
  trim_scale(hourly_rate)::text as "hourlyRate",trim_scale(amount)::text as amount`;

export async function serviceEffortCost(client,req,command,audit) {
  await assertCommercialAuthority(client,req,'commercial.cost_candidates.view');
  await assertCommercialAuthority(client,req,'commercial.service_cost.view');
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,req.params.evidenceId];
  const ctx={organizationId,legalEntityId,actorId:req.user.sub,activeRole:req.user.activeRole};
  const {rows:[e]}=await client.query(`select id from commercial_service_unit_evidence
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and id=$4
      and rate_candidate_worker_visible($5::jsonb,recorder_worker_id)`,[...args,JSON.stringify(ctx)]);
  if (!e) fail(404,'SERVICE_COST_UNAVAILABLE','Service effort is unavailable in the current worker scope.');
  const {rows:[existing]}=await client.query(`select id,evidence_id as "evidenceId",service_date::text as "serviceDate",
    trim_scale(hours)::text as hours,${fields} from commercial_service_effort_costs
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and evidence_id=$4`,args);
  if (existing) {
    if (command && (existing.adoptionId!==command.adoptionId || existing.reviewId!==command.reviewId))
      fail(409,'SERVICE_COST_CHANGED','This effort already has a cost snapshot from another source.');
    return {snapshot:existing,preview:null};
  }
  if (!command) {
    const {rows:[preview]}=await client.query(`select e.id as "evidenceId",e.service_date::text as "serviceDate",
      trim_scale(e.effort_hours)::text as hours,s.* from commercial_service_unit_evidence e cross join lateral
      (select ${fields} from service_effort_cost_source(e)) s where e.id=$1`,[e.id]);
    return {snapshot:null,preview:preview??null};
  }
  const id=randomUUID();
  await client.query("select set_config('workos.service_effort_cost',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId})]);
  const {rows:[snapshot]}=await client.query(`insert into commercial_service_effort_costs
    (organization_id,legal_entity_id,engagement_id,evidence_id,review_id,adoption_id,id,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,evidence_id as "evidenceId",service_date::text as "serviceDate",
    trim_scale(hours)::text as hours,${fields}`,[...args,command.reviewId,command.adoptionId,id,req.user.sub,req.user.activeRole,req.operationId]);
  await audit(client,req,{module:'Commercial Drafting',action:'Recorded',entityType:'Managed Service Effort Cost',entityId:id,
    oldValue:null,newValue:{costId:id,evidenceId:e.id,adoptionId:command.adoptionId},source:'Web',details:'Retained worker cost from an adopted hourly source.'});
  return {snapshot,preview:null};
}
