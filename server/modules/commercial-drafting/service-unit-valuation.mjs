import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const policyGrant='commercial.service_units.policy',valueGrant='commercial.service_units.value';
export const policyCommand=z.object({effectiveFrom:z.string().date(),profile:z.enum(['accepted_unit','disabled']),precision:z.number().int().min(0).max(4).nullable(),
  previousId:z.string().uuid().nullable(),reason:z.string().trim().min(3).max(1000)}).strict().refine(p=>(p.profile==='accepted_unit')===(p.precision!==null));
export const valueCommand=z.object({reviewId:z.string().uuid(),policyId:z.string().uuid()}).strict();
const policyFields='id,effective_from::text as "effectiveFrom",profile,precision_digits as precision,reason,actor_id as "ownerId"';
const valueFields='id,evidence_id as "evidenceId",review_id as "reviewId",policy_id as "policyId",version_id as "versionId",currency,quantity::text,unit_price::text as "unitPrice",amount::text';
const keys=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId,req.params.id];
const where='organization_id=$1 and legal_entity_id=$2 and engagement_id=$3';
async function mark(client,req,id) {
  await client.query("select set_config('workos.service_valuation',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId})]);
}
async function log(client,req,audit,kind,id,material) {
  await audit(client,req,{module:'Commercial Drafting',action:'Recorded',entityType:kind,entityId:id,oldValue:null,newValue:material,source:'Web',details:'Operational management valuation record.'});
}
export async function servicePolicy(client,req,command,audit) {
  await assertCommercialAuthority(client,req,policyGrant);
  const scope=keys(req);
  const eng=await client.query("select id from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='managed_service'",scope);
  if (!eng.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','Managed-service engagement unavailable.');
  const {rows:[latest]}=await client.query(`select ${policyFields} from commercial_service_unit_policies where ${where} order by effective_from desc limit 1`,scope);
  const {rows:[effective]}=await client.query(`select ${policyFields} from commercial_service_unit_policies where ${where} and effective_from<=(now() at time zone 'UTC')::date order by effective_from desc limit 1`,scope);
  if (!command) return {latest:latest??null,effective:effective??null};
  if (latest?.ownerId===req.user.sub && latest.effectiveFrom===command.effectiveFrom && latest.profile===command.profile && latest.precision===command.precision && latest.reason===command.reason) return latest;
  if ((latest?.id??null)!==command.previousId) fail(409,'SERVICE_POLICY_CHANGED','Reload the latest scheduled policy.');
  const id=randomUUID();await mark(client,req,id);
  const {rows:[record]}=await client.query(`insert into commercial_service_unit_policies
    (organization_id,legal_entity_id,engagement_id,id,effective_from,profile,precision_digits,reason,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${policyFields}`,[...scope,id,command.effectiveFrom,command.profile,command.precision,command.reason,req.user.sub,req.user.activeRole,req.operationId]);
  const {profile,precision,effectiveFrom,reason}=record;
  await log(client,req,audit,'Service Valuation Policy',id,{engagementId:req.params.id,effectiveFrom,profile,precision,reason});
  return record;
}
export async function serviceValue(client,req,command,audit) {
  await assertCommercialAuthority(client,req,valueGrant);
  const {evidenceId}=req.params;
  if (!z.string().uuid().safeParse(evidenceId).success) fail(400,'SERVICE_VALUE_INVALID','Invalid receipt.');
  const scope=[...keys(req),evidenceId];
  const {rows:[e]}=await client.query(`select id,service_date::text as day from commercial_service_unit_evidence where ${where} and id=$4`,scope);
  if (!e) fail(404,'COMMERCIAL_NOT_FOUND','Evidence not found.');
  const {rows:[policy]}=await client.query(`select ${policyFields} from commercial_service_unit_policies where ${where} and effective_from<=$4::date order by effective_from desc limit 1`,[...keys(req),e.day]);
  const {rows:[prior]}=await client.query(`select ${valueFields} from commercial_service_unit_valuations where ${where} and evidence_id=$4`,scope);
  if (!command) return {policy:policy??null,valuation:prior??null};
  if (prior?.reviewId===command.reviewId && prior.policyId===command.policyId) return prior;
  if (policy?.profile!=='accepted_unit' || policy.id!==command.policyId || prior) fail(409,'SERVICE_VALUE_UNAVAILABLE','An effective accepted-unit policy is required.');
  const id=randomUUID();await mark(client,req,id);
  const {rows:[record]}=await client.query(`insert into commercial_service_unit_valuations
    (organization_id,legal_entity_id,engagement_id,evidence_id,review_id,policy_id,id,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${valueFields}`,[...scope,command.reviewId,command.policyId,id,req.user.sub,req.user.activeRole,req.operationId]);
  const {id:recordId,...material}=record;await log(client,req,audit,'Service Unit Valuation',recordId,material);
  return record;
}
