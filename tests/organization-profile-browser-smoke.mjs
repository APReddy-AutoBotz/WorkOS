import assert from 'node:assert/strict';

// This acceptance journey is executed by the hosted browser CI job. Do not start
// a local server/browser to bypass the task environment's socket restriction.
const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless: true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath: process.env.WORKOS_CHROMIUM_PATH} : {}),
});
const page = await browser.newPage({viewport: {width: 1100, height: 900}});
page.setDefaultTimeout(10000);
const pageErrors = [];
const unexpectedApi = [];
const unexpectedRemote = [];
let downloads = 0;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('download', () => { downloads += 1; });
page.on('request', request => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) unexpectedRemote.push(request.url());
});
await page.route('**/api/**', route => {
  unexpectedApi.push({method: route.request().method(), url: route.request().url()});
  return route.abort();
});

const today = new Date().toISOString().slice(0, 10);
const futureDate = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
const profile = (overrides = {}) => ({
  organizationId: 'org-a', code: 'SYN-A', name: 'Synthetic Organization A',
  legalName: 'Synthetic Organization A LLC', productDisplayName: 'Synthetic Workspace A',
  supportContact: 'support-a@example.invalid', defaultLocale: 'en-US',
  defaultTimeZone: 'America/New_York', baseCurrency: 'USD', fiscalYearStart: '01-01',
  defaultWeekStart: 1, effectiveFrom: today, ...overrides,
});
const raw = value => ({
  organization_id: value.organizationId, organization_code: value.code, organization_name: value.name,
  legal_name: value.legalName, branding:value.branding, product_display_name: value.productDisplayName, support_contact: value.supportContact,
  default_locale: value.defaultLocale, default_time_zone: value.defaultTimeZone, base_currency: value.baseCurrency,
  fiscal_year_start: value.fiscalYearStart, default_week_start: value.defaultWeekStart, profile_effective_from: `${value.effectiveFrom}T00:00:00.000Z`,
});
const checkKeys = ['organization', 'legal_entity', 'calendars', 'roles', 'identity', 'initial_users', 'imports',
  'commercial_defaults', 'notifications', 'production_readiness', 'worker_type', 'reporting_period'];
const readiness = (organizationId = 'org-a', legalEntityId = 'legal-a') => ({
  organizationId, legalEntityId, ready: false, authority: 'persisted-server-state',
  checks: Object.fromEntries(checkKeys.map(key => [key, key === 'organization'])),
  evidence: {organization: 'Synthetic persisted organization profile'},
});
const fieldNames = {
  organizationId: 'Organization ID', code: 'Organization code', name: 'Organization name', legalName: 'Legal name',
  productDisplayName: 'Product display name', supportContact: 'Support contact', defaultLocale: 'Default locale',
  defaultTimeZone: 'Default timezone', baseCurrency: 'Base currency', fiscalYearStart: 'Fiscal year start',
  defaultWeekStart: 'Week start day', effectiveFrom: 'Effective from',
};
const input = key => page.getByLabel(fieldNames[key], {exact: true});
const button = name => page.getByRole('button', {name, exact: true});
const reload = () => button('Reload profile');
const save = () => button('Save profile');
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const calls = () => page.evaluate(() => window.organizationProfileHarness.calls);
const count = async kind => (await calls()).filter(call => call.kind === kind).length;
const lastId = async () => Math.max(0, ...(await calls()).map(call => call.id));
const pending = async (kind, after = 0) => {
  await page.waitForFunction(({kind, after}) => window.organizationProfileHarness.pending.some(call => call.kind === kind && call.id > after), {kind, after});
  return page.evaluate(({kind, after}) => {
    const {id, kind: requestKind, url, method, headers, credentials, body} = window.organizationProfileHarness.pending.filter(call => call.kind === kind && call.id > after).at(-1);
    return {id, kind: requestKind, url, method, headers, credentials, body};
  }, {kind, after});
};
const settle = (request, result, status) => page.evaluate(({id, result, status}) => window.organizationProfileHarness.settle(id, result, status), {id: request.id, result, status});
let fixtureToken;
const headers = (request, organizationId = 'org-a', legalEntityId = 'legal-a', token = fixtureToken) => {
  assert.deepEqual(request.headers, {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-organization-id': organizationId, 'x-legal-entity-id': legalEntityId,
  }, `${request.kind} uses only production JSON/authentication/captured-scope headers`);
  assert.equal(request.credentials, 'include', 'production cookie credentials remain included');
  assert.equal(request.url, `/api/organization-setup/${request.kind === 'readiness' ? 'readiness' : 'profile'}`);
  assert.equal(request.method, request.kind === 'save' ? 'PUT' : 'GET');
};
const health = async (after = 0) => {
  const request = await pending('health', after);
  assert.equal(request.url, '/api/health');
  assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'include');
  assert.equal(request.body, null);
  await settle(request, {database: 'connected'});
  return request;
};
const readers = async (after = 0, organizationId = 'org-a', legalEntityId = 'legal-a') => {
  const current = await pending('profile', after);
  const setup = await pending('readiness', after);
  headers(current, organizationId, legalEntityId);
  headers(setup, organizationId, legalEntityId);
  assert.equal(current.body, null);
  assert.equal(setup.body, null);
  return {profile: current, readiness: setup};
};
const expectProfile = async expected => {
  await page.waitForFunction(name => [...document.querySelectorAll('input')].some(element => element.value === name), expected.name);
  for (const [key, label] of Object.entries(fieldNames)) {
    assert.equal(await page.getByLabel(label, {exact: true}).inputValue(), String(expected[key]), `${label} reflects the accepted profile`);
  }
  assert.equal(await input('organizationId').getAttribute('readonly'), '', 'organization ownership is not editable');
  assert.equal(await input('code').getAttribute('readonly'), '', 'organization code is not editable');
  assert.equal(await save().isEnabled(), true);
};
const expectNoSuccess = async () => {
  assert.equal(await page.getByText('Organization profile saved.', {exact: true}).count(), 0);
  assert.equal(await page.getByText(/^Organization profile scheduled for /).count(), 0);
};
const expectNoPrivateError = async () => {
  const body = await page.locator('body').innerText();
  for (const marker of ['synthetic-private', 'synthetic-secret', '/internal/provider', 'SYNTHETIC_PRIVATE_ERROR_CODE']) {
    assert.equal(body.includes(marker), false, 'private API/network details must not appear in the UI');
  }
};
const expectInvalidated = async () => {
  await page.getByRole('alert').getByText('Scope or access changed. Draft cleared.', {exact: false}).waitFor();
  await expectNoSuccess();
  assert.equal(await input('name').count(), 0, 'invalid context does not retain an editable draft');
};
const open = async ({strict = false} = {}) => {
  await page.goto(`${baseUrl}/tests/fixtures/organization-profile.html${strict ? '?strict=1' : ''}`);
  await page.getByRole('heading', {name: 'Organization profile', exact: true}).waitFor();
  await page.getByText('Loading organization profile…', {exact: false}).waitFor();
  fixtureToken = await page.evaluate(() => window.organizationProfileHarness.syntheticToken);
};
const boot = async (value = profile(), readinessStatus) => {
  await open();
  await health();
  const attempt = await readers();
  await settle(attempt.readiness, readiness(value.organizationId), readinessStatus);
  await settle(attempt.profile, raw(value));
  await expectProfile(value);
  return attempt;
};
const edit = async value => {
  for (const key of Object.keys(fieldNames).filter(key => !['organizationId', 'code'].includes(key))) {
    if (key === 'defaultWeekStart') await input(key).selectOption(String(value[key]));
    else await input(key).fill(String(value[key]));
  }
};
const completeSave = async (request, value, {scheduled = false, readinessStatus} = {}) => {
  await settle(request, raw(value));
  await page.getByText(scheduled ? `Organization profile scheduled for ${value.effectiveFrom}.` : 'Organization profile saved.', {exact: true}).waitFor();
  const setup = await pending('readiness', request.id);
  headers(setup, value.organizationId, value.organizationId === 'org-a' ? 'legal-a' : 'legal-b');
  await settle(setup, readiness(value.organizationId, value.organizationId === 'org-a' ? 'legal-a' : 'legal-b'), readinessStatus);
  await expectProfile(value);
  assert.equal((await calls()).filter(call => call.kind === 'profile' && call.id > request.id).length, 0, 'save uses the authoritative PUT response, not an invented current-effective GET');
};
const explicitReload = async (value = profile(), scope = {organizationId: 'org-a', legalEntityId: 'legal-a'}) => {
  const after = await lastId();
  await reload().click();
  await expectNoSuccess();
  await health(after);
  const attempt = await readers(after, scope.organizationId, scope.legalEntityId);
  await settle(attempt.profile, raw(value));
  await settle(attempt.readiness, readiness(scope.organizationId, scope.legalEntityId));
  await expectProfile(value);
  return attempt;
};
const capture = (label, kind) => page.evaluate(({label, kind}) => window.organizationProfileHarness.capture(label, kind), {label, kind});
const invoke = labels => page.evaluate(labels => window.organizationProfileHarness.invoke(labels), labels);
const expectNoDispatch = async (before, reason) => {
  await flush();
  assert.deepEqual(await calls(), before, reason);
};

try {
  // Missing settings-management permission fails closed before even a health
  // probe. A role name alone must not substitute for the actual permission.
  await page.goto(`${baseUrl}/tests/fixtures/organization-profile.html?access=none`);
  await page.getByRole('heading', {name: 'Organization profile', exact: true}).waitFor();
  await expectInvalidated();
  assert.deepEqual(await calls(), []);
  await reload().click();
  await flush();
  assert.deepEqual(await calls(), [], 'Reload without effective access cannot dispatch');

  // Every editable field crosses the real service/client normalization boundary.
  await boot();
  const weekdays = await input('defaultWeekStart').locator('option').evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(weekdays, ['0', '1', '2', '3', '4', '5', '6'], 'all seven persisted week-start values remain available');
  const changed = profile({
    name: 'Synthetic Edited Organization', legalName: 'Synthetic Edited Legal LLC', productDisplayName: 'Synthetic Edited Workspace',
    supportContact: 'https://support.example.invalid/help', defaultLocale: 'en-GB', defaultTimeZone: 'Europe/London',
    baseCurrency: 'GBP', fiscalYearStart: '04-01', defaultWeekStart: 0,
  });
  await edit(changed);
  changed.branding = {primaryAccent:'#334455'};
  await page.getByLabel('Primary accent', {exact:true}).fill(changed.branding.primaryAccent);
  assert.equal(await page.getByLabel('Brand preview').evaluate(el => el.style.borderColor),'rgb(51, 68, 85)');
  await save().focus();
  await page.keyboard.press('Enter');
  const firstSave = await pending('save');
  headers(firstSave);
  const {code: immutableCode, ...expectedBody} = changed;
  assert.deepEqual(firstSave.body, expectedBody, 'all editable fields plus the captured organization ID are transmitted; writable code is excluded');
  assert.equal(immutableCode, 'SYN-A');
  assert.equal(await button('Saving profile…').isDisabled(), true);
  for (const key of Object.keys(fieldNames)) assert.equal(await input(key).isDisabled(), true, 'the full fieldset is disabled during save');
  await completeSave(firstSave, changed);
  const setupSection = page.getByRole('region', {name: 'Organization setup readiness', exact: true});
  await setupSection.getByText('Configured', {exact: true}).waitFor();
  assert.equal(await setupSection.getByText('Configured', {exact: true}).count(), 1);
  assert.equal(await setupSection.getByText('Required', {exact: true}).count(), checkKeys.length - 1, 'saving a profile does not mark unrelated server-derived requirements complete');
  assert.equal(await page.getByText(/setup (is )?complete[.!]?$/i).count(), 0, 'saving only a profile never declares the whole setup complete');
  await input('name').fill('Synthetic Unsaved Change After Success');
  await expectNoSuccess();
  await explicitReload(changed);

  // Readiness is independently recoverable and cannot block editing or save.
  await boot(profile(), 503);
  await page.getByText('Setup readiness could not be loaded. Profile editing is independent.', {exact: true}).waitFor();
  await input('name').fill('Synthetic Saved Despite Readiness Failure');
  await save().click();
  const independentSave = await pending('save');
  await completeSave(independentSave, profile({name: 'Synthetic Saved Despite Readiness Failure'}), {readinessStatus: 'network'});
  await expectNoPrivateError();

  // Cross-scope readiness is rejected independently rather than attached to an
  // otherwise valid profile, and cross-scope profile data is never editable.
  await open();
  await health();
  const mismatchedReadiness = await readers();
  await settle(mismatchedReadiness.readiness, readiness('org-b', 'legal-b'));
  await settle(mismatchedReadiness.profile, raw(profile()));
  await expectProfile(profile());
  await page.getByText('Setup readiness could not be loaded. Profile editing is independent.', {exact: true}).waitFor();
  await open();
  await health();
  const mismatchedProfile = await readers();
  await settle(mismatchedProfile.readiness, readiness());
  await settle(mismatchedProfile.profile, raw(profile({organizationId: 'org-b', name: 'Synthetic Wrong Scope Profile'})));
  await page.getByRole('alert').getByText('Organization profile could not be loaded. Check your connection and try again.', {exact: true}).waitFor();
  assert.equal(await input('name').count(), 0);

  // Future-effective saves are scheduled; a current-effective reload is distinct.
  await boot();
  const scheduled = profile({name: 'Synthetic Future Organization', effectiveFrom: futureDate});
  await edit(scheduled);
  await save().click();
  const futureSave = await pending('save');
  assert.equal(futureSave.body.effectiveFrom, futureDate);
  await completeSave(futureSave, scheduled, {scheduled: true});
  assert.equal(await page.getByText('Organization profile saved.', {exact: true}).count(), 0);
  await explicitReload(profile());
  assert.equal(await input('effectiveFrom').inputValue(), today, 'reload reflects currently effective server state, not the scheduled draft');

  // Required fields and simple format constraints prevent native invalid
  // submits. Locale/timezone/fiscal validity remains server authoritative.
  for (const [key, value] of [
    ['name', ''], ['legalName', ''], ['productDisplayName', ''],
    ['baseCurrency', 'usd'], ['fiscalYearStart', '4-1'], ['effectiveFrom', ''],
  ]) {
    await boot();
    await input(key).fill(value);
    assert.equal(await input(key).evaluate(element => element.validity.valid), false, `${key} has an accessible native invalid state`);
    const before = await calls();
    await save().click();
    await expectNoDispatch(before, `${key} native validation blocks API dispatch`);
    await expectNoSuccess();
  }
  for (const [key, value] of [['supportContact', 'not a contact'], ['defaultLocale', 'not_a_locale'],
    ['defaultTimeZone', 'Mars/Olympus'], ['fiscalYearStart', '02-31']]) {
    await boot();
    await input(key).fill(value);
    await save().click();
    const rejected = await pending('save');
    assert.equal(rejected.body[key], value, 'domain validation remains authoritative on the server');
    await settle(rejected, undefined, 400);
    await page.getByRole('alert').getByText('Profile was not saved. Check the fields and effective date.', {exact: true}).waitFor();
    await expectNoSuccess();
    await expectNoPrivateError();
  }

  // Server validation/conflict/access/unavailable/network failures are never
  // converted to success or exposed as raw provider errors.
  for (const status of [400, 409, 401, 403, 503, 'network']) {
    await boot();
    await input('name').fill(`Synthetic Rejected ${status}`);
    await save().click();
    const request = await pending('save');
    headers(request);
    await settle(request, undefined, status);
    const alert = page.getByRole('alert');
    await alert.waitFor();
    if (status === 400) await alert.getByText('Profile was not saved. Check the fields and effective date.', {exact: true}).waitFor();
    if (status === 401 || status === 403) await alert.getByText('Organization profile access could not be confirmed. Reload after checking your access.', {exact: true}).waitFor();
    if (status === 409) await alert.getByText('Profile was not saved because its effective date conflicts with the latest server version. Reload before making another change.', {exact: true}).waitFor();
    if (status === 503 || status === 'network') await alert.getByText('Save could not be confirmed. Reload profile before trying again.', {exact: true}).waitFor();
    await expectNoSuccess();
    await expectNoPrivateError();
    assert.equal(await count('save'), 1, 'a failed/uncertain save is not automatically retried');
    assert.equal(await count('readiness'), 1, 'failed saves cannot refresh or claim new readiness evidence');
    assert.equal(new URL(page.url()).pathname, '/tests/fixtures/organization-profile.html', 'safe in-editor failures retain the bounded editor');
  }

  // Initial read failures do not manufacture an editable blank profile.
  for (const status of [400, 409, 401, 403, 503, 'network']) {
    await open();
    await health();
    const attempt = await readers();
    await settle(attempt.readiness, readiness());
    await settle(attempt.profile, undefined, status);
    await page.getByRole('alert').waitFor();
    assert.equal(await input('name').count(), 0);
    await expectNoSuccess();
    await expectNoPrivateError();
    assert.equal(await count('save'), 0);
  }

  // A delayed initial backend-health check must never bind a request to a new
  // organization after its initiating generation has been invalidated.
  await open();
  const delayedHealth = await pending('health');
  await page.evaluate(() => window.organizationProfileHarness.scope('org-b', 'legal-b'));
  await expectInvalidated();
  await settle(delayedHealth, {database: 'connected'});
  await flush();
  assert.deepEqual((await calls()).map(call => call.kind), ['health'], 'old health completion dispatches neither old nor new-context profile/readiness requests');
  const profileB = profile({organizationId: 'org-b', code: 'SYN-B', name: 'Synthetic Organization B'});
  await explicitReload(profileB, {organizationId: 'org-b', legalEntityId: 'legal-b'});

  // Refresh invalidates the old form callback synchronously, even before
  // React removes the old form, and old reload callbacks cannot fork a new read.
  await boot();
  await capture('before-reload-submit');
  await capture('before-reload-button', 'reload');
  const beforeReload = await lastId();
  await page.evaluate(() => window.organizationProfileHarness.reloadAndInvoke(['before-reload-submit']));
  const reloadHealth = await health(beforeReload);
  const reloaded = await readers(reloadHealth.id);
  await settle(reloaded.profile, raw(profile()));
  await settle(reloaded.readiness, readiness());
  await expectProfile(profile());
  const beforeRetainedReload = await calls();
  await invoke(['before-reload-submit', 'before-reload-button']);
  await expectNoDispatch(beforeRetainedReload, 'old-generation submit/reload callbacks cannot reuse current context');

  // Events invalidate old drafts/results synchronously, including the switch
  // request raised before asynchronous scope authorization has completed.
  for (const event of ['workos:organization-scope-switch-requested', 'workos:organization-scope-changed', 'storage', 'focus']) {
    await boot();
    await input('name').fill('Synthetic Invalidated Draft');
    await capture(`event-${event}`);
    const before = await calls();
    await page.evaluate(({event, label}) => {
      if (event === 'workos:organization-scope-switch-requested') window.organizationProfileHarness.event(event, [label]);
      else if (event === 'focus') window.organizationProfileHarness.identity('synthetic-admin-b', 'Admin', true, event, [label]);
      else window.organizationProfileHarness.scope('org-b', 'legal-b', event, [label]);
    }, {event, label: `event-${event}`});
    await expectInvalidated();
    await expectNoDispatch(before, `${event} invalidates retained form callbacks before React rerenders`);
  }

  // Permission loss, role changes, actor changes and token changes are checked
  // again at send time, even if an event or render has not occurred yet.
  for (const change of ['permission', 'role', 'actor', 'token', 'legal-entity', 'scope-removed']) {
    await boot();
    await input('name').fill('Synthetic Retained Unauthorized Draft');
    await capture(`silent-${change}`);
    const before = await calls();
    await page.evaluate(({change, label}) => {
      if (change === 'permission') window.organizationProfileHarness.identity('synthetic-admin-a', 'Admin', false, null, [label]);
      if (change === 'role') window.organizationProfileHarness.identity('synthetic-admin-a', 'HR', true, null, [label]);
      if (change === 'actor') window.organizationProfileHarness.identity('synthetic-admin-b', 'Admin', true, null, [label]);
      if (change === 'token') window.organizationProfileHarness.token('synthetic-profile-token-b', null, [label]);
      if (change === 'legal-entity') window.organizationProfileHarness.scope('org-a', 'legal-other', null, [label]);
      if (change === 'scope-removed') window.organizationProfileHarness.scope(null, null, null, [label]);
    }, {change, label: `silent-${change}`});
    await expectNoDispatch(before, `${change} is guarded inside the retained callback`);
    await page.evaluate(() => window.organizationProfileHarness.event('focus'));
    await expectInvalidated();
  }

  // Permission loss during already-dispatched reads also rejects the old
  // profile/readiness completion, not just later attempts to submit a form.
  await open();
  await health();
  const revokedReaders = await readers();
  await page.evaluate(() => window.organizationProfileHarness.identity('synthetic-admin-a', 'Admin', false, 'storage'));
  await expectInvalidated();
  const beforeRevokedCompletion = await calls();
  await settle(revokedReaders.profile, raw(profile({name: 'Synthetic Revoked Completion'})));
  await settle(revokedReaders.readiness, readiness());
  await expectNoDispatch(beforeRevokedCompletion, 'permission loss rejects old profile/readiness completion');
  await expectInvalidated();

  // Duplicate form submissions in the very same JavaScript turn must not race
  // React's disabled state. Only one real PUT can be sent.
  await boot();
  await input('name').fill('Synthetic Single Submission');
  await page.evaluate(() => window.organizationProfileHarness.submitTwice());
  const onlySave = await pending('save');
  await flush();
  assert.equal(await count('save'), 1);
  await completeSave(onlySave, profile({name: 'Synthetic Single Submission'}));

  // Already-dispatched writes retain original headers/body but their old result
  // must never appear as success, draft or readiness in a different context.
  await boot();
  await input('name').fill('Synthetic Original Scope Save');
  await save().click();
  const oldSave = await pending('save');
  headers(oldSave);
  assert.equal(oldSave.body.organizationId, 'org-a');
  await page.evaluate(() => window.organizationProfileHarness.scope('org-b', 'legal-b'));
  await expectInvalidated();
  await explicitReload(profileB, {organizationId: 'org-b', legalEntityId: 'legal-b'});
  const beforeOldCompletion = await calls();
  await settle(oldSave, raw(profile({name: 'Synthetic Old Scope Completion'})));
  await expectNoDispatch(beforeOldCompletion, 'stale save completion cannot trigger new-scope readiness or resubmit');
  await expectProfile(profileB);
  await expectNoSuccess();

  // A to B to A proves generation, not merely matching organization strings,
  // decides whether a completion may replace current evidence.
  await boot();
  const beforeA = await lastId();
  await reload().click();
  const oldAHealth = await health(beforeA);
  const oldA = await readers(oldAHealth.id);
  await page.evaluate(() => window.organizationProfileHarness.scope('org-b', 'legal-b'));
  await reload().click();
  const oldBHealth = await health(Math.max(oldA.profile.id, oldA.readiness.id));
  const oldB = await readers(oldBHealth.id, 'org-b', 'legal-b');
  await page.evaluate(() => window.organizationProfileHarness.scope('org-a', 'legal-a'));
  await reload().click();
  const newestAHealth = await health(Math.max(oldB.profile.id, oldB.readiness.id));
  const newestA = await readers(newestAHealth.id);
  const currentA = profile({name: 'Synthetic Newest A'});
  await settle(newestA.profile, raw(currentA));
  await settle(newestA.readiness, readiness());
  await expectProfile(currentA);
  await settle(oldA.profile, raw(profile({name: 'Synthetic Stale Same Scope'})));
  await settle(oldA.readiness, readiness());
  await settle(oldB.profile, undefined, 503);
  await settle(oldB.readiness, undefined, 'network');
  await flush();
  await expectProfile(currentA);
  assert.equal(await page.getByRole('alert').count(), 0, 'stale success and stale failure cannot replace newer current evidence');

  // Unmount invalidates both pending requests and retained callbacks. The real
  // request may finish, but it cannot dispatch another request after unmount.
  await open();
  const unmountedHealth = await pending('health');
  await page.evaluate(() => window.organizationProfileHarness.hide());
  await page.getByRole('heading', {name: 'Organization profile', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedHealth, {database: 'connected'});
  await flush();
  assert.deepEqual((await calls()).map(call => call.kind), ['health']);
  await boot();
  await input('name').fill('Synthetic Unmounted Save');
  await capture('unmounted-submit');
  await save().click();
  const unmountedSave = await pending('save');
  await page.evaluate(() => window.organizationProfileHarness.hide());
  await page.getByRole('heading', {name: 'Organization profile', exact: true}).waitFor({state: 'detached'});
  const beforeUnmountCompletion = await calls();
  await invoke(['unmounted-submit']);
  await settle(unmountedSave, raw(profile({name: 'Synthetic Unmounted Completion'})));
  await expectNoDispatch(beforeUnmountCompletion, 'unmounted save/callback cannot dispatch or refresh readiness');
  await page.evaluate(() => window.organizationProfileHarness.show());
  const remountedHealth = await health(unmountedSave.id);
  const remounted = await readers(remountedHealth.id);
  await settle(remounted.profile, raw(profile()));
  await settle(remounted.readiness, readiness());
  await expectProfile(profile());
  await expectNoSuccess();

  // The application uses StrictMode. Its development mount/cleanup/replay
  // creates two independent health gates; only the replay's generation owns the
  // current read. Settle the obsolete gate last to exercise out-of-order replay.
  await open({strict: true});
  await page.waitForFunction(() => window.organizationProfileHarness.pending.filter(call => call.kind === 'health').length === 2);
  const strictHealth = await page.evaluate(() => window.organizationProfileHarness.pending.filter(call => call.kind === 'health').map(({id}) => ({id})));
  await settle(strictHealth[1], {database: 'connected'});
  const strictReaders = await readers(strictHealth[1].id);
  const replayed = profile({name: 'Synthetic StrictMode Current Profile'});
  await settle(strictReaders.profile, raw(replayed));
  await settle(strictReaders.readiness, readiness());
  await expectProfile(replayed);
  const beforeObsoleteHealth = await calls();
  await settle(strictHealth[0], undefined, 503);
  await expectNoDispatch(beforeObsoleteHealth, 'obsolete StrictMode health completion cannot dispatch a stale read');
  await expectProfile(replayed);
  assert.equal(await page.getByRole('alert').count(), 0, 'obsolete StrictMode failure cannot replace current evidence');
  assert.equal(await count('profile'), 1);
  assert.equal(await count('readiness'), 1);
  await capture('strict-old-submit');
  await capture('strict-old-reload', 'reload');
  await explicitReload(profile());
  const beforeStrictCallbacks = await calls();
  await invoke(['strict-old-submit', 'strict-old-reload']);
  await expectNoDispatch(beforeStrictCallbacks, 'StrictMode does not grant retained old callbacks the replayed generation');

  // Keyboard-only submit and narrow layout remain usable for the full form.
  await boot();
  await page.setViewportSize({width: 390, height: 844});
  await input('name').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Synthetic Keyboard Organization');
  await save().focus();
  assert.equal(await save().evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  const keyboardSave = await pending('save');
  await completeSave(keyboardSave, profile({name: 'Synthetic Keyboard Organization'}));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'organization profile has no horizontal overflow at 390px');
  for (const key of Object.keys(fieldNames)) {
    const bounds = await input(key).boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `${fieldNames[key]} fits the narrow viewport`);
  }
  await expectNoPrivateError();
  assert.equal(downloads, 0, 'profile maintenance does not add export/download side effects');
  assert.deepEqual(await page.evaluate(() => window.organizationProfileHarness.unexpectedFetches), []);
  assert.deepEqual(unexpectedApi, [], 'no synthetic request reaches an API socket');
  assert.deepEqual(unexpectedRemote, [], 'acceptance uses no live external services');
  assert.deepEqual(pageErrors, []);
  console.log('Organization profile browser passed: real service/header/body boundary, all fields, current/scheduled persistence, safe validation/conflict/failure, separate readiness, health/context/callback races, duplicate submits, unmount, keyboard and narrow layout.');
} finally {
  await browser.close();
}
