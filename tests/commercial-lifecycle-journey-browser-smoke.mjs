import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {runMigrations} from '../server/migrate.mjs';
import {recordAuditEvent} from '../server/modules/audit/audit-record.mjs';
import {withCommercialDatabase, withPreCommercialMigrations, seedCommercialReferences, seedCommercialLegacyWork,
  migrateCommercialDatabase, seedCommercialIdentities, withCommercialApi, commercialFixture} from './support/commercial-drafting-test.mjs';

// Hosted acceptance only. This runs the actual React -> HTTP API -> randomized
// disposable PostgreSQL path. No routes, fetch responses, services or writes are
// mocked. Missing PostgreSQL/Chromium is a required-test failure, never a skip.
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = '/api/v1/commercial-drafting';
const lifecyclePrefix = `${prefix}/lifecycle`;
const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const hostile = '<script>window.syntheticLifecycleExecuted=true</script>';
const privateReason = `Synthetic protected lifecycle evidence ${hostile}`;
const approvalReference = 'SYNTHETIC-PROTECTED-APPROVAL';
const proposed = {id: 'project-lifecycle-proposed', code: 'SYN-LIFECYCLE-PROPOSED', name: 'Synthetic Proposed promotion', startsOn: '2020-01-01', endsOn: '2099-12-31'};
const transitionFields = ['expectedSequence','state','contractVersionId','reason','approvalReference'];
const projectFields = ['engagementId','projectId','code','name','managerId','startsOn','endsOn','billable','budgetAllocation','reason'];
const snapshot = async (pool, table, where = '', values = []) => (await pool.query(`select to_jsonb(t) value from ${table} t ${where} order by to_jsonb(t)::text`, values)).rows;
const durableEvidence = async pool => {
  const output = {};
  for (const table of ['project_allocations','timesheets','timesheet_entries','approval_records','project_engagement_mappings','commercial_contracts','commercial_contract_versions','commercial_engagements','commercial_draft_events','commercial_purchase_orders','commercial_milestones']) output[table] = await snapshot(pool, table);
  output.neutralEngagements = await snapshot(pool, 'commercial_engagements', "where origin='legacy-neutral'");
  output.historicalProject = await snapshot(pool, 'projects', 'where id=$1', [commercialFixture.projectId]);
  return output;
};
const stateCounts = async pool => ({events: (await pool.query('select count(*)::int count from commercial_lifecycle_events')).rows[0].count,
  bindings: (await pool.query('select count(*)::int count from commercial_project_bindings')).rows[0].count,
  audit: (await pool.query("select count(*)::int count from audit_logs where module='Commercial Lifecycle'")).rows[0].count});

// Compose only the established safe fixture helpers. The Proposed project must
// exist before migration040 so promotion can prove its neutral mapping survives.
await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await withPreCommercialMigrations(async rootDir => {
    await runMigrations({pool, rootDir, logger: {log() {}}});
    await seedCommercialReferences(pool);await seedCommercialLegacyWork(pool);
    await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,project_type,billable,start_date,end_date,status,country,notes,organization_id,legal_entity_id)
      values($1,$2,$3,$4,'Synthetic commercial local client',$5,'Synthetic commercial owner','Synthetic legacy model',true,$6,$7,'Proposed','US','Synthetic no-history promotion fixture',$8,$9)`,
    [proposed.id,proposed.code,proposed.name,commercialFixture.clientId,commercialFixture.ownerId,proposed.startsOn,proposed.endsOn,commercialFixture.organizationId,commercialFixture.legalEntityId]);
    await recordAuditEvent(pool,{organizationScope:{organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.legalEntityId}},
      {module:'Projects',action:'Create Project',entityType:'Project',entityId:proposed.id,oldValue:null,
        newValue:(await pool.query('select * from projects where id=$1',[proposed.id])).rows[0],details:'Synthetic original Proposed creation provenance'});
    await migrateCommercialDatabase(pool);
  });
  const identities = await seedCommercialIdentities(pool);
  // Explicit, synthetic test-only authority in this randomized database. Never
  // mutate a live identity, inherit a role default or change product grants.
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.lifecycle.manage',true)
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`);
  await withCommercialApi({databaseUrl, identities}, async ({baseUrl: apiUrl, request: apiRequest, tokenFor}) => {
    const scope = {organizationId: commercialFixture.organizationId, legalEntityId: commercialFixture.legalEntityId};
    const ownerId = commercialFixture.ownerId, clientId = commercialFixture.clientId;
    const command = async (path, body) => {
      const result = await apiRequest(path, {method: 'POST', body});assert.equal(result.status, 201, `real fixture setup ${path}`);return result.body;
    };
    const terms = {name: 'Synthetic lifecycle contract', model: 'fixed_fee', startsOn: '2020-01-01', endsOn: '2099-12-31', effectiveFrom: '2020-01-01', currency: 'GBP', value: '25000.0001', billingTerms: 'Synthetic protected billing terms', documents: [{name: 'Synthetic terms', url: 'https://example.test/synthetic-lifecycle.pdf'}]};
    const contract = await command('/contracts', {...terms, number: 'SYN-LIFECYCLE-CONTRACT', clientId, reason: 'Synthetic lifecycle contract setup'});
    const pin = contract.versions[0].id;
    const revision = await command(`/contracts/${contract.id}/versions`, {...terms, effectiveFrom: future, expectedVersion: 1, value: '30000.0002', reason: 'Synthetic future terms setup'});
    const futurePin = revision.versions.find(version => version.version === 2).id;
    const engagementInput = {code: 'SYN-LIFECYCLE-ENGAGEMENT', name: 'Synthetic lifecycle engagement', model: 'fixed_fee', ownerId, startsOn: '2020-01-01', endsOn: '2099-12-31', currency: 'GBP', budget: '10000.0001', contractId: contract.id, contractVersionId: pin, clientId, attributionId: null, reason: 'Synthetic lifecycle engagement setup'};
    const engagement = await command('/engagements', engagementInput);
    const futureEngagement = await command('/engagements', {...engagementInput, code: 'SYN-LIFECYCLE-FUTURE-PIN', name: 'Synthetic future-pinned engagement', startsOn: future, contractVersionId: futurePin});
    const beforeEvidence = await durableEvidence(pool);
    const proposedBefore = (await snapshot(pool, 'projects', 'where id=$1', [proposed.id]))[0].value;
    // Match the source row's existing pg-driver JSON representation, including
    // timestamp serialization; the neutral migration snapshot is compared raw.
    const proposedSourceBefore = JSON.parse(JSON.stringify((await pool.query('select *,start_date::text,end_date::text from projects where id=$1', [proposed.id])).rows[0]));
    const neutralBefore = (await snapshot(pool, 'project_engagement_mappings', 'where project_id=$1', [proposed.id]))[0].value;
    assert.equal(neutralBefore.source_snapshot.status, 'Proposed');assert.equal(neutralBefore.origin, 'legacy-neutral');
    assert.equal((await pool.query('select count(*)::int count from project_allocations where project_id=$1', [proposed.id])).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int count from timesheet_entries where project_id=$1', [proposed.id])).rows[0].count, 0);
    const fixtureServer = await startFixtureServer({root, fixtures: ['commercial-lifecycle'], apiUrl});
    let browser;
    try {
      const baseUrl = fixtureServer.url;
      browser = await chromium.launch({headless: true, ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {})});
      const errors = [], external = [], writes = [], reads = [];
      const createContext = async (identity, permissions) => {
        const context = await browser.newContext({viewport: {width: 1200, height: 1000}});
        const session = {id: identity.id, employeeId: ownerId, name: 'Synthetic lifecycle journey operator', role: identity.role, permissionRole: identity.role, permissions};
        await context.addInitScript(({session, scope, token}) => {
          sessionStorage.setItem('workos_session', JSON.stringify(session));sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));sessionStorage.setItem('workos_api_token', token);
        }, {session, scope, token: tokenFor(identity)});
        const page = await context.newPage();page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          const url = new URL(request.url());if (/^https?:/.test(request.url()) && url.origin !== baseUrl) external.push(request.url());
          if (url.pathname.startsWith('/api/')) {
            const record = {path: url.pathname, method: request.method(), body: request.method() === 'GET' ? null : request.postDataJSON(), headers: request.headers()};
            (request.method() === 'GET' ? reads : writes).push(record);
          }
        });
        return {context, page, session};
      };
      const manager = await createContext(identities.manager, ['commercial.contracts.view','commercial.lifecycle.manage']);
      const {page} = manager;
      const button = name => page.getByRole('button', {name, exact: true});
      const ready = () => button(`View history for ${contract.number}`).waitFor();
      const open = async () => {await page.goto(`${baseUrl}/tests/fixtures/commercial-lifecycle.html`);await ready();};
      const reload = async () => {await page.reload();await ready();};
      const post = async (path, action, expectedStatus = 201) => {
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `${lifecyclePrefix}${path}` && response.request().method() === 'POST');
        await action();const response = await responsePromise;assert.equal(response.status(), expectedStatus, `real browser lifecycle ${path}`);
        const body = response.request().postDataJSON();assert.deepEqual(Object.keys(body).sort(), (path === '/projects' ? projectFields : transitionFields).toSorted(), 'exact production command allowlist');
        assert.equal(response.request().headers()['x-organization-id'], scope.organizationId);assert.equal(response.request().headers()['x-legal-entity-id'], scope.legalEntityId);
        const result = await response.json();await reload();return {body, result};
      };
      const editTransition = async label => {await button(label).click();await page.getByLabel('Reason', {exact: true}).fill(privateReason);await page.getByLabel('Approval reference (optional)', {exact: true}).fill(approvalReference);};
      const transition = async ({type, id, label, sequence, state, version = pin, expectedStatus = 201, code}) => {
        const before = await stateCounts(pool);await editTransition(label);
        const result = await post(`/${type}/${id}/transitions`, () => button('Confirm lifecycle transition').click(), expectedStatus);
        assert.deepEqual(result.body, {expectedSequence: sequence, state, contractVersionId: version, reason: privateReason, approvalReference});
        if (expectedStatus === 201) {assert.equal(result.result.sequence, sequence + 1);assert.equal(result.result.state, state);assert.equal(result.result.contractVersionId, version);}
        else {assert.equal(result.result.error.code, code);assert.deepEqual(await stateCounts(pool), before, 'denied transition atomically changes no event, project binding or audit');}
        return result;
      };
      await open();assert.equal(writes.length, 0, 'initial render has no hidden writes');
      await transition({type: 'Engagement', id: engagement.id, label: `Activate ${engagement.code}`, sequence: 0, state: 'Active', expectedStatus: 409, code: 'COMMERCIAL_PARENT_NOT_ACTIVE'});
      await transition({type: 'Contract', id: contract.id, label: `Activate ${contract.number}`, sequence: 0, state: 'Active'});
      assert.notEqual(pin, futurePin, 'test has distinct immutable current/future versions');
      await transition({type: 'Engagement', id: futureEngagement.id, label: `Activate ${futureEngagement.code}`, sequence: 0, state: 'Active', version: futurePin, expectedStatus: 409, code: 'COMMERCIAL_INACTIVE_DATES'});
      await transition({type: 'Engagement', id: engagement.id, label: `Activate ${engagement.code}`, sequence: 0, state: 'Active'});
      const createProject = async promotion => {
        await button('New governed project').click();await page.getByLabel('Parent engagement', {exact: true}).selectOption(engagement.id);
        if (promotion) {
          await page.getByLabel('Project source', {exact: true}).selectOption('legacy');await page.getByLabel('Existing Proposed project', {exact: true}).selectOption(proposed.id);
          await page.getByLabel('I explicitly confirm promotion of this exact Proposed record into the selected Active parent.', {exact: true}).check();
        } else {
          await page.getByLabel('Code', {exact: true}).fill('SYN-LIFECYCLE-NEW');await page.getByLabel('Name', {exact: true}).fill('Synthetic new governed project');
          await page.getByLabel('Manager', {exact: true}).selectOption(ownerId);await page.getByLabel('Starts on', {exact: true}).fill('2020-01-01');await page.getByLabel('Ends on', {exact: true}).fill('2099-12-31');
          await page.getByLabel('Billable', {exact: true}).selectOption('yes');
        }
        await page.getByLabel('Commercial budget allocation', {exact: true}).fill(promotion ? '4000.0001' : '5000.0000');await page.getByLabel('Reason', {exact: true}).fill(privateReason);
        const saved = await post('/projects', () => button(promotion ? 'Promote and activate project' : 'Create and activate project').click());
        assert.equal(saved.body.projectId, promotion ? proposed.id : null);assert.equal(saved.body.engagementId, engagement.id);assert.equal(saved.result.contractVersionId, pin);
        assert.equal(saved.result.lifecycle.state, 'Active');assert.equal(saved.result.lifecycle.sequence, 1);assert.equal(saved.result.budgetAllocation, promotion ? '4000.0001' : '5000.0000');
        assert.equal(saved.result.origin, promotion ? 'explicit-legacy-promotion' : 'manual');return saved.result;
      };
      const created = await createProject(false);const promoted = await createProject(true);assert.equal(promoted.id, proposed.id);
      const bindings = (await pool.query('select project_id,engagement_id,contract_version_id,budget_allocation::text,origin,source_snapshot from commercial_project_bindings order by project_id')).rows;
      assert.equal(bindings.length, 2);assert(bindings.every(row => row.engagement_id === engagement.id && row.contract_version_id === pin));
      assert.deepEqual(bindings.find(row => row.project_id === proposed.id).source_snapshot, proposedSourceBefore, 'explicit promotion retains exact original Proposed snapshot');
      assert.deepEqual((await snapshot(pool, 'project_engagement_mappings', 'where project_id=$1', [proposed.id]))[0].value, neutralBefore, 'the separate neutral mapping is never rewritten or treated as authority');
      const beforeBudgetDenial = await stateCounts(pool);
      await button('New governed project').click();await page.getByLabel('Parent engagement', {exact: true}).selectOption(engagement.id);
      await page.getByLabel('Code', {exact: true}).fill('SYN-LIFECYCLE-OVER-BUDGET');await page.getByLabel('Name', {exact: true}).fill('Synthetic rejected budget allocation');
      await page.getByLabel('Commercial budget allocation', {exact: true}).fill('1000.0001');await page.getByLabel('Reason', {exact: true}).fill(privateReason);
      const budgetDenial = await post('/projects', () => button('Create and activate project').click(), 422);
      assert.equal(budgetDenial.result.error.code, 'COMMERCIAL_PROJECT_BUDGET_EXCEEDED');assert.deepEqual(await stateCounts(pool), beforeBudgetDenial, 'one ten-thousandth over the parent budget cannot create a project, binding, event or audit');

      // A different legitimate tab commits after this editor captured sequence1.
      // The stale browser command must roll back, not overwrite or double-append.
      await editTransition(`Put ${created.code} on hold`);
      const concurrent = await command(`${lifecyclePrefix}/Project/${created.id}/transitions`, {expectedSequence: 1, state: 'On Hold', contractVersionId: pin, reason: 'Synthetic concurrent tab hold', approvalReference: null});assert.equal(concurrent.sequence, 2);
      const beforeStale = await stateCounts(pool);const stale = await post(`/Project/${created.id}/transitions`, () => button('Confirm lifecycle transition').click(), 409);
      assert.equal(stale.body.expectedSequence, 1);assert.equal(stale.result.error.code, 'COMMERCIAL_LIFECYCLE_CONFLICT');assert.deepEqual(await stateCounts(pool), beforeStale);
      await transition({type: 'Project', id: created.id, label: `Resume ${created.code}`, sequence: 2, state: 'Active'});
      await transition({type: 'Contract', id: contract.id, label: `Put ${contract.number} on hold`, sequence: 1, state: 'On Hold', expectedStatus: 409, code: 'COMMERCIAL_ACTIVE_DEPENDENCIES'});
      await transition({type: 'Engagement', id: engagement.id, label: `Put ${engagement.code} on hold`, sequence: 1, state: 'On Hold', expectedStatus: 409, code: 'COMMERCIAL_ACTIVE_DEPENDENCIES'});
      await transition({type: 'Project', id: created.id, label: `Put ${created.code} on hold`, sequence: 3, state: 'On Hold'});
      await transition({type: 'Project', id: promoted.id, label: `Put ${promoted.code} on hold`, sequence: 1, state: 'On Hold'});
      await transition({type: 'Engagement', id: engagement.id, label: `Put ${engagement.code} on hold`, sequence: 1, state: 'On Hold'});
      await transition({type: 'Contract', id: contract.id, label: `Put ${contract.number} on hold`, sequence: 1, state: 'On Hold'});
      await transition({type: 'Project', id: created.id, label: `Resume ${created.code}`, sequence: 4, state: 'Active', expectedStatus: 409, code: 'COMMERCIAL_PARENT_NOT_ACTIVE'});
      await transition({type: 'Engagement', id: engagement.id, label: `Resume ${engagement.code}`, sequence: 2, state: 'Active', expectedStatus: 409, code: 'COMMERCIAL_PARENT_NOT_ACTIVE'});
      await transition({type: 'Contract', id: contract.id, label: `Resume ${contract.number}`, sequence: 2, state: 'Active'});
      await transition({type: 'Engagement', id: engagement.id, label: `Resume ${engagement.code}`, sequence: 2, state: 'Active'});
      await transition({type: 'Project', id: created.id, label: `Resume ${created.code}`, sequence: 4, state: 'Active'});
      await transition({type: 'Project', id: promoted.id, label: `Resume ${promoted.code}`, sequence: 2, state: 'Active'});
      const afterTransitions = await stateCounts(pool);assert.deepEqual(afterTransitions, {events: 14, bindings: 2, audit: 14});
      assert.equal(writes.length, 21, 'exactly the requested commands dispatch once; the concurrent tab command is separate from the browser');

      const beforeInspectionWrites = writes.length;
      for (const [type, entity, count] of [['Contract', contract, 3], ['Engagement', engagement, 3], ['Project', created, 5], ['Project', promoted, 3]]) {
        const label = entity.number || entity.code;
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `${lifecyclePrefix}/${type}/${entity.id}/history`);
        await button(`View history for ${label}`).click();const response = await responsePromise;assert.equal(response.status(), 200);const result = await response.json();
        assert.deepEqual(result.events.map(event => event.sequence), Array.from({length: count}, (_, index) => count - index));assert(result.events.every(event => event.contractVersionId === pin));
        await page.getByText(`Reason: ${privateReason}`, {exact: true}).first().waitFor();assert.equal(await page.locator('script').filter({hasText: 'syntheticLifecycleExecuted'}).count(), 0);
      }
      const readinessPromise = page.waitForResponse(response => new URL(response.url()).pathname === `${lifecyclePrefix}/Project/${promoted.id}/readiness`);
      await button(`Inspect closure dependencies for ${promoted.code}`).click();const readinessResponse = await readinessPromise;assert.equal(readinessResponse.status(), 200);const readiness = await readinessResponse.json();
      assert.equal(readiness.available, false);assert.equal(readiness.evidence.openAssignments, 0);assert.equal(readiness.evidence.draftSubmittedWorkLines, 0);assert.equal(readiness.evidence.ownerActive, true);
      await page.getByRole('region', {name: 'Closure dependency inspection', exact: true}).getByText('Missing evidence is unknown, never zero:', {exact: false}).waitFor();
      assert(readiness.unavailableEvidence.length > 0);assert.equal(await page.getByRole('button', {name: /^(Close|Delete|Complete) /}).count(), 0);
      assert.equal(writes.length, beforeInspectionWrites, 'history and closure dependency inspection never mutate');
      await reload();await button(`Put ${created.code} on hold`).waitFor();await button(`Put ${promoted.code} on hold`).waitFor();assert.equal(await page.evaluate(() => window.syntheticLifecycleExecuted), undefined);

      // Captured handlers cannot dispatch after a context boundary, even before
      // a replacement scope/session has completed loading and without a refresh.
      await editTransition(`Put ${created.code} on hold`);await page.evaluate(() => window.commercialLifecycleHarness.capture('old-submit'));
      const beforeInvalidation = writes.length;
      await page.evaluate(session => window.commercialLifecycleHarness.identity({...session, permissions: []}, 'focus', ['old-submit']), manager.session);
      await page.waitForFunction(() => document.querySelector('form') === null);assert.equal(writes.length, beforeInvalidation, 'revoked captured editor has no hidden mutation');
      assert(!((await page.locator('body').innerText()).includes(privateReason)), 'scope/access invalidation clears protected history and draft material');
      assert.deepEqual(await stateCounts(pool), afterTransitions);
      for (const boundary of ['scope','token']) {
        await reload();await editTransition(`Put ${created.code} on hold`);await page.evaluate(() => window.commercialLifecycleHarness.capture('old-submit'));
        if (boundary === 'scope') await page.evaluate(() => window.commercialLifecycleHarness.scope({organizationId: 'synthetic-replacement-org', legalEntityId: 'synthetic-replacement-legal'}, 'workos:organization-scope-changed', ['old-submit']));
        else await page.evaluate(() => window.commercialLifecycleHarness.token('example-replacement-session', 'focus', ['old-submit']));
        await page.getByRole('alert').getByText('Scope or access changed.', {exact: false}).waitFor();assert.equal(await page.locator('form').count(), 0);
        assert.equal(writes.length, beforeInvalidation, `${boundary} invalidates captured handlers before dispatch`);assert(!((await page.locator('body').innerText()).includes(privateReason)));
      }
      assert.deepEqual(await stateCounts(pool), afterTransitions);

      const reader = await createContext(identities.reader, ['commercial.contracts.view']);await reader.page.goto(`${baseUrl}/tests/fixtures/commercial-lifecycle.html`);
      await reader.page.getByRole('button', {name: `View history for ${contract.number}`, exact: true}).waitFor();
      assert.equal(await reader.page.getByRole('button', {name: /^(Activate |Put |Resume |New governed |Create and activate |Confirm lifecycle)/}).count(), 0, 'read-only user has no command surfaces');
      const readerHistory = reader.page.waitForResponse(response => new URL(response.url()).pathname === `${lifecyclePrefix}/Project/${created.id}/history`);await reader.page.getByRole('button', {name: `View history for ${created.code}`, exact: true}).click();assert.equal((await readerHistory).status(), 200);
      const readOnlyWrite = await apiRequest(`${lifecyclePrefix}/Project/${created.id}/transitions`, {identity: identities.reader, method: 'POST', body: {expectedSequence: 5, state: 'On Hold', contractVersionId: pin, reason: 'Synthetic reader denied', approvalReference: null}});assert.equal(readOnlyWrite.status, 403);
      const denied = await createContext(identities.denied, []);let deniedCalls = 0;denied.page.on('request', request => {if (new URL(request.url()).pathname.startsWith('/api/')) deniedCalls++;});await denied.page.goto(`${baseUrl}/tests/fixtures/commercial-lifecycle.html`);
      await denied.page.getByRole('alert').waitFor();assert.equal(deniedCalls, 0);assert(!((await denied.page.locator('body').innerText()).includes(contract.number)));assert(!((await denied.page.locator('body').innerText()).includes(privateReason)));
      for (const path of ['/workspace', `/Project/${created.id}/history`, `/Project/${created.id}/readiness`]) {
        const denial = await apiRequest(`${lifecyclePrefix}${path}`, {identity: identities.denied});assert.equal(denial.status, 403);assert(!JSON.stringify(denial.body).includes(privateReason));assert(!JSON.stringify(denial.body).includes(approvalReference));
      }
      assert.equal(writes.length, beforeInvalidation, 'read-only/denied inspection has no browser writes');assert.deepEqual(await stateCounts(pool), afterTransitions);
      const events = (await pool.query('select * from commercial_lifecycle_events order by entity_type,entity_id,sequence')).rows;
      for (const event of events) {assert.equal(event.actor_id, identities.manager.id);assert.equal(event.active_role, identities.manager.role);assert.equal(event.organization_id, scope.organizationId);assert.equal(event.legal_entity_id, scope.legalEntityId);assert.equal(event.contract_version_id, pin);assert(event.correlation_id);assert(event.operation_id);assert(event.after_value.snapshot);}
      assert.equal(events.filter(event => event.reason === privateReason).length, 13);assert.equal(events.filter(event => event.approval_reference === approvalReference).length, 11);
      const audit = await snapshot(pool, 'audit_logs', "where module='Commercial Lifecycle'");assert.equal(audit.length, 14);
      for (const protectedValue of [privateReason, approvalReference, hostile, '25000.0001', 'https://example.test/synthetic-lifecycle.pdf']) assert(!JSON.stringify(audit).includes(protectedValue), 'general audit exposes opaque lifecycle pointers, not protected material');
      assert.deepEqual(await durableEvidence(pool), beforeEvidence, 'activation, explicit promotion, holds, resume and negatives preserve immutable terms/drafts, neutral history and all existing work');
      const finalProposed = (await snapshot(pool, 'projects', 'where id=$1', [proposed.id]))[0].value;
      const omitProjection = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['status','updated_at'].includes(key)));
      assert.equal(finalProposed.id, proposedBefore.id);assert.equal(finalProposed.status, 'Active');assert.deepEqual(omitProjection(finalProposed), omitProjection(proposedBefore));
      const projected = (await pool.query('select id,status from projects where id=any($1::text[]) order by id', [[created.id,promoted.id]])).rows;assert(projected.every(project => project.status === 'Active'));
      assert(writes.every(write => write.method === 'POST' && write.path.startsWith(lifecyclePrefix)));assert(reads.every(read => read.path.startsWith(lifecyclePrefix)), 'fixture uses lifecycle production API only');
      await reader.context.close();await denied.context.close();await manager.context.close();assert.deepEqual(errors, []);assert.deepEqual(external, []);
      console.log('Commercial lifecycle real React -> API -> disposable PostgreSQL journey passed: exact current/future version pins, real parent/date/stale denials and rollback, two governed projects including same-ID explicit no-history promotion, unchanged neutral history/work, dependency-ordered hold/resume, persisted history/readiness/reload, protected audit and read-only/denied/context-invalidated privacy without hidden mutations.');
    } finally {try {if (browser) await browser.close();} finally {await fixtureServer.close();}}
  });
});
