import {adoptHourlyRate} from './support/adopt-hourly-rate.mjs';
import {verifyRecoveredCredit} from './support/retainer-credit-recovery.mjs';
import {INVOICE_EXPORT_EVENT_KEYS} from '../shared/invoice-export-notification.mjs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {recordAuditEvent} from '../server/modules/audit/audit-record.mjs';
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
  managed: ['name','model','startsOn','endsOn','effectiveFrom','currency','value','billingTerms','documents','serviceDimensions','servicePeriodCharges','number','clientId','reason'],
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
  await pool.query('update users set employee_record_id=$1 where id=$2',[ownerId,identities.manager.id]);
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values('syn-installment-reviewer','SYN-INSTALLMENT','Synthetic installment reviewer','installment@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)`,[scope.organizationId,scope.legalEntityId]);
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
    const linkReviewer=worker=>pool.query('update users set employee_record_id=$1 where id=$2',[worker,identities.reader.id]);
    await linkReviewer(null);
    assert.equal((await issue(identities.reader)).status,403);
    await assert.rejects(linkReviewer(ownerId),e=>e.code==='23505');
    await linkReviewer('employee-commercial-other-owner');
    assert.equal((await issue(identities.reader)).status,403);
    await linkReviewer('syn-installment-reviewer');
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
    await schedule.getByText(/Approval identities verified/).waitFor();
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
    const workerStatus=status=>pool.query('update employees set status=$1 where id=$2',[status,ownerId]);
    await workerStatus('On Leave');
    const unavailable=await apiRequest('/api/v1/invoice-drafts/batches/'+fixedBatch+'/lines',{method:'POST',identity:identities.reader,
      body:{expectedOwnerKey:created.request().postDataJSON().expectedOwnerKey,requestId:crypto.randomUUID(),itemId:registered.itemId,
        itemVersion:1,expectedLineCount:0,reason:'Check independent approval evidence'}});
    assert.equal(unavailable.status,409,JSON.stringify(unavailable.body));
    assert.equal((await pool.query('select 1 from invoice_draft_occupancies where item_id=$1',[registered.itemId])).rowCount,0);
    await workerStatus('Active');
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
    await workerStatus('On Leave');
    assert.equal((await apiRequest(linePath,{method:'POST',identity:identities.reader,body:original})).status,409);
    await workerStatus('Active');
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
    const identityReceipt=await pool.query('select author_worker_id,reviewer_worker_id,origin from fixed_fee_installment_identities where event_id=$1',[registered.eventId]);
    assert.deepEqual(identityReceipt.rows,[{author_worker_id:ownerId,reviewer_worker_id:'syn-installment-reviewer',origin:'issue'}]);
    await linkReviewer(null);
    await linkReviewer('syn-installment-reviewer');
    assert.equal((await issue(identities.reader)).status,409);
    assert.equal((await pool.query('select fixed_fee_identity_current($1) ok',[registered.eventId])).rows[0].ok,false);
    const historical=(await apiRequest(path,{identity:identities.reader})).body.receipts;
    assert.equal(historical.length,1);assert.equal(historical[0].identityCurrent,false);
    await linkReviewer(null);
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
    const openHistoricalTerms=async(contractId,versionId,entities)=>{
      const historyClient=await pool.connect();
      try {
        await historyClient.query('begin');
        await historyClient.query('create schema journey_retainer_clock');
        await historyClient.query("create function journey_retainer_clock.now() returns timestamptz language sql stable as $$select timestamptz '2020-01-01 12:00:00+00'$$");
        await historyClient.query('set local search_path=journey_retainer_clock,public,pg_catalog');
        for (const [type,id] of entities) {
          await historyClient.query(`insert into commercial_lifecycle_events(organization_id,legal_entity_id,entity_type,entity_id,sequence,state,effective_on,
            contract_id,contract_version_id,after_value,reason,actor_id,active_role,correlation_id,operation_id)
            values($1,$2,$3,$4,1,'Active','2020-01-01',$5,$6,jsonb_build_object('state','Active'),'Synthetic opening history',$7,'Admin',$4,$4)`,
            [scope.organizationId,scope.legalEntityId,type,id,contractId,versionId,actorId]);
        }
        await historyClient.query('drop function journey_retainer_clock.now()');
        await historyClient.query('drop schema journey_retainer_clock');
        await historyClient.query('commit');
      } catch(error) {await historyClient.query('rollback');throw error;} finally {historyClient.release();}
    };
    await openHistoricalTerms(savedRetainer.result.id,retainerVersion,[['Contract',savedRetainer.result.id],['Engagement',eng.body.id]]);
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
    const verifyInvoiceExport=async({engagementId,batchId,ownerKey,instance,permissions,schema,amount,itemId,eventId,sourceId,reviewId,sourceLabel,sourceType})=>{
      const exportKeys=['commercial.reversal_eligibility.create','commercial.invoice_batch.confirm','reports.export','commercial.invoice_export.view','commercial.invoice_export.create','commercial.invoice_export.configure','integrations.invoice_alert_routes.manage'];
      for(const role of [reviewRole,'Admin','Employee']) await pool.query(
        'insert into role_permissions(role_name,permission_key,enabled) select $1,k,true from unnest($2::text[]) k on conflict(role_name,permission_key) do update set enabled=true',[role,exportKeys]);
      const csv='/api/v1/invoice-csv', notice='/api/v1/invoice-export-notice-config';
      const configPost=(path,body)=>apiRequest(notice+path,{method:'POST',identity:finance,body:{...body,expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),reason:'Synthetic export notice configuration'}});
      const route=await configPost('/routes',{routeKey:crypto.randomUUID(),expectedLatestId:null,label:'Synthetic export notices '+sourceType,active:true});
      assert.equal(route.status,201,JSON.stringify(route.body));
      const policies=await apiRequest(notice+'/policies?engagementId='+engagementId,{identity:finance});
      assert.equal(policies.status,200,JSON.stringify(policies.body));
      const notify=await configPost('/policies',{expectedLatestId:policies.body.policies.at(-1)?.id??null,effectiveFrom:today,definition:{entityType:'InvoiceExport',engagementId:engagementId,
        financeOwner:{userId:finance.id,role:reviewRole},integrationAdmin:{userId:identities.manager.id,role:'Admin'},alertRouteId:route.body.route.id,
        locale:'en-US',templates:INVOICE_EXPORT_EVENT_KEYS.map(key=>({key,subject:'Invoice {{sourceRef}}',body:'Synthetic status {{sourceRef}}'})),completionInApp:true}});
      assert.equal(notify.status,201,JSON.stringify(notify.body));
      assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:identities.reader})).status,403);
      const exportSource=await apiRequest(csv+'/batches/'+batchId,{identity:finance});
      assert.equal(exportSource.status,200,JSON.stringify(exportSource.body));
      const exportCmd={expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId,approvalId:instance,finalTransitionId:exportSource.body.batch.finalTransitionId,
        lineageHash:exportSource.body.batch.lineageHash,schemaVersion:schema,expectedLineCount:1,expectedTotal:amount,reason:'Synthetic approved charge export'};
      const sendExport=body=>apiRequest(csv+'/exports',{method:'POST',identity:finance,body});
      assert.equal((await sendExport({...exportCmd,expectedTotal:'1'})).status,409);
      assert.equal((await sendExport({...exportCmd,schemaVersion:'workos.invoice-tm-csv/1'})).status,409);
      await pool.query("create trigger reject_test_retainer_export before insert on audit_logs for each row when (new.module='Invoice CSV') execute function reject_test_po_audit()");
      const interrupted=await sendExport(exportCmd);
      assert.equal(interrupted.status,503,JSON.stringify(interrupted.body));
      assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:finance})).body.batch.state,'Approved');
      assert.equal((await pool.query('select 1 from invoice_csv_artifacts where batch_id=$1',[batchId])).rowCount,0);
      await pool.query('drop trigger reject_test_retainer_export on audit_logs');
      const csvBrowser=await createContext(finance,[...draftGrants,...permissions,...exportKeys]);
      await csvBrowser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      const csvDesk=csvBrowser.page.getByRole('region',{name:'Invoice CSV export'});
      await csvDesk.getByLabel('Invoice export engagement').selectOption(engagementId);
      await csvDesk.getByRole('button',{name:'Load invoice export batches'}).click();
      await csvDesk.getByLabel('Invoice export batch').selectOption(batchId);
      await csvDesk.getByRole('button',{name:'Inspect invoice export source'}).click();
      await csvDesk.getByLabel('Invoice CSV schema').selectOption(schema);
      await csvDesk.getByRole('checkbox',{name:'I inspected the final approval, retained lineage and control total'}).check();
      await csvDesk.getByLabel('Invoice CSV reason').fill(exportCmd.reason);
      const saving=csvBrowser.page.waitForResponse(r=>r.url().endsWith(csv+'/exports') && r.request().method()==='POST');
      await csvDesk.getByRole('button',{name:'Accept invoice CSV artifact'}).click();
      const saved=await saving;assert.equal(saved.status(),201,await saved.text());
      await csvDesk.getByRole('region',{name:'Verified invoice CSV'}).waitFor();
      const a=(await saved.json()).artifact;
      const downloadPromise=csvBrowser.page.waitForEvent('download');
      await csvDesk.getByText('Download verified invoice CSV',{exact:true}).click();
      const stream=await (await downloadPromise).createReadStream();const chunks=[];
      for await(const chunk of stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks),Buffer.from(a.payloadBase64,'base64'));
      const bytes=Buffer.from(a.payloadBase64,'base64'),row=bytes.toString('utf8').split('\r\n')[1].split(',');
      assert.deepEqual([row[4],row[6],row[8],JSON.parse(Buffer.from(row[9].slice(4),'base64')).reviewId,row[15],row[19]],
        [itemId,eventId,sourceId,reviewId,amount,'1']);
      assert.equal((await apiRequest(csv+'/artifacts/'+a.id,{identity:identities.reader})).status,403);
      assert.equal((await pool.query('select count(*)::int n from invoice_draft_occupancies where batch_id=$1',[batchId])).rows[0].n,1);
      if (['MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD'].includes(sourceType)) {
        const rejected=await csvBrowser.page.evaluate(async artifact=>{
          const period=artifact.schemaVersion==='workos.invoice-service-period-csv/1';
          const verify=period?window.verifyPeriodInvoiceCsv:window.verifyServiceInvoiceCsv;
          const records=atob(artifact.payloadBase64).split('\r\n');
          const columns=records[1].split(',');
          const evidence=JSON.parse(atob(columns[9].slice(4)));
          if(period) evidence.contractualAmount='0.0001';
          else evidence.unitPrice='0.0001';
          columns[9]='b64:'+btoa(JSON.stringify(evidence));
          records[1]=columns.join(',');
          const payload=records.join('\r\n');
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
          const sha256=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
          const outcomes=await Promise.allSettled([
            verify({...artifact,sha256:'0'.repeat(64)}),
            verify({...artifact,payloadBase64:btoa(payload),sha256})
          ]);
          return outcomes.map(result=>result.status==='rejected'?result.reason.message:'accepted');
        },a);
        assert.deepEqual(rejected,['Checksum mismatch',sourceType==='MANAGED_SERVICE_PERIOD'?'Fixed-period contract evidence mismatch':'Service charge evidence mismatch']);
      }
      if (sourceType==='MANAGED_SERVICE_PERIOD') {
        const connection=await pool.connect();
        try {
          await connection.query('begin');
          const changed=await connection.query('update users set employee_record_id=null where id=(select author_id from commercial_service_period_reviews where id=$1) and id<>$2',[reviewId,finance.id]);
          assert.equal(changed.rowCount,1);
          const check=()=>connection.query(`select service_period_invoice_item_current(b,l.item_id,$2,$3) as current,
            invoice_source_line_visible(l.organization_id,l.legal_entity_id,l.batch_id,l.item_id,$2,$3) as correction_scope,
            invoice_source_historical_visible(l.organization_id,l.legal_entity_id,l,$2,$3) as historical from invoice_draft_lines l join invoice_draft_batches b on b.id=l.batch_id where l.batch_id=$1`,
            [batchId,finance.id,reviewRole]);
          assert.deepEqual((await check()).rows,[{current:false,correction_scope:true,historical:true}]);
          await connection.query("update role_permissions set enabled=false where role_name=$1 and permission_key='commercial.service_periods.issue'",[reviewRole]);
          assert.deepEqual((await check()).rows,[{current:false,correction_scope:false,historical:false}]);
        } finally {
          await connection.query('rollback');
          connection.release();
        }
      }
      const noticeEvents=await pool.query(
        "select id from invoice_export_notice_events where batch_id=$1 and artifact_id=$2 and event_key='invoice_batch.exported_or_billed_confirmed'",
        [batchId,a.id]);
      assert.equal(noticeEvents.rowCount,1,'Accepted invoice export must produce its configured completion notice');
      const replayExport=await sendExport(saved.request().postDataJSON());assert.equal(replayExport.body.replayed,true);
      assert.equal(replayExport.body.artifact.sha256,a.sha256);
      assert.equal((await sendExport({...saved.request().postDataJSON(),reason:'Changed reason'})).status,409);
      assert.equal((await apiRequest(csv+'/batches/'+batchId,{identity:finance})).body.batch.state,'Exported');
      const confirmations=csvBrowser.page.getByRole('region',{name:'Invoice billing confirmation'});
      await confirmations.getByLabel('Invoice confirmation engagement').selectOption(engagementId);
      await confirmations.getByRole('button',{name:'Load invoice confirmation batches'}).click();
      await confirmations.getByLabel('Invoice confirmation batch').selectOption(batchId);
      await confirmations.getByRole('button',{name:'Inspect exported invoice artifact'}).click();
      const inspected=confirmations.getByRole('region',{name:'Inspected confirmation source'});
      await inspected.getByText(sourceLabel).waitFor();
      assert.equal((await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:identities.reader})).status,403);
      const reference='Synthetic downstream invoice '+sourceType;
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
      assert.deepEqual([receipt.sourceType,receipt.artifactSha256,receipt.total,receipt.reference],[sourceType,a.sha256,a.total,reference]);
      await confirmations.getByText('Retained manual attestation '+receipt.id,{exact:false}).waitFor();
      assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[batchId])).rowCount,1);
      const attestationRequest=confirmed.request().postDataJSON();
      assert.equal((await attest(attestationRequest)).body.replayed,true);
      assert.equal((await attest({...attestationRequest,reference:'Changed reference'})).status,409);
      assert.equal((await apiRequest(csv+'/confirmation-receipts/'+attestationRequest.requestId,{identity:finance})).body.confirmation.id,receipt.id);
      assert.equal((await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:finance})).body.source.state,'Billed/Confirmed');
      assert.equal((await pool.query('select id from invoice_export_notice_events where confirmation_id=$1',[receipt.id])).rowCount,1);
      return {a,receipt,attest,attestationRequest,csv,sendExport,csvDesk,csvBrowser,exportCmd};
    };
    const verifyCorrection=async({exported,engagementId,ownerKey,batchId,lineId,policyId,original,sourceType,amount,act,reviewerKey,secondKey})=>{
      const {a,receipt,attest,attestationRequest,csv,sendExport,csvDesk,csvBrowser,exportCmd}=exported;
      const reversalPath=csv+'/batches/'+batchId+'/lines/'+lineId+'/reversal-request';
      const reverse=(path,body)=>apiRequest(reversalPath+path,{method:'POST',identity:finance,body});
      const requestBody={expectedOwnerKey:ownerKey,artifactId:a.id,sha256:a.sha256,inspectedState:'Billed/Confirmed',reason:'Reverse duplicate downstream charge'};
      assert.equal((await reverse('',{...requestBody,inspectedState:'Exported'})).status,409);
      assert.equal((await apiRequest(reversalPath,{identity:identities.reader})).status,403);
      await csvDesk.getByLabel('Invoice export engagement').selectOption(engagementId);
      await csvDesk.getByRole('button',{name:'Load invoice export batches'}).click();
      await csvDesk.getByLabel('Invoice export batch').selectOption(batchId);
      await csvDesk.getByRole('button',{name:'Inspect invoice export source'}).click();
      await csvDesk.getByRole('button',{name:'Retrieve retained invoice CSV'}).click();
      await csvDesk.getByLabel('Exported line to review').selectOption(lineId);
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
        expectedOwnerKey:key,expectedSequence:n,policyId:policyId,confirmationId:receipt.id,decision:'Approved',reason:'Verified retained service period charge'}});
      const selfReview=await pool.query(
        'select invoice_reversal_participants_valid(b.source_type,retainer_reversal_participants(b,$1,$2,$3)) ok from invoice_draft_batches b where b.id=$4',
        [identities.manager.id,identities.manager.role,policyId,batchId]);
      assert.equal(selfReview.rows[0].ok,false,'The reversal requester cannot occupy a named review stage');
      if (sourceType.startsWith('MANAGED_SERVICE_')) {
        const sourceGrant=sourceType==='MANAGED_SERVICE_PERIOD'?'commercial.service_periods.issue':'commercial.service_units.issue';
        const client=await pool.connect();
        try {
          await client.query('begin');
          const changeGrant=(permission,enabled)=>client.query("update role_permissions set enabled=$2 where role_name='Admin' and permission_key=$1",[permission,enabled]);
          const canReview=async()=>(await client.query('select invoice_reversal_participants_valid(b.source_type,retainer_reversal_participants(b,$1,$2,$3)) ok from invoice_draft_batches b where b.id=$4',[finance.id,reviewRole,policyId,batchId])).rows[0].ok;
          await changeGrant(sourceGrant,false);
          assert.equal(await canReview(),false,'Retainer access cannot authorize a managed-service correction');
          await changeGrant(sourceGrant,true);
          await changeGrant(issueGrant,false);
          assert.equal(await canReview(),true,'The original charge permission is sufficient');
        } finally {
          await client.query('rollback');
          client.release();
        }
      }
      const firstReversal=await stageDecision(identities.manager,reviewerKey,0);
      assert.equal(firstReversal.status,201,JSON.stringify(firstReversal.body));
      assert.equal(firstReversal.body.review.sourceType,sourceType);
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
        assert.equal(eligibility.source.amount,'-'+amount);
        assert.equal(eligibility.source.originalEventId,original.eventId);
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
        assert.equal(credit.amount,'-'+amount);
        const reservePath=csv+'/batches/'+batchId+'/correction-drafts';
        const reserveBody={expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),reason:'Reserve the service-period credit',itemIds:[credit.itemId]};
        const reserve=()=>apiRequest(reservePath,{method:'POST',identity:finance,body:reserveBody});
        const reserved=ok(await reserve()).receipt;
        assert.equal(reserved.total,credit.amount);
        assert.equal(ok(await reserve(),200).receipt.batchId,reserved.batchId);
        const proof=ok(await apiRequest(reservePath+'/'+reserved.batchId,{identity:finance}),200);
        assert.equal(proof.lines[0].artifactSha256,a.sha256);
        const creditSource=ok(await act('/sources/'+reserved.batchId,finance),200).batch;
        assert.equal(creditSource.lines[0].evidence.originalSourceType,sourceType);
        const creditApproval=ok(await act('/requests',finance,{expectedOwnerKey:ownerKey,requestId:crypto.randomUUID(),batchId:reserved.batchId,
          expectedPolicyId:policyId,expectedLineCount:1,expectedLineageHash:creditSource.lineageHash,reason:'Review service-period credit'})).approval;
        for(const [n,who,key] of [[0,identities.manager,reviewerKey],[1,alias,secondKey]]){
          ok(await act('/instances/'+creditApproval.id+'/decisions',who,{expectedOwnerKey:key,requestId:crypto.randomUUID(),expectedSequence:n,
            decision:'Approved',reason:'Approved reviewed service-period credit'}));
        }
        const exportCredit=ok(await apiRequest(csv+'/batches/'+reserved.batchId,{identity:finance}),200).batch;
        const creditCmd={...exportCmd,requestId:crypto.randomUUID(),batchId:reserved.batchId,approvalId:creditApproval.id,
          finalTransitionId:exportCredit.finalTransitionId,lineageHash:exportCredit.lineageHash,schemaVersion:'workos.invoice-credit-csv/1',expectedTotal:credit.amount};
        assert.equal((await sendExport({...creditCmd,expectedTotal:amount})).status,409);
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
        if (sourceType==='RETAINER_PERIOD') recoveryEvidence={finance, original:{artifact:a,confirmation:receipt,itemId:original.itemId},
          credit:{artifact:creditArtifact,confirmation:creditConfirmation,itemId:credit.itemId}};
        assert.equal(creditConfirmation.sourceType,'FULL_LINE_REVERSAL');
        assert.equal(creditConfirmation.total,credit.amount);
        assert.equal(ok(await apiRequest(csv+'/confirmation-sources/'+batchId,{identity:finance}),200).confirmation.id,receipt.id);
        const csvText=Buffer.from(creditArtifact.payloadBase64,'base64').toString('utf8');
        for(const pinned of [a.id,a.sha256,lineId]) assert.ok(csvText.includes(pinned));
        assert.equal(ok(await sendExport(acceptedCredit.request().postDataJSON()),200).artifact.sha256,creditArtifact.sha256);
        assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[reserved.batchId])).rowCount,1);
      }
      assert.equal((await pool.query('select 1 from invoice_draft_occupancies where batch_id=$1',[batchId])).rowCount,1);
    };
    const approveServiceBatchInBrowser=async({reviewer,sourceGrant,engagementId,instance,reviewId})=>{
      const reviewBrowser=await createContext(reviewer,[...draftGrants,sourceGrant,issueGrant,'approvals.view','commercial.invoice_approval.decide']);
      const reviewPage=reviewBrowser.page;await reviewPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      const desk=reviewPage.getByRole('region',{name:'Invoice batch approvals'});
      await desk.getByLabel('Invoice approval engagement').selectOption(engagementId);
      await desk.getByRole('button',{name:'Load invoice batches and reviews'}).click();
      await desk.getByLabel('Invoice batch review',{exact:true}).selectOption(instance);
      await desk.getByRole('button',{name:'Inspect invoice review'}).click();
      await desk.getByText(new RegExp(reviewId)).waitFor();
      await desk.getByLabel('Invoice approval decision',{exact:true}).selectOption('Approved');
      await desk.getByLabel('Invoice approval decision reason').fill('Verified the retained service charge and its approval evidence');
      const outcome=reviewPage.waitForResponse(r=>r.url().endsWith('/instances/'+instance+'/decisions') && r.request().method()==='POST');
      await desk.getByRole('button',{name:'Record invoice approval decision'}).click();
      const decided=await outcome;assert.equal(decided.status(),201,await decided.text());
      await reviewBrowser.context.close();
    };
    const verifyContractChargeDraft=async({engagementId,receipt,reviewId,permissions,prefix,availablePath,expectedLineAmount=receipt.amount})=>{
      const preparing=await createContext(finance,[...draftGrants,...permissions]);
      const draftPage=preparing.page;
      await draftPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      const desk=draftPage.getByRole('region',{name:'Invoice-ready draft batches'});
      const loadDrafts=()=>desk.getByRole('button',{name:'Load drafts and available items'}).click();
      await loadDrafts();
      await desk.getByLabel('Invoice engagement').selectOption(prefix==='period'?'period:'+engagementId:engagementId);
      await desk.getByLabel('Invoice period start').fill(today);
      await desk.getByLabel('Invoice period end').fill(today);
      await desk.getByLabel('Invoice period basis').selectOption('ELIGIBLE_DATE');
      await desk.getByLabel('Invoice owner user ID').fill(finance.id);
      await desk.getByLabel('Invoice owner role').fill(reviewRole);
      await desk.getByLabel('Invoice draft reason').fill('Prepare the approved contract charge');
      await desk.getByRole('checkbox',{name:'Confirm the displayed client, contract and currency'}).check();
      const post=(suffix)=>draftPage.waitForResponse(r=>r.url().endsWith('/api/v1/invoice-drafts/'+suffix) && r.request().method()==='POST');
      const creating=post('batches');
      await desk.getByRole('button',{name:'Create invoice Draft'}).click();
      const created=await creating;assert.equal(created.status(),201,await created.text());
      const batchId=(await created.json()).batch.id;
      const inspectDraft=async()=>{
        await loadDrafts();
        await desk.getByLabel('Invoice draft',{exact:true}).selectOption(batchId);
        await desk.getByRole('button',{name:'Inspect invoice draft'}).click();
      };
      await inspectDraft();
      await desk.getByLabel('Available invoice item').selectOption(prefix+':'+receipt.itemId);
      await desk.getByLabel('Invoice item reason').fill('Reserve the exact approved contract charge');
      const reserving=post('batches/'+batchId+'/lines');
      await desk.getByRole('button',{name:'Reserve selected whole item'}).click();
      const reserved=await reserving;assert.equal(reserved.status(),201,await reserved.text());
      const line=(await reserved.json()).line;
      assert.deepEqual([line.eventId,line.itemId,line.amount,line.snapshotId],
        [receipt.eventId,receipt.itemId,expectedLineAmount,null]);
      const linePath='/api/v1/invoice-drafts/batches/'+batchId+'/lines';
      const original=reserved.request().postDataJSON();
      const replay=await apiRequest(linePath,{method:'POST',identity:finance,body:original});
      assert.equal(replay.body.replayed,true,JSON.stringify(replay.body));
      const double=await apiRequest(linePath,{method:'POST',identity:finance,
        body:{...original,expectedLineCount:1,requestId:crypto.randomUUID()}});
      assert.equal(double.status,409);
      const draftsUrl='/api/v1/invoice-drafts/batches';
      if (prefix==='period') {
        const command=created.request().postDataJSON();
        assert.equal(command.definition.sourceType,'MANAGED_SERVICE_PERIOD');
        const invalidSource=await apiRequest(draftsUrl,{method:'POST',identity:finance,
          body:{...command,definition:{...command.definition,sourceType:'UNKNOWN'},requestId:crypto.randomUUID()}});
        assert.equal(invalidSource.status,400,JSON.stringify(invalidSource.body));
        const wrongModel=await apiRequest(draftsUrl,{method:'POST',identity:finance,body:{...command,
          definition:{...command.definition,engagementId:eng.body.id},requestId:crypto.randomUUID()}});
        assert.equal(wrongModel.status,409,JSON.stringify(wrongModel.body));
      }
      const otherBatch=await apiRequest(draftsUrl,{method:'POST',identity:finance,body:{...created.request().postDataJSON(),requestId:crypto.randomUUID()}});
      assert.equal(otherBatch.status,201,JSON.stringify(otherBatch.body));
      const otherPath=draftsUrl+'/'+otherBatch.body.batch.id;
      const otherCommand={...original,requestId:crypto.randomUUID()};
      const overlapping=await apiRequest(otherPath+'/lines',{method:'POST',identity:finance,body:otherCommand});
      assert.equal(overlapping.status,409);
      assert.deepEqual((await apiRequest(otherPath+'/available-'+availablePath,{identity:finance})).body.items,[]);
      const withoutAuthority=await apiRequest('/api/v1/invoice-drafts/batches/'+batchId,{identity:identities.reader});
      assert.equal(withoutAuthority.status,403);
      assert.equal((await apiRequest('/api/v1/invoice-drafts/batches',{identity:identities.reader})).body.batches.some(row=>row.id===batchId),false);
      assert.equal(line.evidence.reviewId,reviewId);

      await inspectDraft();
      await desk.getByText(/Retained lines 1/).waitFor();
      await desk.getByLabel('Cancellation reason').fill('Release the contract charge for rebatching');
      const cancelling=post('batches/'+batchId+'/cancellations');
      await desk.getByRole('button',{name:/Cancel .*draft/i}).click();
      const cancelled=await cancelling;assert.equal(cancelled.status(),201,await cancelled.text());
      assert.equal((await pool.query('select 1 from invoice_draft_occupancies where item_id=$1',[receipt.itemId])).rowCount,0);
      assert.equal((await pool.query('select 1 from invoice_draft_lines where id=$1 and event_id=$2',[line.id,receipt.eventId])).rowCount,1);
      const rebatched=await apiRequest(otherPath+'/lines',{method:'POST',identity:finance,body:otherCommand});
      assert.equal(rebatched.status,201,JSON.stringify(rebatched.body));
      assert.equal(rebatched.body.line.eventId,line.eventId);
      assert.notEqual(rebatched.body.line.id,line.id);
      await preparing.context.close();
      return {line,rebatched,otherBatch};
    };
    {
    for (const key of draftGrants) await pool.query(
      'insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true',[reviewRole,key]);
    const {line:retainerLine,rebatched,otherBatch}=await verifyContractChargeDraft({engagementId:eng.body.id,receipt:issued.body.receipt,reviewId:retainerCommand.reviewId,
      permissions:[issueGrant],prefix:'retainer',availablePath:'retainer-charges'});
    assert.equal(retainerLine.evidence.statementId,retainerCommand.statementId);
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
    const exported=await verifyInvoiceExport({
      engagementId:eng.body.id,batchId,ownerKey,instance,permissions:[issueGrant],schema:'workos.invoice-retainer-csv/1',amount:'3500',
      itemId:issued.body.receipt.itemId,eventId:issued.body.receipt.eventId,sourceId:retainerCommand.statementId,reviewId:retainerCommand.reviewId,
      sourceLabel:/retainer source/,sourceType:'RETAINER_PERIOD'});
    await verifyCorrection({exported,engagementId:eng.body.id,ownerKey,batchId,lineId:rebatched.body.line.id,policyId:stagedPolicy.body.policy.id,
      original:issued.body.receipt,sourceType:'RETAINER_PERIOD',amount:'3500',act,reviewerKey,secondKey});
    await exported.csvBrowser.context.close();
    await reviewBrowser.context.close();

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
      await button('Add fixed-period charge').click();
      const periods=[{startsOn:'2024-01-01',endsOn:'2024-01-31',amount:'100.0250'}];
      await fill(managed,{'Charge 1 start date':periods[0].startsOn,'Charge 1 end date':periods[0].endsOn,'Charge 1 amount':periods[0].amount});
      for (const term of [{startsOn:'2024-02-01',endsOn:'2024-02-29',amount:'90'},{startsOn:'2099-01-01',endsOn:'2099-01-31',amount:'80'}]) {
        periods.push(term);
        await button('Add fixed-period charge').click();
        const n=periods.length;
        await fill(managed,{['Charge '+n+' start date']:term.startsOn,['Charge '+n+' end date']:term.endsOn,['Charge '+n+' amount']:term.amount});
      }
      await fill(managed,{'Unit 1 code':'TICKET','Unit 1 label':'Accepted ticket'});
      await button('Add service unit').click();
      await fill(managed,{'Unit 2 code':'SHIFT','Unit 2 label':'Support shift','Unit 2 price (contract currency, optional)':'120.0123'});
      await managed.getByLabel('Unit 2 decimal places').selectOption('2');
      await managed.getByLabel('Unit 2 billing terms').selectOption('1');
      await button('Add service unit').click();
      await fill(managed,{'Unit 3 code':'CALL','Unit 3 label':'Support call','Unit 3 price (contract currency, optional)':'80'});
      const saved=await save('/contracts','managed');
      const units=[{code:'TICKET',label:'Accepted ticket',precision:0},{code:'SHIFT',label:'Support shift',precision:2,unitPrice:'120.0123',billingPrecision:1},{code:'CALL',label:'Support call',precision:0,unitPrice:'80'}];
      assert.deepEqual(saved.result.versions[0].serviceDimensions,units);
      assert.deepEqual(saved.result.versions[0].servicePeriodCharges,periods);
      await button('Inspect SYN-SERVICE').click();
      await page.getByText('Support shift · SHIFT · 2 decimal places · GBP 120.0123 per unit · billing rounds to 1 decimals',{exact:true}).waitFor();
      await page.getByRole('listitem').filter({hasText:'2024-01-01 to 2024-01-31 · GBP 100.0250'}).first().waitFor();
      const serviceVersion=saved.result.versions[0].id;
      const serviceEng=await apiRequest('/engagements',{method:'POST',body:{...engagement.body,model:'managed_service',code:'SYN-SERVICE-CAPTURE',
        name:'Synthetic unit capture',budget:'100',contractId:saved.result.id,contractVersionId:serviceVersion,startsOn:'2020-01-01',endsOn:'2099-12-31'}});
      assert.equal(serviceEng.status,201,JSON.stringify(serviceEng.body));
      const capturePath='/engagements/'+serviceEng.body.id+'/service-unit-evidence';
      const serviceInput={versionId:serviceVersion,serviceDate:today,dimensionCode:'SHIFT',quantity:'1.25',sourceReference:'SYN-SHIFT-1',effortHours:'0.6250'};
      const capture=(body,opts={})=>apiRequest(capturePath,{method:'POST',body,...opts});
      assert.equal((await capture(serviceInput)).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.service_units.capture',true),('Admin','commercial.lifecycle.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
      assert.equal((await capture(serviceInput)).status,422,'draft engagement cannot record delivery');
      const periodPath='/contracts/'+saved.result.id+'/versions/'+serviceVersion+'/service-periods/'+periods[0].startsOn+'/review';
      const periodGrant='commercial.service_periods.decide';
      const periodCommand={decision:'Approved',reason:'Confirmed delivery against the closed January terms'};
      const decidePeriod=(who,body)=>apiRequest(periodPath,{method:'POST',identity:who,body});
      assert.equal((await decidePeriod(finance,periodCommand)).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true),('HR',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[periodGrant]);
      assert.equal((await decidePeriod(finance,periodCommand)).status,409);
      await openHistoricalTerms(saved.result.id,serviceVersion,[['Contract',saved.result.id],['Engagement',serviceEng.body.id]]);
      assert.equal((await decidePeriod(identities.manager,periodCommand)).status,403);
      assert.equal((await decidePeriod(finance,{...periodCommand,amount:'1'})).status,400);
      await pool.query("create trigger reject_period_review_audit before insert on audit_logs for each row when(new.entity_type='Managed Service Period Review') execute function reject_test_po_audit()");
      assert.equal((await decidePeriod(finance,periodCommand)).status,503);
      assert.equal((await apiRequest(periodPath,{identity:finance})).body.review,null);
      await pool.query('drop trigger reject_period_review_audit on audit_logs');
      const valuePeriodGrant='commercial.service_periods.value';
      const periodBrowser=await createContext(finance,['commercial.contracts.view',periodGrant,valuePeriodGrant]);
      await periodBrowser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      await periodBrowser.page.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
      const periodDesk=periodBrowser.page.getByRole('group',{name:'Fixed-period charge review'});
      await periodDesk.getByLabel('Service period').selectOption(periods[0].startsOn);
      await periodDesk.getByRole('button',{name:'Inspect period decision'}).click();
      await periodDesk.getByLabel('Period decision reason').fill(periodCommand.reason);
      const periodResult=periodBrowser.page.waitForResponse(r=>r.url().endsWith(periodPath) && r.request().method()==='POST');
      await periodDesk.getByRole('button',{name:'Approve period charge'}).click();
      const periodResponse=await periodResult; assert.equal(periodResponse.status(),201,await periodResponse.text());
      const {review:periodReview}=await periodResponse.json();
      assert.deepEqual([periodReview.currency,periodReview.amount,periodReview.versionId],['GBP','100.025',serviceVersion]);
      await periodDesk.getByText(new RegExp(periodReview.id)).waitFor();
      assert.equal((await decidePeriod(finance,periodCommand)).body.review.id,periodReview.id);
      assert.equal((await decidePeriod(finance,{...periodCommand,decision:'Rejected'})).status,409);
      assert.equal((await apiRequest(periodPath,{identity:finance})).body.review.id,periodReview.id);
      const periodIssueGrant='commercial.service_periods.issue';
      const periodBillPath='/engagements/'+serviceEng.body.id+'/service-period-reviews/'+periodReview.id+'/billing';
      const issueBody={reviewId:periodReview.id,reason:'Issue the approved January fixed charge'};
      const issuePeriod=(body,who=finance)=>apiRequest(periodBillPath,body?{method:'POST',identity:who,body}:{identity:who});
      assert.equal((await issuePeriod()).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[periodIssueGrant]);
      assert.equal((await issuePeriod()).body.charge.amount,'100.025');
      assert.equal((await issuePeriod({...issueBody,amount:'100.03'})).status,400);
      assert.equal((await issuePeriod({...issueBody,reviewId:crypto.randomUUID()})).status,409);
      assert.equal((await apiRequest(periodBillPath,{identity:finance,scope:{...scope,legalEntityId:'synthetic-unassigned-entity'},method:'POST',body:issueBody})).status,403);
      const lockedIssue=await pool.connect();
      try {
        await lockedIssue.query('begin');
        await lockedIssue.query("update reporting_periods set status='Financially Locked' where id='syn-fixed-period'");
        const op=crypto.randomUUID();
        await lockedIssue.query("select set_config('workos.period_issue_operation',$1,true)",[op]);
        await assert.rejects(lockedIssue.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,
          source_type,version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,service_period_review_id)
          select gen_random_uuid(),$1,$2,s.client_id,s.contract_id,$3,'MANAGED_SERVICE_PERIOD',1,(statement_timestamp() at time zone 'UTC')::date,s.currency,
          s.amount,s.evidence||jsonb_build_object('reason',$5::text),$6,$7,$8,$4 from service_period_eligibility_source($1,$2,$3,$4) s`,
          [scope.organizationId,scope.legalEntityId,serviceEng.body.id,periodReview.id,issueBody.reason,finance.id,finance.role,op]),err=>err.code==='CTM04');
      } finally {await lockedIssue.query('rollback');lockedIssue.release();}
      await pool.query("create trigger reject_period_billing before insert on audit_logs for each row when(new.action='Issue Service Period Charge') execute function reject_test_po_audit()");
      assert.equal((await issuePeriod(issueBody)).status,503);
      assert.equal((await issuePeriod()).body.receipt,null);
      await pool.query('drop trigger reject_period_billing on audit_logs');
      const billBrowser=await createContext(finance,['commercial.contracts.view',periodIssueGrant]);
      await billBrowser.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      await billBrowser.page.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
      const approvedDesk=billBrowser.page.getByRole('group',{name:'Fixed-period charge review'});
      await approvedDesk.getByLabel('Service period').selectOption(periods[0].startsOn);
      await approvedDesk.getByRole('button',{name:'Inspect period decision'}).click();
      await billBrowser.page.getByLabel('Period billing engagement').selectOption(serviceEng.body.id);
      const billDesk=billBrowser.page.getByRole('region',{name:'Fixed-period billing'});
      await billDesk.getByRole('button',{name:'Inspect billing eligibility'}).click();
      await billDesk.getByLabel('Billing decision reason').fill(issueBody.reason);
      await billDesk.getByRole('button',{name:'Register approved-period charge'}).click();
      await billDesk.getByText(/Approved unbilled · GBP 100.025/).waitFor();
      const issuedPeriod=(await issuePeriod()).body.receipt;
      assert.equal((await issuePeriod(issueBody)).body.receipt.itemId,issuedPeriod.itemId);
      assert.equal((await issuePeriod({...issueBody,reason:'Changed decision'})).status,409);
      assert.equal((await pool.query("select count(*)::int n from commercial_service_period_valuations where review_id=$1",[periodReview.id])).rows[0].n,0);
      const entries=await pool.query(`select ev.billing_evidence,ev.amount::text from billing_eligibility_events ev join approved_unbilled_items i on i.event_id=ev.id
        where ev.service_period_review_id=$1 and i.id=$2 and ev.source_type='MANAGED_SERVICE_PERIOD'`,[periodReview.id,issuedPeriod.itemId]);
      assert.equal(entries.rowCount,1);assert.equal(entries.rows[0].billing_evidence.contractVersionId,serviceVersion);
      assert.equal(entries.rows[0].billing_evidence.endsOn,periods[0].endsOn);
      const sibling=await apiRequest('/engagements',{method:'POST',body:{...engagement.body,model:'managed_service',code:'SYN-SERVICE-PERIOD-SECOND',
        name:'Synthetic second billing engagement',budget:'100',contractId:saved.result.id,contractVersionId:serviceVersion,startsOn:'2020-01-01',endsOn:'2099-12-31'}});
      assert.equal(sibling.status,201,JSON.stringify(sibling.body));
      await openHistoricalTerms(saved.result.id,serviceVersion,[['Engagement',sibling.body.id]]);
      const siblingPath=periodBillPath.replace(serviceEng.body.id,sibling.body.id);
      assert.deepEqual((await apiRequest(siblingPath,{identity:finance})).body,{charge:null,receipt:null});
      assert.equal((await apiRequest(siblingPath,{identity:finance,method:'POST',body:issueBody})).status,409);
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events where service_period_review_id=$1',[periodReview.id])).rows[0].n,1);
      const reservedPeriod=await verifyContractChargeDraft({engagementId:serviceEng.body.id,receipt:issuedPeriod,reviewId:periodReview.id,
        permissions:[issueGrant,periodIssueGrant],prefix:'period',availablePath:'period-charges',expectedLineAmount:periods[0].amount});
      assert.equal(reservedPeriod.line.sourceType,'MANAGED_SERVICE_PERIOD');
      assert.deepEqual([reservedPeriod.line.evidence.contractVersionId,reservedPeriod.line.evidence.startsOn,reservedPeriod.line.evidence.endsOn],
        [serviceVersion,periods[0].startsOn,periods[0].endsOn]);
      let periodPolicyId,periodApprovalId;
      {
        const serviceBatchId=reservedPeriod.otherBatch.body.batch.id;
        const call=(path,who,body)=>apiRequest('/api/v1/invoice-batch-approvals'+path,body?{identity:who,method:'POST',body}:{identity:who});
        const view=await call('/sources/'+serviceBatchId,finance);
        assert.equal(view.status,200,JSON.stringify(view.body));assert.equal(view.body.batch.total,'100.025');
        const key=view.body.ownerKey,reviewer=identities.manager;
        const configure=(who,prior,more=[])=>call('/policies',finance,{expectedOwnerKey:key,requestId:crypto.randomUUID(),engagementId:serviceEng.body.id,
          expectedLatestId:prior,effectiveFrom:today,definition:{entityType:'InvoiceBatch',fullLineReversals:true,engagementId:serviceEng.body.id,locale:'en-US',completionInApp:true,
            stages:[{userId:who.id,role:who.role},...more],templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed'].map(k=>({key:k,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'}))},
          reason:'Review accepted service charges'});
        const submit=(id,hash=view.body.batch.lineageHash)=>call('/requests',finance,{requestId:crypto.randomUUID(),expectedOwnerKey:key,
          batchId:serviceBatchId,expectedPolicyId:id,expectedLineCount:1,expectedLineageHash:hash,reason:'Inspect the service invoice'});
        assert.equal((await call('/sources/'+serviceBatchId,reviewer)).status,403);
        await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[periodIssueGrant]);
        const self=await configure(finance,null);assert.equal(self.status,201,JSON.stringify(self.body));
        assert([403,409].includes((await submit(self.body.policy.id)).status));
        const policy=await configure(reviewer,self.body.policy.id);assert.equal(policy.status,201,JSON.stringify(policy.body));
        periodPolicyId=policy.body.policy.id;
        assert.equal((await submit(periodPolicyId,'0'.repeat(64))).status,409);
        const submitted=await submit(periodPolicyId);assert.equal(submitted.status,201,JSON.stringify(submitted.body));
        const instance=submitted.body.approval.id;
        periodApprovalId=instance;
        await approveServiceBatchInBrowser({reviewer,sourceGrant:periodIssueGrant,engagementId:serviceEng.body.id,instance,reviewId:periodReview.id});
        assert.equal((await call('/sources/'+serviceBatchId,finance)).body.batch.state,'Approved');
        const delivery=await verifyInvoiceExport({engagementId:serviceEng.body.id,batchId:serviceBatchId,ownerKey:key,instance,
          permissions:[issueGrant,periodIssueGrant],schema:'workos.invoice-service-period-csv/1',amount:'100.025',itemId:issuedPeriod.itemId,eventId:issuedPeriod.eventId,
          sourceId:periodReview.id,reviewId:periodReview.id,sourceLabel:/fixed-period source/,sourceType:'MANAGED_SERVICE_PERIOD'});
        const correctionPolicy=await configure(reviewer,periodPolicyId,[{userId:alias.id,role:alias.role}]);
        assert.equal(correctionPolicy.status,201,JSON.stringify(correctionPolicy.body));
        periodPolicyId=correctionPolicy.body.policy.id;
        await verifyCorrection({exported:delivery,engagementId:serviceEng.body.id,ownerKey:key,batchId:serviceBatchId,
          lineId:reservedPeriod.rebatched.body.line.id,policyId:periodPolicyId,original:issuedPeriod,sourceType:'MANAGED_SERVICE_PERIOD',amount:'100.025',act:call,
          reviewerKey:(await call('/sources/'+serviceBatchId,reviewer)).body.ownerKey,secondKey:(await call('/sources/'+serviceBatchId,alias)).body.ownerKey});
        const periodReport=(await pool.query('select service_margin_report($1,$2,$3,$4) report',
          [scope.organizationId,scope.legalEntityId,serviceEng.body.id,'2024-01-01'])).rows[0].report;
        assert.equal(periodReport.billable,'0');
        assert.equal(periodReport.billingEvents.length,2);
        assert(periodReport.billingEvents.includes(issuedPeriod.eventId));
        await delivery.csvBrowser.context.close();
        await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1",[periodIssueGrant]);
      }
      await pool.query("update role_permissions set enabled=false where role_name='HR' and permission_key=$1",[periodIssueGrant]);
      assert.equal((await apiRequest('/api/v1/invoice-drafts/batches/'+reservedPeriod.otherBatch.body.batch.id,{identity:finance})).status,403);
      await billBrowser.context.close();
      const pvPath='/engagements/'+serviceEng.body.id+'/service-period-reviews/'+periodReview.id+'/valuation';
      const periodValue=(body,who=finance)=>apiRequest(pvPath,body?{method:'POST',identity:who,body}:{identity:who});
      assert.equal((await periodValue()).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR',$1,true),('HR','commercial.service_units.policy',true) on conflict(role_name,permission_key) do update set enabled=true",[valuePeriodGrant]);
      assert.deepEqual((await periodValue()).body,{policy:null,valuation:null});
      const historicPolicy=crypto.randomUUID(),policyOperation=crypto.randomUUID();
      assert.equal((await periodValue({policyId:historicPolicy})).status,409);
      // Install the historical policy under the same database guards and audit contract as a live write.
      const historical=await pool.connect();
      try {
        await historical.query('begin');
        await historical.query('create schema journey_period_clock');
        await historical.query("create function journey_period_clock.now() returns timestamptz language sql stable as $$select timestamptz '2024-01-01 00:00:00+00'$$");
        await historical.query('set local search_path=journey_period_clock,public,pg_catalog');
        await historical.query("select set_config('workos.service_valuation',$1,true)",[JSON.stringify({id:historicPolicy,actor:finance.id,operation:policyOperation})]);
        const policyReason='Value approved contract charges at period end';
        await historical.query(`insert into commercial_service_unit_policies(id,organization_id,legal_entity_id,engagement_id,effective_from,profile,precision_digits,reason,actor_id,active_role,operation_id)
          values($1,$2,$3,$4,'2024-01-01','approved_period',2,$5,$6,$7,$8)`,[historicPolicy,scope.organizationId,scope.legalEntityId,serviceEng.body.id,policyReason,finance.id,finance.role,policyOperation]);
        await recordAuditEvent(historical,{user:{sub:finance.id,activeRole:finance.role},organizationScope:scope,operationId:policyOperation,correlationId:policyOperation},{
          module:'Commercial Drafting',action:'Recorded',entityType:'Service Valuation Policy',entityId:historicPolicy,details:'Synthetic historical policy',source:'Web',
          newValue:{engagementId:serviceEng.body.id,effectiveFrom:'2024-01-01',profile:'approved_period',precision:2,reason:policyReason}});
        await historical.query('drop schema journey_period_clock cascade');
        await historical.query('commit');
      } catch(error){await historical.query('rollback');throw error;} finally {historical.release();}
      assert.equal((await periodValue({policyId:historicPolicy})).status,409,'the source period must be open for financial reporting');
      await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
        values('syn-period-valuation',$1,$2,'SYN-PVAL','Synthetic service period end',$3,$3,'Open','Weekly')`,[scope.organizationId,scope.legalEntityId,periods[0].endsOn]);
      assert.equal((await periodValue({policyId:historicPolicy,amount:'1'})).status,400);
      await pool.query("create trigger reject_period_value_audit before insert on audit_logs for each row when(new.entity_type='Service Period Valuation') execute function reject_test_po_audit()");
      assert.equal((await periodValue({policyId:historicPolicy})).status,503);
      assert.equal((await periodValue()).body.valuation,null);
      await pool.query('drop trigger reject_period_value_audit on audit_logs');
      const wrongScope=await apiRequest(pvPath,{identity:finance,method:'POST',scope:{...scope,legalEntityId:'synthetic-unassigned-entity'},body:{policyId:historicPolicy}});
      assert.equal(wrongScope.status,403);
      const registerCount=async()=>Number((await pool.query('select count(*) n from approved_unbilled_items')).rows[0].n);
      const registerBeforePeriodValue=await registerCount();
      const stalePeriodValue=await pool.connect();
      try {
        await stalePeriodValue.query('begin');
        const original=(await stalePeriodValue.query('select employee_record_id from users where id=$1',[finance.id])).rows[0].employee_record_id;
        await stalePeriodValue.query('update users set employee_record_id=null where id=$1',[finance.id]);
        await stalePeriodValue.query('update users set employee_record_id=$2 where id=$1',[finance.id,original]);
        const id=crypto.randomUUID(),operation=crypto.randomUUID();
        await stalePeriodValue.query("select set_config('workos.service_valuation',$1,true)",[JSON.stringify({id,actor:finance.id,operation})]);
        await assert.rejects(stalePeriodValue.query(`insert into commercial_service_period_valuations
          (organization_id,legal_entity_id,engagement_id,review_id,policy_id,id,actor_id,active_role,operation_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[scope.organizationId,scope.legalEntityId,serviceEng.body.id,periodReview.id,historicPolicy,id,finance.id,finance.role,operation]),
          err=>err.code==='MSV02' && err.message.includes('identity changed'));
      } finally {await stalePeriodValue.query('rollback');stalePeriodValue.release();}
      const valuationDesk=periodBrowser.page.getByRole('region',{name:'Fixed-period operational valuation'});
      await valuationDesk.getByLabel('Period valuation engagement').selectOption(serviceEng.body.id);
      await valuationDesk.getByRole('button',{name:'Inspect period valuation'}).click();
      await valuationDesk.getByRole('button',{name:'Record period value'}).click();
      await valuationDesk.getByText('Operational management value · GBP 100.03',{exact:true}).waitFor();
      const retained=(await periodValue()).body.valuation;
      assert.equal(await registerCount(),registerBeforePeriodValue,'Operational valuation must not issue a billing item');
      assert.deepEqual([retained.sourceAmount,retained.amount,retained.policyId,retained.reviewId],['100.025','100.03',historicPolicy,periodReview.id]);
      await pool.query("update reporting_periods set status='Financially Locked' where id='syn-period-valuation'");
      assert.equal((await periodValue({policyId:historicPolicy})).body.id,retained.id);
      await assert.rejects(pool.query('delete from commercial_service_period_valuations where id=$1',[retained.id]));
      const decideOther=(term,who,decision)=>apiRequest(periodPath.replace(periods[0].startsOn,term.startsOn),{method:'POST',identity:who,body:{decision,reason:'Reconcile service delivery exception'}});
      assert.equal((await decideOther(periods[2],finance,'Approved')).status,409);
      const stale=await pool.connect();
      try {
        await stale.query('begin');
        const worker=(await stale.query('select employee_record_id from users where id=$1',[finance.id])).rows[0].employee_record_id;
        await stale.query('update users set employee_record_id=null where id=$1',[finance.id]);
        await stale.query('update users set employee_record_id=$2 where id=$1',[finance.id,worker]);
        const id=crypto.randomUUID(),operation=crypto.randomUUID();
        await stale.query("select set_config('workos.period_review',$1,true)",[JSON.stringify({id,actor:finance.id,operation})]);
        await assert.rejects(stale.query(`insert into commercial_service_period_reviews
          (organization_id,legal_entity_id,contract_id,version_id,starts_on,id,actor_id,active_role,operation_id,decision,reason)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,'Approved','Synthetic stale worker check')`,
          [scope.organizationId,scope.legalEntityId,saved.result.id,serviceVersion,periods[1].startsOn,id,finance.id,finance.role,operation]),err=>err.code==='MSP02');
      } finally {await stale.query('rollback');stale.release();}
      const declined=await decideOther(periods[1],finance,'Rejected');
      assert.equal(declined.status,201,JSON.stringify(declined.body));
      assert.equal(declined.body.review.decision,'Rejected');
      await pool.query("update role_permissions set enabled=true where role_name='HR' and permission_key=$1",[periodIssueGrant]);
      assert.equal((await apiRequest(periodBillPath.replace(periodReview.id,declined.body.review.id),{identity:finance})).status,404);
      await pool.query("update role_permissions set enabled=false where role_name='HR' and permission_key=$1",[periodIssueGrant]);
      assert.equal((await apiRequest(pvPath.replace(periodReview.id,declined.body.review.id),{identity:finance})).status,404);
      assert.equal((await decideOther(periods[1],finance,'Approved')).status,409);
      await periodBrowser.context.close();
      assert.equal((await capture({...serviceInput,recorderWorkerId:ownerId})).status,400);
      await pool.query('update users set employee_record_id=null where id=$1',[actorId]);
      assert.equal((await capture(serviceInput)).status,403,'unlinked recorder cannot create evidence');
      await pool.query('update users set employee_record_id=$2 where id=$1',[actorId,ownerId]);
      assert.equal((await capture({...serviceInput,quantity:'1.251'})).status,422);
      assert.equal((await capture({...serviceInput,dimensionCode:'UNKNOWN'})).status,422);
      assert.equal((await capture({...serviceInput,serviceDate:future})).status,422);
      assert.equal((await capture({...serviceInput,versionId})).status,422);
      assert.equal((await capture(serviceInput,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
      await open();await button('Inspect SYN-SERVICE').click();
      const captureForm=form('Record delivered units');
      await captureForm.getByLabel('Service engagement').selectOption(serviceEng.body.id);
      await captureForm.getByLabel('Delivered unit').selectOption('SHIFT');
      await fill(captureForm,{'Service date':today,'Delivered quantity':'1.25','Your effort in hours (optional)':'0.6250','Service evidence reference':'SYN-SHIFT-1'});
      await button('Record service evidence').click();
      await captureForm.getByText(/Service evidence recorded/).waitFor();
      await captureForm.getByText(today+' · 1.25 SHIFT · SYN-SHIFT-1').waitFor();
      await captureForm.getByText('Recorded effort · 0.625 hours').waitFor();
      const replay=await capture(serviceInput);assert.equal(replay.status,201,JSON.stringify(replay.body));
      assert.equal(replay.body.effortHours,'0.625');
      const equivalent=await capture({...serviceInput,effortHours:'0.625'});
      assert.equal(equivalent.body.id,replay.body.id);
      assert.equal((await capture({...serviceInput,effortHours:undefined})).status,409);
      assert.equal((await capture({...serviceInput,effortHours:'1'})).status,409);
      for(const effortHours of ['0','-1','24.0001','0.00001','1e1',1,null]) {
        assert.equal((await capture({...serviceInput,effortHours})).status,400);
      }
      assert.equal((await capture({...serviceInput,costAmount:'25'})).status,400);
      const asContractReader=await apiRequest(capturePath+'?versionId='+serviceVersion,{identity:identities.reader});
      assert.equal(asContractReader.status,200,JSON.stringify(asContractReader.body));
      const visibleUnit=asContractReader.body.records.find(row=>row.id===replay.body.id);
      assert.equal(visibleUnit.quantity,'1.25');
      assert.equal(Object.hasOwn(visibleUnit,'effortHours'),false);
      const linkCheck=await pool.connect();
      try {
        await linkCheck.query('begin');
        await linkCheck.query('update users set employee_record_id=null where id=$1',[actorId]);
        await linkCheck.query('update users set employee_record_id=$2 where id=$1',[actorId,ownerId]);
        const {rows}=await linkCheck.query('select service_unit_effort_recorder_current(e) as current from commercial_service_unit_evidence e where e.id=$1',[replay.body.id]);
        assert.deepEqual(rows,[{current:false}]);
      } finally {await linkCheck.query('rollback');linkCheck.release();}
      const effortAudit=await pool.query("select new_value->>'effortHours' as hours from audit_logs where entity_id=$1 and action='Recorded' and entity_type='Managed Service Evidence'",[replay.body.id]);
      assert.deepEqual(effortAudit.rows,[{hours:'0.625'}]);
      assert.equal((await capture({...serviceInput,quantity:'2'})).status,409);
      const evidence=await pool.query('select quantity::text,actor_id,recorder_worker_id,recorder_link_generation::text from commercial_service_unit_evidence where engagement_id=$1',[serviceEng.body.id]);
      const generation=(await pool.query('select coalesce(max(generation),0)::text generation from invoice_reviewer_link_changes where account_id=$1',[actorId])).rows[0].generation;
      assert.deepEqual(evidence.rows,[{quantity:'1.25',actor_id:actorId,recorder_worker_id:ownerId,recorder_link_generation:generation}]);
      await assert.rejects(pool.query('delete from commercial_service_unit_evidence where id=$1',[replay.body.id]));
      const decisionGrant='commercial.service_units.decide';
      const reason='Delivery verified against the shift register';
      const reviewUnits=(id,decision,who=finance,options={})=>apiRequest(capturePath+'/'+id+'/review',{
        method:'POST',identity:who,body:{decision,reason},...options});
      assert.equal((await reviewUnits(replay.body.id,'Accepted')).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR',$1,true),('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[decisionGrant]);
      assert.equal((await reviewUnits(replay.body.id,'Accepted',identities.manager)).status,403);
      assert.equal((await reviewUnits(replay.body.id,'Accepted',finance,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
      assert.equal((await reviewUnits(replay.body.id,'Accepted',finance,{body:{decision:'Accepted',reason,actorId}})).status,400);
      const serviceReviewer=await createContext(finance,['commercial.contracts.view',decisionGrant]);
      const reviewerPage=serviceReviewer.page;
      await reviewerPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      await reviewerPage.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
      await reviewerPage.getByLabel('Service engagement').selectOption(serviceEng.body.id);
      await reviewerPage.getByRole('button',{name:'Review SYN-SHIFT-1',exact:true}).click();
      await reviewerPage.getByLabel('Decision reason').fill(reason);
      await reviewerPage.getByRole('button',{name:'Accept units',exact:true}).click();
      await reviewerPage.getByText('Accepted · '+reason,{exact:true}).waitFor();
      await serviceReviewer.context.close();
      const accepted=await reviewUnits(replay.body.id,'Accepted');assert.equal(accepted.status,201,JSON.stringify(accepted.body));
      assert.equal((await reviewUnits(replay.body.id,'Rejected')).status,409);
      {
        const path=capturePath+'/'+replay.body.id+'/effort-cost';
        const captureCost=(body,identity=identities.manager)=>apiRequest(path,{identity,method:'POST',body});
        const costPermission='commercial.service_cost.record';
        assert.equal((await apiRequest(path)).status,403);
        const costGrants=[costPermission,decisionGrant,'commercial.service_margin.view','commercial.service_margin.record','reports.view_utilization','commercial.service_cost.view','commercial.cost_candidates.manage','commercial.cost_candidates.view','commercial.cost_approvals.decide','employees.view','approvals.view'];
        await pool.query("insert into role_permissions(role_name,permission_key,enabled) select 'Admin',k,true from unnest($1::text[]) k on conflict(role_name,permission_key) do update set enabled=true",[costGrants]);
        await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin' on conflict do nothing",[finance.id]);
        const costReader=()=>apiRequest(path);
        assert.equal((await apiRequest(path,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
        assert.deepEqual((await costReader()).body,{snapshot:null,preview:null});
        assert.equal((await apiRequest(path,{identity:identities.reader})).status,403);
        const rate=(amount,priority,currency='GBP',effectiveFrom=today)=>adoptHourlyRate({request:apiRequest,ids:{manager:identities.manager,second:{...finance,role:'Admin'}},
          workerId:ownerId,today,end:future,currency,effectiveFrom},'cost',amount,priority);
        await rate('20',1,'USD');
        await rate('40',10,'GBP',future);
        assert.deepEqual((await costReader()).body,{snapshot:null,preview:null});
        const first=await rate('10',1);
        const command={reviewId:accepted.body.id,adoptionId:first.id};
        assert.equal((await costReader()).body.preview.amount,'6.25');
        await rate('12',1);
        assert.equal((await costReader()).body.preview,null);
        assert.equal((await captureCost(command)).status,409);
        const adopted=await rate('12.3457',2);
        assert.equal((await captureCost({...command,adoptionId:adopted.id,amount:'1'})).status,400);
        await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1",[costPermission]);
        assert.equal((await costReader()).body.preview.amount,'7.7160625');
        assert.equal((await captureCost({...command,adoptionId:adopted.id})).status,403);
        await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key=$1",[costPermission]);
        const locked=await pool.connect();
        try {
          await locked.query('begin');
          await locked.query("update reporting_periods set status='Financially Locked' where id='syn-fixed-period'");
          const id=crypto.randomUUID(),operation=crypto.randomUUID();
          await locked.query("select set_config('workos.service_effort_cost',$1,true)",[JSON.stringify({id,actor:actorId,operation})]);
          await assert.rejects(locked.query(`insert into commercial_service_effort_costs(id,organization_id,legal_entity_id,engagement_id,
            evidence_id,review_id,adoption_id,actor_id,active_role,operation_id) values($1,$2,$3,$4,$5,$6,$7,$8,'Admin',$9)`,
            [id,scope.organizationId,scope.legalEntityId,serviceEng.body.id,replay.body.id,accepted.body.id,adopted.id,actorId,operation]),err=>err.code==='CTM04');
        } finally {await locked.query('rollback');locked.release();}
        await pool.query("create trigger reject_effort_cost_audit before insert on audit_logs for each row when (new.entity_type='Managed Service Effort Cost') execute function reject_test_po_audit()");
        const failed=await captureCost({...command,adoptionId:adopted.id});
        assert(failed.status>=500,JSON.stringify(failed.body));
        assert.equal((await costReader()).body.snapshot,null);
        await pool.query('drop trigger reject_effort_cost_audit on audit_logs');
        const operator=await createContext(identities.manager,['commercial.contracts.view',...costGrants]);
        const costPage=operator.page;
        await costPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
        await costPage.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
        await costPage.getByLabel('Service engagement').selectOption(serviceEng.body.id);
        await costPage.getByRole('button',{name:'Compare approved effort'}).click();
        await costPage.getByText('No approved work has this reference.').waitFor();
        const costDesk=costPage.getByRole('region',{name:'Service effort cost'});
        await costDesk.getByRole('button',{name:'Inspect effort cost'}).click();
        await costDesk.getByText(/Estimated cost · GBP 7.7160625/).waitFor();
        await costDesk.getByRole('button',{name:'Retain effort cost'}).click();
        await costDesk.getByText(/Retained cost · GBP 7.7160625/).waitFor();
        const margin=costPage.getByRole('region',{name:'Managed-service period margin'});
        await margin.getByRole('button',{name:'Inspect month'}).click();
        await margin.getByText(/Retained worker cost 7.7160625/).waitFor();
        await margin.getByRole('button',{name:'Retain month'}).click();
        await margin.getByText(/Retained version 1/).waitFor();
        await operator.context.close();
        const retained=(await costReader()).body.snapshot;
        assert.deepEqual([retained.reviewId,retained.adoptionId,retained.hourlyRate,retained.hours,retained.amount],[accepted.body.id,adopted.id,'12.3457','0.625','7.7160625']);
        await rate('35',3);
        assert.deepEqual((await costReader()).body,{snapshot:retained,preview:null});
        assert.equal((await captureCost({...command,adoptionId:adopted.id})).body.snapshot.id,retained.id);
        assert.equal((await captureCost(command)).status,409);
        assert.equal(retained.priority,2);
        assert.equal(retained.resolutionRule,'worker-hourly-priority/1');
        assert.equal((await pool.query("select 1 from audit_logs where entity_id=$1 and new_value ? 'amount'",[retained.id])).rowCount,0);
        await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='employees.view'");
        assert.equal((await costReader()).status,404);
        await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='employees.view'");
        await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.cost_candidates.view'");
        assert.equal((await costReader()).status,403);
      }
      const billPath=id=>capturePath+'/'+id+'/billing';
      const serviceBill=(id,reviewId,opts={})=>apiRequest(billPath(id),{method:'POST',identity:finance,body:{reviewId,reason:'Register verified support shift'},...opts});
      const issueKey='commercial.service_units.issue';
      assert.equal((await serviceBill(replay.body.id,accepted.body.id)).status,403);
      await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[issueKey]);
      assert.equal((await serviceBill(replay.body.id,accepted.body.id,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
      assert.equal((await serviceBill(replay.body.id,accepted.body.id,{body:{reviewId:accepted.body.id,amount:'9000',reason:'Invalid forged amount'}})).status,400);
      const billOperator=await createContext(finance,['commercial.contracts.view',issueKey]);
      const billPage=billOperator.page;
      await billPage.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      await billPage.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
      await billPage.getByLabel('Service engagement').selectOption(serviceEng.body.id);
      await billPage.getByRole('button',{name:'Inspect billing eligibility',exact:true}).click();
      await billPage.getByText('Contractual charge · GBP 150.0',{exact:true}).waitFor();
      await billPage.getByLabel('Billing decision reason').fill('Register verified support shift');
      await billPage.getByRole('button',{name:'Register accepted-unit charge',exact:true}).click();
      await billPage.getByText(/Approved unbilled · GBP 150.0000/).waitFor();
      await billOperator.context.close();
      const billReceipt=await serviceBill(replay.body.id,accepted.body.id);
      assert.equal(billReceipt.status,201,JSON.stringify(billReceipt.body));
      assert.equal(billReceipt.body.receipt.amount,'150.0000');
      assert.equal((await pool.query('select count(*)::int n from commercial_service_unit_valuations')).rows[0].n,0);
      const link=await pool.query('select source_type,billing_evidence from billing_eligibility_events where id=$1',[billReceipt.body.receipt.eventId]);
      assert.equal(link.rows[0].source_type,'MANAGED_SERVICE_UNIT');assert.equal(link.rows[0].billing_evidence.contractVersionId,serviceVersion);
      assert.equal(link.rows[0].billing_evidence.quantity,'1.25');assert.equal(link.rows[0].billing_evidence.billingPrecision,1);
      {
        const {line,otherBatch,rebatched}=await verifyContractChargeDraft({engagementId:serviceEng.body.id,receipt:billReceipt.body.receipt,reviewId:accepted.body.id,
          permissions:[issueGrant,issueKey],prefix:'unit',availablePath:'service-charges'});
        assert.equal(line.evidence.dimensionCode,'SHIFT');assert.equal(line.evidence.quantity,'1.25');
        const serviceBatchId=otherBatch.body.batch.id,base='/api/v1/invoice-batch-approvals';
        const call=(path,who,body)=>apiRequest(base+path,body?{identity:who,method:'POST',body}:{identity:who});
        const view=await call('/sources/'+serviceBatchId,finance);
        assert.equal(view.status,200,JSON.stringify(view.body));
        assert.equal(view.body.batch.sourceType,'MANAGED_SERVICE_UNIT');assert.equal(view.body.batch.lines[0].evidence.reviewId,accepted.body.id);
        const key=view.body.ownerKey,reviewer=identities.manager;
        const configure=(who,prior,more=[])=>call('/policies',finance,{expectedOwnerKey:key,requestId:crypto.randomUUID(),engagementId:serviceEng.body.id,
          expectedLatestId:prior,effectiveFrom:today,definition:{entityType:'InvoiceBatch',fullLineReversals:true,engagementId:serviceEng.body.id,locale:'en-US',completionInApp:true,
            stages:[{userId:who.id,role:who.role},...more],templates:['approval.action_required','approval.rejected_or_correction_required','approval.completed'].map(k=>({key:k,subject:'Review {{sourceRef}}',body:'Stage {{stageNumber}}'}))},
          reason:'Review accepted service charges'});
        assert.equal((await call('/sources/'+serviceBatchId,reviewer)).status,403);
        assert.equal((await configure(reviewer,periodPolicyId)).status,403);
        await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[issueKey]);
        const unitHistory=await call('/instances?engagementId='+serviceEng.body.id,reviewer);
        assert.equal(unitHistory.status,200,JSON.stringify(unitHistory.body));
        assert(!unitHistory.body.approvals.some(x=>x.id===periodApprovalId));
        assert.equal((await call('/instances/'+periodApprovalId,reviewer)).status,403);
        const self=await configure(finance,periodPolicyId);assert.equal(self.status,201,JSON.stringify(self.body));
        const submit=(id,hash=view.body.batch.lineageHash)=>call('/requests',finance,{requestId:crypto.randomUUID(),expectedOwnerKey:key,
          batchId:serviceBatchId,expectedPolicyId:id,expectedLineCount:1,expectedLineageHash:hash,reason:'Inspect the service invoice'});
        assert([403,409].includes((await submit(self.body.policy.id)).status));
        const policy=await configure(reviewer,self.body.policy.id);assert.equal(policy.status,201,JSON.stringify(policy.body));
        assert.equal((await submit(policy.body.policy.id,'0'.repeat(64))).status,409);
        const submitted=await submit(policy.body.policy.id);assert.equal(submitted.status,201,JSON.stringify(submitted.body));
        const instance=submitted.body.approval.id;
        await approveServiceBatchInBrowser({reviewer,sourceGrant:issueKey,engagementId:serviceEng.body.id,instance,reviewId:accepted.body.id});
        assert.equal((await call('/sources/'+serviceBatchId,finance)).body.batch.state,'Approved');
        const exported=await verifyInvoiceExport({engagementId:serviceEng.body.id,batchId:serviceBatchId,ownerKey:key,instance,permissions:[issueGrant,issueKey],
          schema:'workos.invoice-service-unit-csv/1',amount:'150',itemId:billReceipt.body.receipt.itemId,eventId:billReceipt.body.receipt.eventId,
          sourceId:replay.body.id,reviewId:accepted.body.id,sourceLabel:/managed-service source/,sourceType:'MANAGED_SERVICE_UNIT'});
        const correctionPolicy=await configure(reviewer,policy.body.policy.id,[{userId:alias.id,role:alias.role}]);
        assert.equal(correctionPolicy.status,201,JSON.stringify(correctionPolicy.body));
        await verifyCorrection({exported,engagementId:serviceEng.body.id,ownerKey:key,batchId:serviceBatchId,lineId:rebatched.body.line.id,
          policyId:correctionPolicy.body.policy.id,original:billReceipt.body.receipt,sourceType:'MANAGED_SERVICE_UNIT',amount:'150',act:call,
          reviewerKey:(await call('/sources/'+serviceBatchId,reviewer)).body.ownerKey,secondKey:(await call('/sources/'+serviceBatchId,alias)).body.ownerKey});
        const unitReport=(await pool.query('select service_margin_report($1,$2,$3,$4) report',
          [scope.organizationId,scope.legalEntityId,serviceEng.body.id,today.slice(0,7)+'-01'])).rows[0].report;
        assert.equal(unitReport.billable,'0');
        assert.equal(unitReport.billingEvents.length,2);
        assert(unitReport.billingEvents.includes(billReceipt.body.receipt.eventId));
        const unitOwnerCheck=await pool.connect();
        try {
          await unitOwnerCheck.query('begin');
          await unitOwnerCheck.query('set constraints all immediate');
          await unitOwnerCheck.query('update role_permissions set enabled=false where role_name=$1 and permission_key=$2',[reviewRole,issueKey]);
          await unitOwnerCheck.query('update role_permissions set enabled=true where role_name=$1 and permission_key=$2',[reviewRole,issueKey]);
          assert.equal((await unitOwnerCheck.query('select 1 from invoice_draft_owner_losses where batch_id=$1',[serviceBatchId])).rowCount,1);
        } finally {
          await unitOwnerCheck.query('rollback');
          unitOwnerCheck.release();
        }
        await exported.csvBrowser.context.close();
      }
      const withoutEffort={...serviceInput,effortHours:undefined,sourceReference:'SYN-NONCHARGE',quantity:'1',dimensionCode:'CALL'};
      const [noncharge,concurrentCapture]=await Promise.all([capture(withoutEffort),capture(withoutEffort)]);
      assert.equal(noncharge.status,201,JSON.stringify(noncharge.body));assert.equal(concurrentCapture.body.id,noncharge.body.id);
      assert.equal(Object.hasOwn(noncharge.body,'effortHours'),false);
      const nonchargeReview=await reviewUnits(noncharge.body.id,'Accepted');
      assert.equal(nonchargeReview.status,201);
      assert.equal((await serviceBill(noncharge.body.id,nonchargeReview.body.id)).status,409,'a price alone cannot authorize billing');
      assert.equal((await pool.query("select count(*)::int n from billing_eligibility_events where source_type='MANAGED_SERVICE_UNIT'")).rows[0].n,1);
      const policyPath='/engagements/'+serviceEng.body.id+'/service-valuation-policy';
      const valuationPath=capturePath+'/'+replay.body.id+'/valuation';
      const valueRead=(path,identity=finance)=>apiRequest(path,{identity});
      const valuePost=(path,body,options={})=>apiRequest(path,{identity:finance,method:'POST',body,...options});
      const valAccess=['commercial.service_units.policy','commercial.service_units.value'];
      assert.equal((await valueRead(valuationPath)).status,403);
      for(const k of valAccess) await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('HR',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[k]);
      const aheadOfUnitPolicy=(await valueRead(valuationPath)).body;
      assert.equal(aheadOfUnitPolicy.valuation,null);assert.equal(aheadOfUnitPolicy.policy.id,historicPolicy);
      assert.equal((await valuePost(valuationPath,{policyId:historicPolicy,reviewId:accepted.body.id})).status,409);
      assert.equal((await valuePost(valuationPath,{policyId:crypto.randomUUID(),reviewId:accepted.body.id})).status,409);
      const operator=await createContext(finance,['commercial.contracts.view',...valAccess]);
      const op=operator.page;await op.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
      await op.getByRole('button',{name:'Inspect SYN-SERVICE',exact:true}).click();
      await op.getByLabel('Service engagement').selectOption(serviceEng.body.id);
      await op.getByRole('button',{name:'Inspect valuation policy',exact:true}).click();
      await op.getByText('Current policy: Approved fixed periods',{exact:true}).waitFor();
      await op.getByLabel('Operational valuation profile').selectOption('accepted_unit');
      await op.getByLabel('Policy effective date').fill(today);
      await op.getByLabel('Policy decision reason').fill('Value accepted support shifts');
      await op.getByRole('button',{name:'Schedule policy',exact:true}).click();
      await op.getByText('Current policy: Accepted units',{exact:true}).waitFor();
      const policy=(await valueRead(policyPath)).body.effective;
      assert.equal((await periodValue()).body.valuation.id,retained.id,'Later policy versions preserve historical period valuation');
      const valuateBody={policyId:policy.id,reviewId:accepted.body.id};
      assert.equal((await valuePost(valuationPath,{...valuateBody,amount:'9000'})).status,400);
      assert.equal((await valuePost(valuationPath,valuateBody,{scope:{...scope,legalEntityId:'synthetic-unassigned-entity'}})).status,403);
      const futurePolicy=await valuePost(policyPath,{previousId:policy.id,effectiveFrom:future,profile:'disabled',precision:null,reason:'End management valuation'});
      assert.equal(futurePolicy.status,201,JSON.stringify(futurePolicy.body));
      await op.getByRole('region',{name:'Recorded service evidence'}).getByRole('listitem').filter({hasText:'SYN-SHIFT-1'}).getByRole('button',{name:'Inspect operational valuation',exact:true}).click();
      await op.getByRole('button',{name:'Record operational value',exact:true}).click();
      await op.getByText('Operational management value · GBP 150.02 · 1.25 units at 120.0123',{exact:true}).waitFor();
      const snapshot=await valuePost(valuationPath,valuateBody);
      assert.equal(snapshot.status,201);assert.equal(snapshot.body.versionId,serviceVersion);assert.equal(snapshot.body.amount,'150.02');
      await assert.rejects(pool.query('delete from commercial_service_unit_valuations where id=$1',[snapshot.body.id]));
      await operator.context.close();
      const unpriced=await capture({...serviceInput,sourceReference:'SYN-TICKET-VAL',quantity:'1',dimensionCode:'TICKET'});
      const reviewedTicket=await reviewUnits(unpriced.body.id,'Accepted');
      assert.equal(reviewedTicket.status,201);
      assert.equal((await serviceBill(unpriced.body.id,reviewedTicket.body.id)).status,409);
      assert.equal((await valuePost(capturePath+'/'+unpriced.body.id+'/valuation',{...valuateBody,reviewId:reviewedTicket.body.id})).status,409);
      const second=await capture({...serviceInput,sourceReference:'SYN-SHIFT-2'});
      const concurrent=await Promise.all([reviewUnits(second.body.id,'Rejected'),reviewUnits(second.body.id,'Rejected')]);
      assert(concurrent.every(r=>r.status===201));assert.equal(concurrent[0].body.id,concurrent[1].body.id);
      assert.equal((await reviewUnits(second.body.id,'Accepted')).status,409);
      assert.equal((await serviceBill(second.body.id,concurrent[0].body.id)).status,409);
      assert.equal((await valuePost(capturePath+'/'+second.body.id+'/valuation',{...valuateBody,reviewId:concurrent[0].body.id})).status,409);
      const lockReceipt=await capture({...serviceInput,sourceReference:'SYN-LOCKED-VALUE'});
      const lockReview=await reviewUnits(lockReceipt.body.id,'Accepted');
      assert.equal(lockReview.status,201);
      await pool.query("update reporting_periods set status='Financially Locked' where id='syn-fixed-period'");
      assert.equal((await serviceBill(lockReceipt.body.id,lockReview.body.id)).status,409);
      assert.equal((await serviceBill(replay.body.id,accepted.body.id)).body.receipt.itemId,billReceipt.body.receipt.itemId);
      assert.equal((await valuePost(capturePath+'/'+lockReceipt.body.id+'/valuation',{...valuateBody,reviewId:lockReview.body.id})).status,409);
      assert.equal((await valuePost(valuationPath,valuateBody)).body.id,snapshot.body.id,'locked period preserves idempotent historical receipt');
      assert.equal((await pool.query('select count(*)::int n from commercial_service_unit_valuations')).rows[0].n,1);
      await assert.rejects(pool.query('delete from commercial_service_unit_reviews where id=$1',[accepted.body.id]));
      const third=await capture({...serviceInput,sourceReference:'SYN-SHIFT-3'});
      await pool.query('update users set employee_record_id=null where id=$1',[finance.id]);
      await pool.query("update users set employee_record_id='syn-retainer-reviewer' where id=$1",[finance.id]);
      assert.equal((await reviewUnits(third.body.id,'Accepted')).status,403,'relinked reviewer cannot accept earlier evidence');
      const fourth=await capture({...serviceInput,sourceReference:'SYN-SHIFT-4'});
      const priorAliasWorker=(await pool.query('select employee_record_id from users where id=$1',[alias.id])).rows[0].employee_record_id;
      await pool.query('update users set employee_record_id=null where id=$1',[actorId]);
      await pool.query('update users set employee_record_id=$2 where id=$1',[alias.id,ownerId]);
      assert.equal((await reviewUnits(fourth.body.id,'Accepted',alias)).status,403,'an account now linked to the recorder worker cannot review');
      await pool.query('update users set employee_record_id=$2 where id=$1',[alias.id,priorAliasWorker]);
      await pool.query('update users set employee_record_id=$2 where id=$1',[actorId,ownerId]);
      assert.equal((await reviewUnits(fourth.body.id,'Accepted')).status,403,'restored recorder link cannot validate earlier evidence');
      assert.equal((await pool.query('select count(*)::int n from commercial_service_unit_reviews')).rows[0].n,5);
      const {number,clientId:client,...revision}=saved.body;
      const path='/contracts/'+saved.result.id+'/versions';
      const revise=(body,identity=identities.manager)=>apiRequest(path,{method:'POST',identity,body});
      const next={...revision,expectedVersion:1,effectiveFrom:future};
      assert.equal((await revise(next,identities.denied)).status,403);
      assert.equal((await apiRequest(path,{method:'POST',identity:identities.manager,scope:{...scope,legalEntityId:'synthetic-unassigned-entity'},body:next})).status,403);
      assert.equal((await revise({...next,serviceDimensions:[{...units[0],precision:5}]})).status,400);
      assert.equal((await revise({...next,serviceDimensions:[units[0],units[0]]})).status,422);
      assert.equal((await apiRequest('/contracts',{method:'POST',body:{...saved.body,number:'SYN-WRONG-MODEL',model:'retainer'}})).status,422);
      for(const unitPrice of ['-1','1.00001','01','1e2',120,null]) {
        const dimensions=[{...units[0],unitPrice}];
        assert.equal((await revise({...next,serviceDimensions:dimensions})).status,400);
        assert.equal((await pool.query("select valid_priced_service_dimensions($1::jsonb,'managed_service') ok",[JSON.stringify(dimensions)])).rows[0].ok,false);
      }
      assert.equal((await pool.query("select valid_priced_service_dimensions($1::jsonb,'managed_service') ok",[JSON.stringify([{...units[0],unitPrice:'0.0000'}])])).rows[0].ok,true);
      for (const invalid of [[...periods,...periods],[{...periods[0],endsOn:'2023-12-31'}],[{...periods[0],amount:'0'}],[{...periods[0],startsOn:'2019-12-31'}]]) {
        assert.equal((await revise({...next,servicePeriodCharges:invalid})).status,422);
      }
      assert.equal((await revise({...next,servicePeriodCharges:[{...periods[0],amount:'1e3'}]})).status,400);
      assert.equal((await apiRequest('/contracts',{method:'POST',body:{...saved.body,number:'SYN-WRONG-PERIOD',model:'fixed_fee',serviceDimensions:[]}})).status,422);
      delete next.servicePeriodCharges;
      delete next.serviceDimensions;
      const inherited=await revise(next);
      assert.equal(inherited.status,201,JSON.stringify(inherited.body));
      assert.deepEqual(inherited.body.versions[0].serviceDimensions,units);
      assert.deepEqual(inherited.body.versions[0].servicePeriodCharges,periods);
      const repricedUnits=[{...units[0],unitPrice:'0.0000'},{code:'SHIFT',label:'Support shift',precision:2}];
      const repriced=await revise({...next,expectedVersion:2,effectiveFrom:'2099-01-01',serviceDimensions:repricedUnits});
      assert.equal(repriced.status,201,JSON.stringify(repriced.body));
      assert.deepEqual(repriced.body.versions[0].serviceDimensions,repricedUnits);
      assert.deepEqual(repriced.body.versions[1].serviceDimensions,units);
      const cleared=await revise({...next,expectedVersion:3,effectiveFrom:'2099-01-02',servicePeriodCharges:[],serviceDimensions:[]});
      assert.equal(cleared.status,201,JSON.stringify(cleared.body));
      assert.equal(cleared.body.versions[0].serviceDimensions,undefined);
      assert.equal(cleared.body.versions[0].servicePeriodCharges,undefined);
      assert.deepEqual(cleared.body.versions[1].servicePeriodCharges,periods);
      assert.deepEqual(cleared.body.versions[2].serviceDimensions,units);
      const auditTerms=await pool.query("select before_value,after_value from commercial_draft_events where entity_id=$1 and after_value->>'latestVersion'='4'",[saved.result.id]);
      assert.deepEqual(auditTerms.rows[0].before_value.versions[0].serviceDimensions,repricedUnits);
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
