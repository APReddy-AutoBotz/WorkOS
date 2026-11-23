import {z} from 'zod';
import {sumHours} from '../../../shared/work-hours.mjs';
import {approvedWorkDisposition} from '../planning/actual-work-service.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const effortMonth=z.object({monthStart:z.string().date().regex(/-01$/)}).strict();

export async function fixedFeeWorkRows(client,req,{monthStart,through,after,startsOn},buildEmployeeScopeWhere) {
  for (const key of ['employees.view','reports.view_utilization']) await assertCommercialAuthority(client,req,key);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id];
  const engagement=await client.query("select id from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 and model='fixed_fee'",args);
  if (!engagement.rowCount) fail(404,'COMMERCIAL_NOT_FOUND','Fixed-fee engagement unavailable.');
  args.push(through??monthStart);
  if (through) args.push(after??null);
  const dates=through ? 'entry.work_date <= $4::date and ($5::uuid is null or entry.id>$5::uuid)'
    : "entry.work_date >= $4::date and entry.work_date < $4::date + interval '1 month'";
  const from=through && startsOn?' and entry.work_date >= $'+args.push(startsOn)+'::date':'';
  const visible=buildEmployeeScopeWhere(req,args,'worker');
  const {rows}=await client.query(`select entry.*,entry.work_date::text,sheet.employee_id,sheet.status,sub.id submission_id,decision.id decision_id,retained.entries,decision.status as decision,retained.pinned
    from commercial_engagements eng join commercial_project_bindings b on b.organization_id=eng.organization_id
      and b.legal_entity_id=eng.legal_entity_id and b.engagement_id=eng.id and b.model=eng.model
    join timesheet_entries entry on entry.project_id=b.project_id
    join timesheets sheet on sheet.id=entry.timesheet_id and sheet.organization_id=b.organization_id
      and sheet.legal_entity_id=b.legal_entity_id and sheet.status='Approved'
    join employees worker on worker.organization_id=sheet.organization_id and worker.legal_entity_id=sheet.legal_entity_id and worker.id=sheet.employee_id
    left join lateral(select s.id,s.entries from work_submission_evidence s where s.timesheet_id=sheet.id and s.organization_id=sheet.organization_id
      and s.legal_entity_id=sheet.legal_entity_id order by s.sequence desc limit 1) sub on true
    left join lateral(select jsonb_agg(item) entries,bool_or(item->>'kind'='governed' and item->>'bindingId'=b.id
        and commercial_tm_terms_match(b,eng,item->'references',entry.work_date)) pinned
      from jsonb_array_elements(case when jsonb_typeof(sub.entries)='array' then sub.entries else '[]'::jsonb end) item
      where item->>'entryId'=entry.id::text) retained on true
    left join lateral(select d.id,d.status from work_submission_decisions d where d.submission_id=sub.id order by d.created_at desc,d.id desc limit 1) decision on true
    where eng.organization_id=$1 and eng.legal_entity_id=$2 and eng.id=$3 and ${dates}${from} and (${visible})
      ${through?'order by entry.id limit 500':''}`,args);
  const verified=rows.filter(row=>row.pinned && approvedWorkDisposition(row,{entries:row.entries},{status:row.decision}).disposition!=='unresolved');
  return {verified,unresolvedEntries:rows.length-verified.length,next:through && rows.length===500?rows.at(-1).id:null};
}

export async function fixedFeeEffort(client,req,{monthStart},buildEmployeeScopeWhere) {
  const {verified,unresolvedEntries}=await fixedFeeWorkRows(client,req,{monthStart},buildEmployeeScopeWhere);
  return {engagementId:req.params.id,monthStart,verifiedEntries:verified.length,unresolvedEntries,
    billableHours:sumHours(verified.filter(row=>row.billable).map(row=>row.hours)),
    nonBillableHours:sumHours(verified.filter(row=>!row.billable).map(row=>row.hours))};
}
