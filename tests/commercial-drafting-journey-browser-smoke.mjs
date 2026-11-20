import { INVOICE_EXPORT_EVENT_KEYS } from '../shared/invoice-export-notification.mjs';
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
      await context.addInitScript(({identity, permissions, scope, signedToken, ownerId}) => {
        sessionStorage.setItem('workos_session', JSON.stringify({id: identity.id, userName:identity.username, employeeId: ownerId, name: 'Synthetic Commercial Journey Operator', role: identity.role, permissionRole: identity.role, permissions}));
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
    const reviewRoot='/api/v1/invoice-batch-approvals';
    const reviewerGrants=[...draftGrants,grant,'approvals.view','commercial.invoice_approval.decide','commercial.invoice_approval.manage','commercial.contracts.manage'];
    for (const key of reviewerGrants) await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[key]);
    await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.invoice_approval.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
    const postAs=async(url,identity,body)=>{
      const response=await apiRequest(url,{method:'POST',identity,body});
      assert.equal(response.status,201,JSON.stringify(response.body));
      return response.body;
    };
    const nextDraft=await postAs('/api/v1/invoice-drafts/batches',identities.reader,
      {...created.request().postDataJSON(),requestId:crypto.randomUUID()});
    const nextId=nextDraft.batch.id;
    const nextLine=await postAs('/api/v1/invoice-drafts/batches/'+nextId+'/lines',identities.reader,
      {...original,requestId:crypto.randomUUID(),expectedLineCount:0});
    const sourcePath=reviewRoot+'/sources/'+nextId;
    const readSource=async identity=>{
      const result=await apiRequest(sourcePath,{identity});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
    };
    const managerSource=await readSource(identities.manager);
    const definition={entityType:'InvoiceBatch',engagementId:engagement.result.id,stages:[{userId:identities.manager.id,role:'Admin'}],
      completionInApp:true,locale:'en-US',templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed']
      .map(key=>({key,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'}))};
    const reviewPolicy=await postAs(reviewRoot+'/policies',identities.manager,{expectedOwnerKey:managerSource.ownerKey,requestId:crypto.randomUUID(),
      engagementId:engagement.result.id,expectedLatestId:null,effectiveFrom:today,definition,reason:'Independent fixed-fee batch review'});
    const submitterSource=await readSource(identities.reader);
    assert.deepEqual([submitterSource.batch.sourceType,submitterSource.batch.lines[0].eventId,submitterSource.batch.lineCount],
      ['FIXED_FEE_INSTALLMENT',registered.eventId,1]);
    const submit={expectedOwnerKey:submitterSource.ownerKey,requestId:crypto.randomUUID(),batchId:nextId,expectedPolicyId:reviewPolicy.policy.id,
      expectedLineCount:1,expectedLineageHash:submitterSource.batch.lineageHash,reason:'Review the retained fixed-fee charge'};
    const staleTotal=await apiRequest(reviewRoot+'/requests',{method:'POST',identity:identities.reader,body:{...submit,expectedLineCount:2}});
    assert.equal(staleTotal.status,409);
    const activeReview=await postAs(reviewRoot+'/requests',identities.reader,submit);
    const reviewId=activeReview.approval.id;
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1",[grant]);
    assert.equal((await apiRequest(reviewRoot+'/instances/'+reviewId,{identity:identities.manager})).status,403);
    await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key=$1",[grant]);
    const deciding=await createContext(identities.manager,reviewerGrants);
    await deciding.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const queue=deciding.page.getByRole('region',{name:'Invoice batch approvals'});
    await queue.getByLabel('Invoice approval engagement').selectOption(engagement.result.id);
    await queue.getByRole('button',{name:'Load invoice batches and reviews'}).click();
    await queue.getByLabel('Invoice batch review',{exact:true}).selectOption(reviewId);
    await queue.getByRole('button',{name:'Inspect invoice review'}).click();
    await queue.getByText(/installment 1 · due/).first().waitFor();
    await queue.getByLabel('Invoice approval decision',{exact:true}).selectOption('Approved');
    await queue.getByLabel('Invoice approval decision reason').fill('Verified contract schedule and invoice line');
    const decisionPost=deciding.page.waitForResponse(r=>r.url().endsWith('/instances/'+reviewId+'/decisions') && r.request().method()==='POST');
    await queue.getByRole('button',{name:'Record invoice approval decision'}).click();
    const decided=await decisionPost;assert.equal(decided.status(),201,await decided.text());
    assert.equal((await readSource(identities.manager)).batch.state,'Approved');
    assert.equal((await pool.query('select line_id from invoice_draft_occupancies where item_id=$1',[registered.itemId])).rows[0].line_id,nextLine.line.id);
    const exportGrants=[...reviewerGrants,'reports.export','commercial.invoice_export.view','commercial.invoice_export.create',
      'commercial.invoice_export.configure','commercial.invoice_export.recover_notices','integrations.invoice_alert_routes.manage'];
    for (const key of exportGrants) await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[key]);
    const config='/api/v1/invoice-export-notice-config', csv='/api/v1/invoice-csv';
    const configCommand={expectedOwnerKey:managerSource.ownerKey,requestId:crypto.randomUUID(),expectedLatestId:null,reason:'Deliver fixed-fee invoice notices'};
    const {route}=await postAs(config+'/routes',identities.manager,{...configCommand,routeKey:crypto.randomUUID(),label:'Synthetic billing alert',active:true});
    await postAs(config+'/policies',identities.manager,{...configCommand,requestId:crypto.randomUUID(),effectiveFrom:today,
      definition:{entityType:'InvoiceExport',engagementId:engagement.result.id,financeOwner:{userId:identities.manager.id,role:'Admin'},
        integrationAdmin:{userId:identities.reader.id,role:'Employee'},alertRouteId:route.id,locale:'en-US',completionInApp:true,
        templates:INVOICE_EXPORT_EVENT_KEYS.map(key=>({key,subject:'Invoice {{sourceRef}}',body:'Invoice status {{sourceRef}}'}))}});
    const exporting=await createContext(identities.manager,exportGrants);
    await exporting.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
    const exportUi=exporting.page.getByRole('region',{name:'Invoice CSV export'});
    await exportUi.getByLabel('Invoice export engagement').selectOption(engagement.result.id);
    await exportUi.getByRole('button',{name:'Load invoice export batches'}).click();
    await exportUi.getByLabel('Invoice export batch',{exact:true}).selectOption(nextId);
    await exportUi.getByRole('button',{name:'Inspect invoice export source'}).click();
    await exportUi.getByText(/installment 1 · due/).first().waitFor();
    await exportUi.getByLabel('Invoice CSV schema').selectOption('workos.invoice-fixed-fee-csv/1');
    await exportUi.getByRole('checkbox',{name:/I inspected the final approval/}).check();
    await exportUi.getByLabel('Invoice CSV reason').fill('Retain approved fixed-fee installment');
    const inspection=await apiRequest(csv+'/batches/'+nextId,{identity:identities.manager});
    const {batch:approved,ownerKey:exportOwner}=inspection.body;
    const stale=await apiRequest(csv+'/exports',{identity:identities.manager,method:'POST',body:{
      batchId:nextId,expectedOwnerKey:exportOwner,requestId:crypto.randomUUID(),approvalId:approved.approvalId,
      finalTransitionId:approved.finalTransitionId,lineageHash:approved.lineageHash,schemaVersion:'workos.invoice-fixed-fee-csv/1',
      expectedLineCount:approved.control.lineCount+1,expectedTotal:approved.control.total,reason:'Reject stale control total'}});
    assert.equal(stale.status,409);
    assert.equal((await readSource(identities.manager)).batch.state,'Approved');
    await pool.query("create function synthetic_fixed_fee_notice_refusal() returns trigger language plpgsql as $$begin raise exception 'Synthetic notification failure' using errcode='INC02';end$$");
    await pool.query('create trigger synthetic_fixed_fee_notice_refusal before insert on invoice_export_notice_events for each row execute function synthetic_fixed_fee_notice_refusal()');
    const exported=exporting.page.waitForResponse(r=>r.url().endsWith('/exports') && r.request().method()==='POST');
    await exportUi.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
    const generated=await exported;assert.equal(generated.status(),201,await generated.text());
    const {artifact}=await generated.json();
    const exportReplay=await apiRequest(csv+'/exports',{identity:identities.manager,method:'POST',body:generated.request().postDataJSON()});
    assert.equal(exportReplay.status,200);
    assert.equal(exportReplay.body.artifact.id,artifact.id);
    assert.equal((await pool.query('select line_id from invoice_draft_occupancies where item_id=$1',[registered.itemId])).rows[0].line_id,nextLine.line.id);
    await exportUi.getByText('Download verified invoice CSV').waitFor();
    const retained=await apiRequest(csv+'/artifacts/'+artifact.id,{identity:identities.manager});
    assert.equal(retained.body.artifact.payloadBase64,artifact.payloadBase64);
    const rows=Buffer.from(artifact.payloadBase64,'base64').toString('utf8').split('\r\n');
    assert.deepEqual(rows[1].split(',').slice(4,8),[registered.itemId,'1',registered.eventId,'FIXED_FEE_INSTALLMENT']);
    assert.equal(JSON.parse(Buffer.from(rows[1].split(',')[9].slice(4),'base64')).installment,1);
    await pool.query('drop trigger synthetic_fixed_fee_notice_refusal on invoice_export_notice_events');
    const recoveryUi=exporting.page.getByRole('region',{name:'Invoice notification recovery'});
    await recoveryUi.getByLabel('Invoice recovery engagement').selectOption(engagement.result.id);
    await recoveryUi.getByRole('button',{name:'Load invoice recovery batches'}).click();
    await recoveryUi.getByLabel('Invoice recovery batch',{exact:true}).selectOption(nextId);
    const targetsResponse=exporting.page.waitForResponse(r=>r.url().endsWith('/notice-recovery-sources/'+nextId));
    await recoveryUi.getByRole('button',{name:'Load invoice recovery targets'}).click();
    const targets=(await (await targetsResponse).json()).targets;
    assert.deepEqual(targets.map(t=>t.kind),['producer']);
    await recoveryUi.getByLabel('Invoice recovery target').selectOption(targets[0].id);
    await recoveryUi.getByLabel('Invoice recovery reason').fill('Restore the original fixed-fee export notice');
    const recovered=exporting.page.waitForResponse(r=>r.url().endsWith('/notice-recoveries') && r.request().method()==='POST');
    await recoveryUi.getByRole('button',{name:'Attempt invoice notice recovery'}).click();
    const recoveryResult=await recovered;
    assert.equal(recoveryResult.status(),201,await recoveryResult.text());
    await recoveryUi.getByText(/Recovery attempt recorded/).waitFor();
    const reread=await apiRequest(csv+'/notice-recovery-sources/'+nextId,{identity:identities.manager});
    assert.deepEqual(reread.body.targets,[]);
    const notice=await pool.query('select id from invoice_export_notice_events where batch_id=$1 and artifact_id=$2',[nextId,artifact.id]);
    assert.equal(notice.rowCount,1);
    assert.equal((await apiRequest(csv+'/artifacts/'+artifact.id,{identity:identities.manager})).body.artifact.sha256,artifact.sha256);
    await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1",[grant]);
    assert.equal((await apiRequest(csv+'/artifacts/'+artifact.id,{identity:identities.manager})).status,403);
    assert.equal((await apiRequest(csv+'/notice-recovery-sources/'+nextId,{identity:identities.manager})).status,403);
    await exporting.context.close();
    await deciding.context.close();
    await preparing.context.close();
    await billing.context.close();
    await reviewer.context.close();
    await reader.context.close();await denied.context.close();await context.close();assert.deepEqual(errors, []);assert.deepEqual(external, []);
    console.log('Commercial drafting real React -> API -> disposable PostgreSQL journey passed: exact commands, persisted contract/engagement/PO/milestone, immutable future revision and pinned old terms, protected full audit/general redaction, reload persistence, unchanged legacy work, read-only and no-access behavior.');
  } finally {try {if (browser) await browser.close();} finally {await fixtureServer.close();}}
}, {upgrade: true});
