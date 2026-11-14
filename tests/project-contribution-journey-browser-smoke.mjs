import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedActualWork, adoptActualInputs, actualEntries} from './support/actual-work-test.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const {identities, today} = await seedActualWork(pool);
  await withCommercialApi({databaseUrl, identities}, async ({baseUrl: apiUrl, request, tokenFor}) => {
    await adoptActualInputs(request, today);
    const work = await request('/api/timesheets', {method: 'POST', identity: identities.reader, body: {
      employee_id: f.ownerId, week_ending: today, status: 'Submitted', entries: actualEntries(today)}});
    assert.equal(work.status, 200, JSON.stringify(work.body));
    assert.equal((await request(`/api/timesheets/${work.body.id}/status`, {method: 'PATCH', body: {status: 'Approved'}})).status, 200);
    const vite = await createServer({root, mode: 'production', logLevel: 'error', server: {host: '127.0.0.1', port: 0, hmr: false,
      proxy: {'/api': {target: apiUrl, changeOrigin: true}}}, define: {'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false')}});
    let browser;
    try {
      await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      browser = await chromium.launch({headless: true});
      const context = await browser.newContext({viewport: {width: 1280, height: 960}, acceptDownloads: true});
      await context.addInitScript(({scope, token, user}) => {
        sessionStorage.setItem('workos_session', JSON.stringify(user)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token);
      }, {scope: {organizationId: f.organizationId, legalEntityId: f.legalEntityId}, token: tokenFor(identities.manager), user: {
        id: identities.manager.id, name: 'Synthetic reporting operator', role: 'Admin', permissionRole: 'Admin', permissions: ['projects.view', 'employees.view', 'reports.view_utilization', 'reports.export']}});
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      const errors = [], external = [], downloads = [], writes = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('download', download => downloads.push(download));
      page.on('request', req => {if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== origin) external.push(req.url()); if (req.method() === 'POST') writes.push(req.url());});
      await page.goto(origin + '/tests/fixtures/project-contribution-real.html?project=' + encodeURIComponent(f.projectId));
      await page.getByLabel('Project period starts').fill(today); await page.getByLabel('Project period ends').fill(today);
      await page.getByRole('button', {name: 'Load project contribution', exact: true}).click();
      const report = page.getByRole('article', {name: 'Current project contribution', exact: true});
      await report.waitFor(); assert.equal(await report.getByText('25%', {exact: true}).count(), 2);
      await page.getByLabel('Report retention reason').fill('Synthetic real browser export');
      const path = '/api/v1/project-contribution/projects/' + f.projectId + '/evidence';
      let committed;
      await page.route('**' + path, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const upstream = await route.fetch(); assert.equal(upstream.status(), 201);
        committed = await upstream.json();
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'SYNTHETIC_ACK_LOSS', error: 'Synthetic lost acknowledgement after commit'})});
      }, {times: 1});
      await page.getByRole('button', {name: 'Retain report for export', exact: true}).click();
      await page.getByText(/Retention is not confirmed/).waitFor();
      assert.equal(await page.getByLabel('Project period starts').isDisabled(), true);
      assert.equal((await pool.query('select count(*)::int n from project_contribution_evidence')).rows[0].n, 1);
      await page.getByRole('button', {name: 'Reconcile original report request', exact: true}).click();
      await page.getByText('The original report is confirmed. No new report was created.', {exact: true}).waitFor();
      assert.equal(writes.length, 1, 'reconciliation must not resend a command');
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', {name: 'Download confirmed report CSV', exact: true}).click();
      const downloaded = await downloadPromise, bytes = await readFile(await downloaded.path());
      const stored = (await pool.query('select * from project_contribution_evidence where id=$1', [committed.evidence.id])).rows[0];
      assert.equal(bytes.toString('utf8'), stored.artifact_csv);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), stored.artifact_sha256);
      assert.equal(bytes.length, stored.artifact_bytes);
      assert.equal(downloaded.suggestedFilename(), committed.evidence.artifact.fileName);
      await pool.query(`insert into working_calendar_holidays(id,organization_id,calendar_id,holiday_date,label,holiday_type,active,effective_from)
        values('synthetic-browser-holiday',$1,'synthetic-actual-calendar',$2,'Synthetic holiday','Company',true,'1970-01-01')`, [f.organizationId, today]);
      await page.getByRole('button', {name: 'Retain report for export', exact: true}).click();
      await page.getByText('Sources changed before retention. Reload the contribution before saving another report.', {exact: true}).waitFor();
      assert.equal((await pool.query('select count(*)::int n from project_contribution_evidence')).rows[0].n, 1);
      await page.getByRole('button', {name: 'Load project contribution', exact: true}).click();
      await report.getByText('Not applicable', {exact: true}).first().waitFor();
      await page.getByRole('button', {name: 'Load retained report history', exact: true}).click();
      const oldDownload = page.getByRole('button', {name: 'Download retained CSV', exact: true}); await oldDownload.waitFor();
      const oldPromise = page.waitForEvent('download'); await oldDownload.click();
      assert.deepEqual(await readFile(await (await oldPromise).path()), bytes, 'later source changes cannot rewrite retained bytes');
      await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.export'");
      await oldDownload.click(); await page.getByRole('alert').waitFor();
      assert.equal(await report.count(), 0, 'known permission denial clears retained and current data');
      assert.equal(downloads.length, 2);
      const audit = await pool.query("select action from audit_logs where entity_type='ProjectContributionEvidence' and entity_id=$1", [stored.id]);
      assert.equal(audit.rows.filter(row => row.action === 'Retain Project Contribution Evidence').length, 1);
      assert.equal(audit.rows.filter(row => row.action === 'Retrieve Project Contribution Artifact').length, 2);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally {await browser?.close(); await vite.close();}
  });
});
console.log('Project contribution real React/API/PostgreSQL journey passed: approved source, exact report, committed lost acknowledgement, read-only reconciliation, immutable verified download, stale-source refusal, history and live export revocation.');
