import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval, adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE} from './support/work-approval-test.mjs';
import {actualCatalog} from './support/actual-work-test.mjs';
import {createAmendmentHierarchy, grantAmendmentPermissions, addUtcDays} from './support/commercial-amendments-test.mjs';

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const {today,identities}=await seedWorkApproval(pool);
  await grantAmendmentPermissions(pool);
  for (const role of ['Admin','Employee']) await pool.query(
    `insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k
     on conflict(role_name,permission_key) do update set enabled=true`,
    [role,['employees.view','reports.view_utilization','commercial.contracts.view']]);
  await withCommercialApi({databaseUrl,identities},async ({request})=>{
    const post=async(path,body,status=201,identity=identities.manager)=>{
      const r=await request(path,{method:'POST',body,identity});
      assert.equal(r.status,status,JSON.stringify(r.body)); return r.body;
    };
    const tomorrow=addUtcDays(today,1),end=addUtcDays(today,30);
    const periods=[today,tomorrow].map(day=>({startsOn:day,endsOn:day,includedHours:'10',baseFee:'100'}));
    const {project,contract,pin}=await createAmendmentHierarchy(request,'SYN-RETAINER-HOURS',{
      contract:{model:'retainer',startsOn:today,endsOn:end,effectiveFrom:today,retainerPeriods:periods},
      engagement:{startsOn:today,endsOn:end},project:{startsOn:today,endsOn:end}});
    const read=async(identity=identities.manager,version=pin)=>{
      const res=await request(`/contracts/${contract.id}/versions/${version}/retainer-consumption`,{identity});
      assert.equal(res.status,200,JSON.stringify(res.body));return res.body.periods.map(p=>[p.billableHours,p.nonBillableHours]);
    };
    await post('/api/v1/work-categories/catalogs',{expectedLatestId:null,effectiveFrom:today,definition:actualCatalog,reason:'Synthetic categories'});
    await adoptStagedPolicy(request,identities,today);
    await post('/api/allocations',{employee_id:commercialFixture.ownerId,project_id:project.id,percentage:20,
      start_date:today,end_date:today,billable:true,status:'Active'},200);
    const {instance}=await submitStagedWork(request,identities.reader,today,{entries:['1.25','2.5'].map(hours=>({
      project_id:project.id,work_type:'Project Work',category_code:'BILL',work_date:today,hours,billable:true,remark:'Synthetic work'}))});
    const empty=[['0','0'],['0','0']];
    const decide=async(identity)=>{
      const current=await request(WORK_APPROVAL_BASE+'/instances/'+instance.id);
      assert.equal(current.status,200);
      const v=current.body.instance;
      return post(WORK_APPROVAL_BASE+'/instances/'+instance.id+'/decisions',{expectedOwnerKey:await readApprovalOwner(request,identity),
        expectedSourceToken:v.sourceToken,expectedSequence:v.state.sequence,requestId:randomUUID(),decision:'Approved',
        reason:'Synthetic retainer stage approval'},201,identity);
    };
    await decide(identities.manager);
    assert.deepEqual(await read(),empty);
    await decide(identities.second);
    const approved=[['3.75','0'],['0','0']];
    assert.deepEqual(await read(),approved);
    assert.deepEqual(await read(identities.reader),approved);
    assert.deepEqual(await read(identities.first),empty);
    const {id,version,...terms}=contract.versions[0];
    const revised=await post('/contracts/'+contract.id+'/versions',{...terms,expectedVersion:version,effectiveFrom:tomorrow,
      reason:'Synthetic prospective revision'});
    assert.deepEqual(await read(identities.manager,revised.versions[0].id),empty);
    assert.deepEqual(await read(),approved);
  });
});
console.log('Retainer consumption passed pending and final approval, decimal totals, period, version and worker scope.');
