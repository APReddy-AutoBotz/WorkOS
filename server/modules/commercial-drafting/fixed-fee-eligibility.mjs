import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const fixedFeeGrant = 'commercial.fixed_fee_eligibility.issue';
export const installmentCommand = z.object({
  installment: z.number().int().min(1).max(120),
  engagementId: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export async function fixedFeeRegister(c,req,command,audit) {
  await assertCommercialAuthority(c,req,fixedFeeGrant);
  const {organizationId,legalEntityId}=req.organizationScope;
  const versionId=req.params.id;
  const args=[organizationId,legalEntityId,versionId];
  const version=(await c.query(`select contract_id,model from commercial_contract_versions
    where organization_id=$1 and legal_entity_id=$2 and id=$3`,args)).rows[0];
  if (!version || version.model!=='fixed_fee') fail(404,'SCHEDULE_NOT_FOUND','This fixed-fee schedule is unavailable.');
  const receipts=async()=> (await c.query(`select ev.id as "eventId", i.id as "itemId",ev.engagement_id as "engagementId",
    fixed_fee_identity_current(ev.id) as "identityCurrent",ev.eligible_on::text as "eligibleOn",ev.currency,ev.amount::text amount,
    (ev.billing_evidence->>'installment')::int installment,ev.billing_evidence->>'contractVersionId' as "contractVersionId",
    ev.billing_evidence->>'dueOn' as "dueOn" from billing_eligibility_events ev join approved_unbilled_items i on i.event_id=ev.id
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.contract_id=$3 and ev.source_type='FIXED_FEE_INSTALLMENT'
    order by installment`,[organizationId,legalEntityId,version.contract_id])).rows;
  if (!command) return {receipts:await receipts()};
  await assertCommercialAuthority(c,req,'commercial.contracts.manage');
  const {installment,engagementId,reason}=command;
  const prior=(await c.query(`select id,actor_id,active_role,engagement_id,billing_evidence from billing_eligibility_events
    where organization_id=$1 and legal_entity_id=$2 and contract_id=$3 and source_type='FIXED_FEE_INSTALLMENT'
    and (billing_evidence->>'installment')::int=$4`,[organizationId,legalEntityId,version.contract_id,installment])).rows[0];
  if (prior) {
    if (prior.actor_id===req.user.sub && prior.active_role===req.user.activeRole && prior.engagement_id===engagementId &&
        prior.billing_evidence.contractVersionId===versionId && prior.billing_evidence.approvalReason===reason) {
      await c.query('select lock_fixed_fee_source_workers(ev) from billing_eligibility_events ev where id=$1',[prior.id]);
      if (!(await c.query('select fixed_fee_identity_current($1) ok',[prior.id])).rows[0].ok)
        fail(409,'INSTALLMENT_IDENTITY_CHANGED','The original approval identity can no longer be verified.');
      return {receipts:await receipts()};
    }
    fail(409,'INSTALLMENT_ALREADY_REGISTERED','This installment already has a billing eligibility receipt.');
  }
  await c.query("select set_config('workos.fixed_fee_issue_operation',$1,true)",[req.operationId]);
  let event;
  try {
    const day="(statement_timestamp() at time zone 'UTC')::date";
    event=(await c.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,
      engagement_id,source_type,version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id)
      select gen_random_uuid(),$1,$2,s.client_id,s.contract_id,$5,'FIXED_FEE_INSTALLMENT',1,${day},s.currency,s.amount,
      s.evidence || jsonb_build_object('approvalReason',$6::text),$7,$8,$9
      from fixed_fee_installment_source($1,$2,$3,$4,$5,${day}) s returning id`,
      [...args,installment,engagementId,reason,req.user.sub,req.user.activeRole,req.operationId])).rows[0];
  } catch (error) {
    if (error.code==='FFE01') fail(403,'INSTALLMENT_APPROVAL_DENIED','An independent authorized reviewer is required.');
    if (error.code==='CTM04') fail(409,'INSTALLMENT_PERIOD_CLOSED','The financial period does not permit installment approval.');
    if (error.code==='FFE02') fail(409,'INSTALLMENT_SOURCE_CHANGED','Reload the contract schedule and engagement.');
    throw error;
  }
  if (!event) fail(409,'INSTALLMENT_UNAVAILABLE','Check the due date, adopted terms, prior charges and engagement coverage.');
  const result=await receipts();
  const receipt=result.find(item=>item.eventId===event.id);
  await audit(c,req,{module:'Commercial Drafting',action:'Approve Installment',entityType:'Billing Eligibility Event',
    entityId:event.id,oldValue:null,newValue:{eventId:event.id,itemId:receipt.itemId},source:'Web',
    reason:'Independent installment approval retained in protected billing evidence.',details:'Fixed-fee installment entered the approved-unbilled register.'});
  return {receipts:result};
}
