import assert from 'node:assert/strict';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f, commercialServerDir, withCommercialDatabase, withPreCommercialMigrations,
  migrateCommercialDatabase, seedCommercialReferences, seedCommercialLegacyWork, seedCommercialIdentities, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday, addUtcDays, grantAmendmentPermissions, createAmendmentHierarchy} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions, workAllocation, workInput, workPost, workImport, workImportRow} from './support/work-assignment-test.mjs';

const migration = '045_wos04_work_capture_policy', quiet = {log() {}};
const tableSnapshot = async (pool, table) => (await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
await withCommercialDatabase(async ({pool}) => {
  await withPreCommercialMigrations(async rootDir => {
    for (const file of ['040_wos04_commercial_drafting_foundation.sql', '041_wos04_governed_lifecycle.sql', '042_wos04_scoped_client_profiles.sql', '043_wos04_governed_amendments.sql', '044_wos04_work_submission_evidence.sql']) {
      await copyFile(join(commercialServerDir, 'migrations', file), join(rootDir, 'migrations', file));
    }
    await runMigrations({pool, rootDir, logger: quiet}); await seedCommercialReferences(pool); await seedCommercialLegacyWork(pool);
    const before = await tableSnapshot(pool, 'timesheet_entries'), headers = await tableSnapshot(pool, 'timesheets');
    for(const row of before){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;} // additive 047/048 column
    const grants = await tableSnapshot(pool, 'role_permissions');
    const installed = await migrateCommercialDatabase(pool); assert.deepEqual(installed.applied, [migration,'046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence']);
    assert.deepEqual(await tableSnapshot(pool, 'timesheet_entries'), before); assert.deepEqual(await tableSnapshot(pool, 'timesheets'), headers);
    assert.deepEqual(await tableSnapshot(pool, 'role_permissions'), grants);
    assert.equal((await pool.query('select count(*)::int n from work_capture_policy_versions')).rows[0].n, 0);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
  });
});

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  assert((await migrateCommercialDatabase(pool)).applied.includes(migration));
  await seedCommercialReferences(pool); await seedCommercialLegacyWork(pool);
  const identities = await seedCommercialIdentities(pool); await grantAmendmentPermissions(pool); await grantWorkPermissions(pool);
  const today = await amendmentToday(pool), next = addUtcDays(today, 7), yesterday = addUtcDays(today, -1);
  // The current synthetic Weekly period begins today so prospective policy
  // activation is tested without backdating, disabling guards or changing time.
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('capture-current',$1,$2,'SYN-CAPTURE-CURRENT','Synthetic capture current',$3,$3::date+6,'Open','Weekly'),
    ('capture-next',$1,$2,'SYN-CAPTURE-NEXT','Synthetic capture next',$3::date+7,$3::date+13,'Planned','Weekly')`, [f.organizationId, f.legalEntityId, today]);
  const legacy = await tableSnapshot(pool, 'timesheet_entries');
  await withCommercialApi({databaseUrl, identities, timeZone: 'Pacific/Kiritimati'}, async ({request}) => {
    const roots = await createAmendmentHierarchy(request, 'SYN-CAPTURE');
    await workPost(request, '/api/allocations', workAllocation(roots.project.id, today));
    const neutral = await workPost(request, '/api/timesheets', workInput(roots.project.id, today, {entries: [{...workInput(roots.project.id, today).entries[0], hours: 0.25, remark: null}]}));
    const original = (await pool.query('select entries,policy_version,capture_policy_references from work_submission_evidence where timesheet_id=$1', [neutral.id])).rows[0];
    assert.equal(original.policy_version, 'assignment-work-date/1'); assert.equal(original.capture_policy_references[0].reference, null);
    assert.equal(neutral.total_hours, '0.25');
    // With no inferred policy, exact neutral quantities must survive actual
    // PostgreSQL nested-JSON transport and an untouched manual round trip.
    const precisionWorker='worker-capture-exact-neutral',tiny='0.'+'0'.repeat(330)+'1';
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values($1,$1,'Synthetic exact neutral worker','exact-neutral@example.test','Consultant','Delivery','US','director-commercial','Active',$2,$3)`,[precisionWorker,f.organizationId,f.legalEntityId]);
    const precisionHeader=(await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,'Draft',0,0,$3,$4) returning id`,[precisionWorker,today,f.organizationId,f.legalEntityId])).rows[0].id;
    for(const [category,hours] of [['Synthetic exact','0.25000000000000001'],['Synthetic tiny',tiny]])await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,category,work_date,hours,remark,billable)
      values($1,'Client Misc Task','Synthetic exact context',$2,$3,$4,'Synthetic exact comment',false)`,[precisionHeader,category,today,hours]);
    await pool.query('update timesheets set total_hours=(select sum(hours) from timesheet_entries where timesheet_id=$1) where id=$1',[precisionHeader]);
    const preciseRead=(await request('/api/timesheets')).body.find(row=>row.id===precisionHeader);
    assert.deepEqual(preciseRead.entries.map(row=>[row.category,row.hours_exact]).sort(),[['Synthetic exact','0.25000000000000001'],['Synthetic tiny',tiny]]);
    const exactRoundTrip=await request('/api/timesheets',{method:'POST',body:{employee_id:precisionWorker,week_ending:today,status:'Draft',entries:preciseRead.entries.map(entry=>({work_type:entry.work_type,client_name:entry.client_name,category:entry.category,work_date:entry.work_date,hours:entry.hours_exact,remark:entry.remark,billable:entry.billable}))}});
    assert.equal(exactRoundTrip.status,200,JSON.stringify(exactRoundTrip.body));
    assert.deepEqual((await pool.query('select category,hours::text hours from timesheet_entries where timesheet_id=$1 order by category',[precisionHeader])).rows,[{category:'Synthetic exact',hours:'0.25000000000000001'},{category:'Synthetic tiny',hours:tiny}]);
    const path = '/api/v1/work-capture-policy';
    assert.equal((await request(path, {identity: identities.reader})).status, 403);
    assert.equal((await request(path, {scope: {organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId}})).status, 403);
    let workspace = await request(path); assert.equal(workspace.status, 200); assert.equal(workspace.body.latestId, null);
    const body = {expectedLatestId: null, effectiveFrom: today, minimumIncrement: '0.25', dailyMaximum: '1', weeklyMaximum: '0.75', commentRequired: true};
    const created = await request(path, {method: 'POST', body}); assert.equal(created.status, 201, JSON.stringify(created.body));
    await assert.rejects(pool.query("update reporting_periods set ends_on=ends_on-1 where id='capture-current'"), {code:'23514'}, 'policy activation boundaries are not an indirect mutable policy editor');
    assert.equal((await request(path, {method: 'POST', body})).status, 409, 'lost update cannot append twice');
    assert.equal((await request(path, {method: 'POST', body: {...body, expectedLatestId: created.body.id, effectiveFrom: addUtcDays(today, 1)}})).status, 409, 'activation must be a Weekly start');
    for (const sql of ['update work_capture_policy_versions set minimum_increment=1 where id=$1', 'delete from work_capture_policy_versions where id=$1']) {
      await assert.rejects(pool.query(sql, [created.body.id]), error => Boolean(error.code));
    }
    // A newly installed policy cannot change an old retained decision contract.
    assert.equal((await request(`/api/timesheets/${neutral.id}/status`, {method: 'PATCH', body: {status: 'Approved'}})).status, 200);
    assert.deepEqual((await pool.query('select entries,policy_version,capture_policy_references from work_submission_evidence where timesheet_id=$1', [neutral.id])).rows[0], original);
    const worker = async id => {
      await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
        values($1,$1,'Synthetic capture worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)`, [id, `${id}@example.test`, f.organizationId, f.legalEntityId]);
      await workPost(request, '/api/allocations', workAllocation(roots.project.id, today, {employee_id: id}));
      return id;
    };
    const manualWorker = await worker('worker-capture-manual');
    const manual = (hours, remark = 'Synthetic capture comment', status = 'Draft') => workInput(roots.project.id, today, {employee_id: manualWorker, status,
      entries: [{...workInput(roots.project.id, today).entries[0], hours, remark}]});
    let saved = await workPost(request, '/api/timesheets', manual(0.25)); assert.equal(saved.total_hours, '0.25');
    assert.equal((await pool.query('select hours::text from timesheet_entries where timesheet_id=$1', [saved.id])).rows[0].hours, '0.25');
    assert.equal((await request('/api/timesheets', {method: 'POST', body: manual(0.3)})).body.code, 'WORK_CAPTURE_INCREMENT');
    assert.equal((await request('/api/timesheets', {method: 'POST', body: manual(0.25, '  ')})).body.code, 'WORK_CAPTURE_COMMENT_REQUIRED');
    saved = await workPost(request, '/api/timesheets', manual(0.5)); assert.equal(saved.total_hours, '0.5', 'replacement counted once');
    await assert.rejects(pool.query('update timesheet_entries set remark=$2 where timesheet_id=$1',[saved.id,'\t\n\u00a0\u2003\ufeff']),{code:'WCR03'},'SQL whitespace-only comments match JavaScript trim');
    assert.equal((await request('/api/timesheets',{method:'POST',body:manual('0.25000000000000001')})).body.code,'WORK_CAPTURE_INCREMENT','manual exact decimal strings are not rounded before validation');
    // Deliberately irregular legacy header: the aggregate must still include its
    // real work date. No application path is allowed to create this old shape.
    const otherHeader = (await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,'Draft',0.25,0,$3,$4) returning id`, [manualWorker, yesterday, f.organizationId, f.legalEntityId])).rows[0].id;
    await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,work_date,hours,remark,billable)
      values($1,'Client Misc Task','Synthetic legacy context',$2,0.25,'Synthetic retained comment',false)`, [otherHeader, today]);
    const limited = await request('/api/timesheets', {method: 'POST', body: manual(0.75)}); assert.equal(limited.body.code, 'WORK_CAPTURE_WEEKLY_LIMIT');
    const daily = await request('/api/timesheets', {method: 'POST', body: manual(1)}); assert.equal(daily.body.code, 'WORK_CAPTURE_DAILY_LIMIT');
    await assert.rejects(pool.query('update timesheet_entries set hours=0.75 where timesheet_id=$1', [saved.id]), {code: 'WCR04'}, 'future SQL writers cannot bypass aggregates');
    await pool.query('delete from timesheet_entries where timesheet_id=$1', [otherHeader]); await pool.query('delete from timesheets where id=$1', [otherHeader]);
    const submitted = await workPost(request, '/api/timesheets', manual(0.5, 'Synthetic pinned capture', 'Submitted'));
    const retained = (await pool.query('select entries,capture_policy_references from work_submission_evidence where timesheet_id=$1', [submitted.id])).rows[0];
    assert.equal(retained.capture_policy_references[0].reference.id, created.body.id);
    assert.equal(retained.capture_policy_references[0].reference.policyVersion, 'work-capture-rules/1');
    assert.doesNotMatch(JSON.stringify(submitted.work_assurance), /minimumIncrement|comment|maximum|budget|currency/);
    const importWorker = await worker('worker-capture-import');
    const imported = (hours, remark, dryRun = true, versioned = true) => request(versioned ? '/api/v1/imports/timesheets/apply' : '/api/imports/timesheets/apply', {
      method: 'POST', headers: versioned ? {'Idempotency-Key': randomUUID()} : {},
      body: versioned ? workImport(workImportRow(roots.project.id, today, {employeeId: importWorker, hours, remark, status: 'Draft'}), {dryRun})
        : {fileName: 'synthetic-capture-legacy.csv', rows: [workImportRow(roots.project.id, today, {employeeId: importWorker, hours, remark, status: 'Draft'})]},
    });
    for (const versioned of [true, false]) {
      const precise = await imported('0.25000000000000001','Synthetic exact decimal comment',true,versioned);assert.equal(precise.body.validRows,0);assert.equal(precise.body.errors[0].code,'WORK_CAPTURE_INCREMENT');
      const bad = await imported(0.3, 'Synthetic import comment', true, versioned); assert.equal(bad.body.validRows, 0); assert.equal(bad.body.errors[0].code, 'WORK_CAPTURE_INCREMENT');
      const missing = await imported(0.25, '', true, versioned); assert.equal(missing.body.validRows, 0); assert.equal(missing.body.errors[0].code, 'WORK_CAPTURE_COMMENT_REQUIRED');
    }
    assert.equal((await imported(0.25, 'Synthetic quarter-hour comment')).body.validRows, 1);
    assert.equal((await pool.query('select count(*)::int n from timesheets where employee_id=$1', [importWorker])).rows[0].n, 0, 'preview does not write work');
    assert.equal((await imported(0.25, 'Synthetic quarter-hour comment', false)).body.status, 'Success');
    assert.equal((await pool.query('select total_hours::text from timesheets where employee_id=$1', [importWorker])).rows[0].total_hours, '0.25');
    const successorBody={...body,expectedLatestId:created.body.id,effectiveFrom:next,minimumIncrement:'1',weeklyMaximum:'2'};
    const raced=await Promise.all([request(path,{method:'POST',body:successorBody}),request(path,{method:'POST',body:successorBody})]);
    assert.deepEqual(raced.map(result=>result.status).sort(),[201,409],'concurrent appends retain one successor and reject the stale writer');
    const successor=raced.find(result=>result.status===201);
    assert.equal(successor.status, 201); assert.deepEqual((await pool.query('select entries,capture_policy_references from work_submission_evidence where timesheet_id=$1', [submitted.id])).rows[0], retained);
    assert.equal((await request(`/api/timesheets/${submitted.id}/status`, {method: 'PATCH', body: {status: 'Approved'}})).status, 200);
    assert.deepEqual((await pool.query('select to_jsonb(t) value from timesheet_entries t where id=$1', [f.workId])).rows, legacy.filter(row => row.value.id === f.workId));
    // All state assertions use an explicit current policy and synthetic direct
    // SQL legacy shapes. No clock changes, backdating or disabled guards.
    const concurrentWorker=await worker('worker-capture-concurrent');
    const makeHeader=async(employee,ending,legal=f.legalEntityId)=> (await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,'Draft',0.25,0,$3,$4) returning id`,[employee,ending,f.organizationId,legal])).rows[0].id;
    const makeEntry=async(header,date)=> (await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,work_date,hours,remark,billable)
      values($1,'Client Misc Task','Synthetic SQL context',$2,0.25,'Synthetic SQL comment',false) returning id`,[header,date])).rows[0].id;
    const concurrentHeaders=[await makeHeader(concurrentWorker,today),await makeHeader(concurrentWorker,yesterday)];
    const concurrentEntries=[await makeEntry(concurrentHeaders[0],today),await makeEntry(concurrentHeaders[1],today)];
    const aggregateRace=await Promise.allSettled(concurrentEntries.map(id=>pool.query('update timesheet_entries set hours=0.5 where id=$1',[id])));
    assert.equal(aggregateRace.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(aggregateRace.filter(result=>result.status==='rejected'&&result.reason.code==='WCR04').length,1,'serialized SQL writers cannot jointly exceed the Weekly aggregate');
    assert.equal((await pool.query('select sum(hours)::text n from timesheet_entries where timesheet_id=any($1::uuid[])',[concurrentHeaders])).rows[0].n,'0.75');
    // Reparenting checks destination aggregates as well as the old period.
    await pool.query('update timesheet_entries set hours=0.25 where id=any($1::uuid[])',[concurrentEntries]);
    await pool.query('update timesheet_entries set timesheet_id=$2 where id=$1',[concurrentEntries[0],concurrentHeaders[1]]);
    assert.equal((await pool.query('select timesheet_id from timesheet_entries where id=$1',[concurrentEntries[0]])).rows[0].timesheet_id,concurrentHeaders[1]);
    const lockedWorker=await worker('worker-capture-locked-old');
    const lockedHeader=await makeHeader(lockedWorker,today),tomorrow=addUtcDays(today,1);
    const lockedEntry=await makeEntry(lockedHeader,tomorrow);
    await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
      values('capture-old-date-closed',$1,$2,'SYN-CAPTURE-OLD-CLOSED','Synthetic closed old date',$3,$3,'Financially Locked','Monthly')`,[f.organizationId,f.legalEntityId,tomorrow]);
    const lockedBefore=await tableSnapshot(pool,'timesheet_entries'),lockedHeadersBefore=await tableSnapshot(pool,'timesheets');
    for(const [sql,args] of [
      ['delete from timesheet_entries where id=$1',[lockedEntry]],
      ['delete from timesheets where id=$1',[lockedHeader]],
      ['update timesheet_entries set work_date=$2 where id=$1',[lockedEntry,today]],
      ['update timesheet_entries set timesheet_id=$2 where id=$1',[lockedEntry,concurrentHeaders[0]]],
    ])await assert.rejects(pool.query(sql,args),{code:'WCR05'},'old content dates remain protected before last-row removal, cascade, date edit or reparent');
    const replacement={employee_id:lockedWorker,week_ending:today,status:'Draft',entries:[{work_type:'Client Misc Task',client_name:'Synthetic replacement',work_date:today,hours:'0.25',remark:'Synthetic replacement comment',billable:false}]};
    assert.equal((await request('/api/timesheets',{method:'POST',body:replacement})).body.code,'REPORTING_PERIOD_CLOSED');
    for(const dryRun of [true,false]){
      const result=await request('/api/v1/imports/timesheets/apply',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:workImport(workImportRow(null,today,{employeeId:lockedWorker,workType:'Client Misc Task',clientName:'Synthetic replacement',status:'Draft',hours:'0.25',remark:'Synthetic replacement comment'}),{dryRun})});
      assert.equal(result.body.validRows,0);assert.equal(result.body.errors[0].code,'REPORTING_PERIOD_CLOSED');
    }
    assert.deepEqual(await tableSnapshot(pool,'timesheet_entries'),lockedBefore);assert.deepEqual(await tableSnapshot(pool,'timesheets'),lockedHeadersBefore,'all denied old-date writes leave headers and work untouched');
    const decisionHeaders=[];
    for(const suffix of ['direct','generic']){
      const id=await worker(`worker-capture-reject-${suffix}`);
      const submittedDecision=await workPost(request,'/api/timesheets',workInput(roots.project.id,today,{employee_id:id,entries:[{...workInput(roots.project.id,today).entries[0],hours:'0.25',remark:'Synthetic rejection decision comment'}]}));
      decisionHeaders.push(submittedDecision.id);
    }
    const retainedBeforeDecisions=(await pool.query('select to_jsonb(w) value from work_submission_evidence w where timesheet_id=any($1::uuid[]) order by id',[decisionHeaders])).rows;
    await pool.query("update reporting_periods set status='Submission Closed' where id='capture-current'");
    const directReject=await request(`/api/timesheets/${decisionHeaders[0]}/status`,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic correction requested'}});assert.equal(directReject.status,200,JSON.stringify(directReject.body));
    const approval=(await pool.query("select id from approval_records where entity_type='Timesheet' and entity_id=$1",[decisionHeaders[1]])).rows[0];
    const genericReject=await request(`/api/approvals/${approval.id}/status`,{method:'PATCH',body:{status:'Rejected',comments:'Synthetic generic correction requested'}});assert.equal(genericReject.status,200,JSON.stringify(genericReject.body));
    assert.deepEqual((await pool.query('select to_jsonb(w) value from work_submission_evidence w where timesheet_id=any($1::uuid[]) order by id',[decisionHeaders])).rows,retainedBeforeDecisions,'Submission Closed rejection preserves exact captured evidence through both decision paths');
    assert.deepEqual((await pool.query('select status from timesheets where id=any($1::uuid[]) order by id',[decisionHeaders])).rows,[{status:'Rejected'},{status:'Rejected'}]);
    assert.equal((await pool.query("select count(*)::int n from work_submission_decisions d join work_submission_evidence w on w.id=d.submission_id where w.timesheet_id=any($1::uuid[]) and d.status='Rejected'",[decisionHeaders])).rows[0].n,2);
    await assert.rejects(pool.query('delete from timesheets where id=$1',[decisionHeaders[0]]),{code:'WCR05'},'decision permission is not content deletion permission');
    await pool.query("update reporting_periods set status='Financially Locked' where id='capture-current'");
    const locked = await imported(0.25, 'Synthetic locked import', false); assert.equal(locked.body.validRows, 0); assert.equal(locked.body.errors[0].code, 'REPORTING_PERIOD_CLOSED');
  });
});
console.log('Real capture policy PostgreSQL/API fresh/044 upgrade, history, scope, append, precision, replacements, all-header guards, manual/import parity, pinning and locked-period cases passed.');
