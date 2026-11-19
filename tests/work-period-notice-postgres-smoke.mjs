import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../server/migrate.mjs';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { NOTICE_BASE as base, noticeDefinition, seedPeriodNotices, configurePeriodNotices, previewPeriodNotice, evaluatePeriodNotice, withPrePeriodNoticeMigrations } from './support/work-period-notice-test.mjs';
import { readApprovalOwner, prepareStagedWork, submitStagedWork, adoptStagedPolicy, workApprovalWorkers as workers, stagedWorkEntries } from './support/work-approval-test.mjs';
const table = async (p, t) => (await p.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows, tables = ['work_period_notice_policies', 'work_period_notice_templates', 'work_period_notice_runs', 'work_period_notice_events', 'work_period_notice_recipients', 'work_period_notice_deliveries', 'work_period_notice_reads'];
await withCommercialDatabase(async ({ pool }) => withPrePeriodNoticeMigrations(async (rootDir) => { await runMigrations({ pool, rootDir, logger: { log() { } } }); await seedPeriodNotices(pool); const keep = ['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'work_approval_policy_versions', 'work_approval_instances', 'work_approval_events', 'approval_records', 'notification_events', 'notification_delivery_attempts', 'role_permissions', 'work_capture_policy_versions'], before = Object.fromEntries(await Promise.all(keep.map(async (t) => [t, await table(pool, t)]))); assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock']); for (const t of tables)
    assert.deepEqual(await table(pool, t), []); for (const t of keep)
    assert.deepEqual(await table(pool, t), before[t], t + ' neutral upgrade'); assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []); }));
for (const mode of ['due', 'overdue'])
    await withCommercialDatabase(async ({ pool, databaseUrl }) => {
        await migrateCommercialDatabase(pool);
        const fx = await seedPeriodNotices(pool, mode), { identities } = fx, diagnostics = [];
        await withCommercialApi({ databaseUrl, identities, onServerError: s => diagnostics.push(s), timeZone: 'Pacific/Kiritimati' }, async ({ request }) => {
            const none = await previewPeriodNotice(request, fx);
            assert.equal(none.status, 200, JSON.stringify(none.body));
            assert.equal(none.body.preview.state, 'unconfigured');
            assert.equal((await previewPeriodNotice(request, fx, identities.first)).status, 403);
            await assert.rejects(pool.query("insert into work_period_notice_policies(id,organization_id,legal_entity_id,sequence,effective_from,definition,actor_id,active_role,reason)values($1,$2,$3,1,$4,$5,$6,'Admin','Synthetic unsupported direct SQL')", [randomUUID(), f.organizationId, f.legalEntityId, fx.today, JSON.stringify(noticeDefinition(identities, mode)), identities.manager.id]), { code: 'WDN01' });
            const overflowing=noticeDefinition(identities,mode);overflowing.templates[1].body=Array(530).fill('{{workerCode}}').join(' ');const invalid=await request(base+'/policies',{method:'POST',body:{expectedOwnerKey:await readApprovalOwner(request,identities.manager),expectedLatestId:null,effectiveFrom:fx.today,definition:overflowing,reason:'Synthetic expansion contract regression'}});assert.equal(invalid.status,400);assert.equal((await table(pool,'work_period_notice_policies')).length,0);assert.equal((await pool.query('select valid_work_period_notice_definition($1::jsonb)ok',[JSON.stringify(overflowing)])).rows[0].ok,false);assert.equal((await pool.query("select work_period_notice_units('🙂')n")).rows[0].n,2);assert.equal((await pool.query("select work_period_notice_units('')n")).rows[0].n,0);
        const configured = await configurePeriodNotices(request, fx, { ...noticeDefinition(identities, mode), workerIds: Object.values(workers).sort() });
            let p = (await previewPeriodNotice(request, fx)).body.preview;
            assert.equal(p.state, mode, JSON.stringify(p));
            assert.equal(p.eventKey, 'work_period.submission_' + mode);
            assert.equal(p.recipientReasons.length, mode === 'due' ? 1 : 2);
            const snapshot = async () => Object.fromEntries(await Promise.all(['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'work_approval_instances', 'work_approval_transitions', 'work_approval_events', 'approval_records', 'project_allocations', 'worker_capacity_versions', 'notification_events', 'notification_delivery_attempts'].map(async (t) => [t, await table(pool, t)]))), old = await snapshot(), counts = async () => Object.fromEntries(await Promise.all(tables.slice(2).map(async (t) => [t, await table(pool, t)]))), empty = await counts(), key = randomUUID();
            assert.equal((await evaluatePeriodNotice(request, fx, p, key, { recipients: [identities.manager.id] })).status, 400);
            assert.deepEqual(await counts(), empty);
            await pool.query("update users set status='Inactive'where id=$1", [identities.first.id]);
            assert.equal((await evaluatePeriodNotice(request, fx, p, key)).status, 409);
            assert.deepEqual(await counts(), empty);
            await pool.query("update users set status='Active'where id=$1", [identities.first.id]);
            assert.equal((await request(base + '/preview?' + new URLSearchParams({ employeeId: fx.workerId, periodId: fx.periodId, asOf: '2099-01-01T00:00:00Z' }))).status, 400);
            assert.equal((await evaluatePeriodNotice(request, fx, p, key, { checkedAt: '2099-01-01T00:00:00Z' })).status, 400);
            assert.deepEqual(await counts(), empty);
            if (mode === 'overdue') {
                await pool.query('update user_organization_scopes set active=false where user_id=$1', [identities.second.id]);
                assert.equal((await evaluatePeriodNotice(request, fx, p, key)).status, 409);
                assert.deepEqual(await counts(), empty);
                await pool.query('update user_organization_scopes set active=true where user_id=$1', [identities.second.id]);
                await pool.query('delete from user_roles where user_id=$1', [identities.second.id]);
                assert.equal((await evaluatePeriodNotice(request, fx, p, key)).status, 409);
                assert.deepEqual(await counts(), empty);
                await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='Admin'", [identities.second.id]);
            }
            const ambiguousId = randomUUID();
            await assert.rejects(pool.query("insert into users(id,username,email,status,employee_record_id,employee_id)values($1,$2,$3,'Active',$4,$4)", [ambiguousId, 'synthetic-ambiguous-' + ambiguousId, 'synthetic-' + ambiguousId + '@example.test', fx.workerId]), { code: '23505' });
            assert.deepEqual(await counts(), empty, 'existing unique worker-account relationship prevents ambiguous linking');
            await pool.query("insert into notification_preferences(employee_id,event_type,in_app,email,teams)values($1,$2,false,true,true)", [fx.workerId, p.eventKey]);
            await pool.query(`create function synthetic_notice_delivery_failure()returns trigger language plpgsql as $$begin raise exception 'Synthetic protected InApp delivery persistence failure';end$$;create trigger synthetic_notice_delivery_failure before insert on work_period_notice_deliveries for each row execute function synthetic_notice_delivery_failure()`);
            try {
                assert.equal((await evaluatePeriodNotice(request, fx, p, key)).status, 503);
                assert.deepEqual(await counts(), empty);
            }
            finally {
                await pool.query('drop trigger synthetic_notice_delivery_failure on work_period_notice_deliveries');
                await pool.query('drop function synthetic_notice_delivery_failure()');
            }
            await pool.query('update employees set employee_id=$1 where id=$2',['x'.repeat(201),fx.workerId]);const unsupported=(await previewPeriodNotice(request,fx)).body.preview;assert.equal((await evaluatePeriodNotice(request,fx,unsupported)).status,422);assert.deepEqual(await counts(),empty,'Unsupported rendered metadata leaves no protected success fragments');await pool.query('update employees set employee_id=$1 where id=$2',[fx.workerId,fx.workerId]);
        const fault = mode === 'overdue' ? `if exists(select 1 from work_period_notice_recipients where event_id=new.event_id)then raise exception 'Synthetic second recipient failure';end if;` : `raise exception 'Synthetic first recipient failure';`;
            await pool.query(`create function synthetic_notice_recipient_failure()returns trigger language plpgsql as $$begin ${fault}return new;end$$;create trigger synthetic_notice_recipient_failure before insert on work_period_notice_recipients for each row execute function synthetic_notice_recipient_failure()`);
            try {
                assert.equal((await evaluatePeriodNotice(request, fx, p, key)).status, 503);
                assert.deepEqual(await counts(), empty);
            }
            finally {
                await pool.query('drop trigger synthetic_notice_recipient_failure on work_period_notice_recipients');
                await pool.query('drop function synthetic_notice_recipient_failure()');
            }
            const race = await Promise.all([evaluatePeriodNotice(request, fx, p, key), evaluatePeriodNotice(request, fx, p, key)]);
            assert.deepEqual(race.map(r => r.status).sort(), [200, 201]);
            assert.deepEqual(race[0].body.receipt, race[1].body.receipt);
            assert.equal(race[0].body.receipt.outcome.disposition, 'Emitted');
            const emitted = race[0].body.receipt;
            assert.equal((await table(pool, 'work_period_notice_events')).length, 1);
            assert.equal((await table(pool, 'work_period_notice_recipients')).length, mode === 'due' ? 1 : 2);
            assert.equal((await table(pool, 'work_period_notice_deliveries')).length, mode === 'due' ? 1 : 2);
            assert.deepEqual(await snapshot(), old);
            assert.equal((await evaluatePeriodNotice(request, fx, p, key, { reason: 'Different intent' })).status, 409);
            assert.equal((await evaluatePeriodNotice(request, fx, p)).status, 409);
            p = (await previewPeriodNotice(request, fx)).body.preview;
            const again = await evaluatePeriodNotice(request, fx, p);
            assert.equal(again.status, 201, JSON.stringify(again.body));
            assert.equal(again.body.receipt.outcome.disposition, 'Existing');
            assert.equal(again.body.receipt.outcome.eventId, emitted.outcome.eventId);
            assert.equal((await table(pool, 'work_period_notice_events')).length, 1);
            const inbox = await request('/api/v1/work-approvals/inbox', { identity: identities.first });
            assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
            const notice = inbox.body.notifications.find(n => n.kind === 'work-period');
            assert(notice);
            assert.equal(notice.eventKey, 'work_period.submission_' + mode);
            assert.equal(notice.deliveryStatus, 'Delivered');
            const ack = await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', { method: 'POST', identity: identities.first, body: { expectedOwnerKey: inbox.body.ownerKey } });
            assert.equal(ack.status, 200, JSON.stringify(ack.body));
            assert(ack.body.notification.readAt);
            assert.equal((await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, identities.manager) } })).status, 404);
            // Real accepted source with a pending PR77 stage suppresses the missing-submission producer.
            await prepareStagedWork(request, identities, fx.today);
            await adoptStagedPolicy(request, identities, fx.today);
            const submitted = await submitStagedWork(request, identities.first, fx.today);
            assert.equal(submitted.instance.state.status, 'Pending');
            const accepted = (await previewPeriodNotice(request, fx)).body.preview;
            assert.equal(accepted.state, 'accepted', JSON.stringify(accepted));
            assert.equal(accepted.eventKey, null);
            assert.equal((await evaluatePeriodNotice(request, fx, accepted)).body.receipt.outcome.disposition, 'NoEvent');
            assert.equal((await table(pool, 'work_period_notice_events')).length, 1);
            // Both import aliases retain real accepted zero work and create no missing-submission event.
            for (const versioned of [false, true]) {
                const employeeId = versioned ? workers.versionedImport : workers.legacyImport, other = { ...fx, workerId: employeeId }, url = (versioned ? '/api/v1' : '/api') + '/imports/timesheets/apply', row = { employeeId, weekEnding: fx.today, workType: 'Non-client Work', categoryCode: 'CAT0', date: fx.today, hours: '0', billable: false, status: 'Submitted', remark: 'Synthetic zero accepted source' }, importKey = randomUUID(), call = (dryRun = false, key = importKey) => request(url, { method: 'POST', identity: identities.requester, headers: versioned ? { 'Idempotency-Key': key } : {}, body: { fileName: 'synthetic-notice-source.csv', rows: [row], ...(versioned ? { schemaVersion: 'timesheet-import/1', dryRun } : {}) } });
                if (versioned) {
                    const before = await table(pool, 'timesheets');
                    assert.equal((await call(true, randomUUID())).body.validRows, 1);
                    assert.deepEqual(await table(pool, 'timesheets'), before);
                }
                const imported = await call();
                assert.equal(imported.body.validRows, 1, JSON.stringify(imported.body));
                if (versioned)
                    assert.deepEqual((await call()).body, imported.body);
                const v = (await previewPeriodNotice(request, other)).body.preview;
                assert.equal(v.state, 'accepted', JSON.stringify(v));
                assert.equal(v.eventKey, null);
            }
            // Current rejection/correction lineage is explicitly unavailable, rather than inferred missing work.
            const corrected = { ...fx, workerId: workers.optional }, pending = await submitStagedWork(request, identities.optional, fx.today), rejected = await request('/api/v1/work-approvals/instances/' + pending.instance.id + '/decisions', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, identities.manager), expectedSourceToken: pending.instance.sourceToken, expectedSequence: 0, requestId: randomUUID(), decision: 'Rejected', reason: 'Synthetic correction lineage' } });
            assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
            assert.equal((await previewPeriodNotice(request, corrected)).body.preview.state, 'unavailable');
            assert.equal((await request('/api/timesheets', { method: 'POST', identity: identities.optional, body: { employee_id: workers.optional, week_ending: fx.today, status: 'Draft', entries: stagedWorkEntries(fx.today, '0.5') } })).status, 200);
            assert.equal((await previewPeriodNotice(request, corrected)).body.preview.state, 'unavailable');
            // Queue a real submission before evaluation on the shared lifecycle lock. The latter must see it.
            const raceFx = { ...fx, workerId: workers.correction }, racePreview = (await previewPeriodNotice(request, raceFx)).body.preview, blocker = await pool.connect();
            let held = false;
            try {
                await blocker.query('begin');
                held = true;
                await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['commercial-lifecycle:' + f.organizationId + ':' + f.legalEntityId]);
                const pendingSubmit = submitStagedWork(request, identities.correction, fx.today);
                let waiting = false;
                for (let n = 0; n < 100; n++) {
                    const v = (await pool.query("select count(*)::int n from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database()and l.locktype='advisory'and not l.granted")).rows[0].n;
                    if (v) {
                        waiting = true;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 20));
                }
                assert(waiting, 'real source submit is queued before evaluation');
                const pendingNotice = evaluatePeriodNotice(request, raceFx, racePreview);
                await new Promise(r => setTimeout(r, 50));
                await blocker.query('commit');
                held = false;
                assert((await pendingSubmit).instance);
                assert.equal((await pendingNotice).status, 409);
                assert.equal((await previewPeriodNotice(request, raceFx)).body.preview.state, 'accepted');
                assert.equal((await pool.query('select count(*)::int n from work_period_notice_events e join work_period_notice_runs r on r.id=e.run_id where r.employee_id=$1', [workers.correction])).rows[0].n, 0);
            }
            finally {
                if (held)
                    await blocker.query('rollback');
                blocker.release();
            }
            // No retained identity is fabricated for a legacy Submitted header.
            await pool.query("insert into timesheets(employee_id,week_ending,status,organization_id,legal_entity_id)values($1,$2,'Submitted',$3,$4)", [workers.locked, fx.today, f.organizationId, f.legalEntityId]);
            assert.equal((await previewPeriodNotice(request, { ...fx, workerId: workers.locked })).body.preview.state, 'unavailable');
            // Cursor history/replay are immutable observations, and never add another phase delivery.
            for (let i = 0; i < 9; i++)
                assert.equal((await evaluatePeriodNotice(request, fx, accepted)).status, 201);
            const history = await request(base + '/history?' + new URLSearchParams({ employeeId: fx.workerId, periodId: fx.periodId }));
            assert.equal(history.body.receipts.length, 10);
            assert.equal(history.body.nextBefore, history.body.receipts.at(-1).sequence);
            const older = await request(base + '/history?' + new URLSearchParams({ employeeId: fx.workerId, periodId: fx.periodId, before: String(history.body.nextBefore) }));
            assert(older.body.receipts.length > 0);
            assert.equal(older.body.nextBefore, null);
            assert.equal((await table(pool, 'work_period_notice_events')).length, 1);
            const futureDefinition = { ...noticeDefinition(identities, mode), workerIds: [] }, future = (await request(base + '/choices')).body.periods.find(x => x.id === 'synthetic-category-next'), adopt = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, identities.manager), expectedLatestId: configured.policy.id, effectiveFrom: future.starts_on, definition: futureDefinition, reason: 'Synthetic explicit future retirement' } });
            assert.equal(adopt.status, 201, JSON.stringify(adopt.body));
            assert.equal((await previewPeriodNotice(request, fx)).body.preview.policy.id, configured.policy.id);
            assert.equal((await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, identities.manager), expectedLatestId: configured.policy.id, effectiveFrom: future.ends_on, definition: futureDefinition, reason: 'Synthetic stale adoption' } })).status, 409);
            for (const t of tables) {
                const row = (await pool.query(`select * from ${t} limit 1`)).rows[0];
                if (row)
                    await assert.rejects(pool.query(`delete from ${t} where ${t === 'work_period_notice_reads' ? 'recipient_id' : 'id'}=$1`, [row[t === 'work_period_notice_reads' ? 'recipient_id' : 'id']]));
            }
            console.log(JSON.stringify({ mode, sourcePolicy: configured.capture.id, noticePolicy: configured.policy.id, emitted: emitted.id, pendingAcceptedSuppressed: true, zeroImportAliasesSuppressed: true, sourceRaceSuppressed: true, sourceUnchangedByProducer: true }));
        }).catch(e => { console.error('Synthetic deadline notice API diagnostic:', diagnostics.join('').slice(-2600)); throw e; });
    });
await withCommercialDatabase(async ({ pool, databaseUrl }) => { await migrateCommercialDatabase(pool); const fx = await seedPeriodNotices(pool, 'overdue'), { identities } = fx; await withCommercialApi({ databaseUrl, identities }, async ({ request }) => { const definition = { ...noticeDefinition(identities, 'overdue'), escalationOwner: { userId: identities.first.id, role: 'Employee' } }; await configurePeriodNotices(request, fx, definition); assert.equal((await pool.query('select valid_work_period_notice_definition($1::jsonb)ok', [JSON.stringify({ ...definition, escalationOwner: { ...definition.escalationOwner, userId: 'ABCDEF01-1111-4111-8111-111111111111' } })])).rows[0].ok, false); const p = (await previewPeriodNotice(request, fx)).body.preview; assert.deepEqual(p.recipientReasons, [{ userId: identities.first.id, reasons: ['affected_worker', 'configured_escalation_owner'] }]); assert.equal((await evaluatePeriodNotice(request, fx, p)).status, 201); assert.equal((await table(pool, 'work_period_notice_recipients')).length, 1); assert.equal((await table(pool, 'work_period_notice_deliveries')).length, 1); await pool.query("update reporting_periods set code=code||'-changed'where id=$1",[fx.periodId]);const changed=(await previewPeriodNotice(request,fx)).body.preview;assert.equal(changed.state,'unavailable');assert.match(changed.unavailableReason,/lineage changed/);assert.equal((await evaluatePeriodNotice(request,fx,changed)).status,409);await pool.query("update reporting_periods set status='Approval Closed'where id=$1", [fx.periodId]); const closed = (await previewPeriodNotice(request, fx)).body.preview; assert.equal(closed.state, 'unavailable'); assert.match(closed.unavailableReason, /closed-period/); assert.equal((await evaluatePeriodNotice(request, fx, closed)).status, 409); assert.equal((await table(pool, 'work_period_notice_events')).length, 1); }); });
console.log('Work-period notice PostgreSQL fresh/063 upgrade/replay, real UTC due/overdue, protected atomic recipient failure/recovery/concurrency/dedup, source neutrality, owned canonical inbox/read and accepted pending-stage suppression passed.');
