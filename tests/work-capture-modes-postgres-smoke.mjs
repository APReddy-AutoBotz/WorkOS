import assert from 'node:assert/strict';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,
  seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday,addUtcDays} from './support/commercial-amendments-test.mjs';
import {grantWorkPermissions,workSnapshot} from './support/work-assignment-test.mjs';
const migration='046_wos04_work_capture_modes';
const table=async(pool,name)=>(await pool.query(`select to_jsonb(t) value from ${name} t order by to_jsonb(t)::text`)).rows;
await withCommercialDatabase(async({pool})=>{
  await withPreCommercialMigrations(async rootDir=>{
    for(const file of ['040_wos04_commercial_drafting_foundation.sql','041_wos04_governed_lifecycle.sql','042_wos04_scoped_client_profiles.sql','043_wos04_governed_amendments.sql','044_wos04_work_submission_evidence.sql','045_wos04_work_capture_policy.sql'])await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
    await runMigrations({pool,rootDir,logger:{log(){}}});await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
    const work=await workSnapshot(pool),grants=await table(pool,'role_permissions');
    for(const row of work.timesheet_entries){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;} // additive 047/048 column
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[migration,'047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity']);
    assert.deepEqual(await workSnapshot(pool),work);assert.deepEqual(await table(pool,'role_permissions'),grants);
    assert.equal((await pool.query('select count(*)::int n from work_capture_mode_versions')).rows[0].n,0);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  });
});
await withCommercialDatabase(async({pool,databaseUrl})=>{
  assert((await migrateCommercialDatabase(pool)).applied.includes(migration));
  await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','timesheets.submit',false) on conflict(role_name,permission_key) do update set enabled=false");
  const today=await amendmentToday(pool),headerDate=addUtcDays(today,2),pastHeader=addUtcDays(today,-5),yesterday=addUtcDays(today,-1);
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('modes-current',$1,$2,'SYN-MODES-CURRENT','Synthetic current',$3::date-4,$3::date+2,'Open','Weekly'),
      ('modes-previous',$1,$2,'SYN-MODES-PREVIOUS','Synthetic previous',$3::date-11,$3::date-5,'Open','Weekly')`,[f.organizationId,f.legalEntityId,today]);
  const worker=async suffix=>{const id=`worker-modes-${suffix}`;await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values($1,$1,'Synthetic modes worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)`,[id,`${id}@example.test`,f.organizationId,f.legalEntityId]);return id;};
  const input=(employeeId,overrides={})=>({employee_id:employeeId,week_ending:headerDate,status:'Draft',entries:[{work_type:'Client Misc Task',client_name:'Synthetic modes context',category:'Synthetic modes category',work_date:today,hours:'0.25000000000000001',remark:'Synthetic modes comment',billable:false}],...overrides});
  await withCommercialApi({databaseUrl,identities,timeZone:'Pacific/Kiritimati'},async({request})=>{
    const path='/api/v1/work-capture-modes',settings=`${path}/settings`;
    assert.equal((await request(settings,{identity:identities.reader})).status,403);
    assert.equal((await request(path,{identity:identities.reader})).status,403);
    assert.equal((await request(path,{scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}})).status,403);
    const neutral=await request(path);assert.equal(neutral.status,200);assert.equal(neutral.body.latestId,null);assert.deepEqual(neutral.body.enabledModes,[]);assert.equal(neutral.body.serverDate,today);
    assert.deepEqual(Object.keys(neutral.body).sort(),['organizationId','legalEntityId','serverDate','latestId','enabledModes'].sort());
    const grants=await table(pool,'role_permissions'),before=await workSnapshot(pool);
    let modes=await request(settings,{method:'POST',body:{expectedLatestId:null,enabledModes:['weekly','daily']}});assert.equal(modes.status,201,JSON.stringify(modes.body));
    assert.deepEqual(await workSnapshot(pool),before);assert.deepEqual(await table(pool,'role_permissions'),grants,'explicit modes do not grant permissions');
    for(const sql of ['update work_capture_mode_versions set enabled_modes=array[\'daily\'] where id=$1','delete from work_capture_mode_versions where id=$1'])await assert.rejects(pool.query(sql,[modes.body.id]),error=>Boolean(error.code));
    const racedSettings=await Promise.all([1,2].map(()=>request(settings,{method:'POST',body:{expectedLatestId:modes.body.id,enabledModes:['daily']}})));
    assert.deepEqual(racedSettings.map(result=>result.status).sort(),[201,409]);modes=racedSettings.find(result=>result.status===201);
    const modeFields={capture_mode:'daily',expected_mode_policy_id:modes.body.id};
    const id=await worker('cas'),create={...input(id),...modeFields,expected_write_token:null};
    let saved=await request('/api/timesheets',{method:'POST',body:create});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.match(saved.body.write_token,/^[a-f0-9]{64}$/);
    let read=(await request('/api/timesheets')).body.find(row=>row.id===saved.body.id);assert.equal(read.write_token,saved.body.write_token);assert.equal(read.entries[0].hours_exact,'0.25000000000000001');
    const stable=await workSnapshot(pool);
    for(const body of [{...create,expected_write_token:null},{...create,capture_mode:'weekly',expected_write_token:saved.body.write_token},{...create,expected_mode_policy_id:'stale-version',expected_write_token:saved.body.write_token}])assert.equal((await request('/api/timesheets',{method:'POST',body})).status,409);
    assert.deepEqual(await workSnapshot(pool),stable,'stale or disabled-mode writes leave all work/evidence/approvals unchanged');
    const auditCount=async()=>(await pool.query("select count(*)::int n from audit_logs where module='Timesheets'")).rows[0].n;
    const audits=await auditCount(),revision=saved.body.write_token;
    const raced=await Promise.all(['first','second'].map(remark=>request('/api/timesheets',{method:'POST',body:{...create,expected_write_token:revision,entries:[{...create.entries[0],remark:`Synthetic ${remark} winner`}]}})));
    assert.deepEqual(raced.map(result=>result.status).sort(),[200,409]);assert.equal(await auditCount(),audits+1,'only accepted replacement produces a work audit');
    saved=raced.find(result=>result.status===200);assert.notEqual(saved.body.write_token,revision);
    assert.equal((await pool.query('select remark from timesheet_entries where timesheet_id=$1',[saved.body.id])).rows[0].remark,saved.body.entries[0].remark);
    const raceWorker=await worker('create-race'),raceInput={...input(raceWorker),...modeFields,expected_write_token:null};
    const creates=await Promise.all([1,2].map(()=>request('/api/timesheets',{method:'POST',body:raceInput})));
    assert.deepEqual(creates.map(result=>result.status).sort(),[200,409]);assert.equal((await pool.query('select count(*)::int n from timesheets where employee_id=$1',[raceWorker])).rows[0].n,1);
    // Full physical revisions notice direct SQL and intentional legacy writers.
    let stale=saved.body.write_token;await pool.query("update timesheet_entries set category='Synthetic SQL edit' where timesheet_id=$1",[saved.body.id]);
    const afterSql=await workSnapshot(pool);assert.equal((await request('/api/timesheets',{method:'POST',body:{...create,expected_write_token:stale}})).body.code,'WORK_CAPTURE_WRITE_CONFLICT');assert.deepEqual(await workSnapshot(pool),afterSql);
    const unconditional=await request('/api/timesheets',{method:'POST',body:input(id)});assert.equal(unconditional.status,200,'full omission intentionally preserves the legacy API contract');
    stale=unconditional.body.write_token;await pool.query("update timesheets set rejection_reason='Synthetic physical header edit' where id=$1",[saved.body.id]);
    assert.equal((await request('/api/timesheets',{method:'POST',body:{...create,expected_write_token:stale}})).body.code,'WORK_CAPTURE_WRITE_CONFLICT');
    const tokenOnly=await request('/api/timesheets',{method:'POST',body:{...input(id),expected_write_token:(await request('/api/timesheets')).body.find(row=>row.id===saved.body.id).write_token}});assert.equal(tokenOnly.status,200,'legacy clients may deliberately opt into token-only CAS');
    const imported=(employeeId,versioned,overrides={},dryRun=false,key=randomUUID())=>{
      const row={employeeId,weekEnding:headerDate,workType:'Client Misc Task',clientName:'Synthetic imported mode context',date:today,hours:'0.25',remark:'Synthetic imported comment',billable:false,status:'Draft',...overrides};
      return request(versioned?'/api/v1/imports/timesheets/apply':'/api/imports/timesheets/apply',{method:'POST',headers:versioned?{'Idempotency-Key':key}:{},body:{fileName:'synthetic-modes.csv',rows:[row],...(versioned?{schemaVersion:'timesheet-import/1',dryRun}:{})}});
    };
    stale=tokenOnly.body.write_token;assert.equal((await imported(id,true)).body.status,'Success');
    assert.equal((await request('/api/timesheets',{method:'POST',body:{...create,expected_write_token:stale}})).body.code,'WORK_CAPTURE_WRITE_CONFLICT','import replacement invalidates manual revision');
    for(const versioned of [false,true]){
      const importer=await worker(`import-${versioned}`);
      if(versioned){const previewBefore=await workSnapshot(pool);assert.equal((await imported(importer,true,{},true)).body.validRows,1);assert.deepEqual(await workSnapshot(pool),previewBefore);}
      const operationKey=randomUUID(),accepted=await imported(importer,versioned,{},false,operationKey);assert.equal(accepted.body.status,'Success',JSON.stringify(accepted.body));
      if(versioned){const acceptedWork=await workSnapshot(pool);assert.equal((await imported(importer,true,{},false,operationKey)).body.status,'Success');assert.deepEqual(await workSnapshot(pool),acceptedWork,'operation replay does not replace work again');}
      const deniedBefore=await workSnapshot(pool);
      for(const override of [{status:'Submitted'},{status:undefined},{date:addUtcDays(today,1),hours:'0'},{date:addUtcDays(headerDate,-7)}]){
        const result=await imported(importer,versioned,override);assert.equal(result.body.validRows,0,JSON.stringify(result.body));
      }
      assert.deepEqual(await workSnapshot(pool),deniedBefore,'both aliases deny future zero work, Submitted/omitted future headers and out-of-header dates without work drift');
    }
    for(const override of [{status:'Submitted'},{entries:[{...create.entries[0],work_date:addUtcDays(today,1),hours:'0'}]},{entries:[{...create.entries[0],work_date:addUtcDays(headerDate,-7)}]}]){
      const freshWorker=await worker(`manual-denied-${randomUUID()}`),unchanged=await workSnapshot(pool);
      assert.equal((await request('/api/timesheets',{method:'POST',body:{...input(freshWorker),...override,...modeFields,expected_write_token:null}})).status,422);assert.deepEqual(await workSnapshot(pool),unchanged);
    }
    const completed=await worker('submitted'),completedInput={...input(completed,{week_ending:pastHeader,status:'Submitted',entries:[{...create.entries[0],work_date:pastHeader,hours:'0.25'}]}),...modeFields,expected_write_token:null};
    const submitted=await request('/api/timesheets',{method:'POST',body:completedInput});assert.equal(submitted.status,200,JSON.stringify(submitted.body));assert.equal(submitted.body.work_assurance.policyVersion,'assignment-work-date/1');
    assert.equal((await pool.query('select count(*)::int n from work_submission_evidence where timesheet_id=$1',[submitted.body.id])).rows[0].n,1);
    assert.equal((await pool.query('select count(*)::int n from approval_records where entity_id=$1',[submitted.body.id])).rows[0].n,1,'one whole-header approval, never daily approval');
    assert.equal((await request(`/api/timesheets/${submitted.body.id}/status`,{method:'PATCH',body:{status:'Approved'}})).status,200);
    assert.equal((await request('/api/timesheets',{method:'POST',body:{...completedInput,expected_write_token:submitted.body.write_token}})).body.code,'WORK_CAPTURE_WRITE_CONFLICT','status changes invalidate physical work revisions');
    // An unrelated closed Monthly date must protect OLD work even when removal
    // would leave only Open NEW dates, including with no capture-rule adoption.
    const oldWorker=await worker('old-period'),oldInput={...input(oldWorker,{entries:[{...create.entries[0],work_date:yesterday,hours:'0.25'}]}),...modeFields,expected_write_token:null};
    const old=await request('/api/timesheets',{method:'POST',body:oldInput});assert.equal(old.status,200);
    await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
      values('modes-old-monthly',$1,$2,'SYN-MODES-OLD','Synthetic closed old date',$3,$3,'Closed','Monthly')`,[f.organizationId,f.legalEntityId,yesterday]);
    const closedBefore=await workSnapshot(pool);
    assert.equal((await request('/api/timesheets',{method:'POST',body:{...input(oldWorker),...modeFields,expected_write_token:old.body.write_token}})).body.code,'REPORTING_PERIOD_CLOSED');
    for(const versioned of [false,true])for(const dryRun of versioned?[true,false]:[false]){const result=await imported(oldWorker,versioned,{},dryRun);assert.equal(result.body.validRows,0);assert.equal(result.body.errors[0].code,'REPORTING_PERIOD_CLOSED');}
    assert.deepEqual(await workSnapshot(pool),closedBefore);
    await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
      values('modes-new-monthly',$1,$2,'SYN-MODES-NEW','Synthetic closed new date',$3,$3,'Closed','Monthly')`,[f.organizationId,f.legalEntityId,today]);
    const newWorker=await worker('new-period'),newBefore=await workSnapshot(pool);
    assert.equal((await request('/api/timesheets',{method:'POST',body:{...input(newWorker),...modeFields,expected_write_token:null}})).body.code,'REPORTING_PERIOD_CLOSED');
    assert.equal((await imported(newWorker,true)).body.validRows,0);assert.deepEqual(await workSnapshot(pool),newBefore);
  });
});
console.log('Fresh capture modes actual PostgreSQL/API acceptance: fresh/045 upgrade/replay, explicit scoped immutable settings, CAS/create races, SQL/import/status invalidation, legacy parity, whole-header submission and OLD/NEW period protection passed.');
