import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assignmentApprovalIdentity } from '../shared/assignment-approval.mjs';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map(), fallback = [];
globalThis.sessionStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.localStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(k => [k, () => { fallback.push(k); throw Error('No fallback'); }]));
globalThis.window = { localStorage, location: { pathname: '/approvals', href: '/approvals' }, dispatchEvent: () => true };
const { workApprovals, captureWorkApprovalContext: capture } = await import('../src/services/workApprovals.ts'), s = workApprovals.assignments;
const ids = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(8, '0') + '-1111-4111-8111-111111111111'), [actor, requester, policyId, instanceId, versionId, requestId, transitionId, templateId, noticeId, deliveryId] = ids;
const scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' }, user = { id: actor, employeeId: actor, userName: 'synthetic-assignment-actor', role: 'Admin', permissionRole: 'Admin', permissions: ['settings.manage', 'permissions.manage', 'notifications.manage', 'notifications.view', 'employees.view', 'projects.view', 'allocations.view', 'allocations.manage', 'approvals.view'] }, ownerKey = createHash('sha256').update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId])).digest('hex'), createdAt = '2026-10-25T04:00:00Z', envelope = { contractVersion: 'work-approval/1', ...scope, ownerKey, actorUserId: actor };
const definition = { entityType: 'Assignment', workerIds: ['synthetic-worker'], materialFields: ['quantityExact'], stages: [{ userId: actor, role: 'Admin' }], locale: 'en-GB', completionInApp: true, templates: ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'].map(key => ({ key, subject: 'Review {{sourceRef}}', body: 'Worker {{workerCode}} {{decisionReason}}.' })) }, policy = { id: policyId, sequence: 1, effectiveFrom: '2026-10-25', definition, actorId: actor, activeRole: 'Admin', reason: 'Synthetic adopted material policy', createdAt }, before = { assignmentId: 'synthetic-assignment', employeeId: 'synthetic-worker', projectId: 'synthetic-project', role: null, quantityUnit: 'percentage', quantityExact: '20', startsOn: '2026-10-25', endsOn: '2026-10-26', billable: false, status: 'Active', comment: null }, proposed = { role: null, quantityUnit: 'percentage', quantityExact: '25', startsOn: before.startsOn, endsOn: before.endsOn, billable: false, status: 'Active', comment: null }, source = { assignmentId: before.assignmentId, revision: 'a'.repeat(64), versionId, snapshot: before, policy }, instance = { id: instanceId, assignmentId: before.assignmentId, employeeId: before.employeeId, projectId: before.projectId, sourceRevision: source.revision, sourceVersionId: versionId, sourceToken: 'b'.repeat(64), requesterUserId: requester, requestId, reason: 'Synthetic proposal', createdAt, worker: { id: before.employeeId, code: 'SYN', name: 'Synthetic worker' }, policy, before, proposed, currentRevision: source.revision, currentVersionId: versionId, state: { status: 'Pending', sequence: 0, currentStage: 0 }, transitions: [], notificationFailures: [] }, receipt = { id: transitionId, instanceId, sequence: 1, stage: 0, decision: 'Approved', actorId: actor, activeRole: 'Admin', requestId, operationId: 'synthetic-operation', reason: 'Synthetic decision', outcome: { status: 'Approved', sequence: 1, currentStage: null }, createdAt };
const notice = { kind: 'assignment-approval', id: noticeId, eventId: assignmentApprovalIdentity(instanceId, 0, 'approval.action_required', 'synthetic-operation'), instanceId, assignmentId: before.assignmentId, sourceToken: instance.sourceToken, transitionSequence: 0, eventKey: 'approval.action_required', policyClass: 'ACTION_REQUIRED', templateId, operationId: 'synthetic-operation', locale: 'en-GB', title: 'Synthetic material review', body: 'Synthetic material source', reasons: ['current_stage_approver'], channelDecision: 'Required', deliveryId, deliveryStatus: 'Delivered', createdAt, readAt: null };
let raw, status, calls, gate, signal;
globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    signal?.();
    const body = raw, code = status, wait = gate;
    if (wait)
        await wait;
    return new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
};
const reset = () => { values.clear(); values.set('workos_session', JSON.stringify(user)); values.set('workos_organization_scope', JSON.stringify(scope)); values.set('workos_api_token', 'synthetic-token'); raw = { ...envelope, source }; status = 200; calls = []; gate = null; signal = null; };
reset();
assert.deepEqual(await s.source(before.assignmentId, capture('assignment')), source);
assert.equal(calls.length, 1);
assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-token');
assert.equal(calls[0].headers['X-Legal-Entity-Id'], scope.legalEntityId);
for (const patch of [{ assignmentId: 'redirect' }, { revision: 'invalid' }, { versionId: 'invalid' }, { snapshot: { ...before, quantityExact: 20 } }, { snapshot: { ...before, quantityUnit: 'hours' } }, { policy: { ...policy, definition: { ...definition, materialFields: [] } } }]) {
    raw = { ...envelope, source: { ...source, ...patch } };
    await assert.rejects(s.source(before.assignmentId, capture('assignment')), { status: 503 });
}
const unicodeWorkers = ['synthetic-\ue000-worker', 'synthetic-😀-worker'];
raw = { ...envelope, workers: unicodeWorkers.map(id => ({ id, code: id, name: id, status: 'Active' })), users: [], nextWorker: null, nextUser: null, today: '2026-10-25' };
assert.deepEqual((await s.choices(capture('configure'))).workers.map(w => w.id), unicodeWorkers, 'PostgreSQL C/UTF-8 worker choice order, including BMP private-use and astral identifiers');
raw = { ...raw, workers: [...raw.workers].reverse() };
await assert.rejects(s.choices(capture('configure')), { status: 503 });
raw = { ...envelope, instance };
const page = await s.instance(instanceId, capture('assignment'));
assert.deepEqual(page.instance, instance);
for (const patch of [{ sourceToken: 'invalid' }, { sourceVersionId: 'invalid' }, { before: { ...before, employeeId: 'redirect' } }, { proposed: { ...proposed, quantityUnit: 'hours' } }, { state: { status: 'Approved', sequence: 0, currentStage: null } }, { transitions: [receipt] }]) {
    raw = { ...envelope, instance: { ...instance, ...patch } };
    await assert.rejects(s.instance(instanceId, capture('assignment')), { status: 503 });
}
raw = { ...envelope, receipt, sourceToken: instance.sourceToken, replayed: false };
assert.deepEqual((await s.decide(page, 'Approved', receipt.reason, requestId, capture('assignment-decide'))).receipt, receipt);
assert.deepEqual(JSON.parse(calls.at(-1).body), { expectedSourceToken: instance.sourceToken, expectedSequence: 0, decision: 'Approved', reason: receipt.reason, requestId, expectedOwnerKey: ownerKey });
for (const patch of [{ receipt: { ...receipt, actorId: requester } }, { receipt: { ...receipt, reason: 'changed' } }, { receipt: { ...receipt, outcome: { status: 'Pending', sequence: 1, currentStage: 0 } } }, { sourceToken: 'c'.repeat(64) }, { replayed: 'true' }]) {
    raw = { ...envelope, receipt, sourceToken: instance.sourceToken, replayed: false, ...patch };
    await assert.rejects(s.decide(page, 'Approved', receipt.reason, requestId, capture('assignment-decide')), { status: 503 });
}
raw = { ...envelope, policy };
assert.deepEqual(await s.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), policy);
raw = { ...envelope, policy: { ...policy, actorId: requester } };
await assert.rejects(s.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), { status: 503 });
raw = { ...envelope, instances: [instance, instance], nextAfter: null };
await assert.rejects(s.list(capture('assignment')), { status: 503 });
raw = { ...envelope, policies: [policy], nextBefore: 1 };
await assert.rejects(s.policies(capture('configure')), { status: 503 });
raw = { ...envelope, notifications: [notice], nextAfter: null };
assert.equal((await workApprovals.inbox(null, capture('inbox'))).notifications[0].eventId, notice.eventId);
raw = { ...envelope, notification: { ...notice, readAt: createdAt } };
assert.equal((await workApprovals.read(notice, capture('inbox'))).readAt, createdAt);
raw = { ...envelope, notification: { ...notice, deliveryId: requestId, readAt: createdAt } };
await assert.rejects(workApprovals.read(notice, capture('inbox')), { status: 503 });
for (const patch of [{ ownerKey: 'f'.repeat(64) }, { actorUserId: 'invalid' }, { legalEntityId: 'other' }, { contractVersion: 'other' }]) {
    raw = { ...envelope, source, ...patch };
    await assert.rejects(s.source(before.assignmentId, capture('assignment')), { status: 503 });
}
for (const change of [() => values.set('workos_api_token', 'replacement'), () => values.set('workos_session', JSON.stringify({ ...user, permissions: [] })), () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'other' }))]) {
    reset();
    const c = capture('assignment');
    change();
    await assert.rejects(s.source(before.assignmentId, c), { status: 403 });
    assert.equal(calls.length, 0);
}
for (const code of [200, 401]) {
    reset();
    status = code;
    let release;
    gate = new Promise(r => release = r);
    const dispatched = new Promise(r => signal = r), pending = s.source(before.assignmentId, capture('assignment')).then(v => ({ v }), error => ({ error }));
    let timer;
    try {
        await Promise.race([dispatched, new Promise((_r, reject) => { timer = setTimeout(() => reject(Error('No mock dispatch')), 5000); })]);
    }
    finally {
        clearTimeout(timer);
    }
    values.set('workos_api_token', 'replacement');
    values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'other' }));
    release();
    assert((await pending).error);
    assert.equal(values.get('workos_api_token'), 'replacement');
    assert.equal(calls.length, 1);
}
for (const code of [400, 409, 422, 503]) {
    reset();
    status = code;
    await assert.rejects(s.source(before.assignmentId, capture('assignment')), { status: code });
    assert.equal(calls.length, 1);
}
assert.deepEqual(fallback, []);
console.log('Material assignment production source/policy/stage/current-version/CAS/receipt/canonical-inbox/delivery/read acknowledgement, late200/401 owner isolation and no fallback/retry passed.');

reset();
const creationPolicy = { ...policy, definition: { ...definition, creationRequired: true } }, creationId = 'a-' + versionId;
const creation = { ...instance, operationKind: 'Creation', assignmentId: creationId, requesterUserId: actor, before: null, sourceVersionId: null, currentVersionId: null, policy: creationPolicy };
raw = { ...envelope, employeeId: before.employeeId, projectId: before.projectId, policy: creationPolicy };
assert.deepEqual(await s.creationPolicy(before.employeeId, before.projectId, capture('assignment')), creationPolicy);
raw = { ...envelope, instance: creation, replayed: false };
const created = await s.requestCreation(before.employeeId, before.projectId, creationPolicy, proposed, creation.reason, requestId, capture('assignment'));
assert.equal(created.instance.operationKind, 'Creation'); assert.equal(created.instance.before, null);
assert.equal(JSON.parse(calls.at(-1).body).expectedPolicyId, policyId);
for (const patch of [{ operationKind: 'MaterialChange' }, { assignmentId: 'redirect' }, { before }, { sourceVersionId: versionId }, { employeeId: 'redirect' }, { proposed: { ...proposed, quantityExact: 25 } }, { policy: { ...creationPolicy, definition } }, { state: { status: 'Approved', sequence: 0, currentStage: null } }]) {
 raw = { ...envelope, instance: { ...creation, ...patch } };
 await assert.rejects(s.creation(instanceId, capture('assignment')), { status: 503 });
}
raw = { ...envelope, instance: creation }; assert.equal((await s.creation(instanceId, capture('assignment'))).instance.before, null);
raw = { ...envelope, instances: [creation], nextAfter: null }; assert.equal((await s.creations(capture('assignment'))).instances.length, 1);
raw = { ...envelope, notifications: [{ ...notice, kind: 'assignment-creation-approval', assignmentId: creationId }], nextAfter: null };
assert.equal((await workApprovals.inbox(null, capture('inbox'))).notifications[0].kind, 'assignment-creation-approval');
let finishCreation; gate = new Promise(resolve => { finishCreation = resolve; });
raw = { ...envelope, instance: creation, replayed: false };
const lateCreation = s.requestCreation(before.employeeId, before.projectId, creationPolicy, proposed, creation.reason, requestId, capture('assignment'));
values.set('workos_session', JSON.stringify({ ...user, userName: 'synthetic-other-account' })); finishCreation();
await assert.rejects(lateCreation); assert.deepEqual(fallback, []);
console.log('Creation production policy/request/source-absence/current-stage/canonical-inbox and malformed/accepted-late acknowledgement contracts passed.');

// Reviewed batch coordinator uses the same strict production per-item clients.
const { reviewApproval, executeReviewedApprovals, reconcileReviewedApproval } = await import('../src/services/reviewedApprovalBatch.ts');
const reviewedPage = { instance, actorUserId: actor, ownerKey };
const reviewed = reviewApproval('Material', reviewedPage, 'Approved', receipt.reason, requestId);
assert(Object.isFrozen(reviewed) && Object.isFrozen(reviewed.page.instance.proposed));
assert.throws(() => reviewApproval('Creation', reviewedPage, 'Approved', receipt.reason));
const anotherId = ids[11], anotherKey = ids[10], another = reviewApproval('Material', { ...reviewedPage, instance: { ...instance, id: anotherId } }, 'Approved', receipt.reason, anotherKey);
const batchSetup = () => { reset(); signal = () => { const call = calls.at(-1), id = call.url.split('/').at(-2), input = JSON.parse(call.body); status = 200; raw = { ...envelope, receipt: { ...receipt, instanceId: id, requestId: input.requestId }, replayed: false, sourceToken: instance.sourceToken }; }; return { work: null, assignment: capture('assignment-decide') }; };
let batchContext = batchSetup(), batchResults = [];
await executeReviewedApprovals([reviewed, another], batchContext, () => true, r => batchResults.push(r));
assert.deepEqual(batchResults.map(r => r.status), ['Confirmed', 'Confirmed']); assert.equal(calls.length, 2);
await assert.rejects(executeReviewedApprovals([reviewed, reviewed], batchContext, () => true, () => {}));
batchContext = batchSetup(); const successfulSignal = signal; signal = () => { successfulSignal(); if (calls.length === 1) { status = 409; raw = { error: 'Synthetic stale source' }; } }; batchResults = [];
await executeReviewedApprovals([reviewed, another], batchContext, () => true, r => batchResults.push(r)); assert.deepEqual(batchResults.map(r => r.status), ['Denied', 'Confirmed']);
batchContext = batchSetup(); signal = () => { raw = { malformed: true }; }; batchResults = [];
await executeReviewedApprovals([reviewed, another], batchContext, () => true, r => batchResults.push(r)); assert.deepEqual(batchResults.map(r => r.status), ['Uncertain', 'NotAttempted']); assert.equal(calls.length, 1);
batchContext = batchSetup(); signal = () => { values.set('workos_api_token', 'synthetic-owner-changed'); }; batchResults = [];
await executeReviewedApprovals([reviewed, another], batchContext, () => true, r => batchResults.push(r)); assert.deepEqual(batchResults.map(r => r.status), ['Uncertain', 'NotAttempted']); assert.equal(calls.length, 1);
reset(); raw = { ...envelope, instance };
assert.equal((await reconcileReviewedApproval(reviewed, capture('assignment'))).status, 'Unresolved'); assert.equal(calls.length, 1, 'Reconciliation is read-only');
reset(); raw = { ...envelope, instance: { ...instance, transitions: [receipt], state: receipt.outcome } };
assert.equal((await reconcileReviewedApproval(reviewed, capture('assignment'))).status, 'Confirmed'); assert.equal(calls.length, 1);
console.log('Reviewed bulk immutable snapshots, distinct selection, independent strict receipts/denials, uncertain stop, owner stop and read-only exact request reconciliation passed.');

reset(); raw = { ...envelope, instance: { ...instance, currentRevision: 'c'.repeat(64) } };
assert.equal((await reconcileReviewedApproval(reviewed, capture('assignment'))).status, 'Changed');
reset(); raw = { ...envelope, instance: { ...instance, transitions: [{ ...receipt, reason: 'Synthetic conflicting history' }], state: receipt.outcome } };
await assert.rejects(reconcileReviewedApproval(reviewed, capture('assignment'))); assert.equal(calls.length, 1);

batchContext = batchSetup(); signal = () => { status = 403; raw = { error: 'Synthetic retry denied' }; }; batchResults = [];
await executeReviewedApprovals([reviewed, another], batchContext, () => true, r => batchResults.push(r), new Set([reviewed.requestId]));
assert.deepEqual(batchResults.map(r => r.status), ['Uncertain', 'NotAttempted'], 'A denied retry cannot establish the original uncertain request did not commit'); assert.equal(calls.length, 1);
batchContext = batchSetup(); batchResults = [];
await executeReviewedApprovals([reviewed, another], { work: null, assignment: null }, () => true, r => batchResults.push(r), new Set([reviewed.requestId]));
assert.deepEqual(batchResults.map(r => r.status), ['Uncertain', 'NotAttempted']); assert.equal(calls.length, 0);

// Configured prospective due handoff is part of this required gate.
await import('./approval-due-service-smoke.mjs');

// Configured canonical leave approval is part of this required gate.
await import('./leave-approval-service-smoke.mjs');
