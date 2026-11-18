import assert from 'node:assert/strict';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday,addUtcDays,grantAmendmentPermissions,createAmendmentHierarchy,amendmentTransition,seedApplicableAmendmentVersion,amendmentWorkspace,amendmentInput,amendmentApply} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions,seedWorkPeriods,workAllocation,workInput,workSnapshot,workPost,workImport,workImportRow} from './support/work-assignment-test.mjs';
const migration='044_wos04_work_submission_evidence';
const quiet={log(){}};
// Mandatory real PostgreSQL/HTTP tests: no fallback, no skipped missing service.
await withCommercialDatabase(async({pool})=>{
  await withPreCommercialMigrations(async rootDir=>{
    for(const file of ['040_wos04_commercial_drafting_foundation.sql','041_wos04_governed_lifecycle.sql','042_wos04_scoped_client_profiles.sql','043_wos04_governed_amendments.sql'])await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
    await runMigrations({pool,rootDir,logger:quiet});await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
    const before=await workSnapshotBefore044(pool),grants=await permissionSnapshot(pool);
    for(const row of before.timesheet_entries){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;} // additive 047/048 column
    const installed=await migrateCommercialDatabase(pool);assert.deepEqual(installed.applied,[migration,'045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence']);assert.equal(installed.status.isCurrent,true);
    assert.deepEqual(await workSnapshotBefore044(pool),before,'043 upgrade preserves every legacy ID and byte of accepted work');
    assert.equal((await pool.query('select count(*)::int n from work_submission_evidence')).rows[0].n,0,'no historical pins are inferred');
    assert.equal((await pool.query('select count(*)::int n from work_submission_decisions')).rows[0].n,0);
    assert.deepEqual(await permissionSnapshot(pool),grants,'migration adds no grants or permissions');
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);assert.deepEqual(await workSnapshotBefore044(pool),before);
  });
});
await withCommercialDatabase(async({pool,databaseUrl})=>{
  const installed=await migrateCommercialDatabase(pool);assert(installed.applied.includes(migration));assert.equal(installed.status.isCurrent,true);
  await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);
  await grantAmendmentPermissions(pool);await grantWorkPermissions(pool);const today=await amendmentToday(pool);await seedWorkPeriods(pool,today);
  const legacyBefore=(await pool.query('select to_jsonb(t) row from timesheet_entries t where id=$1',[f.workId])).rows;
  await withCommercialApi({databaseUrl,identities,timeZone:'America/Los_Angeles'},async({request})=>{
    const roots=await createAmendmentHierarchy(request,'SYN-WORK-POLICY');
    // Scoped aliases, exact date, parent activation and date policy are real API paths.
    const allocation=await workPost(request,'/api/allocations',workAllocation(roots.project.id,today));
    const listedAllocations=await request('/api/allocations');assert.equal(listedAllocations.status,200,JSON.stringify(listedAllocations.body));
    assert.deepEqual(listedAllocations.body.find(x=>x.id===allocation.id),allocation,'canonical allocation list preserves the saved date-only payload');
    const denied=await request('/api/allocations',{method:'POST',identity:identities.reader,body:workAllocation(roots.project.id,today)});assert.equal(denied.status,403);
    const cross=await request('/api/allocations',{method:'POST',body:workAllocation(roots.project.id,today,{employee_id:f.otherOwnerId})});assert.equal(cross.status,422);
    const beforeForeign=await workSnapshot(pool);assert.equal((await request('/api/timesheets',{method:'POST',body:workInput(roots.project.id,today,{employee_id:f.otherOwnerId})})).status,422);assert.deepEqual(await workSnapshot(pool),beforeForeign);
    // A concurrent missing header gets one immutable submission, never replacement.
    const race=await Promise.all([request('/api/timesheets',{method:'POST',body:workInput(roots.project.id,today)}),request('/api/timesheets',{method:'POST',body:workInput(roots.project.id,today)})]);
    assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);const submitted=race.find(x=>x.status===200).body;assert.equal(submitted.work_assurance.governedEntryCount,1);
    const evidence=(await pool.query('select * from work_submission_evidence where timesheet_id=$1',[submitted.id])).rows[0];assert.equal(evidence.sequence,1);assert.equal(evidence.entries[0].references.length,3);assert.equal(evidence.entries[0].references[0].contractVersionId,roots.pin);assert.equal(evidence.entries[0].remark,'Synthetic submitted work note');
    const broad=await request('/api/timesheets');assert.equal(broad.status,200);assert.equal(broad.body.find(x=>x.id===submitted.id).work_assurance.entryCount,1);assert.doesNotMatch(JSON.stringify(broad.body),/billing metadata|billing_terms|budget_allocation|commercial_amendments|contractVersionId/);
    for(const sql of ['update work_submission_evidence set sequence=2 where id=$1','delete from work_submission_evidence where id=$1'])await assert.rejects(pool.query(sql,[evidence.id]),error=>Boolean(error.code));
    await assert.rejects(pool.query("update timesheet_entries set hours=9 where timesheet_id=$1",[submitted.id]),{code:'WWP01'});
    await assert.rejects(pool.query("update timesheets set status='Draft' where id=$1",[submitted.id]),{code:'WWP01'});
    const imported=async(row,overrides={},key=randomUUID(),versioned=true)=>request(versioned?'/api/v1/imports/timesheets/apply':'/api/imports/timesheets/apply',{
      method:'POST',body:versioned?workImport(row,overrides):{fileName:'synthetic-legacy-work.csv',rows:[row],...overrides},headers:versioned?{'Idempotency-Key':key}:{}});
    // Different keys and compatibility imports cannot replace accepted work,
    // even when incoming rows remove every governed project reference.
    const replacement=workImportRow(null,today,{workType:'Client Misc Task',clientName:'Synthetic replacement',status:'Draft'});
    const prior=await workSnapshot(pool);
    for(const versioned of [true,false]){
      const rejected=await imported(replacement,{},randomUUID(),versioned);assert.equal(rejected.status,200);assert.equal(rejected.body.status,'Failed');assert.equal(rejected.body.errors[0].code,'WORK_HISTORY_IMMUTABLE');
    }
    assert.deepEqual(await workSnapshot(pool),prior);
    const forgedDecision=await imported(workImportRow(roots.project.id,addUtcDays(today,-7),{status:'Approved'}));
    assert.equal(forgedDecision.body.status,'Failed');assert.equal(forgedDecision.body.errors[0].code,'WORK_IMPORT_DECISION_REQUIRED');
    // Source-specific permission is required even through the generic inbox.
    const approval=(await pool.query("select id from approval_records where entity_type='Timesheet' and entity_id=$1",[submitted.id])).rows[0];assert(approval);
    await pool.query("insert into roles(name) values('HR') on conflict(name) do nothing");
    await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='HR'",[identities.denied.id]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR','approvals.view',true) on conflict(role_name,permission_key) do update set enabled=true");
    const hr={...identities.denied,role:'HR'};
    const deniedDecision=await request(`/api/approvals/${approval.id}/status`,{method:'PATCH',identity:hr,body:{status:'Approved'}});assert.equal(deniedDecision.status,403);
    assert.deepEqual(await workSnapshot(pool),prior);
    // Rejection/correction preserves the complete original submission and decision.
    assert.equal((await request(`/api/timesheets/${submitted.id}/status`,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic correction requested'}})).status,200);
    const corrected=await workPost(request,'/api/timesheets',workInput(roots.project.id,today,{entries:[{...workInput(roots.project.id,today).entries[0],hours:3,remark:'Synthetic corrected work note'}]}));
    assert.equal(corrected.id,submitted.id);assert.equal(corrected.work_assurance.sequence,2);
    const retained=(await pool.query('select sequence,entries from work_submission_evidence where timesheet_id=$1 order by sequence',[submitted.id])).rows;
    assert.equal(retained[0].entries[0].remark,'Synthetic submitted work note');assert.equal(retained[1].entries[0].remark,'Synthetic corrected work note');
    assert.equal((await pool.query('select count(*)::int n from work_submission_decisions')).rows[0].n,1);
    assert.equal((await request(`/api/approvals/${approval.id}/status`,{method:'PATCH',body:{status:'Approved',comments:'Synthetic approval'}})).status,200);
    const decisions=(await pool.query('select d.status,e.sequence from work_submission_decisions d join work_submission_evidence e on e.id=d.submission_id order by e.sequence')).rows;
    assert.deepEqual(decisions,[{status:'Rejected',sequence:1},{status:'Approved',sequence:2}]);
    const acceptedBefore=(await pool.query('select entries from work_submission_evidence where timesheet_id=$1 order by sequence',[submitted.id])).rows;
    // Independent parent adoption changes future assignment authority, not work.
    const v2=await seedApplicableAmendmentVersion(pool,identities.manager,roots.contract,today);
    for(const [type,id] of [['Contract',roots.contract.id],['Engagement',roots.engagement.id],['Project',roots.project.id]]){
      const workspace=await amendmentWorkspace(request,type,id);await amendmentApply(request,type,id,amendmentInput(workspace,v2));
    }
    const extended=await workPost(request,'/api/allocations',workAllocation(roots.project.id,'2099-01-01',{end_date:'2099-01-02',percentage:10}));assert.equal(String(extended.end_date).slice(0,10),'2099-01-02');
    const beyond=await request('/api/allocations',{method:'POST',body:workAllocation(roots.project.id,'2100-01-01')});assert.equal(beyond.status,422);
    assert.deepEqual((await pool.query('select entries from work_submission_evidence where timesheet_id=$1 order by sequence',[submitted.id])).rows,acceptedBefore);
    // Lifecycle hold is effective authority for all writer paths, not just a UI filter.
    await amendmentTransition(request,'Project',roots.project.id,1,roots.pin,'On Hold');
    const held=await request('/api/allocations',{method:'POST',body:workAllocation(roots.project.id,today)});assert.equal(held.status,422);assert.equal(held.body.code,'WORK_LIFECYCLE_INACTIVE');
    const heldImport=await request('/api/v1/imports/allocations/apply',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:{fileName:'synthetic-held.csv',schemaVersion:'allocation-control/1',dryRun:true,rows:[{employeeId:f.ownerId,projectId:roots.project.id,startDate:today,endDate:today,percentage:1,billable:true}]}});
    assert.equal(heldImport.status,200);assert.equal(heldImport.body.validRows,0);assert(heldImport.body.errors.some(x=>x.code==='WORK_LIFECYCLE_INACTIVE'));
    // Ending remains possible, preserves the valid future interval, and never
    // alters any retained work/terms; it does not grant a policy exception.
    const ended=await request(`/api/allocations/${extended.id}`,{method:'DELETE'});assert.equal(ended.status,200);assert.equal(String(ended.body.end_date).slice(0,10),'2099-01-01');
    await amendmentTransition(request,'Project',roots.project.id,2,roots.pin,'Active');
    const worker='worker-synthetic-work-import';await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'SYN-WORK-IMPORT','Synthetic imported worker','work-import@example.test','Analyst','Delivery','US','director-commercial','Active',$2,$3)`,[worker,f.organizationId,f.legalEntityId]);
    await workPost(request,'/api/allocations',workAllocation(roots.project.id,today,{employee_id:worker}));
    // Same-key import concurrency replays exactly one immutable evidence record.
    const row=workImportRow(roots.project.id,today,{employeeId:worker});const key=randomUUID();
    const replay=await Promise.all([imported(row,{},key),imported(row,{},key)]);assert(replay.every(x=>x.status===200));assert.equal(replay[0].body.log.id,replay[1].body.log.id);assert.equal(replay[0].body.status,'Success');
    assert.equal((await pool.query('select count(*)::int n from work_submission_evidence w join timesheets t on t.id=w.timesheet_id where t.employee_id=$1',[worker])).rows[0].n,1);
    // A locked constituent date is not bypassed by an open week-ending date.
    const importedHeader=(await pool.query('select id from timesheets where employee_id=$1',[worker])).rows[0];
    await pool.query("insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency) values('period-work-lock',$1,$2,'SYN-WORK-LOCK','Synthetic monthly lock',$3,$3,'Financially Locked','Monthly')",[f.organizationId,f.legalEntityId,today]);
    const blocked=await request(`/api/timesheets/${importedHeader.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(blocked.status,409);assert.equal(blocked.body.code,'REPORTING_PERIOD_CLOSED');
    const linked=(await pool.query("select id from approval_records where entity_type='Timesheet' and entity_id=$1",[importedHeader.id])).rows[0];
    const blockedGeneric=await request(`/api/approvals/${linked.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(blockedGeneric.status,409);
    await pool.query("delete from reporting_periods where id='period-work-lock'");
    // Normal internal/pre-sales work has explicit non-billable authority and no
    // invented contract, rate, value or historical commercial pin.
    const internal=await workPost(request,'/engagements',{code:'SYN-WORK-INTERNAL',name:'Synthetic internal initiative',model:'internal',ownerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',currency:'GBP',budget:'0',clientId:null,contractId:null,contractVersionId:null,attributionId:f.businessUnitId,reason:'Synthetic internal planning'},201);
    await amendmentTransition(request,'Engagement',internal.id,0,null);
    const project=await workPost(request,'/lifecycle/projects',{engagementId:internal.id,projectId:null,code:'SYN-WORK-INTERNAL-P',name:'Synthetic internal project',managerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',billable:false,budgetAllocation:'0',reason:'Synthetic internal project'},201);
    const badInternal=await request('/api/allocations',{method:'POST',body:workAllocation(project.id,today)});assert.equal(badInternal.status,422);assert.equal(badInternal.body.code,'WORK_BILLABILITY_POLICY');
    await workPost(request,'/api/allocations',workAllocation(project.id,today,{billable:false}));
    const internalWorker='worker-synthetic-internal';await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'SYN-WORK-INTERNAL','Synthetic internal worker','work-internal@example.test','Analyst','Delivery','US','director-commercial','Active',$2,$3)`,[internalWorker,f.organizationId,f.legalEntityId]);
    await workPost(request,'/api/allocations',workAllocation(project.id,today,{employee_id:internalWorker,billable:false}));
    const internalSubmitted=await workPost(request,'/api/timesheets',workInput(project.id,today,{employee_id:internalWorker}));
    assert.equal(Number(internalSubmitted.billable_hours),0);assert.equal(internalSubmitted.entries[0].billable,false);
    const internalEvidence=(await pool.query('select entries from work_submission_evidence where timesheet_id=$1',[internalSubmitted.id])).rows[0].entries[0];
    assert.equal(internalEvidence.references.length,2);assert(internalEvidence.references.every(x=>x.contractVersionId===null));
    const oversized=await imported(workImportRow(null,addUtcDays(today,-7),{employeeId:internalWorker,workType:'Client Misc Task',clientName:'Synthetic item 0'}),{dryRun:true,rows:Array.from({length:101},(_,i)=>workImportRow(null,addUtcDays(today,-7),{employeeId:internalWorker,workType:'Client Misc Task',clientName:`Synthetic item ${i}`}))});
    assert.equal(oversized.status,200);assert.equal(oversized.body.validRows,0);assert(oversized.body.errors.every(x=>x.code==='WORK_ENTRY_LIMIT'));
    // Activation occurs today, so yesterday's internal work may not be invented.
    const historical=await request('/api/timesheets',{method:'POST',body:workInput(project.id,addUtcDays(today,-7))});assert.equal(historical.status,422);
    assert.deepEqual((await pool.query('select to_jsonb(t) row from timesheet_entries t where id=$1',[f.workId])).rows,legacyBefore);

  });
});
// Positive-offset driver regression: a locked prior day must never be
// accidentally substituted for a validated current-day period end.
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);const identities=await seedCommercialIdentities(pool);
  await grantAmendmentPermissions(pool);await grantWorkPermissions(pool);const today=await amendmentToday(pool);await seedWorkPeriods(pool,today);
  await pool.query("insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency) values('period-positive-offset-previous',$1,$2,'SYN-POSITIVE-PREVIOUS','Synthetic previous-date lock',$3::date-1,$3::date-1,'Financially Locked','Monthly')",[f.organizationId,f.legalEntityId,today]);
  await withCommercialApi({databaseUrl,identities,timeZone:'Asia/Kolkata'},async({request})=>{
    const roots=await createAmendmentHierarchy(request,'SYN-WORK-POSITIVE-OFFSET');
    const allocation=await workPost(request,'/api/allocations',workAllocation(roots.project.id,today));assert.equal(allocation.start_date,today);assert.equal(allocation.end_date,today);
    const listedAllocations=await request('/api/allocations');assert.equal(listedAllocations.status,200,JSON.stringify(listedAllocations.body));assert.equal(listedAllocations.body.find(x=>x.id===allocation.id).start_date,today);assert.equal(listedAllocations.body.find(x=>x.id===allocation.id).end_date,today);
    const submitted=await workPost(request,'/api/timesheets',workInput(roots.project.id,today));assert.equal(submitted.week_ending,today);
    const listed=await request('/api/timesheets');assert.equal(listed.status,200);assert.equal(listed.body.find(x=>x.id===submitted.id).week_ending,today);
    const direct=await request(`/api/timesheets/${submitted.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(direct.status,200,JSON.stringify(direct.body));
    const worker='worker-positive-offset-import';await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'SYN-POSITIVE-WORK','Synthetic positive-offset worker','positive-offset@example.test','Analyst','Delivery','US','director-commercial','Active',$2,$3)`,[worker,f.organizationId,f.legalEntityId]);
    await workPost(request,'/api/allocations',workAllocation(roots.project.id,today,{employee_id:worker}));
    const imported=await request('/api/v1/imports/timesheets/apply',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:workImport(workImportRow(roots.project.id,today,{employeeId:worker}))});assert.equal(imported.status,200);assert.equal(imported.body.status,'Success',JSON.stringify(imported.body));
    const header=(await pool.query('select id from timesheets where employee_id=$1',[worker])).rows[0];const approval=(await pool.query("select id from approval_records where entity_type='Timesheet' and entity_id=$1",[header.id])).rows[0];
    const generic=await request(`/api/approvals/${approval.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(generic.status,200,JSON.stringify(generic.body));
    const evidence=(await pool.query('select period_references from work_submission_evidence')).rows;assert.equal(evidence.length,2);assert(evidence.every(row=>row.period_references.every(p=>p.id==='period-work-current')));
    // An open period end cannot bypass a locked earlier constituent work date.
    const legacyProject='project-constituent-date';await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,project_type,billable,start_date,end_date,status,country,organization_id,legal_entity_id) values($1,'SYN-CONSTITUENT-DATE','Synthetic constituent-date project',$2,'Synthetic client',$3,'Synthetic owner','Synthetic legacy',false,'2020-01-01','2098-12-31','Active','US',$4,$5)`,[legacyProject,f.clientId,f.ownerId,f.organizationId,f.legalEntityId]);
    const earlier=addUtcDays(today,-2);await workPost(request,'/api/allocations',workAllocation(legacyProject,earlier,{employee_id:worker,billable:false,end_date:today}));
    const otherWorker='worker-constituent-date';await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'SYN-CONSTITUENT-DATE','Synthetic constituent-date worker','constituent-date@example.test','Analyst','Delivery','US','director-commercial','Active',$2,$3)`,[otherWorker,f.organizationId,f.legalEntityId]);
    await workPost(request,'/api/allocations',workAllocation(legacyProject,earlier,{employee_id:otherWorker,billable:false,end_date:today}));
    const earlierWork=await workPost(request,'/api/timesheets',workInput(legacyProject,today,{employee_id:otherWorker,entries:[{...workInput(legacyProject,today).entries[0],work_date:earlier,billable:false}]}));
    await pool.query("insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency) values('period-work-constituent-lock',$1,$2,'SYN-WORK-CONSTITUENT-LOCK','Synthetic constituent-date lock',$3,$3,'Financially Locked','Monthly')",[f.organizationId,f.legalEntityId,earlier]);
    for(const path of [`/api/timesheets/${earlierWork.id}/status`,`/api/approvals/${(await pool.query("select id from approval_records where entity_type='Timesheet' and entity_id=$1",[earlierWork.id])).rows[0].id}/status`]){
      const blocked=await request(path,{method:'PATCH',body:{status:'Approved'}});assert.equal(blocked.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.code,'REPORTING_PERIOD_CLOSED');
    }

  });
});
async function permissionSnapshot(pool){return (await pool.query("select jsonb_build_object('definitions',(select jsonb_agg(to_jsonb(t) order by permission_key) from permission_definitions t),'roles',(select jsonb_agg(to_jsonb(t) order by role_name,permission_key) from role_permissions t),'users',(select jsonb_agg(to_jsonb(t) order by user_id,permission_key) from user_permission_grants t)) value")).rows;}
async function workSnapshotBefore044(pool){const result={};for(const table of ['timesheets','timesheet_entries','project_allocations','approval_records'])result[table]=(await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;return result;}
console.log('Work assignment real PostgreSQL migration and HTTP acceptance passed.');
