import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,
  seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday,addUtcDays} from './support/commercial-amendments-test.mjs';
import {workPermissions,grantWorkPermissions,workSnapshot} from './support/work-assignment-test.mjs';
const {chromium}=await import('playwright');
const rootDir=fileURLToPath(new URL('../',import.meta.url)),hostile='<script>window.syntheticModesExecuted=true</script>';
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
  const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
  const today=await amendmentToday(pool),weekday=new Date(`${today}T00:00:00Z`).getUTCDay();
  const currentMonday=addUtcDays(today,weekday===6?2:weekday===0?1:1-weekday),currentFriday=addUtcDays(currentMonday,4);
  const monday=addUtcDays(currentMonday,-7),friday=addUtcDays(monday,4),saturday=addUtcDays(monday,-2),currentSaturday=addUtcDays(currentFriday,-6);
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('modes-browser-previous',$1,$2,'SYN-MODES-PREVIOUS','Synthetic previous',$3,$4,'Open','Weekly'),
      ('modes-browser-current',$1,$2,'SYN-MODES-CURRENT','Synthetic current',$5,$6,'Open','Weekly')`,[f.organizationId,f.legalEntityId,saturday,friday,currentSaturday,currentFriday]);
  await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,project_type,billable,start_date,end_date,status,country,organization_id,legal_entity_id)
    values('project-modes-weekend','SYN-MODES-WEEKEND','Synthetic weekend-only project',$1,'Synthetic client',$2,'Synthetic owner','Synthetic legacy model',true,$3,$3,'Active','US',$4,$5)`,[f.clientId,f.ownerId,saturday,f.organizationId,f.legalEntityId]);
  await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
    values('allocation-modes-weekend',$1,'project-modes-weekend',20,$2,$2,true,'Active',$3,$4)`,[f.ownerId,saturday,f.organizationId,f.legalEntityId]);
  const header=(await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
    values($1,$2,'Draft',1,0,$3,$4) returning id`,[f.ownerId,friday,f.organizationId,f.legalEntityId])).rows[0].id;
  for(const [date,hours,category,remark] of [[monday,'0.25000000000000001','Synthetic A',hostile],[monday,'0.5','Synthetic B','Synthetic distinct comment'],[saturday,'0.25','Synthetic weekend','Synthetic weekend comment'],[monday,'0','Synthetic zero','Synthetic zero comment']])await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,category,work_date,hours,remark,billable)
    values($1,'Client Misc Task','Synthetic context',$2,$3,$4,$5,false)`,[header,category,date,hours,remark]);
  await pool.query('update timesheets set total_hours=(select sum(hours) from timesheet_entries where timesheet_id=$1) where id=$1',[header]);
  const entries=async()=>(await pool.query('select work_date::text,hours::text,client_name,category,remark,billable from timesheet_entries where timesheet_id=$1 order by category,work_date',[header])).rows;
  await withCommercialApi({databaseUrl,identities},async({baseUrl:apiUrl,tokenFor,request})=>{
    const fixtureServer = await startFixtureServer({root: rootDir, fixtures: ['work-capture-modes'], apiUrl});
    let browser;
    try{
      const baseUrl=fixtureServer.url;
      browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1700,height:1200},timezoneId:'Pacific/Kiritimati'});
      const session={id:f.ownerId,employeeId:f.ownerId,name:'Synthetic mode operator',role:'Admin',permissionRole:'Admin',permissions:workPermissions},scope={organizationId:f.organizationId,legalEntityId:f.legalEntityId};
      await context.addInitScript(({session,scope,token})=>{sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);},{session,scope,token:tokenFor(identities.manager)});
      const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[],external=[],writes=[];
      page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{const url=new URL(r.url());if(/^https?:/.test(r.url())&&url.origin!==baseUrl)external.push(r.url());if(url.pathname.startsWith('/api/')&&r.method()!=='GET')writes.push({path:url.pathname,body:r.postDataJSON()});});
      const response=(owner,path)=>owner.waitForResponse(result=>new URL(result.url()).pathname===path&&result.request().method()==='POST');
      const save=async(owner=page,click='click')=>{const pending=response(owner,'/api/timesheets');await owner.getByRole('button',{name:'Save Draft',exact:true})[click]();const result=await pending;return result.status();};
      const rowFor=(owner,category)=>owner.locator('tbody tr').filter({has:owner.locator(`input[value="${category}"]`)});
      const ready=async owner=>{await owner.getByRole('button',{name:'Save Draft',exact:true}).waitFor();await owner.waitForFunction(()=>!document.querySelector('select[aria-label="Capture mode"]')?.disabled);};
      await page.goto(`${baseUrl}/tests/fixtures/work-capture-modes.html`);
      await page.getByText('No capture modes enabled. Ask an authorized administrator to configure modes explicitly.',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Configure capture modes',exact:true}).click();
      await page.getByText('No explicit capture modes. No default has been adopted.',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Enable weekly grid',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('Enable daily entry',{exact:true}).isChecked(),false);
      assert.equal(await page.getByRole('button',{name:'Append capture modes',exact:true}).isDisabled(),true);
      await page.getByLabel('Enable weekly grid',{exact:true}).check();await page.getByLabel('Enable daily entry',{exact:true}).check();
      const append=response(page,'/api/v1/work-capture-modes/settings');await page.getByRole('button',{name:'Append capture modes',exact:true}).dblclick();assert.equal((await append).status(),201);
      await page.getByText('Capture modes appended. Reload to review the retained version before another change.',{exact:true}).waitFor();
      assert.equal((await pool.query('select count(*)::int n from work_capture_mode_versions')).rows[0].n,1);
      await page.getByRole('button',{name:'Reload capture modes',exact:true}).click();await page.getByText('Version 1: weekly, daily.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Enter work',exact:true}).click();await ready(page);await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');
      await page.getByRole('button',{name:'Add Client Misc Task',exact:true}).click();let row=page.locator('tbody tr').last();
      await row.getByPlaceholder('Client Name...',{exact:true}).fill('Synthetic current client');await row.getByPlaceholder('Misc Task (e.g. Call, Escalation)...',{exact:true}).fill('Synthetic current');await row.getByPlaceholder('0.0',{exact:true}).fill('0.25');
      await row.getByRole('button',{name:/^Edit .* remark$/}).click();await page.getByPlaceholder('Describe your work for this day in detail...',{exact:true}).fill('Synthetic current daily comment');await page.getByRole('button',{name:'Save Daily Remark',exact:true}).click();
      assert.equal(await save(page,'dblclick'),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();
      const current=(await pool.query('select id,status from timesheets where employee_id=$1 and week_ending=$2',[f.ownerId,currentFriday])).rows[0];assert.equal(current.status,'Draft');assert.equal((await pool.query('select work_date::text from timesheet_entries where timesheet_id=$1',[current.id])).rows[0].work_date,today);
      assert.equal((await pool.query('select count(*)::int n from approval_records where entity_id=$1',[current.id])).rows[0].n,0);if(currentFriday>today)assert.equal(await page.getByRole('button',{name:'Submit for Approval',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Previous week',exact:true}).click();await ready(page);
      assert.equal(await page.locator('tbody tr').count(),2);await page.getByRole('region',{name:'Preserved off-grid entries',exact:true}).waitFor();await page.getByRole('region',{name:'Preserved unseen entries',exact:true}).waitFor();
      assert.equal(await rowFor(page,'Synthetic A').getByPlaceholder('0.0',{exact:true}).first().inputValue(),'0.25000000000000001');
      await page.getByRole('button',{name:'Add Project Entry',exact:true}).click();const weekendProject=page.locator('tbody tr').last();assert.equal(await weekendProject.locator('option[value="project-modes-weekend"]').count(),1,'assignment discovery covers the complete seven-day header');await weekendProject.getByRole('button',{name:'Remove visible entry',exact:true}).click();
      await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');await page.getByLabel('Work date',{exact:true}).selectOption('2');
      row=rowFor(page,'Synthetic A');await row.getByPlaceholder('0.0',{exact:true}).fill('0.75000000000000001');await row.getByPlaceholder('0.0',{exact:true}).fill('invalid');
      assert.equal((await row.locator('td').last().textContent()).trim(),'0.75000000000000001','invalid raw retains the most recent valid exact preview');assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
      await row.getByPlaceholder('0.0',{exact:true}).fill('0.75000000000000001');assert.equal(await save(),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();
      let stored=await entries();assert.equal(stored.length,4);assert.equal(stored.find(item=>item.category==='Synthetic A').hours,'0.75000000000000001');assert.equal(stored.find(item=>item.category==='Synthetic A').remark,hostile);assert.equal(stored.find(item=>item.category==='Synthetic weekend').work_date,saturday);assert.equal(stored.find(item=>item.category==='Synthetic zero').hours,'0');assert(stored.every(item=>item.billable===false));
      const dailyWrite=writes.filter(write=>write.path==='/api/timesheets').at(-1).body;assert.equal(dailyWrite.capture_mode,'daily');assert.match(dailyWrite.expected_write_token,/^[a-f0-9]{64}$/);assert(dailyWrite.expected_mode_policy_id);
      // An unsaved weekly row spans two weekdays. Editing its daily context
      // must retain the unseen day's original context and exact draft value.
      await page.getByLabel('Capture mode',{exact:true}).selectOption('weekly');await page.getByRole('button',{name:'Add Client Misc Task',exact:true}).click();row=page.locator('tbody tr').last();
      await row.getByPlaceholder('Client Name...',{exact:true}).fill('Synthetic mixed client');await row.getByPlaceholder('Misc Task (e.g. Call, Escalation)...',{exact:true}).fill('Synthetic mixed original');await row.getByPlaceholder('0.0',{exact:true}).nth(0).fill('0.25');await row.getByPlaceholder('0.0',{exact:true}).nth(1).fill('0.50000000000000001');
      await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');await page.getByLabel('Work date',{exact:true}).selectOption('2');
      await rowFor(page,'Synthetic mixed original').getByPlaceholder('Misc Task (e.g. Call, Escalation)...',{exact:true}).fill('Synthetic mixed Monday');
      await page.getByRole('region',{name:'Preserved unseen entries',exact:true}).getByText(/Synthetic mixed original/).waitFor();assert.equal(await save(),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();
      stored=await entries();assert.equal(stored.find(item=>item.category==='Synthetic mixed Monday').work_date,monday);assert.equal(stored.find(item=>item.category==='Synthetic mixed original').work_date,addUtcDays(monday,1));assert.equal(stored.find(item=>item.category==='Synthetic mixed original').hours,'0.50000000000000001');
      await page.getByLabel('Work date',{exact:true}).selectOption('0');assert.equal(await rowFor(page,'Synthetic weekend').getByPlaceholder('0.0',{exact:true}).inputValue(),'0.25');await page.getByLabel('Work date',{exact:true}).selectOption('2');
      const second=await context.newPage();second.setDefaultTimeout(20000);second.on('pageerror',error=>errors.push(error.message));await second.goto(`${baseUrl}/tests/fixtures/work-capture-modes.html`);await ready(second);await second.getByRole('button',{name:'Previous week',exact:true}).click();await ready(second);
      assert.equal(await save(),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();const winner=await workSnapshot(pool);assert.equal(await save(second),409);await second.getByText(/Work changed since it was loaded/).waitFor();assert.deepEqual(await workSnapshot(pool),winner);assert.equal(await second.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);await second.close();
      const latest=(await request('/api/v1/work-capture-modes/settings')).body.latestId;const disabled=await request('/api/v1/work-capture-modes/settings',{method:'POST',body:{expectedLatestId:latest,enabledModes:['weekly']}});assert.equal(disabled.status,201);
      const modeBefore=await workSnapshot(pool);assert.equal(await save(),409);await page.getByText(/Capture modes changed or this mode is disabled/).waitFor();assert.deepEqual(await workSnapshot(pool),modeBefore);
      await page.getByRole('button',{name:'Reload work',exact:true}).click();await ready(page);assert.equal(await page.getByLabel('Capture mode',{exact:true}).locator('option[value="daily"]').count(),0);
      // Retained evidence and rejection context must disappear on invalidation,
      // not remain visible under a newly selected scope while reload is blocked.
      const raw=(await request('/api/timesheets')).body.find(item=>item.id===header);
      const submit=await request('/api/timesheets',{method:'POST',body:{employee_id:f.ownerId,week_ending:friday,status:'Submitted',expected_write_token:raw.write_token,capture_mode:'weekly',expected_mode_policy_id:disabled.body.id,
        entries:raw.entries.map(item=>({work_type:item.work_type,project_id:item.project_id,client_name:item.client_name,category:item.category,work_date:String(item.work_date).slice(0,10),hours:item.hours_exact,remark:item.remark||'Synthetic completed comment',billable:item.billable}))}});assert.equal(submit.status,200,JSON.stringify(submit.body));
      const reason='Synthetic retained rejection context';assert.equal((await request(`/api/timesheets/${header}/status`,{method:'PATCH',body:{status:'Rejected',reason}})).status,200);
      await page.getByRole('button',{name:'Reload work',exact:true}).click();await ready(page);await page.getByText(`"${reason}"`,{exact:true}).waitFor();await page.getByText(/Submission 1: .* work entries retained/).waitFor();
      await page.getByRole('button',{name:'Edit Monday remark',exact:true}).first().click();await page.getByRole('dialog',{name:'Entry remarks',exact:true}).waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
      await page.getByText('Access or scope changed. Reload work explicitly for the selected legal entity.',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog',{name:'Entry remarks',exact:true}).count(),0);assert.equal(await page.getByText(`"${reason}"`,{exact:true}).count(),0);assert.equal(await page.getByText(/Submission 1: .* work entries retained/).count(),0);assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Reload work',exact:true}).click();await ready(page);
      // Real in-flight HTTP transaction waiting on the actual database lock.
      const blocker=await pool.connect();try{
        await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`commercial-lifecycle:${f.organizationId}:${f.legalEntityId}`]);
        const started=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/timesheets'&&r.method()==='POST'),pending=response(page,'/api/timesheets');await page.getByRole('button',{name:'Save Draft',exact:true}).click();await started;
        await page.evaluate(()=>window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));await page.getByText('Access or scope changed. Reload work explicitly for the selected legal entity.',{exact:true}).waitFor();await blocker.query('commit');assert.equal((await pending).status(),200);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.getByText('Draft timesheet saved.',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
      }finally{await blocker.query('rollback').catch(()=>{});blocker.release();}
      assert.equal(await page.evaluate(()=>window.syntheticModesExecuted),undefined);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();
    }finally{await browser?.close();await fixtureServer.close();}
  });
});
console.log('Fresh real React/API/PostgreSQL capture-mode journey passed: explicit configuration, current Draft daily work, exact/unseen/zero/context preservation, stale tabs/modes, owner metadata/modal cleanup and genuine in-flight scope invalidation.');
