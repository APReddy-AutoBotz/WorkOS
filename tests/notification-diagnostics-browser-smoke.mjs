import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialIdentities,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);const identities=await seedCommercialIdentities(pool);
 const permissions=['notifications.view','notifications.manage','employees.view','allocations.view','projects.view'];
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) select 'Admin',key,true from unnest($1::text[])key on conflict(role_name,permission_key) do update set enabled=true",[permissions]);
 await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true)',[identities.manager.id,f.organizationId,f.otherLegalEntityId]);
 for(const [id,worker,channel,status] of [['local',f.ownerId,'Email','Failed'],['other',f.otherOwnerId,'Teams','Delivered'],['foreign',f.foreignOwnerId,'InApp','Failed']]) {
  await pool.query("insert into notification_events(id,recipient_employee_id,event_type,title,body)values($1,$2,'SyntheticDiagnostic','Synthetic notice','Synthetic body')",[id,worker]);
  await pool.query("insert into notification_delivery_attempts(id,notification_id,channel,provider,status,response_metadata)values($1,$1,$2,'mock',$3,$4)",[id,channel,status,JSON.stringify({error:'synthetic-private-browser-diagnostic',statusCode:503})]);
 }
 await withCommercialApi({databaseUrl,identities},async({baseUrl,tokenFor,request})=>{
  const release=await request('/api/organization-setup/module-releases/notifications',{method:'PUT',body:{enabled:true,expectedRevision:0,evidence:'Synthetic browser diagnostics'}});
  assert.ok([200,201].includes(release.status));
  const fixtureServer = await startFixtureServer({root, fixtures: ['notification-diagnostics'], apiUrl: baseUrl, publicEnv: {VITE_APP_MODE: 'production', VITE_ALLOW_TEST_FALLBACK: 'false'}});
  let browser;
  try {
   browser=await chromium.launch({headless:true});const context=await browser.newContext();
   await context.addInitScript(({identity,token,permissions,scope})=>{
    sessionStorage.setItem('workos_session',JSON.stringify({id:identity.id,name:'Synthetic diagnostics operator',role:'Admin',permissionRole:'Admin',permissions}));
    sessionStorage.setItem('workos_api_token',token);
    if(!sessionStorage.getItem('workos_organization_scope'))sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
   },{identity:identities.manager,token:tokenFor(identities.manager),permissions,scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId}});
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')console.error('Browser console:',message.text());});
   const table=()=>page.locator('table').filter({has:page.getByRole('columnheader',{name:'Provider',exact:true})});
   const response=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/notification-delivery-attempts',{timeout:60000});
   let [result]=await Promise.all([response(),page.goto(`${fixtureServer.url}/tests/fixtures/notification-diagnostics.html`,{waitUntil:'domcontentloaded',timeout:60000})]);assert.equal(result.status(),200);let rows=await result.json();assert.deepEqual(rows.map(r=>r.id),['local']);assert.equal(JSON.stringify(rows).includes('synthetic-private-browser-diagnostic'),false);
   await table().getByRole('cell',{name:'Email',exact:true}).waitFor();assert.equal(await table().locator('tbody tr').count(),1);
   await page.evaluate(scope=>sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope)),{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId});
   [result]=await Promise.all([response(),page.reload({waitUntil:'domcontentloaded'})]);assert.equal(result.status(),200);rows=await result.json();assert.deepEqual(rows.map(r=>r.id),['other']);assert.equal(JSON.stringify(rows).includes('synthetic-private-browser-diagnostic'),false);
   await table().getByRole('cell',{name:'Teams',exact:true}).waitFor();assert.equal(await table().getByRole('cell',{name:'Email',exact:true}).count(),0);assert.equal(await table().locator('tbody tr').count(),1);
   assert.deepEqual(errors,[]);
  } finally {await browser?.close();await fixtureServer.close();}
 });
});
console.log('Real notification diagnostics browser/API: selected-entity rows, redacted network payloads and reload into authorized scope passed.');
