import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {
  withClientProfilesJourney, clientProfilePrefix as prefix, clientProfileFixture as f,
  clientProfileDate as day, clientProfileInput, clientProfileTables, preservedClientTables,
  clientProfileSnapshot as snapshot, clientProfileCounts as counts, seedClientProfileClient,
} from './support/client-profiles-test.mjs';

// Hosted-only required acceptance: the real application route and React editor
// call the real HTTP API and randomized disposable PostgreSQL. No route, fetch,
// service, mutation or database response is mocked. Absence is a failure, no skip.
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const hostile = '<script>window.syntheticClientProfilesExecuted=true</script>';
const privateName = `Synthetic private legal ${hostile}`;
const privateReason = `Synthetic private profile change ${hostile}`;
const exactFields = {
  client: ['expectedVersion', 'code', 'effectiveFrom', 'legalName', 'displayName', 'parentClientId', 'defaultCurrency', 'billingContacts', 'reason'],
  unit: ['code', 'kind', 'effectiveFrom', 'legalName', 'displayName', 'defaultCurrency', 'billingContacts', 'reason'],
  unitRevision: ['expectedVersion', 'effectiveFrom', 'legalName', 'displayName', 'defaultCurrency', 'billingContacts', 'reason'],
};
await withClientProfilesJourney(async ({pool, baseUrl: apiUrl, request: apiRequest, commercialRequest, tokenFor, identities, scope, today, ownerId, clientId}) => {
  const future = day(today, 30), later = day(today, 60), afterLater = day(today, 90);
  const parentId = await seedClientProfileClient(pool, {name: 'Synthetic parent operational account'});
  const command = async (path, body) => {const result = await commercialRequest(path, {method: 'POST', body});assert.equal(result.status, 201, JSON.stringify(result.body));return result.body;};
  const contract = await command('/contracts', {number: 'SYN-CLIENT-PIN-CONTRACT', clientId, name: 'Synthetic preserved browser contract', model: 'fixed_fee',
    startsOn: '2020-01-01', endsOn: '2099-12-31', effectiveFrom: '2020-01-01', currency: 'USD', value: '25000.0001', billingTerms: 'Synthetic immutable existing terms', documents: [], reason: 'Synthetic fixture contract setup'});
  const pinned = contract.versions[0].id;
  const engagement = await command('/engagements', {code: 'SYN-CLIENT-PIN-ENGAGEMENT', name: 'Synthetic preserved browser delivery', model: 'fixed_fee', ownerId,
    startsOn: '2020-01-01', endsOn: '2099-12-31', currency: 'USD', budget: '10000.0001', clientId, contractId: contract.id, contractVersionId: pinned, attributionId: null, reason: 'Synthetic fixture engagement setup'});
  const preserved = await snapshot(pool, preservedClientTables);
  const fixtureServer = await startFixtureServer({root, fixtures: ['client-profiles'], apiUrl});
  let browser;
  try {
    const baseUrl = fixtureServer.url;
    browser = await chromium.launch({headless: true, ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {})});
    const errors = [], external = [], writes = [], protectedReads = [];
    const createContext = async (identity, permissions) => {
      const context = await browser.newContext({viewport: {width: 1360, height: 1100}});
      await context.addInitScript(({identity, permissions, scope, token, ownerId}) => {
        sessionStorage.setItem('workos_session', JSON.stringify({id: identity.id, employeeId: ownerId, name: 'Synthetic client profile operator', role: identity.role, permissionRole: identity.role, permissions}));
        sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));sessionStorage.setItem('workos_api_token', token);
      }, {identity, permissions, scope, token: tokenFor(identity), ownerId});
      const page = await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror', failure => errors.push(failure.message));
      page.on('request', request => {
        const url = new URL(request.url());if (/^https?:/.test(request.url()) && url.origin !== baseUrl) external.push(request.url());
        if (url.pathname.startsWith('/api/') && request.method() !== 'GET') writes.push({path: url.pathname, method: request.method(), body: request.postDataJSON(), headers: request.headers()});
        if (url.pathname.startsWith(prefix) && request.method() === 'GET') protectedReads.push({path: url.pathname, query: url.search, identity: identity.id});
      });
      return {context, page};
    };
    const manager = await createContext(identities.manager, ['commercial.clients.view', 'commercial.clients.manage']);
    const {page} = manager;const button = name => page.getByRole('button', {name, exact: true});
    const region = name => page.getByRole('region', {name, exact: true});
    const form = name => page.getByRole('form', {name, exact: true});
    const fill = async (target, fields) => {for (const [label, value] of Object.entries(fields)) await target.getByLabel(label, {exact: true}).fill(value);};
    const ready = () => region('Client profile list').waitFor();
    const inspect = async () => {await button('Inspect Synthetic commercial local client').click();await region('Client profile detail').getByRole('heading', {name: 'Synthetic commercial local client', exact: true}).waitFor();};
    const open = async () => {await page.goto(`${baseUrl}/client-profiles`, {waitUntil: 'networkidle'});await ready();await inspect();};
    const save = async (path, kind, status = 201) => {
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}${path}` && response.request().method() === 'POST');
      await button('Save profile').click();const response = await responsePromise;assert.equal(response.status(), status, `${kind} real browser save`);
      const request = response.request(), body = request.postDataJSON();assert.deepEqual(Object.keys(body).sort(), [...exactFields[kind]].sort());
      assert.equal(request.headers()['x-organization-id'], scope.organizationId);assert.equal(request.headers()['x-legal-entity-id'], scope.legalEntityId);
      const result = await response.json();
      if (status === 201) {await page.getByText('Profile saved. Current server records refreshed. Existing commercial pins are unchanged.', {exact: true}).waitFor();await ready();}
      return {body, result};
    };
    await open();assert.equal(new URL(page.url()).pathname, '/client-profiles');assert.equal(writes.length, 0, 'real app navigation/initial render makes no hidden writes');
    assert.ok((await region('Client profile detail').innerText()).includes('Incomplete legacy client.'));
    await button('Initialize client profile').click();let target = form('Initialize client profile');
    for (const label of ['Client code', 'Effective from', 'Legal name', 'Display name', 'Default currency (ISO code)']) assert.equal(await target.getByLabel(label, {exact: true}).inputValue(), '', 'first profile never guesses operational names, currency or date');
    assert.equal(await target.getByLabel('Parent client', {exact: true}).inputValue(), '');
    await fill(target, {'Client code': 'SYN-BROWSER-CLIENT', 'Effective from': today, 'Legal name': privateName, 'Display name': 'Synthetic explicit display', 'Default currency (ISO code)': 'GBP', 'Reason for profile change': privateReason});
    await target.getByLabel('Parent client', {exact: true}).selectOption(parentId);await button('Add billing contact').click();
    await fill(target, {'Billing contact 1 name': 'Synthetic protected contact', 'Billing contact 1 email': 'synthetic-browser-billing@example.test'});
    const initialized = await save(`/clients/${clientId}/profiles`, 'client');assert.equal(initialized.body.expectedVersion, 0);assert.equal(initialized.body.parentClientId, parentId);
    assert.equal(initialized.result.currentProfile.legalName, privateName);assert.equal(initialized.result.currentProfile.defaultCurrency, 'GBP');
    const first = initialized.result.currentProfile;assert.equal(await region('Client profile editor').count(), 0);
    assert.ok((await region('Current client profile').innerText()).includes(privateName));assert.ok((await region('Client profile detail').innerText()).includes(`account owner ${ownerId}`));
    assert.equal(await region('Client profile detail').locator('script,img').count(), 0);assert.equal(await page.evaluate(() => window.syntheticClientProfilesExecuted), undefined);
    await button('Append client profile revision').click();target = form('Append client profile revision');
    assert.equal(await target.getByLabel('Client code', {exact: true}).isDisabled(), true);assert.equal(await target.getByLabel('Client code', {exact: true}).inputValue(), 'SYN-BROWSER-CLIENT');
    await fill(target, {'Effective from': future, 'Legal name': 'Synthetic future customer legal name', 'Display name': '', 'Default currency (ISO code)': '', 'Reason for profile change': privateReason});
    await target.getByLabel('Parent client', {exact: true}).selectOption('');await button('Remove billing contact 1').click();
    const revised = await save(`/clients/${clientId}/profiles`, 'client');assert.equal(revised.body.expectedVersion, 1);assert.equal(revised.body.displayName, null);assert.equal(revised.body.defaultCurrency, null);assert.deepEqual(revised.body.billingContacts, []);
    assert.deepEqual(revised.result.currentProfile, first);assert.equal(revised.result.latestVersion, 2);assert.equal(revised.result.latestProfile.parentClientId, null);
    assert.ok((await region('Current client profile').innerText()).includes(privateName));assert.ok((await region('Latest client profile').innerText()).includes('Synthetic future customer legal name'));
    assert.ok((await region('Latest client profile').innerText()).includes('Default currency: Not provided'));
    await region('Client profile history').getByText(`Version 1 · effective ${today}`, {exact: true}).waitFor();
    await region('Client profile history').getByText(`Version 2 · effective ${future}`, {exact: true}).waitFor();

    await button('Add billing unit').click();target = form('Add billing unit');
    for (const label of ['Unit code', 'Effective from', 'Legal name', 'Display name', 'Default currency (ISO code)']) assert.equal(await target.getByLabel(label, {exact: true}).inputValue(), '');
    await fill(target, {'Unit code': 'SYN-BROWSER-BILLING', 'Effective from': today, 'Legal name': `Synthetic billing identity ${hostile}`, 'Display name': 'Synthetic billing display', 'Default currency (ISO code)': 'EUR', 'Reason for profile change': privateReason});
    await target.getByLabel('Unit kind', {exact: true}).selectOption('billing_entity');await button('Add billing contact').click();
    await fill(target, {'Billing contact 1 name': 'Synthetic unit contact', 'Billing contact 1 email': 'synthetic-browser-unit@example.test'});
    const added = await save(`/clients/${clientId}/billing-units`, 'unit');const billing = added.result.billingUnits.find(unit => unit.code === 'SYN-BROWSER-BILLING');assert.ok(billing);assert.equal(billing.clientId, clientId);assert.equal(billing.currentProfile.defaultCurrency, 'EUR');
    await button('Append unit revision SYN-BROWSER-BILLING').click();target = form('Append billing unit revision');
    assert.equal(await target.getByLabel('Unit code', {exact: true}).isDisabled(), true);assert.equal(await target.getByLabel('Unit kind', {exact: true}).isDisabled(), true);
    await fill(target, {'Effective from': future, 'Legal name': '', 'Display name': '', 'Default currency (ISO code)': '', 'Reason for profile change': privateReason});await button('Remove billing contact 1').click();
    const unitRevised = await save(`/clients/${clientId}/billing-units/${billing.id}/versions`, 'unitRevision');assert.equal(unitRevised.body.expectedVersion, 1);assert.equal(unitRevised.body.legalName, null);assert.deepEqual(unitRevised.body.billingContacts, []);
    const persistedUnit = unitRevised.result.billingUnits.find(unit => unit.id === billing.id);assert.equal(persistedUnit.latestVersion, 2);assert.deepEqual(persistedUnit.currentProfile, billing.currentProfile);
    await button('Add billing unit').click();target = form('Add billing unit');await fill(target, {'Unit code': 'SYN-BROWSER-BUSINESS', 'Effective from': future, 'Reason for profile change': privateReason});await target.getByLabel('Unit kind', {exact: true}).selectOption('business_unit');
    const business = await save(`/clients/${clientId}/billing-units`, 'unit');const businessUnit = business.result.billingUnits.find(unit => unit.code === 'SYN-BROWSER-BUSINESS');assert.equal(businessUnit.kind, 'business_unit');assert.equal(businessUnit.currentProfile, null);assert.equal(businessUnit.versions[0].legalName, null);assert.equal(businessUnit.versions[0].defaultCurrency, null);

    // The date is an explicit GET projection, not a backdated write or a new
    // default. Applying/reloading it must dispatch no mutation at all.
    const beforeDateWrites = writes.length;await page.getByLabel('As-of date', {exact: true}).fill(future);await button('Apply as-of date').click();await ready();await inspect();
    assert.ok((await region('Current client profile').innerText()).includes('Synthetic future customer legal name'));
    assert.ok((await region('Current client profile').innerText()).includes('Default currency: Not provided'));
    const readAtFuture = await apiRequest(`/clients/${clientId}?asOf=${future}`);assert.equal(readAtFuture.body.currentProfile.version, 2);assert.equal(readAtFuture.body.billingUnits.find(unit => unit.id === billing.id).currentProfile.version, 2);
    assert.equal(writes.length, beforeDateWrites);assert.ok(protectedReads.some(read => read.query === `?asOf=${future}`));
    await page.reload({waitUntil: 'networkidle'});await ready();await inspect();assert.ok((await region('Current client profile').innerText()).includes(privateName));
    await button('Append client profile revision').click();target = form('Append client profile revision');
    await fill(target, {'Effective from': afterLater, 'Legal name': 'Synthetic rejected stale browser name', 'Reason for profile change': privateReason});
    const concurrent = await apiRequest(`/clients/${clientId}/profiles`, {method: 'POST', body: clientProfileInput(later, {code: 'SYN-BROWSER-CLIENT', expectedVersion: 2, legalName: 'Synthetic newer tab legal name', defaultCurrency: 'JPY'})});assert.equal(concurrent.status, 201);
    const beforeStale = await counts(pool), staleSnapshot = await snapshot(pool, clientProfileTables);
    const stale = await save(`/clients/${clientId}/profiles`, 'client', 409);assert.equal(stale.body.expectedVersion, 2);assert.equal(stale.result.error.code, 'CLIENT_PROFILE_VERSION_CONFLICT');
    await page.getByText('Profile not saved because a version, code or hierarchy changed. Reload before another save.', {exact: true}).waitFor();assert.equal(await button('Save profile').isDisabled(), true);
    assert.deepEqual(await counts(pool), beforeStale);assert.deepEqual(await snapshot(pool, clientProfileTables), staleSnapshot);
    await button('Cancel').click();assert.equal(await button('Append client profile revision').isDisabled(), true, 'cancelling does not clear a stale/uncertain save lock');
    await button('Reload workspace').click();await ready();await inspect();await region('Latest client profile').getByText('Legal name: Synthetic newer tab legal name', {exact: true}).waitFor();
    assert.equal(await button('Append client profile revision').isDisabled(), false);assert.equal(writes.length, 6, 'five deliberate saves and one stale denial dispatch exactly once; concurrent tab is a separate API command');

    // Persistence and source authority are verified in SQL, not only the DOM.
    const sqlProfiles = (await pool.query('select version,effective_from::text,legal_name,default_currency,billing_contacts from client_profile_versions where client_id=$1 order by version', [clientId])).rows;
    assert.deepEqual(sqlProfiles.map(row => row.version), [1, 2, 3]);assert.equal(sqlProfiles[0].legal_name, privateName);assert.equal(sqlProfiles[0].default_currency, 'GBP');assert.equal(sqlProfiles[1].default_currency, null);assert.equal(sqlProfiles[2].default_currency, 'JPY');
    assert.equal((await pool.query('select contract_version_id,currency from commercial_engagements where id=$1', [engagement.id])).rows[0].contract_version_id, pinned);
    assert.deepEqual(await snapshot(pool, preservedClientTables), preserved, 'new profiles, billing-unit histories, future defaults and stale denial never rewrite operational/work/commercial/neutral/lifecycle history');
    const events = (await pool.query('select * from client_profile_events order by created_at,id')).rows;assert.equal(events.length, 6);assert.equal(events.filter(event => event.before_value === null).length, 3);
    for (const event of events) {assert.equal(event.actor_id, identities.manager.id);assert.equal(event.active_role, 'Admin');assert.equal(event.source, 'Web');assert.ok(event.correlation_id);assert.ok(event.operation_id);assert.ok(event.after_value);}
    const history = await apiRequest(`/clients/${clientId}/history`, {identity: identities.reader});assert.equal(history.status, 200);assert.equal(history.body.events.length, 6);assert.ok(JSON.stringify(history.body).includes(privateName));
    const audits = (await pool.query("select * from audit_logs where module='Client Profiles'")).rows;assert.equal(audits.length, 6);assert.equal(JSON.stringify(audits).includes(hostile), false);assert.equal(JSON.stringify(audits).includes('synthetic-browser-billing@example.test'), false);assert.equal(JSON.stringify(audits).includes('synthetic-browser-unit@example.test'), false);
    assert.equal(await page.evaluate(() => window.syntheticClientProfilesExecuted), undefined);assert.equal(await region('Client profile detail').locator('script,img').count(), 0);
    const writeCount = writes.length;
    const reader = await createContext(identities.reader, ['commercial.clients.view']);await reader.page.goto(`${baseUrl}/client-profiles`, {waitUntil: 'networkidle'});
    await reader.page.getByText('Read-only client profile access. A separate manage permission is required to save.', {exact: false}).waitFor();await reader.page.getByRole('button', {name: 'Inspect Synthetic commercial local client', exact: true}).click();
    await reader.page.getByRole('region', {name: 'Client profile history', exact: true}).waitFor();assert.equal(await reader.page.getByRole('button', {name: /^Initialize|^Append|^Add billing unit$/}).count(), 0);assert.equal(writes.length, writeCount);
    const denied = await createContext(identities.denied, ['commercial.contracts.view', 'commercial.contracts.manage', 'commercial.lifecycle.manage']);
    // The fixture hosts the exact production component without app-shell
    // auxiliary reads, so it can prove zero confidential requests at no access.
    await denied.page.goto(`${baseUrl}/tests/fixtures/client-profiles.html?live=1`);await denied.page.getByRole('alert').getByText('Scope or access changed.', {exact: false}).waitFor();
    assert.equal(protectedReads.filter(read => read.identity === identities.denied.id).length, 0);assert.equal(writes.length, writeCount);
    const forbidden = await apiRequest(`/clients/${clientId}`, {identity: identities.denied});assert.equal(forbidden.status, 403);
    assert.deepEqual(errors, []);assert.deepEqual(external, []);
    await denied.context.close();await reader.context.close();await manager.context.close();
    console.log('Client profiles real /client-profiles React -> API -> PostgreSQL journey passed: explicit incomplete legacy state, legal/display/contact profiles, hierarchy, current/future immutable snapshots, both billing-unit kinds, null clearing, exact commands and scoped headers, stale concurrency rollback, reload persistence, pin/work preservation, protected audit, reader/no-access and safe text rendering.');
  } finally {try {if (browser) await browser.close();} finally {await fixtureServer.close();}}
});
