import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const serviceIssueGrant='commercial.service_units.issue';
export const serviceIssueCommand=z.object({reviewId:z.string().uuid(),reason:z.string().trim().min(3).max(1000)}).strict();

export async function serviceUnitRegister(client,req,command,audit) {
  await assertCommercialAuthority(client,req,serviceIssueGrant);
  const {organizationId,legalEntityId}=req.organizationScope;
  const {id:engagementId,evidenceId}=req.params;
  if (!z.string().uuid().safeParse(evidenceId).success) fail(400,'SERVICE_REGISTER_INVALID','Invalid receipt.');
  const scope=[organizationId,legalEntityId,engagementId,evidenceId];
  const source=await client.query(`select r.id from commercial_service_unit_evidence e left join commercial_service_unit_reviews r on r.evidence_id=e.id
    where e.organization_id=$1 and e.legal_entity_id=$2 and e.engagement_id=$3 and e.id=$4`,scope);
  if (!source.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','Service receipt unavailable.');
  const reviewId=source.rows[0].id;
  const receipt=async()=> (await client.query(`select ev.id as "eventId",i.id as "itemId",ev.amount::text,ev.currency,ev.eligible_on::text as "eligibleOn",
    ev.service_review_id as "reviewId",ev.billing_evidence->>'reason' reason,ev.actor_id as "actorId",ev.active_role as "activeRole"
    from billing_eligibility_events ev join approved_unbilled_items i on i.event_id=ev.id
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.engagement_id=$3 and ev.service_review_id=$4`,[organizationId,legalEntityId,engagementId,reviewId])).rows[0]??null;
  const prior=await receipt();
  if (prior) {
    if (command && (command.reason!==prior.reason || command.reviewId!==prior.reviewId || prior.actorId!==req.user.sub || prior.activeRole!==req.user.activeRole))
      fail(409,'SERVICE_ALREADY_REGISTERED','This receipt already has a billing decision.');
    return {receipt:prior,charge:null};
  }
  const args=[...scope,reviewId];
  if (!command) {
    const {rows:[charge]}=await client.query(`select amount::text,currency,evidence->>'reviewId' as "reviewId"
      from service_unit_eligibility_source($1,$2,$3,$4,$5)`,args);
    return {receipt:null,charge:charge??null};
  }
  if (command.reviewId!==reviewId) fail(409,'SERVICE_REGISTER_CHANGED','Review the current acceptance.');
  await client.query("select set_config('workos.service_issue_operation',$1,true)",[req.operationId]);
  const event=await client.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,source_type,version,
      eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,service_review_id)
    select gen_random_uuid(),$1,$2,s.client_id,s.contract_id,$3,'MANAGED_SERVICE_UNIT',1,(statement_timestamp() at time zone 'UTC')::date,s.currency,s.amount,
      s.evidence||jsonb_build_object('reason',$6::text),$7,$8,$9,$5 from service_unit_eligibility_source($1,$2,$3,$4,$5) s returning id`,
    [...args,command.reason,req.user.sub,req.user.activeRole,req.operationId]);
  if (!event.rowCount) fail(409,'SERVICE_INELIGIBLE','Accepted service evidence and billable contract terms are required.');
  const issued=await receipt();
  await audit(client,req,{module:'Commercial Drafting',action:'Issue Service Unit Charge',entityType:'Billing Eligibility Event',entityId:event.rows[0].id,
    oldValue:null,newValue:{eventId:issued.eventId,itemId:issued.itemId},source:'Web',reason:'Registration reason retained in protected billing evidence.',
    details:'Registered an accepted service unit charge.'});
  return {receipt:issued,charge:null};
}
