import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval} from './support/work-approval-test.mjs';
import {adoptActualInputs} from './support/actual-work-test.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);
  const {identities:ids,today}=await seedWorkApproval(pool),hr={...ids.reader,role:'HR'};
  await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='HR' on conflict do nothing",[hr.id]);
  await withCommercialApi({databaseUrl,identities:ids},async({request,tokenFor,baseUrl})=>{
    await adoptActualInputs(request,today);
    const quote=await request(`/api/v1/leave-calendar/workers/${hr.employeeRecordId}/period?startsOn=${today}&endsOn=${today}`,{identity:hr});
    assert.equal(quote.status,200);
    const created=await request('/api/leave/requests',{identity:hr,method:'POST',body:{employee_id:hr.employeeRecordId,leave_type_id:'leave-type-annual',start_date:today,end_date:today,expected_calendar_token:quote.body.quote.sourceToken,reason:'Synthetic browser independence'}});
    assert.equal(created.status,200,JSON.stringify(created.body));
    const path=`/api/leave/requests/${created.body.id}/status`;
    const vite=await createServer({root,mode:'production',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:baseUrl,changeOrigin:true}}},define:{'import.meta.env.VITE_APP_MODE':JSON.stringify('production'),'import.meta.env.VITE_ALLOW_TEST_FALLBACK':JSON.stringify('false'),'import.meta.env.VITE_FEATURE_LEAVE':JSON.stringify('true')}});
    let browser;
    try{
      await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
      browser=await chromium.launch({headless:true});
      const pageFor=async identity=>{
        const current=await request('/api/auth/me',{identity});assert.equal(current.status,200);
        const context=await browser.newContext({viewport:{width:1600,height:1200}});
        await context.addInitScript(({user,scope,token})=>{
          sessionStorage.setItem('workos_session',JSON.stringify(user));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));sessionStorage.setItem('workos_api_token',token);
        },{user:{id:identity.employeeRecordId||identity.id,employeeId:identity.employeeId||identity.id,userName:identity.username,name:'Synthetic leave reviewer',role:identity.role,permissionRole:identity.role,permissions:current.body.permissions},scope:{organizationId:f.organizationId,legalEntityId:f.legalEntityId},token:tokenFor(identity)});
        const page=await context.newPage();page.setDefaultTimeout(30000);
        await page.route('**/*',route=>{const url=new URL(route.request().url());return /^https?:$/.test(url.protocol)&&url.origin!==origin?route.abort():route.continue();});
        await page.goto(origin+'/tests/fixtures/configured-leave.html',{waitUntil:'domcontentloaded',timeout:60000});
        await page.getByRole('button',{name:'Review calendar leave',exact:true}).click();return page;
      };
      const owner=await pageFor(hr);
      const deniedResponse=owner.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='PATCH');
      await owner.getByTitle('Approve',{exact:true}).click();assert.equal((await deniedResponse).status(),403);
      await owner.getByText('The requester or affected worker cannot decide their own leave request.',{exact:true}).waitFor();
      assert.equal((await pool.query('select status from leave_requests where id=$1',[created.body.id])).rows[0].status,'Submitted');
      const reviewer=await pageFor(ids.manager);
      const approvedResponse=reviewer.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='PATCH');
      await reviewer.getByTitle('Approve',{exact:true}).click();assert.equal((await approvedResponse).status(),200);
      await reviewer.getByText('Approved',{exact:true}).waitFor();
      assert.equal((await pool.query('select status from leave_requests where id=$1',[created.body.id])).rows[0].status,'Approved');
      console.log('Real team leave UI passed: owner receives explicit denial, source stays Submitted, independent reviewer approves.');
    }finally{await browser?.close();await vite.close();}
  });
});
