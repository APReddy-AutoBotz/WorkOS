import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday,addUtcDays} from './support/commercial-amendments-test.mjs';
import {workPermissions,grantWorkPermissions,workSnapshot} from './support/work-assignment-test.mjs';
const rootDir=fileURLToPath(new URL('../',import.meta.url)),link='https://example.test/work/42?revision=1#note',nextLink='https://example.test/work/43';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);const identities=await seedCommercialIdentities(pool);await grantWorkPermissions(pool);
 const today=await amendmentToday(pool),weekday=new Date(`${today}T00:00:00Z`).getUTCDay();
 const currentMonday=addUtcDays(today,weekday===6?2:weekday===0?1:1-weekday),monday=addUtcDays(currentMonday,-7),friday=addUtcDays(monday,4),saturday=addUtcDays(monday,-2);
 await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
  values('evidence-browser-past',$1,$2,'SYN-EVIDENCE-PAST','Synthetic evidence past',$3,$4,'Open','Weekly')`,[f.organizationId,f.legalEntityId,saturday,friday]);
 const header=(await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
  values($1,$2,'Draft',1,0,$3,$4) returning id`,[f.ownerId,friday,f.organizationId,f.legalEntityId])).rows[0].id;
 for(const [date,hours,category,url] of [[monday,'0.25','Synthetic Monday',link],[saturday,'0.25','Synthetic weekend','https://example.test/weekend'],[monday,'0','Synthetic zero','https://example.test/zero']])await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,category,work_date,hours,remark,billable,evidence_url)
  values($1,'Client Misc Task','Synthetic evidence client',$2,$3,$4,'Synthetic retained comment',false,$5)`,[header,category,date,hours,url]);
 const entries=async()=>(await pool.query('select category,work_date::text,hours::text,evidence_url from timesheet_entries where timesheet_id=$1 order by category,work_date',[header])).rows;
 await withCommercialApi({databaseUrl,identities},async({baseUrl:apiUrl,tokenFor,request})=>{
  assert.equal((await request('/api/v1/work-capture-modes/settings',{method:'POST',body:{expectedLatestId:null,enabledModes:['weekly','daily']}})).status,201);
  const vite=await createServer({root:rootDir,mode:'production',clearScreen:false,logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,proxy:{'/api':{target:apiUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
  let browser;
  try{
   await vite.listen();const baseUrl=`http://127.0.0.1:${vite.httpServer.address().port}`;
   browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1700,height:1200},timezoneId:'Pacific/Kiritimati'});
   await context.addInitScript(({session,scope,token})=>{sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);},{session:{id:f.ownerId,employeeId:f.ownerId,name:'Synthetic evidence operator',role:'Admin',permissionRole:'Admin',permissions:workPermissions},scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},token:tokenFor(identities.manager)});
   const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[],external=[],writes=[];
   page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url())&&new URL(req.url()).origin!==baseUrl)external.push(req.url());if(new URL(req.url()).pathname==='/api/timesheets'&&req.method()==='POST')writes.push(req.postDataJSON());});
   const ready=async owner=>owner.waitForFunction(()=>!document.querySelector('select[aria-label="Capture mode"]')?.disabled);
   const loadPast=async owner=>{await owner.goto(`${baseUrl}/tests/fixtures/work-capture-modes.html`);await ready(owner);await owner.getByRole('button',{name:'Previous week',exact:true}).click();await ready(owner);};
   const rowFor=(owner,category)=>owner.locator('tbody tr').filter({has:owner.locator(`input[value="${category}"]`)});
   const edit=async(owner,category,value,day='Monday')=>{await rowFor(owner,category).getByRole('button',{name:`Edit ${day} remark`,exact:true}).click();await owner.getByLabel('Evidence URL (optional)',{exact:true}).fill(value);await owner.getByRole('button',{name:'Save Daily Remark',exact:true}).click();};
   const save=async owner=>{const wait=owner.waitForResponse(response=>new URL(response.url()).pathname==='/api/timesheets'&&response.request().method()==='POST');await owner.getByRole('button',{name:'Save Draft',exact:true}).click();return (await wait).status();};
   await loadPast(page);
   const anchor=rowFor(page,'Synthetic Monday').getByRole('link',{name:'Open evidence',exact:true});assert.equal(await anchor.getAttribute('href'),link);assert.equal(await anchor.getAttribute('rel'),'noopener noreferrer');assert.equal(await anchor.getAttribute('target'),'_blank');
   await edit(page,'Synthetic Monday','javascript:synthetic');assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);assert.equal(await rowFor(page,'Synthetic Monday').getByRole('link').count(),0);
   await edit(page,'Synthetic Monday',nextLink);await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');await page.getByLabel('Work date',{exact:true}).selectOption('0');
   assert.equal(await rowFor(page,'Synthetic weekend').getByRole('link',{name:'Open evidence',exact:true}).getAttribute('href'),'https://example.test/weekend');
   assert.equal(await save(page),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();
   let stored=await entries();assert.equal(stored.find(row=>row.category==='Synthetic Monday').evidence_url,nextLink);assert.equal(stored.find(row=>row.category==='Synthetic weekend').evidence_url,'https://example.test/weekend');assert.equal(stored.find(row=>row.category==='Synthetic zero').evidence_url,'https://example.test/zero');
   assert.equal(writes.at(-1).entries.length,3);assert(writes.at(-1).entries.every(row=>Object.hasOwn(row,'evidence_url')),'new UI sends a complete explicit replacement');
   await page.getByRole('button',{name:'Reload work',exact:true}).click();await ready(page);await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');await page.getByLabel('Work date',{exact:true}).selectOption('2');
   assert.equal(await rowFor(page,'Synthetic Monday').getByRole('link',{name:'Open evidence',exact:true}).getAttribute('href'),nextLink);
   await edit(page,'Synthetic Monday','');assert.equal(await save(page),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();assert.equal((await entries()).find(row=>row.category==='Synthetic Monday').evidence_url,null);
   await page.getByRole('button',{name:'Reload work',exact:true}).click();await ready(page);assert.equal(await rowFor(page,'Synthetic Monday').getByRole('link').count(),0);
   // Two unsaved dates carry distinct URLs. Changing one date's context retains
   // the unseen date's original context and URL in the same full-header save.
   await page.getByLabel('Capture mode',{exact:true}).selectOption('weekly');await page.getByRole('button',{name:'Add Client Misc Task',exact:true}).click();let row=page.locator('tbody tr').last();
   await row.getByPlaceholder('Client Name...',{exact:true}).fill('Synthetic mixed client');await row.getByPlaceholder('Misc Task (e.g. Call, Escalation)...',{exact:true}).fill('Synthetic mixed original');await row.getByPlaceholder('0.0',{exact:true}).nth(0).fill('0.25');await row.getByPlaceholder('0.0',{exact:true}).nth(1).fill('0.25');
   await edit(page,'Synthetic mixed original','https://example.test/mixed-monday');await edit(page,'Synthetic mixed original','https://example.test/mixed-tuesday','Tuesday');
   await page.getByLabel('Capture mode',{exact:true}).selectOption('daily');await page.getByLabel('Work date',{exact:true}).selectOption('2');await rowFor(page,'Synthetic mixed original').getByPlaceholder('Misc Task (e.g. Call, Escalation)...',{exact:true}).fill('Synthetic mixed Monday');
   assert.equal(await save(page),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();stored=await entries();assert.equal(stored.find(row=>row.category==='Synthetic mixed Monday').evidence_url,'https://example.test/mixed-monday');assert.equal(stored.find(row=>row.category==='Synthetic mixed original').evidence_url,'https://example.test/mixed-tuesday');
   const second=await context.newPage();second.setDefaultTimeout(20000);await loadPast(second);
   await edit(page,'Synthetic Monday',link);assert.equal(await save(page),200);await page.getByText('Draft timesheet saved.',{exact:true}).waitFor();const winner=await workSnapshot(pool);
   await edit(second,'Synthetic Monday',nextLink);assert.equal(await save(second),409);await second.getByText(/Work changed since it was loaded/).waitFor();assert.deepEqual(await workSnapshot(pool),winner);assert.equal(await second.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
   await second.close();assert.deepEqual(errors,[]);assert.deepEqual(external,[],'no preview or automatic request to any evidence URL');await context.close();
  }finally{await browser?.close();await vite.close();}
 });
});
console.log('Work evidence real React/API/PostgreSQL journey passed: save/reload/clear, safe links, invalid URL feedback, mode/hidden/weekend/zero/context preservation, evidence-only stale tabs and no dereferencing.');
