import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './compiled-fixture-server.mjs';
import assert from 'node:assert/strict';
import {commercialFixture,withCommercialApi} from './commercial-drafting-test.mjs';

export async function verifyNegativeStatement({pool,request,identities,databaseUrl,engagement,today,tomorrow}) {
  const path='/engagements/'+engagement.id+'/fixed-fee-statement';
  const reason='Finance verified both retained effort values';
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.fixed_fee_statement.sign',true)");
  await pool.query("update reporting_periods set status='Financially Locked' where id='synthetic-category-current'");
  const opening=(await request(path+'?through='+today+'&frequency=Weekly')).body;
  const signed=await request(path,{method:'POST',body:{through:today,frequency:'Weekly',expectedToken:opening.token,reason}});
  assert.equal(signed.status,201,JSON.stringify(signed.body));
  assert.equal(signed.body.saved.report.closing.amount,'60');

  // Only connections to this disposable database use the next service day's clock.
  await pool.query(`create schema statement_test_clock;
    create function statement_test_clock.now() returns timestamptz language sql stable as $$select pg_catalog.now()+interval '1 day'$$`);
  const datedUrl=new URL(databaseUrl);
  datedUrl.searchParams.set('options','-c search_path=statement_test_clock,public,pg_catalog');
  await withCommercialApi({databaseUrl:datedUrl.href,identities},async({request:dated,baseUrl,tokenFor})=>{
    const progress=path.replace('statement','progress');
    const inspected=await dated(progress+'?through='+tomorrow);
    assert.equal(inspected.body.report?.amount,'30',JSON.stringify(inspected.body));
    const retained=await dated(progress,{method:'POST',body:{through:tomorrow,expectedVersion:0,expectedToken:inspected.body.token}});
    assert.equal(retained.status,201,JSON.stringify(retained.body));
    await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
      values('synthetic-reduction-period',$1,$2,'SYN-REDUCTION','Synthetic period after budget change',$3,$3,'Financially Locked','Monthly')`,
      [commercialFixture.organizationId,commercialFixture.legalEntityId,tomorrow]);
    const {body:view}=await dated(path+'?through='+tomorrow+'&frequency=Monthly');
    assert.deepEqual([view.status,view.report.opening.amount,view.report.closing.amount,view.report.movement],['explanation_required','60','30','-30']);
    const cmd={through:tomorrow,frequency:'Monthly',expectedToken:view.token,reason};
    assert.equal((await dated(path,{method:'POST',body:cmd})).status,422);
    const reductionExplanation='The approved effort budget doubled while verified delivery hours were unchanged.';
    const fixture=await startFixtureServer({root:fileURLToPath(new URL('../../',import.meta.url)),fixtures:['commercial-drafting'],apiUrl:baseUrl});
    let browser;
    try {
      const {chromium}=await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
      browser=await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH?{executablePath:process.env.WORKOS_CHROMIUM_PATH}:{})});
      const page=await browser.newPage();
      await page.clock.setFixedTime(new Date(tomorrow+'T12:00:00Z'));
      await page.addInitScript(({session,scope,token})=>{
        sessionStorage.setItem('workos_session',JSON.stringify(session));sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
        sessionStorage.setItem('workos_api_token',token);
      },{session:{id:identities.manager.id,userName:identities.manager.username,name:'Synthetic finance signer',role:'Admin',permissionRole:'Admin',
        permissions:['commercial.contracts.view','commercial.fixed_fee_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization','commercial.fixed_fee_statement.sign']},
        scope:{organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.legalEntityId},token:tokenFor(identities.manager)});
      await page.goto(fixture.url+'/tests/fixtures/commercial-drafting.html?live=1');
      const effort=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:new RegExp(engagement.code)})}).getByRole('region',{name:'Fixed-fee approved effort'});
      await effort.getByLabel('Effort month').fill(tomorrow.slice(0,7));
      await effort.getByRole('button',{name:'Inspect approved effort'}).click();
      const exposure=effort.getByRole('region',{name:'Fixed-fee allocation risk'});
      await exposure.getByLabel('Include work through').fill(tomorrow);
      await exposure.getByRole('button',{name:'Check allocation risk'}).click();
      const desk=exposure.getByRole('region',{name:'Fixed-fee period statement'});
      await desk.getByLabel('Reporting frequency').selectOption('Monthly');
      await desk.getByRole('button',{name:'Inspect period statement'}).click();
      await desk.getByText('GBP · Opening 60 · Closing 30 · Period movement -30').waitFor();
      await desk.getByLabel('Statement sign-off reason').fill(reason);
      const sign=desk.getByRole('button',{name:'Sign period statement'});
      assert(await sign.isDisabled());
      await desk.getByLabel('Reduction explanation').fill(reductionExplanation);
      await sign.click();
      await desk.getByText('Reduction explanation: '+reductionExplanation).waitFor();
    } finally {try {if (browser) await browser.close();} finally {await fixture.close();}}
    const reduced=await dated(path,{method:'POST',body:{...cmd,reductionExplanation}});
    assert.equal(reduced.status,201,JSON.stringify(reduced.body));
    assert.equal(reduced.body.saved.report.movement,'-30');
    assert.equal(reduced.body.saved.reductionExplanation,reductionExplanation);
    assert.equal((await pool.query("select new_value->>'reductionExplanation' why from audit_logs where entity_id=$1 and action='Signed'",[reduced.body.saved.id])).rows[0].why,reductionExplanation);
    assert.deepEqual((await dated(path+'?through='+today+'&frequency=Weekly&version=1')).body.saved,signed.body.saved);
  });
}
