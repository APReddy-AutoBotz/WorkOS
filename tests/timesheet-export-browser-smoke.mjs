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
console.log('Timesheet Ops Export real browser/API/SQL: CSV integrity, responsive export, stale decisions and delayed acknowledgements passed.');
