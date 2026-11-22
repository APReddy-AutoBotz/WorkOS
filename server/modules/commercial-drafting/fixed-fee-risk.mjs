import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const riskQuery=z.object({through:z.string().date()}).strict();

export async function fixedFeeRisk(client,req,{through},buildEmployeeScopeWhere) {
  for (const grant of ['employees.view','reports.view_utilization','commercial.fixed_fee_cost.view','commercial.cost_candidates.view']) {
    await assertCommercialAuthority(client,req,grant);
  }
  const coverage={entityWide:false};
  buildEmployeeScopeWhere(req,[],'worker',coverage);
  if (!coverage.entityWide) fail(403,'FIXED_RISK_DENIED','Engagement-wide worker visibility is required.');
  const {organizationId,legalEntityId}=req.organizationScope;
  const context={organizationId,legalEntityId,actorId:req.user.sub,activeRole:req.user.activeRole};
  const {rows:[row]}=await client.query(`with terms as (
    select e.id, e.currency, coalesce(a.contract_version_id,e.contract_version_id) version_id,
      a.id amendment_id,coalesce(a.budget,e.budget) allocation
    from commercial_engagements e left join lateral (
      select id,contract_version_id,budget from commercial_amendments
      where organization_id=$1 and legal_entity_id=$2 and entity_type='Engagement' and entity_id=e.id and effective_on<=$4::date
      order by sequence desc limit 1
    ) a on true where e.organization_id=$1 and e.legal_entity_id=$2 and e.id=$3 and e.model='fixed_fee'
      and $4::date <= (now() at time zone 'UTC')::date and exists(select from commercial_lifecycle_events l
        where l.organization_id=$1 and l.legal_entity_id=$2 and l.entity_type='Engagement' and l.entity_id=e.id
          and l.state='Active' and l.effective_on<=$4::date)
  ), work as (
    select t.id,s.employee_id from commercial_project_bindings b join timesheet_entries t on t.project_id=b.project_id
    join timesheets s on s.id=t.timesheet_id and s.organization_id=$1 and s.legal_entity_id=$2 and s.status='Approved'
    where b.organization_id=$1 and b.legal_entity_id=$2 and b.engagement_id=$3 and b.model='fixed_fee' and t.work_date<=$4::date
  ), costs as (
    select entry_id,worker_id,currency,amount from commercial_fixed_fee_work_costs where organization_id=$1 and legal_entity_id=$2
      and engagement_id=$3 and work_date<=$4::date
  ), amounts as (
    select count(w.id)::int approved,count(c.entry_id)::int costed,
      count(*) filter(where w.id is null or c.entry_id is null)::int unmatched,
      coalesce(sum(c.amount),0) retained,
      bool_and(rate_candidate_worker_visible($5::jsonb,coalesce(c.worker_id,w.employee_id)) is true) visible,
      bool_and(c.currency is null or c.currency=(select currency from terms)) currency_matches
    from work w full join costs c on c.entry_id=w.id
  )
  select t.version_id "contractVersionId",t.amendment_id "amendmentId",t.currency,trim_scale(t.allocation)::text allocation,
    a.approved "approvedEntries",a.costed "costedEntries",a.visible,a.currency_matches,(a.approved>0 and a.unmatched=0) "complete",
    trim_scale(a.retained)::text "retainedCost",trim_scale(t.allocation-a.retained)::text "remainingAllocation",
    case when a.retained>t.allocation then 'exceeded' when a.approved=0 and a.costed=0 then 'no_work'
      when a.unmatched>0 then 'incomplete' when a.retained=t.allocation then 'exhausted' else 'remaining' end status
  from terms t cross join amounts a`,[organizationId,legalEntityId,req.params.id,through,JSON.stringify(context)]);
  if (!row) fail(404,'FIXED_RISK_UNAVAILABLE','An activated fixed-fee engagement and a current or historical date are required.');
  if (row.visible===false) fail(403,'FIXED_RISK_DENIED','Engagement-wide cost visibility is required.');
  if (row.currency_matches===false) fail(409,'FIXED_RISK_CURRENCY','Retained costs must reconcile in the allocation currency.');
  const {visible,currency_matches,...report}=row;
  return {engagementId:req.params.id,through,...report};
}
