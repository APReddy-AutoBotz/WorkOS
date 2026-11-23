import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const riskConfigureGrant='commercial.fixed_fee_risk.configure';
const namedRecipient=z.object({userId:z.string().uuid().toLowerCase(),role:z.string().trim().min(1).max(100)}).strict();
const locale=z.string().min(2).max(64).refine(value=>{
  try {return Intl.getCanonicalLocales(value)[0]===value;} catch {return false;}
});
export const riskPolicyCommand=z.object({
  expectedVersion:z.number().int().nonnegative(),effectiveFrom:z.string().date(),
  manager:namedRecipient,finance:namedRecipient,locale,title:z.string().trim().min(1).max(200),
  body:z.string().trim().min(1).max(2000),reason:z.string().trim().min(3).max(1000)
}).strict();
const policyFields=`id,version,effective_from::text "effectiveFrom",locale,title,body,
  jsonb_build_object('userId',manager_id,'role',manager_role) manager,
  jsonb_build_object('userId',finance_id,'role',finance_role) finance`;

export async function fixedFeeRiskPolicy(client,req,input,audit) {
  const scope=await requireRiskConfigurationScope(client,req);
  const [organizationId,legalEntityId]=scope;
  const actor=req.user.sub,role=req.user.activeRole;
  const {rows:[last]}=await client.query(`select ${policyFields} from fixed_fee_risk_notice_policies
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by version desc limit 1`,scope);
  if (!input) return {engagementId:req.params.id,latest:last??null};
  if (input.expectedVersion!==(last?.version??0)) {
    if (last?.version===input.expectedVersion+1) {
      const replay=await client.query(`select 1 from fixed_fee_risk_notice_policies where id=$1 and actor_id=$2 and active_role=$3 and reason=$4`,
        [last.id,actor,role,input.reason]);
      if (replay.rowCount && ['effectiveFrom','locale','title','body'].every(key=>last[key]===input[key])
        && ['manager','finance'].every(key=>last[key].userId===input[key].userId && last[key].role===input[key].role)) {
        return {engagementId:req.params.id,latest:last};
      }
    }
    fail(409,'RISK_POLICY_CHANGED','Review the latest recipient configuration.');
  }
  const id=randomUUID();
  await client.query("select set_config('workos.risk_notice_policy_context',$1,true)",[JSON.stringify({
    id,actor,role,organization:organizationId,entity:legalEntityId,engagement:req.params.id,operation:req.operationId})]);
  const {rows:[saved]}=await client.query(`insert into fixed_fee_risk_notice_policies
    (id,organization_id,legal_entity_id,engagement_id,version,effective_from,manager_id,manager_role,finance_id,finance_role,
     locale,title,body,actor_id,active_role,operation_id,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    returning ${policyFields}`,[id,...scope,input.expectedVersion+1,input.effectiveFrom,input.manager.userId,input.manager.role,
    input.finance.userId,input.finance.role,input.locale,input.title,input.body,actor,role,req.operationId,input.reason]);
  await audit(client,req,{module:'Commercial Notifications',action:'Configure Fixed Fee Risk Notices',entityType:'Fixed Fee Risk Policy',
    entityId:id,details:'Versioned engagement notice policy.',oldValue:last?{policyId:last.id}:null,newValue:{policyId:id},source:'Web',
    reason:'Approved recipient configuration and reason retained on the scoped policy.'});
  return {engagementId:req.params.id,latest:saved};
}

async function requireRiskConfigurationScope(client,req) {
  await assertCommercialAuthority(client,req,riskConfigureGrant);
  const {organizationId,legalEntityId}=req.organizationScope;
  const scope=[organizationId,legalEntityId,req.params.id];
  const actor=req.user.sub,role=req.user.activeRole;
  const access=await client.query(`select 1 from commercial_engagements where organization_id=$1 and legal_entity_id=$2
    and id=$3 and model='fixed_fee' and rate_candidate_worker_visible($4::jsonb,owner_id)`,
    [...scope,JSON.stringify({organizationId,legalEntityId,actorId:actor,activeRole:role})]);
  if (!access.rowCount) fail(404,'RISK_POLICY_UNAVAILABLE','The fixed-fee engagement is unavailable in the current scope.');
  return scope;
}

export async function fixedFeeRiskDeliveryStatus(client,req) {
  const scope=await requireRiskConfigurationScope(client,req);
  const {rows:[scan]}=await client.query(`select through_date::text as "scanDate",failure as "scanFailure"
    from fixed_fee_risk_scans where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3`,scope);
  const {rows:events}=await client.query(`select e.metric,e.through_date::text as "through",e.source_id as "sourceAmendmentId",
    d.attempts,d.failure,d.delivered_at as "deliveredAt",case when d.delivered_at is null then d.next_attempt end as "nextAttempt"
    from fixed_fee_risk_events e join fixed_fee_risk_dispatch d on d.event_id=e.id
    where e.organization_id=$1 and e.legal_entity_id=$2 and e.engagement_id=$3 order by e.created_at desc,e.id limit 20`,scope);
  return {engagementId:req.params.id,scan:scan??null,events};
}
