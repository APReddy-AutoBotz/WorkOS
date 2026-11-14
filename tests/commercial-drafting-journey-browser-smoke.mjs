import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {withCommercialDraftingApi} from './support/commercial-drafting-test.mjs';

// Hosted CI only: this is the actual React -> HTTP API -> disposable PostgreSQL
// acceptance journey. There are no request routes, fetch mocks or fake services.
// Required browser/database absence fails rather than being represented as a pass.
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
const hostile = '<script>window.syntheticCommercialExecuted=true</script>';
const prefix = '/api/v1/commercial-drafting';
const expectedFields = {
  contract: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','number','clientId','reason'],
  engagement: ['code','name','model','ownerId','startsOn','endsOn','currency','budget','contractId','contractVersionId','clientId','attributionId','reason'],
  po: ['contractId','contractVersionId','number','value','currency','startsOn','endsOn','warningThresholdPercent','reason'],
  milestone: ['engagementId','code','name','dueOn','amount','currency','reason'],
  revision: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','expectedVersion','reason'],
};
const legacyState = async pool => {
  const output = {};
  for (const table of ['projects','project_allocations','timesheets','timesheet_entries','approval_records','project_engagement_mappings']) {
    const order = table === 'project_engagement_mappings' ? 'project_id' : 'id::text';
    output[table] = (await pool.query(`select to_jsonb(t) value from ${table} t order by ${order}`)).rows;
  }
  return output;
};
await withCommercialDraftingApi(async ({pool, baseUrl: apiUrl, tokenFor, identities, actorId, scope, ownerId, clientId, request: apiRequest}) => {
  const beforeLegacy = await legacyState(pool);
  const vite = await createServer({root, mode: 'production', server: {host: '127.0.0.1', port: 0, strictPort: false, hmr: false, proxy: {'/api': {target: apiUrl, changeOrigin: true}}}});
  let browser;
  try {
    await vite.listen();
    const address = vite.httpServer.address();assert(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({headless: true, ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {})});
    const errors = [], external = [], writes = [];
    const createContext = async (identity, permissions) => {
      const context = await browser.newContext({viewport: {width: 1100, height: 900}});
      await context.addInitScript(({identity, permissions, scope, signedToken, ownerId}) => {
        sessionStorage.setItem('workos_session', JSON.stringify({id: identity.id, employeeId: ownerId, name: 'Synthetic Commercial Journey Operator', role: identity.role, permissionRole: identity.role, permissions}));
        sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
        sessionStorage.setItem('workos_api_token', signedToken);
      }, {identity, permissions, scope, signedToken: tokenFor(identity), ownerId});
      const page = await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) external.push(request.url());
        if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push({path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON()});
      });
      return {context, page};
    };
    const {context, page} = await createContext(identities.manager, ['commercial.contracts.view','commercial.contracts.manage']);
    const button = name => page.getByRole('button', {name, exact: true});
    const form = name => page.getByRole('form', {name, exact: true});
    const fill = async (target, fields) => {for (const [label, value] of Object.entries(fields)) await target.getByLabel(label, {exact: true}).fill(value);};
    const ready = () => page.getByRole('region', {name: 'Contracts and SOWs', exact: true}).waitFor();
    const open = async () => {await page.goto(`${baseUrl}/tests/fixtures/commercial-drafting.html?live=1`);await ready();};
    const save = async (path, kind, name = 'Save draft') => {
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}${path}` && response.request().method() === 'POST');
      await button(name).click();const response = await responsePromise;assert.equal(response.status(), 201, `${kind} is persisted by the real API`);
      const body = response.request().postDataJSON();assert.deepEqual(Object.keys(body).sort(), expectedFields[kind].sort(), `${kind} exact production command fields`);
      const result = await response.json();await page.getByText('Draft saved. Server records refreshed.', {exact: true}).waitFor();await ready();return {body, result};
    };
    await open();await page.getByText('Legacy projects mapped: 1 of 1.', {exact: false}).waitFor();
    await button('New contract / SOW').click();let target = form('New contract / SOW');
    await fill(target, {'Contract / SOW number': 'SYN-JOURNEY-CONTRACT', 'Contract name': `Synthetic browser terms ${hostile}`, 'Starts on': '2020-01-01', 'Ends on': '2099-12-31', 'Terms effective from': '2020-01-01', 'Currency (ISO code)': 'GBP', 'Contract value (decimal)': '12345.6789', 'Billing terms': `Synthetic browser billing terms ${hostile}`, 'Reason for creation / revision': 'Synthetic browser contract creation'});
    await target.getByLabel('Client', {exact: true}).selectOption(clientId);await target.getByLabel('Commercial model', {exact: true}).selectOption('fixed_fee');
    await button('Add document link').click();await fill(target, {'Document 1 name': `Synthetic safe SOW ${hostile}`, 'Document 1 URL': 'https://example.test/synthetic-browser-sow.pdf'});
    const contract = await save('/contracts', 'contract');const contractId = contract.result.id;const versionId = contract.result.versions[0].id;
    assert.equal(contract.body.value, '12345.6789');assert.equal(contract.result.versions[0].value, '12345.6789');
    assert.equal(await page.locator('form').count(), 0);assert.equal(await page.getByRole('region', {name: 'Contract version history'}).locator('script,img').count(), 0);
    const chooseContract = async target => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/contracts/${contractId}` && response.request().method() === 'GET');
      await target.getByLabel('Contract / SOW', {exact: true}).selectOption(contractId);assert.equal((await response).status(), 200);
      await page.getByRole('region', {name: 'Contract version history'}).getByRole('heading', {name: 'SYN-JOURNEY-CONTRACT', exact: true}).waitFor();
      assert.equal(await target.getByLabel('Pinned contract version', {exact: true}).inputValue(), versionId);
    };
    await button('New engagement').click();target = form('New engagement');await target.getByLabel('Commercial model', {exact: true}).selectOption('fixed_fee');await chooseContract(target);
    await target.getByLabel('Engagement owner', {exact: true}).selectOption(ownerId);await fill(target, {'Engagement code': 'SYN-JOURNEY-ENGAGEMENT', 'Engagement name': 'Synthetic browser delivery', 'Budget (decimal)': '5000.0001', 'Reason for creation / revision': 'Synthetic browser engagement creation'});
    const engagement = await save('/engagements', 'engagement');assert.equal(engagement.body.contractVersionId, versionId);assert.equal(engagement.result.billable, true);assert.equal(engagement.result.status, 'Draft');
    await button('New purchase order').click();target = form('New purchase order');await chooseContract(target);await fill(target, {'Purchase order number': 'SYN-JOURNEY-PO', 'Purchase order value (decimal)': '7500.4500', 'Warning threshold percent (0–100)': '75.25', 'Reason for creation / revision': 'Synthetic browser purchase order creation'});
    const po = await save('/purchase-orders', 'po');assert.equal(po.result.value, '7500.4500');assert.equal(po.result.contractVersionId, versionId);
    await button('New draft milestone').click();target = form('New draft milestone');await target.getByLabel('Engagement', {exact: true}).selectOption(engagement.result.id);await fill(target, {'Milestone code': 'SYN-JOURNEY-MILESTONE', 'Milestone name': 'Synthetic browser draft milestone', 'Due on': future, 'Milestone amount (decimal)': '100.0001', 'Reason for creation / revision': 'Synthetic browser milestone creation'});
    const milestone = await save('/milestones', 'milestone');assert.equal(milestone.result.billingEligible, false);assert.equal(milestone.result.status, 'Draft');
    const history = page.getByRole('region', {name: 'Contract version history'});
    const inspectResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/contracts/${contractId}` && response.request().method() === 'GET');
    await button('Inspect SYN-JOURNEY-CONTRACT').click();assert.equal((await inspectResponse).status(), 200);await button('Append effective revision').click();target = form('Append revision to SYN-JOURNEY-CONTRACT');
    await fill(target, {'Contract name': 'Synthetic browser future terms', 'Terms effective from': future, 'Contract value (decimal)': '13579.2468', 'Reason for creation / revision': 'Synthetic browser future-effective revision'});
    const revision = await save(`/contracts/${contractId}/versions`, 'revision', 'Append contract revision');assert.equal(revision.body.expectedVersion, 1);assert.equal(revision.result.latestVersion, 2);
    assert.equal(revision.result.versions.length, 2);assert.equal(revision.result.versions.find(version => version.version === 1).value, '12345.6789');
    await history.getByRole('heading', {name: /^Version 2/}).waitFor();await history.getByRole('heading', {name: /^Version 1/}).waitFor();
    assert((await page.getByRole('region', {name: 'Contracts and SOWs'}).innerText()).includes('Currently effective version 1: GBP 12345.6789.'));
    assert.equal(await page.evaluate(() => window.syntheticCommercialExecuted), undefined);assert.equal(await history.locator('script,img').count(), 0);
    await page.reload();await ready();await page.getByRole('heading', {name: 'SYN-JOURNEY-PO · Draft', exact: true}).waitFor();await page.getByText('Draft, not accepted, not billing eligible.', {exact: false}).waitFor();
    assert.equal(await page.getByRole('heading', {name: /^SYN-JOURNEY-ENGAGEMENT/}).count(), 1);assert.equal(await page.getByRole('heading', {name: /^SYN-JOURNEY-MILESTONE/}).count(), 1);

    const contracts = (await pool.query('select * from commercial_contracts where id=$1', [contractId])).rows;
    assert.equal(contracts.length, 1);assert.equal(contracts[0].latest_version, 2);assert.equal(contracts[0].organization_id, scope.organizationId);assert.equal(contracts[0].legal_entity_id, scope.legalEntityId);assert.equal(contracts[0].created_by, actorId);
    const versions = (await pool.query('select id,version,value::text,effective_from::text from commercial_contract_versions where contract_id=$1 order by version', [contractId])).rows;
    assert.deepEqual(versions.map(({version,value}) => ({version,value})), [{version: 1, value: '12345.6789'}, {version: 2, value: '13579.2468'}]);assert.equal(versions[1].effective_from, future);
    const persistedEngagement = (await pool.query('select contract_version_id,budget::text,status,created_by from commercial_engagements where id=$1', [engagement.result.id])).rows[0];
    assert.deepEqual(persistedEngagement, {contract_version_id: versionId, budget: '5000.0001', status: 'Draft', created_by: actorId});
    const persistedPo = (await pool.query('select contract_version_id,value::text,status,created_by from commercial_purchase_orders where id=$1', [po.result.id])).rows[0];
    assert.deepEqual(persistedPo, {contract_version_id: versionId, value: '7500.4500', status: 'Draft', created_by: actorId});
    const persistedMilestone = (await pool.query('select engagement_id,amount::text,status,created_by from commercial_milestones where id=$1', [milestone.result.id])).rows[0];
    assert.deepEqual(persistedMilestone, {engagement_id: engagement.result.id, amount: '100.0001', status: 'Draft', created_by: actorId});
    const events = (await pool.query("select * from commercial_draft_events where source='Web' order by created_at,id")).rows;assert.equal(events.length, 5);
    const migrationEvents = (await pool.query("select * from commercial_draft_events where source='Migration'")).rows;assert.equal(migrationEvents.length, 1);assert.equal(migrationEvents[0].actor_id, null);assert.equal(migrationEvents[0].active_role, 'system');assert.equal(migrationEvents[0].system_identity, 'migration:040_wos04_commercial_drafting_foundation');assert.equal(migrationEvents[0].after_value.engagement.origin, 'legacy-neutral');
    for (const event of events) {
      assert.equal(event.actor_id, actorId);assert.equal(event.active_role, identities.manager.role);assert.equal(event.source, 'Web');assert.equal(event.organization_id, scope.organizationId);assert.equal(event.legal_entity_id, scope.legalEntityId);assert(event.reason.startsWith('Synthetic browser'));assert(event.correlation_id);assert(event.operation_id);assert(event.after_value);
    }
    const append = events.find(event => event.action === 'Append Version');assert(append);assert.equal(append.before_value.latestVersion, 1);assert.equal(append.after_value.latestVersion, 2);assert.equal(append.before_value.versions[0].id, versionId);
    assert.equal(events.find(event => event.entity_type === 'Milestone').after_value.billingEligible, false);
    const audit = (await pool.query("select old_value,new_value,reason,details from audit_logs where module='Commercial Drafting'")).rows;assert.equal(audit.length, 5);assert(!JSON.stringify(audit).includes(hostile));assert(!JSON.stringify(audit).includes('https://example.test/synthetic-browser-sow.pdf'));
    assert.deepEqual(await legacyState(pool), beforeLegacy, 'drafting/revision leaves all legacy projects, allocations, work evidence, approvals and neutral mappings unchanged');
    const result = await apiRequest('/workspace');assert.equal(result.status, 200);assert.equal(result.body.milestones[0].billingEligible, false);assert.equal(result.body.purchaseOrders[0].contractVersionId, versionId);assert.equal(result.body.engagements[0].contractVersionId, versionId);
    assert.equal(result.body.contracts[0].currentTerms.id, versionId, 'future terms never replace current terms or old pinned drafts');
    const writeCount = writes.length;assert.equal(writeCount, 5);assert(writes.every(write => write.method === 'POST' && write.path.startsWith(prefix)));
    const reader = await createContext(identities.reader, ['commercial.contracts.view']);await reader.page.goto(`${baseUrl}/tests/fixtures/commercial-drafting.html?live=1`);await reader.page.getByText('Read-only commercial access.', {exact: false}).waitFor();assert.equal(await reader.page.getByRole('button', {name: /^New /}).count(), 0);assert.equal(writes.length, writeCount);
    const denied = await createContext(identities.denied, []);let deniedApiCalls = 0;denied.page.on('request', request => {if (new URL(request.url()).pathname.startsWith('/api/')) deniedApiCalls++;});await denied.page.goto(`${baseUrl}/tests/fixtures/commercial-drafting.html?live=1`);await denied.page.getByRole('alert').getByText('Scope or access changed.', {exact: false}).waitFor();assert.equal(deniedApiCalls, 0);assert.equal(writes.length, writeCount);
    await reader.context.close();await denied.context.close();await context.close();assert.deepEqual(errors, []);assert.deepEqual(external, []);
    console.log('Commercial drafting real React -> API -> disposable PostgreSQL journey passed: exact commands, persisted contract/engagement/PO/milestone, immutable future revision and pinned old terms, protected full audit/general redaction, reload persistence, unchanged legacy work, read-only and no-access behavior.');
  } finally {try {if (browser) await browser.close();} finally {await vite.close();}}
}, {upgrade: true});
