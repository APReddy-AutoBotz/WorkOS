import {evidencePage} from '../server/modules/commercial-drafting/retainer-statement.mjs';
import {adoptHourlyRate} from './support/adopt-hourly-rate.mjs';
import assert from 'node:assert/strict';
import {priceRetainerOverage} from '../server/modules/commercial-drafting/retainer-overage.mjs';
import {retainerBalances} from '../server/modules/commercial-drafting/retainer-balances.mjs';
import {randomUUID} from 'node:crypto';
import {commercialFixture, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval, adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE} from './support/work-approval-test.mjs';
import {actualCatalog} from './support/actual-work-test.mjs';
import {createAmendmentHierarchy, grantAmendmentPermissions, addUtcDays} from './support/commercial-amendments-test.mjs';

const historyEntries=Array.from({length:103},(_,entryId)=>({entryId}));
const paged={periods:[{entries:historyEntries.slice(0,97)},{entries:historyEntries.slice(97)}]};
assert.deepEqual(evidencePage(paged).periods.flatMap(p=>p.entries),historyEntries.slice(0,100));
assert.deepEqual(evidencePage(paged,'100').periods.flatMap(p=>p.entries),historyEntries.slice(100));
assert.equal(evidencePage(paged,'100').nextOffset,null);
assert.throws(()=>evidencePage(paged,'103'),e=>e.code==='RETAINER_INVALID_PAGE');
const capacityInputs=['2026-01-01','2026-02-01'].map(day=>({startsOn:day,endsOn:day,includedHours:'2.1501'}));
const hours=capacityInputs.map((p,i)=>({...p,billableHours:i?'4.10':'1.1',nonBillableHours:'0.025'}));
for (const [policy,carried,expired,overage] of [
  ['billable_rollover','1.0501','0','0.8998'],['all_rollover','1.0251','0','0.9498'],
  ['billable_expire','0','1.0501','1.9499'],['all_expire','0','1.0251','1.9749']]) {
  const [a,b]=retainerBalances(capacityInputs,hours,policy,'2026-02-01');
  assert.equal(a.capacity.carriedOut,carried);assert.equal(a.capacity.expired,expired);
  assert.equal(b.capacity.carriedIn,carried);assert.equal(b.capacity.overage,overage);
}
const revisedBalances=retainerBalances(capacityInputs,hours,'all_rollover','2026-02-01','2026-01-20');
assert.equal(revisedBalances[0].capacity,undefined);
assert.equal(revisedBalances[1].capacity.carriedIn,'0');
assert.equal(retainerBalances(capacityInputs.slice(0,1),hours.slice(0,1),'all_rollover','2026-02-01')[0].capacity.expired,'1.0251');

await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const {today,identities}=await seedWorkApproval(pool);
  const example={startsOn:today,endsOn:today,baseFee:'100.125'};
  const roundedFee=async rounding=>(await priceRetainerOverage(pool,commercialFixture,'synthetic-unused','USD','no_charge',
    [{...example,capacity:{overage:'2'}}],[example],rounding))[0].periodPrice;
  for (const [mode,wanted] of [['HALF_EVEN','100.12'],['HALF_UP','100.13'],['DOWN','100.12']])
    assert.deepEqual(await roundedFee({mode,precision:2}),{baseFee:wanted,overage:'0.00',total:wanted});
  assert.equal(await roundedFee(null),null);
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
    const periods=[today,tomorrow].map(day=>({startsOn:day,endsOn:day,includedHours:'1.0001',baseFee:'100.125'}));
    const {project,contract,pin}=await createAmendmentHierarchy(request,'SYN-RETAINER-HOURS',{
      contract:{model:'retainer',startsOn:today,endsOn:end,effectiveFrom:today,retainerPeriods:periods,retainerCapacityPolicy:'all_rollover',retainerOveragePolicy:'contract_hourly_at_period_end',retainerRounding:{mode:'HALF_EVEN',precision:2}},
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
    const path=`/contracts/${contract.id}/versions/${pin}/retainer-consumption`;
    const full=(await request(path)).body.periods;
    assert.deepEqual(full[0].capacity,{consumed:'3.75',carriedIn:'0',remaining:'0',overage:'2.7499',expired:'0',carriedOut:'0'});
    assert.equal(full[1].capacity,undefined);
    for (const identity of [identities.reader,identities.first])
      assert((await request(path,{identity})).body.periods.every(p=>p.capacity===undefined));
    const previewPath=path.replace('retainer-consumption','retainer-overage-preview');
    const preview=async()=>{const r=await request(previewPath);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.periods[0];};
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.rate_candidates.view'");
    assert.equal((await request(previewPath)).status,403);
    for (const [role,grants] of [['Admin',['commercial.rate_candidates.view','commercial.rate_candidates.manage','commercial.rate_approvals.decide','commercial.retainer_statements.prepare']],
      ['Employee',['commercial.rate_candidates.view']]]) await pool.query(
      `insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k
       on conflict(role_name,permission_key) do update set enabled=true`,[role,grants]);
    assert.equal((await request(previewPath,{identity:identities.reader})).status,403);
    assert.equal((await preview()).status,'missing');
    const opts={request,ids:identities,contractId:contract.id,today,end,currency:contract.versions[0].currency};
    await adoptHourlyRate({...opts,currency:'JPY'},'billing','999.00');
    assert.equal((await preview()).status,'missing');
    const adoption=await adoptHourlyRate(opts,'billing','12.3456');
    const priced=await preview();
    assert.deepEqual(priced.periodPrice,{baseFee:'100.12',overage:'33.95',total:'134.07'});
    assert.deepEqual([priced.status,priced.hours,priced.amount,priced.source.adoptionId,priced.source.effectiveFrom,priced.source.effectiveTo],
      ['priced','2.7499','33.94916544',adoption.id,today,end]);
    const statementPath=path.replace('retainer-consumption','retainer-statements/'+today);
    const inspected=await request(statementPath);
    assert.equal(inspected.status,200,JSON.stringify(inspected.body));
    const statement=inspected.body.evidence;
    assert.equal(statement.closed,false);assert.equal(statement.price.source.adoptionId,adoption.id);
    assert.deepEqual(statement.price.periodPrice,priced.periodPrice);
    assert.deepEqual(statement.periods[0].entries.map(e=>e.hours).sort(),['1.25','2.5']);
    assert(statement.periods[0].entries.every(e=>e.submissionId===instance.submissionId && e.decisionId && e.entryId && e.engagementId && e.projectId===project.id));
    const attempted=await request(statementPath,{method:'POST',body:{sourceHash:inspected.body.sourceHash,previousId:null,reason:'Synthetic open period'}});
    assert.equal(attempted.status,409);assert.equal(attempted.body.error.code,'RETAINER_PERIOD_OPEN');
    await adoptHourlyRate(opts,'billing','14.00');
    const conflict=await preview(); assert.equal(conflict.status,'conflict');assert.equal(conflict.amount,null);assert.equal(conflict.source,null);assert.equal(conflict.periodPrice,null);
    const {id,version,...terms}=contract.versions[0];
    const revised=await post('/contracts/'+contract.id+'/versions',{...terms,expectedVersion:version,effectiveFrom:tomorrow,
      reason:'Synthetic prospective revision',retainerOveragePolicy:null,retainerRounding:null});
    assert.equal((await request(previewPath.replace(pin,revised.versions[0].id))).status,409);
    assert.deepEqual(await read(identities.manager,revised.versions[0].id),empty);
    assert((await request(path.replace(pin,revised.versions[0].id))).body.periods.every(p=>!p.capacity));
    assert.deepEqual(await read(),approved);
  });
});
console.log('Retainer consumption passed pending and final approval, decimal totals, period, version and worker scope.');
