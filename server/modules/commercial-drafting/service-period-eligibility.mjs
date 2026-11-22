import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const periodIssueGrant='commercial.service_periods.issue';
export async function servicePeriodRegister(client,req,command,audit) {
  await assertCommercialAuthority(client,req,periodIssueGrant);
  const {id:engagementId,reviewId}=req.params;
  if (!z.string().uuid().safeParse(reviewId).success) fail(400,'SERVICE_REGISTER_INVALID','Invalid review identifier.');
  const scope=[req.organizationScope.organizationId,req.organizationScope.legalEntityId,engagementId,reviewId];
  const review=await client.query(`select r.id from commercial_service_period_reviews r join commercial_engagements g
    on g.organization_id=r.organization_id and g.legal_entity_id=r.legal_entity_id and g.contract_id=r.contract_id and g.model='managed_service'
    where r.organization_id=$1 and r.legal_entity_id=$2 and g.id=$3 and r.id=$4 and r.decision='Approved'`,scope);
  if (!review.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','Approved period unavailable for this engagement.');
  if(command && command.reviewId!==reviewId) fail(409,'SERVICE_REGISTER_CHANGED','Inspect the approved period again.');
  const readReceipt=async()=>(await client.query(`select ev.id as "eventId",i.id as "itemId",trim_scale(ev.amount)::text amount,ev.currency,
    ev.eligible_on::text as "eligibleOn",ev.service_period_review_id as "reviewId",ev.billing_evidence->>'reason' reason,ev.actor_id as "actorId",ev.active_role as "activeRole"
    from billing_eligibility_events ev join approved_unbilled_items i on i.event_id=ev.id
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.engagement_id=$3 and ev.service_period_review_id=$4`,scope)).rows[0]??null;
  const receipt=await readReceipt();
  if(receipt) {
    if(command && (command.reason!==receipt.reason || req.user.sub!==receipt.actorId || req.user.activeRole!==receipt.activeRole))
      fail(409,'SERVICE_ALREADY_REGISTERED','This period already has a billing decision.');
    return {charge:null,receipt};
  }
  if(!command) {
    const {rows:[charge]}=await client.query(`select amount::text,currency,evidence->>'reviewId' as "reviewId" from service_period_eligibility_source($1,$2,$3,$4)`,scope);
    return {charge:charge??null,receipt:null};
  }
  await client.query("select set_config('workos.period_issue_operation',$1,true)",[req.operationId]);
  const event=await client.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,source_type,version,
    eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,service_period_review_id)
    select gen_random_uuid(),$1,$2,s.client_id,s.contract_id,$3,'MANAGED_SERVICE_PERIOD',1,(statement_timestamp() at time zone 'UTC')::date,s.currency,s.amount,
    s.evidence||jsonb_build_object('reason',$5::text),$6,$7,$8,$4 from service_period_eligibility_source($1,$2,$3,$4) s returning id`,
    [...scope,command.reason,req.user.sub,req.user.activeRole,req.operationId]);
  if(!event.rowCount) fail(409,'SERVICE_PERIOD_INELIGIBLE','This approved period has no available contractual charge.');
  const issued=await readReceipt();
  await audit(client,req,{module:'Commercial Drafting',action:'Issue Service Period Charge',entityType:'Billing Eligibility Event',entityId:issued.eventId,
    oldValue:null,newValue:{eventId:issued.eventId,itemId:issued.itemId},source:'Web',reason:'Decision reason retained in protected billing evidence.',details:'Registered an approved fixed-period service charge.'});
  return {receipt:issued,charge:null};
}
