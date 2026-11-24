import {randomUUID} from 'node:crypto';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const retainerRiskConfigureGrant='commercial.retainer_risk.configure';
const policyFields=`id,version,effective_from::text "effectiveFrom",locale,title,body,
  jsonb_build_object('userId',manager_id,'role',manager_role) manager,
  jsonb_build_object('userId',finance_id,'role',finance_role) finance`;

export async function retainerRiskPolicy(client,req,input,audit) {
  const scope=await requireRiskConfigurationScope(client,req);
  const [organizationId,legalEntityId]=scope;
  const actor=req.user.sub,role=req.user.activeRole;
  const {rows:[last]}=await client.query(`select ${policyFields} from retainer_risk_notice_policies
    where organization_id=$1 and legal_entity_id=$2 and version_id=$3 order by version desc limit 1`,scope);
  if (!input) return {versionId:req.params.id,latest:last??null};
  if (input.expectedVersion!==(last?.version??0)) {
    if (last?.version===input.expectedVersion+1) {
      const replay=await client.query(`select 1 from retainer_risk_notice_policies where id=$1 and actor_id=$2 and active_role=$3 and reason=$4`,
        [last.id,actor,role,input.reason]);
      if (replay.rowCount && ['effectiveFrom','locale','title','body'].every(key=>last[key]===input[key])
        && ['manager','finance'].every(key=>last[key].userId===input[key].userId && last[key].role===input[key].role)) {
        return {versionId:req.params.id,latest:last};
      }
    }
    fail(409,'RISK_POLICY_CHANGED','Review the latest recipient configuration.');
  }
  const id=randomUUID();
  await client.query("select set_config('workos.retainer_notice_policy_context',$1,true)",[JSON.stringify({
    id,actor,role,organization:organizationId,entity:legalEntityId,version:req.params.id,operation:req.operationId})]);
  const {rows:[saved]}=await client.query(`insert into retainer_risk_notice_policies
    (id,organization_id,legal_entity_id,version_id,version,effective_from,manager_id,manager_role,finance_id,finance_role,
     locale,title,body,actor_id,active_role,operation_id,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    returning ${policyFields}`,[id,...scope,input.expectedVersion+1,input.effectiveFrom,input.manager.userId,input.manager.role,
    input.finance.userId,input.finance.role,input.locale,input.title,input.body,actor,role,req.operationId,input.reason]);
  await audit(client,req,{module:'Commercial Notifications',action:'Configure Retainer Risk Notices',entityType:'Retainer Risk Policy',
    entityId:id,details:'Versioned retainer version notice policy.',oldValue:last?{policyId:last.id}:null,newValue:{policyId:id},source:'Web',
    reason:'Approved recipient configuration and reason retained on the scoped policy.'});
  return {versionId:req.params.id,latest:saved};
}

async function requireRiskConfigurationScope(client,req) {
  await assertCommercialAuthority(client,req,retainerRiskConfigureGrant);
  const {organizationId,legalEntityId}=req.organizationScope;
  const scope=[organizationId,legalEntityId,req.params.id];
  const access=await client.query(`select 1 from commercial_contract_versions where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='retainer'`,scope);
  if (!access.rowCount) fail(404,'RISK_POLICY_UNAVAILABLE','The retainer version is unavailable.');
  return scope;
}

export async function retainerDeliveryStatus(client,req) {
  const scope=await requireRiskConfigurationScope(client,req);
  const {rows:events}=await client.query(`select e.id,e.kind,e.starts_on::text as "startsOn",e.ends_on::text as "endsOn",
    d.attempts,d.failure,d.delivered_at as "deliveredAt",case when d.delivered_at is null then d.next_attempt end as "nextAttempt",
    (select coalesce(jsonb_agg(jsonb_build_object('attempt',h.attempt,'at',h.attempted_at,'failure',h.failure) order by h.attempt desc),'[]'::jsonb)
       from (select attempt,attempted_at,failure from retainer_risk_delivery_attempts where event_id=e.id order by attempt desc limit 5) h) history
    from retainer_risk_events e join retainer_risk_dispatch d on d.event_id=e.id
    where e.organization_id=$1 and e.legal_entity_id=$2 and e.version_id=$3 order by e.observed_at desc,e.id limit 20`,scope);
  const {rows:[scan]}=await client.query('select failure from retainer_risk_scans where version_id=$1',[req.params.id]);
  return {versionId:req.params.id,scanFailure:scan?.failure??null,events};
}
