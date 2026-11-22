import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {effortMonth,fixedFeeWorkRows} from './fixed-fee-effort.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const fixedCostGrant='commercial.fixed_fee_cost.record';
export const fixedCostCommand=effortMonth.extend({entryId:z.string().uuid(),decisionId:z.string().min(1).max(200),adoptionId:z.string().uuid()}).strict();
export async function fixedFeeCosts(client,req,input,buildEmployeeScopeWhere,audit) {
  for (const grant of ['commercial.fixed_fee_cost.view','commercial.cost_candidates.view']) await assertCommercialAuthority(client,req,grant);
  const {verified,unresolvedEntries}=await fixedFeeWorkRows(client,req,input,buildEmployeeScopeWhere);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,verified.filter(e=>!audit || e.id===input.entryId).map(e=>e.id),
    JSON.stringify({organizationId,legalEntityId,actorId:req.user.sub,activeRole:req.user.activeRole})];
  const read=async()=> (await client.query(`select t.id "entryId",s.employee_id "workerId",t.work_date::text "workDate",trim_scale(t.hours)::text hours,
      trim_scale(sum(saved.amount) over(partition by saved.currency))::text as "retainedSubtotal",
      coalesce(saved.priority,p.priority) priority,saved.id "snapshotId",coalesce(saved.decision_id,p.decision_id) "decisionId",coalesce(saved.adoption_id,p.adoption_id) "adoptionId",
      coalesce(saved.candidate_id,p.candidate_id) "candidateId",coalesce(saved.effective_from,p.effective_from)::text "effectiveFrom",
      coalesce(saved.effective_to,p.effective_to)::text "effectiveTo",coalesce(saved.currency,p.currency) currency,
      trim_scale(coalesce(saved.hourly_rate,p.hourly_rate))::text "hourlyRate",trim_scale(coalesce(saved.amount,p.amount))::text amount
    from timesheet_entries t join timesheets s on s.id=t.timesheet_id
    left join commercial_fixed_fee_work_costs saved on saved.entry_id=t.id and saved.organization_id=$1 and saved.legal_entity_id=$2 and saved.engagement_id=$3
    left join lateral fixed_fee_work_cost_source($1,$2,$3,t.id) p on saved.id is null
    where t.id=any($4::uuid[]) and rate_candidate_worker_visible($5::jsonb,s.employee_id)
    order by t.work_date,t.id`,args)).rows;
  let rows=await read();
  if (audit) {
    const row=rows[0];
    if (!row || row.decisionId!==input.decisionId || row.adoptionId!==input.adoptionId)
      fail(409,'FIXED_COST_CHANGED','Inspect the current approved work and adopted cost.');
    if (!row.snapshotId) {
      const id=randomUUID();
      await client.query("select set_config('workos.fixed_fee_work_cost',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId})]);
      await client.query(`insert into commercial_fixed_fee_work_costs(id,organization_id,legal_entity_id,engagement_id,entry_id,decision_id,adoption_id,actor_id,active_role,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,organizationId,legalEntityId,req.params.id,row.entryId,row.decisionId,row.adoptionId,req.user.sub,req.user.activeRole,req.operationId]);
      await audit(client,req,{module:'Commercial Drafting',action:'Recorded',entityType:'Fixed Fee Work Cost',entityId:id,
        oldValue:null,newValue:{costId:id,entryId:row.entryId,adoptionId:row.adoptionId},source:'Web',details:'Retained adopted worker cost for approved fixed-fee work.'});
      rows=await read();
    }
  }
  const totals=new Map();
  const entries=rows.map(({retainedSubtotal,...entry})=>{
    if (entry.snapshotId) totals.set(entry.currency,retainedSubtotal);
    return entry;
  });
  return {engagementId:req.params.id,monthStart:input.monthStart,unresolvedEntries,entries,
    retainedTotals:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([currency,amount])=>({currency,amount})),
    complete:!audit && unresolvedEntries===0 && entries.length>0 && entries.length===verified.length && entries.every(e=>e.snapshotId)};

}
