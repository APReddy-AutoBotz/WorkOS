import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentPermissions,amendmentScope,amendmentToday,grantAmendmentPermissions,createAmendmentHierarchy,amendmentTransition} from './support/commercial-amendments-test.mjs';
import {workPermissions,grantWorkPermissions,seedWorkPeriods} from './support/work-assignment-test.mjs';
const {chromium}=await import('playwright');
const rootDir=fileURLToPath(new URL('../',import.meta.url));
const hostile='<script>window.syntheticWorkExecuted=true</script>';
// Mandatory hosted real React -> HTTP -> disposable PostgreSQL operator flow.
// No interception, business mock, local fallback, live provider or customer data.
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantAmendmentPermissions(pool);await grantWorkPermissions(pool);
  const today=await amendmentToday(pool);await seedWorkPeriods(pool,today);
  const baselineLegacy=(await pool.query('select to_jsonb(t) value from timesheet_entries t where id=$1',[f.workId])).rows;
  await withCommercialApi({databaseUrl,identities,timeZone:'America/Los_Angeles'},async({baseUrl:apiUrl,request,tokenFor})=>{
    const roots=await createAmendmentHierarchy(request,'SYN-WORK-BROWSER');
    // Fail at the actual dependency, rather than timing out on an empty select.
    // These are real scoped HTTP reads, not browser interception or mocks.
    for(const path of ['/api/employees','/api/projects','/api/allocations','/api/timesheets','/api/settings','/api/role-definitions','/api/country-directors']){
      const result=await request(path);assert.equal(result.status,200,`${path}: ${JSON.stringify(result.body)}`);assert(Array.isArray(result.body),`${path} must return its real list`);
      if(path==='/api/employees')assert(result.body.some(x=>x.id===f.ownerId&&x.status==='Active'));
      if(path==='/api/projects')assert(result.body.some(x=>x.id===roots.project.id&&x.status==='Active'));
    }
    const vite=await createServer({root:rootDir,mode:'production',clearScreen:false,logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,proxy:{'/api':{target:apiUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
    let browser;
    try{
      await vite.listen();const address=vite.httpServer.address();assert(address&&typeof address!=='string');const baseUrl=`http://127.0.0.1:${address.port}`;
      browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1100}});
      const session={id:identities.manager.id,employeeId:f.ownerId,name:'Synthetic work operator',role:'Admin',permissionRole:'Admin',permissions:[...new Set([...amendmentPermissions,...workPermissions])]};
      await context.addInitScript(({session,scope,token})=>{sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);},{session,scope:amendmentScope,token:tokenFor(identities.manager)});
      const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[],external=[],writes=[];
      page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{const url=new URL(r.url());if(/^https?:/.test(r.url())&&url.origin!==baseUrl)external.push(r.url());if(url.pathname.startsWith('/api/')&&r.method()!=='GET')writes.push({path:url.pathname,method:r.method(),body:r.postDataJSON()});});
      const response=(path,method='POST')=>page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);
      await page.goto(`${baseUrl}/tests/fixtures/work-assignment.html`);
      await page.locator('select').nth(0).selectOption(f.ownerId);await page.locator('select').nth(1).selectOption(roots.project.id);
      await page.locator('input[type=date]').nth(0).fill(today);await page.locator('input[type=date]').nth(1).fill(today);
      const allocationResponse=response('/api/allocations');await page.getByRole('button',{name:'Confirm Allocation',exact:true}).click();assert.equal((await allocationResponse).status(),200);
      await page.getByRole('button',{name:'Apply Valid Rows',exact:true}).waitFor({state:'hidden'});
      const csv=(status='Submitted')=>`employeeId,weekEnding,workType,projectId,clientName,category,date,hours,remark,billable,status,rejectionReason\n${f.ownerId},${today},Project Work,${roots.project.id},,Synthetic work,${today},2,${hostile},true,${status},\n`;
      const upload=async(name,status='Submitted')=>{
        const pending=response('/api/v1/imports/timesheets/apply');await page.locator('input[type=file]').nth(4).setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(csv(status))});const dry=await pending;assert.equal(dry.status(),200);return dry.json();
      };
      const preview=await upload('synthetic-governed-work.csv');assert.equal(preview.status,'Dry Run');assert.equal(preview.validRows,1);
      const applying=response('/api/v1/imports/timesheets/apply');await page.getByRole('button',{name:'Apply Valid Rows',exact:true}).dblclick();const applied=await applying;assert.equal(applied.status(),200);assert.equal((await applied.json()).status,'Success');
      await page.getByText('Applied 1 valid worklog import rows from synthetic-governed-work.csv.',{exact:true}).waitFor();
      const header=(await pool.query('select id,status,total_hours from timesheets where employee_id=$1 and week_ending=$2',[f.ownerId,today])).rows[0];assert.equal(header.status,'Submitted');
      const retained=(await pool.query('select id,sequence,entries from work_submission_evidence where timesheet_id=$1',[header.id])).rows;assert.equal(retained.length,1);assert.equal(retained[0].entries[0].references.length,3);assert.equal(retained[0].entries[0].remark,hostile);
      await page.getByRole('button',{name:'Review work',exact:true}).click();await page.locator('tbody tr').filter({hasText:today}).first().click();
      const assurance=page.getByRole('region',{name:'Work submission assurance',exact:true});await assurance.getByText('Submission 1: 1 work entries retained, including 1 governed entries.',{exact:true}).waitFor();await assurance.getByText(/not billing eligibility or invoice readiness/).waitFor();
      assert.equal(await page.evaluate(()=>window.syntheticWorkExecuted),undefined,'submitted remarks are rendered as text, never executed');
      // Later lifecycle changes cannot rewrite submission references. They do
      // block a new assignment save and the form announces the server rejection.
      await amendmentTransition(request,'Project',roots.project.id,1,roots.pin,'On Hold');
      await page.getByRole('button',{name:'Plan assignment',exact:true}).click();await page.locator('select').nth(0).selectOption(f.ownerId);await page.locator('select').nth(1).selectOption(roots.project.id);await page.locator('input[type=date]').nth(0).fill(today);await page.locator('input[type=date]').nth(1).fill(today);
      const heldResponse=response('/api/allocations');await page.getByRole('button',{name:'Confirm Allocation',exact:true}).click();assert.equal((await heldResponse).status(),422);await page.getByText('The governed project and every parent must be active on each relevant date.',{exact:true}).waitFor();
      assert.deepEqual((await pool.query('select id,sequence,entries from work_submission_evidence where timesheet_id=$1',[header.id])).rows,retained);
      await page.getByRole('button',{name:'Import work',exact:true}).click();const blocked=await upload('synthetic-governed-work-replacement.csv','Draft');assert.equal(blocked.validRows,0);assert(blocked.errors.some(x=>x.code==='WORK_HISTORY_IMMUTABLE'));assert.equal(await page.getByRole('button',{name:'Apply Valid Rows',exact:true}).isDisabled(),true);
      const operations=writes.filter(x=>x.path==='/api/v1/imports/timesheets/apply');assert.equal(operations.filter(x=>x.body.dryRun===false).length,1,'repeated click has one confirmed apply');
      assert.deepEqual((await pool.query('select to_jsonb(t) value from timesheet_entries t where id=$1',[f.workId])).rows,baselineLegacy);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();
    }finally{await browser?.close();await vite.close();}
  });
});
console.log('Real work assignment React/API/PostgreSQL journey passed: plan, import dry-run/apply, immutable submission assurance, double-click, hostile text, held lifecycle error, protected replacement and legacy evidence.');
