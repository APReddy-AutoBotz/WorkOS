import assert from 'node:assert/strict';
import {copyFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {capturePolicyView} from '../server/modules/work-capture/capture-policy.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday,addUtcDays} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions,workSnapshot} from './support/work-assignment-test.mjs';
const migration='049_wos04_required_work_evidence',url='https://example.test/work/42',nextUrl='https://example.test/work/43';
const table=async(pool,name)=>(await pool.query(`select to_jsonb(t) value from ${name} t order by to_jsonb(t)::text`)).rows;
const periods=async(pool,today)=>{for(let step=-1;step<7;step++)await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
 values($1,$2,$3,$1,'Synthetic required evidence period',$4,$4::date+6,'Open','Weekly')`,[`evidence-policy-${step}`,f.organizationId,f.legalEntityId,addUtcDays(today,step*7)]);};
const sqlAppend=async(pool,actor,today,sequence,field)=>{
 const columns=field===undefined?'':',evidence_required',placeholder=field===undefined?'':',$7';
 return (await pool.query(`insert into work_capture_policy_versions(id,organization_id,legal_entity_id,sequence,policy_version,effective_from,minimum_increment,daily_maximum,weekly_maximum,comment_required,actor_id,active_role,source,correlation_id,operation_id${columns})
  values($1,$2,$3,$4,'work-capture-rules/1',$5,0.25,null,null,false,$6,'Admin','Synthetic SQL','synthetic-evidence-correlation','synthetic-evidence-operation'${placeholder}) returning *,effective_from::text`,
 [`evidence-policy-sql-${randomUUID()}`,f.organizationId,f.legalEntityId,sequence,today,actor,...(field===undefined?[]:[field])])).rows[0];
};
await withCommercialDatabase(async({pool})=>{
 await withPreCommercialMigrations(async rootDir=>{
  for(const file of (await readdir(join(commercialServerDir,'migrations'))).filter(file=>/^04[0-8]_/.test(file)))await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
  await runMigrations({pool,rootDir,logger:{log(){}}});await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool),today=await amendmentToday(pool);await periods(pool,today);
  await sqlAppend(pool,identities.manager.id,today,1);
  await pool.query("update timesheets set status='Submitted' where id=$1",[f.timesheetId]);
  await pool.query(`insert into work_submission_evidence(id,organization_id,legal_entity_id,timesheet_id,sequence,policy_version,entries,period_references,actor_id,active_role,source,correlation_id,operation_id)
   select 'synthetic-pre049-submission',$1,$2,$3,1,'assignment-work-date/1',jsonb_build_array(jsonb_build_object('entryId',e.id,'projectId',e.project_id,'workType',e.work_type,'workDate',e.work_date::text,'hours',e.hours::text,'billable',e.billable,'clientName',e.client_name,'category',e.category,'remark',e.remark,'evidenceUrl',e.evidence_url,'workReference',e.work_reference)),
   '[]'::jsonb,$4,'Admin','Web','synthetic-pre049-correlation','synthetic-pre049-operation' from timesheet_entries e where e.timesheet_id=$3`,[f.organizationId,f.legalEntityId,f.timesheetId,identities.manager.id]);
  const before=await workSnapshot(pool),rules=await table(pool,'work_capture_policy_versions'),grants=await table(pool,'role_permissions');
  for(const row of before.timesheet_entries){row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;}
  for(const row of before.work_submission_evidence){row.value.duplicate_entry_check=null;row.value.submission_timing=null;} // additive 050; old JSON contents remain exact
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[migration,'050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals']);
  assert.deepEqual(await workSnapshot(pool),before);assert.deepEqual(await table(pool,'role_permissions'),grants);
  assert.deepEqual((await pool.query("select to_jsonb(t)-array['evidence_required','overtime_rule','submission_deadline'] value from work_capture_policy_versions t order by to_jsonb(t)::text")).rows,rules);
  const legacy=(await pool.query('select *,effective_from::text,minimum_increment::text,daily_maximum::text,weekly_maximum::text from work_capture_policy_versions')).rows[0];assert.equal(legacy.evidence_required,null);assert.equal(capturePolicyView(legacy).evidenceRequired,false);
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);assert.deepEqual(await workSnapshot(pool),before);
 });
});
await withCommercialDatabase(async({pool,databaseUrl})=>{
 assert((await migrateCommercialDatabase(pool)).applied.includes(migration));await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);const today=await amendmentToday(pool);await periods(pool,today);
 const worker=async()=>{const id=`worker-required-evidence-${randomUUID()}`;await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
  values($1,$1,'Synthetic evidence policy worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)`,[id,`${id}@example.test`,f.organizationId,f.legalEntityId]);return id;};
 const entry={work_type:'Client Misc Task',client_name:'Synthetic evidence policy context',category:'Synthetic evidence category',work_date:today,hours:'0.25',remark:'Synthetic evidence policy comment',billable:false,work_reference:'TASK-42'};
 const input=(employeeId,entries=[entry],status='Draft')=>({employee_id:employeeId,week_ending:today,status,entries});
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  const path='/api/v1/work-capture-policy',post=body=>request('/api/timesheets',{method:'POST',body});
  const neutral=await request(path);assert.equal(neutral.status,200);assert.equal(neutral.body.latestId,null);assert.deepEqual(neutral.body.versions,[]);assert.equal((await pool.query('select count(*)::int n from work_capture_policy_versions')).rows[0].n,0);
  const oldWorker=await worker(),old=await post(input(oldWorker,[entry],'Submitted'));assert.equal(old.status,200,JSON.stringify(old.body));const oldEvidence=(await pool.query('select to_jsonb(w) value from work_submission_evidence w where timesheet_id=$1',[old.body.id])).rows;
  const rule={expectedLatestId:null,effectiveFrom:today,minimumIncrement:'0.25',dailyMaximum:null,weeklyMaximum:null,commentRequired:false,evidenceRequired:true};
  assert.equal((await request(path,{method:'POST',identity:identities.reader,body:rule})).status,403);
  assert.equal((await request(path,{method:'POST',scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},body:rule})).status,403);
  const grants=await table(pool,'role_permissions');let created=await request(path,{method:'POST',body:rule});assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.evidenceRequired,true);assert.deepEqual(await table(pool,'role_permissions'),grants);
  assert.equal((await request(path,{method:'POST',body:rule})).status,409);assert.equal((await request(path,{method:'POST',body:{...rule,expectedLatestId:created.body.id,effectiveFrom:addUtcDays(today,1)}})).status,409);
  assert.equal((await request(path,{method:'POST',body:{...rule,evidenceRequired:'true'}})).status,400);
  const audit=(await pool.query("select new_value from audit_logs where action='Append Capture Policy' and entity_id=$1",[created.body.id])).rows[0];assert.equal(audit.new_value.evidenceRequired,true);
  for(const sql of ['update work_capture_policy_versions set evidence_required=false where id=$1','delete from work_capture_policy_versions where id=$1'])await assert.rejects(pool.query(sql,[created.body.id]),error=>Boolean(error.code));
  // Decisions retain the earlier submission contract even after adoption on
  // the same work date; no new pin or missing-link rewrite is inferred.
  assert.equal((await request(`/api/timesheets/${old.body.id}/status`,{method:'PATCH',body:{status:'Approved'}})).status,200);assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w where timesheet_id=$1',[old.body.id])).rows,oldEvidence);
  const id=await worker(),before=await workSnapshot(pool);
  for(const body of [input(id),input(id,[{...entry,evidence_url:null}]),input(id,[{...entry,evidence_url:''}])]){const missing=await post(body);assert.equal(missing.status,422);assert.equal(missing.body.code,'WORK_CAPTURE_EVIDENCE_REQUIRED');assert.deepEqual(await workSnapshot(pool),before);}
  assert.equal((await post(input(id,[{...entry,evidence_url:'javascript:synthetic'}]))).status,400);
  const zeroId=await worker();assert.equal((await post(input(zeroId,[{...entry,hours:'0'}]))).status,200,'zero entries remain exempt');
  let saved=await post(input(id,[{...entry,evidence_url:url}]));assert.equal(saved.status,200,JSON.stringify(saved.body));
  const read=async()=>(await request('/api/timesheets')).body.find(row=>row.id===saved.body.id);
  saved=await post(input(id,[{...entry,hours:'0.5'}]));assert.equal(saved.status,200);assert.equal((await read()).entries[0].evidence_url,url,'resolve legacy omission before required-evidence validation');
  const stable=await workSnapshot(pool);assert.equal((await post(input(id,[{...entry,evidence_url:null}]))).body.code,'WORK_CAPTURE_EVIDENCE_REQUIRED');assert.deepEqual(await workSnapshot(pool),stable);
  await assert.rejects(pool.query('update timesheet_entries set evidence_url=null where timesheet_id=$1',[saved.body.id]),{code:'WCR06'});assert.deepEqual(await workSnapshot(pool),stable,'deferred SQL guard rolls back an evidence-only clear');
  const mixedId=await worker();const mixed=await post(input(mixedId,[{...entry,evidence_url:url},{...entry,category:'Synthetic zero',hours:'0'},{...entry,category:'Synthetic earlier optional',work_date:addUtcDays(today,-1)}]));assert.equal(mixed.status,200,JSON.stringify(mixed.body));assert.equal(mixed.body.entries.length,3);
  for(const versioned of [false,true]){
   const employeeId=await worker(),importPath=versioned?'/api/v1/imports/timesheets/apply':'/api/imports/timesheets/apply';
   const row={employeeId,weekEnding:today,workType:entry.work_type,clientName:entry.client_name,category:entry.category,date:today,hours:'0.25',remark:entry.remark,billable:false,status:'Draft'};
   const imported=(rows,dryRun=false,key=randomUUID())=>request(importPath,{method:'POST',headers:versioned?{'Idempotency-Key':key}:{},body:{fileName:'synthetic-required-evidence.csv',rows,...(versioned?{schemaVersion:'timesheet-import/1',dryRun}:{})}});
   const initial=await workSnapshot(pool);for(const dryRun of versioned?[true,false]:[false]){const rejected=await imported([row],dryRun);assert.equal(rejected.body.validRows,0);assert.equal(rejected.body.errors[0].code,'WORK_CAPTURE_EVIDENCE_REQUIRED');assert.deepEqual(await workSnapshot(pool),initial);}
   const linked={...row,evidenceUrl:url};if(versioned){assert.equal((await imported([linked],true)).body.validRows,1);assert.deepEqual(await workSnapshot(pool),initial);}
   const key=randomUUID();assert.equal((await imported([linked],false,key)).body.status,'Success');if(versioned){const replay=await workSnapshot(pool);assert.equal((await imported([linked],false,key)).body.status,'Success');assert.deepEqual(await workSnapshot(pool),replay);}
   assert.equal((await imported([{...row,hours:'0.5'}])).body.status,'Success','old import caller preserves existing matching URL');
   const accepted=await workSnapshot(pool);assert.equal((await imported([{...linked,evidenceUrl:null}])).body.validRows,0);assert.deepEqual(await workSnapshot(pool),accepted);
   assert.equal((await imported([{...linked,status:'Submitted'}])).body.status,'Success');
   const retained=(await pool.query('select w.entries,w.capture_policy_references from work_submission_evidence w join timesheets t on t.id=w.timesheet_id where t.employee_id=$1',[employeeId])).rows[0];assert.equal(retained.entries[0].evidenceUrl,url);assert.equal(retained.capture_policy_references[0].reference.id,created.body.id);
  }
  const submitted=await post(input(id,[{...entry,evidence_url:url}],'Submitted'));assert.equal(submitted.status,200);const snapshots=async()=>(await pool.query('select id,entries,capture_policy_references from work_submission_evidence where timesheet_id=$1 order by sequence',[saved.body.id])).rows;const original=(await snapshots())[0];
  assert.equal(original.capture_policy_references[0].reference.id,created.body.id);assert.equal((await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic evidence correction'}})).status,200);
  const rejected=await workSnapshot(pool);assert.equal((await post(input(id,[{...entry,evidence_url:null}],'Submitted'))).body.code,'WORK_CAPTURE_EVIDENCE_REQUIRED');assert.deepEqual(await workSnapshot(pool),rejected);
  assert.equal((await post(input(id,[{...entry,evidence_url:nextUrl}],'Submitted'))).status,200);const revised=await snapshots();assert.deepEqual(revised[0],original);assert.equal(revised[1].entries[0].evidenceUrl,nextUrl);
  assert.equal((await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Approved'}})).status,200);
  // Omitted flags preserve the choice through old API and raw SQL commands.
  const {evidenceRequired:_omitted,...legacyRule}=rule;
  let next=await request(path,{method:'POST',body:{...legacyRule,expectedLatestId:created.body.id,effectiveFrom:addUtcDays(today,7)}});assert.equal(next.status,201);assert.equal(next.body.evidenceRequired,true);
  const direct=await sqlAppend(pool,identities.manager.id,addUtcDays(today,14),3);assert.equal(direct.evidence_required,true);
  const disabled=await request(path,{method:'POST',body:{...rule,evidenceRequired:false,expectedLatestId:direct.id,effectiveFrom:addUtcDays(today,21)}});assert.equal(disabled.status,201);assert.equal(disabled.body.evidenceRequired,false);
  next=await request(path,{method:'POST',body:{...legacyRule,expectedLatestId:disabled.body.id,effectiveFrom:addUtcDays(today,28)}});assert.equal(next.status,201);assert.equal(next.body.evidenceRequired,false);
  const missingNow=await worker();assert.equal((await post(input(missingNow))).body.code,'WORK_CAPTURE_EVIDENCE_REQUIRED','a future opt-out never changes current work-date authority');
  const raced=await Promise.all([true,false].map(evidenceRequired=>request(path,{method:'POST',body:{...rule,evidenceRequired,expectedLatestId:next.body.id,effectiveFrom:addUtcDays(today,35)}})));assert.deepEqual(raced.map(row=>row.status).sort(),[201,409]);
  const history=await request(path);assert.equal(history.body.versions.length,6);assert.equal(history.body.versions.find(row=>row.id===created.body.id).evidenceRequired,true);
  const closeBefore=await workSnapshot(pool);await pool.query("update reporting_periods set status='Closed' where id='evidence-policy-0'");assert.equal((await post(input(zeroId,[{...entry,hours:'0'}]))).body.code,'REPORTING_PERIOD_CLOSED');assert.deepEqual(await workSnapshot(pool),closeBefore);
 });
});
console.log('Required evidence PostgreSQL/API fresh/048 upgrade/replay, neutral history/grants, explicit/inherited policy, direct SQL guard, manual/import parity, prospective disable, races, periods and immutable correction/decision evidence passed.');
