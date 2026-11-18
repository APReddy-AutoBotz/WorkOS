import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { periodNoticeIdentity, periodNoticePhase } from '../shared/work-period-notices.mjs';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map(), fallback = [];
globalThis.sessionStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.localStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(k => [k, () => { fallback.push(k); throw Error('No fallback'); }]));
globalThis.window = { localStorage, location: { pathname: '/approvals', href: '/approvals' }, dispatchEvent: () => true };
const { workApprovals: s, captureWorkApprovalContext: capture } = await import('../src/services/workApprovals.ts'), d = s.deadlines, ids = Array.from({ length: 9 }, (_, i) => String(i + 1).padStart(8, '0') + '-1111-4111-8111-111111111111'), [actor, owner, policyId, runId, requestId, recipientId, templateId, deliveryId, otherId] = ids, scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' }, user = { id: actor, userName: 'synthetic-deadline-operator', employeeId: actor, role: 'Admin', permissionRole: 'Admin', permissions: ['settings.manage', 'permissions.manage', 'notifications.manage', 'notifications.view', 'employees.view', 'timesheets.submit', 'timesheets.approve', 'projects.view', 'approvals.view'] }, ownerKey = createHash('sha256').update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId])).digest('hex'), envelope = { contractVersion: 'work-approval/1', ...scope, ownerKey, actorUserId: actor }, now = '2026-10-25T12:00:00Z', definition = { workerIds: ['synthetic-worker'], reminderMinutesBeforeDeadline: 0, overdueBoundary: 'grace-end', escalationOwner: { userId: owner, role: 'Admin' }, locale: 'en-GB', templates: [{ key: 'work_period.submission_due', subject: 'Due {{periodCode}}', body: 'Worker {{workerCode}} deadline {{deadlineAt}}' }, { key: 'work_period.submission_overdue', subject: 'Overdue {{periodCode}}', body: 'Grace {{graceEndsAt}}, reminder {{reminderAt}}' }] }, policy = { id: policyId, sequence: 1, effectiveFrom: '2026-10-25', definition, actorId: actor, activeRole: 'Admin', reason: 'Synthetic explicit notice configuration', createdAt: now }, sourceVersion = 'b'.repeat(64), sourceToken = randomBytes(32).toString('hex'), eventKey = 'work_period.submission_overdue', preview = { ...scope, worker: { id: 'synthetic-worker', code: 'SYN', name: 'Synthetic worker', status: 'Active', joining_date: null, exit_date: null }, period: { id: 'synthetic-period', code: 'SYN-PERIOD', starts_on: '2026-10-25', ends_on: '2026-10-25', status: 'Open', frequency: 'Weekly' }, policy, capturePolicyId: 'synthetic-capture', deadlineAt: '2026-10-25T00:00:00Z', graceEndsAt: '2026-10-25T00:00:00Z', state: 'overdue', unavailableReason: null, eventKey, reminderAt: '2026-10-25T00:00:00.000Z', overdueAt: '2026-10-25T00:00:00.000Z', existingEvent: null, sourceVersion, sourceToken, checkedAt: now, sourceSummary: [], recipientReasons: [{ userId: actor, reasons: ['affected_worker'] }, { userId: owner, reasons: ['configured_escalation_owner'] }] }, eventId = periodNoticeIdentity(sourceVersion, eventKey, 'synthetic-operation'), receipt = { id: runId, sequence: 1, employeeId: preview.worker.id, periodId: preview.period.id, policyId, requestId, actorId: actor, activeRole: 'Admin', reason: 'Synthetic deadline evaluation', operationId: 'synthetic-operation', correlationId: 'synthetic-correlation', sourceToken, sourceVersion, outcome: { state: 'overdue', disposition: 'Emitted', eventKey, eventId, checkedAt: now, sourceToken, sourceVersion }, createdAt: now }, notice = { kind: 'work-period', id: recipientId, eventId, runId, employeeId: preview.worker.id, periodId: preview.period.id, policyId, sourceVersion, eventKey, policyClass: 'CONTROL_MANDATORY', templateId, operationId: 'synthetic-operation', correlationId: 'synthetic-correlation', locale: 'en-GB', title: 'Synthetic overdue', body: 'Synthetic deadline', reasons: ['affected_worker'], channelDecision: 'Required', deliveryId, deliveryStatus: 'Delivered', createdAt: now, readAt: null };
let raw, status, calls, gate, dispatchSignal;
globalThis.fetch = async (url, init = {}) => { calls.push({ url, ...init }); dispatchSignal?.(); const b = raw, code = status, wait = gate; if (wait)
    await wait; return new Response(JSON.stringify(b), { status: code, headers: { 'Content-Type': 'application/json' } }); };
const reset = () => { values.clear(); values.set('workos_session', JSON.stringify(user)); values.set('workos_organization_scope', JSON.stringify(scope)); values.set('workos_api_token', 'synthetic-deadline-token'); raw = { ...envelope, preview }; status = 200; calls = []; gate = null; dispatchSignal=null; };
reset();
const read = () => d.preview(preview.worker.id, preview.period.id, capture('configure'));
assert.deepEqual(await read(), preview);
assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-deadline-token');
assert.equal(calls[0].headers['X-Legal-Entity-Id'], scope.legalEntityId);
assert(!calls[0].url.includes('asOf'));
for (const patch of [{ sourceToken: randomBytes(1).toString('hex') }, { organizationId: 'other' }, { eventKey: 'approval.action_required' }, { state: 'due' }, { overdueAt: '2026-10-26T00:00:00Z' }, { recipientReasons: [] }, { period: { ...preview.period, id: 'wrong' } }, { policy: { ...policy, definition: { ...definition, escalationOwner: { userId: owner, role: 'invented' }, recipients: [actor] } } }]) {
    raw = { ...envelope, preview: { ...preview, ...patch } };
    await assert.rejects(read(), { status: 503 });
}
raw = { ...envelope, receipt, replayed: false };
assert.deepEqual((await d.evaluate(preview, requestId, receipt.reason, capture('configure'))).receipt, receipt);
assert.deepEqual(JSON.parse(calls.at(-1).body), { employeeId: preview.worker.id, periodId: preview.period.id, expectedSourceToken: sourceToken, expectedEventKey: eventKey, requestId, reason: receipt.reason, expectedOwnerKey: ownerKey });
for (const patch of [{ actorId: otherId }, { requestId: otherId }, { sourceVersion: 'c'.repeat(64) }, { outcome: { ...receipt.outcome, eventId: 'wrong' } }, { outcome: { ...receipt.outcome, disposition: 'NoEvent' } }, { outcome: { ...receipt.outcome, eventKey: 'work_period.submission_due' } }]) {
    raw = { ...envelope, receipt: { ...receipt, ...patch }, replayed: false };
    await assert.rejects(d.evaluate(preview, requestId, receipt.reason, capture('configure')), { status: 503 });
}
raw = { ...envelope, policy };
assert.deepEqual(await d.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), policy);
raw = { ...envelope, policy: { ...policy, definition: { ...definition, reminderMinutesBeforeDeadline: 1 } } };
await assert.rejects(d.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), { status: 503 });
raw = { ...envelope, policies: [policy], nextBefore: 1 };
await assert.rejects(d.policies(null, capture('configure')), { status: 503 });
raw = { ...envelope, employeeId: preview.worker.id, periodId: preview.period.id, receipts: [receipt], nextBefore: null };
assert.equal((await d.history(preview.worker.id, preview.period.id, null, capture('configure'))).receipts.length, 1);
raw = { ...raw, receipts: [receipt, receipt] };
await assert.rejects(d.history(preview.worker.id, preview.period.id, null, capture('configure')), { status: 503 });
raw = { ...envelope, notifications: [notice], nextAfter: null };
assert.equal((await s.inbox(null, capture('inbox'))).notifications[0].eventId, eventId);
for (const patch of [{ policyClass: 'INFORMATIONAL' }, { reasons: [] }, { deliveryStatus: 'Failed' }, { eventId: 'wrong' }, { channelDecision: 'SuppressedPreference' }]) {
    raw = { ...envelope, notifications: [{ ...notice, ...patch }], nextAfter: null };
    await assert.rejects(s.inbox(null, capture('inbox')), { status: 503 });
}
raw = { ...envelope, notification: { ...notice, readAt: now } };
assert.equal((await s.read(notice, capture('inbox'))).readAt, now);
raw = { ...envelope, notification: { ...notice, body: 'Changed', readAt: now } };
await assert.rejects(s.read(notice, capture('inbox')), { status: 503 });
for (const change of [() => values.set('workos_api_token', 'replacement'), () => values.set('workos_session', JSON.stringify({ ...user, role: 'Employee' })), () => values.set('workos_session', JSON.stringify({ ...user, permissions: [] })), () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'other' }))]) {
    reset();
    const c = capture('configure');
    change();
    await assert.rejects(d.preview(preview.worker.id, preview.period.id, c), { status: 403 });
    assert.equal(calls.length, 0);
}
for (const code of [200, 401]) {
    reset();
    status = code;
    let release;
    gate = new Promise(r => release = r);
    const dispatched=new Promise(resolve=>{dispatchSignal=resolve;});
    const pending = read().then(v => ({ v }), error => ({ error }));
    let timer;try{await Promise.race([dispatched,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic request did not reach mock fetch')),5000);})]);}finally{clearTimeout(timer);}
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
    await assert.rejects(read(), { status: code });
    assert.equal(calls.length, 1);
}
assert.deepEqual(fallback, []);
console.log('Work-period notice production exact source/phase/policy/evaluation/history/mandatory delivery/inbox/read contracts, no caller clock/recipient, full acknowledgements and account/role/token/scope late200/401 isolation passed without fallback or retry.');
