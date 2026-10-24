import {workSourceIdentityKey} from '../../../shared/work-source-identity.mjs';
import {readSubmissionTiming,assertSubmissionTiming} from './submission-deadline.mjs';
import {checkDuplicateEntries,duplicateCheckSummary} from './duplicate-entry-check.mjs';
import {randomUUID} from 'node:crypto';
import {lockCommercialLifecycle} from '../commercial-drafting/project-mutation.mjs';
import {assertReportingPeriodAllows,REPORTING_PERIOD_OPERATIONS} from '../../reporting-periods.mjs';

export const WORK_POLICY_VERSION='assignment-work-date/1';
export class WorkPolicyError extends Error {
  constructor(code,message,statusCode=422){super(message);this.code=code;this.statusCode=statusCode;}
}
const fail=(code,message,status)=>{throw new WorkPolicyError(code,message,status);};
const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const date=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const shift=(value,days)=>{const d=new Date(`${value}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
export const workPolicyError=(res,error)=>{
  if(error?.code==='WDL01'){res.status(422).json({error:'The configured submission deadline and grace period have elapsed. Save a Draft or follow the authorized policy process.',code:'WORK_SUBMISSION_DEADLINE_BLOCKED'});return true;}
  if(error?.code==='WDL02'){res.status(409).json({error:'Submission timing requires unambiguous Weekly period authority.',code:'WORK_SUBMISSION_DEADLINE_AUTHORITY'});return true;}
  if(['WSI01','WSI02'].includes(error?.code)){res.status(409).json({error:'Source-linked work is already captured or its content differs. This create/conflict command cannot change, clear or rebind it.',code:error.code==='WSI01'?'WORK_SOURCE_IDENTITY_CONFLICT':'WORK_SOURCE_IDENTITY_IMMUTABLE'});return true;}
  if(error?.code==='WWP01'){res.status(409).json({error:'Retained submitted work cannot be rewritten.',code:'WORK_HISTORY_IMMUTABLE'});return true;}
  if(error?.code==='WOT01'){res.status(422).json({error:'Recorded work exceeds a buyer-selected overtime threshold configured to block capture.',code:'WORK_CAPTURE_OVERTIME_BLOCKED'});return true;}
  if(error?.code==='WCR06'){res.status(422).json({error:'An evidence URL is required for each positive work entry on this work date.',code:'WORK_CAPTURE_EVIDENCE_REQUIRED'});return true;}
  if(error?.code==='WCR05'){res.status(409).json({error:'Capture policy requires open authoritative reporting periods.',code:'WORK_CAPTURE_PERIOD_AUTHORITY'});return true;}
  if(['WCR03','WCR04'].includes(error?.code)){res.status(422).json({error:'Work violates the effective capture increment, comment or aggregate limit.',code:'WORK_CAPTURE_POLICY_VIOLATION'});return true;}
  if(!(error instanceof WorkPolicyError))return false;
  res.status(error.statusCode).json({error:error.message,code:error.code});return true;
};
// All mutable work/assignment writers acquire the same commercial lock first.
// Lifecycle/amendment/promotion writers already use it. Worker/project row shares
// and a worker advisory lock remain held until the caller commits or rolls back.
export const lockWorkPolicy=async(client,req,employeeIds=[])=>{
  await lockCommercialLifecycle(client,req.organizationScope);
  for(const id of [...new Set(employeeIds)].filter(Boolean).sort())await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
};
const actorIds=req=>[req.user.employeeRecordId,req.user.employeeId].filter(Boolean);
export const assertWorkActorScope=async(client,req,employeeId,projectId=null,{assignment=false}={})=>{
  const role=req.user.activeRole,ids=actorIds(req);
  if(['Employee','TeamLead'].includes(role)){
    const own=ids.includes(employeeId);
    const report=role==='TeamLead'&&!assignment&&(await client.query(`with recursive reports as (select id from employees where organization_id=$2 and legal_entity_id=$3 and reporting_manager_id=any($4::text[]) union select e.id from employees e join reports r on e.reporting_manager_id=r.id where e.organization_id=$2 and e.legal_entity_id=$3) select 1 from reports where id=$1`,[employeeId,...scope(req),ids])).rowCount;
    if(!own&&!report)fail('WORK_SCOPE_DENIED','The worker is outside active-role data scope.',403);
  }
  if(role==='CountryDirector'&&!(await client.query(`select 1 from employees e where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3
    and (e.primary_country_director_id=$4 or exists(select 1 from employee_country_director_map m where m.employee_id=e.id and m.country_director_id=$4))`,[employeeId,...scope(req),req.user.countryDirectorId||req.user.cdId])).rowCount)
    fail('WORK_SCOPE_DENIED','The worker is outside active-role data scope.',403);
  if(role==='ProjectManager'&&!assignment&&!projectId&&!ids.includes(employeeId)&&!(await client.query(`select 1 from project_allocations a join projects p on p.id=a.project_id and p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id where a.employee_id=$1 and a.organization_id=$2 and a.legal_entity_id=$3 and p.manager_id=any($4::text[]) limit 1`,[employeeId,...scope(req),ids])).rowCount)fail('WORK_SCOPE_DENIED','The worker is outside active-role data scope.',403);
  if(role==='ProjectManager'&&projectId&&!(await client.query('select 1 from projects where id=$1 and organization_id=$2 and legal_entity_id=$3 and manager_id=any($4::text[])',[projectId,...scope(req),ids])).rowCount)
    fail('WORK_SCOPE_DENIED','The project is outside active-role data scope.',403);
};
const loadWorker=async(client,req,id)=>{
  const worker=(await client.query('select id,status,joining_date::text,exit_date::text from employees where id=$1 and organization_id=$2 and legal_entity_id=$3 for share',[id,...scope(req)])).rows[0];
  if(!worker)fail('WORK_WORKER_UNAVAILABLE','A worker in the authorized scope is required.');
  const history=(await client.query('select status,effective_from::text,effective_to::text from worker_history where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 order by effective_from',[id,...scope(req)])).rows;
  return {worker,history};
};
const assertWorkerDate=({worker,history},at)=>{
  if((worker.joining_date&&at<worker.joining_date)||(worker.exit_date&&at>worker.exit_date))fail('WORK_WORKER_DATES','Work and assignment dates must fit the worker timeline.');
  const state=history.length?history.find(x=>x.effective_from<=at&&(!x.effective_to||x.effective_to>=at))?.status:worker.status;
  if(!['Active','On Leave'].includes(state))fail('WORK_WORKER_INACTIVE','The worker lifecycle does not permit this date.');
};
const loadProject=async(client,req,id)=>{
  const project=(await client.query('select id,status,start_date::text,end_date::text,billable,client_id from projects where id=$1 and organization_id=$2 and legal_entity_id=$3 for share',[id,...scope(req)])).rows[0];
  if(!project)fail('WORK_PROJECT_UNAVAILABLE','A project in the authorized scope is required.');
  const binding=(await client.query('select id,project_id,engagement_id,contract_id,contract_version_id,starts_on::text,ends_on::text,billable,model from commercial_project_bindings where project_id=$1 and organization_id=$2 and legal_entity_id=$3',[id,...scope(req)])).rows[0];
  if(!binding)return {project,entities:[],binding:null};
  const engagement=(await client.query('select id,contract_id,contract_version_id,starts_on::text,ends_on::text,billable,model from commercial_engagements where id=$1 and organization_id=$2 and legal_entity_id=$3',[binding.engagement_id,...scope(req)])).rows[0];
  if(!engagement||engagement.contract_id!==binding.contract_id)fail('WORK_PARENT_UNAVAILABLE','The governed project hierarchy is unavailable.');
  const entities=[{type:'Project',id:project.id,root:binding},{type:'Engagement',id:engagement.id,root:engagement}];
  if(binding.contract_id)entities.push({type:'Contract',id:binding.contract_id,root:null});
  for(const entity of entities){
    entity.lifecycle=(await client.query(`select id,sequence,state,effective_on::text,contract_version_id from commercial_lifecycle_events
      where organization_id=$1 and legal_entity_id=$2 and entity_type=$3 and entity_id=$4 order by sequence`,[...scope(req),entity.type,entity.id])).rows;
    entity.amendments=(await client.query(`select id,sequence,effective_on::text,contract_version_id,starts_on::text,ends_on::text from commercial_amendments
      where organization_id=$1 and legal_entity_id=$2 and entity_type=$3 and entity_id=$4 order by sequence`,[...scope(req),entity.type,entity.id])).rows;
    if(entity.type==='Contract'){
      const pin=entity.lifecycle[0]?.contract_version_id;
      entity.root=(await client.query('select id,starts_on::text,ends_on::text,effective_from::text from commercial_contract_versions where id=$1 and contract_id=$2 and organization_id=$3 and legal_entity_id=$4',[pin,entity.id,...scope(req)])).rows[0];
      if(!entity.root)fail('WORK_PARENT_UNAVAILABLE','The governed contract activation is unavailable.');
      entity.root.contract_version_id=pin;
    }
  }
  return {project,binding,entities};
};
const lastAt=(rows,at)=>rows.filter(x=>x.effective_on<=at).at(-1);
// Entity adoption is independent: a parent's later adoption never silently
// changes a child's retained version. Each dated snapshot must cover the date.
export const resolveProjectDate=(loaded,at,{assignment=false}={})=>{
  const {project,binding,entities}=loaded;
  if(!binding){
    if(!(assignment?['Active','Proposed']:['Active','Proposed','On Hold']).includes(project.status))fail('WORK_PROJECT_INACTIVE','The legacy project does not permit this operation.');
    if(at<project.start_date||at>project.end_date)fail('WORK_PROJECT_DATES','Dates must stay within the applicable project timeline.');
    return {kind:'legacy-neutral',projectId:project.id,billable:Boolean(project.billable),references:[]};
  }
  const references=[];
  for(const entity of entities){
    const lifecycle=lastAt(entity.lifecycle,at),amendment=lastAt(entity.amendments,at),terms=amendment||entity.root;
    if(lifecycle?.state!=='Active')fail('WORK_LIFECYCLE_INACTIVE','The governed project and every parent must be active on each relevant date.');
    if(at<terms.starts_on||at>terms.ends_on||(terms.effective_from&&at<terms.effective_from))fail('WORK_TERMS_DATES','Dates must fit each explicitly adopted project, engagement and contract term.');
    references.push({entityType:entity.type,entityId:entity.id,lifecycleEventId:lifecycle.id,amendmentId:amendment?.id||null,contractVersionId:terms.contract_version_id||null});
  }
  if(['internal','pre_sales'].includes(binding.model)&&binding.billable)fail('WORK_INTERNAL_POLICY','Internal and pre-sales work must remain non-billable.');
  return {kind:'governed',projectId:project.id,bindingId:binding.id,billable:Boolean(binding.billable),references};
};
export const policySegmentDates=(startsOn,endsOn,loaded,workerHistory=[])=>{
  const cuts=new Set([startsOn]);
  for(const row of [...loaded.entities.flatMap(x=>[...x.lifecycle,...x.amendments]),...workerHistory]){
    const d=row.effective_on||row.effective_from;
    if(d>startsOn&&d<=endsOn)cuts.add(d);
    if(row.effective_to&&row.effective_to>=startsOn&&row.effective_to<endsOn)cuts.add(shift(row.effective_to,1));
  }
  const sorted=[...cuts].sort();return sorted.flatMap((start,i)=>[start,i+1<sorted.length?shift(sorted[i+1],-1):endsOn]);
};
export const validateAssignmentPolicy=async(client,req,input)=>{
  await lockWorkPolicy(client,req,[input.employee_id]);
  await assertWorkActorScope(client,req,input.employee_id,input.project_id,{assignment:true});
  const worker=await loadWorker(client,req,input.employee_id),loaded=await loadProject(client,req,input.project_id);
  for(const at of policySegmentDates(input.start_date,input.end_date,loaded,worker.history)){
    assertWorkerDate(worker,at);const policy=resolveProjectDate(loaded,at,{assignment:true});
    if(input.billable&&!policy.billable)fail('WORK_BILLABILITY_POLICY','A non-billable project cannot have a billable assignment.');
  }
};
// Demand uses the same project/lifecycle timeline without inventing a worker,
// allocation, commercial treatment, capacity denominator or exception.
export const validateDemandProjectPolicy=async(client,req,projectId,startsOn,endsOn)=>{
  await lockWorkPolicy(client,req);const loaded=await loadProject(client,req,projectId);
  for(const at of policySegmentDates(startsOn,endsOn,loaded))resolveProjectDate(loaded,at,{assignment:true});
};
export const validateWorkEntries=async(client,req,employeeId,entries)=>{
  await lockWorkPolicy(client,req,[employeeId]);
  await assertWorkActorScope(client,req,employeeId);
  const worker=await loadWorker(client,req,employeeId),projects=new Map(),output=[];
  for(const entry of entries){
    await assertWorkActorScope(client,req,employeeId,entry.project_id||null);
    const at=date(entry.work_date);assertWorkerDate(worker,at);
    if(!entry.project_id){
      if(entry.work_type!=='Client Misc Task'||!entry.client_name)fail('WORK_PROJECT_REQUIRED','Project work requires an authorized project.');
      output.push({...entry,policy:{kind:'legacy-neutral',projectId:null,billable:Boolean(entry.billable),references:[]}});continue;
    }
    if(!projects.has(entry.project_id))projects.set(entry.project_id,await loadProject(client,req,entry.project_id));
    const policy=resolveProjectDate(projects.get(entry.project_id),at);
    const assignments=(await client.query(`select id,billable,start_date::text,end_date::text,status,percentage::text,role_on_project,(select v.id from assignment_versions v where v.assignment_id=project_allocations.id and v.organization_id=project_allocations.organization_id and v.legal_entity_id=project_allocations.legal_entity_id order by sequence desc limit 1) assignment_version_id from project_allocations where employee_id=$1 and project_id=$2 and organization_id=$3 and legal_entity_id=$4
      and status='Active' and $5::date between start_date and end_date order by id for share`,[employeeId,entry.project_id,...scope(req),at])).rows;
    if(!assignments.length)fail('WORK_ASSIGNMENT_REQUIRED','Project work requires an active assignment covering the work date.');
    const billable=Boolean(entry.billable)&&policy.billable&&assignments.some(x=>x.billable);
    output.push({...entry,billable,policy:{...policy,billable,assignmentIds:assignments.map(x=>x.id),assignmentSnapshots:assignments.map(x=>({id:x.id,...(x.assignment_version_id?{assignmentVersionId:x.assignment_version_id}:{}),workerId:employeeId,projectId:entry.project_id,startsOn:x.start_date,endsOn:x.end_date,status:x.status,billable:x.billable,percentage:x.percentage,roleOnProject:x.role_on_project||null}))}});
  }
  return output;
};
export const assertTimesheetEditable=previous=>{
  if(previous&&!['Draft','Rejected'].includes(previous.status))fail('WORK_HISTORY_IMMUTABLE','Only Draft or Rejected work can be replaced. Submitted and Approved evidence must not be overwritten.',409);
};
export const validateImportWorkStatus=status=>{
  if(!['Draft','Submitted'].includes(status))fail('WORK_IMPORT_DECISION_REQUIRED','Import work as Draft or Submitted. Approval and rejection require the scoped approval workflow.');
};
export const retainWorkSubmission=async(client,req,timesheet,entries,source)=>{
  const sequence=Number((await client.query('select coalesce(max(sequence),0)+1 sequence from work_submission_evidence where organization_id=$1 and legal_entity_id=$2 and timesheet_id=$3',[...scope(req),timesheet.id])).rows[0].sequence);
  const id=`work-submission-${randomUUID()}`;
  const periods=await assertReportingPeriodAllows(client,{organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,relevantDates:[timesheet.week_ending,...entries.map(entry=>entry.work_date)],operation:REPORTING_PERIOD_OPERATIONS.CONTENT});
  const periodReferences=[...new Map(periods.map(p=>[p.id,{id:p.id,frequency:p.frequency,status:p.status}])).values()];
  const submissionTiming=await readSubmissionTiming(client,req,[timesheet.week_ending,...entries.map(entry=>entry.work_date)]);assertSubmissionTiming(submissionTiming);
  const duplicateEntryCheck=checkDuplicateEntries(entries);
  const evidence=entries.map(entry=>({entryId:entry.id,projectId:entry.project_id||null,workType:entry.work_type,workDate:date(entry.work_date),hours:String(entry.hours),billable:entry.billable,
    clientName:entry.client_name||null,category:entry.category||null,remark:entry.remark||null,evidenceUrl:entry.evidence_url||null,workReference:entry.work_reference||null,sourceIdentity:entry.source_identity||null,kind:entry.policy.kind,bindingId:entry.policy.bindingId||null,assignmentIds:entry.policy.assignmentIds||[],assignmentSnapshots:entry.policy.assignmentSnapshots||[],references:entry.policy.references}));
  await client.query(`insert into work_submission_evidence(id,organization_id,legal_entity_id,timesheet_id,sequence,policy_version,entries,period_references,actor_id,active_role,source,correlation_id,operation_id,capture_policy_references,duplicate_entry_check,submission_timing)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb)`,[id,...scope(req),timesheet.id,sequence,WORK_POLICY_VERSION,JSON.stringify(evidence),JSON.stringify(periodReferences),req.user.sub,req.user.activeRole,source,req.correlationId,req.operationId,JSON.stringify(entries.map(entry=>({entryId:entry.id,reference:entry.capturePolicyReference||null}))),duplicateEntryCheck===null?null:JSON.stringify(duplicateEntryCheck),JSON.stringify(submissionTiming)]);
  return {id,sequence,policyVersion:WORK_POLICY_VERSION,entryCount:evidence.length,governedEntryCount:evidence.filter(x=>x.kind==='governed').length,duplicateCheck:duplicateCheckSummary(duplicateEntryCheck),submissionTiming};
};
// Decision-time period checks cover every stored work date, not just week end.
// New submissions are evaluated against their immutable evidence, not today's
// assignment or commercial policy. Legacy submissions remain explicitly unpinned.
export const assertWorkDecisionAllowed=async(client,req,timesheet)=>{
  const entries=(await client.query('select *,work_date::text from timesheet_entries where timesheet_id=$1 order by id',[timesheet.id])).rows;
  await assertReportingPeriodAllows(client,{organizationId:timesheet.organization_id,legalEntityId:timesheet.legal_entity_id,
    relevantDates:[timesheet.week_ending,...entries.map(x=>x.work_date)],operation:REPORTING_PERIOD_OPERATIONS.DECISION});
  if(actorIds(req).includes(timesheet.employee_id))fail('WORK_SELF_APPROVAL_DENIED','Users cannot decide their own submitted work.',403);
  // The source transition already resolved direct or delegated approval scope.
  // Do not narrow delegation to the work-entry editor's reporting hierarchy.
  const retained=(await client.query('select entries from work_submission_evidence where organization_id=$1 and legal_entity_id=$2 and timesheet_id=$3 order by sequence desc limit 1',[...scope(req),timesheet.id])).rows[0];
  if(retained){
    const expected=entries.map(x=>({entryId:x.id,projectId:x.project_id||null,workType:x.work_type,workDate:x.work_date,hours:String(x.hours),billable:x.billable,clientName:x.client_name||null,category:x.category||null,remark:x.remark||null,evidenceUrl:x.evidence_url||null,workReference:x.work_reference||null,sourceIdentity:x.source_identity||null}));
    if(retained.entries.length!==expected.length||expected.some(x=>!retained.entries.some(y=>Object.entries(x).every(([key,value])=>key==='sourceIdentity'?workSourceIdentityKey(y[key])===workSourceIdentityKey(value):(['evidenceUrl','workReference'].includes(key)?(y[key]??null):y[key])===value))))fail('WORK_SUBMISSION_CHANGED','Submitted work no longer matches its retained evidence.',409);
  }
};

export const retainWorkDecision=async(client,req,timesheet,status,reason,source)=>{
  const submission=(await client.query('select id from work_submission_evidence where organization_id=$1 and legal_entity_id=$2 and timesheet_id=$3 order by sequence desc limit 1',[...scope(req),timesheet.id])).rows[0];
  if(!submission)return; // Existing legacy work never gains an inferred pin.
  await client.query(`insert into work_submission_decisions(id,submission_id,status,reason,actor_id,active_role,source,correlation_id,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[`work-decision-${randomUUID()}`,submission.id,status,reason||null,req.user.sub,req.user.activeRole,source,req.correlationId,req.operationId]);
};
