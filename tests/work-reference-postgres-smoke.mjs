import assert from 'node:assert/strict';
import {copyFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,
 seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions,workSnapshot,seedWorkPeriods} from './support/work-assignment-test.mjs';
const migration='048_wos04_work_entry_reference',reference='TASK-42 · Discovery',nextReference='TICKET-43';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await withPreCommercialMigrations(async rootDir=>{
  for(const file of (await readdir(join(commercialServerDir,'migrations'))).filter(file=>/^04[0-7]_/.test(file)))await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
  await runMigrations({pool,rootDir,logger:{log(){}}});await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);
  await pool.query('update timesheet_entries set evidence_url=$2 where timesheet_id=$1',[f.timesheetId,'https://example.test/preserved-pre048']);
  await pool.query("update timesheets set status='Submitted' where id=$1",[f.timesheetId]);
  await pool.query(`insert into work_submission_evidence(id,organization_id,legal_entity_id,timesheet_id,sequence,policy_version,entries,period_references,actor_id,active_role,source,correlation_id,operation_id)
   select 'synthetic-pre048-submission',$1,$2,$3,1,'assignment-work-date/1',jsonb_build_array(jsonb_build_object(
    'entryId',e.id,'projectId',e.project_id,'workType',e.work_type,'workDate',e.work_date::text,'hours',e.hours::text,'billable',e.billable,'clientName',e.client_name,'category',e.category,'remark',e.remark,'evidenceUrl',e.evidence_url)),
    '[]'::jsonb,$4,'Admin','Web','synthetic-pre048-correlation','synthetic-pre048-operation' from timesheet_entries e where e.timesheet_id=$3`,[f.organizationId,f.legalEntityId,f.timesheetId,identities.manager.id]);
  const oldHistory=(await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows;
  for(const row of oldHistory){row.value.duplicate_entry_check=null;row.value.submission_timing=null;} // additive 050; no historical diagnostic is inferred
  assert.equal(Object.hasOwn(oldHistory[0].value.entries[0],'workReference'),false);

  const before=(await pool.query('select to_jsonb(e) value from timesheet_entries e order by id')).rows;
  const grants=(await pool.query('select to_jsonb(r) value from role_permissions r order by to_jsonb(r)::text')).rows;
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[migration,'049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','057_wos04_assignment_versions','058_wos04_assignment_overlap_policy','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','066_wos05_assignment_creation_approvals','067_wos05_approval_due_notices','068_wos05_canonical_leave_approvals', '069_wos05_canonical_delegation','070_wos05_approval_reminders','071_wos02_governed_calendar_authoring','072_wos02_country_group_calendar_authoring','073_wos02_business_structure_authoring','074_wos02_workforce_classification','075_wos02_worker_type','076_wos06_rate_cost_candidates','077_wos06_candidate_owners','078_wos06_commercial_candidate_approvals','079_wos06_approved_rate_adoptions','080_wos06_governed_tm_valuation','081_wos06_tm_billing_eligibility']);
  assert.deepEqual((await pool.query("select to_jsonb(e)-array['work_reference','source_identity','category_code','category_reference'] value from timesheet_entries e order by id")).rows,before);
  assert.equal((await pool.query('select count(*)::int n from timesheet_entries where work_reference is not null')).rows[0].n,0);
  assert.deepEqual((await pool.query('select to_jsonb(r) value from role_permissions r order by to_jsonb(r)::text')).rows,grants);
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows,oldHistory,'upgrade and replay leave pre048 immutable JSON byte-equivalent');
  await grantWorkPermissions(pool);
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
   values('evidence-legacy-first',$1,$2,'SYN-EVIDENCE-LEGACY-1','Synthetic legacy first','2020-03-08','2020-03-14','Open','Weekly'),
   ('evidence-legacy-second',$1,$2,'SYN-EVIDENCE-LEGACY-2','Synthetic legacy second','2020-03-15','2020-03-21','Open','Weekly')`,[f.organizationId,f.legalEntityId]);
  await withCommercialApi({databaseUrl,identities},async({request})=>{
   const approved=await request(`/api/timesheets/${f.timesheetId}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(approved.status,200,JSON.stringify(approved.body));
   assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows,oldHistory,'ordinary approval accepts old missing/null reference without rewriting its snapshot');
  });

 });
});
await withCommercialDatabase(async({pool,databaseUrl})=>{
 assert((await migrateCommercialDatabase(pool)).applied.includes(migration));
 await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
 const today=await amendmentToday(pool);await seedWorkPeriods(pool,today);
 const worker=async()=>{const id=`worker-reference-${randomUUID()}`;await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
  values($1,$1,'Synthetic reference worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)`,[id,`${id}@example.test`,f.organizationId,f.legalEntityId]);return id;};
 const entry={evidence_url:'https://example.test/preserved-evidence',work_type:'Client Misc Task',client_name:'Synthetic reference context',category:'Synthetic reference category',work_date:today,hours:'0.25',remark:'Synthetic reference comment',billable:false,work_reference:reference};
 const input=(employeeId,entries=[entry])=>({employee_id:employeeId,week_ending:today,status:'Draft',entries});
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  const post=body=>request('/api/timesheets',{method:'POST',body});
  const id=await worker();let saved=await post(input(id));assert.equal(saved.status,200,JSON.stringify(saved.body));
  const read=async()=>(await request('/api/timesheets')).body.find(row=>row.id===saved.body.id);
  let raw=await read();assert.equal(raw.entries[0].work_reference,reference);assert.equal(raw.entries[0].evidence_url,entry.evidence_url);
  const audit=(await pool.query("select new_value from audit_logs where module='Timesheets' and entity_id=$1 order by created_at desc limit 1",[saved.body.id])).rows[0];assert.equal(audit.new_value.entryEvidence[0].work_reference,reference);
  const {work_reference:_omitted,...legacyEntry}=entry;
  saved=await post({...input(id,[{...legacyEntry,hours:'0.5'}]),expected_write_token:saved.body.write_token});assert.equal(saved.status,200);assert.equal((await read()).entries[0].work_reference,reference,'legacy omission preserves the matching reference');
  const before=await workSnapshot(pool);
  const ambiguous=await post(input(id,[{...legacyEntry,category:'Changed context'}]));assert.equal(ambiguous.status,409);assert.equal(ambiguous.body.code,'WORK_REFERENCE_REPLACEMENT_CONFLICT');assert.deepEqual(await workSnapshot(pool),before);
  // Reference-only SQL change is part of the complete physical write revision.
  const oldToken=saved.body.write_token;await pool.query('update timesheet_entries set work_reference=$2 where timesheet_id=$1',[saved.body.id,nextReference]);
  const afterEvidence=await workSnapshot(pool);assert.notEqual((await read()).write_token,oldToken);
  const stale=await post({...input(id),expected_write_token:oldToken});assert.equal(stale.status,409);assert.equal(stale.body.code,'WORK_CAPTURE_WRITE_CONFLICT');assert.deepEqual(await workSnapshot(pool),afterEvidence);
  saved=await post({...input(id,[{...entry,work_reference:null}]),expected_write_token:(await read()).write_token});assert.equal(saved.status,200);assert.equal((await read()).entries[0].work_reference,null);assert.equal((await read()).entries[0].evidence_url,entry.evidence_url);
  saved=await post(input(id,[{...entry,work_reference:''}]));assert.equal(saved.status,200);assert.equal((await read()).entries[0].work_reference,null);assert.equal((await read()).entries[0].evidence_url,entry.evidence_url);
  const {evidence_url:_url,...referenceOnlyEntry}=entry;
  saved=await post(input(id,[referenceOnlyEntry]));assert.equal(saved.status,200);assert.equal((await read()).entries[0].evidence_url,entry.evidence_url,'reference-only callers preserve omitted evidence URLs');
  const unicode='😀'.repeat(200);saved=await post(input(id,[{...entry,work_reference:unicode}]));assert.equal(saved.status,200);assert.equal((await read()).entries[0].work_reference,unicode);
  for(const work_reference of ['line1\nline2','\tTASK-42','x'.repeat(201),'\ud800']){
   const snapshot=await workSnapshot(pool);assert.equal((await post(input(id,[{...entry,work_reference}]))).status,400);assert.deepEqual(await workSnapshot(pool),snapshot);
  }
  await assert.rejects(pool.query('update timesheet_entries set work_reference=$2 where timesheet_id=$1',[saved.body.id,'x'.repeat(201)]),error=>error.code==='23514');
  const scopeBefore=await workSnapshot(pool);assert.equal((await request('/api/timesheets',{method:'POST',scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},body:input(id)})).status,403);assert.deepEqual(await workSnapshot(pool),scopeBefore);

  // Existing Submitted -> Rejected -> correction -> Submitted history retains
  // each work reference independently. No change to the approval state machine.
  saved=await post({...input(id),status:'Submitted'});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const snapshots=async()=>(await pool.query('select id,entries from work_submission_evidence where timesheet_id=$1 order by sequence',[saved.body.id])).rows;
  const original=(await snapshots())[0];assert.equal(original.entries[0].workReference,reference);
  await assert.rejects(pool.query('update timesheet_entries set work_reference=$2 where timesheet_id=$1',[saved.body.id,nextReference]),error=>error.code==='WWP01');
  assert.equal((await post(input(id,[{...entry,work_reference:nextReference}]))).body.code,'WORK_HISTORY_IMMUTABLE');
  let decision=await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic reference correction'}});assert.equal(decision.status,200,JSON.stringify(decision.body));
  saved=await post({...input(id,[{...entry,work_reference:nextReference}]),status:'Submitted'});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const retained=await snapshots();assert.equal(retained.length,2);assert.deepEqual(retained[0],original);assert.equal(retained[1].entries[0].workReference,nextReference);
  decision=await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(decision.status,200,JSON.stringify(decision.body));
  assert.equal((await pool.query('select count(*)::int n from work_submission_decisions where submission_id=any($1::text[])',[retained.map(row=>row.id)])).rows[0].n,2);
  await assert.rejects(pool.query("update work_submission_evidence set entries='[]'::jsonb where id=$1",[original.id]),error=>Boolean(error.code));

  for(const versioned of [false,true]){
   const employeeId=await worker(),path=versioned?'/api/v1/imports/timesheets/apply':'/api/imports/timesheets/apply';
   const row={employeeId,weekEnding:today,workType:entry.work_type,clientName:entry.client_name,category:entry.category,date:today,hours:'0.25',remark:entry.remark,billable:false,status:'Draft',evidenceUrl:'https://example.test/preserved-evidence',workReference:reference};
   const imported=(rows,dryRun=false,key=randomUUID())=>request(path,{method:'POST',headers:versioned?{'Idempotency-Key':key}:{},body:{fileName:'synthetic-reference.csv',rows,...(versioned?{schemaVersion:'timesheet-import/1',dryRun}:{})}});
   const stored=async()=>(await pool.query('select e.work_reference from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.employee_id=$1',[employeeId])).rows;
   if(versioned){const previewBefore=await workSnapshot(pool);assert.equal((await imported([row],true)).body.validRows,1);assert.deepEqual(await workSnapshot(pool),previewBefore);}
   const key=randomUUID();assert.equal((await imported([row],false,key)).body.status,'Success');assert.deepEqual(await stored(),[{work_reference:reference}]);
   if(versioned){const replayBefore=await workSnapshot(pool);assert.equal((await imported([row],false,key)).body.status,'Success');assert.deepEqual(await workSnapshot(pool),replayBefore);}
   const {workReference:_field,...legacyRow}=row;assert.equal((await imported([{...legacyRow,hours:'0.5'}])).body.status,'Success');assert.deepEqual(await stored(),[{work_reference:reference}]);
   const replacementBefore=await workSnapshot(pool);
   const rejected=await imported([{...legacyRow,category:'Changed category'}],versioned);assert.equal(rejected.body.validRows,0);assert.equal(rejected.body.errors[0].code,'WORK_REFERENCE_REPLACEMENT_CONFLICT');assert.deepEqual(await workSnapshot(pool),replacementBefore);
   assert.equal((await imported([{...row,workReference:null}])).body.status,'Success');assert.deepEqual(await stored(),[{work_reference:null}]);
   const {evidenceUrl:_oldUrl,...referenceOnlyRow}=row;assert.equal((await imported([referenceOnlyRow])).body.status,'Success');
   assert.equal((await pool.query('select e.evidence_url from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.employee_id=$1',[employeeId])).rows[0].evidence_url,row.evidenceUrl);

   assert.equal((await imported([{...row,category:'Explicit replacement',workReference:nextReference}])).body.status,'Success');assert.deepEqual(await stored(),[{work_reference:nextReference}]);
   assert.equal((await imported([{...row,workReference:'invalid\nreference'}])).status,400);
   assert.equal((await imported([{...row,status:'Submitted'}])).body.status,'Success');
   assert.equal((await pool.query('select w.entries from work_submission_evidence w join timesheets t on t.id=w.timesheet_id where t.employee_id=$1',[employeeId])).rows[0].entries[0].workReference,reference);
  }

 });
});
console.log('Work reference PostgreSQL/API fresh/047 upgrade/replay, manual save/read/clear, legacy preservation/conflict, reference-only CAS, scope, immutable correction history and both import aliases passed.');
