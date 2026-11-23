import {startFixtureServer} from './compiled-fixture-server.mjs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {processFixedFeeWarnings} from '../../server/modules/commercial-drafting/fixed-fee-risk-worker.mjs';
import {WORK_APPROVAL_BASE} from './work-approval-test.mjs';
import {commercialFixture} from './commercial-drafting-test.mjs';

export async function verifyRiskDelivery({pool,request,engagement,identities,today,baseUrl,tokenFor}) {
  const count=async table=>(await pool.query('select count(*)::int n from '+table)).rows[0].n;
  assert.equal(await count('fixed_fee_risk_events'),0);
  const scope=async(user,active)=>pool.query('update user_organization_scopes set active=$2 where user_id=$1 and legal_entity_id=$3',
    [user.id,active,commercialFixture.legalEntityId]);
  const {reader,second,requester}=identities;
  await pool.query(`insert into notification_preferences(employee_id,event_type,in_app) values($1,'commercial.risk_threshold_breached',false)
    on conflict(employee_id,event_type) do update set in_app=false`,[commercialFixture.ownerId]);
  const inbox=async identity=>{
    const result=await request(WORK_APPROVAL_BASE+'/inbox',{identity});
    assert.equal(result.status,200,JSON.stringify(result.body));
    return {rows:result.body.notifications.filter(n=>n.kind==='fixed-fee-risk'),owner:result.body.ownerKey};
  };
  const path='/engagements/'+engagement.id+'/fixed-fee-risk-notice-policy';
  const {latest}= (await request(path)).body;
  for (const user of [second,requester]) {
    const worker='synthetic-risk-'+user.id;
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values($1,$1,'Synthetic reviewer',$2,'Reviewer','Delivery','US','director-commercial','Active',$3,$4)`,
      [worker,worker+'@example.test',commercialFixture.organizationId,commercialFixture.legalEntityId]);
    await pool.query('update users set employee_record_id=$2 where id=$1',[user.id,worker]);
  }
  const policy=await request(path,{method:'POST',body:{expectedVersion:latest.version,effectiveFrom:today,
    manager:{userId:second.id,role:'Admin'},finance:{userId:requester.id,role:'Admin'},
    locale:'en',title:'Budget warning',body:'Review this engagement.',reason:'Assign separate scoped owners'}});
  assert.equal(policy.status,201,JSON.stringify(policy.body));
  await scope(second,false);
  await processFixedFeeWarnings(pool);
  assert.equal(await count('fixed_fee_risk_events'),2);
  assert.equal(await count('fixed_fee_risk_inbox'),0);
  assert.deepEqual((await pool.query('select distinct failure from fixed_fee_risk_dispatch')).rows,[{failure:'RECIPIENTS_UNAVAILABLE'}]);
  const statusPath='/engagements/'+engagement.id+'/fixed-fee-risk-deliveries';
  const status=await request(statusPath);
  assert.deepEqual(status.body.events.map(e=>e.failure),['RECIPIENTS_UNAVAILABLE','RECIPIENTS_UNAVAILABLE']);
  assert.equal((await request(statusPath,{identity:reader})).status,403);
  await scope(second,true);
  await pool.query(`create function reject_test_risk_receipt() returns trigger language plpgsql as $$begin
    if 'finance_billing_owner'=any(new.reasons) then raise exception 'Synthetic receipt failure'; end if; return new;end $$;
    create trigger reject_test_risk_receipt before insert on fixed_fee_risk_inbox for each row execute function reject_test_risk_receipt()`);
  const retry=()=>pool.query("update fixed_fee_risk_dispatch set next_attempt=now() where delivered_at is null");
  await retry();await processFixedFeeWarnings(pool);
  assert.equal(await count('fixed_fee_risk_inbox'),0);
  assert.deepEqual((await pool.query('select distinct failure from fixed_fee_risk_dispatch')).rows,[{failure:'DELIVERY_UNAVAILABLE'}]);
  await pool.query('drop trigger reject_test_risk_receipt on fixed_fee_risk_inbox');
  await retry();await Promise.all([processFixedFeeWarnings(pool),processFixedFeeWarnings(pool)]);
  await pool.query('update fixed_fee_risk_scans set next_check=now()');
  await processFixedFeeWarnings(pool);
  assert.equal(await count('fixed_fee_risk_events'),2);
  assert.equal(await count('fixed_fee_risk_inbox'),6);
  const attempts=await pool.query(`select attempt,failure,count(*)::int n from fixed_fee_risk_delivery_attempts
    group by attempt,failure order by attempt`);
  const recovered=await request(statusPath);
  assert.deepEqual(recovered.body.events[0].history.map(h=>[h.attempt,h.failure]),[[3,null],[2,'DELIVERY_UNAVAILABLE'],[1,'RECIPIENTS_UNAVAILABLE']]);
  assert.deepEqual(attempts.rows,[{attempt:1,failure:'RECIPIENTS_UNAVAILABLE',n:2},
    {attempt:2,failure:'DELIVERY_UNAVAILABLE',n:2},{attempt:3,failure:null,n:2}]);
  await assert.rejects(pool.query('delete from fixed_fee_risk_delivery_attempts where attempt=1'));
  for (const [user,reason] of [[reader,'engagement_owner'],[second,'commercial_manager'],[requester,'finance_billing_owner']]) {
    const {rows,owner}=await inbox(user);
    assert.deepEqual(rows.map(n=>n.metric).sort(),['effort','laborCost']);
    for (const row of rows) {
      assert.deepEqual(row.reasons,[reason]);
      assert.equal(row.eventKey,'commercial.risk_threshold_breached');
      assert.equal(row.channelDecision,'Required');
      assert.equal(row.templateId,policy.body.latest.id);
    }
    const ack=await request(WORK_APPROVAL_BASE+'/inbox/'+rows[0].id+'/read',{identity:user,method:'POST',body:{expectedOwnerKey:owner}});
    assert.equal(ack.status,200,JSON.stringify(ack.body));assert.ok(ack.body.notification.readAt);
  }
  const fixture=await startFixtureServer({root:fileURLToPath(new URL('../../',import.meta.url)),fixtures:['commercial-approval-inbox'],apiUrl:baseUrl});
  let browser;
  try {
    const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE||'playwright');
    browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
    const page=await browser.newPage();
    await page.addInitScript(({session,scope,token})=>{
      sessionStorage.setItem('workos_session',JSON.stringify(session));
      sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
      sessionStorage.setItem('workos_api_token',token);
    },{session:{id:'synthetic-risk-'+requester.id,userName:requester.username,name:'Synthetic reviewer',role:'Admin',permissionRole:'Admin',permissions:['notifications.view','employees.view']},
      scope:{organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.legalEntityId},token:tokenFor(requester)});
    await page.goto(fixture.url+'/tests/fixtures/commercial-approval-inbox.html');
    await page.getByRole('button',{name:'Load my governed notifications'}).click();
    await page.getByText('Engagement '+engagement.id+' · Delivery hours warning').waitFor();
    await page.getByText('Engagement '+engagement.id+' · Labor cost warning').waitFor();
    const unread=page.getByRole('article').filter({hasText:'Budget warning'}).filter({hasText:'Unread'});
    await unread.getByRole('button',{name:/Mark governed notification read/}).click();
    await unread.waitFor({state:'detached'});
  } finally {await browser?.close();await fixture.close();}
  const outsider=await inbox(identities.manager);
  assert.equal(outsider.rows.length,0);
  const [retained]=(await inbox(reader)).rows;
  const otherRead=await request(WORK_APPROVAL_BASE+'/inbox/'+retained.id+'/read',{identity:identities.manager,method:'POST',body:{expectedOwnerKey:outsider.owner}});
  assert.equal(otherRead.status,404);
  await assert.rejects(pool.query('update fixed_fee_risk_dispatch set delivered_at=null where event_id=$1',[retained.eventId]));

  await scope(second,false);
  assert.equal((await inbox(reader)).rows.length,2);
  await scope(second,true);
}
