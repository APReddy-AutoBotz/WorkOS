import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './compiled-fixture-server.mjs';
import {processMonthEndMarginAlerts} from '../../server/modules/commercial-drafting/month-end-margin-alerts.mjs';
import {fixedFeeRiskInboxRows} from '../../server/modules/commercial-drafting/fixed-fee-risk-inbox.mjs';
import {WORK_APPROVAL_BASE} from './work-approval-test.mjs';
import {commercialFixture,withCommercialApi} from './commercial-drafting-test.mjs';

// The disposable database has current identities and routing policies. Stage a closed
// reporting month's synthetic source records in a separate schema to exercise the real
// month-end migrations and worker without waiting for the calendar to advance.
export async function verifyMonthEndDelivery(databaseUrl,engagementId,identities) {
  const reader=identities.reader;
  const pool=new pg.Pool({connectionString:databaseUrl,options:'-c search_path=margin_history,public'});
  const {organizationId,legalEntityId}=commercialFixture;
  const scope=[organizationId,legalEntityId,engagementId];
  try {
    await pool.query(`create schema margin_history;
      create table margin_history.commercial_service_margin_versions(id uuid primary key,organization_id text,legal_entity_id text,
        engagement_id text,month_start date,version integer,created_at timestamptz,report jsonb);
      create table margin_history.commercial_amendments(id text primary key,organization_id text,legal_entity_id text,
        entity_id text,entity_type text,effective_on date,ends_on date,after_value jsonb)`);
    await pool.query(`insert into commercial_amendments
      values ('mid-month',$1,$2,$3,'Engagement','2020-02-15','2020-12-31','{"terms":{"marginThresholdPercent":"10"}}'),
             ('month-end',$1,$2,$3,'Engagement','2020-02-29','2020-12-31','{"terms":{"marginThresholdPercent":"20"}}')`,scope);
    await pool.query(`insert into commercial_service_margin_versions
      select gen_random_uuid(),$1,$2,$3,'2020-02-01',v,at_time::timestamptz,jsonb_build_object('marginPercent',pct)
      from (values (1,'2020-02-15 UTC','5'),(2,'2020-02-29 UTC','20'),(3,'2020-03-02 UTC','19.99'),
                   (4,'2020-03-03 UTC','18')) versions(v,at_time,pct)`,scope);
    for (const file of ['114_wos07_managed_margin_thresholds','116_wos07_month_end_margin_breaches']) {
      await pool.query(await readFile(new URL('../../server/migrations/'+file+'.sql',import.meta.url),'utf8'));
    }
    const setScope=active=>pool.query('update user_organization_scopes set active=$2 where user_id=$1 and legal_entity_id=$3',
      [reader.id,active,legalEntityId]);
    // The owner can still receive notices while the separate named finance role loses inbox access.
    const financeId = identities.first.id;
    await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[financeId]);
    const namedRecipients = async () => (await pool.query(
      "select reason from engagement_risk_recipients('managed_service',$1,$2,$3,$4,'Employee',$5,'Admin') order by reason",
      [...scope,reader.id,financeId])).rows.map(row=>row.reason);
    const required = ['commercial_manager','engagement_owner','finance_billing_owner'];
    assert.deepEqual(await namedRecipients(),required);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='employees.view'");
    assert.deepEqual(await namedRecipients(),[]);
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='employees.view'");
    assert.deepEqual(await namedRecipients(),required);
    await setScope(false);
    await processMonthEndMarginAlerts(pool);
    assert.deepEqual((await pool.query('select failure,attempts from service_margin_risk_dispatch')).rows,
      [{failure:'RECIPIENTS_UNAVAILABLE',attempts:1}]);
    assert.equal((await pool.query('select from service_margin_risk_inbox')).rowCount,0);
    await setScope(true);
    await pool.query('update service_margin_risk_dispatch set next_attempt=now()');
    await Promise.all([processMonthEndMarginAlerts(pool),processMonthEndMarginAlerts(pool)]);
    assert.deepEqual((await pool.query(`select m.version,a.amendment_id,d.attempts from commercial_service_margin_alerts a
      join commercial_service_margin_versions m on m.id=a.margin_version_id join service_margin_risk_dispatch d on d.event_id=m.id
      where d.delivered_at is not null`)).rows,[{version:3,amendment_id:'month-end',attempts:2}]);
    const req={organizationScope:{organizationId,legalEntityId},user:{sub:reader.id,activeRole:'Employee'}};
    const inbox=()=>fixedFeeRiskInboxRows(pool,req,{},true);
    const receipts=await inbox();
    assert.equal(receipts.length,1);
    assert.deepEqual(receipts[0].reasons,['commercial_manager','engagement_owner','finance_billing_owner']);
    assert.equal(receipts[0].monthStart,'2020-02-01');
    const url=new URL(databaseUrl);
    url.searchParams.set('options','-c search_path=margin_history,public');
    await withCommercialApi({databaseUrl:url.toString(),identities},async({request,baseUrl,tokenFor})=>{
      const path='/engagements/'+engagementId+'/service-margin-risk-deliveries';
      const status=await request(path);
      assert.equal(status.status,200,JSON.stringify(status.body));
      assert.equal(status.body.events[0].history.length,2);
      assert.equal((await request(path,{identity:reader})).status,403);
      const {body}=await request(WORK_APPROVAL_BASE+'/inbox',{identity:reader});
      const notice=body.notifications.find(n=>n.kind==='monthly-margin-risk');
      assert.equal(notice.id,receipts[0].id);
      const fixture=await startFixtureServer({root:fileURLToPath(new URL('../../',import.meta.url)),
        fixtures:['commercial-approval-inbox'],apiUrl:baseUrl});
      let browser;
      try {
        const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE||'playwright');
        browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
        const page=await browser.newPage();
        await page.addInitScript(({session,scope,token})=>{
          sessionStorage.setItem('workos_session',JSON.stringify(session));
          sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
          sessionStorage.setItem('workos_api_token',token);
        },{session:{id:reader.employeeRecordId,employeeId:reader.employeeId,userName:reader.username,name:'Synthetic engagement owner',role:'Employee',
          permissionRole:'Employee',permissions:['notifications.view','employees.view']},scope:{organizationId,legalEntityId},token:tokenFor(reader)});
        await page.goto(fixture.url+'/tests/fixtures/commercial-approval-inbox.html');
        await page.getByRole('button',{name:'Load my governed notifications'}).click();
        await page.getByText('Engagement '+engagementId+' · 2020-02 · Margin below approved threshold').waitFor();
        const read=page.getByRole('button',{name:'Mark governed notification read '+notice.id});
        await read.click();
        await read.waitFor({state:'detached'});
        assert.ok((await inbox())[0].readAt);
      } finally {await browser?.close();await fixture.close();}
    });
    await setScope(false);
    assert.deepEqual(await inbox(),[]);
    await setScope(true);
  } finally {await pool.end();}
}
