import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { commercialFixture as f } from './commercial-drafting-test.mjs';
import { actualCatalog, actualCapacityDefinition } from './actual-work-test.mjs';
import { adoptAssignmentApproval, getAssignmentApprovalSource, proposeAssignment, decideAssignment, ASSIGNMENT_APPROVAL_BASE as assignments } from './assignment-approval-test.mjs';
import { adoptStagedPolicy, submitStagedWork, readApprovalOwner, WORK_APPROVAL_BASE as work } from './work-approval-test.mjs';
import { nativeCheckpoint } from '../../shared/native-forecast.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const expectResponse = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
export const e2Paths = today => ({
  actual: '/api/v1/actual-work/workers/' + f.ownerId,
  native: '/api/v1/native-forecast/workers/' + f.ownerId,
  actualQuery: '?startsOn=' + today + '&endsOn=' + today,
  nativeQuery: '?startsOn=' + today + '&endsOn=' + nativeCheckpoint(today, 3) + '&months=3',
});

// Explicit public configuration in a disposable database; existing fixture roles
// are reused without new grants. No policy/default is adopted in a buyer system.
export const configureE2 = async (request, fx) => {
  for (const [path, body, status] of [
    ['/api/settings', { expectedWeeklyHours: 56, utilizationThresholdHigh: 100, utilizationThresholdLow: 80, benchThreshold: 20 }, 200],
    ['/api/v1/work-categories/catalogs', { expectedLatestId: null, effectiveFrom: fx.today, definition: actualCatalog, reason: 'Synthetic explicit E2 inclusion' }, 201],
    ['/api/v1/worker-capacity/workers/' + f.ownerId + '/profiles', { expectedLatestId: null, effectiveFrom: fx.today, definition: actualCapacityDefinition, reason: 'Synthetic explicit E2 prospective capacity' }, 201],
  ]) expectResponse(await request(path, { method: 'POST', body }), status);
  await adoptStagedPolicy(request, fx.identities, fx.today);
  await adoptAssignmentApproval(request, fx);
  return expectResponse(await request('/api/allocations', { method: 'POST', identity: fx.identities.requester, body: {
    employee_id: f.ownerId, project_id: f.projectId, percentage: 20, start_date: fx.today,
    end_date: nativeCheckpoint(fx.today, 3), role_on_project: 'Synthetic E2 role', billable: true, status: 'Active', comments: 'Synthetic E2 effective V1',
  } }));
};

// Hooks replace actual HTTP operations with actual production-page interactions
// in the browser driver, never calculators or business-service mocks.
export const proveE2 = async ({ pool, request, fx, assignment, hooks = {} }) => {
  const { today, identities: ids } = fx, p = e2Paths(today);
  const deliveries = async () => (await pool.query('select * from notification_delivery_attempts order by id')).rows;
  const originalDeliveries = await deliveries();
  const native = async () => hooks.native ? hooks.native() : expectResponse(await request(p.native + '/period' + p.nativeQuery));
  const actual = async () => hooks.actual ? hooks.actual() : expectResponse(await request(p.actual + '/period' + p.actualQuery));
  const retain = async (kind, result) => hooks.retain ? hooks.retain(kind, result) : expectResponse(await request(p[kind] + '/evidence', { method: 'POST', body: {
    startsOn: today, endsOn: kind === 'native' ? nativeCheckpoint(today, 3) : today, ...(kind === 'native' ? { months: 3 } : {}),
    expectedSourceToken: result.sourceToken, requestId: randomUUID(), reason: 'Synthetic connected E2 ' + kind,
  } }), 201);
  const source = async () => (await getAssignmentApprovalSource(request, assignment.id, ids.requester)).body.source;
  const row = async (table, id) => (await pool.query(`select * from ${table} where id=$1`, [id])).rows[0];
  const v1 = await source();
  assert(v1.versionId, 'V1 must be a real retained assignment version');
  const firstNative = await native();
  assert.deepEqual(firstNative.result.points.map(v => v.declaredPercentageExact), ['20', '20', '20', '20']);
  assert.equal(firstNative.result.assignments.find(v => v.id === assignment.id).versionId, v1.versionId);
  assert.equal(firstNative.result.physicalUtilization, null, 'No percentage-to-hours authority is inferred');
  const retainedNative = await retain('native', firstNative.result);
  assert.equal(digest(retainedNative.csv), retainedNative.evidence.artifact.sha256);
  const frozenNative = await row('native_forecast_evidence', retainedNative.evidence.id);

  // Real named API submission in the authoritative initial short Weekly. The
  // current rolling UI header can end in the future and is not called submitted.
  const submitted = await submitStagedWork(request, ids.reader, today, { entries: [{
    project_id: f.projectId, work_type: 'Project Work', category_code: 'BILL', work_date: today,
    hours: '4', billable: true, remark: 'Synthetic E2 four approved project hours',
    evidence_url: 'https://example.test/work/E2-V1', work_reference: 'SYN-E2-V1',
  }] });
  const workId = submitted.instance.id, submission = await row('work_submission_evidence', submitted.instance.submissionId);
  assert.equal(submission.entries.length, 1, 'Evidence is nonempty, never an empty-table preservation assertion');
  assert.equal(submission.entries[0].evidenceUrl, 'https://example.test/work/E2-V1');
  assert.equal(submission.entries[0].workReference, 'SYN-E2-V1');
  const pin = submission.entries[0].assignmentSnapshots.find(v => v.id === assignment.id);
  assert(pin, 'Submitted project work retains its effective assignment');
  assert.equal(pin.assignmentVersionId, v1.versionId);
  assert.equal(pin.percentage, '20');
  assert.equal(submission.actor_id, ids.reader.id);
  const readWork = async () => expectResponse(await request(work + '/instances/' + workId)).instance;
  const decideWork = async (identity, instance) => hooks.workDecision ? hooks.workDecision(identity, instance) : expectResponse(await request(work + '/instances/' + workId + '/decisions', { method: 'POST', identity, body: {
    expectedOwnerKey: await readApprovalOwner(request, identity), expectedSourceToken: instance.sourceToken,
    expectedSequence: instance.state.sequence, requestId: randomUUID(), decision: 'Approved', reason: 'Synthetic E2 named work stage',
  } }), 201);
  assert.equal((await actual()).result.includedHoursExact, '0', 'Submitted work is not approved actual work');
  assert.equal((await decideWork(ids.manager, await readWork())).receipt.outcome.status, 'Pending');
  assert.equal((await actual()).result.includedHoursExact, '0', 'Intermediate work stage is not final actual work');
  assert.equal((await decideWork(ids.second, await readWork())).receipt.outcome.status, 'Approved');
  const approved = await actual();
  assert.equal(approved.result.includedHoursExact, '4');
  assert.equal(approved.result.eligibleAvailableHoursExact, '8');
  assert.equal(approved.result.percentage.displayPercent, '50');
  const ownActual = hooks.ownActual ? await hooks.ownActual() : expectResponse(await request('/api/v1/my-actual-work/period' + p.actualQuery, { identity: ids.reader }));
  assert.equal(ownActual.result.sourceToken, approved.result.sourceToken);
  assert.equal(ownActual.result.includedHoursExact, '4');
  const retainedActual = await retain('actual', approved.result), frozenActual = await row('actual_work_evidence', retainedActual.evidence.id);
  assert.equal(digest(retainedActual.csv), retainedActual.evidence.artifact.sha256);
  assert.equal(Buffer.byteLength(retainedActual.csv), retainedActual.evidence.artifact.bytes);
  const decisions = (await pool.query('select * from work_submission_decisions where submission_id=$1 order by id', [submission.id])).rows;
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, 'Approved');
  const frozenWork = await readWork();
  assert.equal(frozenWork.transitions.length, 2);

  const unchanged = async (label) => {
    const s = await source(); assert.equal(s.versionId, v1.versionId, label); assert.equal(s.snapshot.quantityExact, '20', label);
    assert.equal((await native()).result.sourceToken, firstNative.result.sourceToken, label);
    assert.equal((await actual()).result.sourceToken, approved.result.sourceToken, label);
  };
  const propose = async () => hooks.propose ? hooks.propose(assignment) : expectResponse(await proposeAssignment(request, fx, await source()), 201);
  const decide = async (identity, instance, decision = 'Approved') => hooks.assignmentDecision ? hooks.assignmentDecision(identity, instance, decision) : expectResponse(await decideAssignment(request, identity, instance, decision), 201);
  const readProposal = async id => expectResponse(await request(assignments + '/instances/' + id)).instance;
  const rejected = (await propose()).instance;
  await unchanged('Pending rejected proposal leaves effective V1');
  assert.equal((await decide(ids.manager, rejected, 'Rejected')).receipt.outcome.status, 'Rejected');
  await unchanged('Rejected proposal leaves effective V1');
  const pending = (await propose()).instance;
  await unchanged('Pending second proposal leaves effective V1');
  assert.equal((await decide(ids.manager, pending)).receipt.outcome.status, 'Pending');
  await unchanged('Intermediate named assignment stage leaves effective V1');
  assert.equal((await decide(ids.second, await readProposal(pending.id))).receipt.outcome.status, 'Approved');
  const v2 = await source();
  assert.notEqual(v2.versionId, v1.versionId);
  assert.equal(v2.snapshot.quantityExact, '25');
  const changed = await native();
  assert.deepEqual(changed.result.points.map(v => v.declaredPercentageExact), ['25', '25', '25', '25']);
  assert.notEqual(changed.result.sourceToken, firstNative.result.sourceToken);
  assert.equal(changed.result.assignments.find(v => v.id === assignment.id).versionId, v2.versionId);
  const stale = hooks.staleNative ? await hooks.staleNative() : await request(p.native + '/evidence', { method: 'POST', body: { startsOn: today, endsOn: nativeCheckpoint(today, 3), months: 3, expectedSourceToken: firstNative.result.sourceToken, requestId: randomUUID(), reason: 'Synthetic old E2 forecast token' } });
  expectResponse(stale, 409);
  assert.equal(stale.body.error.code, 'NATIVE_SOURCE_CHANGED', JSON.stringify(stale.body));
  const after = await actual();
  assert.equal(after.result.sourceToken, approved.result.sourceToken, 'Assignment-only V2 does not change material actual-hours inputs');
  assert.equal(after.result.includedHoursExact, '4'); assert.equal(after.result.percentage.displayPercent, '50');
  const own = hooks.ownPlanning ? await hooks.ownPlanning() : expectResponse(await request('/api/v1/my-work-planning' + p.actualQuery, { identity: ids.reader }));
  assert.equal(own.assignments.find(a => a.id === assignment.id).versionId, v2.versionId);
  assert.equal(own.assignments.find(a => a.id === assignment.id).snapshot.quantityExact, '25');
  assert.deepEqual(await row('work_submission_evidence', submission.id), submission);
  assert.deepEqual((await pool.query('select * from work_submission_decisions where submission_id=$1 order by id', [submission.id])).rows, decisions);
  assert.deepEqual(await readWork(), frozenWork, 'Retained work source/stages stay pinned to V1 after effective V2');
  for (const [kind, retained, frozen] of [['actual', retainedActual, frozenActual], ['native', retainedNative, frozenNative]]) {
    const artifact = expectResponse(await request(p[kind] + '/evidence/' + retained.evidence.id + '/artifact' + p[kind + 'Query']));
    assert.equal(artifact.csv, retained.csv); assert.equal(digest(artifact.csv), retained.evidence.artifact.sha256);
    assert.deepEqual(await row(kind === 'native' ? 'native_forecast_evidence' : 'actual_work_evidence', retained.evidence.id), frozen);
    if (hooks.artifact) await hooks.artifact(kind, retained);
  }
  if (hooks.history) await hooks.history({ workId, rejectedId: rejected.id, approvedId: pending.id });
  assert.deepEqual(await deliveries(), originalDeliveries, 'Adopted work and material-change journey adds no legacy/external delivery attempt; fixture/creation baseline stays separate');
  const receipt = { today, assignmentId: assignment.id, v1: v1.versionId, v2: v2.versionId, workId, submissionId: submission.id, actualHoursExact: '4', availableHoursExact: '8', displayPercent: '50', nativeBefore: '20', nativeAfter: '25', actualSourceUnchanged: true, retainedActualSha: retainedActual.evidence.artifact.sha256, retainedNativeSha: retainedNative.evidence.artifact.sha256 };
  console.log('Connected E2 exact source/state/history receipt:', JSON.stringify(receipt));
  return receipt;
};
