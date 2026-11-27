import {canonicalHours} from '../../../shared/work-hours.mjs';
import {z} from 'zod';
import {decimalAmount,fail} from './contracts.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';

export const prepareCostGrant='commercial.project_costs.prepare';
export const decideCostGrant='commercial.project_costs.decide';
export const costDay=z.object({day:z.string().date()}).strict();
export const costEntry=costDay.extend({id:z.string().uuid(),projectId:z.string().min(1).max(200),
  reference:z.string().trim().min(1).max(160),amount:decimalAmount.refine(value=>/[1-9]/.test(value))}).strict();
export const costDecision=z.object({id:z.string().uuid(),decision:z.enum(['Approved','Rejected']),reason:z.string().trim().min(3).max(1000)}).strict();
const scope=(req)=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId,req.params.id];
const auditRow="to_jsonb(e)||jsonb_build_object('amount',trim_scale(e.amount)::text)";

export async function approvedProjectCost(client,args) {
  const {rows:[result]}=await client.query(`select trim_scale(coalesce(sum(e.amount),0))::text amount,count(*)::int entries,encode(digest(coalesce(string_agg(e.id::text,',' order by e.id),''),'sha256'),'hex') "sourceHash"
    from commercial_project_cost_entries e join commercial_project_bindings b on b.id=e.binding_id
    where e.organization_id=$1 and e.legal_entity_id=$2 and b.engagement_id=$3 and e.incurred_on<=$4 and e.decision='Approved'`,args);
  return result;
}

export async function projectCosts(client,req,input,workerScope,audit) {
  await assertElapsedReadScope(client,req,workerScope);
  await assertCommercialAuthority(client,req,'commercial.fixed_fee_margin.view');
  const args=scope(req);
  const engagement=(await client.query("select currency from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='fixed_fee'",args)).rows[0];
  if(!engagement)fail(404,'PROJECT_COST_UNAVAILABLE','Fixed-fee engagement unavailable.');
  if(!audit){
    const projects=(await client.query(`select b.project_id id,b.code,b.name,
      ($4::date <= (now() at time zone 'UTC')::date and
       $4::date between coalesce(terms.starts_on,b.starts_on) and coalesce(terms.ends_on,b.ends_on)) as "inTerm"
      from commercial_project_bindings b left join lateral (
        select a.starts_on,a.ends_on from commercial_amendments a
        where a.organization_id=b.organization_id and a.legal_entity_id=b.legal_entity_id
          and a.entity_type='Project' and a.entity_id=b.project_id and a.effective_on<=$4::date
        order by a.sequence desc limit 1
      ) terms on true
      where b.organization_id=$1 and b.legal_entity_id=$2 and b.engagement_id=$3
      order by b.code,b.project_id`,[...args,input.day])).rows;
    const entries=(await client.query(`select e.id,b.project_id "projectId",e.reference,trim_scale(e.amount)::text amount,e.decision,
      e.decision_reason reason,e.prepared_by=$5 as "preparedByMe" from commercial_project_cost_entries e join commercial_project_bindings b on b.id=e.binding_id
      where e.organization_id=$1 and e.legal_entity_id=$2 and b.engagement_id=$3 and e.incurred_on=$4 order by e.created_at,e.id`,[...args,input.day,req.user.sub])).rows;
    return {engagementId:req.params.id,day:input.day,currency:engagement.currency,projects,entries};
  }
  const actor=req.user.sub;
  const {rows:[prior]}=await client.query(`select ${auditRow} source,b.project_id from commercial_project_cost_entries e
    join commercial_project_bindings b on b.id=e.binding_id where e.organization_id=$1 and e.legal_entity_id=$2 and b.engagement_id=$3 and e.id=$4`,[...args,input.id]);
  await client.query("select set_config('workos.project_cost',$1,true)",[JSON.stringify({id:input.id,actor,role:req.user.activeRole,operation:req.operationId})]);
  let saved;
  if(input.decision){
    if(!prior)fail(404,'PROJECT_COST_UNAVAILABLE','Project cost unavailable.');
    if(prior.source.decision){
      if(prior.source.decision===input.decision && prior.source.decided_by===actor && prior.source.decision_reason===input.reason)return {id:input.id};
      fail(409,'PROJECT_COST_DECIDED','The project cost already has a decision.');
    }
    ({rows:[saved]}=await client.query(`update commercial_project_cost_entries e set decision=$2,decided_by=$3,decision_reason=$4 where id=$1 returning ${auditRow} source`,[input.id,input.decision,actor,input.reason]));
  }else{
    if(prior){
      if(prior.source.prepared_by===actor && prior.project_id===input.projectId && prior.source.incurred_on===input.day && prior.source.reference===input.reference &&
        prior.source.amount===canonicalHours(input.amount))return {id:input.id};
      fail(409,'PROJECT_COST_CHANGED','The request already recorded a different cost.');
    }
    ({rows:[saved]}=await client.query(`insert into commercial_project_cost_entries as e
      (id,organization_id,legal_entity_id,binding_id,incurred_on,reference,amount,prepared_by)
      select $4,$1,$2,b.id,$5,$6,$7,$8 from commercial_project_bindings b
      where b.organization_id=$1 and b.legal_entity_id=$2 and b.engagement_id=$3 and b.project_id=$9
      returning ${auditRow} source`,[...args,input.id,input.day,input.reference,input.amount,actor,input.projectId]));
    if(!saved)fail(404,'PROJECT_COST_UNAVAILABLE','Project unavailable for this engagement.');
  }
  await audit(client,req,{module:'Commercial Drafting',entityType:'Project Cost',entityId:input.id,action:input.decision??'Prepared',
    oldValue:prior?.source??null,newValue:saved.source,source:'Web',details:input.reason??input.reference});
  return {id:input.id};
}
