import {adoptHourlyRate} from './support/adopt-hourly-rate.mjs';
import {runMigrations} from '../server/migrate.mjs';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture, withCommercialDatabase, withCommercialMigrationsThrough, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval, adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE} from './support/work-approval-test.mjs';
import {actualCatalog} from './support/actual-work-test.mjs';
import {createAmendmentHierarchy, grantAmendmentPermissions, addUtcDays, seedApplicableAmendmentVersion, amendmentWorkspace, amendmentInput, amendmentApply} from './support/commercial-amendments-test.mjs';
await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(98,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
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
    const {project,engagement,contract}=await createAmendmentHierarchy(request,'SYN-FIXED-EFFORT',{
      contract:{model:'fixed_fee',startsOn:addUtcDays(today,-30),endsOn:end,effectiveFrom:addUtcDays(today,-30)},
      engagement:{startsOn:today,endsOn:end,budget:'50'},project:{startsOn:today,endsOn:end,budgetAllocation:'40'}});
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
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['099_wos06_fixed_fee_work_costs']);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,billableHours:'3.75',nonBillableHours:'0.75'});
    const costPath='/engagements/'+engagement.id+'/fixed-fee-costs';
    const inspect=()=>request(costPath+'?monthStart='+monthStart);
    assert.equal((await inspect()).status,403);
    const grants=['commercial.fixed_fee_cost.view','commercial.fixed_fee_cost.record','commercial.cost_candidates.manage',
      'commercial.cost_candidates.view','commercial.cost_approvals.decide','employees.view','approvals.view'];
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k
      on conflict(role_name,permission_key) do update set enabled=true`,[grants]);
    const riskPath='/engagements/'+engagement.id+'/fixed-fee-risk?through=';
    const risk=async()=>{
      const response=await request(riskPath+today);
      assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
    };
    assert.equal((await risk()).status,'incomplete');
    assert.equal((await request(riskPath+addUtcDays(today,1))).status,404);
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Employee',k,true from unnest($1::text[]) k
      on conflict(role_name,permission_key) do update set enabled=true`,[['commercial.fixed_fee_cost.view','commercial.cost_candidates.view']]);
    assert.equal((await request(riskPath+today,{identity:identities.reader})).status,403);
    await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key='commercial.fixed_fee_cost.view'");
    const costs=async()=>{
      const r=await inspect();assert.equal(r.status,200,JSON.stringify(r.body));return r.body.entries;
    };
    assert((await costs()).every(r=>r.amount===null));
    const adopt=(amount,priority,currency='GBP')=>adoptHourlyRate({request,ids:identities,workerId:commercialFixture.ownerId,today,end,currency},'cost',amount,priority);
    await adopt('99',9,'EUR');
    assert((await costs()).every(r=>r.amount===null));
    const rate=await adopt('12.3456',1);
    const entry=(await costs()).find(r=>r.hours==='2.5');
    assert.deepEqual([entry.hourlyRate,entry.amount,entry.adoptionId,entry.snapshotId],['12.3456','30.864',rate.id,null]);
    const command={entryId:entry.entryId,decisionId:entry.decisionId,adoptionId:rate.id,monthStart};
    assert.equal((await request(costPath,{method:'POST',body:{...command,amount:'1'}})).status,400);
    assert.equal((await request(costPath,{method:'POST',body:{...command,adoptionId:randomUUID()}})).status,409);
    const period=(await pool.query(`select id,status from reporting_periods where organization_id=$1 and legal_entity_id=$2
      and frequency='Weekly' and $3::date between starts_on and ends_on`,[commercialFixture.organizationId,commercialFixture.legalEntityId,today])).rows[0];
    assert(period);
    await pool.query("update reporting_periods set status='Financially Locked' where id=$1",[period.id]);
    assert.equal((await request(costPath,{method:'POST',body:command})).status,409);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k on conflict(role_name,permission_key) do update set enabled=true",[['settings.manage','periods.financial_reopen']]);
    const periodPath='/api/v1/organization-setup/financial-periods';
    const observed=await request(periodPath+'?date='+today);
    assert.equal(observed.status,200);
    await post(periodPath+'/'+period.id+'/transitions',{expectedOwnerKey:observed.body.ownerKey,
      expectedRevision:observed.body.periods.find(p=>p.id===period.id).revision,action:'reopen',reason:'Synthetic finance review'},200);
    await pool.query(`create function reject_test_fixed_cost_audit() returns trigger language plpgsql as $$begin
      raise exception 'Synthetic cost audit failure';end $$;
      create trigger reject_test_fixed_cost before insert on audit_logs for each row when(new.entity_type='Fixed Fee Work Cost')
      execute function reject_test_fixed_cost_audit()`);
    assert.equal((await request(costPath,{method:'POST',body:command})).status,503);
    assert.equal((await pool.query('select count(*)::int n from commercial_fixed_fee_work_costs')).rows[0].n,0);
    await pool.query('drop trigger reject_test_fixed_cost on audit_logs');
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
        permissions:['commercial.contracts.view','employees.view','reports.view_utilization',...grants]},scope:{organizationId,legalEntityId},token:tokenFor(identities.manager)});
      await page.goto(fixture.url+'/tests/fixtures/commercial-drafting.html?live=1');
      const report=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:new RegExp(engagement.code)})}).getByRole('region',{name:'Fixed-fee approved effort'});
      await report.getByLabel('Effort month').fill(today.slice(0,7));
      await report.getByRole('button',{name:'Inspect approved effort'}).click();
      await report.getByText('3.75 billable hours · 0.75 non-billable hours · 3 verified entries · 0 unresolved entries').waitFor();
      await report.getByRole('button',{name:'Inspect worker costs'}).click();
      const costRow=report.getByText('Cost preview GBP 30.864 · Hourly rate 12.3456').locator('..');
      await costRow.getByRole('button',{name:'Retain worker cost'}).click();
      await report.getByText('Retained cost GBP 30.864 · Hourly rate 12.3456').waitFor();
      const exposure=report.getByRole('region',{name:'Fixed-fee allocation risk'});
      await exposure.getByLabel('Include work through').fill(today);
      await exposure.getByRole('button',{name:'Check allocation risk'}).click();
      await exposure.getByText('Engagement allocation GBP 50 · Retained labor cost 30.864 · Allocation less retained cost 19.136').waitFor();
      await exposure.getByText('Some approved work still needs a verified cost.').waitFor();
    } finally {try {if (browser) await browser.close();} finally {await fixture.close();}}
    const saved=(await costs()).find(r=>r.entryId===entry.entryId);
    assert(saved.snapshotId);
    assert.deepEqual((await post(costPath,command)).entries,[saved]);
    await adopt('20',2);
    assert.deepEqual((await costs()).find(r=>r.entryId===entry.entryId),saved);
    await adopt('25',2);
    assert((await costs()).filter(r=>r.entryId!==entry.entryId).every(r=>r.amount===null));
    assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Fixed Fee Work Cost' and entity_id=$1",[saved.snapshotId])).rows[0].n,1);
    await assert.rejects(pool.query('update commercial_fixed_fee_work_costs set amount=1 where id=$1',[saved.snapshotId]));
    assert.equal((await request(costPath+'?monthStart='+monthStart,{identity:identities.reader})).status,403);
    const partial=(await inspect()).body;
    assert.equal(partial.complete,false);
    assert.deepEqual(partial.retainedTotals,[{currency:'GBP',amount:'30.864'}]);
    await adopt('20',3);
    for (const pending of (await costs()).filter(r=>!r.snapshotId)) await post(costPath,{monthStart,entryId:pending.entryId,adoptionId:pending.adoptionId,decisionId:pending.decisionId});
    const complete=(await inspect()).body;
    assert.equal(complete.complete,true);
    assert.deepEqual(complete.retainedTotals,[{currency:'GBP',amount:'70.864'}]);
    const exceeded=await risk();
    assert.deepEqual([exceeded.status,exceeded.complete,exceeded.remainingAllocation,exceeded.retainedCost,exceeded.approvedEntries,exceeded.costedEntries],
      ['exceeded',true,'-20.864','70.864',3,3]);
    const revision=await seedApplicableAmendmentVersion(pool,identities.manager,contract,today);
    await amendmentApply(request,'Contract',contract.id,amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),revision));
    assert.equal((await risk()).allocation,'50');
    const event=await amendmentApply(request,'Engagement',engagement.id,amendmentInput(await amendmentWorkspace(request,'Engagement',engagement.id),revision,{budget:'70.864'}));
    const exhausted=await risk();
    assert.deepEqual([exhausted.status,exhausted.allocation,exhausted.remainingAllocation,exhausted.contractVersionId,exhausted.amendmentId],
      ['exhausted','70.864','0',revision.id,event.id]);
    await assert.rejects(pool.query("update timesheet_entries set remark='Synthetic changed evidence' where project_id=$1 and hours=2.5",[project.id]),e=>e.code==='WWP01');
    const historicalSheet=randomUUID();
    await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,$3,'Approved',1,1,$4,$5)`,[historicalSheet,commercialFixture.ownerId,addUtcDays(today,7),commercialFixture.organizationId,commercialFixture.legalEntityId]);
    await pool.query(`insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,category_code,billable)
      values($1,$2,'Project Work',$3,1,'BILL',true)`,[historicalSheet,project.id,today]);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,unresolvedEntries:1,billableHours:'3.75',nonBillableHours:'0.75'});
    assert.equal((await inspect()).body.complete,false);
    const incomplete=await risk();
    assert.deepEqual([incomplete.status,incomplete.complete],['incomplete',false]);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.view_utilization'");
    assert.equal((await request(path)).status,403);
  });
});
console.log('Fixed-fee approved effort, worker scope and permission checks passed.');
