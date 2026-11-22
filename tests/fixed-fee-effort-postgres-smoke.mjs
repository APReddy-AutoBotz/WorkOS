import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {fileURLToPath} from 'node:url';
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
  await withCommercialApi({databaseUrl,identities},async ({request,baseUrl,tokenFor})=>{
    const post=async(path,body,status=201,identity=identities.manager)=>{
      const r=await request(path,{method:'POST',body,identity});
      assert.equal(r.status,status,JSON.stringify(r.body)); return r.body;
    };
    const end=addUtcDays(today,30);
    const {project,engagement}=await createAmendmentHierarchy(request,'SYN-FIXED-EFFORT',{
      contract:{model:'fixed_fee',startsOn:today,endsOn:end,effectiveFrom:today},
      engagement:{startsOn:today,endsOn:end},project:{startsOn:today,endsOn:end}});
    const monthStart=today.slice(0,7)+'-01';
    const path='/engagements/'+engagement.id+'/fixed-fee-effort?monthStart='+monthStart;
    const read=async(identity=identities.manager)=>{
      const r=await request(path,{identity});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
    };
    const empty={engagementId:engagement.id,monthStart,verifiedEntries:0,unresolvedEntries:0,billableHours:'0',nonBillableHours:'0'};
    await post('/api/v1/work-categories/catalogs',{expectedLatestId:null,effectiveFrom:today,definition:actualCatalog,reason:'Synthetic categories'});
    await adoptStagedPolicy(request,identities,today);
    await post('/api/allocations',{employee_id:commercialFixture.ownerId,project_id:project.id,percentage:20,
      start_date:today,end_date:today,billable:true,status:'Active'},200);
    const {instance}=await submitStagedWork(request,identities.reader,today,{entries:['1.25','2.5','0.75'].map(hours=>({
      project_id:project.id,work_type:'Project Work',category_code:hours==='0.75'?'NONBILL':'BILL',work_date:today,hours,billable:hours!=='0.75',remark:'Synthetic work'}))});
    const decide=async(identity)=>{
      const current=await request(WORK_APPROVAL_BASE+'/instances/'+instance.id);
      assert.equal(current.status,200);
      const v=current.body.instance;
      return post(WORK_APPROVAL_BASE+'/instances/'+instance.id+'/decisions',{expectedOwnerKey:await readApprovalOwner(request,identity),
        expectedSourceToken:v.sourceToken,expectedSequence:v.state.sequence,requestId:randomUUID(),decision:'Approved',
        reason:'Synthetic fixed-fee stage approval'},201,identity);
    };
    await decide(identities.manager);
    assert.deepEqual(await read(),empty);
    await decide(identities.second);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,billableHours:'3.75',nonBillableHours:'0.75'});
    assert.deepEqual(await read(identities.first),empty);
    assert.equal((await request(path.replace(monthStart,monthStart.slice(0,8)+'02'))).status,400);
    const fixture=await startFixtureServer({root:fileURLToPath(new URL('../',import.meta.url)),fixtures:['commercial-drafting'],apiUrl:baseUrl});
    let browser;
    try {
      const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
      browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
      const page=await browser.newPage();
      const {organizationId,legalEntityId}=commercialFixture;
      await page.addInitScript(({session,scope,token})=>{
        sessionStorage.setItem('workos_session',JSON.stringify(session));
        sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
        sessionStorage.setItem('workos_api_token',token);
      },{session:{id:identities.manager.id,userName:identities.manager.username,name:'Synthetic effort reviewer',role:'Admin',permissionRole:'Admin',
        permissions:['commercial.contracts.view','employees.view','reports.view_utilization']},scope:{organizationId,legalEntityId},token:tokenFor(identities.manager)});
      await page.goto(fixture.url+'/tests/fixtures/commercial-drafting.html?live=1');
      const report=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:new RegExp(engagement.code)})}).getByRole('region',{name:'Fixed-fee approved effort'});
      await report.getByLabel('Effort month').fill(today.slice(0,7));
      await report.getByRole('button',{name:'Inspect approved effort'}).click();
      await report.getByText('3.75 billable hours · 0.75 non-billable hours · 3 verified entries · 0 unresolved entries').waitFor();
    } finally {try {if (browser) await browser.close();} finally {await fixture.close();}}
    await assert.rejects(pool.query("update timesheet_entries set remark='Synthetic changed evidence' where project_id=$1 and hours=2.5",[project.id]),e=>e.code==='WWP01');
    const historicalSheet=randomUUID();
    await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,$3,'Approved',1,1,$4,$5)`,[historicalSheet,commercialFixture.ownerId,addUtcDays(today,7),commercialFixture.organizationId,commercialFixture.legalEntityId]);
    await pool.query(`insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,category_code,billable)
      values($1,$2,'Project Work',$3,1,'BILL',true)`,[historicalSheet,project.id,today]);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,unresolvedEntries:1,billableHours:'3.75',nonBillableHours:'0.75'});
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.view_utilization'");
    assert.equal((await request(path)).status,403);
  });
});
console.log('Fixed-fee approved effort, worker scope and permission checks passed.');
