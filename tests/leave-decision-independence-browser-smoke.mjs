import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,seedCommercialReferences,seedCommercialIdentities,commercialFixture as f} from './support/commercial-drafting-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  await seedCommercialReferences(pool);
  const ids=await seedCommercialIdentities(pool),today='2026-11-16';
  const hr={...ids.manager,employeeRecordId:f.ownerId,employeeId:'SYNTHETIC-COMMERCIAL-LOCAL'};
  await pool.query('update users set employee_record_id=$2,employee_id=$3 where id=$1',[hr.id,hr.employeeRecordId,hr.employeeId]);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[ids.reader.id]);
  const reviewerIdentity={...ids.reader,role:'Admin'};
  await withCommercialApi({databaseUrl,identities:ids},async({request,tokenFor,baseUrl})=>{
    const created=await request('/api/leave/requests',{identity:hr,method:'POST',body:{employee_id:hr.employeeRecordId,leave_type_id:'leave-type-unpaid',start_date:today,end_date:today,reason:'Synthetic browser independence'}});
    assert.equal(created.status,200,JSON.stringify(created.body));
    const path=`/api/leave/requests/${created.body.id}/status`;
    const fixtureServer = await startFixtureServer({root, fixtures: ['independent-leave'], apiUrl: baseUrl, publicEnv: {VITE_FEATURE_LEAVE: 'true'}});
    let browser;
    try{
      const origin=fixtureServer.url;
      browser=await chromium.launch({headless:true});
      const pageFor=async identity=>{
        const current=await request('/api/auth/me',{identity});assert.equal(current.status,200);
        const context=await browser.newContext({viewport:{width:1600,height:1200}});
        await context.addInitScript(({user,scope,token})=>{
          sessionStorage.setItem('workos_session',JSON.stringify(user));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);
        },{user:{id:identity.employeeRecordId||identity.id,employeeId:identity.employeeId||identity.id,userName:identity.username,name:'Synthetic leave reviewer',role:identity.role,permissionRole:identity.role,permissions:current.body.permissions},scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},token:tokenFor(identity)});
        const page=await context.newPage();page.setDefaultTimeout(30000);
        await page.route('**/*',route=>{const url=new URL(route.request().url());return /^https?:$/.test(url.protocol)&&url.origin!==origin?route.abort():route.continue();});
        await page.goto(origin+'/tests/fixtures/independent-leave.html',{waitUntil:'domcontentloaded',timeout:60000});
        await page.getByTitle('Approve',{exact:true}).waitFor({timeout:60000});return page;
      };
      const owner=await pageFor(hr);
      const deniedResponse=owner.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='PATCH');
      await owner.getByTitle('Approve',{exact:true}).click();assert.equal((await deniedResponse).status(),403);
      await owner.getByText('The requester or affected worker cannot decide their own leave request.',{exact:true}).waitFor();
      assert.equal((await pool.query('select status from leave_requests where id=$1',[created.body.id])).rows[0].status,'Submitted');
      const reviewer=await pageFor(reviewerIdentity);
      const approvedResponse=reviewer.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='PATCH');
      await reviewer.getByTitle('Approve',{exact:true}).click();assert.equal((await approvedResponse).status(),200);
      await reviewer.getByText('Approved',{exact:true}).waitFor();
      assert.equal((await pool.query('select status from leave_requests where id=$1',[created.body.id])).rows[0].status,'Approved');
      console.log('Real team leave UI passed: owner receives explicit denial, source stays Submitted, independent reviewer approves.');
    }finally{await browser?.close();await fixtureServer.close();}
  });
});
