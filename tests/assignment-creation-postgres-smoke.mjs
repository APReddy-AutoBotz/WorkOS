import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { seedAssignmentApproval, adoptAssignmentApproval, assignmentApprovalDefinition, decideAssignment, createApprovalAssignment } from './support/assignment-approval-test.mjs';
import { readApprovalOwner } from './support/work-approval-test.mjs';
import { withPreCreationMigrations } from './support/assignment-creation-test.mjs';
import { runMigrations } from '../server/migrate.mjs';
import { capacityHash } from '../server/modules/planning/worker-capacity-service.mjs';
const base = '/api/v1/work-approvals/assignments';
await withCommercialDatabase(async ({ pool, databaseUrl }) => withPreCreationMigrations(async rootDir => {
  await runMigrations({ pool, rootDir, logger: { log() {} } });
  const fx = await seedAssignmentApproval(pool), { identities: ids, today } = fx;
  // These compatible material-source commands prepare real nonempty065 state;
  // the new inbox/creation routes are not used until066 is installed.
  await withCommercialApi({ databaseUrl, identities: ids }, async ({ request }) => {
    const owner = u => capacityHash([u.username, u.employeeRecordId || u.employeeId || u.id, u.role, f.organizationId, f.legalEntityId]);
    const assignment = await createApprovalAssignment(request, fx), p = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: owner(ids.manager), expectedLatestId: null, effectiveFrom: today, definition: assignmentApprovalDefinition(ids), reason: 'Synthetic pre066 material policy' } }); assert.equal(p.status, 201, JSON.stringify(p.body));
    const source = (await request(base + '/sources/' + assignment.id)).body.source, { assignmentId: _id, employeeId: _worker, projectId: _project, ...definition } = source.snapshot;
    const proposal = await request(base + '/sources/' + assignment.id + '/proposals', { method: 'POST', identity: ids.requester, body: { expectedOwnerKey: owner(ids.requester), expectedRevision: source.revision, expectedLatestId: source.versionId, definition: { ...definition, quantityExact: '25' }, requestId: randomUUID(), reason: 'Synthetic pre066 retained proposal' } }); assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    const keep = ['project_allocations', 'assignment_versions', 'timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions', 'approval_records', 'role_permissions', 'users', 'assignment_approval_policies', 'assignment_approval_templates', 'assignment_approval_instances', 'assignment_approval_transitions', 'assignment_approval_events', 'assignment_approval_recipients', 'assignment_approval_deliveries', 'assignment_approval_reads'];
    const snapshot = async () => Object.fromEntries(await Promise.all(keep.map(async t => [t, (await pool.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows])));
    const before = await snapshot(); assert.equal(before.assignment_approval_instances.length, 1); assert(before.timesheet_entries.length > 0);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['066_wos05_assignment_creation_approvals','067_wos05_approval_due_notices','068_wos05_canonical_leave_approvals', '069_wos05_canonical_delegation','070_wos05_approval_reminders','071_wos02_governed_calendar_authoring','072_wos02_country_group_calendar_authoring','073_wos02_business_structure_authoring','074_wos02_workforce_classification','075_wos02_worker_type','076_wos06_rate_cost_candidates','077_wos06_candidate_owners','078_wos06_commercial_candidate_approvals','079_wos06_approved_rate_adoptions','080_wos06_governed_tm_valuation','081_wos06_tm_billing_eligibility','082_wos06_invoice_draft_occupancy','083_wos06_invoice_batch_approval','084_wos06_approved_invoice_csv','085_wos06_invoice_export_notifications','086_wos06_invoice_billing_confirmation','087_wos06_invoice_action_required']);
    const after = await snapshot(); for (const row of after.assignment_approval_instances) { assert.equal(row.v.operation_kind, 'MaterialChange'); delete row.v.operation_kind; }
    assert.deepEqual(after, before, 'All prior fields, nonempty work and material-source/stage/recipient evidence unchanged');
    assert.equal((await pool.query("select count(*)::int n from assignment_approval_policies where definition?'creationRequired'")).rows[0].n, 0, 'No buyer creation option is installed or backfilled');
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    let v = (await request(base + '/instances/' + proposal.body.instance.id)).body.instance;
    assert.equal((await decideAssignment(request, ids.manager, v)).status, 201); v = (await request(base + '/instances/' + v.id)).body.instance; assert.equal((await decideAssignment(request, ids.second, v)).status, 201, 'Retained old material policy/source continues through original stages');
  });
}));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedAssignmentApproval(pool), { identities: ids, today } = fx;
  await withCommercialApi({ databaseUrl, identities: ids, onServerError: s => process.stderr.write(s) }, async ({ request }) => {
    const workTables = ['timesheets', 'timesheet_entries', 'work_submission_evidence', 'work_submission_decisions'], savedWork = async () => Object.fromEntries(await Promise.all(workTables.map(async t => [t, (await pool.query(`select to_jsonb(t)v from ${t} t order by to_jsonb(t)::text`)).rows]))), originalWork = await savedWork(); assert(originalWork.timesheet_entries.length > 0);
    const policy = await adoptAssignmentApproval(request, fx, { ...assignmentApprovalDefinition(ids), creationRequired: true });
    const definition = { role: 'Synthetic approved creation role', quantityUnit: 'percentage', quantityExact: '20', startsOn: today, endsOn: today, billable: true, status: 'Active', comment: 'Synthetic creation' };
    const key = randomUUID(), body = { expectedOwnerKey: await readApprovalOwner(request, ids.requester), expectedPolicyId: policy.id, employeeId: f.ownerId, projectId: f.projectId, definition, requestId: key, reason: 'Synthetic governed staffing request' };
    const post = () => request(base + '/creations', { method: 'POST', identity: ids.requester, body });
    const create = async (patch = {}) => { const r = await request(base + '/creations', { method: 'POST', identity: ids.requester, body: { ...body, requestId: randomUUID(), ...patch } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.instance; };
    const get = async id => { const r = await request(base + '/creation-instances/' + id); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.instance; };
    const noSource = async id => { assert.equal((await pool.query('select count(*)::int n from project_allocations where id=$1', [id])).rows[0].n, 0); assert.equal((await pool.query('select count(*)::int n from assignment_versions where assignment_id=$1', [id])).rows[0].n, 0); };
    const ledger = async () => (await pool.query('select(select count(*)from assignment_approval_instances)i,(select count(*)from assignment_approval_transitions)t,(select count(*)from assignment_approval_events)e,(select count(*)from assignment_approval_recipients)r,(select count(*)from assignment_approval_deliveries)d,(select count(*)from project_allocations)a,(select count(*)from assignment_versions)v')).rows[0];
    const race = await Promise.all([post(), post()]); assert.deepEqual(race.map(r => r.status).sort(), [200, 201]); assert.equal(race[0].body.instance.id, race[1].body.instance.id);
    const created = race.find(r => r.status === 201);
    let v = created.body.instance; assert.equal(v.operationKind, 'Creation'); assert.equal(v.before, null);
    const absent = async () => { assert.equal((await pool.query('select count(*)::int n from project_allocations where id=$1', [v.assignmentId])).rows[0].n, 0); assert.equal((await pool.query('select count(*)::int n from assignment_versions where assignment_id=$1', [v.assignmentId])).rows[0].n, 0); };
    await absent(); assert.equal((await post()).status, 200);
    assert.equal((await request(base + '/creations', { method: 'POST', identity: ids.requester, body: { ...body, reason: 'Changed retry content' } })).status, 409);
    assert.equal((await request(base + '/creations', { method: 'POST', identity: ids.denied, body: { ...body, requestId: randomUUID() } })).status, 403);
    assert.equal((await request(base + '/creation-instances/' + v.id, { identity: ids.denied })).status, 404);
    assert.equal((await request(base + '/creations', { method: 'POST', identity: ids.requester, body: { ...body, requestId: randomUUID(), expectedPolicyId: randomUUID() } })).status, 409);
    for (const patch of [{ quantityUnit: 'hours' }, { quantityExact: 20 }, { status: null }]) assert.equal((await request(base + '/creations', { method: 'POST', identity: ids.requester, body: { ...body, requestId: randomUUID(), definition: { ...definition, ...patch } } })).status, 400);
    assert.equal((await request(base + '/creations', { method: 'POST', identity: ids.requester, body: { ...body, requestId: randomUUID(), recipients: [ids.requester.id] } })).status, 400);
    assert.equal((await request(base + '/creations', { method: 'POST', body: { ...body, expectedOwnerKey: await readApprovalOwner(request, ids.manager), requestId: randomUUID() } })).status, 403, 'A requester cannot configure itself as a creation decision stage');
    assert.equal((await pool.query('select valid_assignment_approval_definition($1::jsonb) ok', [JSON.stringify({ ...assignmentApprovalDefinition(ids), creationRequired: null })])).rows[0].ok, false);
    for (const field of Object.keys(definition)) { const d = { ...definition }; delete d[field]; assert.equal((await pool.query('select valid_assignment_creation_definition($1::jsonb) ok', [JSON.stringify(d)])).rows[0].ok, false, field); }
    assert.equal((await pool.query('select valid_assignment_creation_definition($1::jsonb) ok', [JSON.stringify({ ...definition, status: null })])).rows[0].ok, false);
    assert.equal((await pool.query('select valid_assignment_creation_definition($1::jsonb) ok', [JSON.stringify({ ...definition, comment: '😀'.repeat(1501) })])).rows[0].ok, false, 'SQL uses the public UTF-16 note bound');
    const payload = { employee_id: f.ownerId, project_id: f.projectId, percentage: 20, start_date: today, end_date: today, billable: true, status: 'Active' };
    assert.equal((await request('/api/allocations', { method: 'POST', body: payload })).status, 409, 'ordinary manual creation cannot bypass configured approval');
    await assert.rejects(pool.query("insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)values($1,$2,$3,20,$4,$4,true,'Active',$5,$6)", ['synthetic-denied-creation', f.ownerId, f.projectId, today, f.organizationId, f.legalEntityId]), { code: 'ASA01' });
    for (const versioned of [false, true]) for (const dryRun of versioned ? [true, false] : [false]) {
      const path = (versioned ? '/api/v1' : '/api') + '/imports/allocations/apply', key = randomUUID(), options = { method: 'POST', headers: versioned ? { 'Idempotency-Key': key } : {}, body: { fileName: 'synthetic-creation.csv', rows: [{ id: 'synthetic-create-import-' + String(versioned), employeeId: f.ownerId, projectId: f.projectId, roleOnProject: definition.role, percentage: 20, startDate: today, endDate: today, billable: true, status: 'Active' }], ...(versioned ? { schemaVersion: 'allocation-control/1', dryRun } : {}) } };
      const before = await ledger(), r = await request(path, options); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.validRows, 0, JSON.stringify(r.body)); assert.equal(r.body.errorRows, 1); assert(r.body.errors.some(e => e.code === 'ASSIGNMENT_APPROVAL_REQUIRED'));
      if (versioned && !dryRun) assert.deepEqual((await request(path, options)).body, r.body);
      assert.deepEqual(await ledger(), before);
    }
    assert.equal((await decideAssignment(request, ids.second, v)).status, 403);
    const beforeHandoff = await ledger();
    await pool.query("create function synthetic_creation_delivery_failure()returns trigger language plpgsql as $$begin raise exception 'Synthetic creation delivery failure';end$$;create trigger synthetic_creation_delivery before insert on assignment_approval_deliveries for each row execute function synthetic_creation_delivery_failure()");
    try { assert.equal((await decideAssignment(request, ids.manager, v)).status, 503); assert.deepEqual(await ledger(), beforeHandoff); await absent(); }
    finally { await pool.query('drop trigger synthetic_creation_delivery on assignment_approval_deliveries;drop function synthetic_creation_delivery_failure()'); }
    let decision = await decideAssignment(request, ids.manager, v); assert.equal(decision.status, 201, JSON.stringify(decision.body)); await absent();
    v = (await request(base + '/creation-instances/' + v.id)).body.instance;
    const finalKey = randomUUID(), finalRace = await Promise.all([decideAssignment(request, ids.second, v, 'Approved', {}, finalKey), decideAssignment(request, ids.second, v, 'Approved', {}, finalKey)]);
    assert.deepEqual(finalRace.map(r => r.status).sort(), [200, 201]); assert.deepEqual(finalRace[0].body.receipt, finalRace[1].body.receipt); decision = finalRace[0];
    const source = (await pool.query('select * from project_allocations where id=$1', [v.assignmentId])).rows[0]; assert(source); assert.equal(String(source.percentage), '20');
    const versions = (await pool.query('select * from assignment_versions where assignment_id=$1', [v.assignmentId])).rows; assert.equal(versions.length, 1); assert.equal(versions[0].sequence, 1); assert.equal(versions[0].change_kind, 'Created');
    assert.equal((await request(base + '/instances')).body.instances.length, 0, 'creation requests do not contaminate old material-only list DTOs');
    const rejected = await create(), rejectedSource = JSON.stringify(rejected.proposed);
    assert.equal((await decideAssignment(request, ids.manager, rejected, 'Rejected')).status, 201); await noSource(rejected.assignmentId); assert.equal((await get(rejected.id)).state.status, 'Rejected'); assert.equal(JSON.stringify((await get(rejected.id)).proposed), rejectedSource);
    const missing = await create(); await pool.query("update users set status='Inactive'where id=$1", [ids.reader.id]); const beforeMissing = await ledger();
    try { assert.equal((await decideAssignment(request, ids.manager, missing, 'Rejected')).status, 409); assert.deepEqual(await ledger(), beforeMissing); }
    finally { await pool.query("update users set status='Active'where id=$1", [ids.reader.id]); }
    assert.equal((await decideAssignment(request, ids.manager, missing, 'Rejected')).status, 201); await noSource(missing.assignmentId);
    const changedProject = await create(); assert.equal((await decideAssignment(request, ids.manager, changedProject)).status, 201);
    await pool.query("update projects set status='Completed'where id=$1", [f.projectId]); const beforeProject = await ledger();
    try { assert.equal((await decideAssignment(request, ids.second, await get(changedProject.id))).status, 422); assert.deepEqual(await ledger(), beforeProject); await noSource(changedProject.assignmentId); }
    finally { await pool.query("update projects set status='Active'where id=$1", [f.projectId]); }
    for (const changed of ['date', 'billability']) {
      const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      const pending = await create(changed === 'date' ? { definition: { ...definition, endsOn: tomorrow } } : {}); assert.equal((await decideAssignment(request, ids.manager, pending)).status, 201);
      const original = (await pool.query('select end_date::text,billable from projects where id=$1', [f.projectId])).rows[0];
      if (changed === 'date') await pool.query('update projects set end_date=$1::date where id=$2', [today, f.projectId]);
      else await pool.query('update projects set billable=false where id=$1', [f.projectId]);
      const before = await ledger();
      try { const final = await decideAssignment(request, ids.second, await get(pending.id)); assert.equal(final.status, 422, JSON.stringify(final.body)); assert.deepEqual(await ledger(), before); await noSource(pending.assignmentId); }
      finally { await pool.query('update projects set end_date=$1::date,billable=$2 where id=$3', [original.end_date, original.billable, f.projectId]); }
    }
    const revoked = await create(); await pool.query("update role_permissions set enabled=false where role_name='Admin'and permission_key='allocations.manage'");
    try { assert.equal((await decideAssignment(request, ids.manager, revoked)).status, 403); await noSource(revoked.assignmentId); }
    finally { await pool.query("update role_permissions set enabled=true where role_name='Admin'and permission_key='allocations.manage'"); }
    const optional = await create(); assert.equal((await decideAssignment(request, ids.manager, optional)).status, 201);
    await pool.query("create function synthetic_creation_optional_failure()returns trigger language plpgsql as $$begin if new.event_key='approval.completed'then raise exception 'Synthetic creation optional failure';end if;return new;end$$;create trigger synthetic_creation_optional before insert on assignment_approval_events for each row execute function synthetic_creation_optional_failure()");
    try { assert.equal((await decideAssignment(request, ids.second, await get(optional.id))).status, 201); }
    finally { await pool.query('drop trigger synthetic_creation_optional on assignment_approval_events;drop function synthetic_creation_optional_failure()'); }
    assert.equal((await get(optional.id)).notificationFailures.length, 1); assert((await pool.query('select * from project_allocations where id=$1', [optional.assignmentId])).rowCount);
    const overlap = await create(); assert.equal((await decideAssignment(request, ids.manager, overlap)).status, 201);
    const overlapPolicy = await request('/api/v1/assignment-overlap/policies', { method: 'POST', body: { expectedLatestId: null, effectiveFrom: today, definition: { enabled: true, quantityUnit: 'percentage', includedStatus: 'Active', warningThresholdExact: null, blockingThresholdExact: '40' }, reason: 'Synthetic explicit current-load boundary' } }); assert.equal(overlapPolicy.status, 201, JSON.stringify(overlapPolicy.body));
    const beforeOverlap = await ledger(); assert.equal((await decideAssignment(request, ids.second, await get(overlap.id))).status, 422); assert.deepEqual(await ledger(), beforeOverlap); await noSource(overlap.assignmentId);
    const next = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const inherited = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, ids.manager), expectedLatestId: policy.id, effectiveFrom: next, definition: { ...assignmentApprovalDefinition(ids), materialFields: [] }, reason: 'Synthetic older editor omission preserves creation-only requirement' } }); assert.equal(inherited.status, 201, JSON.stringify(inherited.body)); assert.equal(inherited.body.policy.definition.creationRequired, true);
    const olderSql = await pool.connect(); try {
      await olderSql.query('begin'); await olderSql.query("select set_config('workos.assignment_approval_context',$1,true)", [JSON.stringify({ actorId: ids.manager.id, activeRole: 'Admin', organizationId: f.organizationId, legalEntityId: f.legalEntityId })]);
      const d = (await olderSql.query("insert into assignment_approval_policies(id,organization_id,legal_entity_id,sequence,effective_from,definition,actor_id,active_role,reason)values($1,$2,$3,3,$4::date+1,$5,$6,'Admin','Synthetic old SQL editor omission')returning definition", [randomUUID(), f.organizationId, f.legalEntityId, next, assignmentApprovalDefinition(ids), ids.manager.id])).rows[0].definition; assert.equal(d.creationRequired, true);
    } finally { await olderSql.query('rollback'); olderSql.release(); }
    const dayAfter = new Date(Date.parse(next + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const retired = await request(base + '/policies', { method: 'POST', body: { expectedOwnerKey: await readApprovalOwner(request, ids.manager), expectedLatestId: inherited.body.policy.id, effectiveFrom: dayAfter, definition: { ...assignmentApprovalDefinition(ids), materialFields: [], creationRequired: false }, reason: 'Synthetic explicit future creation-only retirement' } }); assert.equal(retired.status, 201, JSON.stringify(retired.body)); assert.equal(retired.body.policy.definition.creationRequired, false);
    await assert.rejects(pool.query('delete from assignment_approval_instances where id=$1', [v.id]));
    assert.deepEqual(await savedWork(), originalWork, 'Existing nonempty approved work and submission/decision history remain unchanged');
    console.log('Creation request/two named stages/exact effective V1 passed', JSON.stringify({ instance: v.id, assignment: v.assignmentId, version: versions[0].id }));
  });
});
