import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval, adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE} from './support/work-approval-test.mjs';
import {actualCatalog} from './support/actual-work-test.mjs';
import {createAmendmentHierarchy, grantAmendmentPermissions, addUtcDays} from './support/commercial-amendments-test.mjs';
import {verifyServiceMargin} from './support/service-margin-test.mjs';
for (const marginScenario of [false,true]) await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const {today,identities}=await seedWorkApproval(pool);
  await grantAmendmentPermissions(pool);
  const grants=['commercial.contracts.view','employees.view','reports.view_utilization','commercial.service_units.decide'];
  for (const role of ['Admin','Employee']) await pool.query(
    `insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k
      on conflict(role_name,permission_key) do update set enabled=true`,[role,[...grants,'commercial.service_units.capture']]);
  await withCommercialApi({databaseUrl,identities},async ({request})=>{
    const post=async(path,body,status=201,identity=identities.manager)=>{
      const r=await request(path,{method:'POST',body,identity});
      assert.equal(r.status,status,JSON.stringify(r.body));return r.body;
    };
    const end=addUtcDays(today,30);
    const {project,engagement,pin}=await createAmendmentHierarchy(request,'SYN-RECON',{
      contract:{model:'managed_service',startsOn:today,endsOn:end,effectiveFrom:today,
        serviceDimensions:['CALL','TICKET'].map(code=>({code,label:code,precision:0,unitPrice:'50',billingPrecision:2}))},
      engagement:{startsOn:today,endsOn:end},project:{startsOn:today,endsOn:end}});
    const base='/engagements/'+engagement.id+'/service-unit-evidence';
    const capture=(dimensionCode,sourceReference,effortHours)=>post(base,{dimensionCode,sourceReference,effortHours,
      versionId:pin,serviceDate:today,quantity:'1'},201,identities.reader);
    const receipt=await capture('CALL','OPS-42','3.75');
    const path=base+'/'+receipt.id+'/reconciliation';
    const read=async()=>{const r=await request(path);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
    assert.equal((await read()).status,'pending_review');
    const review=(id,decision)=>post(base+'/'+id+'/review',{decision,reason:'Synthetic delivery verification'},201,identities.first);
    const accepted=await review(receipt.id,'Accepted');
    assert.equal((await read()).status,'no_approved_work');
    await post('/api/v1/work-categories/catalogs',{expectedLatestId:null,effectiveFrom:today,definition:actualCatalog,reason:'Synthetic categories'});
    await adoptStagedPolicy(request,identities,today);
    await post('/api/allocations',{employee_id:commercialFixture.ownerId,project_id:project.id,percentage:20,
      start_date:today,end_date:today,billable:true,status:'Active'},200);
    const {instance}=await submitStagedWork(request,identities.reader,today,{entries:[['1.25','OPS-42'],['2.5','OPS-42'],['0.75','OPS-43']].map(([hours,reference])=>({
      project_id:project.id,work_type:'Project Work',category_code:'BILL',work_date:today,hours,billable:true,remark:'Synthetic work',work_reference:reference}))});
    const decide=async(identity)=>{
      const current=await request(WORK_APPROVAL_BASE+'/instances/'+instance.id);
      assert.equal(current.status,200);
      const v=current.body.instance;
      return post(WORK_APPROVAL_BASE+'/instances/'+instance.id+'/decisions',{expectedOwnerKey:await readApprovalOwner(request,identity),
        expectedSourceToken:v.sourceToken,expectedSequence:v.state.sequence,requestId:randomUUID(),decision:'Approved',
        reason:'Synthetic work approval'},201,identity);
    };
    await decide(identities.manager);
    assert.equal((await read()).status,'no_approved_work');
    await decide(identities.second);
    assert.deepEqual(await read(),{evidenceId:receipt.id,status:'matched',approvedHours:'3.75',recordedHours:'3.75',entryCount:2});
    if (marginScenario) {
      await verifyServiceMargin({pool,request,post,capture,review,receipt,accepted,base,identities,today,end,engagement,workerId:commercialFixture.ownerId});
      return;
    }
    const mismatch=await capture('CALL','OPS-43','1');
    await review(mismatch.id,'Accepted');
    assert.deepEqual((await request(base+'/'+mismatch.id+'/reconciliation')).body,
      {evidenceId:mismatch.id,status:'hours_differ',approvedHours:'0.75',recordedHours:'1',entryCount:1});
    const other=await capture('TICKET','OPS-42','1');
    assert.equal((await read()).status,'ambiguous_reference');
    await review(other.id,'Rejected');
    assert.equal((await read()).status,'matched');
    assert.equal((await request(path,{identity:identities.first})).status,404);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.view_utilization'");
    assert.equal((await request(path)).status,403);
  });
});
console.log('Managed-service approved effort reconciliation passed.');
