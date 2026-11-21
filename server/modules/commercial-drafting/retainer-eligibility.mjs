import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {getRetainerConsumption} from './retainer-consumption.mjs';
import {fail} from './contracts.mjs';

export const retainerIssueGrant='commercial.retainer_eligibility.issue';
export const retainerIssueCommand=z.object({statementId:z.string().uuid(),reviewId:z.string().uuid(),
  engagementId:z.string().min(1).max(200),reason:z.string().trim().min(3).max(1000)}).strict();
const day="(statement_timestamp() at time zone 'UTC')::date";

export async function retainerRegister(c,req,workerScope,command,audit) {
  await assertCommercialAuthority(c,req,retainerIssueGrant);
  const {id:contractId,versionId,startsOn}=req.params;
  if (!z.string().date().safeParse(startsOn).success) fail(400,'RETAINER_INVALID_DATE','Select a valid service period.');
  const {organizationId,legalEntityId}=req.organizationScope;
  const scope=[organizationId,legalEntityId,contractId,versionId,startsOn];
  const evidence=await getRetainerConsumption(c,req,workerScope,true,startsOn);
  const receipt=async()=> (await c.query(`select ev.id as "eventId",i.id as "itemId",ev.engagement_id as "engagementId",
    ev.amount::text amount,ev.currency,ev.eligible_on::text as "eligibleOn",ev.billing_evidence->>'statementId' as "statementId",
    ev.retainer_review_id as "reviewId",ev.billing_evidence->>'reason' reason,ev.actor_id as "actorId",ev.active_role as "activeRole"
    from billing_eligibility_events ev join approved_unbilled_items i on i.event_id=ev.id
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.contract_id=$3 and ev.source_type='RETAINER_PERIOD'
    and ev.billing_evidence->>'contractVersionId'=$4 and lower(ev.retainer_period)=$5::date`,scope)).rows[0] ?? null;
  const prior=await receipt();
  if (prior) {
    if (command && (prior.actorId!==req.user.sub || prior.activeRole!==req.user.activeRole ||
      ['engagementId','statementId','reviewId','reason'].some(key=>prior[key]!==command[key])))
      fail(409,'RETAINER_ALREADY_REGISTERED','This period already has a billing register receipt.');
    return {receipt:prior,statement:null,engagements:[]};
  }
  const statement=(await c.query(`select s.id as "statementId",r.id as "reviewId",s.evidence->'price'->'periodPrice'->>'total' amount,
    s.evidence->>'currency' currency from commercial_retainer_statements s join commercial_retainer_reviews r on r.statement_id=s.id
    where s.organization_id=$1 and s.legal_entity_id=$2 and s.contract_id=$3 and s.version_id=$4 and s.starts_on=$5
    and r.decision='Approved' and s.source_hash=encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex')
    and not exists(select from commercial_retainer_statements n where n.version_id=s.version_id and n.starts_on=s.starts_on and n.sequence>s.sequence)
    and not exists(select from billing_eligibility_events ev where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.contract_id=$3
      and ev.source_type='RETAINER_PERIOD' and ev.retainer_period && daterange(s.starts_on,s.ends_on,'[]'))`,[...scope,JSON.stringify(evidence)])).rows[0] ?? null;
  if (!command) {
    const engagements=statement ? (await c.query(`select e.id,e.name from commercial_engagements e
      cross join lateral retainer_eligibility_source($1,$2,$4,$5,e.id,${day}) src
      where e.organization_id=$1 and e.legal_entity_id=$2 and e.contract_id=$3 order by e.name,e.id`,
    [organizationId,legalEntityId,contractId,statement.statementId,statement.reviewId])).rows : [];
    return {receipt:null,statement,engagements};
  }
  if (!statement || command.statementId!==statement.statementId || command.reviewId!==statement.reviewId)
    fail(409,'RETAINER_SOURCE_CHANGED','Reload the approved period and review its register status.');
  await c.query("select set_config('workos.retainer_issue_operation',$1,true)",[req.operationId]);
  const args=[organizationId,legalEntityId,command.statementId,command.reviewId,command.engagementId,command.reason,req.user.sub,req.user.activeRole,req.operationId];
  const event=(await c.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,
    source_type,version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,retainer_review_id,retainer_period)
    select gen_random_uuid(),$1,$2,s.client_id,s.contract_id,$5,'RETAINER_PERIOD',1,${day},s.currency,s.amount,
    s.evidence||jsonb_build_object('reason',$6::text),$7,$8,$9,$4,daterange((s.evidence->>'startsOn')::date,(s.evidence->>'endsOn')::date,'[]')
    from retainer_eligibility_source($1,$2,$3,$4,$5,${day}) s returning id`,args)).rows[0];
  if (!event) fail(409,'RETAINER_INELIGIBLE','The selected engagement does not cover this charge.');
  const issued=await receipt();
  await audit(c,req,{module:'Commercial Drafting',action:'Issue Retainer Charge',entityType:'Billing Eligibility Event',
    entityId:event.id,oldValue:null,newValue:{eventId:event.id,itemId:issued.itemId},source:'Web',reason:'Registration reason retained in protected billing evidence.',
    details:'Registered an approved retainer service period.'});
  return {receipt:issued,statement:null,engagements:[]};
}
