import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORK_APPROVAL_VERSION, approvalEventIdentity } from '../shared/work-approval.mjs';
process.env.APP_MODE = 'production';
process.env.VITE_APP_MODE = 'production';
process.env.ALLOW_TEST_FALLBACK = 'false';
process.env.VITE_ALLOW_TEST_FALLBACK = 'false';
const values = new Map(), fallback = [];
globalThis.sessionStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
globalThis.localStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(k => [k, () => { fallback.push(k); throw Error('No fallback'); }]));
globalThis.window = { localStorage, location: { pathname: '/approvals', href: '/approvals' }, dispatchEvent: () => true };
const { workApprovals: s, captureWorkApprovalContext: capture } = await import('../src/services/workApprovals.ts');
const ids = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(8, '0') + '-1111-4111-8111-111111111111'), [actor, requester, policyId, instanceId, workId, entryId, receiptId, requestId, templateId, noticeId] = ids, scope = { organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal' }, user = { id: actor, userName: 'synthetic-approver', employeeId: actor, role: 'Admin', permissionRole: 'Admin', permissions: ['settings.manage', 'permissions.manage', 'notifications.manage', 'notifications.view', 'employees.view', 'timesheets.submit', 'timesheets.approve', 'projects.view', 'approvals.view'] }, createdAt = '2026-10-25T01:00:00Z', ownerKey = createHash('sha256').update(JSON.stringify([user.userName, user.id, user.role, scope.organizationId, scope.legalEntityId])).digest('hex'), envelope = { contractVersion: WORK_APPROVAL_VERSION, ...scope, ownerKey, actorUserId: actor };
const definition = { entityType: 'Timesheet', workerIds: ['synthetic-worker'], stages: [{ userId: actor, role: 'Admin' }], locale: 'en-GB', completionInApp: true, templates: [{ key: 'approval.action_required', subject: 'Review {{sourceRef}}', body: 'Worker {{workerCode}} stage {{stageNumber}}' }, { key: 'approval.rejected_or_correction_required', subject: 'Correction {{sourceRef}}', body: '{{decisionReason}}' }, { key: 'approval.completed', subject: 'Completed {{sourceRef}}', body: 'Worker {{workerCode}}' }] }, policy = { id: policyId, sequence: 1, effectiveFrom: '2026-10-25', definition, actorId: actor, activeRole: 'Admin', reason: 'Synthetic prospective adoption', createdAt }, instance = { id: instanceId, timesheetId: workId, submissionId: 'synthetic-submission', submissionSequence: 1, sourceToken: 'a'.repeat(64), requesterUserId: requester, worker: { id: 'synthetic-worker', code: 'SYN', name: 'Synthetic worker' }, createdAt, policy: { id: policyId, sequence: 1, effectiveFrom: policy.effectiveFrom, stages: definition.stages }, state: { status: 'Pending', sequence: 0, currentStage: 0 }, transitions: [], notificationFailures: [], source: { weekEnding: '2026-10-25', totalHoursExact: '1.25', billableHoursExact: '0', currentHeaderStatus: 'Submitted', isCurrentSubmission: true, entries: [{ id: entryId, date: '2026-10-25', workType: 'Non-client Work', projectId: null, clientName: null, category: null, categoryCode: null, hoursExact: '1.25', billable: false, remark: 'Synthetic retained note', evidenceUrl: 'https://example.test/evidence', workReference: null }] } }, receipt = { id: receiptId, instanceId, sequence: 1, stage: 0, decision: 'Approved', actorId: actor, activeRole: 'Admin', requestId, operationId: 'synthetic-operation', reason: 'Synthetic decision', outcome: { status: 'Approved', sequence: 1, currentStage: null }, createdAt }, notification = { id: noticeId, eventId: approvalEventIdentity(instanceId, 0, 'approval.action_required', 'synthetic-operation'), instanceId, timesheetId: workId, submissionId: instance.submissionId, transitionSequence: 0, eventKey: 'approval.action_required', policyClass: 'ACTION_REQUIRED', templateId, operationId: 'synthetic-operation', locale: 'en-GB', title: 'Synthetic review', body: 'Synthetic request', reasons: ['current_stage_approver'], channelDecision: 'Required', createdAt, readAt: null };
let raw, status, calls, gate, dispatchSignal;
globalThis.fetch = async (url, init = {}) => { calls.push({ url, ...init }); dispatchSignal?.(); const body = raw, code = status, wait = gate; if (wait)
    await wait; return new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } }); };
const reset = () => { values.clear(); values.set('workos_session', JSON.stringify(user)); values.set('workos_organization_scope', JSON.stringify(scope)); values.set('workos_api_token', 'synthetic-token'); raw = { ...envelope, instance }; status = 200; calls = []; gate = null; dispatchSignal=null; };
reset();
const page = await s.instance(instanceId, capture('read'));
assert.equal(page.instance.source.entries[0].hoursExact, '1.25');
assert.equal(calls.length, 1);
assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-token');
assert.equal(calls[0].headers['X-Legal-Entity-Id'], scope.legalEntityId);
for (const patch of [{ sourceToken: 'x' }, { policy: { ...instance.policy, stages: [] } }, { source: { ...instance.source, totalHoursExact: '3' } }, { source: { ...instance.source, entries: instance.source.entries.map(e => ({ ...e, evidenceUrl: 'javascript:alert(1)' })) } }, { state: { status: 'Approved', sequence: 0, currentStage: null } }, { transitions: [receipt] }, { source: null }]) {
    raw = { ...envelope, instance: { ...instance, ...patch } };
    await assert.rejects(s.instance(instanceId, capture('read')), { status: 503 });
}
raw = { ...envelope, receipt, replayed: false, sourceToken: instance.sourceToken };
const decision = await s.decide(page, 'Approved', receipt.reason, requestId, capture('decide'));
assert.deepEqual(decision.receipt, receipt);
assert.deepEqual(JSON.parse(calls.at(-1).body), { expectedSourceToken: instance.sourceToken, expectedSequence: 0, requestId, decision: 'Approved', reason: receipt.reason, expectedOwnerKey: ownerKey });
for (const patch of [{ receipt: { ...receipt, actorId: requester } }, { receipt: { ...receipt, reason: 'Changed' } }, { receipt: { ...receipt, stage: 1 } }, { receipt: { ...receipt, outcome: { status: 'Pending', sequence: 1, currentStage: 0 } } }, { sourceToken: 'b'.repeat(64) }, { replayed: 'true' }]) {
    raw = { ...envelope, receipt, replayed: false, sourceToken: instance.sourceToken, ...patch };
    await assert.rejects(s.decide(page, 'Approved', receipt.reason, requestId, capture('decide')), { status: 503 });
}
raw = { ...envelope, policy };
assert.deepEqual(await s.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), policy);
raw = { ...envelope, policy: { ...policy, actorId: requester } };
await assert.rejects(s.adopt(null, policy.effectiveFrom, definition, policy.reason, capture('configure')), { status: 503 });
raw = { ...envelope, policies: [policy], nextBefore: 1 };
await assert.rejects(s.policies(null, capture('configure')), { status: 503 });
raw = { ...envelope, instances: [{ ...instance, source: null }], nextAfter: null };
assert.equal((await s.list(null, capture('read'))).instances.length, 1);
raw = { ...raw, instances: [{ ...instance, source: null }, { ...instance, source: null }] };
await assert.rejects(s.list(null, capture('read')), { status: 503 });
raw = { ...envelope, notifications: [notification], nextAfter: null };
assert.equal((await s.inbox(null, capture('inbox'))).notifications[0].eventId, notification.eventId);
const milestoneNotice={kind:'milestone-billing-eligibility',id:noticeId,eventId:approvalEventIdentity(instanceId,0,'approval.action_required',notification.operationId).replace(/^work-approval\//,'milestone-billing/'),instanceId,milestoneId:'milestone-synthetic',transitionSequence:0,eventKey:'approval.action_required',policyClass:'ACTION_REQUIRED',templateId,operationId:notification.operationId,locale:'en-GB',title:'Synthetic milestone review',body:'Synthetic review stage',reasons:['current_stage_approver'],channelDecision:'Required',deliveryId:receiptId,deliveryStatus:'Delivered',createdAt,readAt:null};
raw={...envelope,notifications:[milestoneNotice],nextAfter:null};
assert.equal((await s.inbox(null,capture('inbox'))).notifications[0].eventId,milestoneNotice.eventId);
raw={...envelope,notifications:[{...milestoneNotice,eventId:'milestone-billing/other'}],nextAfter:null};
await assert.rejects(s.inbox(null,capture('inbox')),{status:503});
raw = { ...envelope, notification: { ...notification, readAt: createdAt } };
assert.equal((await s.read(notification, capture('inbox'))).readAt, createdAt);
raw = { ...envelope, notification: { ...notification, body: 'Changed', readAt: createdAt } };
await assert.rejects(s.read(notification, capture('inbox')), { status: 503 });
for (const patch of [{ ownerKey: 'f'.repeat(64) }, { actorUserId: 'invalid' }, { organizationId: 'other' }, { contractVersion: 'other' }]) {
    raw = { ...envelope, instance, ...patch };
    await assert.rejects(s.instance(instanceId, capture('read')), { status: 503 });
}
for (const change of [() => values.set('workos_api_token', 'replacement'), () => values.set('workos_session', JSON.stringify({ ...user, role: 'Employee' })), () => values.set('workos_session', JSON.stringify({ ...user, permissions: [] })), () => values.set('workos_session', JSON.stringify({ ...user, userName: 'other' })), () => values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'other' }))]) {
    reset();
    const c = capture('read');
    change();
    await assert.rejects(s.instance(instanceId, c), { status: 403 });
    assert.equal(calls.length, 0);
}
for (const code of [200, 401]) {
    reset();
    status = code;
    let release;
    gate = new Promise(r => release = r);
    const dispatched=new Promise(resolve=>{dispatchSignal=resolve;});
    const pending = s.instance(instanceId, capture('read')).then(v => ({ v }), error => ({ error }));
    let timer;try{await Promise.race([dispatched,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic request did not reach mock fetch')),5000);})]);}finally{clearTimeout(timer);}
    values.set('workos_api_token', 'replacement');
    values.set('workos_organization_scope', JSON.stringify({ ...scope, legalEntityId: 'other' }));
    release();
    assert((await pending).error);
    assert.equal(values.get('workos_api_token'), 'replacement');
    assert.equal(calls.length, 1);
}
reset();
let current = true;
const c = capture('read', () => current);
current = false;
await assert.rejects(s.instance(instanceId, c), { status: 403 });
assert.equal(calls.length, 0);
for (const code of [400, 409, 422, 503]) {
    reset();
    status = code;
    await assert.rejects(s.instance(instanceId, capture('read')), { status: code });
    assert.equal(calls.length, 1);
}
assert.deepEqual(fallback, []);
console.log('Staged work production explicit policy/source/stage/receipt/owned notification contracts, full acknowledgements, account/role/token/scope/generation and late200/401 isolation passed without fallback or retry.');
