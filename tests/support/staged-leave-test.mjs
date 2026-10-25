import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { commercialFixture as f } from './commercial-drafting-test.mjs';
import { adoptActualInputs } from './actual-work-test.mjs';
import { adoptStagedPolicy, stagedDefinition, submitStagedWork, readApprovalOwner } from './work-approval-test.mjs';
export const stagedLeaveDigest = value => createHash('sha256').update(value).digest('hex');
export const stagedLeaveResponse = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
export const stagedLeavePaths = today => ({ actual: '/api/v1/actual-work/workers/' + f.ownerId, query: '?startsOn=' + today + '&endsOn=' + today, work: '/api/v1/work-approvals', quote: '/api/v1/leave-calendar/workers/' + f.ownerId + '/period' });
export const configureStagedLeave = async (request, fx) => {
  await adoptActualInputs(request, fx.today);
  await adoptStagedPolicy(request, fx.identities, fx.today, { ...stagedDefinition(fx.identities), workerIds: [f.ownerId] });
};
// Browser hooks execute actual production pages/HTTP operations. They never replace
// domain services, calculators, clocks, authorization or PostgreSQL assertions.
export const proveStagedLeave = async ({ pool, request, fx, hooks = {} }) => {
  const { today, identities: ids } = fx, p = stagedLeavePaths(today), ok = stagedLeaveResponse;
  const actual = async () => hooks.actual ? hooks.actual() : ok(await request(p.actual + '/period' + p.query));
  const own = async () => hooks.own ? hooks.own() : ({ planning: ok(await request('/api/v1/my-work-planning' + p.query, { identity: ids.reader })), actual: ok(await request('/api/v1/my-actual-work/period' + p.query, { identity: ids.reader })) });
  const row = async (table, id) => (await pool.query(`select * from ${table} where id=$1`, [id])).rows[0];
  const state = async (hours, capacity, status, percent) => {
    const report = await actual(), worker = await own();
    for (const r of [report.result, worker.actual.result]) { assert.equal(r.includedHoursExact, hours); assert.equal(r.eligibleAvailableHoursExact, capacity); assert.equal(r.status, status); if (percent === null) assert.equal(r.percentage, null); else assert.equal(r.percentage.displayPercent, percent); }
    assert.equal(worker.actual.result.sourceToken, report.result.sourceToken);
    assert.equal(worker.planning.capacity.totals.availableHoursExact, capacity);
    assert.equal(report.result.capacity.sourceToken, worker.planning.capacity.sourceToken);
    return report.result;
  };
  const retain = async result => {
    const body = hooks.retain ? await hooks.retain(result) : ok(await request(p.actual + '/evidence', { method: 'POST', body: { startsOn: today, endsOn: today, expectedSourceToken: result.sourceToken, requestId: randomUUID(), reason: 'Synthetic staged leave retained actual' } }), 201);
    assert.equal(body.evidence.result.sourceToken, result.sourceToken); assert.equal(stagedLeaveDigest(body.csv), body.evidence.artifact.sha256); assert.equal(Buffer.byteLength(body.csv), body.evidence.artifact.bytes); return { body, frozen: await row('actual_work_evidence', body.evidence.id) };
  };
  const retrieve = async saved => {
    const b = hooks.artifact ? await hooks.artifact(saved.body) : ok(await request(p.actual + '/evidence/' + saved.body.evidence.id + '/artifact' + p.query));
    assert.equal(b.csv, saved.body.csv); assert.equal(stagedLeaveDigest(b.csv), saved.body.evidence.artifact.sha256); assert.deepEqual(await row('actual_work_evidence', saved.body.evidence.id), saved.frozen);
  };
  const submitted = await submitStagedWork(request, ids.reader, today, { entries: [{ work_type: 'Project Work', project_id: f.projectId, category_code: 'BILL', work_date: today, hours: '4', billable: true, remark: 'Synthetic staged leave four approved project hours', evidence_url: 'https://example.test/work/staged-leave', work_reference: 'SYN-STAGED-LEAVE' }] });
  const workId = submitted.instance.id, readWork = async () => ok(await request(p.work + '/instances/' + workId)).instance;
  const evidence = await row('work_submission_evidence', submitted.instance.submissionId); assert.equal(evidence.entries.length, 1); assert.equal(evidence.entries[0].hours, '4'); assert.equal(evidence.entries[0].evidenceUrl, 'https://example.test/work/staged-leave'); assert(evidence.entries[0].assignmentSnapshots.some(s => s.assignmentVersionId));
  await state('0', '8', 'available', '0');
  const receipts = [];
  for (const identity of [ids.manager, ids.second]) {
    const current = await readWork(), reason = 'Synthetic staged leave named work approval';
    const command = { expectedOwnerKey: await readApprovalOwner(request, identity), expectedSourceToken: current.sourceToken, expectedSequence: current.state.sequence, requestId: randomUUID(), decision: 'Approved', reason };
    const body = hooks.workDecision ? await hooks.workDecision(identity, current, reason) : ok(await request(p.work + '/instances/' + workId + '/decisions', { method: 'POST', identity, body: command }), 201);
    receipts.push(body.receipt); command.requestId = body.receipt.requestId; command.reason = body.receipt.reason;
    const replay = ok(await request(p.work + '/instances/' + workId + '/decisions', { method: 'POST', identity, body: command }), 200); assert.deepEqual(replay.receipt, body.receipt); assert.equal(replay.replayed, true);
    await state(identity === ids.manager ? '0' : '4', '8', 'available', identity === ids.manager ? '0' : '50');
  }
  const approved = await state('4', '8', 'available', '50'), initial = await retain(approved), finalWork = await readWork(); assert.equal(finalWork.transitions.length, 2); assert.equal(finalWork.state.status, 'Approved');
  const keep = ['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'work_approval_instances', 'work_approval_transitions', 'work_approval_events', 'work_approval_recipients', 'work_approval_reads', 'assignment_versions', 'project_allocations', 'commercial_contract_versions', 'commercial_project_bindings'];
  const snapshot = async () => Object.fromEntries(await Promise.all(keep.map(async t => [t, (await pool.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows]))), frozen = await snapshot();
  assert.equal((await pool.query('select count(*)::int n from work_submission_decisions where submission_id=$1', [evidence.id])).rows[0].n, 1);
  const quote = hooks.createLeave ? await hooks.createLeave() : await (async () => { const q = ok(await request(p.quote + p.query, { identity: ids.reader })).quote; const leave = ok(await request('/api/leave/requests', { method: 'POST', identity: ids.reader, body: { employee_id: f.ownerId, leave_type_id: 'leave-type-annual', start_date: today, end_date: today, total_days: 1, expected_calendar_token: q.sourceToken, reason: 'Synthetic staged leave current full-day request' } })); return { quote: q, leave }; })();
  assert.equal(quote.quote.mode, 'calendar'); assert.equal(quote.quote.totalDaysExact, '1'); assert.equal(quote.quote.days[0].fractionExact, '1'); const leaveId = quote.leave.id; assert(quote.leave.calendar_evidence_id); const calendar = await row('leave_calendar_evidence', quote.leave.calendar_evidence_id);
  assert.equal((await row('leave_requests', leaveId)).status, 'Submitted'); await state('4', '8', 'available', '50');
  const balances = async () => (await pool.query('select used_days,pending_days from leave_balances where employee_id=$1 and leave_type_id=$2 and balance_year=$3', [f.ownerId, 'leave-type-annual', Number(today.slice(0, 4))])).rows[0];
  assert.equal(Number((await balances()).pending_days), 1); assert.equal(Number((await balances()).used_days), 0);
  const unauthorized = await request('/api/leave/requests/' + leaveId + '/status', { method: 'PATCH', identity: ids.denied, body: { status: 'Approved' } }); assert.equal(unauthorized.status, 403); assert.equal((await row('leave_requests', leaveId)).status, 'Submitted');
  if (hooks.approveLeave) await hooks.approveLeave(leaveId); else ok(await request('/api/leave/requests/' + leaveId + '/status', { method: 'PATCH', body: { status: 'Approved', comments: 'Synthetic authorized existing leave approval' } }));
  assert.equal((await row('leave_requests', leaveId)).status, 'Approved'); const zero = await state('4', '0', 'not_applicable', null); assert.equal(zero.capacity.totals.leaveReductionHoursExact, '8'); assert.notEqual(zero.sourceToken, approved.sourceToken); assert.equal(Number((await balances()).pending_days), 0); assert.equal(Number((await balances()).used_days), 1);
  const empty = await retain(zero); await retrieve(initial); assert.deepEqual(await snapshot(), frozen);
  const count = (await pool.query('select count(*)::int n from actual_work_evidence')).rows[0].n;
  const stale = await request(p.actual + '/evidence', { method: 'POST', body: { startsOn: today, endsOn: today, expectedSourceToken: approved.sourceToken, requestId: randomUUID(), reason: 'Synthetic stale pre-leave actual export' } }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'ACTUAL_SOURCE_CHANGED'); assert.equal((await pool.query('select count(*)::int n from actual_work_evidence')).rows[0].n, count);
  assert.equal((await request(p.actual + '/period' + p.query, { identity: ids.denied })).status, 404, 'Existing worker-scope lookup hides unrelated report sources');
  if (hooks.cancelLeave) await hooks.cancelLeave(leaveId); else ok(await request('/api/leave/requests/' + leaveId + '/cancel', { method: 'PATCH', identity: ids.reader }));
  assert.equal((await row('leave_requests', leaveId)).status, 'Cancelled'); const restored = await state('4', '8', 'available', '50'); assert.equal(restored.capacity.totals.leaveReductionHoursExact, '0'); assert.equal(Number((await balances()).used_days), 0); assert.equal(Number((await balances()).pending_days), 0);
  await retrieve(initial); await retrieve(empty); assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await row('leave_calendar_evidence', calendar.id), calendar); assert.deepEqual(await readWork(), finalWork);
  const history = ok(await request('/api/v1/leave-calendar/requests/' + leaveId + '/history', { identity: ids.reader })); assert.equal(history.evidence[0].id, calendar.id);
  if (hooks.history) await hooks.history({ workId, leaveId });
  console.log('Staged work/leave exact connected receipt:', JSON.stringify({ today, workId, leaveId, approvedHoursExact: '4', beforeCapacityExact: '8', approvedLeaveCapacityExact: '0', restoredCapacityExact: '8', beforePercent: '50', zeroStatus: zero.status, afterPercent: restored.percentage.displayPercent, exactWorkReplay: true, approvedDecisions: receipts.length, sourceHistoryUnchanged: true, retained50CsvSha: initial.body.evidence.artifact.sha256, retainedZeroCsvSha: empty.body.evidence.artifact.sha256 }));
};
