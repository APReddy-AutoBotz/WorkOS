import {verifyFeeStatement} from './support/fixed-fee-statement-journey.mjs';
import {withLockedFeeDate,assertFeePeriodConflict} from './support/fixed-fee-period-authority.mjs';
import {verifyFixedFeeProgress} from './support/fixed-fee-progress-journey.mjs';
import {checkElapsedHistory} from './support/fixed-fee-revenue-history.mjs';
import {adoptHourlyRate} from './support/adopt-hourly-rate.mjs';
import {runMigrations} from '../server/migrate.mjs';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture, withCommercialDatabase, withCommercialMigrationsThrough, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval, adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE} from './support/work-approval-test.mjs';
import {actualCatalog} from './support/actual-work-test.mjs';
import {amendmentTransition,createAmendmentHierarchy, grantAmendmentPermissions, addUtcDays, seedApplicableAmendmentVersion, amendmentWorkspace, amendmentInput, amendmentPreview, amendmentApply} from './support/commercial-amendments-test.mjs';
const runFixedFeeJourney=profile=>withCommercialDatabase(async ({pool,databaseUrl})=>{
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
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['099_wos06_fixed_fee_work_costs','100_wos06_fixed_fee_completion_forecasts','101_wos06_fixed_fee_elapsed_values','102_wos06_fixed_fee_margin_access','103_wos06_fixed_fee_progress_values','104_wos06_fixed_fee_transition_approval','105_wos06_fixed_fee_valuation_periods','106_wos06_fixed_fee_period_statements']);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,billableHours:'3.75',nonBillableHours:'0.75'});
    const costPath='/engagements/'+engagement.id+'/fixed-fee-costs';
    const inspect=()=>request(costPath+'?monthStart='+monthStart);
    assert.equal((await inspect()).status,403);
    const grants=['commercial.fixed_fee_cost.view','commercial.fixed_fee_cost.record','commercial.cost_candidates.manage',
      'commercial.cost_candidates.view','commercial.cost_approvals.decide','employees.view','approvals.view'];
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k
      on conflict(role_name,permission_key) do update set enabled=true`,[grants]);
    if (profile!=='elapsed') return verifyFixedFeeProgress({reduction:profile==='reduction',databaseUrl,pool,request,post,baseUrl,tokenFor,identities,contract,engagement,project,today,end,grants});
    const riskPath='/engagements/'+engagement.id+'/fixed-fee-risk?through=';
    const risk=async()=>{
      const response=await request(riskPath+today);
      assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
    };
    assert.equal((await risk()).status,'incomplete');
    assert.equal((await risk()).laborCostBudget,null);
    assert.equal((await risk()).effortBudget,null);
    assert.equal((await request(riskPath+addUtcDays(today,1))).status,404);
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) select 'Employee',k,true from unnest($1::text[]) k
      on conflict(role_name,permission_key) do update set enabled=true`,[['commercial.fixed_fee_cost.view','commercial.cost_candidates.view']]);
    assert.equal((await request(riskPath+today,{identity:identities.reader})).status,403);
    await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key='commercial.fixed_fee_cost.view'");
    const forecastPath='/engagements/'+engagement.id+'/fixed-fee-forecast';
    const forecast=async(version)=>{
      const r=await request(forecastPath+'?through='+today+(version?'&version='+version:''));
      assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
    };
    const original=await forecast();
    const makeCommand=(source)=>({through:today,expectedVersion:source.latestVersion,expectedToken:source.token,
      remainingHours:'6.25',remainingCost:'30.1725',requestId:randomUUID(),reason:'Synthetic remaining delivery estimate'});
    const firstCmd=makeCommand(original);
    const record=body=>request(forecastPath,{method:'POST',body});
    assert.equal((await record(firstCmd)).status,403);
    assert.equal((await request(forecastPath+'?through='+today,{identity:identities.reader})).status,403);
    const comparisonPath=forecastPath+'?through='+today+'&view=margin_reconciliation';
    assert.equal((await request(comparisonPath)).status,403);
    grants.push('commercial.fixed_fee_forecast.record','commercial.fixed_fee_margin.view');
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_margin.view',true) on conflict(role_name,permission_key) do update set enabled=true");
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_forecast.record',true) on conflict(role_name,permission_key) do update set enabled=true");
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
      assert.equal((await record(firstCmd)).status,409);
      const elapsedDesk=exposure.getByRole('region',{name:'Fixed-fee operational earned-management value'});
      await elapsedDesk.getByRole('button',{name:'Inspect elapsed service day'}).click();
      await elapsedDesk.getByText('No effective approved elapsed-time policy for this service day.').waitFor();
      const periodDesk=elapsedDesk.getByRole('region',{name:'Elapsed-time period reconciliation'});
      await periodDesk.getByLabel('Period starts on').fill(today);
      await periodDesk.getByRole('button',{name:'Reconcile period'}).click();
      await periodDesk.getByText('0 matched · 0 missing · 0 stale · 1 outside policy').waitFor();
      await periodDesk.getByText('Reconciled elapsed-time value: Unavailable').waitFor();
      const disabledRevenue=await request(forecastPath+'?through='+today+'&view=revenue_reconciliation');
      assert.equal(disabledRevenue.status,200,JSON.stringify(disabledRevenue.body));
      assert.deepEqual(disabledRevenue.body.revenue,{applicableDays:0,missingDays:0,staleDays:0,earnedAmount:null,remainingRevenue:null});
      const desk=exposure.getByRole('region',{name:'Fixed-fee completion forecast'});
      await desk.getByRole('button',{name:'Inspect completion forecast'}).click();
      await desk.getByText('Reconciled elapsed-time revenue through '+today+': Unavailable').waitFor();
      await desk.getByLabel('Remaining forecast hours').fill('6.25');
      await desk.getByLabel('Remaining labor cost (GBP)').fill('30.1725');
      await desk.getByLabel('Expected total revenue at completion (GBP, optional)').fill('130.1234');
      await desk.getByLabel('Forecast assumptions').fill('Synthetic remaining delivery work');
      await desk.getByRole('button',{name:'Record completion forecast'}).click();
      await desk.getByText('Forecast hours versus budget: Unavailable').waitFor();
      await desk.getByText('Forecast labor cost versus budget: Unavailable').waitFor();
      await desk.getByText('Actual margin after labor cost: Unavailable').waitFor();
      await desk.getByText('Remaining margin after labor cost: Unavailable').waitFor();
      await desk.getByText('Forecast margin after labor cost: Unavailable').waitFor();
      await desk.getByText('Expected total revenue at completion: GBP 130.1234').waitFor();
      await desk.getByText('Estimate at completion: 10.75 hours · Labor cost Unavailable GBP').waitFor();
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
    const invalidBudget=amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),revision,{laborCostBudget:'55'});
    assert.equal((await request('/amendments/Contract/'+contract.id+'/preview',{method:'POST',body:invalidBudget})).status,422);
    await amendmentApply(request,'Contract',contract.id,amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),revision));
    assert.equal((await risk()).allocation,'50');
    const event=await amendmentApply(request,'Engagement',engagement.id,amendmentInput(await amendmentWorkspace(request,'Engagement',engagement.id),revision,{endsOn:end,budget:'70.864',laborCostBudget:'60.5',budgetHours:'5.25',elapsedTimePolicy:'2'}));
    const {rows:[fractions]}=await pool.query(`select array(select fixed_fee_elapsed_amount(1,2,i,3)::text from generate_series(1,3) i) thirds,
      fixed_fee_elapsed_amount(0.01,2,1,2)::text tie, fixed_fee_elapsed_amount(0.01,2,2,2)::text residual,
      fixed_fee_elapsed_amount(123.4567,3,1,1)::text single_day,
      (select sum(fixed_fee_elapsed_amount(99999999999999.9999,4,i,366))::text from generate_series(1,366) i) leap_year,
      fixed_fee_elapsed_amount(1,2,0,7) before_start,fixed_fee_elapsed_amount(1,2,8,7) after_end`);
    assert.deepEqual(fractions,{thirds:['0.33','0.34','0.33'],tie:'0.01',residual:'0',single_day:'123.457',
      leap_year:'99999999999999.9999',before_start:null,after_end:null});
    const elapsedPath='/engagements/'+engagement.id+'/fixed-fee-elapsed';
    const rangePath=(from,through)=>elapsedPath+'-period?'+new URLSearchParams({from,through});
    const range=rangePath(addUtcDays(today,-1),today);
    const revenue=async(version=1)=>(await request(forecastPath+'?through='+today+'&view=revenue_reconciliation&version='+version)).body.revenue;
    assert.deepEqual(await revenue(),{applicableDays:1,missingDays:1,staleDays:0,earnedAmount:null,remainingRevenue:null});
    const beforeRetain=(await request(range)).body;
    assert.deepEqual([beforeRetain.amount,beforeRetain.missing,beforeRetain.inapplicable],[null,1,1]);
    assert.equal((await request(rangePath(addUtcDays(today,-366),today))).status,400);
    assert.equal((await request(rangePath(today,addUtcDays(today,1)))).status,404);
    assert.equal((await request(range,{identity:identities.reader})).status,403);
    const daily=await request(elapsedPath+'?serviceDay='+today);
    assert.equal(daily.status,200,JSON.stringify(daily.body));
    assert.deepEqual([daily.body.report.dayNumber,daily.body.report.serviceDays,daily.body.report.allocation,daily.body.report.amount,
      daily.body.report.policyVersion,daily.body.saved],[1,31,'70.864','2.29',event.id,null]);
    const retainDay={serviceDay:today,policyVersion:event.id,lifecycleId:daily.body.report.lifecycleId,parentLifecycleId:daily.body.report.parentLifecycleId,expectedVersion:0};
    assert.equal((await request(elapsedPath,{method:'POST',body:retainDay})).status,403);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_elapsed.record',true) on conflict(role_name,permission_key) do update set enabled=true");
    assert.equal((await request(elapsedPath,{method:'POST',body:{...retainDay,amount:'1'}})).status,400);
    assert.equal((await request(elapsedPath,{method:'POST',body:{...retainDay,policyVersion:'stale'}})).status,409);
    await withLockedFeeDate({pool,request,post,date:today,whileCreating:()=>request(elapsedPath,{method:'POST',body:retainDay}),check:async()=>{
      assertFeePeriodConflict(await request(elapsedPath,{method:'POST',body:retainDay}));
      assert.equal((await request(elapsedPath+'?serviceDay='+today)).body.latestVersion,0);
    }});
    const [firstDay,retryDay]=await Promise.all([post(elapsedPath,retainDay),post(elapsedPath,retainDay)]);
    assert.deepEqual(firstDay.saved,retryDay.saved);
    assert.equal(firstDay.saved.version,1);
    await verifyFeeStatement({pool,request,post,today,engagement,identities,profile:'elapsed',snapshotId:firstDay.saved.id,amount:'2.29'});
    await checkElapsedHistory(pool,commercialFixture.organizationId,commercialFixture.legalEntityId,engagement.id,today);
    const reconciled=(await request(range)).body;
    assert.deepEqual([reconciled.matched,reconciled.missing,reconciled.stale,reconciled.inapplicable,reconciled.amount,reconciled.currency],[1,0,0,1,'2.29','GBP']);
    assert.deepEqual(reconciled.days[1],{serviceDay:today,status:'matched',snapshotId:firstDay.saved.id,version:1,retainedAmount:'2.29',applicableAmount:'2.29'});
    assert.equal((await request(elapsedPath+'?serviceDay='+today+'&version=1')).body.saved.id,firstDay.saved.id);
    assert.equal((await request(elapsedPath+'?serviceDay='+today,{identity:identities.reader})).status,403);
    assert.equal((await request(elapsedPath+'?serviceDay='+addUtcDays(today,-1))).body.report,null);
    assert.equal((await request(elapsedPath+'?serviceDay='+addUtcDays(today,1))).body.report,null);
    await assert.rejects(pool.query('update commercial_fixed_fee_elapsed_values set version=2 where id=$1',[firstDay.saved.id]));
    const exhausted=await risk();
    assert.deepEqual(exhausted.effortBudget,{budgetHours:'5.25',verifiedHours:'4.5',remainingHours:'0.75',unresolvedEntries:0,status:'remaining'});
    assert.deepEqual([exhausted.laborCostBudget,exhausted.remainingLaborBudget,exhausted.laborBudgetStatus],['60.5','-10.364','exceeded']);
    assert.deepEqual([exhausted.status,exhausted.allocation,exhausted.remainingAllocation,exhausted.contractVersionId,exhausted.amendmentId],
      ['exhausted','70.864','0',revision.id,event.id]);
    const inspected=await forecast();
    const revised={...makeCommand(inspected),expectedTotalRevenue:'0'};
    assert.equal((await record({...revised,expectedTotalRevenue:'-1'})).status,400);
    assert.equal((await record({...revised,estimatedCost:'0'})).status,400);
    await pool.query(`create function reject_test_forecast_audit() returns trigger language plpgsql as $$begin
      raise exception 'Synthetic forecast audit failure';end $$;
      create trigger reject_test_forecast before insert on audit_logs for each row when(new.entity_type='Fixed Fee Completion Forecast')
      execute function reject_test_forecast_audit()`);
    assert.equal((await record(revised)).status,503);
    assert.equal((await forecast()).latestVersion,1);
    await pool.query('drop trigger reject_test_forecast on audit_logs');
    const [one,two]=await Promise.all([record(revised),record(revised)]);
    for (const r of [one,two]) assert.equal(r.status,201,JSON.stringify(r.body));
    assert.deepEqual(one.body.saved,two.body.saved);
    assert.equal(one.body.saved.report.expectedTotalRevenue,'0');
    const comparison=async version=>{
      const r=await request(forecastPath+'?through='+today+'&view=budget_comparison&version='+version);
      assert.equal(r.status,200); return r.body.budgetVariance;
    };
    assert.deepEqual(await comparison(1),{hours:null,laborCost:null});
    assert.deepEqual(await comparison(2),{hours:'5.5',laborCost:'40.5365'});
    const marginAt=async version=>(await request(forecastPath+'?through='+today+'&view=labor_margin&version='+version)).body.laborMargin;
    assert.equal((await forecast(2)).laborMargin,undefined);
    assert.deepEqual(await marginAt(2),{amount:'-101.0365',percent:null});
    assert.equal(await marginAt(1),null);
    assert.equal((await request(forecastPath+'?through='+today+'&view=labor_margin',{identity:identities.reader})).status,403);
    assert.equal((await record({...revised,expectedTotalRevenue:'1'})).status,409);
    assert.deepEqual([one.body.saved.version,one.body.saved.report.estimatedCost,one.body.saved.report.estimatedHours,
      one.body.saved.report.budgetCost,one.body.saved.report.budgetHours],[2,'101.0365','10.75','60.5','5.25']);
    assert.equal((await record({...revised,remainingCost:'0'})).status,409);
    assert.equal((await record({...revised,requestId:randomUUID()})).status,409);
    assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Fixed Fee Completion Forecast'")).rows[0].n,2);
    assert.deepEqual(await revenue(2),{applicableDays:1,missingDays:0,staleDays:0,earnedAmount:'2.29',remainingRevenue:'-2.29'});
    const positive=await record({...makeCommand(await forecast()),view:'labor_margin',expectedTotalRevenue:'130.1234'});
    assert.equal(positive.status,201);
    assert.deepEqual(positive.body.laborMargin,{amount:'29.0869',percent:'22.35'});
    assert.deepEqual(await marginAt(3),positive.body.laborMargin);
    const split=async version=>(await request(comparisonPath+'&version='+version)).body.marginComparison;
    const aligned=await split(3);
    assert.equal(aligned.forecastCurrent,true);
    assert.deepEqual(aligned.actual,{amount:'-68.574',percent:'-2994.50'});
    assert.deepEqual(aligned.remaining,{amount:'97.6609',percent:'76.40'});
    assert.deepEqual((await split(2)).remaining,{amount:'-32.4625',percent:null});
    const priorBasis=await split(1);
    assert.deepEqual(priorBasis,{actual:aligned.actual,remaining:null,forecastCurrent:false});
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.fixed_fee_margin.view'");
    assert.equal((await request(comparisonPath)).status,403);
    assert.equal(await marginAt(3),null);
    assert.equal((await revenue(3)).remainingRevenue,'127.8334');
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.fixed_fee_margin.view'");
    assert.equal((await revenue(3)).remainingRevenue,'127.8334');
    const lower=await record({...makeCommand(await forecast()),view:'budget_comparison',remainingHours:'0',remainingCost:'0'});
    assert.equal(lower.status,201);
    assert.deepEqual(lower.body.budgetVariance,{hours:'-0.75',laborCost:'10.364'});
    assert.equal((await request(forecastPath+'?through='+today+'&view=budget_comparison',{identity:identities.reader})).status,403);
    const futureVersion=await seedApplicableAmendmentVersion(pool,identities.manager,{...contract,latestVersion:2},addUtcDays(today,1));
    await amendmentApply(request,'Contract',contract.id,amendmentInput(await amendmentWorkspace(request,'Contract',contract.id),futureVersion));
    const next=amendmentInput(await amendmentWorkspace(request,'Engagement',engagement.id),futureVersion,{elapsedTimePolicy:'disabled'});
    const {elapsedTimePolicy,...unchecked}=next;
    assert.equal((await request('/amendments/Engagement/'+engagement.id+'/preview',{method:'POST',body:unchecked})).status,422);
    const inherited=await amendmentPreview(request,'Engagement',engagement.id,next);
    assert.deepEqual([inherited.before.budgetHours,inherited.after.budgetHours],['5.25','5.25']);
    assert.deepEqual([inherited.before.laborCostBudget,inherited.after.laborCostBudget],['60.5','60.5']);
    const tampered=await request('/amendments/Engagement/'+engagement.id,{method:'POST',body:{...next,budgetHours:'0',previewToken:inherited.previewToken}});
    assert.equal(tampered.status,409);
    const futureBudget=await amendmentApply(request,'Engagement',engagement.id,{...next,laborCostBudget:'0',budgetHours:'0'});
    assert.equal(futureBudget.laborCostBudget,'0');
    assert.equal(futureBudget.budgetHours,'0');
    assert.equal((await risk()).laborCostBudget,'60.5');
    await assert.rejects(pool.query("update timesheet_entries set remark='Synthetic changed evidence' where project_id=$1 and hours=2.5",[project.id]),e=>e.code==='WWP01');
    const historicalSheet=randomUUID();
    await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      values($1,$2,$3,'Approved',1,1,$4,$5)`,[historicalSheet,commercialFixture.ownerId,addUtcDays(today,7),commercialFixture.organizationId,commercialFixture.legalEntityId]);
    await pool.query(`insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,category_code,billable)
      values($1,$2,'Project Work',$3,1,'BILL',true)`,[historicalSheet,project.id,today]);
    assert.deepEqual(await read(),{...empty,verifiedEntries:3,unresolvedEntries:1,billableHours:'3.75',nonBillableHours:'0.75'});
    assert.equal((await inspect()).body.complete,false);
    const oldForecast=(await forecast(1)).saved;
    assert.equal(oldForecast.report.expectedTotalRevenue,'130.1234');
    assert.equal(oldForecast.report.estimatedCost,null);
    assert.equal(oldForecast.report.actualHours,'4.5');
    const missing=await forecast();
    const incompleteForecast=await record({...makeCommand(missing),remainingHours:'0',remainingCost:'0'});
    assert.equal(incompleteForecast.status,201);
    assert.deepEqual(await comparison(incompleteForecast.body.saved.version),{hours:null,laborCost:null});
    assert.equal(incompleteForecast.body.saved.report.expectedTotalRevenue,undefined);
    assert.deepEqual([incompleteForecast.body.saved.report.estimatedHours,incompleteForecast.body.saved.report.estimatedCost],[null,null]);
    assert.equal((await forecast(2)).saved.report.estimatedCost,'101.0365');
    await assert.rejects(pool.query("update commercial_fixed_fee_forecasts set reason='Synthetic history edit' where id=$1",[oldForecast.id]));
    const incomplete=await risk();
    assert.deepEqual(incomplete.effortBudget,{budgetHours:'5.25',verifiedHours:'4.5',remainingHours:'0.75',unresolvedEntries:1,status:'incomplete'});
    assert.deepEqual([incomplete.status,incomplete.complete,incomplete.laborBudgetStatus],['incomplete',false,'exceeded']);
    await amendmentTransition(request,'Project',project.id,1,contract.versions[0].id,'On Hold');
    await amendmentTransition(request,'Engagement',engagement.id,1,contract.versions[0].id,'On Hold');
    assert.equal((await revenue(3)).remainingRevenue,null);
    const incompleteSplit=await split(3);
    assert.deepEqual([incompleteSplit.actual,incompleteSplit.remaining],[null,null]);
    const held=(await request(range)).body;
    assert.deepEqual([held.stale,held.amount,held.days[1].applicableAmount,held.days[1].retainedAmount],[1,null,null,'2.29']);
    await amendmentTransition(request,'Engagement',engagement.id,2,contract.versions[0].id);
    const resumed=(await request(elapsedPath+'?serviceDay='+today)).body;
    const changed=(await request(range)).body;
    assert.deepEqual([changed.stale,changed.amount,changed.days[1].applicableAmount],[1,null,'2.29']);
    const replacement=await post(elapsedPath,{...retainDay,expectedVersion:1,lifecycleId:resumed.report.lifecycleId});
    assert.equal((await revenue(3)).remainingRevenue,'127.8334');
    assert.equal((await revenue(incompleteForecast.body.saved.version)).remainingRevenue,null);
    const restored=(await request(range)).body;
    assert.deepEqual([restored.matched,restored.amount,restored.days[1].version,restored.days[1].snapshotId],[1,'2.29',2,replacement.saved.id]);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.view_utilization'");
    assert.equal((await request(range)).status,403);
    assert.equal((await request(path)).status,403);
  });
});
await runFixedFeeJourney('elapsed');
await runFixedFeeJourney('progress');
await runFixedFeeJourney('reduction');
console.log('Fixed-fee elapsed and cumulative progress journeys passed.');
