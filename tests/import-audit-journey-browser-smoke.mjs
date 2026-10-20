import assert from 'node:assert/strict';
import {withImportAuditJourney, journeyFixture as f} from './support/import-audit-journey.mjs';

// This is deliberately not one of the mocked component fixtures. The actual
// index.html/App, services, API middleware, migrations and PostgreSQL run here.
// Only two short-lived signed test sessions are bootstrapped in browser storage.
await withImportAuditJourney(async ({pool, browserUrl, producerId, reviewerId, producer, reviewer}) => {
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true});
  const contexts = [];
  const errors = [];
  const requests = [];
  const externalRequests = [];
  const downloads = [];
  const makeContext = async bootstrap => {
    const context = await browser.newContext({viewport: {width: 1280, height: 1000}});
    contexts.push(context);
    // Deny providers/external navigation, never fulfill or replace any API or
    // business response. Every permitted request reaches the actual application.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== browserUrl) {
        externalRequests.push(`${url.protocol}//${url.host}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await context.addInitScript(data => {
      if (!sessionStorage.getItem('workos_api_token')) sessionStorage.setItem('workos_api_token', data.token);
      if (!sessionStorage.getItem('workos_session')) sessionStorage.setItem('workos_session', JSON.stringify(data.session));
      if (!sessionStorage.getItem('workos_organization_scope')) {
        sessionStorage.setItem('workos_organization_scope', JSON.stringify(data.scope));
      }
    }, bootstrap);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('download', () => downloads.push('unexpected download'));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) requests.push({path, method: request.method()});
    });
    return page;
  };
  const savedState = async () => {
    const rows = await pool.query(`select
      (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from projects p) as projects,
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from import_export_logs l) as batches,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from audit_logs a) as audits,
      (select coalesce(jsonb_agg(to_jsonb(i) order by i.batch_id),'[]') from import_export_idempotency i) as operations,
      (select count(*)::int from user_permission_grants) as grants`);
    return rows.rows[0];
  };
  const operationResponse = page => page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/imports/projects/apply' && response.request().method() === 'POST');
  const history = page => page.getByRole('region', {name: 'Import / Export History'});
  const inspectSavedHistory = async (page, expected) => {
    await page.waitForLoadState('networkidle');
    const panel = history(page);
    await panel.getByText('2 recent operations in this workspace.', {exact: true}).waitFor();
    const items = panel.locator('li').filter({hasText: f.fileName});
    assert.equal(await items.count(), 2);
    for (const entry of expected) {
      const item = items.filter({hasText: `Import · ${entry.status} · 1/1 valid`});
      assert.equal(await item.count(), 1);
      await item.locator('summary').click();
      await item.getByText(entry.id, {exact: true}).waitFor();
      assert.ok((await item.innerText()).includes('project-master/1'));
      assert.ok((await item.innerText()).includes(`Server-side dry run\n${entry.dryRun ? 'Yes' : 'No'}`));
      assert.ok((await item.innerText()).includes(f.producerUsername));
    }
  };
  const references = response => ({correlationId: response.headers()['x-correlation-id'], operationId: response.headers()['x-operation-id']});
  try {
    assert.notEqual(producerId, reviewerId);
    assert.notEqual(producer.session.userName, reviewer.session.userName);
    const producerPage = await makeContext(producer);
    await producerPage.goto(`${browserUrl}/import-export`);
    await producerPage.getByRole('heading', {name: 'Import / Export', exact: true}).waitFor();
    await producerPage.getByTestId('organization-scope-selected').waitFor();
    await history(producerPage).getByText('No bulk data operations have been run yet in this workspace.', {exact: true}).waitFor();
    await producerPage.waitForLoadState('networkidle');
    const csv = [
      'projectCode,name,clientId,client,managerId,startDate,endDate,status,billable,projectType,country,notes',
      [f.projectCode, f.projectName, f.clientId, f.clientName, f.managerEmployeeId,
        '2026-01-01', '2026-12-31', 'Active', 'true', 'Delivery', 'US', 'Synthetic end-to-end provenance'].join(','),
    ].join('\n');
    const channel = producerPage.locator('div.bg-white').filter({has: producerPage.getByRole('heading', {name: 'Project Master', exact: true})});
    const dryRunResponsePromise = operationResponse(producerPage);
    await channel.locator('input[type="file"]').setInputFiles({name: f.fileName, mimeType: 'text/csv', buffer: Buffer.from(csv)});
    const dryRunResponse = await dryRunResponsePromise;
    assert.equal(dryRunResponse.status(), 200);
    const dryRun = await dryRunResponse.json();
    assert.deepEqual({status: dryRun.status, validRows: dryRun.validRows, errorRows: dryRun.errorRows},
      {status: 'Dry Run', validRows: 1, errorRows: 0});
    const dryRunReferences = references(dryRunResponse);
    assert.ok(dryRunReferences.correlationId && dryRunReferences.operationId);
    const dryState = await savedState();
    assert.deepEqual(dryState.projects, [], 'validation must not create a project');
    assert.equal(dryState.batches.length, 1);
    assert.equal(dryState.batches[0].dry_run, true);
    assert.equal(dryState.audits.length, 1);
    assert.equal(dryState.audits[0].entity_type, 'ImportBatch');
    assert.equal(dryState.audits[0].entity_id, dryRun.log.id);
    assert.equal(dryState.audits[0].import_batch_id, dryRun.log.id);
    assert.equal(dryState.audits[0].import_processing_result, 'Dry Run');
    assert.equal(dryState.audits[0].source_identifier, null, 'dry-run batch must not invent a row source identifier');
    assert.equal(dryState.audits[0].correlation_id, dryRunReferences.correlationId);
    assert.equal(dryState.audits[0].operation_id, dryRunReferences.operationId);
    const applyButton = producerPage.getByRole('button', {name: 'Apply Valid Rows', exact: true});
    await applyButton.waitFor();
    const applyResponsePromise = operationResponse(producerPage);
    await applyButton.click();
    const applyResponse = await applyResponsePromise;
    assert.equal(applyResponse.status(), 200);
    const applied = await applyResponse.json();
    assert.deepEqual({status: applied.status, validRows: applied.validRows, errorRows: applied.errorRows},
      {status: 'Success', validRows: 1, errorRows: 0});
    assert.notEqual(applied.log.id, dryRun.log.id);
    const applyReferences = references(applyResponse);
    assert.ok(applyReferences.correlationId && applyReferences.operationId);
    assert.notEqual(applyReferences.correlationId, dryRunReferences.correlationId);
    assert.notEqual(applyReferences.operationId, dryRunReferences.operationId);
    const appliedState = await savedState();
    assert.equal(appliedState.projects.length, 1);
    const project = appliedState.projects[0];
    assert.equal(project.project_code, f.projectCode);
    assert.equal(project.name, f.projectName);
    assert.equal(project.client_id, f.clientId);
    assert.equal(project.manager_id, f.managerId);
    assert.equal(project.organization_id, f.organizationId);
    assert.equal(project.legal_entity_id, f.legalEntityId);
    assert.equal(appliedState.batches.length, 2);
    assert.equal(appliedState.operations.length, 2);
    assert.equal(appliedState.audits.length, 2);
    const projectAudit = appliedState.audits.find(row => row.entity_type === 'Project');
    assert.ok(projectAudit, 'successful apply must persist a real project audit');
    assert.equal(projectAudit.entity_id, project.id);
    assert.equal(projectAudit.user_id, producerId);
    assert.equal(projectAudit.user_name, f.producerUsername);
    assert.equal(projectAudit.user_role, 'Admin');
    assert.equal(projectAudit.active_role, 'Admin');
    assert.equal(projectAudit.source, 'Project Master CSV');
    assert.equal(projectAudit.source_identifier, f.projectCode);
    assert.equal(projectAudit.import_batch_id, applied.log.id);
    assert.equal(projectAudit.import_processing_result, 'Success');
    assert.equal(projectAudit.correlation_id, applyReferences.correlationId);
    assert.equal(projectAudit.operation_id, applyReferences.operationId);
    assert.equal(projectAudit.old_value, null);
    assert.equal(projectAudit.new_value.project_code, f.projectCode);
    for (const batch of appliedState.batches) {
      assert.equal(batch.user_name, f.producerUsername);
      assert.equal(batch.organization_id, f.organizationId);
      assert.equal(batch.legal_entity_id, f.legalEntityId);
      assert.equal(batch.schema_version, 'project-master/1');
    }
    for (const audit of appliedState.audits) {
      assert.equal(audit.user_id, producerId);
      assert.equal(audit.user_name, f.producerUsername);
      assert.equal(audit.user_role, 'Admin');
      assert.equal(audit.active_role, 'Admin');
      assert.equal(audit.source, 'Project Master CSV');
      assert.equal(audit.organization_id, f.organizationId);
      assert.equal(audit.legal_entity_id, f.legalEntityId);
      assert.ok(audit.created_at);
    }
    assert.equal(appliedState.grants, 0);
    const expectedHistory = [{id: dryRun.log.id, status: 'Dry Run', dryRun: true},
      {id: applied.log.id, status: 'Success', dryRun: false}];
    await inspectSavedHistory(producerPage, expectedHistory);
    await producerPage.reload();
    await inspectSavedHistory(producerPage, expectedHistory);
    console.log('PASS actual Import/Export CSV validate/apply/reload; PostgreSQL dry-run, project, batch, audit and operation witnesses.');

    // Freeze the mutation evidence before an independent named reviewer opens
    // the real Audit Trail. Reads, reload, details and scope changes must not
    // modify any business/audit/import/idempotency evidence or add user grants.
    const mutationRequests = requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    assert.deepEqual(mutationRequests, [
      {path: '/api/v1/imports/projects/apply', method: 'POST'},
      {path: '/api/v1/imports/projects/apply', method: 'POST'},
    ]);
    const requestCountBeforeReview = requests.length;
    const reviewerPage = await makeContext(reviewer);
    const auditReadPromise = reviewerPage.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/audit-logs' && response.status() === 200);
    await reviewerPage.goto(`${browserUrl}/audit-trail`);
    await reviewerPage.getByRole('heading', {name: 'Audit Trail', exact: true}).waitFor();
    const auditRead = await auditReadPromise;
    await reviewerPage.waitForLoadState('networkidle');
    const auditRows = await auditRead.json();
    assert.equal(auditRows.length, 2);
    const readReferences = references(auditRead);
    assert.ok(readReferences.correlationId, 'later GET has its own request trace');
    assert.equal(readReferences.operationId, undefined, 'a later read must not invent a mutation operation reference');
    assert.notEqual(readReferences.correlationId, applyReferences.correlationId);
    assert.notEqual(readReferences.correlationId, dryRunReferences.correlationId);
    assert.equal(auditRows.find(row => row.id === projectAudit.id).user_id, producerId);
    assert.equal(await reviewerPage.evaluate(() => JSON.parse(sessionStorage.getItem('workos_session')).userName), f.reviewerUsername);
    const inspectAudit = async (row, savedReferences, batchId, sourceIdentifier, result) => {
      await reviewerPage.getByRole('button', {name: `View audit entry ${row.id}`, exact: true}).click();
      const provenance = reviewerPage.getByRole('region', {name: 'Recorded audit provenance'});
      await provenance.waitFor();
      const expected = {
        'Recorded source': 'Project Master CSV', 'Recorded active role': 'Admin',
        'Saved correlation reference': savedReferences.correlationId,
        'Saved operation reference': savedReferences.operationId, 'Import batch reference': batchId,
        'Source identifier': sourceIdentifier || 'Not recorded or unavailable', 'Recorded processing result': result,
      };
      for (const [label, value] of Object.entries(expected)) {
        const item = provenance.locator('dt').filter({hasText: label}).locator('..');
        assert.equal(await item.locator('dd').innerText(), value);
      }
      assert.equal((await provenance.innerText()).includes(readReferences.correlationId), false,
        'saved provenance must not be backfilled from the later GET trace');
      const panel = reviewerPage.locator('div.fixed.top-0.right-0');
      assert.ok((await panel.innerText()).includes(f.producerUsername));
      assert.equal((await panel.innerText()).includes(f.reviewerUsername), false,
        'recorded producer is not the current reviewer');
      await panel.getByRole('button').first().click();
      await reviewerPage.getByRole('heading', {name: 'Governance Review'}).waitFor({state: 'hidden'});
    };
    await inspectAudit(projectAudit, applyReferences, applied.log.id, f.projectCode, 'Success');
    await inspectAudit(dryState.audits[0], dryRunReferences, dryRun.log.id, null, 'Dry Run');
    await reviewerPage.reload();
    await reviewerPage.waitForLoadState('networkidle');
    await reviewerPage.getByRole('button', {name: `View audit entry ${projectAudit.id}`, exact: true}).waitFor();

    // Existing actual context control selects a second authorized legal entity,
    // in the same organization. It must expose neither tenant's import/audit row.
    await Promise.all([reviewerPage.waitForNavigation({waitUntil: 'networkidle'}),
      reviewerPage.getByRole('combobox', {name: 'Organization context'}).selectOption(`${f.organizationId}:${f.otherLegalEntityId}`)]);
    const otherAudit = await reviewerPage.evaluate(async () => {
      const scope = JSON.parse(sessionStorage.getItem('workos_organization_scope'));
      const response = await fetch('/api/audit-logs', {headers: {
        Authorization: `Bearer ${sessionStorage.getItem('workos_api_token')}`,
        'X-Organization-Id': scope.organizationId, 'X-Legal-Entity-Id': scope.legalEntityId,
      }});
      return {status: response.status, rows: await response.json(), scope};
    });
    assert.equal(otherAudit.status, 200);
    assert.equal(otherAudit.scope.legalEntityId, f.otherLegalEntityId);
    assert.deepEqual(otherAudit.rows, []);
    await reviewerPage.getByText('No audit records were returned for the selected organization and legal entity.', {exact: true}).waitFor();
    assert.equal(await reviewerPage.getByRole('button', {name: `View audit entry ${projectAudit.id}`, exact: true}).count(), 0);
    assert.equal(await reviewerPage.getByRole('region', {name: 'Recorded audit provenance'}).count(), 0);
    await reviewerPage.goto(`${browserUrl}/import-export`);
    await reviewerPage.waitForLoadState('networkidle');
    await history(reviewerPage).getByText('No bulk data operations have been run yet in this workspace.', {exact: true}).waitFor();
    assert.equal((await history(reviewerPage).innerText()).includes(f.fileName), false);
    // Producer lacks this legal-entity assignment altogether. Exercise the real
    // middleware, not role removal, and do not mutate any identity/permission.
    const denied = await producerPage.evaluate(async ({organizationId, legalEntityId}) => {
      const headers = {Authorization: `Bearer ${sessionStorage.getItem('workos_api_token')}`,
        'X-Organization-Id': organizationId, 'X-Legal-Entity-Id': legalEntityId};
      const results = [];
      for (const path of ['/api/audit-logs', '/api/import-export-logs']) {
        const response = await fetch(path, {headers});
        results.push({status: response.status, text: await response.text()});
      }
      return results;
    }, {organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId});
    assert.ok(denied.every(result => result.status === 403));
    assert.ok(denied.every(result => !result.text.includes(f.projectCode) && !result.text.includes(applied.log.id)
      && !result.text.includes(f.fileName)));
    assert.deepEqual(requests.slice(requestCountBeforeReview).filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)), [],
      'inspection and negative scope checks must issue no mutation request');
    assert.deepEqual(await savedState(), appliedState, 'inspection must not change retained mutation evidence');
    assert.deepEqual(externalRequests, [], 'no provider, credential or external-data request');
    assert.deepEqual(downloads, [], 'export is not part of this journey');
    assert.deepEqual(errors, [], 'the real React journey must have no page errors');
    console.log('PASS distinct named reviewer real Audit Trail saved producer/role/source/batch/project/trace provenance; dry-run versus success; other-legal exclusion, denied unassigned scope and zero inspection mutations.');
  } finally {
    try { await Promise.all(contexts.map(context => context.close())); } finally { await browser.close(); }
  }
});

console.log('Integrated import-to-audit PostgreSQL/browser acceptance journey passed. Synthetic sessions only, not production OIDC/UAT or full WOS-03B acceptance.');
