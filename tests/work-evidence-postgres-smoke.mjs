import assert from 'node:assert/strict';
import {syntheticCredential} from './support/synthetic-values.mjs';
import {copyFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,
 seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions,workSnapshot,seedWorkPeriods} from './support/work-assignment-test.mjs';
const migration='047_wos04_work_entry_evidence',link='https://example.test/work/42?revision=1#note',nextLink='https://example.test/work/43';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await withPreCommercialMigrations(async rootDir=>{
  for(const file of (await readdir(join(commercialServerDir,'migrations'))).filter(file=>/^04[0-6]_/.test(file)))await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
  await runMigrations({pool,rootDir,logger:{log(){}}});await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);
  await pool.query("update timesheets set status='Submitted' where id=$1",[f.timesheetId]);
  await pool.query(`insert into work_submission_evidence(id,organization_id,legal_entity_id,timesheet_id,sequence,policy_version,entries,period_references,actor_id,active_role,source,correlation_id,operation_id)
   select 'synthetic-pre047-submission',$1,$2,$3,1,'assignment-work-date/1',jsonb_build_array(jsonb_build_object(
    'entryId',e.id,'projectId',e.project_id,'workType',e.work_type,'workDate',e.work_date::text,'hours',e.hours::text,'billable',e.billable,'clientName',e.client_name,'category',e.category,'remark',e.remark)),
    '[]'::jsonb,$4,'Admin','Web','synthetic-pre047-correlation','synthetic-pre047-operation' from timesheet_entries e where e.timesheet_id=$3`,[f.organizationId,f.legalEntityId,f.timesheetId,identities.manager.id]);
  const oldHistory=(await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows;
  for(const row of oldHistory){row.value.duplicate_entry_check=null;row.value.submission_timing=null;} // additive 050; no historical diagnostic is inferred
  assert.equal(Object.hasOwn(oldHistory[0].value.entries[0],'evidenceUrl'),false);

  const before=(await pool.query('select to_jsonb(e) value from timesheet_entries e order by id')).rows;
  const grants=(await pool.query('select to_jsonb(r) value from role_permissions r order by to_jsonb(r)::text')).rows;
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[migration,'048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage']);
  assert.deepEqual((await pool.query("select to_jsonb(e)-array['evidence_url','work_reference','source_identity','category_code','category_reference'] value from timesheet_entries e order by id")).rows,before);
  assert.equal((await pool.query('select count(*)::int n from timesheet_entries where evidence_url is not null')).rows[0].n,0);
  assert.deepEqual((await pool.query('select to_jsonb(r) value from role_permissions r order by to_jsonb(r)::text')).rows,grants);
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows,oldHistory,'upgrade and replay leave pre047 immutable JSON byte-equivalent');
  await grantWorkPermissions(pool);
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
   values('evidence-legacy-first',$1,$2,'SYN-EVIDENCE-LEGACY-1','Synthetic legacy first','2020-03-08','2020-03-14','Open','Weekly'),
   ('evidence-legacy-second',$1,$2,'SYN-EVIDENCE-LEGACY-2','Synthetic legacy second','2020-03-15','2020-03-21','Open','Weekly')`,[f.organizationId,f.legalEntityId]);
  await withCommercialApi({databaseUrl,identities},async({request})=>{
   const approved=await request(`/api/timesheets/${f.timesheetId}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(approved.status,200,JSON.stringify(approved.body));
   assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w')).rows,oldHistory,'ordinary approval accepts old missing/null evidence without rewriting its snapshot');
  });

 });
});
await withCommercialDatabase(async({pool,databaseUrl})=>{
 assert((await migrateCommercialDatabase(pool)).applied.includes(migration));
 await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
 const today=await amendmentToday(pool);await seedWorkPeriods(pool,today);
 const worker=async()=>{const id=`worker-evidence-${randomUUID()}`;await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
  values($1,$1,'Synthetic evidence worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)`,[id,`${id}@example.test`,f.organizationId,f.legalEntityId]);return id;};
 const entry={work_type:'Client Misc Task',client_name:'Synthetic evidence context',category:'Synthetic evidence category',work_date:today,hours:'0.25',remark:'Synthetic evidence comment',billable:false,evidence_url:link};
 const input=(employeeId,entries=[entry])=>({employee_id:employeeId,week_ending:today,status:'Draft',entries});
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  const post=body=>request('/api/timesheets',{method:'POST',body});
  const id=await worker();let saved=await post(input(id));assert.equal(saved.status,200,JSON.stringify(saved.body));
  const read=async()=>(await request('/api/timesheets')).body.find(row=>row.id===saved.body.id);
  let raw=await read();assert.equal(raw.entries[0].evidence_url,link);
  const audit=(await pool.query("select new_value from audit_logs where module='Timesheets' and entity_id=$1 order by created_at desc limit 1",[saved.body.id])).rows[0];assert.equal(audit.new_value.entryEvidence[0].evidence_url,link);
  const {evidence_url:_omitted,...legacyEntry}=entry;
  saved=await post({...input(id,[{...legacyEntry,hours:'0.5'}]),expected_write_token:saved.body.write_token});assert.equal(saved.status,200);assert.equal((await read()).entries[0].evidence_url,link,'legacy omission preserves the matching link');
  const before=await workSnapshot(pool);
  const ambiguous=await post(input(id,[{...legacyEntry,category:'Changed context'}]));assert.equal(ambiguous.status,409);assert.equal(ambiguous.body.code,'WORK_EVIDENCE_REPLACEMENT_CONFLICT');assert.deepEqual(await workSnapshot(pool),before);
  // Evidence-only SQL change is part of the complete physical write revision.
  const oldToken=saved.body.write_token;await pool.query('update timesheet_entries set evidence_url=$2 where timesheet_id=$1',[saved.body.id,nextLink]);
  const afterEvidence=await workSnapshot(pool);assert.notEqual((await read()).write_token,oldToken);
  const stale=await post({...input(id),expected_write_token:oldToken});assert.equal(stale.status,409);assert.equal(stale.body.code,'WORK_CAPTURE_WRITE_CONFLICT');assert.deepEqual(await workSnapshot(pool),afterEvidence);
  saved=await post({...input(id,[{...entry,evidence_url:null}]),expected_write_token:(await read()).write_token});assert.equal(saved.status,200);assert.equal((await read()).entries[0].evidence_url,null);
  saved=await post(input(id,[{...entry,evidence_url:''}]));assert.equal(saved.status,200);assert.equal((await read()).entries[0].evidence_url,null);
  const credentialUrl = new URL('https://example.test/work');
  credentialUrl.username = 'synthetic-user';
  credentialUrl.password = syntheticCredential();
  for(const evidence_url of ['javascript:alert(1)','//example.test/work',credentialUrl.href,'https://example.test/'+ 'x'.repeat(2048)]){
   const snapshot=await workSnapshot(pool);assert.equal((await post(input(id,[{...entry,evidence_url}]))).status,400);assert.deepEqual(await workSnapshot(pool),snapshot);
  }
  await assert.rejects(pool.query("update timesheet_entries set evidence_url='javascript:synthetic' where timesheet_id=$1",[saved.body.id]),error=>error.code==='23514');
  const scopeBefore=await workSnapshot(pool);assert.equal((await request('/api/timesheets',{method:'POST',scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},body:input(id)})).status,403);assert.deepEqual(await workSnapshot(pool),scopeBefore);

  // Existing Submitted -> Rejected -> correction -> Submitted history retains
  // each evidence URL independently. No change to the approval state machine.
  saved=await post({...input(id),status:'Submitted'});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const snapshots=async()=>(await pool.query('select id,entries from work_submission_evidence where timesheet_id=$1 order by sequence',[saved.body.id])).rows;
  const original=(await snapshots())[0];assert.equal(original.entries[0].evidenceUrl,link);
  await assert.rejects(pool.query('update timesheet_entries set evidence_url=$2 where timesheet_id=$1',[saved.body.id,nextLink]),error=>error.code==='WWP01');
  assert.equal((await post(input(id,[{...entry,evidence_url:nextLink}]))).body.code,'WORK_HISTORY_IMMUTABLE');
  let decision=await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic evidence correction'}});assert.equal(decision.status,200,JSON.stringify(decision.body));
  saved=await post({...input(id,[{...entry,evidence_url:nextLink}]),status:'Submitted'});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const retained=await snapshots();assert.equal(retained.length,2);assert.deepEqual(retained[0],original);assert.equal(retained[1].entries[0].evidenceUrl,nextLink);
  decision=await request(`/api/timesheets/${saved.body.id}/status`,{method:'PATCH',body:{status:'Approved'}});assert.equal(decision.status,200,JSON.stringify(decision.body));
  assert.equal((await pool.query('select count(*)::int n from work_submission_decisions where submission_id=any($1::text[])',[retained.map(row=>row.id)])).rows[0].n,2);
  await assert.rejects(pool.query("update work_submission_evidence set entries='[]'::jsonb where id=$1",[original.id]),error=>Boolean(error.code));

  for(const versioned of [false,true]){
   const employeeId=await worker(),path=versioned?'/api/v1/imports/timesheets/apply':'/api/imports/timesheets/apply';
   const row={employeeId,weekEnding:today,workType:entry.work_type,clientName:entry.client_name,category:entry.category,date:today,hours:'0.25',remark:entry.remark,billable:false,status:'Draft',evidenceUrl:link};
   const imported=(rows,dryRun=false,key=randomUUID())=>request(path,{method:'POST',headers:versioned?{'Idempotency-Key':key}:{},body:{fileName:'synthetic-evidence.csv',rows,...(versioned?{schemaVersion:'timesheet-import/1',dryRun}:{})}});
   const stored=async()=>(await pool.query('select e.evidence_url from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.employee_id=$1',[employeeId])).rows;
   if(versioned){const previewBefore=await workSnapshot(pool);assert.equal((await imported([row],true)).body.validRows,1);assert.deepEqual(await workSnapshot(pool),previewBefore);}
   const key=randomUUID();assert.equal((await imported([row],false,key)).body.status,'Success');assert.deepEqual(await stored(),[{evidence_url:link}]);
   if(versioned){const replayBefore=await workSnapshot(pool);assert.equal((await imported([row],false,key)).body.status,'Success');assert.deepEqual(await workSnapshot(pool),replayBefore);}
   const {evidenceUrl:_field,...legacyRow}=row;assert.equal((await imported([{...legacyRow,hours:'0.5'}])).body.status,'Success');assert.deepEqual(await stored(),[{evidence_url:link}]);
   const replacementBefore=await workSnapshot(pool);
   const rejected=await imported([{...legacyRow,category:'Changed category'}],versioned);assert.equal(rejected.body.validRows,0);assert.equal(rejected.body.errors[0].code,'WORK_EVIDENCE_REPLACEMENT_CONFLICT');assert.deepEqual(await workSnapshot(pool),replacementBefore);
   assert.equal((await imported([{...row,evidenceUrl:null}])).body.status,'Success');assert.deepEqual(await stored(),[{evidence_url:null}]);
   assert.equal((await imported([{...row,category:'Explicit replacement',evidenceUrl:nextLink}])).body.status,'Success');assert.deepEqual(await stored(),[{evidence_url:nextLink}]);
   assert.equal((await imported([{...row,evidenceUrl:'javascript:synthetic'}])).status,400);
   assert.equal((await imported([{...row,status:'Submitted'}])).body.status,'Success');
   assert.equal((await pool.query('select w.entries from work_submission_evidence w join timesheets t on t.id=w.timesheet_id where t.employee_id=$1',[employeeId])).rows[0].entries[0].evidenceUrl,link);
  }

 });
});
console.log('Work evidence PostgreSQL/API fresh/046 upgrade/replay, manual save/read/clear, legacy preservation/conflict, evidence-only CAS, scope, immutable correction history and both import aliases passed.');
