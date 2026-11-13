import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedActualWork,adoptActualInputs,actualEntries} from './support/actual-work-test.mjs';
import {workPermissions} from './support/work-assignment-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hostile='\t=SUM(1,2)';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);
 const {identities,today}=await seedActualWork(pool);
 await withCommercialApi({databaseUrl,identities},async({baseUrl:apiUrl,request,tokenFor})=>{
  await adoptActualInputs(request,today);
  const entries=actualEntries(today).map((entry,i)=>({...entry,remark:i===0?hostile:'Ordinary "quoted", note'}));
  const saved=await request('/api/timesheets',{method:'POST',identity:identities.reader,body:{employee_id:f.ownerId,week_ending:today,status:'Submitted',entries}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const vite=await createServer({root,mode:'production',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:apiUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
  let browser;
  try {
   await vite.listen();
   browser=await chromium.launch({headless:true});
   const context=await browser.newContext({acceptDownloads:true});
   await context.addInitScript(({identity,token,scope,permissions})=>{
    sessionStorage.setItem('workos_session',JSON.stringify({id:identity.id,employeeId:identity.id,name:'Synthetic export operator',role:'Admin',permissionRole:'Admin',permissions}));
    sessionStorage.setItem('workos_api_token',token);
    sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
   },{identity:identities.manager,token:tokenFor(identities.manager),scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},permissions:workPermissions});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/actual-work.html`);
   await page.getByRole('button',{name:'Review composite work',exact:true}).click();
   await page.locator('tbody tr').filter({hasText:today}).waitFor();
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
   assert.deepEqual(errors,[]);
  }finally{await browser?.close();await vite.close();}
 });
});
console.log('Timesheet Ops Export real browser/API/SQL: literal formula prefix, normal CSV quoting, filename and audit passed.');
