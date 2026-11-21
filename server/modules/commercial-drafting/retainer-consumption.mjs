import {retainerBalances} from './retainer-balances.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export async function getRetainerConsumption(client, req, buildEmployeeScopeWhere) {
  await assertCommercialAuthority(client, req, 'employees.view');
  await assertCommercialAuthority(client, req, 'reports.view_utilization');
  const {organizationId, legalEntityId} = req.organizationScope;
  const {id:contractId, versionId} = req.params;
  const params = [organizationId, legalEntityId, contractId, versionId];
  const version = await client.query(
    `select retainer_periods,retainer_capacity_policy,(now() at time zone 'UTC')::date::text today from commercial_contract_versions where organization_id=$1 and legal_entity_id=$2
     and contract_id=$3 and id=$4 and model='retainer'`, params);
  if (!version.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','The scoped retainer version was not found.');
  const periods = version.rows[0].retainer_periods;
  if (!periods.length) return {contractId, versionId, periods:[]};
  params.push(JSON.stringify(periods));
  const coverage = {entityWide:false};
  const workerScope = buildEmployeeScopeWhere(req,params,'worker',coverage);
  const result = await client.query(`
    with periods as (
      select * from jsonb_to_recordset($5::jsonb) as p("startsOn" date,"endsOn" date)
    ), approved as (
      select entry.work_date,entry.hours,entry.billable from commercial_engagements eng
      join commercial_project_bindings b on b.organization_id=eng.organization_id and b.legal_entity_id=eng.legal_entity_id
        and b.engagement_id=eng.id and b.model=eng.model
      join timesheet_entries entry on entry.project_id=b.project_id and entry.hours>0
      join timesheets sheet on sheet.id=entry.timesheet_id and sheet.status='Approved'
        and sheet.organization_id=eng.organization_id and sheet.legal_entity_id=eng.legal_entity_id
      join employees worker on worker.id=sheet.employee_id
      join lateral (select s.id,s.entries from work_submission_evidence s where s.timesheet_id=sheet.id
        and s.organization_id=eng.organization_id and s.legal_entity_id=eng.legal_entity_id
        order by s.sequence desc limit 1) submission on true
      join lateral (select d.status from work_submission_decisions d where d.submission_id=submission.id
        order by d.created_at desc,d.id desc limit 1) decision on decision.status='Approved'
      where eng.organization_id=$1 and eng.legal_entity_id=$2 and eng.contract_id=$3 and eng.model='retainer'
        and ${workerScope}
        and exists (select 1 from jsonb_array_elements(submission.entries) item
          where item->>'entryId'=entry.id::text and item->>'kind'='governed' and item->>'bindingId'=b.id
            and item->>'projectId'=entry.project_id and item->>'workDate'=entry.work_date::text
            and (item->>'hours')::numeric=entry.hours and (item->>'billable')::boolean=entry.billable
            and item->'references'->0->>'contractVersionId'=$4
            and commercial_tm_terms_match(b,eng,item->'references',entry.work_date))
    )
    select p."startsOn"::text,p."endsOn"::text,
      trim_scale(coalesce(sum(a.hours) filter(where a.billable),0))::text as "billableHours",
      trim_scale(coalesce(sum(a.hours) filter(where not a.billable),0))::text as "nonBillableHours"
    from periods p left join approved a on a.work_date between p."startsOn" and p."endsOn"
    group by p."startsOn",p."endsOn" order by p."startsOn"`, params);
  const {retainer_capacity_policy:policy,today} = version.rows[0];
  const rows = coverage.entityWide && policy
    ? retainerBalances(periods,result.rows,policy,today) : result.rows;
  return {contractId, versionId, periods:rows};
}
