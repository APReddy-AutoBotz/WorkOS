import assert from 'node:assert/strict';
import {syntheticHexDigest} from './support/synthetic-values.mjs';
import {randomUUID} from 'node:crypto';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runMigrations} from '../server/migrate.mjs';
import {createContract,createEngagement} from '../server/modules/commercial-drafting/service.mjs';
import {commercialFixture as f,commercialServerDir,withCommercialDatabase,withPreCommercialMigrations,migrateCommercialDatabase,
  seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {localDatabaseUrl} from './support/import-audit-journey.mjs';
import {amendmentPermissions,amendmentScope,amendmentMarker,amendmentSnapshot,amendmentCounts,amendmentToday,addUtcDays,
  amendmentContractInput,amendmentEngagementInput,amendmentPost,amendmentTransition,grantAmendmentPermissions,createAmendmentHierarchy,
  seedApplicableAmendmentVersion,amendmentWorkspace,amendmentInput,amendmentPreview,amendmentApply,assertAmendmentError} from './support/commercial-amendments-test.mjs';

// Mandatory real PostgreSQL + real HTTP acceptance. No live database, fallback,
// request interception or browser. A missing DB is a failure, never a skip.
assert.throws(()=>localDatabaseUrl(undefined));
for(const value of ['postgres://example.test/test','postgres://localhost/test?host=example.test','postgres://localhost/test?service=live',
  'postgres://localhost/test?dbname=shared','postgres://localhost/test?hostaddr=192.0.2.1','postgres://localhost/test#override'])assert.throws(()=>localDatabaseUrl(value));
const migration043='043_wos04_governed_amendments';
const quiet={log(){}};
const defaults=async pool=>{
  assert.equal((await pool.query("select count(*)::int count from permission_definitions where permission_key='commercial.amendments.manage'")).rows[0].count,1);
  for(const table of ['role_permissions','user_permission_grants'])assert.equal((await pool.query(`select count(*)::int count from ${table} where permission_key='commercial.amendments.manage'`)).rows[0].count,0,'migration adds no role/user grants');
  assert.equal((await amendmentCounts(pool)).events,0);
};
const unchangedAfter=async(pool,operation,status,code)=>{
  const before=await amendmentCounts(pool);const result=await operation();assertAmendmentError(result,status,code);
  assert.deepEqual(await amendmentCounts(pool),before,'rejected preview/commit has no amendment, audit, lifecycle or binding side effects');return result;
};
const previewRequest=(request,type,id,body,options={})=>request(`/amendments/${type}/${id}/preview`,{method:'POST',body,...options});
const commitRequest=(request,type,id,body,options={})=>request(`/amendments/${type}/${id}`,{method:'POST',body,...options});
const rejectSql=async(pool,sql,values)=>assert.rejects(pool.query(sql,values),error=>{assert(error.code,'database must reject with SQLSTATE');return true;});
const cloneEvent=async(pool,row,overrides={})=>{
  const copy={...row,...overrides},columns=Object.keys(copy);const values=columns.map(key=>['before_value','after_value'].includes(key)?JSON.stringify(copy[key]):copy[key]);
  return pool.query(`insert into commercial_amendments(${columns.map(key=>`"${key}"`).join(',')}) values(${columns.map((_,index)=>`$${index+1}`).join(',')})`,values);
};

// Explicit enrollment must work through the product's permission APIs, without
// seeding the new authority directly or granting it to any role by default.
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);
  const identities=await seedCommercialIdentities(pool);await defaults(pool);
  const permissionKey='commercial.amendments.manage';
  await withCommercialApi({databaseUrl,identities},async({request})=>{
    const config=await request('/api/permissions/config');assert.equal(config.status,200);
    const definition=config.body.permissions.find(item=>item.key===permissionKey);
    assert.ok(definition,'amendment authority must be discoverable for explicit enrollment');assert.equal(definition.protected,false);
    for(const identity of [identities.reader,identities.denied]){
      assert.equal((await request('/api/permissions/roles/Admin',{method:'PATCH',identity,body:{permissionKey,enabled:true}})).status,403);
      assert.equal((await request('/api/permissions/user-grants',{method:'POST',identity,body:{userId:identity.id,permissionKey}})).status,403);
    }
    await defaults(pool);
    assert.equal((await request('/api/permissions/roles/Admin',{method:'PATCH',body:{permissionKey:'commercial.lifecycle.manage',enabled:true}})).status,200);
    const root=await createAmendmentHierarchy(request,'SYN-PERMISSION-ENROLLMENT');
    const today=await amendmentToday(pool),version=await seedApplicableAmendmentVersion(pool,identities.manager,root.contract,today);
    const input=amendmentInput(await amendmentWorkspace(request,'Contract',root.contract.id),version);
    const preview=()=>previewRequest(request,'Contract',root.contract.id,input);
    assertAmendmentError(await preview(),403);
    const roleGrant=async enabled=>assert.equal((await request('/api/permissions/roles/Admin',{method:'PATCH',body:{permissionKey,enabled}})).status,200);
    await roleGrant(true);assert.equal((await preview()).status,201);
    await roleGrant(false);assertAmendmentError(await preview(),403);
    const granted=await request('/api/permissions/user-grants',{method:'POST',body:{userId:identities.manager.id,permissionKey}});
    assert.equal(granted.status,200);assert.equal((await preview()).status,201);
    assert.equal((await request(`/api/permissions/user-grants/${granted.body.id}`,{method:'DELETE'})).status,200);
    assertAmendmentError(await preview(),403);
    assert.equal((await pool.query('select count(*)::int count from role_permissions where permission_key=$1 and enabled',[permissionKey])).rows[0].count,0);
    assert.equal((await pool.query('select count(*)::int count from user_permission_grants where permission_key=$1',[permissionKey])).rows[0].count,0);
    assert.equal((await amendmentCounts(pool)).events,0,'permission enrollment and preview do not adopt terms');
    const changes=(await pool.query('select * from permission_change_history where permission_key=$1',[permissionKey])).rows;
    assert.equal(changes.length,4);assert(changes.every(row=>row.changed_by===identities.manager.id&&row.active_role==='Admin'));
  });
});

// Exact 042 upgrade with pre-existing manual drafts and approved historical
// evidence, then replay. No backfill silently adopts terms or modifies pins.
await withCommercialDatabase(async({pool})=>{
  await withPreCommercialMigrations(async rootDir=>{
    await runMigrations({pool,rootDir,logger:quiet});
    await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
    for(const file of ['040_wos04_commercial_drafting_foundation.sql','041_wos04_governed_lifecycle.sql','042_wos04_scoped_client_profiles.sql'])
      await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
    const baseline=await runMigrations({pool,rootDir,logger:quiet});assert.equal(baseline.status.currentVersion,'042_wos04_scoped_client_profiles');
    const identities=await seedCommercialIdentities(pool);
    const req={user:{sub:identities.manager.id,activeRole:'Admin'},organizationScope:amendmentScope,correlationId:'synthetic-042-upgrade',operationId:'synthetic-043-upgrade'};
    const client=await pool.connect();
    try{
      await client.query('begin');const contract=await createContract(client,req,amendmentContractInput('SYN-AMENDMENT-UPGRADE-C'),async()=>{});
      await createEngagement(client,req,amendmentEngagementInput('SYN-AMENDMENT-UPGRADE-E',contract),async()=>{});await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
    const preserved=await amendmentSnapshot(pool);const projects=await amendmentSnapshot(pool,['projects']);
    for(const row of preserved.timesheet_entries){row.value.evidence_url=null;row.value.work_reference=null;row.value.source_identity=null;row.value.category_code=null;row.value.category_reference=null;} // additive 047/048 column; existing fields remain exact
    const upgraded=await migrateCommercialDatabase(pool);assert.deepEqual(upgraded.applied,[migration043,'044_wos04_work_submission_evidence','045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission']);assert.equal(upgraded.status.isCurrent,true);
    await defaults(pool);assert.deepEqual(await amendmentSnapshot(pool),preserved);assert.deepEqual(await amendmentSnapshot(pool,['projects']),projects);
    const replay=await migrateCommercialDatabase(pool);assert.deepEqual(replay.applied,[]);assert.deepEqual(await amendmentSnapshot(pool),preserved);
  });
});

await withCommercialDatabase(async({pool,databaseUrl})=>{
  const installed=await migrateCommercialDatabase(pool);assert.equal(installed.status.isCurrent,true);assert(installed.applied.includes(migration043));await defaults(pool);
  await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantAmendmentPermissions(pool);
  const today=await amendmentToday(pool),future=addUtcDays(today,30);
  // Deliberately run the real API in a non-UTC process timezone. All command and
  // read boundaries are still owned by the PostgreSQL UTC date.
  await withCommercialApi({databaseUrl,identities,timeZone:'Pacific/Honolulu'},async({request})=>{
    const root=await createAmendmentHierarchy(request);
    const sibling=await amendmentPost(request,'/lifecycle/projects',{engagementId:root.engagement.id,projectId:null,code:'SYN-AMENDMENT-SIBLING',
      name:'Synthetic second governed project',managerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',billable:true,
      budgetAllocation:'4000.0001',reason:`${amendmentMarker} sibling fixture`});
    const otherContract=await amendmentPost(request,'/contracts',amendmentContractInput('SYN-AMENDMENT-OTHER-CONTRACT'));
    const unactivated=await amendmentPost(request,'/engagements',amendmentEngagementInput('SYN-AMENDMENT-DRAFT',root.contract));
    const internal=await amendmentPost(request,'/engagements',{code:'SYN-AMENDMENT-INTERNAL',name:'Synthetic unsupported internal engagement',model:'internal',
      ownerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',currency:'GBP',budget:'0.0000',clientId:null,contractId:null,contractVersionId:null,attributionId:f.businessUnitId,reason:'Synthetic internal fixture'});
    const v2=await seedApplicableAmendmentVersion(pool,identities.manager,root.contract,today);
    const immutable=await amendmentSnapshot(pool);const projects=await amendmentSnapshot(pool,['projects']);
    const contractWorkspace=await amendmentWorkspace(request,'Contract',root.contract.id);
    assert.equal(contractWorkspace.asOf,today);assert.equal(contractWorkspace.sequence,0);assert.equal(contractWorkspace.latestContractVersion,2);
    assert.equal(contractWorkspace.currentTerms.contractVersionId,root.pin);assert.deepEqual(contractWorkspace.currentTerms,contractWorkspace.activationTerms);
    assert.equal(contractWorkspace.pending,false);assert.deepEqual(contractWorkspace.history,[]);
    const contractInput=amendmentInput(contractWorkspace,v2);
    const paths=[['Contract',root.contract.id],['Engagement',root.engagement.id],['Project',root.project.id]];
    for(const [type,id] of paths){
      assertAmendmentError(await request(`/amendments/${type}/${id}`,{authenticated:false}),401,'AUTHENTICATION_REQUIRED');
      assertAmendmentError(await request(`/amendments/${type}/${id}`,{identity:identities.denied}),403,'COMMERCIAL_PERMISSION_DENIED');
      assert.equal((await request(`/amendments/${type}/${id}`,{identity:identities.reader})).status,200);
      for(const query of ['?asOf=2000-01-01','?organizationId=forged','?legalEntityId=forged','?limit=999'])
        assertAmendmentError(await request(`/amendments/${type}/${id}${query}`),400,'COMMERCIAL_INVALID_REQUEST');
    }
    for(const scope of [{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},{organizationId:f.otherOrganizationId,legalEntityId:f.foreignLegalEntityId}])
      assertAmendmentError(await request(`/amendments/Contract/${root.contract.id}`,{scope}),403,'ORG_SCOPE_DENIED');
    assertAmendmentError(await request('/amendments/Contract/missing-synthetic'),404,'COMMERCIAL_NOT_FOUND');
    assertAmendmentError(await request(`/amendments/Engagement/${unactivated.id}`),409,'COMMERCIAL_AMENDMENT_NOT_GOVERNED');
    assertAmendmentError(await request(`/amendments/Engagement/${internal.id}`),404,'COMMERCIAL_NOT_FOUND');
    await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,{...contractInput,contractVersionId:otherContract.versions[0].id}),409,'COMMERCIAL_AMENDMENT_PIN_CONFLICT');
    await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)',[identities.manager.id,f.organizationId,f.otherLegalEntityId]);
    assertAmendmentError(await request(`/amendments/Contract/${root.contract.id}`,{scope:{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}}),404,'COMMERCIAL_NOT_FOUND');
    assertAmendmentError(await request(`/amendments/PurchaseOrder/${root.contract.id}`),404,'COMMERCIAL_NOT_FOUND');
    for(const permission of ['commercial.contracts.view','commercial.lifecycle.manage','commercial.amendments.manage']){
      await pool.query('update role_permissions set enabled=false where role_name=$1 and permission_key=$2',['Admin',permission]);
      for(const [path,body] of [[`/amendments/Contract/${root.contract.id}/preview`,contractInput],[`/amendments/Contract/${root.contract.id}`,{...contractInput,previewToken:syntheticHexDigest()}]])
        await unchangedAfter(pool,()=>request(path,{method:'POST',body}),403,'COMMERCIAL_PERMISSION_DENIED');
      await pool.query('update role_permissions set enabled=true where role_name=$1 and permission_key=$2',['Admin',permission]);
    }
    await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,contractInput,{identity:identities.reader}),403,'COMMERCIAL_PERMISSION_DENIED');
    for(const [key,value] of Object.entries({actorId:'forged',organizationId:'forged',currency:'USD',model:'retainer',clientId:'forged',name:'forged',state:'Active'}))
      await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,{...contractInput,[key]:value}),400,'COMMERCIAL_INVALID_REQUEST');
    for(const patch of [{expectedSequence:1},{expectedLifecycleSequence:2},{expectedContractVersion:1}])
      await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,{...contractInput,...patch}),409);
    for(const patch of [{contractVersionId:root.pin},{contractVersionId:'missing-synthetic-version'},{effectiveOn:addUtcDays(today,-1)},
      {budget:'30000.0001'},{endsOn:'2098-12-31'},{startsOn:'2020-01-02'}]){
      const result=await previewRequest(request,'Contract',root.contract.id,{...contractInput,...patch});
      assert(result.status===409||result.status===422,JSON.stringify(result.body));
    }
    const beforePreview=await amendmentCounts(pool);const preview=await amendmentPreview(request,'Contract',root.contract.id,contractInput);
    assert.equal(preview.asOf,today);assert.equal(preview.before.contractVersionId,root.pin);assert.equal(preview.after.contractVersionId,v2.id);
    assert.deepEqual(await amendmentCounts(pool),beforePreview,'preview is a zero-write operation');
    for(const patch of [{previewToken:preview.previewToken.replace(/^./,preview.previewToken[0]==='0'?'1':'0')},{reason:'Synthetic changed reason'},{approvalReference:'Synthetic changed approval'},{budget:'30000.0001'}]){
      const result=await commitRequest(request,'Contract',root.contract.id,{...contractInput,previewToken:preview.previewToken,...patch});
      assert(result.status===409||result.status===422,JSON.stringify(result.body));assert.deepEqual(await amendmentCounts(pool),beforePreview);
    }
    // Neither draft-term management nor implicit activation is necessary for the
    // separately authorized amendment command, and there is no child cascade.
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.contracts.manage'");
    const contractEvent=await amendmentPost(request,`/amendments/Contract/${root.contract.id}`,{...contractInput,previewToken:preview.previewToken});
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.contracts.manage'");
    assert.equal(contractEvent.sequence,1);assert.equal(contractEvent.actorId,identities.manager.id);assert.equal(contractEvent.activeRole,'Admin');
    assert.equal(contractEvent.contractVersionId,v2.id);assert.equal(contractEvent.budget,'30000.0002');assert.equal(contractEvent.effectiveOn,today);
    assert.ok(contractEvent.correlationId);assert.ok(contractEvent.operationId);
    for(const [type,entity] of [['Engagement',root.engagement],['Project',root.project]]){
      const workspace=await amendmentWorkspace(request,type,entity.id);assert.equal(workspace.sequence,0);assert.equal(workspace.currentTerms.contractVersionId,root.pin);
    }
    const adoptedContract=await amendmentWorkspace(request,'Contract',root.contract.id);assert.equal(adoptedContract.currentTerms.contractVersionId,v2.id);
    assert.equal(adoptedContract.activationTerms.contractVersionId,root.pin);assert.equal(adoptedContract.lifecycle.contractVersionId,root.pin);
    assert.equal(adoptedContract.history.length,1);assert.equal(adoptedContract.history[0].reason,contractInput.reason);
    await unchangedAfter(pool,()=>commitRequest(request,'Contract',root.contract.id,{...contractInput,previewToken:preview.previewToken}),409);

    const engagementWorkspace=await amendmentWorkspace(request,'Engagement',root.engagement.id);
    const engagementInput=amendmentInput(engagementWorkspace,v2,{budget:'8000.0003'});
    // One ten-thousandth below the exact allocation total fails, as do date
    // changes excluding already governed children and historical start edits.
    for(const patch of [{budget:'8000.0001'},{endsOn:'2098-12-30'},{startsOn:'2020-01-02'}]){
      const result=await previewRequest(request,'Engagement',root.engagement.id,{...engagementInput,...patch});assert(result.status===409||result.status===422,JSON.stringify(result.body));
    }
    const engagementEvent=await amendmentApply(request,'Engagement',root.engagement.id,engagementInput);assert.equal(engagementEvent.budget,'8000.0003');
    const firstProjectWorkspace=await amendmentWorkspace(request,'Project',root.project.id),secondProjectWorkspace=await amendmentWorkspace(request,'Project',sibling.id);
    const raceInputs=[amendmentInput(firstProjectWorkspace,v2,{budget:'4000.0002'}),amendmentInput(secondProjectWorkspace,v2,{budget:'4000.0002'})];
    const raceIds=[root.project.id,sibling.id];
    const racePreviews=await Promise.all(raceIds.map((id,index)=>amendmentPreview(request,'Project',id,raceInputs[index])));
    const beforeRace=await amendmentCounts(pool);
    const race=await Promise.all(raceIds.map((id,index)=>commitRequest(request,'Project',id,{...raceInputs[index],previewToken:racePreviews[index].previewToken})));
    assert.equal(race.filter(result=>result.status===201).length,1,'shared scope serialization admits only the budget-fitting sibling');
    assert(race.filter(result=>result.status!==201).every(result=>result.status===409||result.status===422));
    const afterRace=await amendmentCounts(pool);assert.equal(afterRace.events,beforeRace.events+1);assert.equal(afterRace.audits,beforeRace.audits+1);
    const winner=raceIds[race.findIndex(result=>result.status===201)],loser=raceIds[race.findIndex(result=>result.status!==201)];
    const exactLoser=await amendmentWorkspace(request,'Project',loser);
    const exactEvent=await amendmentApply(request,'Project',loser,amendmentInput(exactLoser,v2,{budget:'4000.0001'}));assert.equal(exactEvent.budget,'4000.0001');
    assert.equal((await amendmentWorkspace(request,'Project',winner)).currentTerms.budget,'4000.0002');
    assert.deepEqual(await amendmentSnapshot(pool),immutable,'all amendment effects reside outside immutable roots, activation pins, original terms and historical work');
    assert.deepEqual(await amendmentSnapshot(pool,['projects']),projects,'no legacy project date/budget/name/status projection is rewritten');

    // Appending future terms does not adopt them. Stale latest-term and stale
    // lifecycle guards remain independent of the amendment sequence.
    const v3Result=await amendmentPost(request,`/contracts/${root.contract.id}/versions`,{...amendmentContractInput('UNUSED'),number:undefined,clientId:undefined,
      expectedVersion:2,effectiveFrom:future,endsOn:'2099-12-31',value:'31000.0003',reason:`${amendmentMarker} future publication`});
    const v3=v3Result.versions.find(version=>version.version===3);assert(v3);
    const beforeFuture=await amendmentWorkspace(request,'Contract',root.contract.id);assert.equal(beforeFuture.currentTerms.contractVersionId,v2.id);
    const futureInput=amendmentInput(beforeFuture,v3);
    await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,{...futureInput,expectedContractVersion:2}),409);
    // A child cannot adopt a target that its Active parent has not adopted.
    const childBeforeParent=amendmentInput(await amendmentWorkspace(request,'Project',winner),v3);
    await unchangedAfter(pool,()=>previewRequest(request,'Project',winner,childBeforeParent),409,'COMMERCIAL_AMENDMENT_PARENT_TERMS');

    const futurePreview=await amendmentPreview(request,'Contract',root.contract.id,futureInput);
    const beforeAuditFailure=await amendmentCounts(pool);
    await pool.query(`create function synthetic_reject_amendment_audit() returns trigger language plpgsql as $$ begin
      if new.module='Commercial Amendments' then raise exception 'Synthetic transactional audit failure'; end if;return new;end $$`);
    await pool.query('create trigger synthetic_reject_amendment_audit before insert on audit_logs for each row execute function synthetic_reject_amendment_audit()');
    try{await unchangedAfter(pool,()=>commitRequest(request,'Contract',root.contract.id,{...futureInput,previewToken:futurePreview.previewToken}),503,'COMMERCIAL_UNAVAILABLE');}
    finally{await pool.query('drop trigger synthetic_reject_amendment_audit on audit_logs');await pool.query('drop function synthetic_reject_amendment_audit()');}
    assert.deepEqual(await amendmentCounts(pool),beforeAuditFailure,'audit failure rolls back the material event atomically');
    const pending=await amendmentPost(request,`/amendments/Contract/${root.contract.id}`,{...futureInput,previewToken:futurePreview.previewToken});
    assert.equal(pending.sequence,2);assert.equal(pending.effectiveOn,future);
    const pendingWorkspace=await amendmentWorkspace(request,'Contract',root.contract.id);assert.equal(pendingWorkspace.pending,true);
    assert.equal(pendingWorkspace.sequence,2);assert.equal(pendingWorkspace.currentTerms.contractVersionId,v2.id);assert.equal(pendingWorkspace.activationTerms.contractVersionId,root.pin);
    assert.equal(pendingWorkspace.history[0].contractVersionId,v3.id);
    await unchangedAfter(pool,()=>previewRequest(request,'Contract',root.contract.id,amendmentInput(pendingWorkspace,v3,{effectiveOn:addUtcDays(future,1)})),409);
    await unchangedAfter(pool,()=>request('/lifecycle/projects',{method:'POST',body:{engagementId:root.engagement.id,projectId:null,code:'SYN-AMENDMENT-PENDING-DENIED',
      name:'Synthetic frozen dependency',managerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2099-12-31',billable:true,budgetAllocation:'0.0000',reason:'Synthetic pending parent freeze'}}),409,'COMMERCIAL_AMENDMENT_PENDING');
    await unchangedAfter(pool,()=>request(`/lifecycle/Engagement/${unactivated.id}/transitions`,{method:'POST',body:{expectedSequence:0,state:'Active',contractVersionId:root.pin,reason:'Synthetic pending activation denied',approvalReference:null}}),409,'COMMERCIAL_AMENDMENT_PENDING');
    const childFuture=amendmentInput(await amendmentWorkspace(request,'Engagement',root.engagement.id),v3,{budget:'8000.0003'});
    const childPending=await amendmentApply(request,'Engagement',root.engagement.id,childFuture);assert.equal(childPending.effectiveOn,future);
    const projectFuture=amendmentInput(await amendmentWorkspace(request,'Project',winner),v3);
    const beforeLifecycle=await amendmentPreview(request,'Project',winner,projectFuture);
    await amendmentTransition(request,'Project',winner,1,root.pin,'On Hold');
    await unchangedAfter(pool,()=>commitRequest(request,'Project',winner,{...projectFuture,previewToken:beforeLifecycle.previewToken}),409);
    const heldWorkspace=await amendmentWorkspace(request,'Project',winner);assert.equal(heldWorkspace.lifecycle.state,'On Hold');assert.equal(heldWorkspace.lifecycle.contractVersionId,root.pin);
    const heldEvent=await amendmentApply(request,'Project',winner,amendmentInput(heldWorkspace,v3));assert.equal(heldEvent.sequence,2,'an existing On Hold entity may adopt terms without resuming it');
    assert.equal((await amendmentWorkspace(request,'Project',winner)).lifecycle.state,'On Hold');

    const events=(await pool.query('select *,effective_on::text from commercial_amendments order by entity_type,entity_id,sequence')).rows;
    assert(events.length>=7);
    for(const event of events){assert.equal(event.organization_id,f.organizationId);assert.equal(event.legal_entity_id,f.legalEntityId);
      assert.equal(event.actor_id,identities.manager.id);assert.equal(event.active_role,'Admin');assert(event.correlation_id);assert(event.operation_id);
      assert(event.before_value);assert(event.after_value);assert.match(event.reason,/SYNTHETIC/);}
    const audits=(await pool.query("select to_jsonb(a) value from audit_logs a where module='Commercial Amendments' order by created_at")).rows;
    assert.equal(audits.length,events.length);
    for(const value of [amendmentMarker,'Synthetic private contract metadata','https://example.test/synthetic-amendment.pdf','30000.0002','8000.0003'])
      assert(!JSON.stringify(audits).includes(value),'general audit must expose only opaque protected-event pointers');
    const sample=events[0];
    await rejectSql(pool,'update commercial_amendments set reason=$1 where id=$2',['Synthetic forbidden rewrite',sample.id]);
    await rejectSql(pool,'delete from commercial_amendments where id=$1',[sample.id]);
    for(const patch of [{id:`amendment-${randomUUID()}`,sequence:99},{id:`amendment-${randomUUID()}`,entity_id:'missing-synthetic'},
      {id:`amendment-${randomUUID()}`,organization_id:f.otherOrganizationId,legal_entity_id:f.foreignLegalEntityId},
      {id:`amendment-${randomUUID()}`,lifecycle_sequence:200},{id:`amendment-${randomUUID()}`,contract_version_id:'missing-synthetic-version'}])
      await assert.rejects(cloneEvent(pool,sample,patch),'direct persistence cannot bypass chronology, scoped root, current lifecycle or foreign-key controls');
    const preservedAfterDeniedWrites=await amendmentCounts(pool);
    assert.equal(preservedAfterDeniedWrites.events,events.length);
    assert.equal((await pool.query('select count(*)::int count from commercial_amendments')).rows[0].count,events.length);
    // Use a fresh governed root with no pending event so direct SQL negatives
    // reach each semantic trigger guard, not an earlier duplicate/sequence gate.
    const guard=await createAmendmentHierarchy(request,'SYN-AMENDMENT-DB-GUARD');
    const guardTarget=await seedApplicableAmendmentVersion(pool,identities.manager,guard.contract,today);
    const base={...sample,entity_type:'Contract',entity_id:guard.contract.id,contract_id:guard.contract.id,contract_version_id:guardTarget.id,
      sequence:1,lifecycle_sequence:1,contract_version:2,effective_on:today,starts_on:guardTarget.startsOn,ends_on:guardTarget.endsOn,budget:guardTarget.value};
    const rejectGuard=async(overrides,sqlstate='23514')=>assert.rejects(cloneEvent(pool,base,{...overrides,id:`amendment-${randomUUID()}`}),error=>error.code===sqlstate);
    for(const patch of [{contract_version_id:guard.pin},{budget:'30000.0001'},{starts_on:'2020-01-02'},{ends_on:'2099-12-30'},
      {effective_on:addUtcDays(today,-1)},{lifecycle_sequence:200},{contract_version:1}])await rejectGuard(patch);
    await rejectGuard({entity_id:'missing-synthetic-guard'},'23503');
    await rejectGuard({entity_type:'Engagement',entity_id:guard.engagement.id,budget:'10000.0001'},'23514');
    await rejectGuard({entity_type:'Project',entity_id:guard.project.id,budget:'4000.0001'},'23514');
    await rejectGuard({entity_type:'Project',entity_id:guard.project.id,budget:'4000.0001',starts_on:'2020-01-02'},'23514');
    const badModel=await seedApplicableAmendmentVersion(pool,identities.manager,{...guard.contract,latestVersion:2,versions:[guardTarget]},addUtcDays(today,1),{model:'retainer'});
    await rejectGuard({contract_version:3,contract_version_id:badModel.id,effective_on:badModel.effectiveFrom},'23514');
    const badCurrency=await seedApplicableAmendmentVersion(pool,identities.manager,{...guard.contract,latestVersion:3,versions:[badModel]},addUtcDays(today,2),{model:'fixed_fee',currency:'USD'});
    await rejectGuard({contract_version:4,contract_version_id:badCurrency.id,effective_on:badCurrency.effectiveFrom},'23514');
    assert.equal((await pool.query('select count(*)::int count from commercial_amendments where entity_id=any($1::text[])',[[guard.contract.id,guard.engagement.id,guard.project.id]])).rows[0].count,0,'no direct-bypass attempt leaves an orphan adoption');
    const finalReplay=await migrateCommercialDatabase(pool);assert.deepEqual(finalReplay.applied,[]);
  });
});
console.log('Commercial amendments real PostgreSQL/HTTP fresh, 042 upgrade/replay, explicit scope/permissions, per-entity no-cascade adoption, decimal sibling race, stale preview/sequences, pending/date/lifecycle guards, atomic audit rollback and immutable history gates passed.');
