import {authorizeRateCandidate} from '../commercial-rates/router.mjs';
import {priceRetainerOverage} from './retainer-overage.mjs';
import {retainerBalances} from './retainer-balances.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export async function getRetainerConsumption(client, req, buildEmployeeScopeWhere, priceOverage=false, statementStart=null, source=req.params) {
  await assertCommercialAuthority(client, req, 'employees.view');
  await assertCommercialAuthority(client, req, 'reports.view_utilization');
  if (priceOverage) await authorizeRateCandidate(client,req,'billing');
  const {organizationId, legalEntityId} = req.organizationScope;
  const {id:contractId, versionId} = source;
  const params = [organizationId, legalEntityId, contractId, versionId];
  const version = await client.query(
    `select retainer_periods,retainer_capacity_policy,retainer_overage_policy,retainer_rounding,effective_from::text,currency,(now() at time zone 'UTC')::date::text today from commercial_contract_versions where organization_id=$1 and legal_entity_id=$2
     and contract_id=$3 and id=$4 and model='retainer'`, params);
  if (!version.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','The scoped retainer version was not found.');
  const terms=version.rows[0];
  const periods=statementStart ? terms.retainer_periods.filter(p=>p.startsOn>=terms.effective_from &&
    p.startsOn<=statementStart && (p.startsOn===statementStart || terms.retainer_capacity_policy?.endsWith('_rollover'))) : terms.retainer_periods;
  params.push(JSON.stringify(periods));
  const coverage = {entityWide:false};
  const workerScope = buildEmployeeScopeWhere(req,params,'worker',coverage);
  if (priceOverage && !coverage.entityWide) fail(403,'COMMERCIAL_PERMISSION_DENIED','Contract-wide worker visibility is required for overage pricing.');
  if (priceOverage && !version.rows[0].retainer_overage_policy) fail(409,'COMMERCIAL_RETAINER_OVERAGE_UNSPECIFIED','Select overage terms on a contract version before pricing.');
  if (statementStart) {
    const period=periods.find(p=>p.startsOn===statementStart);
    if (!period || period.startsOn<version.rows[0].effective_from || period.startsOn>version.rows[0].today)
      fail(409,'RETAINER_PERIOD_OPEN','A full service period that has started is required.');
    if (!version.rows[0].retainer_rounding) fail(409,'RETAINER_ROUNDING_REQUIRED','Select monetary rounding before preparing a statement.');
  }
  if (!periods.length) return {contractId, versionId, periods:[]};
  const result=await approvedRetainerRows(client,params,workerScope,Boolean(statementStart),Boolean(source.throughToday));
  const {retainer_capacity_policy:policy,today,effective_from:effectiveFrom} = version.rows[0];
  const rows = coverage.entityWide && policy
    ? retainerBalances(periods,result.rows,policy,today,effectiveFrom) : result.rows;
  if (priceOverage) {
    const {currency,retainer_overage_policy:overagePolicy}=version.rows[0];
    const prices=await priceRetainerOverage(client,req.organizationScope,contractId,currency,overagePolicy,rows,periods,version.rows[0].retainer_rounding);
    if (statementStart) {
      const target=rows.find(p=>p.startsOn===statementStart), price=prices.find(p=>p.startsOn===statementStart);
      const rollover=policy.endsWith('_rollover');
      const inputs=rows.filter(p=>p.capacity && (rollover || p===target));
      if (!price?.periodPrice) return null;
      return {format:'retainer-statement/1',closed:target.endsOn<today,contractId,versionId,currency,capacityPolicy:policy,overagePolicy,
        rounding:version.rows[0].retainer_rounding,price,periods:inputs.map(p=>({...p,terms:periods.find(t=>t.startsOn===p.startsOn)}))};
    }
    return {contractId,versionId,currency,periods:prices};
  }
  return {contractId, versionId, periods:rows};
}

export async function approvedRetainerRows(client,params,workerScope,statementStart,throughToday) {
  return client.query(`
    with periods as (
      select * from jsonb_to_recordset($5::jsonb) as p("startsOn" date,"endsOn" date)
    ), approved as (
      select entry.work_date,entry.hours,entry.billable${statementStart ? `,entry.id entry_id,submission.id submission_id,
        decision.id decision_id,eng.id engagement_id,b.project_id,sheet.employee_id worker_id` : ''} from commercial_engagements eng
      join commercial_project_bindings b on b.organization_id=eng.organization_id and b.legal_entity_id=eng.legal_entity_id
        and b.engagement_id=eng.id and b.model=eng.model
      join timesheet_entries entry on entry.project_id=b.project_id and entry.hours>0
      join timesheets sheet on sheet.id=entry.timesheet_id and sheet.status='Approved'
        and sheet.organization_id=eng.organization_id and sheet.legal_entity_id=eng.legal_entity_id
      join employees worker on worker.id=sheet.employee_id
      join lateral (select s.id,s.entries from work_submission_evidence s where s.timesheet_id=sheet.id
        and s.organization_id=eng.organization_id and s.legal_entity_id=eng.legal_entity_id
        order by s.sequence desc limit 1) submission on true
      join lateral (select d.status,d.id from work_submission_decisions d where d.submission_id=submission.id
        order by d.created_at desc,d.id desc limit 1) decision on decision.status='Approved'
      where eng.organization_id=$1 and eng.legal_entity_id=$2 and eng.contract_id=$3 and eng.model='retainer'
        ${throughToday ? "and entry.work_date<=(now() at time zone 'UTC')::date" : ''}
        and ${workerScope}
        and exists (select 1 from jsonb_array_elements(submission.entries) item
          where item->>'entryId'=entry.id::text and item->>'kind'='governed' and item->>'bindingId'=b.id
            and item->>'projectId'=entry.project_id and item->>'workDate'=entry.work_date::text
            and (item->>'hours')::numeric=entry.hours and (item->>'billable')::boolean=entry.billable
            and item->'references'->0->>'contractVersionId'=$4
            and commercial_tm_terms_match(b,eng,item->'references',entry.work_date))
    )
    select p."startsOn"::text,p."endsOn"::text,
      ${statementStart ? `count(a.entry_id)::int as "entryCount",
        coalesce(jsonb_agg(jsonb_build_object('entryId',a.entry_id,'submissionId',a.submission_id,'decisionId',a.decision_id,
          'projectId',a.project_id,'workerId',a.worker_id,'engagementId',a.engagement_id,'workDate',a.work_date,'billable',a.billable,'hours',trim_scale(a.hours)::text)
          order by a.entry_id) filter(where a.entry_id is not null),'[]'::jsonb) as entries,` : ''}
      trim_scale(coalesce(sum(a.hours) filter(where a.billable),0))::text as "billableHours",
      trim_scale(coalesce(sum(a.hours) filter(where not a.billable),0))::text as "nonBillableHours"
    from periods p left join approved a on a.work_date between p."startsOn" and p."endsOn"
    group by p."startsOn",p."endsOn" order by p."startsOn"`, params);
}
