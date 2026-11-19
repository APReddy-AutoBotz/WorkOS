import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../server/migrate.mjs';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { WORK_APPROVAL_BASE as base, workApprovalWorkers as workers, seedWorkApproval, withPreWorkApprovalMigrations, stagedDefinition, readApprovalOwner, adoptStagedPolicy, prepareStagedWork, submitStagedWork, stagedWorkEntries } from './support/work-approval-test.mjs';
import { shiftCapacityDate } from '../shared/worker-capacity.mjs';
const table = async (p, t) => (await p.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows, newTables = ['work_approval_policy_versions', 'work_approval_templates', 'work_approval_instances', 'work_approval_transitions', 'work_approval_events', 'work_approval_recipients', 'work_approval_notification_failures', 'work_approval_reads'];
await withCommercialDatabase(async ({ pool }) => withPreWorkApprovalMigrations(async (rootDir) => {
    await runMigrations({ pool, rootDir, logger: { log() { } } });
    await seedWorkApproval(pool);
    const keep = ['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'approval_records', 'approval_delegations', 'notification_events', 'notification_templates', 'notification_preferences', 'notification_delivery_attempts', 'role_permissions', 'users', 'project_allocations', 'assignment_versions', 'worker_capacity_versions', 'native_forecast_evidence'], before = Object.fromEntries(await Promise.all(keep.map(async (t) => [t, await table(pool, t)])));
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility']);
    for (const t of newTables)
        assert.deepEqual(await table(pool, t), []);
    for (const t of keep)
        assert.deepEqual(await table(pool, t), before[t], t + ' unchanged');
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    for (const t of keep)
        assert.deepEqual(await table(pool, t), before[t]);
}));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
    await migrateCommercialDatabase(pool);
    const { identities, today, next } = await seedWorkApproval(pool);
    const diagnostics = [];
    await withCommercialApi({ databaseUrl, identities, timeZone: 'Pacific/Kiritimati', onServerError: s => diagnostics.push(s) }, async ({ request }) => {
        await prepareStagedWork(request, identities, today);
        const legacy = await request('/api/timesheets', { method: 'POST', identity: identities.reader, body: { employee_id: f.ownerId, week_ending: today, status: 'Submitted', entries: stagedWorkEntries(today) } });
        assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
        assert.deepEqual(await table(pool, 'work_approval_instances'), []);
        const policy = await adoptStagedPolicy(request, identities, today);
        assert.equal((await request('/api/timesheets/' + legacy.body.id + '/status', { method: 'PATCH', body: { status: 'Approved' } })).status, 200, 'already submitted work stays unadopted legacy');
        const own = await readApprovalOwner(request, identities.manager), get = async (id, identity = identities.manager) => request(base + '/instances/' + id, { identity }), decide = async (v, identity, decision = 'Approved', key = randomUUID(), reason = 'Synthetic staged decision', extra = {}) => request(base + '/instances/' + v.id + '/decisions', { method: 'POST', identity, body: { expectedOwnerKey: identity === identities.manager ? own : await readApprovalOwner(request, identity), expectedSourceToken: v.sourceToken, expectedSequence: v.state.sequence, requestId: key, decision, reason, ...extra } }), header = async (id) => (await pool.query('select * from timesheets where id=$1', [id])).rows[0], counts = async () => (await pool.query('select(select count(*)from work_approval_instances)i,(select count(*)from work_approval_transitions)t,(select count(*)from work_approval_events)e,(select count(*)from work_approval_recipients)r,(select count(*)from work_submission_decisions)d')).rows[0];
        const canonicalPolicy = stagedDefinition(identities);
        canonicalPolicy.stages[0].userId = 'ABCDEF01-1111-4111-8111-111111111111';
        const badCase = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: own, expectedLatestId: policy.id, effectiveFrom: next, definition: canonicalPolicy, reason: 'Synthetic noncanonical account input' } });
        assert.equal(badCase.status, 400, JSON.stringify(badCase.body));
        assert.equal((await pool.query('select valid_work_approval_definition($1::jsonb) ok', [JSON.stringify(canonicalPolicy)])).rows[0].ok, false);
        const first = await submitStagedWork(request, identities.first, today);
        assert(first.instance);
        let v = first.instance;
        assert.equal(v.policy.id, policy.id);
        assert.equal(v.state.status, 'Pending');
        assert.equal((await header(v.timesheetId)).status, 'Submitted');
        const legacyApproval = (await pool.query("select * from approval_records where entity_type='Timesheet'and entity_id=$1", [v.timesheetId])).rows[0];
        assert.equal(legacyApproval.due_at, null);
        assert.equal((await request('/api/timesheets/' + v.timesheetId + '/status', { method: 'PATCH', body: { status: 'Approved' } })).status, 409);
        assert.equal((await request('/api/approvals/' + legacyApproval.id + '/status', { method: 'PATCH', body: { status: 'Approved' } })).status, 409);
        await assert.rejects(pool.query("update timesheets set status='Approved'where id=$1", [v.timesheetId]), { code: 'WGA04' });
        assert.equal((await decide(v, identities.second)).status, 403);
        assert.equal((await get(v.id, identities.reader)).status, 404, 'unrelated Employee scope cannot inspect the instance');
        const future = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: own, expectedLatestId: policy.id, effectiveFrom: next, definition: { ...stagedDefinition(identities), workerIds: [], locale: 'fr', templates: stagedDefinition(identities).templates.map(t => ({ ...t, subject: 'Synthetic future ' + t.subject })) }, reason: 'Synthetic explicit future retirement; pending sources keep old policy' } });
        assert.equal(future.status, 201, JSON.stringify(future.body));
        assert.equal((await get(v.id)).body.instance.policy.id, policy.id);
        assert.equal((await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: own, expectedLatestId: policy.id, effectiveFrom: shiftCapacityDate(next, 1), definition: stagedDefinition(identities), reason: 'Synthetic stale policy' } })).status, 409);
        // A change of worker binding between stages must roll back the decision and its notice.
        const beforeRebinding = await counts();
        await pool.query('update users set employee_record_id=null where id=$1', [identities.first.id]);
        await pool.query('update users set employee_record_id=$1 where id=$2', [workers.first, identities.second.id]);
        const invalidHandoff = await decide(v, identities.manager);
        assert.equal(invalidHandoff.status, 403);
        assert.equal(invalidHandoff.body.error.code, 'WORK_APPROVAL_SELF_DECISION');
        assert.deepEqual(await counts(), beforeRebinding);
        await pool.query('update users set employee_record_id=null where id=$1', [identities.second.id]);
        await pool.query('update users set employee_record_id=$1 where id=$2', [workers.first, identities.first.id]);
        const key = randomUUID(), race = await Promise.all([decide(v, identities.manager, 'Approved', key), decide(v, identities.manager, 'Approved', key)]);
        assert.deepEqual(race.map(r => r.status).sort(), [200, 201]);
        assert.deepEqual(race[0].body.receipt, race[1].body.receipt);
        assert.equal((await header(v.timesheetId)).status, 'Submitted');
        assert.equal((await pool.query('select count(*)::int n from work_submission_decisions where submission_id=$1', [v.submissionId])).rows[0].n, 0);
        assert.equal((await decide(v, identities.manager, 'Approved', key, 'Changed payload')).status, 409);
        assert.equal((await decide(v, identities.manager)).status, 409);
        v = (await get(v.id, identities.second)).body.instance;
        assert.equal(v.state.currentStage, 1);
        let done = await decide(v, identities.second);
        assert.equal(done.status, 201, JSON.stringify(done.body));
        assert.equal(done.body.receipt.outcome.status, 'Approved');
        assert.equal((await header(v.timesheetId)).status, 'Approved');
        assert.equal((await pool.query('select status from work_submission_decisions where submission_id=$1', [v.submissionId])).rows[0].status, 'Approved');
        const actual = await request('/api/v1/actual-work/workers/' + workers.first + '/period?startsOn=' + today + '&endsOn=' + today);
        assert.equal(actual.body.result.includedHoursExact, '1.25');
        assert.equal(actual.body.result.percentage.displayPercent, '15.63');
        assert.equal((await pool.query('select count(*)::int n from work_approval_events where instance_id=$1', [v.id])).rows[0].n, 3);
        const complete = (await pool.query("select r.* from work_approval_recipients r join work_approval_events e on e.id=r.event_id where e.instance_id=$1 and e.event_key='approval.completed'", [v.id])).rows;
        assert.equal(complete.length, 1);
        assert.deepEqual(complete[0].reasons, ['affected_worker', 'requester']);
        const inbox = await request(base + '/inbox', { identity: identities.first });
        assert.equal(inbox.status, 200);
        const notice = inbox.body.notifications.find(n => n.eventKey === 'approval.completed');
        assert(notice);
        const read = await request(base + '/inbox/' + notice.id + '/read', { method: 'POST', identity: identities.first, body: { expectedOwnerKey: inbox.body.ownerKey } });
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert(read.body.notification.readAt);
        assert.equal((await request(base + '/inbox/' + notice.id + '/read', { method: 'POST', body: { expectedOwnerKey: own } })).status, 404);
        assert.equal((await request(base + '/inbox/' + notice.id + '/read', { method: 'POST', identity: identities.first, body: { expectedOwnerKey: inbox.body.ownerKey } })).body.notification.readAt, read.body.notification.readAt);
        // Protected recipient failure must not leave any source, stage, or delivery fragment.
        const corrective = await submitStagedWork(request, identities.requester, today, { employee_id: workers.correction }), cv = (await get(corrective.instance.id)).body.instance;
        assert.equal(cv.source.entries[0].hoursExact, '1.25');
        assert.equal(cv.source.isCurrentSubmission, true);
        const savedSource = JSON.stringify(cv.source), savedLegacyNotifications = await table(pool, 'notification_events'), savedDeliveries = await table(pool, 'notification_delivery_attempts'), beforeReject = await counts(), rejectKey = randomUUID();
        await pool.query("insert into notification_preferences(employee_id,event_type,in_app,email,teams)values($1,'approval.rejected_or_correction_required',false,true,true)", [workers.correction]);
        await pool.query("update users set status='Inactive'where id=$1", [identities.correction.id]);
        assert.equal((await decide(cv, identities.manager, 'Rejected', rejectKey)).status, 409);
        assert.deepEqual(await counts(), beforeReject);
        assert.equal((await header(cv.timesheetId)).status, 'Submitted');
        await pool.query("update users set status='Active'where id=$1", [identities.correction.id]);
        await pool.query('update user_organization_scopes set active=false where user_id=$1', [identities.requester.id]);
        assert.equal((await decide(cv, identities.manager, 'Rejected', rejectKey)).status, 409);
        assert.deepEqual(await counts(), beforeReject);
        await pool.query('update user_organization_scopes set active=true where user_id=$1', [identities.requester.id]);
        assert.equal((await decide(cv, identities.manager, 'Rejected', rejectKey, 'Synthetic staged decision', { recipientIds: [identities.manager.id] })).status, 400);
        assert.deepEqual(await counts(), beforeReject);
        // This additional test-only trigger fails the second recipient insert. Real guards remain enabled.
        await pool.query(`create function synthetic_reject_second_recipient()returns trigger language plpgsql as $$begin if exists(select 1 from work_approval_events e where e.id=new.event_id and e.event_key='approval.rejected_or_correction_required')and exists(select 1 from work_approval_recipients r where r.event_id=new.event_id)then raise exception 'Synthetic second-recipient persistence failure';end if;return new;end$$;create trigger synthetic_reject_second_recipient before insert on work_approval_recipients for each row execute function synthetic_reject_second_recipient()`);
        try {
            assert.equal((await decide(cv, identities.manager, 'Rejected', rejectKey)).status, 503);
            assert.deepEqual(await counts(), beforeReject);
            assert.equal((await header(cv.timesheetId)).status, 'Submitted');
        }
        finally {
            await pool.query('drop trigger synthetic_reject_second_recipient on work_approval_recipients');
            await pool.query('drop function synthetic_reject_second_recipient()');
        }
        const rejection = await decide(cv, identities.manager, 'Rejected', rejectKey);
        assert.equal(rejection.status, 201, JSON.stringify(rejection.body));
        assert.equal((await decide(cv, identities.manager, 'Rejected', rejectKey)).status, 200);
        assert.equal((await header(cv.timesheetId)).status, 'Rejected');
        const recipients = (await pool.query("select r.* from work_approval_recipients r join work_approval_events e on e.id=r.event_id where e.instance_id=$1 and e.event_key='approval.rejected_or_correction_required'order by r.user_id", [cv.id])).rows;
        assert.equal(recipients.length, 2);
        assert.deepEqual(recipients.find(r => r.user_id === identities.requester.id).reasons, ['requester']);
        assert.deepEqual(recipients.find(r => r.user_id === identities.correction.id).reasons, ['affected_worker']);
        assert(recipients.every(r => r.in_app && r.channel_decision === 'Required'), 'mandatory in-app ignores opt-out without invoking email/Teams');
        const corrected = await submitStagedWork(request, identities.correction, today, { entries: stagedWorkEntries(today, '1.5') });
        assert.equal(corrected.source.id, cv.timesheetId);
        assert.equal(corrected.instance.submissionSequence, 2);
        assert.notEqual(corrected.instance.id, cv.id);
        assert.equal(corrected.instance.state.sequence, 0);
        const old = (await get(cv.id)).body.instance;
        assert.equal(old.state.status, 'Rejected');
        assert.equal(old.source.isCurrentSubmission, false);
        assert.equal(old.source.entries[0].hoursExact, '1.25');
        assert.equal(JSON.stringify({ ...old.source, isCurrentSubmission: true, currentHeaderStatus: 'Submitted' }), savedSource);
        assert.equal((await decide(old, identities.manager)).status, 409);
        assert.equal((await request('/api/timesheets', { method: 'POST', identity: identities.correction, body: { employee_id: workers.correction, week_ending: today, status: 'Draft', entries: stagedWorkEntries(today) } })).status, 409);
        // Informational persistence failure is recorded and isolated from a valid final outcome.
        const optional = await submitStagedWork(request, identities.optional, today);
        assert.equal((await decide(optional.instance, identities.manager)).status, 201);
        const ov = (await get(optional.instance.id, identities.second)).body.instance;
        await pool.query(`create function synthetic_completion_failure()returns trigger language plpgsql as $$begin if new.event_key='approval.completed'then raise exception 'Synthetic informational persistence failure';end if;return new;end$$;create trigger synthetic_completion_failure before insert on work_approval_events for each row execute function synthetic_completion_failure()`);
        let finalOptional;
        const optionalKey = randomUUID();
        try {
            finalOptional = await decide(ov, identities.second, 'Approved', optionalKey);
            assert.equal(finalOptional.status, 201, JSON.stringify(finalOptional.body));
        }
        finally {
            await pool.query('drop trigger synthetic_completion_failure on work_approval_events');
            await pool.query('drop function synthetic_completion_failure()');
        }
        assert.equal((await header(ov.timesheetId)).status, 'Approved');
        assert.deepEqual((await decide(ov, identities.second, 'Approved', optionalKey)).body.receipt, finalOptional.body.receipt);
        const failedPage = (await get(ov.id)).body.instance;
        assert.equal(failedPage.notificationFailures.length, 1);
        assert.equal(failedPage.notificationFailures[0].code, 'INFORMATIONAL_NOTIFICATION_UNAVAILABLE');
        assert.equal((await pool.query("select count(*)::int n from work_approval_events where instance_id=$1 and event_key='approval.completed'", [ov.id])).rows[0].n, 0);
        // Both real import aliases share adoption; versioned dry run rolls back the entire staged path.
        for (const versioned of [false, true]) {
            const workerId = versioned ? workers.versionedImport : workers.legacyImport, url = (versioned ? '/api/v1' : '/api') + '/imports/timesheets/apply', row = { employeeId: workerId, weekEnding: today, workType: 'Non-client Work', categoryCode: 'CAT0', date: today, hours: '0.5', billable: false, status: 'Submitted', remark: 'Synthetic staged imported work' }, call = (dryRun = false, key = randomUUID()) => request(url, { method: 'POST', identity: identities.requester, headers: versioned ? { 'Idempotency-Key': key } : {}, body: { fileName: 'synthetic-staged.csv', rows: [row], ...(versioned ? { schemaVersion: 'timesheet-import/1', dryRun } : {}) } });
            if (versioned) {
                const before = await counts();
                assert.equal((await call(true)).body.validRows, 1);
                assert.deepEqual(await counts(), before);
                assert.equal((await pool.query('select count(*)::int n from timesheets where employee_id=$1', [workerId])).rows[0].n, 0);
            }
            const k = randomUUID(), r = await call(false, k);
            assert.equal(r.body.validRows, 1, JSON.stringify(r.body));
            if (versioned)
                assert.deepEqual((await call(false, k)).body, r.body);
            const imported = (await pool.query('select w.* from work_approval_instances w where employee_id=$1', [workerId])).rows;
            assert.equal(imported.length, 1);
            assert.equal(imported[0].requester_user_id, identities.requester.id);
            assert.equal((await get(imported[0].id)).body.instance.state.status, 'Pending');
        }
        assert.deepEqual(await table(pool, 'notification_events'), savedLegacyNotifications);
        assert.deepEqual(await table(pool, 'notification_delivery_attempts'), savedDeliveries, 'native adopted outcomes never call legacy external delivery');
        const beforeSelf = await counts(), self = await request('/api/timesheets', { method: 'POST', body: { employee_id: workers.locked, week_ending: today, status: 'Submitted', entries: stagedWorkEntries(today) } });
        assert.equal(self.status, 403, JSON.stringify(self.body));
        assert.deepEqual(await counts(), beforeSelf);
        assert.equal((await pool.query('select count(*)::int n from timesheets where employee_id=$1', [workers.locked])).rows[0].n, 0, 'self-stage submission rolls back source and compatibility rows');
        const nextStageUnavailable = (await get(corrected.instance.id)).body.instance, beforeHandoff = await counts();
        await pool.query("update users set status='Inactive'where id=$1", [identities.second.id]);
        assert.equal((await decide(nextStageUnavailable, identities.manager)).status, 409);
        assert.deepEqual(await counts(), beforeHandoff);
        await pool.query("update users set status='Active'where id=$1", [identities.second.id]);
        // Current account authority and forward-only period closure still govern pending stages.
        const locked = await submitStagedWork(request, identities.locked, today), lv = locked.instance, beforeLocked = await counts();
        await pool.query("update role_permissions set enabled=false where role_name='Admin'and permission_key='notifications.view'");
        assert.equal((await decide(lv, identities.manager)).status, 409);
        assert.deepEqual(await counts(), beforeLocked);
        await pool.query("update role_permissions set enabled=true where role_name='Admin'and permission_key='notifications.view'");
        await pool.query("update reporting_periods set status='Approval Closed'where organization_id=$1 and legal_entity_id=$2 and starts_on<=$3 and ends_on>=$3", [f.organizationId, f.legalEntityId, today]);
        const closed = await decide(lv, identities.manager);
        assert.equal(closed.status, 409, JSON.stringify(closed.body));
        assert.deepEqual(await counts(), beforeLocked);
        assert.equal((await header(lv.timesheetId)).status, 'Submitted');
        for (const t of newTables.filter(t => t !== 'work_approval_notification_failures')) {
            const row = (await pool.query(`select * from ${t} limit 1`)).rows[0];
            if (row) {
                const idColumn = t === 'work_approval_reads' ? 'recipient_id' : 'id';
                await assert.rejects(pool.query(`delete from ${t}where ${idColumn}=$1`, [row[idColumn]]));
            }
        }
        console.log(JSON.stringify({ firstInstance: v.id, policyId: policy.id, sourceStatus: (await header(v.timesheetId)).status, coreAndAtomicFailureCasesPassed: true }));
    }).catch(e => { console.error('Staged synthetic API failure diagnostic:', diagnostics.join('').slice(-2500)); throw e; });
});
console.log('Staged work real PostgreSQL/API fresh/062 upgrade/replay, unchanged legacy work, explicit adoption, source/current-stage/direct/SQL guards, concurrent exact decision replay, terminal work/actual consumption, immutable rejection/correction, both import aliases/dry run/replay, mandatory recipient/second-write/handoff rollback and corrected retry, optional failure isolation, no legacy/external delivery and forward-only period closure passed.');
