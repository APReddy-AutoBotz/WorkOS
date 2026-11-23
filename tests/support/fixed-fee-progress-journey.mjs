import assert from 'node:assert/strict';
import {policyRevenue} from '../../server/modules/commercial-drafting/fixed-fee-earned-revenue.mjs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './compiled-fixture-server.mjs';
import {commercialFixture} from './commercial-drafting-test.mjs';
import {amendmentApply,amendmentInput,amendmentWorkspace,seedApplicableAmendmentVersion,amendmentTransition,addUtcDays} from './commercial-amendments-test.mjs';

export async function verifyFixedFeeProgress({pool,request,post,baseUrl,tokenFor,identities,contract,engagement,project,today,end,grants}) {
  const path='/engagements/'+engagement.id+'/fixed-fee-progress';
  const get=async(version)=>{const r=await request(path+'?through='+today+(version?'&version='+version:''));assert.equal(r.status,200);return r.body;};
  assert.deepEqual(await get(),{report:null,saved:null,token:null,latestVersion:0});
  const rev=await seedApplicableAmendmentVersion(pool,identities.manager,contract,today);
  await amendmentApply(request,'Contract',contract.id,amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),rev));
  const ws=await amendmentWorkspace(request,'Engagement',engagement.id);
  const input=amendmentInput(ws,rev,{endsOn:end,budget:'70',budgetHours:'5.25',effortPolicy:'2'});
  const preview='/amendments/Engagement/'+engagement.id+'/preview';
  for (const invalid of [{budgetHours:'0'},{budget:'70.001'},{elapsedTimePolicy:'2'}]) {
    assert.equal((await request(preview,{method:'POST',body:{...input,...invalid}})).status,422);
  }
  const event=await amendmentApply(request,'Engagement',engagement.id,input);
  const {report,token}=await get();
  assert.deepEqual([report.policyVersion,report.billableHours,report.nonBillableHours,report.verifiedHours,report.amount],[event.id,'3.75','0.75','4.5','60']);
  assert.equal((await request(path.replace('progress','elapsed')+'?serviceDay='+today)).body.report,null);
  const forecastPath='/engagements/'+engagement.id+'/fixed-fee-forecast';
  const live=async()=>{const r=await request(forecastPath+'?through='+today+'&view=policy_revenue');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  assert.deepEqual((await live()).revenue,{profile:'effort',status:'missing',snapshotId:null,version:null,earnedAmount:null,remainingRevenue:null});
  assert.equal((await request(forecastPath+'?through='+today+'&view=policy_margin')).status,403);
  const cmd={through:today,expectedVersion:0,expectedToken:token};
  assert.equal((await request(path,{method:'POST',body:cmd})).status,403);
  grants.push('commercial.fixed_fee_progress.record','commercial.fixed_fee_forecast.record');
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_forecast.record',true) on conflict(role_name,permission_key) do update set enabled=true");
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_progress.record',true) on conflict(role_name,permission_key) do update set enabled=true");
  assert.equal((await request(path,{method:'POST',body:{...cmd,amount:'200'}})).status,400);
  assert.equal((await request(path+'?through='+today,{identity:identities.reader})).status,403);
  const {rows:[math]}=await pool.query(`select fixed_fee_progress_amount(70,14,5,2)::text capped,fixed_fee_progress_amount(0.01,1,2,2)::text tie,
    fixed_fee_progress_amount(99999999999999.9999,1,1,4)::text maximum,fixed_fee_progress_amount(5,0,5,2)::text zero, fixed_fee_progress_amount(5,1,0,2) invalid`);
  assert.deepEqual(math,{capped:'70',tie:'0.01',maximum:'99999999999999.9999',zero:'0',invalid:null});
  await pool.query(`create function reject_test_progress_audit() returns trigger language plpgsql as $$begin
    raise exception 'Synthetic progress audit failure';end $$;
    create trigger reject_test_progress before insert on audit_logs for each row when(new.entity_type='Fixed Fee Progress Value')
    execute function reject_test_progress_audit()`);
  assert.equal((await request(path,{method:'POST',body:cmd})).status,503);
  assert.equal((await get()).latestVersion,0);
  await pool.query('drop trigger reject_test_progress on audit_logs');
  const tomorrow=addUtcDays(today,1);
  const next=await seedApplicableAmendmentVersion(pool,identities.manager,{...contract,latestVersion:2},tomorrow);
  await amendmentApply(request,'Contract',contract.id,amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),next));
  await amendmentApply(request,'Engagement',engagement.id,amendmentInput(await amendmentWorkspace(request,'Engagement',engagement.id),next,
    {endsOn:end,effortPolicy:'disabled',elapsedTimePolicy:'2'}));
  const fixture=await startFixtureServer({root:fileURLToPath(new URL('../../',import.meta.url)),fixtures:['commercial-drafting'],apiUrl:baseUrl});
  let browser;
  try {
    const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
    browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
    const page=await browser.newPage();
    const {organizationId,legalEntityId}=commercialFixture;
    await page.addInitScript(({session,scope,token})=>{
      sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
      sessionStorage.setItem('workos_api_token',token);
    },{session:{id:identities.manager.id,userName:identities.manager.username,name:'Synthetic progress reviewer',role:'Admin',permissionRole:'Admin',
      permissions:['commercial.contracts.view','employees.view','reports.view_utilization',...grants]},scope:{organizationId,legalEntityId},token:tokenFor(identities.manager)});
    await page.goto(fixture.url+'/tests/fixtures/commercial-drafting.html?live=1');
    const effort=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:new RegExp(engagement.code)})}).getByRole('region',{name:'Fixed-fee approved effort'});
    await effort.getByLabel('Effort month').fill(today.slice(0,7));
    await effort.getByRole('button',{name:'Inspect approved effort'}).click();
    const exposure=effort.getByRole('region',{name:'Fixed-fee allocation risk'});
    await exposure.getByLabel('Include work through').fill(today);
    await exposure.getByRole('button',{name:'Check allocation risk'}).click();
    const progress=exposure.getByRole('region',{name:'Fixed-fee delivery progress'});
    await progress.getByRole('button',{name:'Inspect approved delivery progress'}).click();
    await progress.getByText('Cumulative effort value: GBP 60').waitFor();
    await progress.getByRole('button',{name:'Retain progress value'}).click();
    await progress.getByText('Retained progress version 1 · GBP 60 · 4.5 verified hours').waitFor();
    const forecast=exposure.getByRole('region',{name:'Fixed-fee completion forecast'});
    await forecast.getByRole('button',{name:'Inspect completion forecast'}).click();
    await forecast.getByText('Reconciled delivery-effort revenue through '+today+': GBP 60').waitFor();
    await forecast.getByText(/Proposed first-day cumulative value: GBP 60.33/).waitFor();
    await forecast.getByLabel('Remaining forecast hours').fill('0.75');
    await forecast.getByLabel('Remaining labor cost (GBP)').fill('5');
    await forecast.getByLabel('Expected total revenue at completion (GBP, optional)').fill('70');
    await forecast.getByLabel('Forecast assumptions').fill('Synthetic progress forecast');
    await forecast.getByRole('button',{name:'Record completion forecast'}).click();
    await forecast.getByText('Remaining forecast revenue after reconciled delivery-effort value: GBP 10').waitFor();
  } finally {try {if(browser) await browser.close();} finally {await fixture.close();}}
  const results=await Promise.all([post(path,cmd),post(path,cmd)]);
  assert.deepEqual(results[0].saved,results[1].saved);
  const {rows:[retained]}=await pool.query('select sources from commercial_fixed_fee_progress_values where id=$1',[results[0].saved.id]);
  assert.equal(retained.sources.length,3);
  assert(retained.sources.every(s=>s.entryId && s.submissionId && s.decisionId && s.workerId));
  await assert.rejects(pool.query('update commercial_fixed_fee_progress_values set version=2 where id=$1',[results[0].saved.id]));
  await amendmentTransition(request,'Project',project.id,1,contract.versions[0].id,'On Hold');
  await amendmentTransition(request,'Engagement',engagement.id,1,contract.versions[0].id,'On Hold');
  assert.equal((await get()).report,null);
  assert.equal((await live()).revenue.status,'inactive');
  await amendmentTransition(request,'Engagement',engagement.id,2,contract.versions[0].id);
  const changed=await get();
  assert.notEqual(changed.token,token);
  assert.deepEqual([(await live()).revenue.status,(await live()).revenue.earnedAmount],['stale',null]);
  assert.equal((await request(path,{method:'POST',body:cmd})).status,409);
  const replacement={...cmd,expectedVersion:1,expectedToken:changed.token};
  const [second,replay]=await Promise.all([post(path,replacement),post(path,replacement)]);
  assert.equal(second.saved.version,2);
  const {scheduled,...currentRevenue}=(await live()).revenue;
  assert.deepEqual([scheduled.closingDate,scheduled.closingAmount,scheduled.residual,scheduled.amount,scheduled.snapshotId],[today,'60','10','60.33',second.saved.id]);
  assert.deepEqual(currentRevenue,{profile:'effort',status:'matched',snapshotId:second.saved.id,version:2,earnedAmount:'60',remainingRevenue:'10'});
  assert.deepEqual(second.saved,replay.saved);
  assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Fixed Fee Progress Value'")).rows[0].n,2);
  assert.deepEqual((await get(1)).saved,results[0].saved);
  const sheet=randomUUID();
  await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
    values($1,$2,$3,'Approved',1,1,$4,$5)`,[sheet,commercialFixture.ownerId,addUtcDays(today,7),commercialFixture.organizationId,commercialFixture.legalEntityId]);
  await pool.query("insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,category_code,billable) values($1,$2,'Project Work',$3,1,'BILL',true)",[sheet,project.id,today]);
  const incomplete=await get();
  assert.deepEqual([(await live()).revenue.status,(await live()).revenue.remainingRevenue],['incomplete',null]);
  assert.deepEqual([incomplete.report.unresolved,incomplete.report.amount],[1,null]);
  assert.equal((await request(path,{method:'POST',body:{...cmd,expectedToken:incomplete.token,expectedVersion:2}})).status,409);
  assert.equal((await live()).revenue.profile,'effort');
  const future=await policyRevenue(pool,null,null,[commercialFixture.organizationId,commercialFixture.legalEntityId,engagement.id,tomorrow],'GBP','70');
  assert.deepEqual(future,{profile:'transition',earnedAmount:null,remainingRevenue:null});
}
