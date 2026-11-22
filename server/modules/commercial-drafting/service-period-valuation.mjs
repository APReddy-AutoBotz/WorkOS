import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './contracts.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {policyFields} from './service-unit-valuation.mjs';

export const periodValueGrant='commercial.service_periods.value';
export const periodValueCommand=z.object({policyId:z.string().uuid()}).strict();
const fields='id,engagement_id as "engagementId",review_id as "reviewId",policy_id as "policyId",version_id as "versionId",ends_on::text as "endsOn",currency,trim_scale(source_amount)::text as "sourceAmount",amount::text';
export async function servicePeriodValue(client,req,command,audit) {
  await assertCommercialAuthority(client,req,periodValueGrant);
  const {id:engagementId,reviewId}=req.params;
  if (!z.string().uuid().safeParse(reviewId).success) fail(400,'SERVICE_PERIOD_INVALID','Invalid review identifier.');
  const keys=[req.organizationScope.organizationId,req.organizationScope.legalEntityId,engagementId,reviewId];
  const {rows:[review]}=await client.query(`select r.ends_on::text from commercial_service_period_reviews r join commercial_engagements e
    on e.organization_id=r.organization_id and e.legal_entity_id=r.legal_entity_id and e.contract_id=r.contract_id
    where r.organization_id=$1 and r.legal_entity_id=$2 and e.id=$3 and r.id=$4 and r.decision='Approved' and e.model='managed_service'`,keys);
  if (!review) fail(404,'COMMERCIAL_NOT_FOUND','Approved period unavailable for this engagement.');
  const {rows:[policy]}=await client.query(`select ${policyFields} from commercial_service_unit_policies where organization_id=$1 and legal_entity_id=$2
    and engagement_id=$3 and effective_from<=$4::date order by effective_from desc limit 1`,[...keys.slice(0,3),review.ends_on]);
  const {rows:[prior]}=await client.query(`select ${fields} from commercial_service_period_valuations where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and review_id=$4`,keys);
  if (!command) return {policy:policy??null,valuation:prior??null};
  if (prior?.policyId===command.policyId) return prior;
  if (prior || policy?.profile!=='approved_period' || policy.id!==command.policyId) fail(409,'SERVICE_VALUE_UNAVAILABLE','Inspect the valuation policy effective on the period end date.');
  const id=randomUUID();
  await client.query("select set_config('workos.service_valuation',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId})]);
  const {rows:[receipt]}=await client.query(`insert into commercial_service_period_valuations
    (organization_id,legal_entity_id,engagement_id,review_id,policy_id,id,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${fields}`,[...keys,policy.id,id,req.user.sub,req.user.activeRole,req.operationId]);
  const {id:entityId,...material}=receipt;
  await audit(client,req,{module:'Commercial Drafting',action:'Recorded',entityType:'Service Period Valuation',entityId,oldValue:null,newValue:material,source:'Web',details:'Operational management value of a reviewed service period.'});
  return receipt;
}
