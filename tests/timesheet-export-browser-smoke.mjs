import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedCapacity} from './support/worker-capacity-test.mjs';
import {seedWorkPeriods,workAllocation} from './support/work-assignment-test.mjs';
import {grantAmendmentPermissions,createAmendmentHierarchy} from './support/commercial-amendments-test.mjs';
import {workPermissions} from './support/work-assignment-test.mjs';
import {parseCsv} from './support/csv-output-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hostile='\t=SUM(1,2)';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);
 const {identities,today}=await seedCapacity(pool);
 await seedWorkPeriods(pool,today);await grantAmendmentPermissions(pool);
 await withCommercialApi({databaseUrl,identities},async({baseUrl:apiUrl,request,tokenFor})=>{

  const roots=await createAmendmentHierarchy(request,'SYN-CSV-EXPORT');
  assert.equal((await request('/api/allocations',{method:'POST',body:workAllocation(roots.project.id,today)})).status,200);
  const entries=[hostile,'Ordinary "quoted", note'].map(remark=>({work_type:'Project Work',project_id:roots.project.id,category:'Synthetic export test',work_date:today,hours:1,remark,billable:false}));
  const saved=await request('/api/timesheets',{method:'POST',identity:identities.reader,body:{employee_id:f.ownerId,week_ending:today,status:'Submitted',entries}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const sourceSnapshot=async()=>{
   const rows={};for(const table of ['timesheets','timesheet_entries','work_submission_evidence'])
    rows[table]=(await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
   return rows;
  };
  const before=await sourceSnapshot();
  const fixtureServer = await startFixtureServer({root, fixtures: ['timesheet-export'], apiUrl, modules: {csv: 'src/lib/csv.ts'}});
  let browser;
  try {
   browser=await chromium.launch({headless:true});
   const context=await browser.newContext({acceptDownloads:true});
   await context.addInitScript(({identity,token,scope,permissions})=>{
    sessionStorage.setItem('workos_session',JSON.stringify({id:identity.id,employeeId:identity.id,name:'Synthetic export operator',role:'Admin',permissionRole:'Admin',permissions}));
    sessionStorage.setItem('workos_api_token',token);
    sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
   },{identity:identities.manager,token:tokenFor(identities.manager),scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},permissions:workPermissions});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`${fixtureServer.url}/tests/fixtures/timesheet-export.html`,{waitUntil:'domcontentloaded',timeout:60000});
   await page.locator('tbody tr').filter({hasText:today}).waitFor();
   await page.locator('select').first().selectOption(today);
   const download=page.waitForEvent('download');
   const audit=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/audit-events'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Ops Export',exact:true}).click();
   const file=await download, csv=await readFile(await file.path(),'utf8');
   assert.ok(csv.includes('"\'\t=SUM(1,2)"'),'Spreadsheet formula/control prefixes must be marked as literal text');
   assert.ok(csv.includes('"Ordinary ""quoted"", note"'),'Ordinary text and CSV field boundaries remain intact');
   assert.ok(csv.startsWith('"Employee","EmployeeId"'),'Headers use the same field quoting');
   assert.equal((await audit).status(),201,'Export audit remains operational');
   assert.equal((await pool.query("select count(*)::int n from audit_logs where action='Export' and module='Timesheet Governance' and user_id=$1",[identities.manager.id])).rows[0].n,1);
   assert.match(file.suggestedFilename(),/^timesheet-approval-export-\d{4}-\d{2}-\d{2}\.csv$/);
   const headers=['Employee','EmployeeId','WeekEnding','Status','ProjectOrClient','WorkType','Category','Date','Hours','Remark','ApprovedBy','RejectedBy','RejectionReason'];
   const parsed=parseCsv(csv);assert.deepEqual(parsed[0],headers);
   assert.equal(parsed.length,3,'Selected week excludes the legacy approved record');
   assert.ok(parsed.slice(1).every(row=>row.length===13&&row[2]===today&&row[8]==='1'));
   assert.deepEqual(parsed.slice(1).map(row=>row[9]).sort(),["'"+hostile,'Ordinary "quoted", note'].sort());
   await page.getByPlaceholder('Search by consultant name...').fill('synthetic-no-matching-worker');
   const emptyDownload=page.waitForEvent('download');
   const emptyAudit=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/audit-events'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Ops Export',exact:true}).click();
   assert.deepEqual(parseCsv(await readFile(await (await emptyDownload).path(),'utf8')),[headers],'Empty export has headers and no fabricated row');
   assert.equal((await emptyAudit).status(),201);
   const audits=(await pool.query("select details from audit_logs where action='Export' and module='Timesheet Governance' and user_id=$1 order by details",[identities.manager.id])).rows;
   assert.deepEqual(audits.map(row=>row.details),['Exported 0 timesheet approval rows from current filter scope','Exported 2 timesheet approval rows from current filter scope']);
   assert.deepEqual(await sourceSnapshot(),before,'Export encoding must not modify stored work or approval evidence');
   const sharedDownload=page.waitForEvent('download');
   await page.evaluate(async()=>{const {downloadCsv}=await import('/tests/fixtures/csv.js');downloadCsv('synthetic-shared-export.csv',[{'\t=1+1':'\ufeff＝1+1',normal:'comma, "quote"\nnext'}]);});
   const shared=await sharedDownload;
   assert.equal(shared.suggestedFilename(),'synthetic-shared-export.csv');
   assert.deepEqual(parseCsv(await readFile(await shared.path(),'utf8')),[["'\t=1+1",'normal'],["'\ufeff＝1+1",'comma, "quote"\nnext']]);
   // Expand the authorized API response at the browser boundary to isolate CSV rendering cost.
   await page.route('**/api/timesheets', async route => {
     const response = await route.fetch();
     const sheets = await response.json();
     const sheet = sheets.find(item => item.id === saved.body.id);
     assert.ok(sheet);
     const entries = Array.from({length: 10000}, (_, i) => ({...sheet.entries[i % 2], remark: 'Synthetic entry ' + i}));
     await route.fulfill({response, json: [{...sheet, entries}]});
   });
   await page.reload();
   await page.locator('tbody tr').filter({hasText:today}).waitFor();
   const exportButton = page.getByRole('button',{name:'Ops Export',exact:true});
   const largeDownload = page.waitForEvent('download');
   const largeAudit = page.waitForResponse(r=>new URL(r.url()).pathname==='/api/audit-events'&&r.request().method()==='POST');
   const responsive = await exportButton.evaluate(button => new Promise(resolve => {
     button.click();
     setTimeout(() => {
       const input = document.querySelector('input[placeholder="Search by consultant name..."]');
       input.focus();
       resolve(button.disabled && document.activeElement === input);
     }, 0);
   }));
   assert.equal(responsive, true, 'The browser must accept focus while the large export is still running');
   const largeRows = parseCsv(await readFile(await (await largeDownload).path(),'utf8'));
   assert.deepEqual(largeRows[0],headers);
   assert.equal(largeRows.length,10001);
   assert.ok(largeRows.slice(1).every((row,i)=>row.length===13 && row[9]==='Synthetic entry '+i));
   assert.equal((await largeAudit).status(),201);

   let cancelledDownloads = 0;
   page.on('download', () => { cancelledDownloads++; });
   await exportButton.evaluate(button => {
     button.click();
     setTimeout(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')),0);
   });
   const reloadApprovals = page.getByRole('button',{name:'Reload approvals'});
   await reloadApprovals.waitFor();
   assert.equal(await page.locator('tbody tr').count(),0);
   assert.equal(await exportButton.count(),0);
   assert.equal(cancelledDownloads,0);
   assert.equal((await pool.query("select count(*)::int n from audit_logs where action='Export' and module='Timesheet Governance' and user_id=$1",[identities.manager.id])).rows[0].n,3);
   await page.unroute('**/api/timesheets');
   await reloadApprovals.click();
   const submittedRow = page.locator('tbody tr').filter({hasText:today});
   await submittedRow.click();
   await page.getByRole('button',{name:'Flag Review'}).click();
   await page.locator('textarea').fill('Synthetic correction');
   let decisions = 0;
   page.on('request', req => { if (req.method()==='PATCH' && new URL(req.url()).pathname.endsWith('/status')) decisions++; });
   await page.evaluate(() => sessionStorage.setItem('workos_organization_scope',JSON.stringify({organizationId:'synthetic-other',legalEntityId:'synthetic-other'})));
   await page.getByRole('button',{name:'Send Back'}).click();
   await reloadApprovals.waitFor();
   assert.equal(await page.locator('textarea, tbody tr').count(),0);
   assert.equal(decisions,0);
   assert.equal((await pool.query('select status from timesheets where id=$1',[saved.body.id])).rows[0].status,'Submitted');
   // Another reviewer requests a correction while this browser retains the original submission.
   await reloadApprovals.click();
   await submittedRow.click();
   const decisionPath = '/api/timesheets/'+saved.body.id+'/status';
   const reject = await request(decisionPath,{method:'PATCH',body:{status:'Rejected',reason:'Synthetic revision',expected_write_token:saved.body.write_token}});
   assert.equal(reject.status,200,JSON.stringify(reject.body));
   const revised = await request('/api/timesheets',{method:'POST',identity:identities.reader,body:{
     employee_id:f.ownerId,week_ending:today,status:'Submitted',entries:entries.map(entry=>({...entry,remark:'Corrected work'}))}});
   assert.equal(revised.status,200,JSON.stringify(revised.body));
   assert.notEqual(revised.body.write_token,saved.body.write_token);
   assert.equal(revised.body.id,saved.body.id);
   const retainedBefore = await sourceSnapshot();
   const decisionCounts = async () => (await pool.query(`select
     (select count(*) from work_submission_decisions) decisions,
     (select count(*) from audit_logs where module='Timesheets' and entity_id=$1) audits`,[saved.body.id])).rows[0];
   const countsBefore = await decisionCounts();
   const staleResponse = page.waitForResponse(r=>new URL(r.url()).pathname===decisionPath && r.request().method()==='PATCH');
   await page.getByRole('button',{name:'Approve',exact:true}).click();
   const conflict = await staleResponse;
   assert.equal(conflict.request().postDataJSON().expected_write_token,saved.body.write_token);
   assert.equal(conflict.status(),409);
   await page.getByText('This timesheet changed after you reviewed it. Reload approvals and review the revised work.').waitFor();
   assert.equal((await conflict.json()).code,'WORK_REVIEW_VERSION_CHANGED');
   const staleRejection = await request(decisionPath,{method:'PATCH',body:{
     status:'Rejected',reason:'Synthetic delayed review',expected_write_token:saved.body.write_token}});
   assert.equal(staleRejection.status,409);
   assert.equal((await request(decisionPath,{method:'PATCH',body:{status:'Approved',expected_write_token:null}})).status,400);
   assert.deepEqual(await sourceSnapshot(),retainedBefore);
   assert.deepEqual(await decisionCounts(),countsBefore);
   decisions = 0;
   // Give the fixture team lead one direct report in the selected legal entity.
   const lead = identities.denied;
   const leadWorker = 'synthetic-approval-team-lead';
   await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
     values($1,'SYN-REVIEW-LEAD','Synthetic review lead','review-lead@example.test','Consultant','Delivery','US','director-commercial','Active',$2,$3)`,[leadWorker,f.organizationId,f.legalEntityId]);
   await pool.query('update users set employee_record_id=$1,employee_id=$2 where id=$3',[leadWorker,'SYN-REVIEW-LEAD',lead.id]);
   await pool.query('update employees set reporting_manager_id=$1 where id=$2',[leadWorker,f.ownerId]);
   const leadPermissions = ['employees.view','projects.view','allocations.view','timesheets.submit','timesheets.approve'];
   await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
     select 'TeamLead',key,true from unnest($1::text[]) key on conflict(role_name,permission_key) do update set enabled=true`,[leadPermissions]);
   const leadContext = await browser.newContext();
   try {
     await leadContext.addInitScript(({worker,permissions,token,scope})=>{
       sessionStorage.setItem('workos_session',JSON.stringify({id:worker,employeeId:'SYN-REVIEW-LEAD',name:'Synthetic review lead',role:'TeamLead',permissionRole:'TeamLead',permissions}));
       sessionStorage.setItem('workos_api_token',token);
       sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
     },{worker:leadWorker,permissions:leadPermissions,token:tokenFor(lead),scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId}});
     const teamPage = await leadContext.newPage();
     await teamPage.goto(fixtureServer.url+'/tests/fixtures/timesheet-export.html');
     await teamPage.locator('tbody tr').filter({hasText:today}).click();
     await teamPage.getByRole('button',{name:'Load retained history'}).click();
     await teamPage.getByRole('article',{name:'Retained submission 2'}).waitFor();
     await teamPage.getByRole('article',{name:'Retained submission 1'}).waitFor();
     const historyPath = '/api/v1/timesheets/'+saved.body.id+'/submissions?view=direct-report-review';
     await pool.query('update employees set reporting_manager_id=null where id=$1',[f.ownerId]);
     assert.equal((await request(historyPath,{identity:lead})).status,404);
     const empty = await request('/api/timesheets?view=direct-report-review',{identity:lead});
     assert.equal(empty.status,200);
     assert.deepEqual(empty.body,[]);
     await pool.query('update employees set reporting_manager_id=$1 where id=$2',[leadWorker,f.ownerId]);
     await pool.query("update role_permissions set enabled=false where role_name='TeamLead' and permission_key='timesheets.approve'");
     assert.equal((await request(historyPath,{identity:lead})).status,403);
   } finally { await leadContext.close(); }
   const previousWeek = (await pool.query("select to_char(ends_on,'YYYY-MM-DD') as day from reporting_periods where id='period-work-previous'")).rows[0].day;
   const previous = await request('/api/timesheets',{identity:identities.reader,method:'POST',body:{
     employee_id:f.ownerId,week_ending:previousWeek,status:'Submitted',entries:[{work_type:'Client Misc Task',
       client_name:'Synthetic client',work_date:previousWeek,hours:1,remark:'Synthetic work',billable:false}]}});
   assert.equal(previous.status,200,JSON.stringify(previous.body));
   await reloadApprovals.click();
   const bulk = page.getByRole('button',{name:'Bulk Approve',exact:true});
   await bulk.click();
   const preview = page.getByRole('region',{name:'Bulk approval preview'});
   await preview.getByText('Approve 2 submitted timesheets from the selected filters?').waitFor();
   await preview.getByRole('button',{name:'Cancel'}).click();
   assert.equal(decisions,0);
   const decisionRoute = '**/api/timesheets/*/status';
   await page.route(decisionRoute,async route => {
     const expectedVersion = route.request().url().includes(previous.body.id) ? previous.body.write_token : revised.body.write_token;
     assert.equal(route.request().postDataJSON().expected_write_token,expectedVersion);
     if (route.request().url().includes(previous.body.id)) {
       const accepted = await route.fetch();
       assert.equal(accepted.status(),200);
       await route.abort('failed'); // The server committed before its acknowledgement was lost.
     } else {
       await route.fulfill({status:503,json:{error:'Synthetic interruption'}});
     }
   });
   await bulk.click();
   await preview.getByRole('button',{name:'Confirm bulk approval'}).evaluate(button => { button.click(); button.click(); });
   await page.getByText('Bulk review complete. 1 of 2 timesheets currently approved.').waitFor();
   await page.getByText('View individual outcomes').click();
   await page.getByText(new RegExp(previousWeek+' · Approved · No acknowledgement')).waitFor();
   await page.getByText(new RegExp(today+' · Submitted · No acknowledgement')).waitFor();
   assert.equal(decisions,2);

   await page.route('**/api/timesheets',route=>route.fulfill({status:503,json:{error:'Synthetic refresh failure'}}));
   await bulk.click();
   await preview.getByRole('button',{name:'Confirm bulk approval'}).click();
   await reloadApprovals.waitFor();
   assert.ok(await bulk.isDisabled());
   assert.equal(decisions,3);
   await reloadApprovals.click();
   await page.getByText('Approval records could not be loaded.').waitFor();
   assert.equal(await bulk.count(),0);
   await page.unroute('**/api/timesheets');
   await page.unroute(decisionRoute);
   // A decision already accepted by the server keeps its original scope even if the UI closes.
   await reloadApprovals.click();
   await submittedRow.click();
   let releaseDecision;
   const holdResponse = new Promise(resolve => { releaseDecision = resolve; });
   let received;
   const serverDecision = new Promise(resolve => { received = resolve; });
   await page.route('**/api/timesheets/*/status',async route => {
     const headers = route.request().headers();
     const response = await route.fetch();
     received({status:response.status(),organization:headers['x-organization-id'],entity:headers['x-legal-entity-id']});
     await holdResponse;
     await route.fulfill({response});
   });
   await page.getByRole('button',{name:'Approve',exact:true}).click();
   try {
     const receipt = await Promise.race([serverDecision,delay(15000,null,{ref:false})]);
     assert.deepEqual(receipt,{status:200,organization:f.organizationId,entity:f.legalEntityId});
     await page.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
     await reloadApprovals.waitFor();
   } finally { releaseDecision(); }
   await page.waitForLoadState('networkidle');
   assert.equal(await page.locator('tbody tr').count(),0);
   assert.equal((await pool.query('select status from timesheets where id=$1',[saved.body.id])).rows[0].status,'Approved');
   assert.deepEqual(errors,[]);
  }finally{await browser?.close();await fixtureServer.close();}
 });
});
console.log('Timesheet Ops Export real browser/API/SQL: CSV integrity, responsive export, stale decisions, partial bulk approval and recovery passed.');
