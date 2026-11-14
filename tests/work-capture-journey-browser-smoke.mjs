import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, seedCommercialReferences,
  seedCommercialLegacyWork, seedCommercialIdentities, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {amendmentToday, addUtcDays} from './support/commercial-amendments-test.mjs';
import {workPermissions, grantWorkPermissions} from './support/work-assignment-test.mjs';
const {chromium} = await import('playwright');
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const hostile = '<script>window.syntheticCaptureExecuted=true</script>';
await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool); await seedCommercialReferences(pool); await seedCommercialLegacyWork(pool);
  const identities = await seedCommercialIdentities(pool); await grantWorkPermissions(pool);
  const today = await amendmentToday(pool);
  const weekday=new Date(`${today}T00:00:00Z`).getUTCDay();
  const currentMonday=addUtcDays(today,weekday===6?2:weekday===0?1:1-weekday);
  const monday = addUtcDays(currentMonday, -7), friday = addUtcDays(monday, 4), saturday = addUtcDays(monday, -2);
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('capture-browser-previous',$1,$2,'SYN-CAPTURE-PREVIOUS','Synthetic previous',$3,$4,'Open','Weekly'),
    ('capture-browser-current',$1,$2,'SYN-CAPTURE-CURRENT','Synthetic current',$5,$5::date+6,'Open','Weekly'),
    ('capture-browser-next',$1,$2,'SYN-CAPTURE-NEXT','Synthetic next',$5::date+7,$5::date+13,'Planned','Weekly'),
    ('capture-browser-third',$1,$2,'SYN-CAPTURE-THIRD','Synthetic third',$5::date+14,$5::date+20,'Planned','Weekly')`, [f.organizationId, f.legalEntityId, saturday, friday, today]);
  const header = (await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
    values($1,$2,'Draft',1,0,$3,$4) returning id`, [f.ownerId, friday, f.organizationId, f.legalEntityId])).rows[0].id;
  for (const [date, hours, category, remark] of [[monday, '0.25', 'Synthetic A', hostile], [monday, '0.5', 'Synthetic B', 'Synthetic distinct comment'],
    [saturday, '0.25', 'Synthetic weekend', 'Synthetic off-grid comment'], [monday, '0', 'Synthetic zero', 'Synthetic zero comment']]) {
    await pool.query(`insert into timesheet_entries(timesheet_id,work_type,client_name,category,work_date,hours,remark,billable)
      values($1,'Client Misc Task','Synthetic client',$2,$3,$4,$5,false)`, [header, category, date, hours, remark]);
  }
  await withCommercialApi({databaseUrl, identities}, async ({baseUrl: apiUrl, tokenFor, request}) => {
    const modeEnablement=await request('/api/v1/work-capture-modes/settings',{method:'POST',body:{expectedLatestId:null,enabledModes:['weekly']}});
    assert.equal(modeEnablement.status,201,JSON.stringify(modeEnablement.body));
    const vite = await createServer({root: rootDir, mode: 'production', clearScreen: false, logLevel: 'error',
      server: {host: '127.0.0.1', port: 0, strictPort: false, hmr: false, proxy: {'/api': {target: apiUrl, changeOrigin: true}}},
      define: {'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false')}});
    let browser;
    try {
      await vite.listen(); const address = vite.httpServer.address(); assert(address && typeof address !== 'string'); const baseUrl = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({headless: true}); const context = await browser.newContext({viewport: {width: 1600, height: 1100}, timezoneId: 'Asia/Kolkata'});
      const session = {id: f.ownerId, employeeId: f.ownerId, name: 'Synthetic capture operator', role: 'Admin', permissionRole: 'Admin', permissions: workPermissions};
      const scope = {organizationId: f.organizationId, legalEntityId: f.legalEntityId};
      await context.addInitScript(({session, scope, token}) => {
        sessionStorage.setItem('workos_session', JSON.stringify(session)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token);
      }, {session, scope, token: tokenFor(identities.manager)});
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      const errors = [], external = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        const url = new URL(request.url()); if (/^https?:/.test(request.url()) && url.origin !== baseUrl) external.push(request.url());
        if (url.pathname.startsWith('/api/') && request.method() !== 'GET') writes.push({path: url.pathname, body: request.postDataJSON()});
      });
      const response = path => page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === 'POST');
      // Transport failure injection only: business state is still served by the
      // actual API/PostgreSQL, and the retry must reset cached offline health.
      await page.route('**/api/health',route=>route.abort());
      await page.goto(`${baseUrl}/tests/fixtures/work-capture-policy.html`);
      await page.getByText('Work could not be loaded. Reload before editing.',{exact:true}).waitFor();
      await page.unroute('**/api/health');
      await page.getByRole('button',{name:'Reload work',exact:true}).click();
      await page.getByRole('button',{name:'Save Draft',exact:true}).waitFor();

      await page.getByRole('button', {name: 'Previous week', exact: true}).click();
      await page.getByRole('region', {name: 'Preserved off-grid entries'}).waitFor();
      assert.equal(await page.locator('tbody tr').count(), 2);
      const first=page.locator('tbody tr').filter({has:page.locator('input[value="Synthetic A"]')});
      assert.equal(await first.locator('input[placeholder="0.0"]').first().inputValue(), '0.25');
      for(const invalid of ['-1','1e999','24.0000000000000001']){
        await first.locator('input[placeholder="0.0"]').first().fill(invalid);
        assert.equal(await page.getByRole('button',{name:'Save Draft',exact:true}).isDisabled(),true);
        await page.getByRole('alert').filter({hasText:'Correct invalid hours before saving.'}).waitFor();
      }
      await first.locator('input[placeholder="0.0"]').first().fill('0.5');
      const saveResponse = response('/api/timesheets'); await page.getByRole('button', {name: 'Save Draft', exact: true}).dblclick();
      assert.equal((await saveResponse).status(), 200); await page.getByText('Draft timesheet saved.', {exact: true}).waitFor();
      const saved = (await pool.query('select work_date::text,hours::text,category,remark,billable from timesheet_entries where timesheet_id=$1 order by category', [header])).rows;
      assert.equal(saved.length, 4); assert.deepEqual(saved.map(entry => entry.hours), ['0.5', '0.5', '0.25', '0']);
      assert(saved.every(entry => entry.billable === false)); assert.equal(saved[0].remark, hostile);
      assert.equal((await pool.query('select total_hours::text from timesheets where id=$1', [header])).rows[0].total_hours, '1.25');
      assert.equal(writes.filter(write => write.path === '/api/timesheets').length, 1);
      assert.equal(await page.evaluate(() => window.syntheticCaptureExecuted), undefined);
      await page.getByRole('button', {name: 'Configure capture policy', exact: true}).click();
      await page.getByText('No explicit capture policy. Existing neutral compatibility applies.', {exact: true}).waitFor();
      await page.getByLabel('Minimum increment (hours)').fill('0');
      const invalidPolicy=response('/api/v1/work-capture-policy');await page.getByRole('button',{name:'Append capture policy',exact:true}).click();
      assert.equal((await invalidPolicy).status(),400);
      await page.getByText('Policy was not saved. Check quantities and activation date.',{exact:true}).waitFor();
      await page.getByLabel('Minimum increment (hours)').fill('0.25');
      await page.getByLabel('Require a comment on every positive entry').check();
      const appendResponse = response('/api/v1/work-capture-policy');
      await page.getByRole('button', {name: 'Append capture policy', exact: true}).dblclick(); assert.equal((await appendResponse).status(), 201);
      await page.getByText('Policy version appended. Reload to review the retained version before making another change.', {exact: true}).waitFor();
      assert.equal((await pool.query('select count(*)::int n from work_capture_policy_versions')).rows[0].n, 1);
      await page.getByRole('button', {name: 'Reload capture policy', exact: true}).click();
      await page.getByText(`Version 1, effective ${today}:`, {exact: false}).waitFor();
      await context.setOffline(true);
      await page.getByRole('button',{name:'Append capture policy',exact:true}).click();
      await page.getByText('Save could not be confirmed. Reload before trying again. Do not resubmit an uncertain save.',{exact:true}).waitFor();
      await context.setOffline(false);
      await page.getByRole('button',{name:'Reload capture policy',exact:true}).click();
      await page.getByText(`Version 1, effective ${today}:`,{exact:false}).waitFor();
      assert.equal((await pool.query('select count(*)::int n from work_capture_policy_versions')).rows[0].n,1,'offline uncertain append creates no duplicate');
      const latest=(await pool.query('select id from work_capture_policy_versions order by sequence desc limit 1')).rows[0].id;
      assert.equal((await request('/api/v1/work-capture-policy',{method:'POST',body:{expectedLatestId:latest,effectiveFrom:addUtcDays(today,7),minimumIncrement:'0.25',dailyMaximum:null,weeklyMaximum:null,commentRequired:true}})).status,201);
      const conflict=response('/api/v1/work-capture-policy');await page.getByRole('button',{name:'Append capture policy',exact:true}).click();assert.equal((await conflict).status(),409);
      await page.getByText('Policy was not saved because its version or activation date changed. Reload before trying again.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Reload capture policy',exact:true}).click();
      await page.getByText(`Version 2, effective ${addUtcDays(today,7)}:`,{exact:false}).waitFor();
      // Real in-flight request blocked on the shared database lock, no network
      // mocks. A scope-switch request must not resurrect stale save success.
      const blocker = await pool.connect();
      try {
        await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`commercial-lifecycle:${f.organizationId}:${f.legalEntityId}`]);
        const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/work-capture-policy' && request.method() === 'POST');
        const pending = response('/api/v1/work-capture-policy');
        await page.getByRole('button', {name: 'Append capture policy', exact: true}).click(); await started;
        await page.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
        await page.getByText('Access or scope changed. Reload for the selected legal entity.', {exact: true}).waitFor();
        await blocker.query('commit'); assert.equal((await pending).status(), 201);
        assert.equal(await page.getByText('Policy version appended. Reload to review the retained version before making another change.', {exact: true}).count(), 0);
      } finally { await blocker.query('rollback').catch(() => {}); blocker.release(); }
      assert.equal((await pool.query('select count(*)::int n from work_capture_policy_versions')).rows[0].n, 3);
      await page.getByRole('button', {name: 'Reload capture policy', exact: true}).click();
      await page.getByText(`Version 3, effective ${addUtcDays(today, 14)}:`, {exact: false}).waitFor();
      await page.getByRole('button', {name: 'Enter work', exact: true}).click(); await page.getByRole('button', {name: 'Previous week', exact: true}).click();
      await page.getByRole('region', {name: 'Preserved off-grid entries'}).waitFor(); assert.equal(await page.locator('tbody tr').count(), 2);
      assert.deepEqual(errors, []); assert.deepEqual(external, []); await context.close();
    } finally { await browser?.close(); await vite.close(); }
  });
});
console.log('Real React/API/PostgreSQL capture journey passed: quarter-hour save, duplicate and off-grid preservation, billability/comments, repeated clicks, outage recovery, validation/conflict/uncertain append recovery, append/reload and in-flight scope invalidation.');
