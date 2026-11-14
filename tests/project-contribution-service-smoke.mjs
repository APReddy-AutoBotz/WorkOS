import assert from 'node:assert/strict';
import {calculateProjectContribution} from '../shared/project-contribution.mjs';
import {actualFixtureCapacity} from './support/actual-work-test.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {projectContributionCsv} from '../shared/project-contribution-artifact.mjs';

process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map(), calls = [], fallback = [];
globalThis.sessionStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
globalThis.localStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(key => [key, () => {fallback.push(key); throw Error('No project report fallback');}]));
globalThis.window = {localStorage, location: {pathname: '/projects', href: '/projects'}, dispatchEvent: () => true};
const scope = {organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal'};
const user = {id: 'synthetic-user', employeeId: 'synthetic-worker', role: 'Admin', permissionRole: 'Admin', permissions: ['projects.view', 'employees.view', 'reports.view_utilization', 'reports.export']};
values.set('workos_session', JSON.stringify(user));
values.set('workos_organization_scope', JSON.stringify(scope));
values.set('workos_api_token', 'synthetic-project-session');
const {projectContributionService: service, captureProjectContributionContext: capture, decodeProjectContributionResult: decode} = await import('../src/services/projectContribution.ts');
const selection = {projectId: 'synthetic-project', startsOn: '2026-10-24', endsOn: '2026-10-24'};
const worker = {employeeId: 'synthetic-worker', capacity: actualFixtureCapacity(), rows: [{id: 'entry', date: selection.startsOn, status: 'Approved', hoursExact: '2', disposition: 'included', reason: null}]};
const computed = calculateProjectContribution({...selection, workers: [worker]});
const result = {...computed, sourceToken: 'a'.repeat(64), observedAt: '2026-10-24T12:00:00.000000Z'};
const response = {contractVersion: 'project-contribution/1', ...scope, project: {id: selection.projectId, name: 'Synthetic project'}, workers: [{id: worker.employeeId, code: 'SYN', name: 'Synthetic worker'}], result};
let reply = response, afterFetch = () => {};
globalThis.fetch = async (url, init) => {calls.push({url, init}); afterFetch(); return new Response(JSON.stringify(reply), {status: 200, headers: {'Content-Type': 'application/json'}});};
assert.equal((await service.period(selection, capture())).result.percentage.displayPercent, '25');
assert.equal(calls.at(-1).init.headers['X-Legal-Entity-Id'], scope.legalEntityId);
assert.match(calls.at(-1).url, /startsOn=2026-10-24&endsOn=2026-10-24/);
const corrupted = [
  {...result, projectId: 'other'}, {...result, startsOn: '2026-10-23'}, {...result, sourceToken: 'invalid'},
  {...result, extra: 'unexpected'}, {...result, workerCount: 2}, {...result, rows: [...result.rows, ...result.rows]},
  {...result, percentage: {...result.percentage, displayPercent: '50'}},
  {...result, eligibleAvailableHoursExact: '16', percentage: {numeratorExact: '25', denominatorExact: '2', displayPercent: '12.5'}},
  {...result, rows: [{...result.rows[0], controls: {...result.rows[0].controls, entryCount: 2}}]},
  {...result, controls: {...result.controls, hoursByStatus: {...result.controls.hoursByStatus, Draft: '1'}}},
  {...result, status: 'unavailable', percentage: null, reasonCodes: ['CAPACITY_UNAVAILABLE']},
  {...result, observedAt: '2026-10-23T12:00:00Z'}, {...result, rows: null},
];
for (const invalid of corrupted) assert.throws(() => decode(invalid, selection), {status: 503});
for (const invalid of [undefined, {}, {...response, extra: true}, {...response, workers: []}, {...response, project: {...response.project, id: 'other'}}, {...response, workers: [{...response.workers[0], id: 'other'}]}]) {
  reply = invalid;
  await assert.rejects(service.period(selection, capture()), {status: 503});
}
reply = {...response, legalEntityId: 'other'};
await assert.rejects(service.period(selection, capture()), {status: 403});
reply = {...response, result: {...calculateProjectContribution({...selection, workers: [worker], sourceLimited: true}), sourceToken: result.sourceToken, observedAt: result.observedAt}};
await assert.rejects(service.period(selection, capture()), {status: 503}, 'a source-limited result must not acknowledge a partial worker roster');
reply = response;
let current = true;
const lease = capture(() => current);
afterFetch = () => {current = false;};
await assert.rejects(service.period(selection, lease), {status: 403});
const beforeStale = calls.length;
await assert.rejects(service.period(selection, lease), {status: 403});
assert.equal(calls.length, beforeStale);
afterFetch = () => {values.set('workos_api_token', 'synthetic-replacement-session');};
await assert.rejects(service.period(selection, capture()), {status: 403});
afterFetch = () => {};
for (const permission of ['projects.view', 'employees.view', 'reports.view_utilization']) {
  values.set('workos_session', JSON.stringify({...user, permissions: user.permissions.filter(value => value !== permission)}));
  assert.equal(capture(), null, permission);
}
values.set('workos_session', JSON.stringify(user));
const envelope = (input, observedAt = result.observedAt) => ({...calculateProjectContribution({...selection, ...input}), sourceToken: result.sourceToken, observedAt});
for (const valid of [envelope({workers: []}), envelope({workers: [worker], sourceLimited: true}), envelope({workers: [worker], periodIsActual: false}, '2026-10-23T12:00:00Z'), envelope({workers: [{...worker, capacity: actualFixtureCapacity(selection.startsOn, {profiles: []})}]}), envelope({workers: [{...worker, rows: [{...worker.rows[0], disposition: 'unresolved', reason: 'APPROVAL_EVIDENCE_UNAVAILABLE'}]}]})]) assert.equal(decode(valid, selection), valid);
assert.deepEqual(fallback, []);
console.log('Project report strict result/control reconciliation, malformed envelopes, scope/request/identity changes, live client permissions and production no-fallback checks passed.');

const {projectContributionEvidenceService: exports} = await import('../src/services/projectContributionEvidence.ts');
const intent = {requestId: randomUUID(), expectedSourceToken: result.sourceToken, reason: 'Synthetic export'};
const csv = projectContributionCsv(scope, result), id = randomUUID();
const retained = {id, requestId: intent.requestId, createdAt: '2026-10-24T13:00:00.000Z', activeRole: 'Admin', source: 'Web', reason: intent.reason,
  result, artifact: {fileName: `project-contribution-${id}.csv`, sha256: createHash('sha256').update(csv).digest('hex'), bytes: Buffer.byteLength(csv)}};
const exportEnvelope = {contractVersion: 'project-contribution/1', ...scope, projectId: selection.projectId};
const savedReply = {...exportEnvelope, evidence: retained, csv, replayed: false};
reply = savedReply;
assert.equal((await exports.retain(selection, intent, capture())).csv, csv);
assert.equal(calls.at(-1).init.method, 'POST');
assert.equal(JSON.parse(calls.at(-1).init.body).requestId, intent.requestId);
reply = {...exportEnvelope, evidence: retained};
assert.equal((await exports.reconcile(selection, intent, capture())).id, id);
assert.equal(calls.at(-1).init.method, 'GET');
reply = {...exportEnvelope, evidence: retained, csv};
assert.equal((await exports.artifact(selection, retained, capture())).csv, csv);
const badExports = [
  {...savedReply, csv: csv + 'extra'},
  {...savedReply, csv: csv + 'extra', evidence: {...retained, artifact: {...retained.artifact, bytes: Buffer.byteLength(csv + 'extra'), sha256: createHash('sha256').update(csv + 'extra').digest('hex')}}},
  {...savedReply, evidence: {...retained, requestId: randomUUID()}},
  {...savedReply, evidence: {...retained, reason: 'Different command'}},
  {...savedReply, evidence: {...retained, artifact: {...retained.artifact, fileName: '../unsafe.csv'}}},
  {...savedReply, evidence: {...retained, artifact: {...retained.artifact, bytes: 1}}},
  {...savedReply, evidence: {...retained, artifact: {...retained.artifact, sha256: '0'.repeat(64)}}},
  {...savedReply, evidence: {...retained, extra: true}}, {...savedReply, replayed: 'false'},
];
for (const bad of badExports) {reply = bad; await assert.rejects(exports.retain(selection, intent, capture()), {status: 503});}
reply = {...savedReply, organizationId: 'other'};
await assert.rejects(exports.retain(selection, intent, capture()), {status: 403});
const history = {...exportEnvelope, startsOn: selection.startsOn, endsOn: selection.endsOn, evidence: [retained], nextBefore: null};
reply = history;
assert.equal((await exports.history(selection, null, capture())).evidence.length, 1);
for (const bad of [{...history, evidence: [retained, retained]}, {...history, nextBefore: id}, {...history, startsOn: '2026-10-23'}, {...history, evidence: [{...retained, id: 'bad'}]}]) {
  reply = bad; await assert.rejects(exports.history(selection, null, capture()), {status: 503});
}
reply = history;
await assert.rejects(exports.history(selection, id, capture()), {status: 503}, 'cursor cannot repeat in its next page');
const beforeDenied = calls.length;
values.set('workos_session', JSON.stringify({...user, permissions: user.permissions.filter(permission => permission !== 'reports.export')}));
await assert.rejects(exports.history(selection, null, capture()), {status: 403});
assert.equal(calls.length, beforeDenied);
values.set('workos_session', JSON.stringify(user));
reply = savedReply;
afterFetch = () => {values.set('workos_api_token', 'synthetic-late-export-session');};
await assert.rejects(exports.retain(selection, intent, capture()), {status: 403});
assert.deepEqual(fallback, []);
console.log('Project retained export strict acknowledgements, exact CSV/hash/bytes, request identity, history pagination, scope/permission and stale-session negatives passed.');
