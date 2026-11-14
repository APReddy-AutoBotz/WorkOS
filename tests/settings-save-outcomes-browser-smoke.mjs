import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedCapacity} from './support/worker-capacity-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const {identities:ids}=await seedCapacity(pool);
 await withCommercialApi({databaseUrl,identities:ids},async({request,tokenFor,baseUrl})=>{
  const identity=ids.manager,current=await request('/api/auth/me');assert.equal(current.status,200);
  const vite=await createServer({root,mode:'production',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:baseUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false')}});
  let browser;
  try{
   await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
   browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1600,height:1200}});
   await context.addInitScript(({user,scope,token})=>{
    sessionStorage.setItem('workos_session',JSON.stringify(user));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);
   },{user:{id:identity.id,userName:identity.username,name:'Synthetic administrator',role:identity.role,permissionRole:identity.role,permissions:current.body.permissions},scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},token:tokenFor(identity)});
   const page=await context.newPage();page.setDefaultTimeout(30000);
   await page.route('**/*',route=>{const url=new URL(route.request().url());return /^https?:$/.test(url.protocol)&&url.origin!==origin?route.abort():route.continue();});
   let rejectLoad=true,held=null,holdSave=true,saveCount=0;
   await page.route('**/api/settings',async route=>{
    if(route.request().method()==='GET'&&rejectLoad){rejectLoad=false;return route.fulfill({status:503,json:{error:'Synthetic unavailable'}});}
    if(route.request().method()==='POST'){saveCount++;if(holdSave){held=route;return;}}
    return route.continue();
   });
   const before=await request('/api/settings');assert.equal(before.status,200);
   await page.goto(origin+'/tests/fixtures/settings-outcomes.html',{waitUntil:'domcontentloaded',timeout:60000});
   await page.getByRole('alert').filter({hasText:'Governance settings could not be loaded'}).waitFor();
   await page.getByRole('button',{name:'Retry loading settings',exact:true}).click();
   const high=page.locator('input[type="number"]').first();await high.fill('117');
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();
   await page.getByRole('button',{name:'Saving...',exact:true}).waitFor();
   for(let i=0;!held&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));
   assert.ok(held);assert.equal(saveCount,1);
   assert.equal(await page.getByRole('button',{name:'Saving...',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'Recalculate Bounds',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'Settings Saved',exact:true}).count(),0);
   assert.deepEqual((await request('/api/settings')).body,before.body);
   await held.fulfill({status:503,json:{error:'Synthetic refusal'}});held=null;
   await page.getByText('Settings save could not be confirmed. Your edits are retained. Review the connection and retry.',{exact:true}).waitFor();
   assert.equal(await high.inputValue(),'117');assert.deepEqual((await request('/api/settings')).body,before.body);
   holdSave=false;
   const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();assert.equal((await saved).status(),200);
   await page.getByText('Settings were saved.',{exact:true}).waitFor();
   assert.equal(Number((await request('/api/settings')).body.find(row=>row.key==='utilizationThresholdHigh').value),117);
   await high.fill('128');holdSave=true;
   await page.getByRole('button',{name:'Recalculate Bounds',exact:true}).click();
   await page.getByRole('button',{name:'Saving...',exact:true}).waitFor();
   for(let i=0;!held&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(held);
   await high.fill('129');await held.continue();held=null;
   await page.getByText('Submitted settings were saved. Your newer edits have not been saved.',{exact:true}).waitFor();
   assert.equal(await high.inputValue(),'129');
   assert.equal(Number((await request('/api/settings')).body.find(row=>row.key==='utilizationThresholdHigh').value),128);
   assert.equal(saveCount,3);
   const detachedSave=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();
   for(let i=0;!held&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(held);
   await page.getByRole('button',{name:'Hide settings',exact:true}).click();await held.continue();held=null;
   assert.equal((await detachedSave).status(),200);
   await page.getByRole('button',{name:'Show settings',exact:true}).click();
   await page.getByRole('button',{name:'Save Changes',exact:true}).waitFor();
   assert.equal(await high.inputValue(),'129');assert.equal(await page.getByText('Settings were saved.',{exact:true}).count(),0);
   const retained=(await request('/api/settings')).body;
   await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='settings.manage'");
   await high.fill('140');holdSave=false;
   const denied=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Save Changes',exact:true}).click();assert.equal((await denied).status(),403);
   await page.getByText('Settings save could not be confirmed. Your edits are retained. Review the connection and retry.',{exact:true}).waitFor();
   assert.equal(await high.inputValue(),'140');
   await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='settings.manage'");
   assert.deepEqual((await request('/api/settings')).body,retained);
   console.log('Settings real React/API/PostgreSQL: failed load retry, no early acknowledgement, refused save retains edits, confirmed persistence and newer-edit distinction passed.');
  }finally{await browser?.close();await vite.close();}
 });
});
