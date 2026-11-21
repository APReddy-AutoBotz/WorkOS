import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { ASSIGNMENT_APPROVAL_BASE as base, seedAssignmentApproval, adoptAssignmentApproval, createApprovalAssignment, getAssignmentApprovalSource, proposeAssignment, decideAssignment, withPreAssignmentApprovalMigrations, assignmentApprovalDefinition } from './support/assignment-approval-test.mjs';
import { runMigrations } from '../server/migrate.mjs';
import { readApprovalOwner } from './support/work-approval-test.mjs';
const tables = ['assignment_approval_policies', 'assignment_approval_templates', 'assignment_approval_instances', 'assignment_approval_transitions', 'assignment_approval_events', 'assignment_approval_recipients', 'assignment_approval_deliveries', 'assignment_approval_notification_failures', 'assignment_approval_reads'];
const table = async (p, t) => (await p.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows;
const snapshot = async (p, names = tables) => Object.fromEntries(await Promise.all(names.map(async (t) => [t, await table(p, t)])));
await withCommercialDatabase(async ({ pool }) => withPreAssignmentApprovalMigrations(async (rootDir) => {
    await runMigrations({ pool, rootDir, logger: { log() { } } });
    await seedAssignmentApproval(pool);
    const keep = ['project_allocations', 'assignment_versions', 'assignment_overlap_policy_versions', 'assignment_overlap_evidence', 'approval_records', 'users', 'role_permissions', 'timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'resource_demands', 'resource_demand_versions', 'work_approval_instances', 'work_approval_events', 'work_period_notice_policies', 'work_period_notice_events', 'notification_events'], before = await snapshot(pool, keep);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility']);
    assert.deepEqual(await snapshot(pool, keep), before);
    for (const t of tables)
        assert.deepEqual(await table(pool, t), []);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    assert.deepEqual(await snapshot(pool, keep), before);
}));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
    await migrateCommercialDatabase(pool);
    const fx = await seedAssignmentApproval(pool), { identities } = fx;
    await withCommercialApi({ databaseUrl, identities, onServerError: s => console.error(s) }, async ({ request }) => {
        const a = await createApprovalAssignment(request, fx), owner = await readApprovalOwner(request, identities.manager), d = assignmentApprovalDefinition(identities), policy = await adoptAssignmentApproval(request, fx), preserve = ['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'resource_demand_versions', 'commercial_contract_versions', 'role_permissions', 'work_approval_instances', 'work_approval_events', 'work_period_notice_events'], frozen = await snapshot(pool, preserve), source = () => getAssignmentApprovalSource(request, a.id, identities.requester).then(r => r.body.source), amount = async () => (await pool.query('select trim_scale(percentage)::text n from project_allocations where id=$1', [a.id])).rows[0].n;
        const choices = await request(base + '/choices');
        assert.equal(choices.status, 200, JSON.stringify(choices.body));
        assert(choices.body.workers.some(w => w.id === f.ownerId));
        assert(choices.body.users.some(u => u.id === identities.manager.id && u.roles.includes('Admin')));
        const s = await source();
        assert.equal((await request(base + '/sources/' + a.id, { authenticated: false })).status, 401);
        assert.equal((await request(base + '/sources/' + a.id, { identity: identities.denied })).status, 404);
        assert.equal((await request(base + '/sources/' + a.id, { identity: identities.requester, scope: { organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId } })).status, 403);
        const nonmaterial = { ...s.snapshot };
        delete nonmaterial.assignmentId;
        delete nonmaterial.employeeId;
        delete nonmaterial.projectId;
        assert.equal((await proposeAssignment(request, fx, s, { definition: nonmaterial })).status, 422);
        assert.equal((await proposeAssignment(request, fx, s, { expectedLatestId: null })).status, 409);
        assert.equal((await proposeAssignment(request, fx, s, { definition: { ...nonmaterial, quantityUnit: 'hours' } })).status, 400);
        assert.equal((await proposeAssignment(request, fx, s, { recipients: [identities.requester.id] })).status, 400);
        const proposalKey = randomUUID(), proposals = await Promise.all([proposeAssignment(request, fx, s, {}, proposalKey), proposeAssignment(request, fx, s, {}, proposalKey)]);
        assert.deepEqual(proposals.map(r => r.status).sort(), [200, 201]);
        assert.equal(proposals[0].body.instance.id, proposals[1].body.instance.id);
        assert.equal((await proposeAssignment(request, fx, s, { reason: 'Synthetic changed proposal request' }, proposalKey)).status, 409);
        const proposed = proposals.find(r => r.status === 201);
        let i = proposed.body.instance;
        assert.equal(i.state.status, 'Pending');
        assert.equal(await amount(), '20');
        assert.equal(i.before.quantityExact, '20');
        assert.equal(i.proposed.quantityExact, '25');
        const payload = { id: a.id, employee_id: a.employee_id, project_id: a.project_id, role_on_project: a.role_on_project, percentage: 30, start_date: a.start_date, end_date: a.end_date, billable: a.billable, status: a.status, comments: a.comments };
        const old = await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']);
        assert.equal((await request('/api/allocations', { method: 'POST', body: payload })).status, 409);
        assert.equal((await request('/api/allocations/' + a.id, { method: 'DELETE' })).status, 409);
        assert.equal((await request('/api/v1/assignment-versions/assignments/' + a.id + '/versions', { method: 'POST', body: { expectedRevision: s.revision, expectedLatestId: s.versionId, definition: { ...nonmaterial, quantityExact: '30' }, reason: 'Synthetic forbidden direct version' } })).status, 409);
        await assert.rejects(pool.query('update project_allocations set percentage=30 where id=$1', [a.id]), { code: 'ASA01' });
        await assert.rejects(pool.query('delete from project_allocations where id=$1', [a.id]), { code: 'ASA01' });
        await assert.rejects(pool.query('update project_allocations set employee_id=$1 where id=$2', [f.otherOwnerId, a.id]), { code: 'ASA01' });
        assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), old);
        const importRow = { id: a.id, employeeId: a.employee_id, projectId: a.project_id, roleOnProject: a.role_on_project, percentage: 30, startDate: a.start_date, endDate: a.end_date, billable: false, status: 'Active', comments: a.comments };
        for (const versioned of [false, true])
            for (const dryRun of versioned ? [true, false] : [false]) {
                const key = randomUUID(), options = { method: 'POST', headers: versioned ? { 'Idempotency-Key': key } : {}, body: { fileName: 'synthetic-material.csv', rows: [importRow], ...(versioned ? { schemaVersion: 'allocation-control/1', dryRun } : {}) } }, path = versioned ? '/api/v1/imports/allocations/apply' : '/api/imports/allocations/apply', r = await request(path, options);
                assert.equal(r.status, 200, JSON.stringify(r.body));
                assert.equal(r.body.validRows, 0);
                assert.equal(r.body.errorRows, 1);
                assert(r.body.errors.some(e => e.code === 'ASSIGNMENT_APPROVAL_REQUIRED'));
                if (versioned && !dryRun)
                    assert.deepEqual((await request(path, options)).body, r.body);
                assert.equal(await amount(), '20');
            }
        const compat = (await pool.query("select id from approval_records where entity_type='AssignmentProposal'and entity_id=$1", [i.id])).rows[0];
        assert.equal((await request('/api/approvals/' + compat.id + '/status', { method: 'PATCH', body: { status: 'Approved', comments: 'Synthetic bypass attempt' } })).status, 409);
        await assert.rejects(pool.query("update approval_records set status='Approved'where id=$1", [compat.id]), { code: 'ASA03' });
        assert.equal((await decideAssignment(request, identities.requester, i)).status, 403);
        assert.equal((await decideAssignment(request, identities.second, i)).status, 403);
        const beforeFault = await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']);
        await pool.query("create function synthetic_assignment_delivery_fault()returns trigger language plpgsql as $$begin raise exception 'Synthetic required delivery fault';end$$;create trigger synthetic_assignment_delivery_fault before insert on assignment_approval_deliveries for each row execute function synthetic_assignment_delivery_fault()");
        try {
            assert.equal((await decideAssignment(request, identities.manager, i)).status, 503);
            assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), beforeFault);
        }
        finally {
            await pool.query('drop trigger synthetic_assignment_delivery_fault on assignment_approval_deliveries;drop function synthetic_assignment_delivery_fault()');
        }
        // A rebinding after proposal creation must not deliver an approval notice to the affected worker.
        await pool.query('update users set employee_record_id=null where id=$1', [identities.reader.id]);
        await pool.query('update users set employee_record_id=$1 where id=$2', [f.ownerId, identities.second.id]);
        const selfHandoff = await decideAssignment(request, identities.manager, i);
        assert.equal(selfHandoff.status, 403, JSON.stringify(selfHandoff.body));
        assert.equal(selfHandoff.body.error.code, 'ASSIGNMENT_APPROVAL_SELF_DECISION');
        assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), beforeFault);
        await pool.query('update users set employee_record_id=null where id=$1', [identities.second.id]);
        await pool.query('update users set employee_record_id=$1 where id=$2', [f.ownerId, identities.reader.id]);
        let decision = await decideAssignment(request, identities.manager, i);
        assert.equal(decision.status, 201, JSON.stringify(decision.body));
        assert.equal(decision.body.receipt.outcome.status, 'Pending');
        i = (await request(base + '/instances/' + i.id, { identity: identities.second })).body.instance;
        assert.equal(await amount(), '20');
        const decisionKey = randomUUID(), terminal = await Promise.all([decideAssignment(request, identities.second, i, 'Approved', {}, decisionKey), decideAssignment(request, identities.second, i, 'Approved', {}, decisionKey)]);
        assert.deepEqual(terminal.map(r => r.status).sort(), [200, 201]);
        assert.deepEqual(terminal[0].body.receipt, terminal[1].body.receipt);
        decision = terminal[0];
        assert.equal(decision.body.receipt.outcome.status, 'Approved');
        assert.equal(await amount(), '25');
        assert.equal((await decideAssignment(request, identities.second, i)).status, 409);
        const latest = (await pool.query('select * from assignment_versions where assignment_id=$1 order by sequence desc limit 1', [a.id])).rows[0];
        assert.equal(latest.actor_id, identities.second.id);
        assert.equal(latest.reason, 'Synthetic material proposal');
        assert.equal(latest.snapshot.quantityExact, '25');
        let current = await source(), candidate = await proposeAssignment(request, fx, current, { definition: { ...nonmaterial, quantityExact: '26' } });
        assert.equal(candidate.status, 201);
        let reject = candidate.body.instance;
        const worker = (await pool.query('select id from users where employee_record_id=$1', [f.ownerId])).rows[0];
        assert(worker);
        await pool.query("insert into notification_preferences(employee_id,event_type,in_app,email,teams)values($1,'approval.rejected_or_correction_required',false,true,true)on conflict(employee_id,event_type)do update set in_app=false", [f.ownerId]);
        await pool.query("update users set status='Inactive'where id=$1", [worker.id]);
        const rejectedBefore = await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']);
        try {
            assert.equal((await decideAssignment(request, identities.manager, reject, 'Rejected')).status, 409);
            assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), rejectedBefore);
        }
        finally {
            await pool.query("update users set status='Active'where id=$1", [worker.id]);
        }
        await pool.query("create function synthetic_assignment_recipient_fault()returns trigger language plpgsql as $$begin if exists(select 1 from assignment_approval_recipients where event_id=new.event_id)then raise exception 'Synthetic second protected recipient fault';end if;return new;end$$;create trigger synthetic_assignment_recipient_fault before insert on assignment_approval_recipients for each row execute function synthetic_assignment_recipient_fault()");
        try {
            assert.equal((await decideAssignment(request, identities.manager, reject, 'Rejected')).status, 503);
            assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), rejectedBefore);
        }
        finally {
            await pool.query('drop trigger synthetic_assignment_recipient_fault on assignment_approval_recipients;drop function synthetic_assignment_recipient_fault()');
        }
        const rejected = await decideAssignment(request, identities.manager, reject, 'Rejected');
        assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
        assert.equal(await amount(), '25');
        const recipients = (await pool.query("select r.* from assignment_approval_recipients r join assignment_approval_events e on e.id=r.event_id where e.instance_id=$1 and e.event_key='approval.rejected_or_correction_required'order by r.user_id", [reject.id])).rows;
        assert.equal(recipients.length, 2);
        assert(recipients.every(r => r.in_app && r.channel_decision === 'Required'));
        assert.deepEqual(recipients.find(r => r.user_id === worker.id).reasons, ['affected_worker']);
        assert.deepEqual(recipients.find(r => r.user_id === identities.requester.id).reasons, ['requester']);
        const inbox = await request('/api/v1/work-approvals/inbox', { identity: identities.requester });
        assert.equal(inbox.status, 200);
        const notice = inbox.body.notifications.find(n => n.kind === 'assignment-approval' && n.instanceId === reject.id && n.eventKey === 'approval.rejected_or_correction_required');
        assert(notice);
        const ack = await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', { method: 'POST', identity: identities.requester, body: { expectedOwnerKey: inbox.body.ownerKey } });
        assert.equal(ack.status, 200);
        assert(ack.body.notification.readAt);
        assert.equal((await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', { method: 'POST', body: { expectedOwnerKey: owner } })).status, 404);
        current = await source();
        candidate = await proposeAssignment(request, fx, current, { definition: { ...nonmaterial, quantityExact: '27' } });
        assert.equal(candidate.status, 201);
        const stale = candidate.body.instance;
        const commentOnly = await request('/api/v1/assignment-versions/assignments/' + a.id + '/versions', { method: 'POST', body: { expectedRevision: current.revision, expectedLatestId: current.versionId, definition: { ...nonmaterial, quantityExact: '25', comment: 'Synthetic nonmaterial accepted change' }, reason: 'Synthetic nonmaterial change leaves older proposal stale' } });
        assert.equal(commentOnly.status, 201, JSON.stringify(commentOnly.body));
        assert.equal((await decideAssignment(request, identities.manager, stale)).status, 409);
        assert.equal(await amount(), '25');
        current = await source();
        candidate = await proposeAssignment(request, fx, current, { definition: { ...nonmaterial, quantityExact: '28' } });
        assert.equal(candidate.status, 201);
        i = candidate.body.instance;
        await pool.query("delete from user_roles where user_id=$1", [identities.manager.id]);
        const revoked = await request(base + '/instances/' + i.id + '/decisions', { method: 'POST', identity: identities.manager, body: { expectedOwnerKey: owner, expectedSourceToken: i.sourceToken, expectedSequence: 0, requestId: randomUUID(), decision: 'Approved', reason: 'Synthetic revoked role' } });
        assert.equal(revoked.status, 403);
        assert.equal(revoked.body.error.code, 'SESSION_ROLE_REVOKED');
        await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='Admin'", [identities.manager.id]);
        assert.equal((await decideAssignment(request, identities.manager, i)).status, 201);
        i = (await request(base + '/instances/' + i.id, { identity: identities.second })).body.instance;
        const competing = await request('/api/allocations', { method: 'POST', identity: identities.requester, body: { ...payload, id: undefined, percentage: 90 } });
        assert.equal(competing.status, 200, JSON.stringify(competing.body));
        await pool.query("insert into system_settings(key,value)values('blockOverAllocation','true'::jsonb)on conflict(key)do update set value='true'::jsonb");
        const blockedBefore = await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']);
        assert.equal((await decideAssignment(request, identities.second, i)).status, 422);
        assert.deepEqual(await snapshot(pool, [...tables, 'project_allocations', 'assignment_versions', 'approval_records']), blockedBefore);
        await pool.query("update system_settings set value='false'::jsonb where key='blockOverAllocation'");
        await pool.query("create function synthetic_optional_assignment_fault()returns trigger language plpgsql as $$begin if new.event_key='approval.completed'then raise exception 'Synthetic optional completion failure';end if;return new;end$$;create trigger synthetic_optional_assignment_fault before insert on assignment_approval_events for each row execute function synthetic_optional_assignment_fault()");
        try {
            const completed = await decideAssignment(request, identities.second, i);
            assert.equal(completed.status, 201, JSON.stringify(completed.body));
            assert.equal(await amount(), '28');
            assert.equal((await pool.query('select count(*)::int n from assignment_approval_notification_failures where instance_id=$1', [i.id])).rows[0].n, 1);
        }
        finally {
            await pool.query('drop trigger synthetic_optional_assignment_fault on assignment_approval_events;drop function synthetic_optional_assignment_fault()');
        }
        const list = await request(base + '/instances?assignmentId=' + a.id, { identity: identities.requester });
        assert.equal(list.status, 200);
        assert.equal(list.body.instances.length, 4);
        assert.deepEqual(await snapshot(pool, preserve), frozen);
        for (const t of tables) {
            const first = (await table(pool, t))[0]?.v;
            if (!first)
                continue;
            const key = t === 'assignment_approval_reads' ? 'recipient_id' : 'id';
            await assert.rejects(pool.query(`delete from ${t} where ${key}=$1`, [first[key]]), { code: '55000' });
        }
        await assert.rejects(pool.query('update assignment_approval_instances set reason=$1 where id=$2', ['rewrite', reject.id]), { code: '55000' });
        for (const discriminator of ['missing', null]) {
            const malformed = { ...d };
            if (discriminator === 'missing')
                delete malformed.entityType;
            else
                malformed.entityType = null;
            assert.equal((await pool.query('select valid_assignment_approval_definition($1::jsonb)accepted', [JSON.stringify(malformed)])).rows[0].accepted, false, 'Required Assignment discriminator must reject missing/null in SQL');
            assert.equal((await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: owner, expectedLatestId: policy.id, effectiveFrom: fx.today, definition: malformed, reason: 'Synthetic missing/null policy discriminator' } })).status, 400);
        }
        const invalidPolicy = { ...d, materialFields: ['quantityExact', 'quantityExact'] };
        assert.equal((await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: owner, expectedLatestId: policy.id, effectiveFrom: fx.today, definition: invalidPolicy, reason: 'Synthetic invalid duplicate material fields' } })).status, 400);
    });
});
console.log('Material assignment real PostgreSQL/API source proposal -> two named stages -> atomic final source version passed.');
