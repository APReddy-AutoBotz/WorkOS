import {createHash} from 'node:crypto';
import {fixedFeeWorkRows} from './fixed-fee-effort.mjs';
import {decimalQuantity,sumHours} from '../../../shared/work-hours.mjs';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const riskQuery=z.object({through:z.string().date(),view:z.enum(['expense_budget','project_expenses','budget_warnings']).optional()}).strict();

export function budgetWarningStatus(actual,budget,percent,complete) {
  if (budget==null) return 'unbudgeted';
  const used=decimalQuantity(actual),limit=decimalQuantity(budget);
  const reached=used.units>0n && used.units*100n*10n**BigInt(limit.scale)>=limit.units*BigInt(percent)*10n**BigInt(used.scale);
  return reached?'reached':complete?'below':'incomplete';
}

export async function fixedFeeRisk(client,req,{through,view},buildEmployeeScopeWhere,forecast=false) {
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
      a.id amendment_id,coalesce(a.budget,e.budget) allocation,a.labor_budget,a.expense_budget,a.warning_percent,a.effective_on,a.budget_hours
    from commercial_engagements e left join lateral (
      select id,contract_version_id,budget,effective_on,after_value->'terms'->>'budgetWarningPercent' warning_percent,(after_value->'terms'->>'expenseBudget')::numeric expense_budget,(after_value->'terms'->>'laborCostBudget')::numeric labor_budget,(after_value->'terms'->>'budgetHours')::numeric budget_hours from commercial_amendments
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
    select id,entry_id,worker_id,currency,amount from commercial_fixed_fee_work_costs where organization_id=$1 and legal_entity_id=$2
      and engagement_id=$3 and work_date<=$4::date
  ), amounts as (
    select count(w.id)::int approved,count(c.entry_id)::int costed,
      count(*) filter(where w.id is null or c.entry_id is null)::int unmatched,
      coalesce(sum(c.amount),0) retained,
      ${forecast?"encode(sha256(convert_to(coalesce(string_agg(c.id::text,',' order by c.id),''),'UTF8')),'hex')":"null::text"} cost_token,
      bool_and(rate_candidate_worker_visible($5::jsonb,coalesce(c.worker_id,w.employee_id)) is true) visible,
      bool_and(c.currency is null or c.currency=(select currency from terms)) currency_matches
    from work w full join costs c on c.entry_id=w.id
  )
  select a.cost_token,t.version_id "contractVersionId",t.amendment_id "amendmentId",t.currency,trim_scale(t.allocation)::text allocation,
    a.approved "approvedEntries",a.costed "costedEntries",a.visible,a.currency_matches,(a.approved>0 and a.unmatched=0) "complete",
    trim_scale(a.retained)::text "retainedCost",trim_scale(t.allocation-a.retained)::text "remainingAllocation",
    case when a.retained>t.allocation then 'exceeded' when a.approved=0 and a.costed=0 then 'no_work'
      when a.unmatched>0 then 'incomplete' when a.retained=t.allocation then 'exhausted' else 'remaining' end status,
    t.warning_percent,t.effective_on::text as "effectiveOn",trim_scale(t.expense_budget)::text as "expenseAmount",trim_scale(t.budget_hours)::text "budgetHours",trim_scale(t.labor_budget)::text "laborCostBudget",trim_scale(t.labor_budget-a.retained)::text "remainingLaborBudget",
    case when t.labor_budget is null then null when a.retained>t.labor_budget then 'exceeded'
      when a.approved=0 and a.costed=0 then 'no_work' when a.unmatched>0 then 'incomplete'
      when a.retained=t.labor_budget then 'exhausted' else 'remaining' end "laborBudgetStatus"
  from terms t cross join amounts a`,[organizationId,legalEntityId,req.params.id,through,JSON.stringify(context)]);
  if (!row) fail(404,'FIXED_RISK_UNAVAILABLE','An activated fixed-fee engagement and a current or historical date are required.');
  if (row.visible===false) fail(403,'FIXED_RISK_DENIED','Engagement-wide cost visibility is required.');
  if (row.currency_matches===false) fail(409,'FIXED_RISK_CURRENCY','Retained costs must reconcile in the allocation currency.');
  const {visible,currency_matches,cost_token,budgetHours,expenseAmount,effectiveOn,warning_percent,...report}=row;
  if (view!==undefined) report.expenseBudget=expenseAmount===null?null:{amount:expenseAmount,effectiveOn,amendmentId:report.amendmentId};
  if (view==='project_expenses' || view==='budget_warnings') {
    const {rows:[projects]}=await client.query(`with budgets as (
      select (a.after_value->'terms'->>'expenseBudget')::numeric amount from commercial_project_bindings b
      left join lateral(select after_value,starts_on,ends_on from commercial_amendments
        where organization_id=b.organization_id and legal_entity_id=b.legal_entity_id and entity_type='Project'
        and entity_id=b.project_id and effective_on<=$4::date order by sequence desc limit 1) a on true
      where b.organization_id=$1 and b.legal_entity_id=$2 and b.engagement_id=$3 and b.model='fixed_fee'
        and $4::date between coalesce(a.starts_on,b.starts_on) and coalesce(a.ends_on,b.ends_on)
    ) select count(*)::int projects,count(amount)::int budgeted,trim_scale(coalesce(sum(amount),0))::text allocated,
      trim_scale($5::numeric-coalesce(sum(amount),0))::text unallocated from budgets`,
      [organizationId,legalEntityId,req.params.id,through,expenseAmount]);
    report.projectExpenses=projects;
  }
  report.effortBudget=null;
  if (budgetHours!==null || forecast) {
    const evidence=forecast?createHash('sha256'):null;
    let after=null,verifiedHours='0',unresolved=0;
    do {
      const page=await fixedFeeWorkRows(client,req,{through,after},buildEmployeeScopeWhere);
      verifiedHours=sumHours([verifiedHours,...page.verified.map(entry=>entry.hours)]);
      if (evidence) for (const entry of page.verified) evidence.update(JSON.stringify([entry.id,entry.hours,entry.work_date,entry.billable]));
      unresolved+=page.unresolvedEntries;
      after=page.next;
    } while (after);
    if (forecast) report.forecastEvidence={verifiedHours,unresolved,workToken:evidence.digest('hex'),costToken:cost_token};
    if (budgetHours!==null) {
      const {rows:[variance]}=await client.query(`select trim_scale($1::numeric-$2::numeric)::text as "remainingHours",
        case when $2::numeric>$1::numeric then 'exceeded' when $3::int>0 then 'incomplete'
          when $4::int=0 then 'no_work' when $2::numeric=$1::numeric then 'exhausted' else 'remaining' end status`,
        [budgetHours,verifiedHours,unresolved,row.approvedEntries]);
      report.effortBudget={budgetHours,verifiedHours,unresolvedEntries:unresolved,...variance};
    }
  }
  if (view==='budget_warnings') {
    report.budgetWarning=null;
    if (warning_percent && warning_percent!=='disabled') {
      const effort=report.effortBudget;
      report.budgetWarning={percent:warning_percent,effectiveOn,amendmentId:report.amendmentId,
        effort:budgetWarningStatus(effort?.verifiedHours,budgetHours,warning_percent,effort?.unresolvedEntries===0),
        laborCost:budgetWarningStatus(report.retainedCost,report.laborCostBudget,warning_percent,report.complete || (report.approvedEntries===0 && report.costedEntries===0))};
    }
  }
  return {engagementId:req.params.id,through,...report};
}
