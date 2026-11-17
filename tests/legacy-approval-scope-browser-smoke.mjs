import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedCapacity} from './support/worker-capacity-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const {identities:ids}=await seedCapacity(pool);
 const recipient='synthetic-browser-delegate';
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values($1,$1,'Synthetic browser delegate','browser-delegate@example.test','Lead','Delivery','US','director-commercial','Active','org-default','legal-default')`,[recipient]);
 await pool.query('update users set employee_record_id=$1,employee_id=$1 where id=$2',[recipient,ids.denied.id]);
 await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='TeamLead' on conflict do nothing",[ids.reader.id]);
 await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('TeamLead','approvals.view',true) on conflict(role_name,permission_key)do update set enabled=true");
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
   await page.goto(origin+'/tests/fixtures/legacy-approval.html',{waitUntil:'domcontentloaded',timeout:60000});
   await page.getByLabel('Delegator',{exact:true}).waitFor({timeout:60000});
   await page.getByLabel('Delegator',{exact:true}).selectOption(f.ownerId);
   await page.getByLabel('Delegate',{exact:true}).selectOption(recipient);
   await page.getByLabel('Delegation role',{exact:true}).selectOption('Admin');
   const denied=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approval-delegations'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Create Delegation',exact:true}).click();assert.equal((await denied).status(),422);
   await page.getByRole('status').filter({hasText:'Active delegation requires both participants'}).waitFor();
   assert.equal((await pool.query('select count(*)::int n from approval_delegations')).rows[0].n,0);
   await page.getByLabel('Delegation role',{exact:true}).selectOption('TeamLead');
   const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approval-delegations'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Create Delegation',exact:true}).click();assert.equal((await saved).status(),200);
   await page.getByRole('status').filter({hasText:'Created approval delegation to Synthetic browser delegate.'}).waitFor();
   assert.equal((await pool.query('select count(*)::int n from approval_delegations')).rows[0].n,1);
   console.log('Real approval workspace: invalid participant role displays server refusal with zero writes; corrected delegation saves once and displays acknowledgement.');
  }finally{await browser?.close();await vite.close();}
 });
});
