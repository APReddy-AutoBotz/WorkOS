import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './contracts.mjs';

export const periodReviewGrant='commercial.service_periods.decide';
export const periodDecision=z.object({decision:z.enum(['Approved','Rejected']),reason:z.string().trim().min(3).max(1000)}).strict();
const fields='id,contract_id as "contractId",version_id as "versionId",starts_on::text as "startsOn",ends_on::text as "endsOn",currency,trim_scale(amount)::text amount,decision,reason';
export async function servicePeriodReview(client,req,input,audit) {
  const {organizationId,legalEntityId}=req.organizationScope;
  const {contractId,versionId,startsOn}=req.params;
  if (!z.string().date().safeParse(startsOn).success) fail(400,'SERVICE_PERIOD_INVALID','Invalid period start date.');
  const keys=[organizationId,legalEntityId,contractId,versionId,startsOn];
  const terms=await client.query(`select 1 from commercial_contract_versions v cross join lateral jsonb_array_elements(v.service_period_charges) p
    where v.organization_id=$1 and v.legal_entity_id=$2 and v.contract_id=$3 and v.id=$4 and p->>'startsOn'=$5`,keys);
  if (!terms.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','The fixed-period charge was not found.');
  const {rows:[prior]}=await client.query(`select ${fields},actor_id,active_role from commercial_service_period_reviews
    where organization_id=$1 and legal_entity_id=$2 and contract_id=$3 and version_id=$4 and starts_on=$5`,keys);
  if (prior) {
    const {actor_id,active_role,...receipt}=prior;
    if (!input || (actor_id===req.user.sub && active_role===req.user.activeRole && input.decision===receipt.decision && input.reason===receipt.reason)) return {review:receipt};
    fail(409,'SERVICE_PERIOD_DECIDED','This period already has a decision.');
  }
  if (!input) return {review:null};
  const id=randomUUID();
  await client.query("select set_config('workos.period_review',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId})]);
  const {rows:[review]}=await client.query(`insert into commercial_service_period_reviews
    (organization_id,legal_entity_id,contract_id,version_id,starts_on,id,actor_id,active_role,operation_id,decision,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${fields}`,[...keys,id,req.user.sub,req.user.activeRole,req.operationId,input.decision,input.reason]);
  const {id:reviewId,...details}=review;
  await audit(client,req,{module:'Commercial Drafting',action:review.decision,entityType:'Managed Service Period Review',entityId:reviewId,
    oldValue:{status:'Pending'},newValue:details,source:'Web',details:'Decision on a closed fixed-period service charge.'});
  return {review};
}
