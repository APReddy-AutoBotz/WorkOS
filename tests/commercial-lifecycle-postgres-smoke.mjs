import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runMigrations} from '../server/migrate.mjs';
import {createContract,createEngagement} from '../server/modules/commercial-drafting/service.mjs';
import {COMMERCIAL_MODELS,ENGAGEMENT_MODELS} from '../server/modules/commercial-drafting/contracts.mjs';
import {localDatabaseUrl} from './support/import-audit-journey.mjs';
import {
  commercialFixture as f,commercialPermissions,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,
  migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi,
} from './support/commercial-drafting-test.mjs';

// Required executable real PostgreSQL + real HTTP acceptance. Never launch a
// browser, use a remote database, or convert missing database access into a skip.
assert.throws(()=>localDatabaseUrl(undefined));
for(const url of ['postgres://example.test/test','postgres://localhost/test?host=example.test','postgres://localhost/test?dbname=shared',
  'postgres://localhost/test?service=live','postgres://localhost/test?hostaddr=192.0.2.1','postgres://localhost/test#override'])assert.throws(()=>localDatabaseUrl(url));
const migration040='040_wos04_commercial_drafting_foundation';
const migration041='041_wos04_governed_lifecycle';
const lifecyclePermission='commercial.lifecycle.manage';
const allPermissions=[...commercialPermissions,lifecyclePermission];
const quiet={log(){}};
const fixtureScope={organizationId:f.organizationId,legalEntityId:f.legalEntityId};
const protectedMarker='SYNTHETIC-PROTECTED-LIFECYCLE-57BD';
const todayFor=async pool=>(await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
const datesFor=today=>({startsOn:`${Number(today.slice(0,4))-1}-01-01`,endsOn:`${Number(today.slice(0,4))+2}-12-31`,
  future:`${Number(today.slice(0,4))+1}-01-01`,expired:`${Number(today.slice(0,4))-1}-12-31`});
const contractInput=(dates,code,model='time_and_materials',overrides={})=>({number:code,clientId:f.clientId,name:`Synthetic ${model} agreement`,model,
  startsOn:dates.startsOn,endsOn:dates.endsOn,effectiveFrom:dates.startsOn,currency:'USD',value:'99999999999999.9999',
  billingTerms:`${protectedMarker} synthetic terms`,documents:[{name:'Synthetic metadata',url:'https://example.test/synthetic-lifecycle.pdf'}],
  reason:`${protectedMarker} create agreement`,...overrides});
const engagementInput=(dates,code,contract,overrides={})=>({code,name:`Synthetic ${code} engagement`,model:contract?.versions[0].model||'internal',
  ownerId:f.ownerId,startsOn:dates.startsOn,endsOn:dates.endsOn,currency:'USD',budget:contract?'1.0000':'0.0000',
  clientId:contract?f.clientId:null,contractId:contract?.id||null,contractVersionId:contract?.versions[0].id||null,
  attributionId:contract?null:f.businessUnitId,reason:`${protectedMarker} create engagement`,...overrides});
const projectInput=(dates,code,engagement,overrides={})=>({engagementId:engagement.id,projectId:null,code,name:`Synthetic ${code} project`,managerId:f.ownerId,
  startsOn:dates.startsOn,endsOn:dates.endsOn,billable:engagement.billable,budgetAllocation:engagement.billable?'0.0001':'0.0000',
  reason:`${protectedMarker} create project`,...overrides});
const transitionInput=(sequence,versionId=null,state='Active',overrides={})=>({expectedSequence:sequence,state,contractVersionId:versionId,
  reason:`${protectedMarker} ${state} transition`,approvalReference:null,...overrides});
const created=async(request,path,body,options={})=>{
  const result=await request(path,{method:'POST',body,...options});
  assert.equal(result.status,201,`${path}: ${JSON.stringify(result.body)}`);assert.ok(result.body.id);return result.body;
};
const changed=async(request,type,id,sequence,version=null,state='Active',options={})=>{
  const result=await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:transitionInput(sequence,version,state),...options});
  assert.equal(result.status,201,`${type}/${id} ${state}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.sequence,sequence+1);assert.equal(result.body.state,state);assert.equal(result.body.contractVersionId,version);return result;
};
const assertError=(result,status,code)=>{
  assert.equal(result.status,status,`${code}: ${JSON.stringify(result.body)}`);assert.equal(result.body?.error?.code,code);
  assert.ok(result.body.error.message);assert.equal(result.body.id,undefined);
  if(new URL(result.response.url).pathname.startsWith('/api/v1/')){
    assert.ok(result.response.headers.get('x-correlation-id'));assert.equal(result.body.error.correlationId,result.response.headers.get('x-correlation-id'));
    if(result.response.headers.get('x-operation-id'))assert.equal(result.body.error.operationId,result.response.headers.get('x-operation-id'));
  }
  assert.doesNotMatch(JSON.stringify(result.body),/postgres(?:ql)?:\/\/|insert into|select .* from|constraint .* violates/i,'safe errors never expose persistence details');
};
const snapshot=async(pool,tables)=>{
  const result={};for(const table of tables)result[table]=(await pool.query(`select to_jsonb(t) snapshot from ${table} t order by to_jsonb(t)::text`)).rows;
  return result;
};
const draftTables=['commercial_contracts','commercial_contract_versions','commercial_engagements','commercial_purchase_orders','commercial_milestones','commercial_draft_events','project_engagement_mappings'];
const legacyTables=['clients','employees','projects','project_allocations','timesheets','timesheet_entries'];
const counts=async pool=>(await pool.query(`select
  (select count(*)::int from projects) projects,(select count(*)::int from commercial_project_bindings) bindings,
  (select count(*)::int from commercial_lifecycle_events) events,(select count(*)::int from commercial_draft_events) drafts,
  (select count(*)::int from audit_logs) audits,(select count(*)::int from import_export_logs) imports,
  (select count(*)::int from import_export_idempotency) idempotency`)).rows[0];
const rejectSql=async(pool,sql,values,code)=>assert.rejects(pool.query(sql,values),error=>{assert.equal(error.code,code);return true;});
const cloneRow=async(pool,table,row,overrides={})=>{
  const copy={...row,...overrides},keys=Object.keys(copy);
  const values=keys.map(key=>['source_snapshot','before_value','after_value'].includes(key)&&copy[key]!==null?JSON.stringify(copy[key]):copy[key]);
  return pool.query(`insert into ${table}(${keys.map(key=>`"${key}"`).join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
};
const rejectClone=async(pool,table,row,overrides,code)=>assert.rejects(cloneRow(pool,table,row,overrides),error=>{assert.equal(error.code,code);return true;});
const defaults=async pool=>{
  assert.deepEqual((await pool.query(`select permission_key from permission_definitions where permission_key=any($1::text[]) order by permission_key`,[allPermissions])).rows.map(x=>x.permission_key),[...allPermissions].sort());
  assert.equal((await pool.query(`select count(*)::int count from role_permissions where permission_key=any($1::text[]) and enabled`,[allPermissions])).rows[0].count,0);
  assert.equal((await pool.query(`select count(*)::int count from user_permission_grants where permission_key=any($1::text[])`,[allPermissions])).rows[0].count,0);
};
const grantLifecycle=async pool=>pool.query(`insert into role_permissions(role_name,permission_key,enabled) values ('Admin',$1,true)
  on conflict(role_name,permission_key) do update set enabled=excluded.enabled`,[lifecyclePermission]);
const seedProposal=async(pool,input,{id=`project-${randomUUID()}`,clientId=f.clientId,managerId=f.ownerId,status='Proposed',scope=fixtureScope}={})=>{
  await pool.query(`insert into projects(id,organization_id,legal_entity_id,project_code,name,client_id,client,manager_id,manager_name,
    project_type,billable,start_date,end_date,status) values($1,$2,$3,$4,$5,$6,'Synthetic commercial local client',$7,'Synthetic commercial owner',
    'Synthetic legacy model',$8,$9,$10,$11)`,[id,scope.organizationId,scope.legalEntityId,input.code,input.name,clientId,managerId,input.billable,input.startsOn,input.endsOn,status]);
  return id;
};
const history=async(request,type,id,options={})=>{
  const result=await request(`/lifecycle/${type}/${id}/history`,options);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.entityType,type);assert.equal(result.body.entityId,id);assert.equal(result.body.limit,200);return result.body.events;
};

// Upgrade from the exact 040 installation, including existing immutable manual
// drafts, neutral mappings and old approved work, not merely an empty database.
await withCommercialDatabase(async({pool,databaseUrl})=>{
  const today=await todayFor(pool),dates=datesFor(today);
  await withPreCommercialMigrations(async rootDir=>{
    const baseline=await runMigrations({pool,rootDir,logger:quiet});assert.equal(baseline.status.currentVersion,'039_wos03_import_operation_contract');
    await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
    const proposalInput=projectInput(dates,'SYN-UPGRADE-PROMOTION',{id:'pending',billable:true},{budgetAllocation:'0.0000'});
    const proposedId=await seedProposal(pool,proposalInput);
    const oldLegacy=await snapshot(pool,legacyTables);
    for(const row of oldLegacy.timesheet_entries){row.snapshot.evidence_url=null;row.snapshot.work_reference=null;row.snapshot.source_identity=null;} // additive 047/048 column
    await copyFile(join(commercialServerDir,'migrations',`${migration040}.sql`),join(rootDir,'migrations',`${migration040}.sql`));
    const before041=await runMigrations({pool,rootDir,logger:quiet});assert.deepEqual(before041.applied,[migration040]);
    const identities=await seedCommercialIdentities(pool);
    const req={user:{sub:identities.manager.id,activeRole:'Admin'},organizationScope:fixtureScope,correlationId:'synthetic-upgrade',operationId:'synthetic-upgrade-040'};
    const client=await pool.connect();let contract,engagement;
    try{
      await client.query('begin');
      contract=await createContract(client,req,contractInput(dates,'SYN-UPGRADE-CONTRACT'),async()=>{});
      engagement=await createEngagement(client,req,engagementInput(dates,'SYN-UPGRADE-ENGAGEMENT',contract),async()=>{});
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
    const immutable040=await snapshot(pool,draftTables);
    const upgraded=await migrateCommercialDatabase(pool);assert.deepEqual(upgraded.applied,[migration041,'042_wos04_scoped_client_profiles','043_wos04_governed_amendments', '044_wos04_work_submission_evidence','045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity']);assert.equal(upgraded.status.isCurrent,true);
    assert.deepEqual(await snapshot(pool,legacyTables),oldLegacy,'041 upgrade must not change old project/work/client/employee identities or fields');
    assert.deepEqual(await snapshot(pool,draftTables),immutable040,'041 upgrade never converts or edits 040 drafts, terms, events or neutral mappings');
    assert.equal((await counts(pool)).events,0);assert.equal((await counts(pool)).bindings,0);
    assert.equal((await pool.query(`select count(*)::int count from role_permissions where permission_key=$1 and enabled`,[lifecyclePermission])).rows[0].count,0);
    assert.equal((await pool.query(`select count(*)::int count from user_permission_grants where permission_key=$1`,[lifecyclePermission])).rows[0].count,0);
    const replay=await migrateCommercialDatabase(pool);assert.deepEqual(replay.applied,[]);
    assert.deepEqual(await snapshot(pool,draftTables),immutable040);assert.deepEqual(await snapshot(pool,legacyTables),oldLegacy);
    await grantLifecycle(pool);
    await withCommercialApi({databaseUrl,identities,timeZone:'America/Los_Angeles'},async({request})=>{
      const pin=contract.versions[0].id;
      await changed(request,'Contract',contract.id,0,pin);await changed(request,'Engagement',engagement.id,0,pin);
      const promoted=await created(request,'/lifecycle/projects',{...proposalInput,projectId:proposedId,engagementId:engagement.id});
      assert.equal(promoted.id,proposedId);assert.equal(promoted.origin,'explicit-legacy-promotion');assert.equal(promoted.lifecycle.state,'Active');
      assert.deepEqual(await snapshot(pool,draftTables),immutable040,'explicit binding coexists with and never edits the original neutral mapping and snapshot');
      const projected=(await pool.query('select status from projects where id=$1',[proposedId])).rows[0];assert.equal(projected.status,'Active');
      const nowLegacy=await snapshot(pool,legacyTables);
      for(const table of legacyTables.filter(x=>x!=='projects'))assert.deepEqual(nowLegacy[table],oldLegacy[table]);
      const oldProject=oldLegacy.projects.find(x=>x.snapshot.id===proposedId).snapshot;
      const newProject=nowLegacy.projects.find(x=>x.snapshot.id===proposedId).snapshot;
      for(const key of Object.keys(oldProject).filter(x=>!['status','updated_at'].includes(x)))assert.deepEqual(newProject[key],oldProject[key]);
      assertError(await request(`/lifecycle/Engagement/legacy-engagement-${proposedId}/history`),404,'COMMERCIAL_NOT_FOUND');
      assertError(await request('/lifecycle/projects',{method:'POST',body:{...proposalInput,projectId:f.projectId,engagementId:engagement.id}}),409,'COMMERCIAL_LEGACY_PROMOTION_MISMATCH');
    });
    assert.deepEqual((await pool.query('select to_jsonb(e) snapshot from timesheet_entries e order by id')).rows,oldLegacy.timesheet_entries,'approved historical work must remain byte-for-byte equivalent');
  });
});

await withCommercialDatabase(async({pool,databaseUrl})=>{
  const installed=await migrateCommercialDatabase(pool);assert.equal(installed.status.isCurrent,true);assert.ok(installed.applied.includes(migration040));assert.ok(installed.applied.includes(migration041));
  await defaults(pool);assert.equal((await counts(pool)).bindings,0);assert.equal((await counts(pool)).events,0);
  await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantLifecycle(pool);
  // Explicit grants exist only inside this randomized local fixture. No roles
  // are removed, no live authorization configuration or diagnostics are touched.
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    select 'Admin',key,true from unnest($1::text[]) key on conflict(role_name,permission_key) do update set enabled=true`,
  [['projects.manage','projects.status_update','imports.manage','clients.manage']]);
  const today=await todayFor(pool),dates=datesFor(today);
  const immutableLegacy=await snapshot(pool,['project_allocations','timesheets','timesheet_entries']);
  await withCommercialApi({databaseUrl,identities,timeZone:'Pacific/Honolulu'},async({request})=>{
    assertError(await request('/lifecycle/workspace',{authenticated:false}),401,'AUTHENTICATION_REQUIRED');
    for(const path of ['/lifecycle/workspace','/lifecycle/Engagement/missing/history','/lifecycle/Engagement/missing/readiness'])
      assertError(await request(path,{identity:identities.denied}),403,'COMMERCIAL_PERMISSION_DENIED');
    assertError(await request('/lifecycle/workspace',{scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}}),403,'ORG_SCOPE_DENIED');
    assertError(await request('/lifecycle/workspace',{scope:{organizationId:f.otherOrganizationId,legalEntityId:f.foreignLegalEntityId}}),403,'ORG_SCOPE_DENIED');
    const empty=await request('/lifecycle/workspace',{identity:identities.reader});assert.equal(empty.status,200);
    assert.deepEqual(empty.body.contracts,[]);assert.deepEqual(empty.body.engagements,[]);assert.deepEqual(empty.body.projects,[]);
    assert.equal(empty.body.asOf,today);assert.equal(empty.body.closure.available,false);assert.ok(empty.body.closure.unavailableEvidence.length>=3);
    assert.match(empty.body.closure.message,/unknown|unavailable/i);
    assert.equal(empty.body.closure.unbilledAmount,undefined,'unimplemented closure evidence is not a computed zero');
    assert.equal(empty.body.limits.pageSize,200);for(const flag of Object.values(empty.body.limits.truncated))assert.equal(flag,false);
    assert.deepEqual(empty.body.choices.owners.map(x=>x.id),[f.ownerId]);
    for(const query of ['?asOf=2026-10-20','?organizationId=forged','?legalEntityId=forged','?limit=999','?state=Active'])
      assertError(await request(`/lifecycle/workspace${query}`),400,'COMMERCIAL_INVALID_REQUEST');
    assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,'SYN-DENIED',{id:'missing',billable:false}),identity:identities.reader}),403,'COMMERCIAL_PERMISSION_DENIED');
    assertError(await request('/lifecycle/Engagement/missing/transitions',{method:'POST',body:transitionInput(0),identity:identities.reader}),403,'COMMERCIAL_PERMISSION_DENIED');
    // Old draft management never silently opts a role into lifecycle authority.
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.contracts.manage',true)
      on conflict(role_name,permission_key) do update set enabled=true`);
    const draftOnly=await created(request,'/engagements',engagementInput(dates,'SYN-DRAFT-ONLY',null),{identity:identities.reader});
    assertError(await request(`/lifecycle/Engagement/${draftOnly.id}/transitions`,{method:'POST',body:transitionInput(0),identity:identities.reader}),403,'COMMERCIAL_PERMISSION_DENIED');

    let primary;
    const models=[];
    for(const model of ENGAGEMENT_MODELS){
      const code=`SYN-${model.toUpperCase()}`;
      const contract=COMMERCIAL_MODELS.includes(model)?await created(request,'/contracts',contractInput(dates,`${code}-CONTRACT`,model)):null;
      const engagement=await created(request,'/engagements',engagementInput(dates,`${code}-ENGAGEMENT`,contract,
        {model,...(model==='pre_sales'?{attributionId:f.costCentreId}:{})}));
      const version=engagement.contractVersionId;
      const unchangedDrafts=await snapshot(pool,draftTables);
      assertError(await request(`/lifecycle/Engagement/${engagement.id}/transitions`,{method:'POST',body:transitionInput(0,version,'On Hold')}),409,'COMMERCIAL_INVALID_TRANSITION');
      assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,`${code}-BEFORE-ACTIVE`,engagement)}),409,'COMMERCIAL_PARENT_NOT_ACTIVE');
      if(contract){
        assertError(await request(`/lifecycle/Engagement/${engagement.id}/transitions`,{method:'POST',body:transitionInput(0,version)}),409,'COMMERCIAL_PARENT_NOT_ACTIVE');
        assertError(await request(`/lifecycle/Contract/${contract.id}/transitions`,{method:'POST',body:transitionInput(0,'not-a-version')}),422,'COMMERCIAL_PIN_CONFLICT');
        await changed(request,'Contract',contract.id,0,version);
      }
      await changed(request,'Engagement',engagement.id,0,version);
      assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,`${code}-CROSS-MANAGER`,engagement,{managerId:f.otherOwnerId})}),422,'COMMERCIAL_OWNER_UNAVAILABLE');
      assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,`${code}-BAD-DATES`,engagement,{startsOn:`${Number(today.slice(0,4))-2}-01-01`})}),422,'COMMERCIAL_TERMS_MISMATCH');
      if(!contract){
        for(const delta of [{billable:true},{budgetAllocation:'0.0001'}])assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,`${code}-INTERNAL-NEGATIVE`,engagement,delta)}),422,'COMMERCIAL_INTERNAL_POLICY');
      }
      const project=await created(request,'/lifecycle/projects',projectInput(dates,`${code}-PROJECT`,engagement));
      assert.equal(project.engagementId,engagement.id);assert.equal(project.model,model);assert.equal(project.billable,Boolean(contract));
      assert.equal(project.budgetAllocation,contract?'0.0001':'0.0000');assert.equal(project.contractVersionId,version);
      assert.equal(project.attributionId,engagement.attributionId);assert.equal(project.origin,'manual');
      assert.equal(project.lifecycle.state,'Active');assert.equal(project.lifecycle.sequence,1);assert.equal(project.lifecycle.effectiveOn,today);
      assert.equal(project.lifecycle.actorId,identities.manager.id);assert.equal(project.lifecycle.activeRole,'Admin');
      assert.equal((await pool.query('select status from projects where id=$1',[project.id])).rows[0].status,'Active');
      assert.deepEqual(await snapshot(pool,draftTables),unchangedDrafts,'activation and project binding never mutate the immutable drafting ledger or Draft statuses');
      for(const [type,id] of [['Engagement',engagement.id],['Project',project.id],...(contract?[['Contract',contract.id]]:[])]){
        const events=await history(request,type,id,{identity:identities.reader});assert.equal(events.length,1);assert.equal(events[0].state,'Active');assert.equal(events[0].sequence,1);
        assert.equal(events[0].actorId,identities.manager.id);assert.equal(events[0].effectiveOn,today);assert.ok(events[0].correlationId);assert.ok(events[0].operationId);
        assertError(await request(`/lifecycle/${type}/${id}/history?organizationId=forged`),400,'COMMERCIAL_INVALID_REQUEST');
      }
      models.push({model,contract,engagement,project});if(model==='time_and_materials')primary=models.at(-1);
    }
    assert.equal(models.length,7);
    const {contract,engagement,project}=primary;const pin=engagement.contractVersionId;
    const draftState=await snapshot(pool,draftTables);
    for(const [type,id] of [['Contract',contract.id],['Engagement',engagement.id],['Project',project.id]]){
      assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:transitionInput(1,pin)}),409,'COMMERCIAL_INVALID_TRANSITION');
      assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:transitionInput(0,pin,'On Hold')}),409,'COMMERCIAL_LIFECYCLE_CONFLICT');
      assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:transitionInput(1,'forged-version','On Hold')}),409,'COMMERCIAL_PIN_CONFLICT');
      for(const [key,value] of Object.entries({actorId:identities.denied.id,organizationId:f.otherOrganizationId,legalEntityId:f.otherLegalEntityId,
        effectiveOn:'2000-01-01',activeRole:'Admin',createdBy:identities.denied.id,billingEligible:true,source:'Migration'})){
        assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:{...transitionInput(1,pin,'On Hold'),[key]:value}}),400,'COMMERCIAL_INVALID_REQUEST');
      }
      assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',body:transitionInput(1,pin,'Completed')}),400,'COMMERCIAL_INVALID_REQUEST');
      const noClose=await request(`/lifecycle/${type}/${id}/close`,{method:'POST',body:{reason:'Synthetic closure'}});assert.equal(noClose.status,404);
    }
    const beforeDenials=await counts(pool);
    for(const [key,value] of Object.entries({actorId:identities.denied.id,organizationId:f.otherOrganizationId,legalEntityId:f.otherLegalEntityId,
      status:'Active',contractVersionId:pin,model:'internal',currency:'XXX',attributionId:f.foreignAttributionId,billingEligible:true}))
      assertError(await request('/lifecycle/projects',{method:'POST',body:{...projectInput(dates,'SYN-FORGED-PROJECT',engagement),[key]:value}}),400,'COMMERCIAL_INVALID_REQUEST');
    assert.deepEqual(await counts(pool),beforeDenials,'invalid client authority fields create no entity, audit or ledger evidence');
    for(const invalidAttribution of [null,f.inactiveAttributionId,f.expiredAttributionId,f.futureAttributionId,f.otherAttributionId,f.foreignAttributionId,f.invalidTypeAttributionId]){
      const result=await request('/engagements',{method:'POST',body:engagementInput(dates,'SYN-INTERNAL-ATTRIBUTION',null,{attributionId:invalidAttribution})});
      assertError(result,invalidAttribution===null?422:404,invalidAttribution===null?'COMMERCIAL_INTERNAL_POLICY':'COMMERCIAL_REFERENCE_NOT_FOUND');
    }
    // Active children are never silently cascaded on hold.
    assertError(await request(`/lifecycle/Engagement/${engagement.id}/transitions`,{method:'POST',body:transitionInput(1,pin,'On Hold')}),409,'COMMERCIAL_ACTIVE_DEPENDENCIES');
    assertError(await request(`/lifecycle/Contract/${contract.id}/transitions`,{method:'POST',body:transitionInput(1,pin,'On Hold')}),409,'COMMERCIAL_ACTIVE_DEPENDENCIES');
    assert.equal((await history(request,'Project',project.id)).length,1);
    await changed(request,'Project',project.id,1,pin,'On Hold');await changed(request,'Engagement',engagement.id,1,pin,'On Hold');
    await changed(request,'Contract',contract.id,1,pin,'On Hold');
    assertError(await request(`/lifecycle/Project/${project.id}/transitions`,{method:'POST',body:transitionInput(2,pin)}),409,'COMMERCIAL_PARENT_NOT_ACTIVE');
    assertError(await request(`/lifecycle/Engagement/${engagement.id}/transitions`,{method:'POST',body:transitionInput(2,pin)}),409,'COMMERCIAL_PARENT_NOT_ACTIVE');
    await changed(request,'Contract',contract.id,2,pin);await changed(request,'Engagement',engagement.id,2,pin);await changed(request,'Project',project.id,2,pin);
    const concurrent=await Promise.all([1,2].map(()=>request(`/lifecycle/Project/${project.id}/transitions`,{method:'POST',body:transitionInput(3,pin,'On Hold')})));
    assert.deepEqual(concurrent.map(x=>x.status).sort(),[201,409]);assertError(concurrent.find(x=>x.status===409),409,'COMMERCIAL_LIFECYCLE_CONFLICT');
    let events=await history(request,'Project',project.id);assert.deepEqual(events.map(x=>x.sequence),[4,3,2,1]);
    await changed(request,'Project',project.id,4,pin);
    assert.deepEqual(await snapshot(pool,draftTables),draftState,'all lifecycle transitions leave immutable 040 draft content and neutral mappings intact');

    // Future contract terms never replace active immutable pins.
    const first=contract.versions[0];const {id:_id,version:_version,...terms}=first;
    const revision=await created(request,`/contracts/${contract.id}/versions`,{...terms,expectedVersion:1,effectiveFrom:dates.future,
      value:'2.0000',reason:`${protectedMarker} future revision`});
    assert.equal(revision.latestVersion,2);
    assert.equal((await history(request,'Project',project.id))[0].contractVersionId,pin);
    assertError(await request(`/lifecycle/Contract/${contract.id}/transitions`,{method:'POST',body:transitionInput(3,revision.versions[0].id,'On Hold')}),409,'COMMERCIAL_PIN_CONFLICT');

    // Current UTC date is authoritative even under a non-UTC API process TZ.
    const futureContract=await created(request,'/contracts',contractInput(dates,'SYN-FUTURE-CONTRACT','fixed_fee',{startsOn:dates.future,effectiveFrom:dates.future}));
    assertError(await request(`/lifecycle/Contract/${futureContract.id}/transitions`,{method:'POST',body:transitionInput(0,futureContract.versions[0].id)}),409,'COMMERCIAL_TERMS_SUPERSEDED');
    const expiredContract=await created(request,'/contracts',contractInput(dates,'SYN-EXPIRED-CONTRACT','fixed_fee',{endsOn:dates.expired}));
    assertError(await request(`/lifecycle/Contract/${expiredContract.id}/transitions`,{method:'POST',body:transitionInput(0,expiredContract.versions[0].id)}),409,'COMMERCIAL_INACTIVE_DATES');
    const futureEngagement=await created(request,'/engagements',engagementInput(dates,'SYN-FUTURE-INTERNAL',null,{startsOn:dates.future}));
    assertError(await request(`/lifecycle/Engagement/${futureEngagement.id}/transitions`,{method:'POST',body:transitionInput(0)}),409,'COMMERCIAL_INACTIVE_DATES');
    assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,'SYN-FUTURE-PROJECT',engagement,{startsOn:dates.future})}),409,'COMMERCIAL_INACTIVE_DATES');

    // A once-active parent ledger is not a bypass for changed current master
    // references. Separate manager and engagement owner prove both are checked.
    const alternateManager='employee-lifecycle-alternate-manager';
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values($1,'SYN-LIFECYCLE-ALTERNATE','Synthetic alternate manager','lifecycle-alternate@example.test','Manager','Delivery','US','director-commercial','Active',$2,$3)`,
    [alternateManager,f.organizationId,f.legalEntityId]);
    const internal=models.find(x=>x.model==='internal');
    const revalidationInput=projectInput(dates,'SYN-REVALIDATE-PROJECT',internal.engagement,{managerId:alternateManager});
    const revalidationProject=await created(request,'/lifecycle/projects',revalidationInput);
    await changed(request,'Project',revalidationProject.id,1,null,'On Hold');
    for(const [table,column,value,restore,target] of [
      ['organization_catalog_items','active',false,true,f.businessUnitId],
      ['organization_catalog_items','effective_to','2000-01-01',null,f.businessUnitId],
      ['employees','status','Exited','Active',f.ownerId],
      ['employees','joining_date',dates.future,null,f.ownerId],
      ['employees','exit_date',dates.expired,null,f.ownerId],
    ]){
      await pool.query(`update ${table} set ${column}=$1 where id=$2`,[value,target]);
      try{
        const before=await counts(pool);
        assertError(await request('/lifecycle/projects',{method:'POST',body:{...revalidationInput,code:'SYN-INVALIDATED-PARENT',projectId:null}}),404,'COMMERCIAL_REFERENCE_NOT_FOUND');
        assertError(await request(`/lifecycle/Project/${revalidationProject.id}/transitions`,{method:'POST',body:transitionInput(2)}),404,'COMMERCIAL_REFERENCE_NOT_FOUND');
        assert.deepEqual(await counts(pool),before);
        assert.equal((await pool.query('select status from projects where id=$1',[revalidationProject.id])).rows[0].status,'On Hold');
      }finally{await pool.query(`update ${table} set ${column}=$1 where id=$2`,[restore,target]);}
    }
    await changed(request,'Project',revalidationProject.id,2);
    const currentClientInput=projectInput(dates,'SYN-CLIENT-REVALIDATE',engagement,{budgetAllocation:'0.0000'});
    const currentClientProject=await created(request,'/lifecycle/projects',currentClientInput);
    await changed(request,'Project',currentClientProject.id,1,pin,'On Hold');
    const inactivePromotionInput=projectInput(dates,'SYN-INACTIVE-CLIENT-PROMOTE',engagement,{budgetAllocation:'0.0000'});
    const inactivePromotionId=await seedProposal(pool,inactivePromotionInput);
    await pool.query(`update clients set status='Inactive' where id=$1`,[f.clientId]);
    try{
      const before=await counts(pool);
      assertError(await request('/lifecycle/projects',{method:'POST',body:{...currentClientInput,code:'SYN-INACTIVE-CLIENT-MANUAL'}}),404,'COMMERCIAL_REFERENCE_NOT_FOUND');
      assertError(await request('/lifecycle/projects',{method:'POST',body:{...inactivePromotionInput,projectId:inactivePromotionId}}),404,'COMMERCIAL_REFERENCE_NOT_FOUND');
      assertError(await request(`/lifecycle/Project/${currentClientProject.id}/transitions`,{method:'POST',body:transitionInput(2,pin)}),404,'COMMERCIAL_REFERENCE_NOT_FOUND');
      assert.deepEqual(await counts(pool),before);
    }finally{await pool.query(`update clients set status='Active' where id=$1`,[f.clientId]);}
    await changed(request,'Project',currentClientProject.id,2,pin);

    // Numeric(18,4), exact decimal boundary and shared lock prevent aggregate
    // allocation races. The loser leaves no orphan project/binding/audit/event.
    const budgetEngagement=await created(request,'/engagements',engagementInput(dates,'SYN-BUDGET-RACE',contract,{budget:'0.0001'}));
    await changed(request,'Engagement',budgetEngagement.id,0,pin);
    const budgetBefore=await counts(pool);
    const budgetResults=await Promise.all(['A','B'].map(suffix=>request('/lifecycle/projects',{method:'POST',body:projectInput(dates,`SYN-BUDGET-${suffix}`,budgetEngagement)})));
    assert.deepEqual(budgetResults.map(x=>x.status).sort(),[201,422]);assertError(budgetResults.find(x=>x.status===422),422,'COMMERCIAL_PROJECT_BUDGET_EXCEEDED');
    const budgetAfter=await counts(pool);for(const key of ['projects','bindings','events','audits'])assert.equal(budgetAfter[key],budgetBefore[key]+1);
    assert.equal((await pool.query(`select sum(budget_allocation)::text total from commercial_project_bindings where engagement_id=$1`,[budgetEngagement.id])).rows[0].total,'0.0001');
    const loserCode=budgetResults[0].status===422?'SYN-BUDGET-A':'SYN-BUDGET-B';assert.equal((await pool.query('select count(*)::int count from projects where project_code=$1',[loserCode])).rows[0].count,0);

    // Exact Proposed legacy promotion, including duplicate-bind concurrency.
    const promotionInput=projectInput(dates,'SYN-PROMOTE-RACE',engagement,{budgetAllocation:'0.0000'});
    const promotionId=await seedProposal(pool,promotionInput);const promotionBefore=await counts(pool);
    const promotion=await Promise.all([1,2].map(()=>request('/lifecycle/projects',{method:'POST',body:{...promotionInput,projectId:promotionId}})));
    assert.deepEqual(promotion.map(x=>x.status).sort(),[201,409]);assertError(promotion.find(x=>x.status===409),409,'COMMERCIAL_PROJECT_ALREADY_GOVERNED');
    const promotionAfter=await counts(pool);assert.equal(promotionAfter.projects,promotionBefore.projects);for(const key of ['bindings','events','audits'])assert.equal(promotionAfter[key],promotionBefore[key]+1);
    const successfulPromotion=promotion.find(x=>x.status===201).body;assert.equal(successfulPromotion.id,promotionId);assert.equal(successfulPromotion.origin,'explicit-legacy-promotion');
    assert.equal((await pool.query('select count(*)::int count from project_engagement_mappings where project_id=$1',[promotionId])).rows[0].count,0,'later promotion does not fabricate a migration mapping');
    await pool.query(`insert into clients(id,name,account_owner_id,status,organization_id,legal_entity_id) values('client-lifecycle-alternate','Synthetic alternate local client',$1,'Active',$2,$3)`,[f.ownerId,f.organizationId,f.legalEntityId]);
    for(const [suffix,rowOverrides,inputOverrides] of [
      ['ACTIVE',{status:'Active'},{}],['NAME',{}, {name:'Synthetic changed project'}],['CODE',{}, {code:'SYN-PROMOTE-WRONG-CODE'}],
      ['START',{}, {startsOn:today}],['END',{}, {endsOn:today}],['BILLABLE',{}, {billable:false}],['CLIENT',{clientId:'client-lifecycle-alternate'},{}],
    ]){
      const input=projectInput(dates,`SYN-PROMOTE-${suffix}`,engagement,{budgetAllocation:'0.0000'});
      const id=await seedProposal(pool,input,rowOverrides);const before=await counts(pool);
      assertError(await request('/lifecycle/projects',{method:'POST',body:{...input,projectId:id,...inputOverrides}}),409,'COMMERCIAL_LEGACY_PROMOTION_MISMATCH');
      assert.deepEqual(await counts(pool),before,'failed promotion leaves the legacy project unchanged');
    }
    for(const kind of ['allocation','work']){
      const input=projectInput(dates,`SYN-HISTORY-${kind.toUpperCase()}`,engagement,{budgetAllocation:'0.0000'});const id=await seedProposal(pool,input);
      if(kind==='allocation')await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
        values($1,$2,$3,10,$4,$5,true,'Completed',$6,$7)`,[`allocation-${randomUUID()}`,f.ownerId,id,dates.startsOn,dates.endsOn,f.organizationId,f.legalEntityId]);
      else await pool.query(`insert into timesheet_entries(id,timesheet_id,project_id,work_type,work_date,hours,remark,billable)
        values($1,$2,$3,'Project Work','2020-03-08',1,'Synthetic prior evidence',true)`,[randomUUID(),f.timesheetId,id]);
      const before=await counts(pool);assertError(await request('/lifecycle/projects',{method:'POST',body:{...input,projectId:id}}),409,'COMMERCIAL_LEGACY_HISTORY_PRESENT');
      assert.deepEqual(await counts(pool),before);
    }

    // Authorized alternate scopes prove server row isolation, not merely header
    // rejection. Empty reads must not leak IDs, names, lifecycle or history.
    const alternateScopes=[{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},{organizationId:f.otherOrganizationId,legalEntityId:f.foreignLegalEntityId}];
    for(const scope of alternateScopes){
      await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)`,[identities.manager.id,scope.organizationId,scope.legalEntityId]);
      let workspace=await request('/lifecycle/workspace',{scope});assert.equal(workspace.status,200);assert.deepEqual(workspace.body.contracts,[]);assert.deepEqual(workspace.body.engagements,[]);assert.deepEqual(workspace.body.projects,[]);
      for(const [type,id] of [['Contract',contract.id],['Engagement',engagement.id],['Project',project.id]]){
        for(const suffix of ['history','readiness'])assertError(await request(`/lifecycle/${type}/${id}/${suffix}`,{scope}),404,'COMMERCIAL_NOT_FOUND');
        assertError(await request(`/lifecycle/${type}/${id}/transitions`,{method:'POST',scope,body:transitionInput(0,pin)}),404,'COMMERCIAL_NOT_FOUND');
      }
      assertError(await request('/lifecycle/projects',{method:'POST',scope,body:projectInput(dates,'SYN-CROSS-SCOPE',engagement)}),404,'COMMERCIAL_NOT_FOUND');
      const foreign=scope.organizationId===f.otherOrganizationId;
      const scopedEngagement=await created(request,'/engagements',engagementInput(dates,`SYN-SCOPED-${foreign?'FOREIGN':'OTHER'}`,null,
        {ownerId:foreign?f.foreignOwnerId:f.otherOwnerId,attributionId:foreign?f.foreignAttributionId:f.otherAttributionId}),{scope});
      await changed(request,'Engagement',scopedEngagement.id,0,null,'Active',{scope});
      const scopedProject=await created(request,'/lifecycle/projects',projectInput(dates,`SYN-SCOPED-PROJECT-${foreign?'FOREIGN':'OTHER'}`,scopedEngagement,
        {managerId:foreign?f.foreignOwnerId:f.otherOwnerId}),{scope});
      workspace=await request('/lifecycle/workspace',{scope});assert.deepEqual(workspace.body.engagements.map(x=>x.id),[scopedEngagement.id]);assert.deepEqual(workspace.body.projects.map(x=>x.id),[scopedProject.id]);
      const local=await request('/lifecycle/workspace');assert.equal(local.body.engagements.some(x=>x.id===scopedEngagement.id),false);assert.equal(local.body.projects.some(x=>x.id===scopedProject.id),false);
    }
    for(const type of ['contract','PurchaseOrder','Milestone','Unknown'])assertError(await request(`/lifecycle/${type}/${project.id}/history`),404,'COMMERCIAL_NOT_FOUND');

    // Neutral/unmapped records retain ordinary legacy behavior. The guard is
    // not a global project freeze and later CRUD/import does not invent mapping.
    const ungoverned=await request('/api/projects',{method:'POST',body:{project_code:'SYN-LEGACY-STILL-EDITABLE',name:'Synthetic ordinary legacy project',
      client_id:f.clientId,manager_id:f.ownerId,start_date:dates.startsOn,end_date:dates.endsOn,status:'Proposed',billable:true}});
    assert.equal(ungoverned.status,200,JSON.stringify(ungoverned.body));assert.ok(ungoverned.body.id);
    const legacyUpdate=await request('/api/projects',{method:'POST',body:{id:ungoverned.body.id,project_code:'SYN-LEGACY-STILL-EDITABLE',name:'Synthetic ordinary legacy edit',
      client_id:f.clientId,manager_id:f.ownerId,start_date:dates.startsOn,end_date:dates.endsOn,status:'Proposed',billable:true}});assert.equal(legacyUpdate.status,200);
    const ordinaryStatus=await request(`/api/projects/${ungoverned.body.id}/status`,{method:'PATCH',body:{status:'On Hold',reason:'Synthetic ordinary legacy state'}});assert.equal(ordinaryStatus.status,200);
    for(const alias of ['/api','/api/v1']){
      const applied=await request(`${alias}/imports/projects/apply`,{method:'POST',headers:{'Idempotency-Key':`synthetic-ordinary-${randomUUID()}`},
        body:{schemaVersion:'project-master/1',dryRun:false,fileName:'synthetic-ordinary-project.csv',totalRows:1,clientErrors:[],rows:[{projectCode:'SYN-LEGACY-STILL-EDITABLE',name:'Synthetic ordinary imported edit',
          clientId:f.clientId,client:'Synthetic commercial local client',managerId:f.ownerId,startDate:dates.startsOn,endDate:dates.endsOn,status:'Proposed',billable:true}]}});
      assert.equal(applied.status,200,JSON.stringify(applied.body));assert.equal(applied.body.validRows,1);
    }
    assert.equal((await pool.query('select count(*)::int count from commercial_project_bindings where project_id=$1',[ungoverned.body.id])).rows[0].count,0);
    assert.equal((await pool.query('select count(*)::int count from project_engagement_mappings where project_id=$1',[ungoverned.body.id])).rows[0].count,0);

    // Every compatibility writer is rejected with one stable conflict, including
    // mixed-row imports whose earlier writes/audit/log/idempotency must rollback.
    const stableConflict=async(path,options)=>{
      const before=await counts(pool);const beforeRows=await snapshot(pool,['clients','projects','project_allocations']);
      const result=await request(path,options);assertError(result,409,'GOVERNED_PROJECT_MUTATION_REQUIRED');
      assert.deepEqual(await counts(pool),before,`${path} creates no partial import, idempotency, audit or lifecycle record`);
      assert.deepEqual(await snapshot(pool,['clients','projects','project_allocations']),beforeRows,`${path} rolls back all data, including preceding rows`);
    };
    const projectRow=(await pool.query('select *,start_date::text,end_date::text from projects where id=$1',[project.id])).rows[0];
    const legacyProject={id:project.id,project_code:projectRow.project_code,name:'Synthetic forbidden legacy edit',client_id:f.clientId,manager_id:f.ownerId,
      start_date:projectRow.start_date,end_date:projectRow.end_date,status:'Completed',billable:true,notes:'Synthetic forbidden notes'};
    await stableConflict('/api/projects',{method:'POST',body:legacyProject});
    await stableConflict('/api/projects',{method:'POST',body:{...legacyProject,manager_id:'synthetic-missing-owner',client_id:'synthetic-missing-client'}});
    for(const status of ['Active','On Hold','Completed','Proposed'])await stableConflict(`/api/projects/${project.id}/status`,{method:'PATCH',body:{status,reason:'Synthetic forbidden legacy status'}});
    const importRow={projectCode:project.code,name:'Synthetic forbidden import',clientId:f.clientId,client:'Synthetic commercial local client',managerId:f.ownerId,
      startDate:dates.startsOn,endDate:dates.endsOn,status:'Completed',billable:true};
    for(const alias of ['/api','/api/v1'])for(const dryRun of [true,false]){
      const firstRow={...importRow,projectCode:`SYN-IMPORT-ROLLBACK-${alias.includes('v1')?'V1':'LEGACY'}-${dryRun?'DRY':'APPLY'}`,name:'Synthetic first-row rollback'};
      await stableConflict(`${alias}/imports/projects/apply`,{method:'POST',headers:{'Idempotency-Key':`synthetic-project-${randomUUID()}`},
        body:{schemaVersion:'project-master/1',dryRun,fileName:'synthetic-governed-projects.csv',rows:[firstRow,importRow],totalRows:2,clientErrors:[]}});
      await stableConflict(`${alias}/imports/projects/apply`,{method:'POST',headers:{'Idempotency-Key':`synthetic-project-invalid-${randomUUID()}`},
        body:{schemaVersion:'project-master/1',dryRun,fileName:'synthetic-invalid-governed-projects.csv',rows:[firstRow,{...importRow,managerId:'synthetic-missing-owner',clientId:'synthetic-missing-client'}],totalRows:2,clientErrors:[]}});
    }
    const savedClient=(await pool.query('select * from clients where id=$1',[f.clientId])).rows[0];
    for(const delta of [{name:'Synthetic forbidden client rename'},{status:'Inactive'}])await stableConflict('/api/clients',{method:'POST',
      body:{id:f.clientId,name:savedClient.name,industry:savedClient.industry||'Unclassified',account_owner_id:f.ownerId,country_director_ids:[],status:'Active',...delta}});
    for(const alias of ['/api','/api/v1'])for(const dryRun of [true,false])for(const invalidReference of [false,true])await stableConflict(`${alias}/imports/clients/apply`,{method:'POST',
      headers:{'Idempotency-Key':`synthetic-client-${randomUUID()}`},body:{schemaVersion:'client-master/1',dryRun,fileName:'synthetic-governed-clients.csv',totalRows:2,clientErrors:[],
        rows:[{name:`Synthetic first client rollback ${randomUUID()}`,status:'Active'},
          {id:f.clientId,name:'Synthetic forbidden import rename',status:'Inactive',accountOwnerId:invalidReference?'synthetic-missing-owner':f.ownerId}]}});
    await stableConflict('/api/clients',{method:'POST',body:{id:f.clientId,name:savedClient.name,account_owner_id:'synthetic-missing-owner',status:'Active'}});

    // Real database-trigger failure demonstrates shared command/audit atomicity.
    await pool.query(`create function synthetic_reject_lifecycle_audit() returns trigger language plpgsql as $$ begin
      if new.module='Commercial Lifecycle' then raise exception 'Synthetic test audit failure';end if;return new;end $$`);
    await pool.query(`create trigger synthetic_lifecycle_audit_failure before insert on audit_logs for each row execute function synthetic_reject_lifecycle_audit()`);
    try{
      const before=await counts(pool);const unchangedProject=(await pool.query('select to_jsonb(p) snapshot from projects p where id=$1',[project.id])).rows;
      assertError(await request('/lifecycle/projects',{method:'POST',body:projectInput(dates,'SYN-ATOMIC-AUDIT-FAIL',engagement)}),503,'COMMERCIAL_UNAVAILABLE');
      assert.deepEqual(await counts(pool),before);assert.equal((await pool.query(`select count(*)::int count from projects where project_code='SYN-ATOMIC-AUDIT-FAIL'`)).rows[0].count,0);
      assertError(await request(`/lifecycle/Project/${project.id}/transitions`,{method:'POST',body:transitionInput(5,pin,'On Hold')}),503,'COMMERCIAL_UNAVAILABLE');
      assert.deepEqual(await counts(pool),before);assert.deepEqual((await pool.query('select to_jsonb(p) snapshot from projects p where id=$1',[project.id])).rows,unchangedProject);
    }finally{await pool.query('drop trigger synthetic_lifecycle_audit_failure on audit_logs');await pool.query('drop function synthetic_reject_lifecycle_audit()');}

    // Ledger material and opaque shared audit are correlated without leaking the
    // user-entered reasons, commercial budget, terms or document URLs.
    const eventRows=(await pool.query('select * from commercial_lifecycle_events where entity_type=$1 and entity_id=$2 order by sequence',['Project',project.id])).rows;
    assert.equal(eventRows.length,5);assert.equal(eventRows[0].before_value,null);assert.equal(eventRows[1].before_value.state,'Active');
    assert.equal(eventRows[0].after_value.snapshot.budget_allocation,'0.0001');
    for(const event of eventRows){
      assert.equal(event.organization_id,f.organizationId);assert.equal(event.legal_entity_id,f.legalEntityId);assert.equal(event.actor_id,identities.manager.id);assert.equal(event.active_role,'Admin');
      assert.match(event.reason,new RegExp(protectedMarker));
      const audits=(await pool.query(`select * from audit_logs where module='Commercial Lifecycle' and new_value->>'commercialEventId'=$1`,[event.id])).rows;
      assert.equal(audits.length,1);assert.equal(audits[0].correlation_id,event.correlation_id);assert.equal(audits[0].operation_id,event.operation_id);
      assert.deepEqual(audits[0].new_value,{commercialEventId:event.id,snapshot:'after'});
      assert.doesNotMatch(JSON.stringify(audits[0]),new RegExp(`${protectedMarker}|synthetic-lifecycle\\.pdf|budget_allocation|99999999999999`));
    }

    // Read-only readiness must provide actual legacy evidence counts and retain
    // unknown commercial balances/unbilled/settlement as an explicit blocker.
    const readinessProject=await created(request,'/lifecycle/projects',projectInput(dates,'SYN-READINESS-PROJECT',engagement,{budgetAllocation:'0.0000'}));
    for(const status of ['Active','Paused','Completed'])await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
      values($1,$2,$3,10,$4,$5,true,$6,$7,$8)`,[`allocation-${randomUUID()}`,f.ownerId,readinessProject.id,dates.startsOn,dates.endsOn,status,f.organizationId,f.legalEntityId]);
    for(const [status,week,lines] of [['Draft','2002-01-06',1],['Submitted','2002-01-13',2],['Approved','2002-01-20',1]]){
      const timesheetId=randomUUID();
      await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
        values($1,$2,$3,$4,$5,$5,$6,$7)`,[timesheetId,f.ownerId,week,status,lines,f.organizationId,f.legalEntityId]);
      for(let n=0;n<lines;n++)await pool.query(`insert into timesheet_entries(id,timesheet_id,project_id,work_type,work_date,hours,remark,billable)
        values($1,$2,$3,'Project Work',$4,1,'Synthetic readiness evidence',true)`,[randomUUID(),timesheetId,readinessProject.id,week]);
      if(status==='Submitted')await pool.query(`insert into approval_records(id,entity_type,entity_id,subject_employee_id,status) values($1,'Timesheet',$2,$3,'Pending')`,
        [`approval-${randomUUID()}`,timesheetId,f.ownerId]);
    }
    for(const n of [1,2])await created(request,'/milestones',{engagementId:engagement.id,code:`SYN-READINESS-M${n}`,name:'Synthetic unaccepted milestone',dueOn:today,amount:'0.0000',currency:'USD',reason:'Synthetic readiness checkpoint'});
    await created(request,'/purchase-orders',{contractId:contract.id,contractVersionId:pin,number:'SYN-READINESS-PO',value:'0.0000',currency:'USD',
      startsOn:dates.startsOn,endsOn:dates.endsOn,warningThresholdPercent:'80',reason:'Synthetic draft PO evidence'});
    const expectedEvidence={openAssignments:2,draftSubmittedWorkLines:3,pendingTimesheetApprovals:1,unacceptedMilestones:2,draftPurchaseOrders:1,ownerActive:true};
    for(const [type,id] of [['Project',readinessProject.id],['Engagement',engagement.id],['Contract',contract.id]]){
      const readiness=await request(`/lifecycle/${type}/${id}/readiness`,{identity:identities.reader});assert.equal(readiness.status,200,JSON.stringify(readiness.body));
      assert.equal(readiness.body.entityType,type);assert.equal(readiness.body.entityId,id);assert.equal(readiness.body.available,false);assert.equal(readiness.body.checkedOn,today);
      assert.deepEqual(readiness.body.evidence,{...expectedEvidence,ownerActive:type==='Contract'?null:true},'readiness counts real dependency rows and deduplicates approvals across work lines');
      assert.ok(readiness.body.unavailableEvidence.length>=3,'missing commercial closure domains are never treated as zero');
      assertError(await request(`/lifecycle/${type}/${id}/readiness?asOf=${today}`),400,'COMMERCIAL_INVALID_REQUEST');
    }
    const zeroReadiness=await request(`/lifecycle/Engagement/${draftOnly.id}/readiness`);assert.equal(zeroReadiness.status,200);
    assert.deepEqual(zeroReadiness.body.evidence,{openAssignments:0,draftSubmittedWorkLines:0,pendingTimesheetApprovals:0,unacceptedMilestones:0,draftPurchaseOrders:0,ownerActive:true});
    assert.equal(zeroReadiness.body.available,false,'zero existing dependencies cannot manufacture unavailable closure authority');

    // Bounded histories reach the advertised maximum with exact descending
    // sequences; the 201st append cannot evade optimistic version limits.
    const historyEngagement=await created(request,'/engagements',engagementInput(dates,'SYN-HISTORY-CAP',null));
    for(let sequence=0;sequence<200;sequence++)await changed(request,'Engagement',historyEngagement.id,sequence,null,sequence%2===0?'Active':'On Hold');
    events=await history(request,'Engagement',historyEngagement.id);assert.equal(events.length,200);assert.deepEqual(events.map(x=>x.sequence),Array.from({length:200},(_,i)=>200-i));
    const beforeLimit=await counts(pool);assertError(await request(`/lifecycle/Engagement/${historyEngagement.id}/transitions`,{method:'POST',body:transitionInput(200)}),400,'COMMERCIAL_INVALID_REQUEST');
    assert.deepEqual(await counts(pool),beforeLimit);
    const template=(await pool.query('select * from commercial_engagements where id=$1',[historyEngagement.id])).rows[0];
    await pool.query(`insert into commercial_engagements(id,organization_id,legal_entity_id,code,name,model,owner_id,attribution_id,starts_on,ends_on,currency,budget,billable,reason,created_by)
      select 'synthetic-capped-engagement-'||n,$1,$2,'SYN-CAPPED-'||n,'Synthetic bounded engagement','internal',$3,$4,$5,$6,'USD',0,false,'Synthetic cap fixture',$7
      from generate_series(1,201) n`,[f.organizationId,f.legalEntityId,f.ownerId,f.businessUnitId,template.starts_on,template.ends_on,identities.manager.id]);
    const invalidLegacyId=await seedProposal(pool,{code:'SYN-NULL-MANAGER',name:'Synthetic optional legacy manager',startsOn:dates.startsOn,endsOn:dates.endsOn,billable:true},{managerId:null});
    const capped=await request('/lifecycle/workspace');assert.equal(capped.status,200);assert.equal(capped.body.engagements.length,200);assert.equal(capped.body.limits.truncated.engagements,true);
    assert.equal(capped.body.choices.legacyProjects.some(x=>x.id===invalidLegacyId),false,'unpromotable nullable legacy rows cannot poison the strict workspace DTO');
    assert.equal((await pool.query('select manager_id from projects where id=$1',[invalidLegacyId])).rows[0].manager_id,null,'filtering a promotion choice does not repair or rewrite legacy data');
    for(const key of ['contracts','projects','legacyProjects','owners'])assert.equal(typeof capped.body.limits.truncated[key],'boolean');
  });

  // Database protections apply independently of API writers, including no-op
  // UPDATE, hard DELETE and attempts to tamper with operational projections.
  const binding=(await pool.query('select * from commercial_project_bindings order by id limit 1')).rows[0];
  const event=(await pool.query('select * from commercial_lifecycle_events order by id limit 1')).rows[0];
  for(const table of ['commercial_project_bindings','commercial_lifecycle_events']){
    await rejectSql(pool,`update ${table} set organization_id=organization_id`,[],'55000');
    await rejectSql(pool,`delete from ${table}`,[],'55000');
  }
  for(const sql of ['update projects set status=status where id=$1','update projects set name=name where id=$1',
    "update projects set status='Completed' where id=$1",'delete from projects where id=$1'])await rejectSql(pool,sql,[binding.project_id],'WPG01');
  assert.ok(event.actor_id);assert.equal((await pool.query('select count(*)::int count from commercial_project_bindings where project_id=$1',[binding.project_id])).rows[0].count,1);
  assert.deepEqual((await pool.query('select to_jsonb(a) snapshot from project_allocations a where id=$1',[f.allocationId])).rows,
    immutableLegacy.project_allocations.filter(x=>x.snapshot.id===f.allocationId));
  assert.deepEqual((await pool.query('select to_jsonb(t) snapshot from timesheets t where id=$1',[f.timesheetId])).rows,
    immutableLegacy.timesheets.filter(x=>x.snapshot.id===f.timesheetId));
  assert.deepEqual((await pool.query('select to_jsonb(t) snapshot from timesheet_entries t where id=$1',[f.workId])).rows,
    immutableLegacy.timesheet_entries.filter(x=>x.snapshot.id===f.workId));
  // Append validation is enforced below the service boundary as well: no
  // forged root, pin, chronology, terminal state, actor or effective date enters
  // the append-only ledger through a future writer that forgets an API check.
  const commercialBinding=(await pool.query(`select *,starts_on::text,ends_on::text from commercial_project_bindings
    where organization_id=$1 and legal_entity_id=$2 and contract_id is not null order by code limit 1`,[f.organizationId,f.legalEntityId])).rows[0];
  const latest=(await pool.query(`select *,effective_on::text from commercial_lifecycle_events where entity_type='Project' and entity_id=$1 order by sequence desc limit 1`,[commercialBinding.project_id])).rows[0];
  const next={id:`lifecycle-${randomUUID()}`,sequence:latest.sequence+1,state:latest.state==='Active'?'On Hold':'Active',effective_on:await todayFor(pool)};
  const immutableBefore=await counts(pool);
  for(const [delta,code] of [
    [{effective_on:'2000-01-01'},'23514'],[{effective_on:'9999-01-01'},'23514'],[{sequence:latest.sequence+2},'23514'],
    [{sequence:latest.sequence},'23514'],[{state:latest.state},'23514'],[{state:'Completed'},'23514'],
    [{contract_id:null,contract_version_id:null},'23514'],[{actor_id:null},'23502'],[{actor_id:randomUUID()},'23503'],
  ])await rejectClone(pool,'commercial_lifecycle_events',latest,{...next,...delta},code);
  await rejectClone(pool,'commercial_lifecycle_events',latest,{...next,entity_type:'Engagement',entity_id:'synthetic-missing-engagement',
    sequence:1,state:'Active',contract_id:null,contract_version_id:null,before_value:null},'23503');
  const unboundInput={code:'SYN-DB-UNBOUND',name:'Synthetic unbound database fixture',startsOn:commercialBinding.starts_on,endsOn:commercialBinding.ends_on,billable:true};
  const unboundId=await seedProposal(pool,unboundInput);
  await rejectClone(pool,'commercial_lifecycle_events',latest,{...next,entity_type:'Project',entity_id:unboundId,
    sequence:1,state:'Active',contract_id:null,contract_version_id:null,before_value:null},'23503');
  const neverActivated=(await pool.query(`select id from commercial_engagements e where model='internal' and organization_id=$1 and legal_entity_id=$2
    and not exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id) order by id limit 1`,[f.organizationId,f.legalEntityId])).rows[0];
  await rejectClone(pool,'commercial_lifecycle_events',latest,{...next,entity_type:'Engagement',entity_id:neverActivated.id,
    sequence:1,state:'On Hold',contract_id:null,contract_version_id:null,before_value:null},'23514');
  const candidate={id:`project-binding-${randomUUID()}`,project_id:unboundId,code:unboundInput.code,name:unboundInput.name};
  for(const [delta,code] of [
    [{manager_id:f.otherOwnerId},'23503'],[{organization_id:f.otherOrganizationId,legal_entity_id:f.foreignLegalEntityId},'23503'],
    [{contract_version_id:'synthetic-missing-version'},'23503'],[{model:'internal',billable:true},'23514'],
    [{budget_allocation:'-0.0001'},'23514'],[{budget_allocation:'100000000000000'},'22003'],
  ])await rejectClone(pool,'commercial_project_bindings',commercialBinding,{...candidate,...delta},code);
  const immutableAfter=await counts(pool);
  for(const key of ['bindings','events','drafts','audits','imports','idempotency'])assert.equal(immutableAfter[key],immutableBefore[key],`rejected raw ${key} changes are atomic`);
  assert.equal(immutableAfter.projects,immutableBefore.projects+1,'only the explicit unbound test proposal was created');
  const replayBefore=await counts(pool);const replay=await migrateCommercialDatabase(pool);assert.deepEqual(replay.applied,[]);assert.deepEqual(await counts(pool),replayBefore);
});
console.log('Commercial lifecycle real PostgreSQL fresh/040 upgrade/replay, seven models, scoped permissions/history, immutable pins, atomic project promotion, race/budget safety, legacy writer rollback, audit integrity and DB tamper protections passed.');
