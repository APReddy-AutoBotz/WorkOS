import assert from 'node:assert/strict';

// Hosted browser CI owns execution. Do not start a local browser/server or use
// a socket workaround in a task environment that restricts local listeners.
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
const endDate = new Date(Date.now() + 86400000 * 60).toISOString().slice(0, 10);
const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
const fields = ['singular', 'plural', 'helpText'];
const configuration = (prefix = 'Synthetic Current', effectiveFrom = today) => ({
  terms: Object.fromEntries(keys.map(key => [key, {
    singular: `${prefix} ${key}`, plural: `${prefix} ${key} plural`, helpText: `${prefix} help for ${key}`,
  }])), effectiveFrom,
});
const raw = value => ({terms: value.terms, effective_from: `${value.effectiveFrom}T00:00:00.000Z`});
const input = (key, field) => page.getByLabel(`${key} ${field === 'helpText' ? 'help text' : field}`, {exact: true});
const dateInput = () => page.getByLabel('Effective from', {exact: true});
const button = name => page.getByRole('button', {name, exact: true});
const reload = () => button('Reload terminology');
const save = () => button('Save terminology');
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const calls = () => page.evaluate(() => window.terminologyConfigurationHarness.calls);
const count = async kind => (await calls()).filter(call => call.kind === kind).length;
const lastId = async () => Math.max(0, ...(await calls()).map(call => call.id));
const pending = async (kind, after = 0) => {
  await page.waitForFunction(({kind, after}) => window.terminologyConfigurationHarness.pending.some(call => call.kind === kind && call.id > after), {kind, after});
  return page.evaluate(({kind, after}) => {
    const {id, kind: requestKind, url, method, headers, credentials, body} = window.terminologyConfigurationHarness.pending.filter(call => call.kind === kind && call.id > after).at(-1);
    return {id, kind: requestKind, url, method, headers, credentials, body};
  }, {kind, after});
};
const settle = (request, result, status) => page.evaluate(({id, result, status}) => window.terminologyConfigurationHarness.settle(id, result, status), {id: request.id, result, status});
let fixtureToken;
const headers = (request, organizationId = 'org-a', legalEntityId = 'legal-a', token = fixtureToken) => {
  assert.deepEqual(request.headers, {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-organization-id': organizationId, 'x-legal-entity-id': legalEntityId,
  }, `${request.kind} retains only real JSON/authentication/captured-scope headers`);
  assert.equal(request.credentials, 'include');
  assert.equal(request.url, '/api/organization-setup/terminology');
  assert.equal(request.method, request.kind === 'save' ? 'POST' : 'GET');
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
const reader = async (after = 0, organizationId = 'org-a', legalEntityId = 'legal-a') => {
  const request = await pending('terminology', after);
  headers(request, organizationId, legalEntityId);
  assert.equal(request.body, null);
  return request;
};
const expectConfiguration = async expected => {
  await page.waitForFunction(value => document.getElementById('term-employee-singular')?.value === value, expected.terms.employee.singular);
  for (const key of keys) {
    await page.getByRole('heading', {name: `Canonical key: ${key}`, exact: true}).waitFor();
    for (const field of fields) assert.equal(await input(key, field).inputValue(), expected.terms[key][field], `${key} ${field} reflects accepted server evidence`);
  }
  assert.equal(await dateInput().inputValue(), expected.effectiveFrom);
  assert.equal(await save().isEnabled(), true);
};
const successText = value => value.effectiveFrom > today
  ? `Terminology scheduled for ${value.effectiveFrom}. Currently effective labels remain in use until that date and a runtime reload.`
  : 'Terminology saved. Runtime labels refresh from the currently effective server version.';
const expectNoSuccess = async () => {
  assert.equal(await page.getByText(/^Terminology saved\./).count(), 0);
  assert.equal(await page.getByText(/^Terminology scheduled for /).count(), 0);
};
const expectNoPrivateError = async () => {
  const body = await page.locator('body').innerText();
  for (const marker of ['synthetic-private', 'synthetic-secret', '/internal/provider', 'SYNTHETIC_PRIVATE_ERROR_CODE']) {
    assert.equal(body.includes(marker), false, 'private provider and network details cannot escape into the UI');
  }
};
const expectInvalidated = async () => {
  await page.getByRole('alert').getByText('Scope or access changed. Draft cleared.', {exact: false}).waitFor();
  await expectNoSuccess();
  assert.equal(await page.getByRole('form', {name: 'Terminology configuration editor'}).count(), 0, 'invalid context clears all 27 terminology fields');
};
const open = async ({strict = false, runtime = false, access = 'manage'} = {}) => {
  const params = new URLSearchParams({...(strict ? {strict: '1'} : {}), ...(runtime ? {runtime: '1'} : {}), ...(access === 'none' ? {access} : {})});
  await page.goto(`${baseUrl}/tests/fixtures/terminology-configuration.html?${params}`);
  await page.getByRole('heading', {name: 'Terminology configuration', exact: true}).waitFor();
  fixtureToken = await page.evaluate(() => window.terminologyConfigurationHarness.syntheticToken);
};
const boot = async (value = configuration()) => {
  await open();
  await health();
  const request = await reader();
  await settle(request, raw(value));
  await expectConfiguration(value);
  return request;
};
const edit = async value => {
  for (const key of keys) for (const field of fields) await input(key, field).fill(value.terms[key][field]);
  await dateInput().fill(value.effectiveFrom);
};
const completeSave = async (request, value) => {
  await settle(request, raw(value));
  await page.getByRole('status').getByText(successText(value), {exact: true}).waitFor();
  await expectConfiguration(value);
  assert.equal((await calls()).filter(call => call.kind === 'terminology' && call.id > request.id).length, 0, 'without a runtime wrapper the POST response owns the accepted draft; no synthetic follow-up GET');
};
const explicitReload = async (value = configuration(), scope = {organizationId: 'org-a', legalEntityId: 'legal-a'}) => {
  const after = await lastId();
  await reload().click();
  await expectNoSuccess();
  await health(after);
  const request = await reader(after, scope.organizationId, scope.legalEntityId);
  await settle(request, raw(value));
  await expectConfiguration(value);
  await expectNoSuccess();
  return request;
};
const capture = (label, kind) => page.evaluate(({label, kind}) => window.terminologyConfigurationHarness.capture(label, kind), {label, kind});
const invoke = labels => page.evaluate(labels => window.terminologyConfigurationHarness.invoke(labels), labels);
const expectNoDispatch = async (before, reason) => { await flush(); assert.deepEqual(await calls(), before, reason); };
const runtimeSnapshot = () => page.evaluate(() => window.terminologyConfigurationHarness.runtimeSnapshot());
const runtimeState = () => page.evaluate(() => window.terminologyConfigurationHarness.runtimeState());
const runtimeSubset = value => Object.fromEntries(['employee', 'project', 'worklog'].map(key => [key, value.terms[key]]));
const expectRuntime = async value => {
  assert.deepEqual(await runtimeSnapshot(), runtimeSubset(value));
  assert.equal(await page.getByTestId('live-navigation').innerText(), value.terms.employee.plural);
  assert.equal(await page.getByTestId('live-form').innerText(), value.terms.project.singular);
  assert.equal(await page.getByTestId('live-report').innerText(), value.terms.worklog.plural);
  assert.equal(await page.getByTestId('live-navigation').getAttribute('href'), '/employees', 'runtime labels never rewrite canonical routes');
};
const finishRuntimeRemount = async (after, currentValue, expectedMounts, scope = {organizationId: 'org-a', legalEntityId: 'legal-a'}) => {
  await page.waitForFunction(mounts => window.terminologyConfigurationHarness.runtimeState().mounts > mounts, expectedMounts);
  await health(after);
  const remountedRead = await reader(after, scope.organizationId, scope.legalEntityId);
  await settle(remountedRead, raw(currentValue));
  await expectConfiguration(currentValue);
  return remountedRead;
};
const bootRuntime = async (value = configuration()) => {
  await open({runtime: true});
  // The editor's health-gated read and wrapper's direct runtime read are real,
  // concurrent production requests. Settle runtime first to force its remount.
  const initialHealth = await pending('health');
  const initialRuntime = await reader();
  const before = await runtimeState();
  await settle(initialRuntime, raw(value));
  await finishRuntimeRemount(initialRuntime.id, value, before.mounts);
  const beforeObsolete = await calls();
  await settle(initialHealth, undefined, 503);
  await expectNoDispatch(beforeObsolete, 'obsolete pre-runtime-remount health cannot dispatch another editor read');
  await expectRuntime(value);
  return value;
};

try {
  await open({access: 'none'});
  await expectInvalidated();
  assert.deepEqual(await calls(), [], 'an Admin name without settings.manage cannot even dispatch health');

  // All nine approved canonical keys expose independent singular/plural/help
  // fields. Extra response metadata and effectiveTo must not become writable.
  await open();
  await health();
  const initial = await reader();
  const original = configuration();
  await settle(initial, {...raw(original), effective_to: `${endDate}T00:00:00.000Z`, id: 'synthetic-version',
    organizationId: 'not-a-writable-field', auditActor: 'not-a-writable-field',
    terms: Object.fromEntries(keys.map(key => [key, {...original.terms[key], readonlyMetadata: 'not-writable'}])),
  });
  await expectConfiguration(original);
  assert.equal(await page.locator('form input').count(), 19, 'only 18 term inputs plus effective date are editable');
  assert.equal(await page.locator('form textarea').count(), 9);
  for (const key of keys) {
    assert.equal(await page.getByRole('textbox', {name: `Canonical key: ${key}`, exact: true}).count(), 0, 'canonical keys are headings, not editable identity fields');
    for (const field of fields) assert.equal(await input(key, field).getAttribute('maxlength'), field === 'helpText' ? '500' : '100');
  }
  const beforeDraftRuntime = await runtimeSnapshot();
  const changed = configuration('Synthetic Edited');
  changed.terms.employee = {singular: 'person', plural: 'people', helpText: 'People perform work.\n<b>This is plain text, not markup.</b>'};
  changed.terms.manager = {singular: 'staff', plural: 'staff', helpText: 'Uncountable approved manager label.'};
  await edit(changed);
  assert.equal(await page.getByTestId('navigation-preview').innerText(), `Navigation: people · ${changed.terms.project.plural}`);
  assert.equal(await page.getByTestId('form-preview').innerText(), `Form: ${changed.terms.project.singular} name · staff`);
  assert.equal(await page.getByTestId('report-preview').innerText(), `Report: ${changed.terms.worklog.plural} · ${changed.terms.engagement.plural}`);
  assert.equal(await page.getByTestId('help-preview').innerText(), `Help: ${changed.terms.employee.helpText}`);
  assert.equal(await page.getByTestId('help-preview').locator('b').count(), 0, 'help text is rendered as text, never HTML');
  assert.deepEqual(await runtimeSnapshot(), beforeDraftRuntime, 'representative previews never mutate shared runtime terminology');
  assert.equal(await count('save'), 0);
  await save().focus();
  await page.keyboard.press('Enter');
  const firstSave = await pending('save');
  headers(firstSave);
  assert.deepEqual(firstSave.body, changed, 'POST contains exactly nine approved structured values and effectiveFrom; no identity, effectiveTo or response metadata');
  assert.deepEqual(Object.keys(firstSave.body), ['terms', 'effectiveFrom']);
  assert.deepEqual(Object.keys(firstSave.body.terms), keys);
  for (const key of keys) assert.deepEqual(Object.keys(firstSave.body.terms[key]), fields);
  assert.equal(await button('Saving terminology…').isDisabled(), true);
  assert.equal(await reload().isDisabled(), true);
  for (const key of keys) for (const field of fields) assert.equal(await input(key, field).isDisabled(), true);
  assert.equal(await dateInput().isDisabled(), true);
  await completeSave(firstSave, changed);
  assert.equal((await runtimeState()).scopeEvents, 1, 'successful POST publishes the existing runtime refresh event exactly once');
  assert.deepEqual(await runtimeSnapshot(), beforeDraftRuntime, 'the plain editor does not bypass the real runtime GET to globally apply draft or POST labels');
  await input('project', 'singular').fill('Synthetic Unsaved After Success');
  await expectNoSuccess();
  await explicitReload(changed);

  // A future POST remains visibly scheduled. Explicit reload is current state,
  // not the saved future draft, and a plain GET alone never claims a save.
  await boot();
  const scheduled = configuration('Synthetic Future', futureDate);
  await edit(scheduled);
  await save().click();
  const futureSave = await pending('save');
  assert.equal(futureSave.body.effectiveFrom, futureDate);
  await completeSave(futureSave, scheduled);
  assert.equal(await page.getByText('Terminology saved.', {exact: false}).count(), 0);
  await explicitReload(original);

  // Native validation blocks malformed required labels/dates before dispatch.
  for (const [key, field, value] of [['employee', 'singular', ''], ['project', 'plural', ''], ['manager', 'singular', '   '], ['date', null, '']]) {
    await boot();
    const target = key === 'date' ? dateInput() : input(key, field);
    await target.fill(value);
    assert.equal(await target.evaluate(element => element.validity.valid), false);
    const before = await calls();
    await save().click();
    await expectNoDispatch(before, `${key} ${field || 'date'} native validation prevents POST`);
    await expectNoSuccess();
  }
  await boot();
  await input('employee', 'helpText').fill('');
  await save().click();
  const emptyHelp = await pending('save');
  assert.equal(emptyHelp.body.terms.employee.helpText, '', 'help text is intentionally optional');
  await settle(emptyHelp, undefined, 400);

  // Server errors are safe, contextual and never an implicit retry or success.
  for (const status of [400, 409, 401, 403, 503, 'network', 'malformed-json']) {
    await boot();
    await input('employee', 'singular').fill(`Synthetic Rejected ${status}`);
    await save().click();
    const request = await pending('save');
    headers(request);
    await settle(request, undefined, status);
    const message = status === 400 ? 'Terminology was not saved. Check the fields and effective date.'
      : status === 409 ? 'Terminology was not saved because its effective date conflicts with the latest server version. Reload before making another change.'
      : status === 401 || status === 403 ? 'Terminology access could not be confirmed. Reload after checking your access.'
      : 'Save could not be confirmed. Reload terminology before trying again.';
    await page.getByRole('alert').getByText(message, {exact: true}).waitFor();
    await expectNoSuccess();
    await expectNoPrivateError();
    assert.equal(await count('save'), 1);
    assert.equal(await count('terminology'), 1, 'failed POST cannot trigger a runtime refresh');
    assert.equal((await runtimeState()).scopeEvents, 0);
    assert.equal(new URL(page.url()).pathname, '/tests/fixtures/terminology-configuration.html', '401 remains safely within the owned editor instead of redirecting');
  }
  for (const malformed of [
    {terms: null, effective_from: today},
    {...raw(original), terms: {...original.terms, unapprovedKey: 'Synthetic extra'}},
    {...raw(original), terms: {...original.terms, project: {singular: 'Project', helpText: ''}}},
    {...raw(original), effective_from: '2026-02-31'},
  ]) {
    await boot();
    await save().click();
    const request = await pending('save');
    await settle(request, malformed);
    await page.getByRole('alert').getByText('Save could not be confirmed. Reload terminology before trying again.', {exact: true}).waitFor();
    await expectNoSuccess();
    assert.equal((await runtimeState()).scopeEvents, 0, 'malformed POST success cannot publish a refresh or manufacture saved evidence');
  }
  for (const status of [400, 409, 401, 403, 503, 'network', 'malformed-json']) {
    await open();
    await health();
    const request = await reader();
    await settle(request, undefined, status);
    await page.getByRole('alert').waitFor();
    assert.equal(await input('employee', 'singular').count(), 0, 'failed GET cannot manufacture an editable default configuration');
    await expectNoSuccess();
    await expectNoPrivateError();
    assert.equal(await count('save'), 0);
  }
  await open();
  await health();
  const malformedRead = await reader();
  await settle(malformedRead, {terms: {employee: {singular: '', plural: 'people', helpText: ''}}, effective_from: today});
  await page.getByRole('alert').waitFor();
  assert.equal(await input('employee', 'singular').count(), 0);

  // Offline health is fail-closed but explicit reload must recheck and recover.
  for (const status of [503, 'network', 'malformed-json', 'disconnected']) {
    await open();
    const request = await pending('health');
    await settle(request, {database: 'disconnected'}, status === 'disconnected' ? undefined : status);
    await page.getByRole('alert').getByText('Terminology could not be loaded. Check your connection and try again.', {exact: true}).waitFor();
    assert.equal(await count('terminology'), 0);
    assert.equal(await input('employee', 'singular').count(), 0);
    await explicitReload(original);
    assert.equal(await count('health'), 2, 'reload does not stay trapped in an old health failure');
  }

  // Initial health belongs to the initiating access/scope generation only.
  await open();
  const delayedHealth = await pending('health');
  await page.evaluate(() => window.terminologyConfigurationHarness.scope('org-b', 'legal-b'));
  await expectInvalidated();
  await settle(delayedHealth, {database: 'connected'});
  await flush();
  assert.deepEqual((await calls()).map(call => call.kind), ['health']);
  const valueB = configuration('Synthetic Scope B');
  await explicitReload(valueB, {organizationId: 'org-b', legalEntityId: 'legal-b'});

  // Reload must synchronously revoke retained submit/reload callback leases.
  await boot();
  await capture('before-reload-submit');
  await capture('before-reload-button', 'reload');
  const beforeReload = await lastId();
  await page.evaluate(() => window.terminologyConfigurationHarness.reloadAndInvoke(['before-reload-submit']));
  await health(beforeReload);
  const refreshed = await reader(beforeReload);
  await settle(refreshed, raw(original));
  await expectConfiguration(original);
  const beforeRetained = await calls();
  await invoke(['before-reload-submit', 'before-reload-button']);
  await expectNoDispatch(beforeRetained, 'old-generation callbacks cannot borrow a new loaded draft');

  for (const event of ['workos:organization-scope-switch-requested', 'workos:organization-scope-changed', 'storage', 'focus']) {
    await boot();
    await input('employee', 'singular').fill('Synthetic Invalidated Draft');
    await capture(`event-${event}`);
    const before = await calls();
    await page.evaluate(({event, label}) => {
      if (event === 'workos:organization-scope-switch-requested') window.terminologyConfigurationHarness.event(event, [label]);
      else if (event === 'focus') window.terminologyConfigurationHarness.identity('synthetic-admin-b', 'Admin', true, event, [label]);
      else window.terminologyConfigurationHarness.scope('org-b', 'legal-b', event, [label]);
    }, {event, label: `event-${event}`});
    await expectInvalidated();
    await expectNoDispatch(before, `${event} invalidates callbacks before React can rerender`);
  }
  for (const change of ['permission', 'role', 'actor', 'token', 'token-removed', 'legal-entity', 'scope-removed']) {
    await boot();
    await capture(`silent-${change}`);
    const before = await calls();
    await page.evaluate(({change, label}) => {
      if (change === 'permission') window.terminologyConfigurationHarness.identity('synthetic-admin-a', 'Admin', false, null, [label]);
      if (change === 'role') window.terminologyConfigurationHarness.identity('synthetic-admin-a', 'HR', true, null, [label]);
      if (change === 'actor') window.terminologyConfigurationHarness.identity('synthetic-admin-b', 'Admin', true, null, [label]);
      if (change === 'token') window.terminologyConfigurationHarness.token('synthetic-terminology-token-b', null, [label]);
      if (change === 'token-removed') window.terminologyConfigurationHarness.token(null, null, [label]);
      if (change === 'legal-entity') window.terminologyConfigurationHarness.scope('org-a', 'legal-other', null, [label]);
      if (change === 'scope-removed') window.terminologyConfigurationHarness.scope(null, null, null, [label]);
    }, {change, label: `silent-${change}`});
    await expectNoDispatch(before, `${change} is checked at dispatch time without relying on event delivery`);
    await page.evaluate(() => window.terminologyConfigurationHarness.event('focus'));
    await expectInvalidated();
  }
  await open();
  await health();
  const revokedRead = await reader();
  await page.evaluate(() => window.terminologyConfigurationHarness.identity('synthetic-admin-a', 'Admin', false, 'storage'));
  await expectInvalidated();
  const beforeRevoked = await calls();
  await settle(revokedRead, raw(configuration('Synthetic Revoked Completion')));
  await expectNoDispatch(beforeRevoked, 'permission loss rejects an already-dispatched GET completion');
  await expectInvalidated();

  await boot();
  const single = configuration('Synthetic Single Submission');
  await edit(single);
  await page.evaluate(() => window.terminologyConfigurationHarness.submitTwice());
  const onlySave = await pending('save');
  await flush();
  assert.equal(await count('save'), 1, 'same-JavaScript-turn duplicate submit is locked before React disabled state');
  await completeSave(onlySave, single);

  await boot();
  await input('employee', 'singular').fill('Synthetic Original Scope Save');
  await save().click();
  const oldSave = await pending('save');
  headers(oldSave);
  await page.evaluate(() => window.terminologyConfigurationHarness.scope('org-b', 'legal-b'));
  await expectInvalidated();
  await explicitReload(valueB, {organizationId: 'org-b', legalEntityId: 'legal-b'});
  const beforeOldSave = await calls();
  const beforeOldSaveEvents = (await runtimeState()).scopeEvents;
  await settle(oldSave, raw(configuration('Synthetic Old Scope Completion')));
  await expectNoDispatch(beforeOldSave, 'old-scope POST completion cannot resubmit or start another editor read');
  assert.equal((await runtimeState()).scopeEvents, beforeOldSaveEvents, 'stale POST completion must not publish a runtime refresh in the replacement scope');
  await expectConfiguration(valueB);
  await expectNoSuccess();
  assert.equal(oldSave.headers['x-organization-id'], 'org-a', 'already-dispatched mutation retains original scope');

  // A to B to A rejects stale same-string scope responses and failures.
  await boot();
  const beforeA = await lastId();
  await reload().click();
  await health(beforeA);
  const oldA = await reader(beforeA);
  await page.evaluate(() => window.terminologyConfigurationHarness.scope('org-b', 'legal-b'));
  await reload().click();
  await health(oldA.id);
  const oldB = await reader(oldA.id, 'org-b', 'legal-b');
  await page.evaluate(() => window.terminologyConfigurationHarness.scope('org-a', 'legal-a'));
  await reload().click();
  await health(oldB.id);
  const newestA = await reader(oldB.id);
  const currentA = configuration('Synthetic Newest A');
  await settle(newestA, raw(currentA));
  await expectConfiguration(currentA);
  await settle(oldA, raw(configuration('Synthetic Stale Same Scope')));
  await settle(oldB, undefined, 503);
  await flush();
  await expectConfiguration(currentA);
  assert.equal(await page.getByRole('alert').count(), 0);

  await open();
  const unmountedHealth = await pending('health');
  await page.evaluate(() => window.terminologyConfigurationHarness.hide());
  await page.getByRole('heading', {name: 'Terminology configuration', exact: true}).waitFor({state: 'detached'});
  await settle(unmountedHealth, {database: 'connected'});
  await flush();
  assert.deepEqual((await calls()).map(call => call.kind), ['health']);
  await boot();
  await capture('unmounted-submit');
  await save().click();
  const unmountedSave = await pending('save');
  await page.evaluate(() => window.terminologyConfigurationHarness.hide());
  await page.getByRole('heading', {name: 'Terminology configuration', exact: true}).waitFor({state: 'detached'});
  const beforeUnmountCompletion = await calls();
  await invoke(['unmounted-submit']);
  await settle(unmountedSave, raw(configuration('Synthetic Unmounted Completion')));
  await expectNoDispatch(beforeUnmountCompletion, 'unmounted completion and retained callbacks cannot dispatch another request');
  await page.evaluate(() => window.terminologyConfigurationHarness.show());
  await health(unmountedSave.id);
  const remounted = await reader(unmountedSave.id);
  await settle(remounted, raw(original));
  await expectConfiguration(original);
  await expectNoSuccess();

  await open({strict: true});
  await page.waitForFunction(() => window.terminologyConfigurationHarness.pending.filter(call => call.kind === 'health').length === 2);
  const strictHealth = await page.evaluate(() => window.terminologyConfigurationHarness.pending.filter(call => call.kind === 'health').map(({id}) => ({id})));
  await settle(strictHealth[1], {database: 'connected'});
  const strictRead = await reader(strictHealth[1].id);
  const replayed = configuration('Synthetic StrictMode Current');
  await settle(strictRead, raw(replayed));
  await expectConfiguration(replayed);
  const beforeObsoleteHealth = await calls();
  await settle(strictHealth[0], undefined, 503);
  await expectNoDispatch(beforeObsoleteHealth, 'obsolete StrictMode health cannot dispatch a stale GET');
  await expectConfiguration(replayed);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await count('terminology'), 1);
  await capture('strict-old-submit');
  await capture('strict-old-reload', 'reload');
  await explicitReload(original);
  const beforeStrictCallbacks = await calls();
  await invoke(['strict-old-submit', 'strict-old-reload']);
  await expectNoDispatch(beforeStrictCallbacks, 'StrictMode replay does not grant old callbacks a new generation');

  // Real RuntimeTerminology wrapper regression: successful POST -> existing
  // event -> GET -> runtime labels -> child remount -> owned success survives.
  // Repeat for future-effective scheduling, whose GET still returns current.
  for (const scheduledSave of [false, true]) {
    await bootRuntime(original);
    const proposed = configuration(scheduledSave ? 'Synthetic Runtime Future' : 'Synthetic Runtime Saved', scheduledSave ? futureDate : today);
    await edit(proposed);
    await capture('runtime-old-submit');
    await capture('runtime-old-reload', 'reload');
    await expectRuntime(original);
    const beforeRuntimeSave = await runtimeState();
    await save().click();
    const request = await pending('save');
    headers(request);
    assert.deepEqual(request.body, proposed);
    await settle(request, raw(proposed));
    const refresh = await reader(request.id);
    assert.equal((await runtimeState()).scopeEvents, beforeRuntimeSave.scopeEvents + 1, 'real successful POST dispatches one existing runtime event');
    assert.deepEqual(await runtimeSnapshot(), runtimeSubset(original), 'POST does not apply its own labels before runtime GET');
    const currentValue = scheduledSave ? original : proposed;
    await settle(refresh, raw(currentValue));
    await finishRuntimeRemount(refresh.id, currentValue, beforeRuntimeSave.mounts);
    await expectRuntime(currentValue);
    await page.getByRole('status').getByText(successText(proposed), {exact: true}).waitFor();
    assert.equal(await count('save'), 1, 'runtime remount preserves feedback without replaying POST');
    const beforeStaleRuntimeCallbacks = await calls();
    await invoke(['runtime-old-submit', 'runtime-old-reload']);
    await expectNoDispatch(beforeStaleRuntimeCallbacks, 'remounted runtime children cannot reuse old editor callback leases');
    if (scheduledSave) {
      assert.equal(await dateInput().inputValue(), today, 'remounted editor reads current-effective data while retaining the owned scheduled banner');
      assert.notEqual((await runtimeSnapshot()).employee.singular, proposed.terms.employee.singular, 'scheduled future POST terms never masquerade as current runtime labels');
    }
    await explicitReload(currentValue);
    await expectRuntime(currentValue);
    assert.equal(await count('save'), 1);
  }

  // The same real wrapper must not refresh/remount a replacement-scope draft
  // when an original-scope mutation happens to finish after the scope switch.
  await bootRuntime(original);
  await save().click();
  const originalScopePost = await pending('save');
  const beforeScopeRuntime = await runtimeState();
  await page.evaluate(() => window.terminologyConfigurationHarness.scope('org-b', 'legal-b'));
  const replacementRuntime = await reader(originalScopePost.id, 'org-b', 'legal-b');
  await settle(replacementRuntime, raw(valueB));
  await finishRuntimeRemount(replacementRuntime.id, valueB, beforeScopeRuntime.mounts, {organizationId: 'org-b', legalEntityId: 'legal-b'});
  await expectRuntime(valueB);
  const replacementDraft = configuration('Synthetic Scope B');
  replacementDraft.terms.project.singular = 'Synthetic Retained Scope B Draft';
  await input('project', 'singular').fill(replacementDraft.terms.project.singular);
  const beforeStalePostCalls = await calls();
  const beforeStalePostState = await runtimeState();
  await settle(originalScopePost, raw(configuration('Synthetic Old Scope Saved')));
  await expectNoDispatch(beforeStalePostCalls, 'stale original-scope POST cannot refresh a replacement-scope runtime');
  assert.deepEqual(await runtimeState(), beforeStalePostState, 'stale POST cannot publish an event or remount the replacement editor');
  await expectConfiguration(replacementDraft);
  await expectRuntime(valueB);
  await expectNoSuccess();

  // Overlapping real runtime GETs use latest-request generation. A late success
  // or failure from an older same-context read cannot apply or remount children.
  for (const staleStatus of [undefined, 'network']) {
    await bootRuntime(original);
    const after = await lastId();
    await page.evaluate(() => {
      window.terminologyConfigurationHarness.event('workos:organization-scope-changed');
      window.terminologyConfigurationHarness.event('workos:organization-scope-changed');
    });
    const runtimeReads = (await calls()).filter(call => call.kind === 'terminology' && call.id > after);
    assert.equal(runtimeReads.length, 2);
    const newest = configuration('Synthetic Latest Runtime');
    const beforeNewest = await runtimeState();
    await settle(runtimeReads[1], raw(newest));
    await finishRuntimeRemount(runtimeReads[1].id, newest, beforeNewest.mounts);
    await expectRuntime(newest);
    const beforeStale = await runtimeState();
    const beforeStaleCalls = await calls();
    await settle(runtimeReads[0], raw(configuration('Synthetic Stale Runtime')), staleStatus);
    await expectNoDispatch(beforeStaleCalls, 'obsolete runtime completion cannot issue another editor GET');
    await expectRuntime(newest);
    assert.equal((await runtimeState()).mounts, beforeStale.mounts, 'obsolete runtime success/failure cannot remount the current editor');
  }

  // Runtime reads also reject an identity/token change without an event.
  await bootRuntime(original);
  const beforeRevokedRuntime = await lastId();
  await page.evaluate(() => window.terminologyConfigurationHarness.event('workos:organization-scope-changed'));
  const identityOwnedRuntime = await reader(beforeRevokedRuntime);
  const beforeIdentityMounts = await runtimeState();
  await page.evaluate(() => window.terminologyConfigurationHarness.token('synthetic-terminology-token-b', null));
  await settle(identityOwnedRuntime, raw(configuration('Synthetic Wrong Token Runtime')));
  await flush();
  assert.deepEqual(await runtimeSnapshot(), runtimeSubset(original));
  assert.equal((await runtimeState()).mounts, beforeIdentityMounts.mounts);
  await page.evaluate(() => window.terminologyConfigurationHarness.event('focus'));
  await expectInvalidated();

  // Keyboard-only input/submit, labels and all fields fit a narrow viewport.
  await boot();
  await page.setViewportSize({width: 390, height: 844});
  await input('employee', 'singular').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Synthetic Keyboard Person');
  await save().focus();
  assert.equal(await save().evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  const keyboardSave = await pending('save');
  const keyboardValue = configuration();
  keyboardValue.terms.employee.singular = 'Synthetic Keyboard Person';
  await completeSave(keyboardSave, keyboardValue);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal overflow at 390px');
  for (const key of keys) for (const field of fields) {
    const bounds = await input(key, field).boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `${key} ${field} fits the 390px viewport`);
  }
  const dateBounds = await dateInput().boundingBox();
  assert(dateBounds && dateBounds.x >= 0 && dateBounds.x + dateBounds.width <= 391);
  await expectNoPrivateError();
  assert.equal(downloads, 0, 'terminology configuration has no export/download side effects');
  assert.deepEqual(await page.evaluate(() => window.terminologyConfigurationHarness.unexpectedFetches), []);
  assert.deepEqual(unexpectedApi, [], 'mocked fetch never reaches a real API socket');
  assert.deepEqual(unexpectedRemote, [], 'browser acceptance uses no live remote services');
  assert.deepEqual(pageErrors, []);
  console.log('Terminology configuration browser passed: nine structured terms, scoped real POST/GET, exact body and immutable keys, isolated previews, current/scheduled feedback through real runtime remounts, safe failures, health/access/token/generation races, duplicate submit, unmount/StrictMode, keyboard and 390px layout.');
} finally {
  await browser.close();
}
