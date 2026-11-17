import assert from 'node:assert/strict';
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
   assert.deepEqual(errors,[]);
  }finally{await browser?.close();await fixtureServer.close();}
 });
});
console.log('Timesheet Ops Export real browser/API/SQL: literal formula prefix, normal CSV quoting, filename and audit passed.');
