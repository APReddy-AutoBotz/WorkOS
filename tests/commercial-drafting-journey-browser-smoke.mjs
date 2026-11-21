import {verifyRecoveredCredit} from './support/retainer-credit-recovery.mjs';
import {INVOICE_EXPORT_EVENT_KEYS} from '../shared/invoice-export-notification.mjs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
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
  managed: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','serviceDimensions','number','clientId','reason'],
  retainer: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','retainerPeriods','retainerCapacityPolicy','retainerOveragePolicy','retainerRounding','number','clientId','reason'],
  contract: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','installments','number','clientId','reason'],
  engagement: ['code','name','model','ownerId','startsOn','endsOn','currency','budget','contractId','contractVersionId','clientId','attributionId','reason'],
  po: ['contractId','contractVersionId','number','value','currency','startsOn','endsOn','warningThresholdPercent','reason'],
  milestone: ['engagementId','code','name','dueOn','amount','currency','reason'],
  revision: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','installments','expectedVersion','reason'],
};
const legacyState = async pool => {
  const output = {};
  for (const table of ['projects','project_allocations','timesheets','timesheet_entries','approval_records','project_engagement_mappings']) {
    const order = table === 'project_engagement_mappings' ? 'project_id' : 'id::text';
    output[table] = (await pool.query(`select to_jsonb(t) value from ${table} t order by ${order}`)).rows;
  }
  return output;
};
const verifyCommercialDrafting = async reversalScenario => {
  let recoveryEvidence;
  await withCommercialDraftingApi(async ({pool, baseUrl: apiUrl, tokenFor, identities, actorId, scope, ownerId, clientId, request: apiRequest}) => {
  const beforeLegacy = await legacyState(pool);
  const fixtureServer = await startFixtureServer({root, fixtures: ['commercial-drafting'], apiUrl});
  let browser;
  try {
    const baseUrl = fixtureServer.url;
    browser = await chromium.launch({headless: true, ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {})});
    const errors = [], external = [], writes = [];
    const createContext = async (identity, permissions) => {
      const context = await browser.newContext({viewport: {width: 1100, height: 900}});
      const linkedWorker=(await pool.query('select employee_record_id from users where id=$1',[identity.id])).rows[0].employee_record_id;
      await context.addInitScript(({identity, permissions, scope, signedToken, ownerId,linkedWorker}) => {
        sessionStorage.setItem('workos_session', JSON.stringify({id: linkedWorker || identity.id, userName:identity.username, employeeId: ownerId, name: 'Synthetic Commercial Journey Operator', role: identity.role, permissionRole: identity.role, permissions}));
        sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
        sessionStorage.setItem('workos_api_token', signedToken);
      }, {identity, permissions, scope, signedToken: tokenFor(identity), ownerId,linkedWorker});
      const page = await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) external.push(request.url());
        if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push({path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON()});
      });
      return {context, page};
    };
    const {context, page} = await createContext(identities.manager, ['commercial.contracts.view','commercial.contracts.manage','employees.view','reports.view_utilization','commercial.rate_candidates.view','commercial.retainer_statements.prepare','commercial.service_units.capture']);
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
    await button('Add installment').click();
    await fill(target, {'Installment 1 due date':new Date().toISOString().slice(0,10), 'Installment 1 amount':'12000'});
    await button('Add installment').click();
    await fill(target, {'Installment 2 due date':'2099-02-01', 'Installment 2 amount':'345.6789'});
    await button('Add document link').click();await fill(target, {'Document 1 name': `Synthetic safe SOW ${hostile}`, 'Document 1 URL': 'https://example.test/synthetic-browser-sow.pdf'});
    const contract = await save('/contracts', 'contract');const contractId = contract.result.id;const versionId = contract.result.versions[0].id;
    await page.getByText('2099-02-01 · GBP 345.6789', {exact:true}).waitFor();
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
    assert.equal(await target.getByLabel('Installment 2 amount').inputValue(), '345.6789');
    await fill(target, {'Installment 2 amount':'1579.2468'});
    const revision = await save(`/contracts/${contractId}/versions`, 'revision', 'Append contract revision');assert.equal(revision.body.expectedVersion, 1);assert.equal(revision.result.latestVersion, 2);
    assert.equal(revision.result.versions.length, 2);assert.equal(revision.result.versions.find(version => version.version === 1).value, '12345.6789');
    await history.getByRole('heading', {name: /^Version 2/}).waitFor();await history.getByRole('heading', {name: /^Version 1/}).waitFor();
    assert((await page.getByRole('region', {name: 'Contracts and SOWs'}).innerText()).includes('Currently effective version 1: GBP 12345.6789.'));
    assert.equal(await page.evaluate(() => window.syntheticCommercialExecuted), undefined);assert.equal(await history.locator('script,img').count(), 0);
    await page.reload();await ready();await page.getByRole('heading', {name: 'SYN-JOURNEY-PO', exact: true}).waitFor();await page.getByText('Draft, not accepted, not billing eligible.', {exact: false}).waitFor();
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
    const releasePath='/purchase-orders/'+po.result.id+'/release';
    const releaseCommand={contractVersionId:versionId,approvalReference:'SYN-PO-AUTH-001',reason:'Verified signed purchase order'};
    const postRelease=(identity,body=releaseCommand)=>apiRequest(releasePath,{method:'POST',identity,body});
    assert.equal((await postRelease(identities.reader)).status,403);
    for (const [role,key] of [['Admin','commercial.lifecycle.manage'],['Admin','commercial.purchase_orders.release'],
      ['Employee','commercial.contracts.manage'],['Employee','commercial.purchase_orders.release']])
      await pool.query('insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true',[role,key]);
    assert.equal((await postRelease(identities.manager)).status,403);
    assert.equal((await postRelease(identities.reader)).status,409);
    const active=await apiRequest('/lifecycle/Contract/'+contractId+'/transitions',{method:'POST',
      body:{expectedSequence:0,state:'Active',contractVersionId:versionId,reason:'Synthetic contract activation',approvalReference:null}});
    assert.equal(active.status,201,JSON.stringify(active.body));
    assert.equal((await postRelease(identities.reader,{...releaseCommand,value:'1.00'})).status,400);
    const missingScope=await apiRequest(releasePath,{identity:identities.reader,headers:{'x-legal-entity-id':'other-synthetic-entity'}});
    assert.equal(missingScope.status,403);
    await pool.query("create function reject_test_po_audit() returns trigger language plpgsql as $$begin raise exception 'Synthetic rollback probe'; end $$");
    await pool.query("create trigger reject_test_po_audit before insert on audit_logs for each row when(new.action='Release') execute function reject_test_po_audit()");
    assert.equal((await postRelease(identities.reader)).status,503);
    assert.equal((await apiRequest(releasePath)).body.release,null);
    await pool.query('drop trigger reject_test_po_audit on audit_logs');
    const reviewer=await createContext(identities.reader,['commercial.contracts.view','commercial.contracts.manage','commercial.purchase_orders.release']);
    await reviewer.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    await reviewer.page.getByRole('button',{name:'Inspect release'}).click();
    await reviewer.page.getByText('Awaiting release').waitFor();
    await reviewer.page.getByLabel('Approval reference',{exact:true}).fill(releaseCommand.approvalReference);
    await reviewer.page.getByLabel('Release reason',{exact:true}).fill(releaseCommand.reason);
    const releasing=reviewer.page.waitForResponse(r=>r.url().endsWith(releasePath) && r.request().method()==='POST');
    await reviewer.page.getByRole('button',{name:'Release purchase order',exact:true}).click();
    const released=await releasing;
    assert.equal(released.status(),201,await released.text());
    await reviewer.page.getByText(/Released .*SYN-PO-AUTH-001/).waitFor();
    await reviewer.page.getByText(/Committed 0 .*Gross consumed 0 .*Available 7500.4500/).waitFor();
    const receipt=await apiRequest(releasePath);
    assert.equal(receipt.body.release.actorId,identities.reader.id);
    assert.deepEqual((await postRelease(identities.reader)).body,receipt.body);
    assert.equal((await postRelease(identities.reader,{...releaseCommand,reason:'Changed instructions'})).status,409);
    assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_id=$1 and action='Release'",[po.result.id])).rows[0].n,1);
    const grant='commercial.fixed_fee_eligibility.issue';
    const path='/fixed-fee-schedules/'+versionId+'/register';
    const command={installment:1,engagementId:engagement.result.id,reason:'Reviewed contractually due installment'};
    const issue=(identity,body=command)=>apiRequest(path,{identity,method:'POST',body});
    assert.equal((await issue(identities.reader)).status,403);
    for(const role of ['Employee','Admin']) await pool.query(
      'insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true',[role,grant]);
    assert.equal((await issue(identities.reader)).status,409);
    const activation=await apiRequest('/lifecycle/Engagement/'+engagement.result.id+'/transitions',{method:'POST',
      body:{expectedSequence:0,state:'Active',contractVersionId:versionId,reason:'Synthetic engagement activation',approvalReference:null}});
    assert.equal(activation.status,201,JSON.stringify(activation.body));
    assert.equal((await issue(identities.reader,{...command,installment:2})).status,409);
    const today=new Date().toISOString().slice(0,10);
    const unavailablePeriod=await issue(identities.reader);
    assert.equal(unavailablePeriod.body.error.code,'INSTALLMENT_PERIOD_CLOSED');
    await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
      values('syn-fixed-period',$1,$2,'SYN-FIXED','Synthetic approval period',$3,$3,'Open','Weekly')`,[scope.organizationId,scope.legalEntityId,today]);
    assert.equal((await issue(identities.manager)).status,403);
    assert.equal((await issue(identities.reader,{...command,amount:'0.01'})).status,400);
    const billing=await createContext(identities.reader,['commercial.contracts.view','commercial.contracts.manage',grant]);
    await billing.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    await billing.page.getByRole('button',{name:'Inspect SYN-JOURNEY-CONTRACT',exact:true}).click();
    const schedule=billing.page.getByRole('listitem').filter({has:billing.page.getByRole('heading',{name:/^Version 1 ·/})})
      .getByRole('group',{name:'Fixed-fee billing eligibility'});
    await schedule.getByRole('button',{name:'Inspect installment register'}).click();
    await schedule.getByLabel('Scheduled installment').selectOption('1');
    await schedule.getByLabel('Billing engagement').selectOption(command.engagementId);
    await schedule.getByLabel('Installment approval reason').fill(command.reason);
    const saving=billing.page.waitForResponse(r=>r.url().endsWith(path) && r.request().method()==='POST');
    await schedule.getByRole('button',{name:'Approve due installment'}).click();
    const saved=await saving;assert.equal(saved.status(),201,await saved.text());
    await schedule.getByText(/Installment 1 · GBP 12000.0000 · Approved/).waitFor();
    const registered=(await saved.json()).receipts[0];
    assert.equal((await issue(identities.reader)).body.receipts[0].itemId,registered.itemId);
    assert.equal((await issue(identities.reader,{...command,reason:'Changed reason'})).status,409);
    assert.equal((await apiRequest(path,{identity:identities.reader,headers:{'x-legal-entity-id':'other-synthetic-entity'}})).status,403);
    const totals=(await pool.query(`select (select count(*) from approved_unbilled_items where event_id=$1::uuid)::int items,
      (select count(*) from audit_logs where entity_id=$1::text and action='Approve Installment')::int audits,
      (select count(*) from invoice_draft_lines where event_id=$1::uuid)::int invoice_lines`,[registered.eventId])).rows[0];
    assert.deepEqual(totals,{items:1,audits:1,invoice_lines:0});
    const reconciles=async schedule=>(await pool.query(
      'select fixed_fee_schedule_preserves_issued($1,$2,$3,$4::jsonb) compatible',
      [scope.organizationId,scope.legalEntityId,contractId,JSON.stringify(schedule)])).rows[0].compatible;
    const first={dueOn:today,amount:'12000.0000'};
    assert.equal(await reconciles([first,{dueOn:future,amount:'2000'}]),true);
    assert.equal(await reconciles([{...first,amount:'11999.9999'}]),false);
    assert.equal(await reconciles([{...first,dueOn:future},first]),false);
    assert.equal(await reconciles([]),false);
    const draftGrants=['commercial.contracts.view','commercial.tm_billing.view','commercial.invoice_drafts.view',
      'employees.view','notifications.view','commercial.invoice_drafts.prepare','commercial.invoice_drafts.own','commercial.invoice_drafts.cancel'];
    for(const key of draftGrants) await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled) values('Employee',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[key]);
    const preparing=await createContext(identities.reader,[...draftGrants,grant]);
    const draftPage=preparing.page;
    await draftPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const desk=draftPage.getByRole('region',{name:'Invoice-ready draft batches'});
    const loadDrafts=()=>desk.getByRole('button',{name:'Load drafts and available items'}).click();
    await loadDrafts();
    await desk.getByLabel('Invoice engagement').selectOption(engagement.result.id);
    await desk.getByLabel('Invoice period start').fill(today);
    await desk.getByLabel('Invoice period end').fill(today);
    await desk.getByLabel('Invoice period basis').selectOption('ELIGIBLE_DATE');
    await desk.getByLabel('Invoice owner user ID').fill(identities.reader.id);
    await desk.getByLabel('Invoice owner role').fill('Employee');
    await desk.getByLabel('Invoice draft reason').fill('Prepare the approved installment');
    await desk.getByRole('checkbox',{name:'Confirm the displayed client, contract and currency'}).check();
    const post=(suffix)=>draftPage.waitForResponse(r=>r.url().endsWith('/api/v1/invoice-drafts/'+suffix) && r.request().method()==='POST');
    const creating=post('batches');
    await desk.getByRole('button',{name:'Create invoice Draft'}).click();
    const created=await creating;assert.equal(created.status(),201,await created.text());
    const fixedBatch=(await created.json()).batch.id;
    const inspectFixed=async()=>{
      await loadDrafts();
      await desk.getByLabel('Invoice draft',{exact:true}).selectOption(fixedBatch);
      await desk.getByRole('button',{name:'Inspect invoice draft'}).click();
    };
    await inspectFixed();
    await desk.getByLabel('Available invoice item').selectOption('fixed:'+registered.itemId);
    await desk.getByLabel('Invoice item reason').fill('Reserve the exact approved installment');
    const reserving=post('batches/'+fixedBatch+'/lines');
    await desk.getByRole('button',{name:'Reserve selected whole item'}).click();
    const reserved=await reserving;assert.equal(reserved.status(),201,await reserved.text());
    const fixedLine=(await reserved.json()).line;
    assert.deepEqual([fixedLine.eventId,fixedLine.itemId,fixedLine.amount,fixedLine.snapshotId],
      [registered.eventId,registered.itemId,'12000.0000',null]);
    const linePath='/api/v1/invoice-drafts/batches/'+fixedBatch+'/lines';
    const original=reserved.request().postDataJSON();
    const replay=await apiRequest(linePath,{method:'POST',identity:identities.reader,body:original});
    assert.equal(replay.body.replayed,true,JSON.stringify(replay.body));
    const double=await apiRequest(linePath,{method:'POST',identity:identities.reader,
      body:{...original,expectedLineCount:1,requestId:crypto.randomUUID()}});
    assert.equal(double.status,409);
    const actorPermissions=['commercial.tm_billing.view','commercial.invoice_drafts.view','employees.view','notifications.view'];
    for(const key of actorPermissions) await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[key]);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1",[grant]);
    const hidden=await apiRequest('/api/v1/invoice-drafts/batches/'+fixedBatch);
    assert.equal(hidden.status,403);
    const listing=await apiRequest('/api/v1/invoice-drafts/batches');
    assert.equal(listing.status,200);assert.ok(!listing.body.batches.some(b=>b.id===fixedBatch));
    await inspectFixed();
    await desk.getByText(/Retained lines 1/).waitFor();
    await desk.getByLabel('Cancellation reason').fill('Release the installment for rebatching');
    const cancelling=post('batches/'+fixedBatch+'/cancellations');
    await desk.getByRole('button',{name:/Cancel .*draft/i}).click();
    const cancelled=await cancelling;assert.equal(cancelled.status(),201,await cancelled.text());
    assert.equal((await pool.query('select 1 from invoice_draft_occupancies where item_id=$1',[registered.itemId])).rowCount,0);
    assert.equal((await pool.query('select 1 from invoice_draft_lines where id=$1 and event_id=$2',[fixedLine.id,registered.eventId])).rowCount,1);
    await open();
    await button('New contract / SOW').click();
    target = form('New contract / SOW');
    await fill(target, {'Contract / SOW number':'SYN-RETAINER-PERIOD','Contract name':'Synthetic retainer',
      'Starts on':'2020-01-01','Ends on':'2099-12-31','Terms effective from':'2020-01-01',
      'Currency (ISO code)':'GBP','Contract value (decimal)':'7000','Billing terms':'Synthetic service period',
      'Reason for creation / revision':'Synthetic retainer capacity'});
    await target.getByLabel('Client',{exact:true}).selectOption(clientId);
    await target.getByLabel('Commercial model',{exact:true}).selectOption('retainer');
    await target.getByLabel('Capacity consumption and unused hours').selectOption('all_rollover');
    await target.getByLabel('Period price rounding').selectOption('HALF_EVEN:2');
    await target.getByLabel('Excess-hour pricing').selectOption('no_charge');
    await button('Add retainer period').click();
    await fill(target, {'Period 1 start date':'2020-01-01','Period 1 end date':'2020-12-31',
      'Period 1 included hours':'40.1250','Period 1 base fee':'3500.0001'});
    const savedRetainer = await save('/contracts','retainer');
    assert.deepEqual(savedRetainer.result.versions[0].retainerPeriods,[
      {startsOn:'2020-01-01',endsOn:'2020-12-31',includedHours:'40.1250',baseFee:'3500.0001'}]);
    await page.getByText('2020-01-01 through 2020-12-31 · 40.1250 included hours · GBP 3500.0001 base fee',{exact:true}).waitFor();
    await page.getByText('All approved hours · carry unused hours to the next service period',{exact:true}).waitFor();
    const consumptionPath=`/contracts/${savedRetainer.result.id}/versions/${savedRetainer.result.versions[0].id}/retainer-consumption`;
    for (const key of ['employees.view','reports.view_utilization','commercial.rate_candidates.view','commercial.retainer_statements.prepare']) await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[key]);
    await button('Inspect approved retainer hours').click();
    await page.getByText('2020-01-01 through 2020-12-31 · 0 billable hours · 0 non-billable hours',{exact:true}).waitFor();
    await page.getByText(/0 remaining · 0 over capacity/).waitFor();
    await button('Preview excess-hour pricing').click();
    await page.getByText(/0 excess hours · No charge under this contract/).waitFor();
    await page.getByText('Period price preview · GBP 3500.00 · base fee 3500.00 · overage 0.00',{exact:true}).waitFor();
    await button('Review period statement').click();
    await page.getByRole('heading',{name:'Current period evidence'}).waitFor();
    const reviewRole='HR', finance={...identities.reader,role:reviewRole},alias={...identities.denied,role:reviewRole};
    const reviewGrants=['commercial.contracts.view','employees.view','reports.view_utilization','commercial.rate_candidates.view','commercial.retainer_statements.decide'];
    await pool.query("insert into roles(name) values($1) on conflict do nothing",[reviewRole]);
    for (const identity of [finance,alias]) await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name=$2 on conflict do nothing",[identity.id,reviewRole]);
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('syn-retainer-reviewer','SYN-RETAINER-REVIEWER','Synthetic reviewer','reviewer-retainer@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)`,[scope.organizationId,scope.legalEntityId]);
    await pool.query("update users set employee_record_id=$1 where id=$2",[ownerId,identities.manager.id]);
    await pool.query("update users set employee_record_id='syn-retainer-reviewer' where id=$1",[finance.id]);
    for (const role of [reviewRole,'Admin']) await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
      select $1,k,true from unnest($2::text[]) k on conflict(role_name,permission_key) do update set enabled=true`,[role,reviewGrants]);
    const scopedStatementPath=consumptionPath.replace('retainer-consumption','retainer-statements/2020-01-01');
    const candidate=(await apiRequest(scopedStatementPath)).body;
    await pool.query(`create function reject_test_statement_audit() returns trigger language plpgsql as $$
      begin if new.entity_type='Retainer Statement' then raise exception 'Synthetic audit unavailable'; end if; return new; end $$;
      create trigger reject_test_statement_audit before insert on audit_logs for each row execute function reject_test_statement_audit()`);
    try {
      assert.equal((await apiRequest(scopedStatementPath,{method:'POST',body:{sourceHash:candidate.sourceHash,previousId:null,reason:'Synthetic audit rollback'}})).status,503);
      assert.equal((await pool.query('select 1 from commercial_retainer_statements where version_id=$1',[savedRetainer.result.versions[0].id])).rowCount,0);
    } finally {await pool.query('drop trigger reject_test_statement_audit on audit_logs');}
    await page.getByLabel('Statement reason').fill('Synthetic closed period reconciliation');
    await button('Prepare statement').click();
    await page.getByText('Statement prepared. Reload to inspect the saved evidence.').waitFor();
    await button('Review period statement').click();
    await button('Inspect statement 1').click();
    await page.getByRole('heading',{name:'Saved statement 1'}).waitFor();
    const statementPath=scopedStatementPath;
    const reviewed=(await apiRequest(statementPath)).body;
    const statementRecord=reviewed.history[0];
    const cmd={sourceHash:statementRecord.sourceHash,previousId:null,reason:statementRecord.reason};
    assert.equal((await apiRequest(statementPath,{method:'POST',body:cmd})).body.record.id,statementRecord.id);
    assert.equal((await apiRequest(statementPath,{method:'POST',body:{...cmd,sourceHash:'0'.repeat(64)}})).status,409);
    assert.equal((await apiRequest(statementPath,{method:'POST',body:{...cmd,total:'999'}})).status,400);
    assert.equal((await apiRequest(statementPath+'?statementId='+statementRecord.id,{identity:identities.reader})).status,403);
    assert.equal((await apiRequest(statementPath.replace('2020-01-01','2099-01-01'))).status,409);
    await assert.rejects(pool.query('update commercial_retainer_statements set reason=$1 where id=$2',['Synthetic rewrite',statementRecord.id]));
    assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Retainer Statement' and entity_id=$1",[statementRecord.id])).rows[0].n,1);
    const reviewPath=statementPath+'/review', review=(record,decision,identity=finance)=>apiRequest(reviewPath,{method:'POST',identity,
      body:{statementId:record.id,sourceHash:record.sourceHash,decision,reason:'Synthetic independent review'}});
    assert.equal((await review(statementRecord,'Approved',identities.manager)).status,403);
    assert.equal((await review(statementRecord,'Approved',alias)).status,403);
    await pool.query("update users set employee_record_id=null where id=$1",[actorId]);
    await pool.query("update users set employee_record_id=$1 where id=$2",[ownerId,alias.id]);
    assert.equal((await review(statementRecord,'Approved',alias)).status,403,'a reassigned preparer identity cannot review the original statement');
    await pool.query("update users set employee_record_id=null where id=$1",[alias.id]);
    await pool.query("update users set employee_record_id=$1 where id=$2",[ownerId,actorId]);
    assert.equal((await review(statementRecord,'Approved')).status,403,'a restored worker link must invalidate the old preparer identity');
    const reprepare=async prior=>{
      const res=await apiRequest(statementPath,{method:'POST',body:{sourceHash:prior.sourceHash,previousId:prior.id,reason:'Synthetic renewed preparation'}});
      assert.equal(res.status,201,JSON.stringify(res.body));return res.body.record;
    };
    const second=await reprepare(statementRecord);
    assert.equal((await review(statementRecord,'Approved')).status,409,'superseded statements cannot be approved');
    await pool.query("update users set employee_record_id=null where id=$1",[finance.id]);
    await pool.query("update users set employee_record_id='syn-retainer-reviewer' where id=$1",[finance.id]);
    assert.equal((await review(second,'Approved')).status,403,'a changed reviewer link requires a fresh preparation');
    const renewal=await apiRequest(statementPath,{method:'POST',body:{sourceHash:second.sourceHash,previousId:second.id,
      renewReviewIdentity:true,reason:'Renew after reviewer identity was confirmed'}});
    assert.equal(renewal.status,201,JSON.stringify(renewal.body));const renewed=renewal.body.record;
    const rejected=await review(renewed,'Rejected');
    assert.equal(rejected.status,201,JSON.stringify(rejected.body));assert.equal(rejected.body.record.review.decision,'Rejected');
    assert.equal((await review(renewed,'Rejected')).body.record.review.id,rejected.body.record.review.id);
    assert.equal((await review(renewed,'Approved')).status,409);
    const pending=await reprepare(renewed);
    const hold=await pool.connect();
    let superseding,concurrentReview;
    const waitForLock=async count=>{
      for (let i=0;i<150;i++) {
        const q=await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'");
        if (q.rows[0].n>=count) return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail('Expected statement writer to wait for the commercial lock');
    };
    try {
      await hold.query('begin');
      await hold.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['commercial-lifecycle:'+scope.organizationId+':'+scope.legalEntityId]);
      superseding=apiRequest(statementPath,{method:'POST',body:{sourceHash:pending.sourceHash,previousId:pending.id,
        renewReviewIdentity:true,reason:'Synthetic concurrency review renewal'}});
      await waitForLock(1);
      concurrentReview=review(pending,'Approved');await waitForLock(2);
    } finally {await hold.query('rollback');hold.release();}
    const replacement=await superseding;
    assert.equal(replacement.status,201,JSON.stringify(replacement.body));const third=replacement.body.record;
    assert.equal((await concurrentReview).status,409,'queued reviewer must observe the committed superseding statement');
    const independent=await createContext(finance,reviewGrants);
    await independent.page.goto(`${baseUrl}/tests/fixtures/commercial-drafting.html?live=1`);
    const reviewButton=name=>independent.page.getByRole('button',{name,exact:true});
    await reviewButton('Inspect SYN-RETAINER-PERIOD').click();
    await reviewButton('Inspect approved retainer hours').click();await reviewButton('Review period statement').click();
    await reviewButton('Inspect statement 5').click();
    await independent.page.getByLabel('Review reason').fill('Synthetic browser decision');
    await reviewButton('Approve statement').click();
    await independent.page.getByText('Statement approved. Reload to inspect the decision.').waitFor();
    const archived=await apiRequest(reviewPath+'?statementId='+third.id,{identity:finance});
    assert.equal(archived.status,200);assert.equal(archived.body.record.review.decision,'Approved');
    assert.equal((await pool.query("select count(*)::int n from audit_logs where entity_type='Retainer Statement Review'")).rows[0].n,2);
    await assert.rejects(pool.query("update commercial_retainer_reviews set reason='Synthetic rewrite' where statement_id=$1",[third.id]));
    const registerPath=scopedStatementPath+'/register',issueGrant='commercial.retainer_eligibility.issue';
    assert.equal((await apiRequest(registerPath,{identity:finance})).status,403);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true",[reviewRole,issueGrant]);
    const retainerVersion=savedRetainer.result.versions[0].id;
    const eng=await apiRequest('/engagements',{method:'POST',body:{...engagement.body,model:'retainer',code:'SYN-RETAINER-BILL',
      name:'Synthetic retainer billing',contractId:savedRetainer.result.id,contractVersionId:retainerVersion,startsOn:'2020-01-01',endsOn:'2099-12-31'}});
    assert.equal(eng.status,201,JSON.stringify(eng.body));
    const retainerCommand={statementId:third.id,reviewId:archived.body.record.review.id,engagementId:eng.body.id,reason:'Register synthetic approved service period'};
    const issueRetainer=body=>apiRequest(registerPath,{identity:finance,method:'POST',body});
    assert.equal((await issueRetainer(retainerCommand)).status,409,'draft terms cannot generate charges');
    // Seed synthetic opening history at the service date. Only this fixture transaction
    // sees the historical clock. The ledger's sequence, root, date and scope triggers all run.
    const historyClient=await pool.connect();
    try {
      await historyClient.query('begin');
      await historyClient.query('create schema journey_retainer_clock');
      await historyClient.query("create function journey_retainer_clock.now() returns timestamptz language sql stable as $$select timestamptz '2020-01-01 12:00:00+00'$$");
      await historyClient.query('set local search_path=journey_retainer_clock,public,pg_catalog');
      for (const [type,id] of [['Contract',savedRetainer.result.id],['Engagement',eng.body.id]]) {
        await historyClient.query(`insert into commercial_lifecycle_events(organization_id,legal_entity_id,entity_type,entity_id,sequence,state,effective_on,
          contract_id,contract_version_id,after_value,reason,actor_id,active_role,correlation_id,operation_id)
          values($1,$2,$3,$4,1,'Active','2020-01-01',$5,$6,jsonb_build_object('state','Active'),'Synthetic opening history',$7,'Admin',$4,$4)`,
          [scope.organizationId,scope.legalEntityId,type,id,savedRetainer.result.id,retainerVersion,actorId]);
      }
      await historyClient.query('drop function journey_retainer_clock.now()');
      await historyClient.query('drop schema journey_retainer_clock');
      await historyClient.query('commit');
    } catch(error) {await historyClient.query('rollback');throw error;} finally {historyClient.release();}
    const inspect=await apiRequest(registerPath,{identity:finance});
    assert.equal(inspect.status,200,JSON.stringify(inspect.body));assert.deepEqual(inspect.body.engagements,[{id:eng.body.id,name:eng.body.name}]);
    assert.equal((await issueRetainer({...retainerCommand,engagementId:engagement.result.id})).status,409);
    assert.equal((await issueRetainer({...retainerCommand,amount:'0.01'})).status,400);
    const issuer=await createContext(finance,[...reviewGrants,issueGrant]);
    await issuer.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const issueButton=name=>issuer.page.getByRole('button',{name,exact:true});
    await issueButton('Inspect SYN-RETAINER-PERIOD').click();await issueButton('Inspect approved retainer hours').click();
    await issueButton('Inspect retainer billing register').click();
    await issuer.page.getByLabel('Responsible billing engagement').selectOption(eng.body.id);
    await issuer.page.getByLabel('Registration reason').fill(retainerCommand.reason);
    await pool.query("create trigger reject_test_retainer_audit before insert on audit_logs for each row when(new.action='Issue Retainer Charge') execute function reject_test_po_audit()");
    assert.equal((await issueRetainer(retainerCommand)).status,503);
    assert.equal((await apiRequest(registerPath,{identity:finance})).body.receipt,null,'register membership rolls back with the audit');
    await pool.query('drop trigger reject_test_retainer_audit on audit_logs');
    const registerLock=await pool.connect();let parallelIssue;
    try {
      await registerLock.query('begin');
      await registerLock.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['commercial-lifecycle:'+scope.organizationId+':'+scope.legalEntityId]);
      await issueButton('Register approved retainer charge').click();await waitForLock(1);
      parallelIssue=issueRetainer(retainerCommand);await waitForLock(2);
    } finally {await registerLock.query('rollback');registerLock.release();}
    assert.equal((await parallelIssue).status,201);
    await issuer.page.getByText(/Approved-unbilled · GBP 3500.0000/).waitFor();
    const issued=await issueRetainer(retainerCommand);
    assert.equal(issued.status,201,JSON.stringify(issued.body));assert.equal(issued.body.receipt.amount,'3500.0000');
    assert.equal((await issueRetainer({...retainerCommand,reason:'Changed registration'})).status,409);
    assert.equal((await pool.query("select count(*)::int n from billing_eligibility_events where source_type='RETAINER_PERIOD'")).rows[0].n,1);
    // Exercise the installed exclusion constraint independently of the source guard.
    // Different versions and engagements still compete for the same contract days.
    const ranges=await pool.connect();
    try {
      await ranges.query('begin');
      const rule=(await ranges.query("select pg_get_constraintdef(oid) rule from pg_constraint where conrelid='billing_eligibility_events'::regclass and conname='retainer_period_billed_once'")).rows[0].rule;
      await ranges.query('create temporary table retainer_range_probe(organization_id text,legal_entity_id text,contract_id text,engagement_id text,version text,source_type text,retainer_period daterange) on commit drop');
      await ranges.query('alter table retainer_range_probe add constraint probe_once '+rule);
      const addRange=(eng,version,start,end)=>ranges.query("insert into retainer_range_probe values('org','entity','contract',$1,$2,'RETAINER_PERIOD',daterange($3,$4,'[]'))",[eng,version,start,end]);
      await addRange('first','v1','2020-01-01','2020-01-31');await addRange('next','v2','2020-02-01','2020-02-28');
      await assert.rejects(addRange('different','v3','2020-01-31','2020-02-01'),e=>e.code==='23P01');
    } finally {await ranges.query('rollback');ranges.release();}
    {
    for (const key of draftGrants) await pool.query(
      'insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true',[reviewRole,key]);
    const preparing=await createContext(finance,[...draftGrants,issueGrant]);
    const draftPage=preparing.page;
    await draftPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const desk=draftPage.getByRole('region',{name:'Invoice-ready draft batches'});
    const loadDrafts=()=>desk.getByRole('button',{name:'Load drafts and available items'}).click();
    await loadDrafts();
    await desk.getByLabel('Invoice engagement').selectOption(eng.body.id);
    await desk.getByLabel('Invoice period start').fill(today);
    await desk.getByLabel('Invoice period end').fill(today);
    await desk.getByLabel('Invoice period basis').selectOption('ELIGIBLE_DATE');
    await desk.getByLabel('Invoice owner user ID').fill(finance.id);
    await desk.getByLabel('Invoice owner role').fill(reviewRole);
    await desk.getByLabel('Invoice draft reason').fill('Prepare the approved retainer charge');
    await desk.getByRole('checkbox',{name:'Confirm the displayed client, contract and currency'}).check();
    const post=(suffix)=>draftPage.waitForResponse(r=>r.url().endsWith('/api/v1/invoice-drafts/'+suffix) && r.request().method()==='POST');
    const creating=post('batches');
    await desk.getByRole('button',{name:'Create invoice Draft'}).click();
    const created=await creating;assert.equal(created.status(),201,await created.text());
    const retainerBatch=(await created.json()).batch.id;
    const inspectRetainer=async()=>{
      await loadDrafts();
      await desk.getByLabel('Invoice draft',{exact:true}).selectOption(retainerBatch);
      await desk.getByRole('button',{name:'Inspect invoice draft'}).click();
    };
    await inspectRetainer();
    await desk.getByLabel('Available invoice item').selectOption('retainer:'+issued.body.receipt.itemId);
    await desk.getByLabel('Invoice item reason').fill('Reserve the exact approved retainer charge');
    const reserving=post('batches/'+retainerBatch+'/lines');
    await desk.getByRole('button',{name:'Reserve selected whole item'}).click();
    const reserved=await reserving;assert.equal(reserved.status(),201,await reserved.text());
    const retainerLine=(await reserved.json()).line;
    assert.deepEqual([retainerLine.eventId,retainerLine.itemId,retainerLine.amount,retainerLine.snapshotId],
      [issued.body.receipt.eventId,issued.body.receipt.itemId,'3500.0000',null]);
    const linePath='/api/v1/invoice-drafts/batches/'+retainerBatch+'/lines';
    const original=reserved.request().postDataJSON();
    const replay=await apiRequest(linePath,{method:'POST',identity:finance,body:original});
    assert.equal(replay.body.replayed,true,JSON.stringify(replay.body));
    const double=await apiRequest(linePath,{method:'POST',identity:finance,
      body:{...original,expectedLineCount:1,requestId:crypto.randomUUID()}});
    assert.equal(double.status,409);
    const draftsUrl='/api/v1/invoice-drafts/batches';
    const otherBatch=await apiRequest(draftsUrl,{method:'POST',identity:finance,body:{...created.request().postDataJSON(),requestId:crypto.randomUUID()}});
    assert.equal(otherBatch.status,201,JSON.stringify(otherBatch.body));
    const otherPath=draftsUrl+'/'+otherBatch.body.batch.id;
    const otherCommand={...original,requestId:crypto.randomUUID()};
    const overlapping=await apiRequest(otherPath+'/lines',{method:'POST',identity:finance,body:otherCommand});
    assert.equal(overlapping.status,409);
    assert.deepEqual((await apiRequest(otherPath+'/available-retainer-charges',{identity:finance})).body.items,[]);
    const withoutAuthority=await apiRequest('/api/v1/invoice-drafts/batches/'+retainerBatch,{identity:identities.reader});
    assert.equal(withoutAuthority.status,403);
    assert.equal((await apiRequest('/api/v1/invoice-drafts/batches',{identity:identities.reader})).body.batches.some(row=>row.id===retainerBatch),false);
    assert.equal(retainerLine.evidence.reviewId,retainerCommand.reviewId);
    assert.equal(retainerLine.evidence.statementId,retainerCommand.statementId);
    await inspectRetainer();
    await desk.getByText(/Retained lines 1/).waitFor();
    await desk.getByLabel('Cancellation reason').fill('Release the retainer charge for rebatching');
    const cancelling=post('batches/'+retainerBatch+'/cancellations');
    await desk.getByRole('button',{name:/Cancel .*draft/i}).click();
    const cancelled=await cancelling;assert.equal(cancelled.status(),201,await cancelled.text());
    assert.equal((await pool.query('select 1 from invoice_draft_occupancies where item_id=$1',[issued.body.receipt.itemId])).rowCount,0);
    assert.equal((await pool.query('select 1 from invoice_draft_lines where id=$1 and event_id=$2',[retainerLine.id,issued.body.receipt.eventId])).rowCount,1);
    const rebatched=await apiRequest(otherPath+'/lines',{method:'POST',identity:finance,body:otherCommand});
    assert.equal(rebatched.status,201,JSON.stringify(rebatched.body));
    assert.equal(rebatched.body.line.eventId,retainerLine.eventId);
    assert.notEqual(rebatched.body.line.id,retainerLine.id);
    const approvalBase='/api/v1/invoice-batch-approvals',batchId=otherBatch.body.batch.id;
    const act=(path,identity,body)=>apiRequest(approvalBase+path,body ? {identity,method:'POST',body} : {identity});
    const invoiceManager=['commercial.contracts.manage','commercial.invoice_approval.manage','approvals.view','commercial.invoice_approval.decide'];
    const decisionKeys=[...draftGrants,issueGrant,'approvals.view','commercial.invoice_approval.decide'];
    for(const [role,keys] of [[reviewRole,invoiceManager],['Admin',decisionKeys]]) await pool.query(
      'insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k on conflict(role_name,permission_key) do update set enabled=true',[role,keys]);
    const sourceRead=await act('/sources/'+batchId,finance);
    assert.equal(sourceRead.status,200,JSON.stringify(sourceRead.body));
    const {batch:source,ownerKey}=sourceRead.body;
    assert.equal(source.sourceType,'RETAINER_PERIOD');assert.equal(source.lines[0].evidence.reviewId,retainerCommand.reviewId);
    const policyInput={entityType:'InvoiceBatch',fullLineReversals:true,engagementId:eng.body.id,locale:'en-US',completionInApp:true,
      templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed'].map(key=>({key,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'}))};
    const configure=(reviewer,prior,additionalStages=[])=>act('/policies',finance,{expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),engagementId:eng.body.id,
      expectedLatestId:prior,effectiveFrom:today,definition:{...policyInput,stages:[{userId:reviewer.id,role:reviewer.role},...additionalStages]},reason:'Synthetic retainer invoice review'});
    const submit=policyId=>act('/requests',finance,{expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId,expectedPolicyId:policyId,
      expectedLineCount:source.lineCount,expectedLineageHash:source.lineageHash,reason:'Review the approved service-period charge'});
    const self=await configure(finance,null);assert.equal(self.status,201,JSON.stringify(self.body));
    const independentRequester=identities.manager;
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.invoice_approval.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
    const adminSource=(await act('/sources/'+batchId,independentRequester)).body;
    const ownerAsReviewer=await act('/requests',independentRequester,{requestId:crypto.randomUUID(),expectedOwnerKey:adminSource.ownerKey,
      batchId,expectedPolicyId:self.body.policy.id,expectedLineCount:source.lineCount,expectedLineageHash:source.lineageHash,reason:'Test owner independence'});
    assert.equal(ownerAsReviewer.status,403,JSON.stringify(ownerAsReviewer.body));
    const selfSubmit=await submit(self.body.policy.id);assert.ok([403,409].includes(selfSubmit.status),JSON.stringify(selfSubmit.body));
    const policy=await configure(identities.manager,self.body.policy.id);assert.equal(policy.status,201,JSON.stringify(policy.body));
    const submission=await submit(policy.body.policy.id);assert.equal(submission.status,201,JSON.stringify(submission.body));
    const reviewerKey=(await act('/sources/'+batchId,identities.manager)).body.ownerKey;
    const decide=(id,decision)=>act('/instances/'+id+'/decisions',identities.manager,{requestId:crypto.randomUUID(),
      expectedOwnerKey:reviewerKey,expectedSequence:0,decision,reason:'Synthetic governed decision'});
    await pool.query('update users set employee_record_id=null where id=$1',[identities.manager.id]);
    await pool.query('update users set employee_record_id=$2 where id=$1',[identities.manager.id,ownerId]);
    const staleDecision=await decide(submission.body.approval.id,'Approved');
    assert.equal(staleDecision.status,409,JSON.stringify(staleDecision.body));
    const withdrawn=await act('/instances/'+submission.body.approval.id+'/withdrawals',finance,
      {requestId:crypto.randomUUID(),expectedOwnerKey:ownerKey,reason:'Renew after reviewer identity changed'});
    assert.equal(withdrawn.status,201,JSON.stringify(withdrawn.body));
    const renewed=await submit(policy.body.policy.id);assert.equal(renewed.status,201,JSON.stringify(renewed.body));
    const rejection=await decide(renewed.body.approval.id,'Rejected');assert.equal(rejection.status,201,JSON.stringify(rejection.body));
    assert.equal((await act('/sources/'+batchId,finance)).body.batch.state,'Draft');
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('syn-invoice-reviewer','SYN-INVOICE-REVIEWER','Synthetic second reviewer','invoice-review@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)`,[scope.organizationId,scope.legalEntityId]);
    await pool.query("update users set employee_record_id='syn-invoice-reviewer' where id=$1",[alias.id]);
    const stagedPolicy=await configure(identities.manager,policy.body.policy.id,[{userId:alias.id,role:alias.role}]);
    assert.equal(stagedPolicy.status,201,JSON.stringify(stagedPolicy.body));
    const finalReview=await submit(stagedPolicy.body.policy.id);assert.equal(finalReview.status,201,JSON.stringify(finalReview.body));
    const instance=finalReview.body.approval.id;
    assert.equal((await act('/instances/'+instance,identities.reader)).status,403);
    const reviewBrowser=await createContext(identities.manager,decisionKeys);
    await reviewBrowser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const approvalDesk=reviewBrowser.page.getByRole('region',{name:'Invoice batch approvals'});
    await approvalDesk.getByLabel('Invoice approval engagement').selectOption(eng.body.id);
    await approvalDesk.getByRole('button',{name:'Load invoice batches and reviews'}).click();
    await approvalDesk.getByLabel('Invoice batch review',{exact:true}).selectOption(instance);
    await approvalDesk.getByRole('button',{name:'Inspect invoice review'}).click();
    await approvalDesk.getByText(new RegExp(retainerCommand.statementId)).waitFor();
    await approvalDesk.getByLabel('Invoice approval decision',{exact:true}).selectOption('Approved');
    await approvalDesk.getByLabel('Invoice approval decision reason').fill('Accepted traced service period and fee components');
    const accepted=reviewBrowser.page.waitForResponse(r=>r.url().endsWith('/instances/'+instance+'/decisions') && r.request().method()==='POST');
    await approvalDesk.getByRole('button',{name:'Record invoice approval decision'}).click();
    const approved=await accepted;assert.equal(approved.status(),201,await approved.text());
    assert.equal((await act('/sources/'+batchId,finance)).body.batch.state,'Under Review');
    const secondKey=(await act('/sources/'+batchId,alias)).body.ownerKey;
    const second=await act('/instances/'+instance+'/decisions',alias,{expectedOwnerKey:secondKey,requestId:crypto.randomUUID(),
      expectedSequence:1,decision:'Approved',reason:'Verified second-stage control total'});
    assert.equal(second.status,201,JSON.stringify(second.body));
    assert.equal((await act('/sources/'+batchId,finance)).body.batch.state,'Approved');
    const exportKeys=['commercial.reversal_eligibility.create','commercial.invoice_batch.confirm','reports.export','commercial.invoice_export.view','commercial.invoice_export.create','commercial.invoice_export.configure','integrations.invoice_alert_routes.manage'];
    for(const role of [reviewRole,'Admin','Employee']) await pool.query(
      'insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k on conflict(role_name,permission_key) do update set enabled=true',[role,exportKeys]);
    const csv='/api/v1/invoice-csv', notice='/api/v1/invoice-export-notice-config';
    const configPost=(path,body)=>apiRequest(notice+path,{method:'POST',identity:finance,body:{...body,expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),reason:'Synthetic export notice configuration'}});
    const route=await configPost('/routes',{routeKey:crypto.randomUUID(),expectedLatestId:null,label:'Synthetic internal export notices',active:true});
    assert.equal(route.status,201,JSON.stringify(route.body));
    const notify=await configPost('/policies',{expectedLatestId:null,effectiveFrom:today,definition:{entityType:'InvoiceExport',engagementId:eng.body.id,
      financeOwner:{userId:finance.id,role:reviewRole},integrationAdmin:{userId:identities.manager.id,role:'Admin'},alertRouteId:route.body.route.id,
      locale:'en-US',templates:INVOICE_EXPORT_EVENT_KEYS.map(key=>({key,subject:'Invoice {{sourceRef}}',body:'Synthetic status {{sourceRef}}'})),completionInApp:true}});
    assert.equal(notify.status,201,JSON.stringify(notify.body));
    assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:identities.reader})).status,403);
    const exportSource=await apiRequest(csv+'/batches/'+batchId,{identity:finance});
    assert.equal(exportSource.status,200,JSON.stringify(exportSource.body));
    const exportCmd={expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId,approvalId:instance,finalTransitionId:exportSource.body.batch.finalTransitionId,
      lineageHash:exportSource.body.batch.lineageHash,schemaVersion:'workos.invoice-retainer-csv/1',expectedLineCount:1,expectedTotal:'3500',reason:'Synthetic retainer export'};
    const sendExport=body=>apiRequest(csv+'/exports',{method:'POST',identity:finance,body});
    assert.equal((await sendExport({...exportCmd,expectedTotal:'1'})).status,409);
    assert.equal((await sendExport({...exportCmd,schemaVersion:'workos.invoice-tm-csv/1'})).status,409);
    await pool.query("create trigger reject_test_retainer_export before insert on audit_logs for each row when (new.module='Invoice CSV') execute function reject_test_po_audit()");
    const interrupted=await sendExport(exportCmd);
    assert.equal(interrupted.status,503,JSON.stringify(interrupted.body));
    assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:finance})).body.batch.state,'Approved');
    assert.equal((await pool.query('select 1 from invoice_csv_artifacts where batch_id=$1',[batchId])).rowCount,0);
    await pool.query('drop trigger reject_test_retainer_export on audit_logs');
    const csvBrowser=await createContext(finance,[...draftGrants,issueGrant,...exportKeys]);
    await csvBrowser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const csvDesk=csvBrowser.page.getByRole('region',{name:'Invoice CSV export'});
    await csvDesk.getByLabel('Invoice export engagement').selectOption(eng.body.id);
    await csvDesk.getByRole('button',{name:'Load invoice export batches'}).click();
    await csvDesk.getByLabel('Invoice export batch').selectOption(batchId);
    await csvDesk.getByRole('button',{name:'Inspect invoice export source'}).click();
    await csvDesk.getByLabel('Invoice CSV schema').selectOption('workos.invoice-retainer-csv/1');
    await csvDesk.getByRole('checkbox',{name:'I inspected the final approval, retained lineage and control total'}).check();
    await csvDesk.getByLabel('Invoice CSV reason').fill(exportCmd.reason);
    const saving=csvBrowser.page.waitForResponse(r=>r.url().endsWith(csv+'/exports') && r.request().method()==='POST');
    await csvDesk.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
    const saved=await saving;assert.equal(saved.status(),201,await saved.text());
    await csvDesk.getByRole('region',{name:'Verified invoice CSV'}).waitFor();
    const a=(await saved.json()).artifact;
    const bytes=Buffer.from(a.payloadBase64,'base64'),row=bytes.toString('utf8').split('\r\n')[1].split(',');
    assert.deepEqual([row[4],row[6],row[8],JSON.parse(Buffer.from(row[9].slice(4),'base64')).reviewId,row[15],row[19]],
      [issued.body.receipt.itemId,issued.body.receipt.eventId,retainerCommand.statementId,retainerCommand.reviewId,'3500','1']);
    assert.equal((await apiRequest(csv+'/artifacts/'+a.id,{identity:identities.reader})).status,403);
    assert.equal((await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1',[batchId])).rows[0].n,1);
    const noticeEvents=await pool.query(
      "select id from invoice_export_notice_events where batch_id=$1 and artifact_id=$2 and event_key='invoice_batch.exported_or_billed_confirmed'",
      [batchId,a.id]);
    assert.equal(noticeEvents.rowCount,1,'Accepted retainer export must produce its configured completion notice');
    const replayExport=await sendExport(saved.request().postDataJSON());assert.equal(replayExport.body.replayed,true);
    assert.equal(replayExport.body.artifact.sha256,a.sha256);
    assert.equal((await sendExport({...saved.request().postDataJSON(),reason:'Changed reason'})).status,409);
    assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:finance})).body.batch.state,'Exported');
    const confirmations=csvBrowser.page.getByRole('region',{name:'Invoice billing confirmation'});
    await confirmations.getByLabel('Invoice confirmation engagement').selectOption(eng.body.id);
    await confirmations.getByRole('button',{name:'Load invoice confirmation batches'}).click();
    await confirmations.getByLabel('Invoice confirmation batch').selectOption(batchId);
    await confirmations.getByRole('button',{name:'Inspect exported invoice artifact'}).click();
    const inspected=confirmations.getByRole('region',{name:'Inspected confirmation source'});
    await inspected.getByText(/retainer source/).waitFor();
    assert.equal((await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:identities.reader})).status,403);
    const reference='Synthetic downstream retainer invoice';
    const cmd={expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId,artifactId:a.id,artifactVersion:1,artifactSha256:a.sha256,currency:a.currency,total:a.total,reference,reason:'Matched downstream receipt'};
    const attest=body=>apiRequest(csv+'/confirmations',{method:'POST',identity:finance,body});
    assert.equal((await attest({...cmd,total:'1'})).status,409);
    await pool.query("create trigger reject_retainer_attestation before insert on audit_logs for each row when(new.module='Invoice Billing Confirmation') execute function reject_test_po_audit()");
    assert.equal((await attest(cmd)).status,503);
    assert.equal((await pool.query('select 1 from invoice_batch_confirmations where batch_id=$1',[batchId])).rowCount,0);
    await pool.query('drop trigger reject_retainer_attestation on audit_logs');
    await inspected.getByLabel('Invoice confirmation reference').fill(reference);
    await inspected.getByLabel('Invoice confirmation reason').fill(cmd.reason);
    await inspected.getByRole('checkbox').check();
    const confirming=csvBrowser.page.waitForResponse(r=>r.url().endsWith(csv+'/confirmations') && r.request().method()==='POST');
    await inspected.getByRole('button',{name:'Record manual billing attestation'}).click();
    const confirmed=await confirming;
    assert.equal(confirmed.status(),201,await confirmed.text());
    const receipt=(await confirmed.json()).confirmation;
    assert.deepEqual([receipt.sourceType,receipt.artifactSha256,receipt.total,receipt.reference],['RETAINER_PERIOD',a.sha256,a.total,reference]);
    await confirmations.getByText('Retained manual attestation '+receipt.id,{exact:false}).waitFor();
    assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[batchId])).rowCount,1);
    const attestationRequest=confirmed.request().postDataJSON();
    assert.equal((await attest(attestationRequest)).body.replayed,true);
    assert.equal((await attest({...attestationRequest,reference:'Changed reference'})).status,409);
    assert.equal((await apiRequest(csv+'/confirmation-receipts/'+attestationRequest.requestId,{identity:finance})).body.confirmation.id,receipt.id);
    assert.equal((await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:finance})).body.source.state,'Billed/Confirmed');
    assert.equal((await pool.query('select id from invoice_export_notice_events where confirmation_id=$1',[receipt.id])).rowCount,1);
    const reversalPath=csv+'/batches/'+batchId+'/lines/'+rebatched.body.line.id+'/reversal-request';
    const reverse=(path,body)=>apiRequest(reversalPath+path,{method:'POST',identity:finance,body});
    const requestBody={expectedOwnerKey:ownerKey,artifactId:a.id,sha256:a.sha256,inspectedState:'Billed/Confirmed',reason:'Reverse duplicate downstream charge'};
    assert.equal((await reverse('',{...requestBody,inspectedState:'Exported'})).status,409);
    assert.equal((await apiRequest(reversalPath,{identity:identities.reader})).status,403);
    await csvDesk.getByLabel('Invoice export engagement').selectOption(eng.body.id);
    await csvDesk.getByRole('button',{name:'Load invoice export batches'}).click();
    await csvDesk.getByLabel('Invoice export batch').selectOption(batchId);
    await csvDesk.getByRole('button',{name:'Inspect invoice export source'}).click();
    await csvDesk.getByRole('button',{name:'Retrieve retained invoice CSV'}).click();
    await csvDesk.getByLabel('Exported line to review').selectOption(rebatched.body.line.id);
    await csvDesk.getByRole('button',{name:'Check reversal request'}).click();
    await csvDesk.getByLabel('Full reversal reason').fill(requestBody.reason);
    await csvDesk.getByRole('button',{name:'Request full line reversal'}).click();
    await csvDesk.getByRole('button',{name:'Check reversal reviewers'}).click();
    await csvDesk.getByRole('button',{name:'Submit reversal for independent review'}).click();
    await csvDesk.getByText(/Submitted reversal review/).waitFor();
    assert.equal((await reverse('',requestBody)).body.replayed,true);
    const savedReview=(await apiRequest(reversalPath+'/review',{identity:finance})).body.review;
    const decisionPath='/api/v1/work-approvals/reversal-reviews/'+savedReview.id;
    const stageDecision=(who,key,n)=>apiRequest(decisionPath+'/decisions',{method:'POST',identity:who,body:{
      expectedOwnerKey:key,expectedSequence:n,policyId:stagedPolicy.body.policy.id,confirmationId:receipt.id,decision:'Approved',reason:'Verified retained service period charge'}});
    const selfReview=await pool.query(
      'select retainer_review_participants_valid(retainer_reversal_participants(b,$1,$2,$3)) ok from invoice_draft_batches b where b.id=$4',
      [identities.manager.id,identities.manager.role,stagedPolicy.body.policy.id,batchId]);
    assert.equal(selfReview.rows[0].ok,false,'The reversal requester cannot occupy a named review stage');
    const firstReversal=await stageDecision(identities.manager,reviewerKey,0);
    assert.equal(firstReversal.status,201,JSON.stringify(firstReversal.body));
    assert.equal(firstReversal.body.review.sourceType,'RETAINER_PERIOD');
    if (reversalScenario === 'stale reviewer') {
      const stageWorker=(await pool.query('select employee_record_id from users where id=$1',[alias.id])).rows[0].employee_record_id;
      await pool.query('update users set employee_record_id=null where id=$1',[alias.id]);
      await pool.query('update users set employee_record_id=$2 where id=$1',[alias.id,stageWorker]);
      assert.equal((await apiRequest(decisionPath,{identity:alias})).body.review.canDecide,false);
      assert.equal((await stageDecision(alias,secondKey,1)).status,409);
      await assert.rejects(pool.query(
        "insert into invoice_reversal_decisions(id,review_id,sequence,actor_id,active_role,reason,confirmation_id,decision,operation_id) values($1,$2,2,$3,$4,'Synthetic stale decision',$5,'Approved',$6)",
        [crypto.randomUUID(),savedReview.id,alias.id,alias.role,receipt.id,crypto.randomUUID()]),
        err=>err.code==='IBA02' && err.message.includes('Reversal reviewer identity changed'));
      assert.equal((await pool.query('select sequence from invoice_reversal_decisions where review_id=$1',[savedReview.id])).rowCount,1);
    } else {
      const ok=(response,code=201)=>{assert.equal(response.status,code,JSON.stringify(response.body));return response.body;};
      assert.equal((await apiRequest(reversalPath+'/eligibility',{identity:finance})).body.source,null);
      ok(await stageDecision(alias,secondKey,1));
      const eligibility=ok(await apiRequest(reversalPath+'/eligibility',{identity:finance}),200);
      assert.equal(eligibility.source.amount,'-3500');
      assert.equal(eligibility.source.originalEventId,issued.body.receipt.eventId);
      const issueBody={expectedOwnerKey:ownerKey,reviewId:savedReview.id,decisionId:eligibility.source.decisionId,
        confirmationId:receipt.id,eligibleOn:eligibility.serverDate,reason:'Correct the original service-period charge'};
      assert.equal((await reverse('/eligibility',{...issueBody,confirmationId:null})).status,409);
      const staleCredit=await pool.connect();
      try {
        await staleCredit.query('begin');
        const worker=(await staleCredit.query('select employee_record_id from users where id=$1',[alias.id])).rows[0].employee_record_id;
        await staleCredit.query('update users set employee_record_id=null where id=$1',[alias.id]);
        await staleCredit.query('update users set employee_record_id=$2 where id=$1',[alias.id,worker]);
        const op=crypto.randomUUID();
        await staleCredit.query("select set_config('workos.reversal_issue_context',$1,true)",[JSON.stringify({
          actorId:finance.id,role:finance.role,org:scope.organizationId,legal:scope.legalEntityId,operationId:op})]);
        await assert.rejects(staleCredit.query(
          `insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,source_type,version,eligible_on,
          currency,amount,billing_evidence,actor_id,active_role,operation_id,reverses_event_id,reversal_decision_id)
          select $1,organization_id,legal_entity_id,client_id,contract_id,engagement_id,'FULL_LINE_REVERSAL',1,$2,currency,amount,evidence,
          $3,$4,$5,original_event,final_decision from full_line_reversal_source($6)`,
          [crypto.randomUUID(),issueBody.eligibleOn,finance.id,finance.role,op,savedReview.id]),
          err=>err.code==='IBA02' && err.message.includes('before credit issuance'));
      } finally {
        await staleCredit.query('rollback');
        staleCredit.release();
      }
      assert.equal((await apiRequest(reversalPath+'/eligibility',{identity:identities.reader})).status,403);
      await pool.query("create trigger fail_retainer_credit before insert on audit_logs for each row when(new.action='Issue Full Line Reversal') execute function reject_test_po_audit()");
      assert.equal((await reverse('/eligibility',issueBody)).status,503);
      assert.equal((await pool.query('select 1 from billing_eligibility_events where reverses_event_id=$1',[eligibility.source.originalEventId])).rowCount,0);
      await pool.query('drop trigger fail_retainer_credit on audit_logs');
      await csvDesk.getByRole('button',{name:'Check reversal reviewers'}).click();
      await csvDesk.getByRole('button',{name:'Inspect corrective billing eligibility'}).click();
      await csvDesk.getByLabel('Credit issuance reason').fill(issueBody.reason);
      await csvDesk.getByRole('button',{name:'Issue approved-unbilled credit'}).click();
      await csvDesk.getByText(/Approved-unbilled credit .*eligibility date/).waitFor();
      const replayedCredit=ok(await reverse('/eligibility',issueBody),200);
      assert.equal(replayedCredit.replayed,true);
      const credit=replayedCredit.receipt;
      assert.equal(credit.amount,'-3500');
      const reservePath=csv+'/batches/'+batchId+'/correction-drafts';
      const reserveBody={expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),reason:'Reserve the service-period credit',itemIds:[credit.itemId]};
      const reserve=()=>apiRequest(reservePath,{method:'POST',identity:finance,body:reserveBody});
      const reserved=ok(await reserve()).receipt;
      assert.equal(reserved.total,credit.amount);
      assert.equal(ok(await reserve(),200).receipt.batchId,reserved.batchId);
      const proof=ok(await apiRequest(reservePath+'/'+reserved.batchId,{identity:finance}),200);
      assert.equal(proof.lines[0].artifactSha256,a.sha256);
      const creditSource=ok(await act('/sources/'+reserved.batchId,finance),200).batch;
      assert.equal(creditSource.lines[0].evidence.originalSourceType,'RETAINER_PERIOD');
      const creditApproval=ok(await act('/requests',finance,{expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId:reserved.batchId,
        expectedPolicyId:stagedPolicy.body.policy.id,expectedLineCount:1,expectedLineageHash:creditSource.lineageHash,reason:'Review service-period credit'})).approval;
      for(const [n,who,key] of [[0,identities.manager,reviewerKey],[1,alias,secondKey]]){
        ok(await act('/instances/'+creditApproval.id+'/decisions',who,{expectedOwnerKey:key,requestId:crypto.randomUUID(),expectedSequence:n,
          decision:'Approved',reason:'Approved reviewed service-period credit'}));
      }
      const exportCredit=ok(await apiRequest(csv+'/batches/'+reserved.batchId,{identity:finance}),200).batch;
      const creditCmd={...exportCmd,requestId:crypto.randomUUID(),batchId:reserved.batchId,approvalId:creditApproval.id,
        finalTransitionId:exportCredit.finalTransitionId,lineageHash:exportCredit.lineageHash,schemaVersion:'workos.invoice-credit-csv/1',expectedTotal:credit.amount};
      assert.equal((await sendExport({...creditCmd,expectedTotal:'3500'})).status,409);
      await csvDesk.getByRole('button',{name:'Load invoice export batches'}).click();
      await csvDesk.getByRole('button',{name:'Find credit exports'}).click();
      await csvDesk.getByLabel('Invoice export batch').selectOption(reserved.batchId);
      await csvDesk.getByRole('button',{name:'Inspect invoice export source'}).click();
      await csvDesk.getByLabel('Invoice CSV schema').selectOption('workos.invoice-credit-csv/1');
      await csvDesk.getByLabel('I inspected the final approval, retained lineage and control total').check();
      await csvDesk.getByLabel('Invoice CSV reason').fill('Export approved retainer credit');
      const exportingCredit=csvBrowser.page.waitForResponse(r=>r.url().endsWith(csv+'/exports') && r.request().method()==='POST');
      await csvDesk.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
      const acceptedCredit=await exportingCredit;
      assert.equal(acceptedCredit.status(),201,await acceptedCredit.text());
      const creditArtifact=(await acceptedCredit.json()).artifact;
      await csvDesk.getByRole('region',{name:'Verified invoice CSV'}).waitFor();
      assert.equal(creditArtifact.total,credit.amount);
      const creditConfirmation=ok(await attest({...attestationRequest,requestId:crypto.randomUUID(),batchId:reserved.batchId,artifactId:creditArtifact.id,
        artifactSha256:creditArtifact.sha256,total:credit.amount,reference:'Synthetic credit application',reason:'Matched applied service-period credit'})).confirmation;
      recoveryEvidence={finance, original:{artifact:a,confirmation:receipt,itemId:issued.body.receipt.itemId},
        credit:{artifact:creditArtifact,confirmation:creditConfirmation,itemId:credit.itemId}};
      assert.equal(creditConfirmation.sourceType,'FULL_LINE_REVERSAL');
      assert.equal(creditConfirmation.total,credit.amount);
      assert.equal(ok(await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:finance}),200).confirmation.id,receipt.id);
      const csvText=Buffer.from(creditArtifact.payloadBase64,'base64').toString('utf8');
      for(const pinned of [a.id,a.sha256,rebatched.body.line.id]) assert.ok(csvText.includes(pinned));
      assert.equal(ok(await sendExport(acceptedCredit.request().postDataJSON()),200).artifact.sha256,creditArtifact.sha256);
      assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[reserved.batchId])).rowCount,1);
    }
    assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[batchId])).rowCount,1);
    await csvBrowser.context.close();
    await reviewBrowser.context.close();
    await preparing.context.close();
    }
    await issuer.context.close();
    await independent.context.close();
    assert.equal((await apiRequest(consumptionPath.replace(savedRetainer.result.versions[0].id,versionId))).status,404);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.view_utilization'");
    assert.equal((await apiRequest(consumptionPath)).status,403);
    await preparing.context.close();
    await billing.context.close();
    await reviewer.context.close();
    if (reversalScenario==='approved credit') {
      await open();
      await button('New contract / SOW').click();
      const managed=form('New contract / SOW');
      await managed.getByLabel('Client',{exact:true}).selectOption(clientId);
      await managed.getByLabel('Commercial model',{exact:true}).selectOption('managed_service');
      await fill(managed,{'Contract / SOW number':'SYN-SERVICE','Contract name':'Synthetic service operation','Starts on':'2020-01-01',
        'Ends on':'2099-12-31','Terms effective from':'2020-01-01','Currency (ISO code)':'GBP','Contract value (decimal)':'1000',
        'Billing terms':'Configured service quantities','Reason for creation / revision':'Set service units'});
      await button('Add service unit').click();
      await fill(managed,{'Unit 1 code':'TICKET','Unit 1 label':'Accepted ticket'});
      await button('Add service unit').click();
      await fill(managed,{'Unit 2 code':'SHIFT','Unit 2 label':'Support shift'});
      await managed.getByLabel('Unit 2 decimal places').selectOption('2');
      const saved=await save('/contracts','managed');
      const units=[{code:'TICKET',label:'Accepted ticket',precision:0},{code:'SHIFT',label:'Support shift',precision:2}];
      assert.deepEqual(saved.result.versions[0].serviceDimensions,units);
      await button('Inspect SYN-SERVICE').click();
      await page.getByText('Support shift · SHIFT · 2 decimal places',{exact:true}).waitFor();
      const serviceVersion=saved.result.versions[0].id;
      const serviceEng=await apiRequest('/engagements',{method:'POST',body:{...engagement.body,model:'managed_service',code:'SYN-SERVICE-CAPTURE',
        name:'Synthetic unit capture',budget:'100',contractId:saved.result.id,contractVersionId:serviceVersion,startsOn:'2020-01-01',endsOn:'2099-12-31'}});
      assert.equal(serviceEng.status,201,JSON.stringify(serviceEng.body));
      const capturePath='/engagements/'+serviceEng.body.id+'/service-unit-evidence';
      const serviceInput={versionId:serviceVersion,serviceDate:today,dimensionCode:'SHIFT',quantity:'1.25',sourceReference:'SYN-SHIFT-1'};
      const capture=(body,opts={})=>apiRequest(capturePath,{method:'POST',body,...opts});
      assert.equal((await capture(serviceInput)).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.service_units.capture',true),('Admin','commercial.lifecycle.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
      assert.equal((await capture(serviceInput)).status,422,'draft engagement cannot record delivery');
      for(const [type,id] of [['Contract',saved.result.id],['Engagement',serviceEng.body.id]]) {
        const result=await apiRequest('/lifecycle/'+type+'/'+id+'/transitions',{method:'POST',body:{expectedSequence:0,state:'Active',contractVersionId:serviceVersion,approvalReference:null,reason:'Synthetic service delivery opening'}});
        assert.equal(result.status,201,JSON.stringify(result.body));
      }
      assert.equal((await capture({...serviceInput,quantity:'1.251'})).status,422);
      assert.equal((await capture({...serviceInput,dimensionCode:'UNKNOWN'})).status,422);
      assert.equal((await capture({...serviceInput,serviceDate:future})).status,422);
      assert.equal((await capture({...serviceInput,versionId})).status,422);
      assert.equal((await capture(serviceInput,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
      await open();await button('Inspect SYN-SERVICE').click();
      const captureForm=form('Record delivered units');
      await captureForm.getByLabel('Service engagement').selectOption(serviceEng.body.id);
      await captureForm.getByLabel('Delivered unit').selectOption('SHIFT');
      await fill(captureForm,{'Service date':today,'Delivered quantity':'1.25','Service evidence reference':'SYN-SHIFT-1'});
      await button('Record service evidence').click();
      await captureForm.getByText(/Service evidence recorded/).waitFor();
      await captureForm.getByText(today+' · 1.25 SHIFT · SYN-SHIFT-1').waitFor();
      const replay=await capture(serviceInput);assert.equal(replay.status,201,JSON.stringify(replay.body));
      assert.equal((await capture({...serviceInput,quantity:'2'})).status,409);
      const evidence=await pool.query('select quantity::text,actor_id from commercial_service_unit_evidence where engagement_id=$1',[serviceEng.body.id]);
      assert.deepEqual(evidence.rows,[{quantity:'1.25',actor_id:actorId}]);
      await assert.rejects(pool.query('delete from commercial_service_unit_evidence where id=$1',[replay.body.id]));
      const {number,clientId:client,...revision}=saved.body;
      const path='/contracts/'+saved.result.id+'/versions';
      const revise=(body,identity=identities.manager)=>apiRequest(path,{method:'POST',identity,body});
      const next={...revision,expectedVersion:1,effectiveFrom:future};
      assert.equal((await revise(next,identities.denied)).status,403);
      assert.equal((await apiRequest(path,{method:'POST',identity:identities.manager,scope:{...scope,legalEntityId:'synthetic-unassigned-entity'},body:next})).status,403);
      assert.equal((await revise({...next,serviceDimensions:[{...units[0],precision:5}]})).status,400);
      assert.equal((await revise({...next,serviceDimensions:[units[0],units[0]]})).status,422);
      assert.equal((await apiRequest('/contracts',{method:'POST',body:{...saved.body,number:'SYN-WRONG-MODEL',model:'retainer'}})).status,422);
      delete next.serviceDimensions;
      const inherited=await revise(next);
      assert.equal(inherited.status,201,JSON.stringify(inherited.body));
      assert.deepEqual(inherited.body.versions[0].serviceDimensions,units);
      const cleared=await revise({...next,expectedVersion:2,effectiveFrom:'2099-01-01',serviceDimensions:[]});
      assert.equal(cleared.status,201,JSON.stringify(cleared.body));
      assert.equal(cleared.body.versions[0].serviceDimensions,undefined);
      assert.deepEqual(cleared.body.versions[2].serviceDimensions,units);
      const auditTerms=await pool.query("select before_value,after_value from commercial_draft_events where entity_id=$1 and after_value->>'latestVersion'='3'",[saved.result.id]);
      assert.deepEqual(auditTerms.rows[0].before_value.versions[0].serviceDimensions,units);
      assert.equal(auditTerms.rows[0].after_value.versions[0].serviceDimensions,undefined);
    }
    await reader.context.close();await denied.context.close();await context.close();assert.deepEqual(errors, []);assert.deepEqual(external, []);
    console.log('Retainer reversal scenario passed:',reversalScenario);
    console.log('Commercial drafting real React -> API -> disposable PostgreSQL journey passed: exact commands, persisted contract/engagement/PO/milestone, immutable future revision and pinned old terms, approved retainer invoice export and downstream billing attestation, independent retainer reversal review, completion notices, rollback and replay, protected full audit/general redaction, reload persistence, unchanged legacy work, read-only and no-access behavior.');
  } finally {try {if (browser) await browser.close();} finally {await fixtureServer.close();}}
}, {upgrade: true, afterApi: reversalScenario === 'approved credit' && process.argv.includes('--restore-credit')
    ? source => verifyRecoveredCredit(source,recoveryEvidence) : undefined});
};
await verifyCommercialDrafting('approved credit');
await verifyCommercialDrafting('stale reviewer');
