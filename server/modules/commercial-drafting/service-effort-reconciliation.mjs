import {sumHours} from '../../../shared/work-hours.mjs';
import {approvedWorkDisposition} from '../planning/actual-work-service.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export async function reconcileServiceEffort(client, req, buildEmployeeScopeWhere) {
  for (const grant of ['commercial.service_units.decide','employees.view','reports.view_utilization']) {
    await assertCommercialAuthority(client,req,grant);
  }
  const {organizationId,legalEntityId}=req.organizationScope;
  const params=[organizationId,legalEntityId,req.params.id,req.params.evidenceId];
  const scope=buildEmployeeScopeWhere(req,params,'worker');
  const {rows:[receipt]}=await client.query(`select e.id,e.service_date::text,e.source_reference,e.version_id,
      e.recorder_worker_id,trim_scale(e.effort_hours)::text hours,r.decision,
      exists(select from commercial_service_unit_evidence other where other.organization_id=e.organization_id
        and other.legal_entity_id=e.legal_entity_id and other.engagement_id=e.engagement_id and other.version_id=e.version_id
        and other.service_date=e.service_date and other.recorder_worker_id=e.recorder_worker_id
        and other.source_reference=e.source_reference and other.effort_hours is not null and other.id<>e.id
        and not exists(select from commercial_service_unit_reviews rejection where rejection.evidence_id=other.id
          and rejection.decision='Rejected')) ambiguous
    from commercial_service_unit_evidence e join employees worker on worker.id=e.recorder_worker_id
      and worker.organization_id=e.organization_id and worker.legal_entity_id=e.legal_entity_id
    left join commercial_service_unit_reviews r on r.evidence_id=e.id
    where e.organization_id=$1 and e.legal_entity_id=$2 and e.engagement_id=$3 and e.id::text=$4 and ${scope}`,params);
  if (!receipt) fail(404,'COMMERCIAL_NOT_FOUND','Service evidence was not found in your worker scope.');
  const result=(status,approvedHours=null,entryCount=null)=>({evidenceId:receipt.id,status,recordedHours:receipt.hours,approvedHours,entryCount});
  if (!receipt.hours) return result('no_recorded_effort');
  if (!receipt.decision) return result('pending_review');
  if (receipt.decision!=='Accepted') return result('rejected');
  if (receipt.ambiguous) return result('ambiguous_reference');
  const {rows}=await client.query(`select entry.*,entry.work_date::text,sheet.status,sub.entries,d.status decision,
      exists(select from jsonb_array_elements(sub.entries) item where item->>'entryId'=entry.id::text
        and item->>'kind'='governed' and item->>'bindingId'=b.id and item->'references'->0->>'contractVersionId'=$7
        and commercial_tm_terms_match(b,eng,item->'references',entry.work_date)) as pinned
    from timesheets sheet join timesheet_entries entry on entry.timesheet_id=sheet.id
    join commercial_project_bindings b on b.organization_id=sheet.organization_id and b.legal_entity_id=sheet.legal_entity_id
      and b.project_id=entry.project_id and b.engagement_id=$3 and b.model='managed_service'
    join commercial_engagements eng on eng.organization_id=b.organization_id and eng.legal_entity_id=b.legal_entity_id and eng.id=b.engagement_id
    left join lateral (select s.id,s.entries from work_submission_evidence s where s.timesheet_id=sheet.id
      and s.organization_id=sheet.organization_id and s.legal_entity_id=sheet.legal_entity_id order by s.sequence desc limit 1) sub on true
    left join lateral (select status from work_submission_decisions where submission_id=sub.id order by created_at desc,id desc limit 1) d on true
    where sheet.organization_id=$1 and sheet.legal_entity_id=$2 and sheet.employee_id=$4 and sheet.status='Approved'
      and entry.work_date=$5 and entry.work_reference=$6 limit 101`,
    [organizationId,legalEntityId,req.params.id,receipt.recorder_worker_id,receipt.service_date,receipt.source_reference,receipt.version_id]);
  if (!rows.length) return result('no_approved_work');
  if (rows.length>100 || rows.some(row=>!row.pinned || approvedWorkDisposition(row,{entries:row.entries},{status:row.decision}).disposition==='unresolved'))
    return result('unverified_work');
  const hours=sumHours(rows.map(row=>row.hours));
  return result(hours===receipt.hours?'matched':'hours_differ',hours,rows.length);
}
