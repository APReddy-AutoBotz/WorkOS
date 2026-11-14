import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readdir, copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {commercialFixture as f, commercialServerDir, withCommercialDatabase, withPreCommercialMigrations, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedActualWork, adoptActualInputs, actualEntries} from './support/actual-work-test.mjs';
import {runMigrations} from '../server/migrate.mjs';

// Upgrade a populated prior revision without rewriting any existing source or grant.
await withCommercialDatabase(async ({pool}) => withPreCommercialMigrations(async rootDir => {
  for (const name of await readdir(join(commercialServerDir, 'migrations'))) {
    if (/^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) >= 40 && Number(name.slice(0, 3)) <= 96) {
      await copyFile(join(commercialServerDir, 'migrations', name), join(rootDir, 'migrations', name));
    }
  }
  await runMigrations({pool, rootDir, logger: {log() {}}});
  await seedActualWork(pool);
  const tables = ['users', 'user_roles', 'role_permissions', 'employees', 'projects', 'timesheets', 'timesheet_entries', 'approval_records', 'worker_capacity_versions', 'actual_work_evidence'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows])));
  const before = await snapshot();
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied, ['097_wos07_project_contribution_evidence']);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await pool.query('select count(*)::int n from project_contribution_evidence')).rows[0].n, 0);
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
  assert.deepEqual(await snapshot(), before);
}));

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const {identities, today} = await seedActualWork(pool);
  const path = '/api/v1/project-contribution/projects/' + f.projectId;
  await withCommercialApi({databaseUrl, identities}, async ({request}) => {
    await adoptActualInputs(request, today);
    const work = await request('/api/timesheets', {method: 'POST', identity: identities.reader,
      body: {employee_id: f.ownerId, week_ending: today, status: 'Submitted', entries: actualEntries(today)}});
    assert.equal(work.status, 200, JSON.stringify(work.body));
    assert.equal((await request(`/api/timesheets/${work.body.id}/status`, {method: 'PATCH', body: {status: 'Approved'}})).status, 200);
    const observation = await request(path + '/period?' + new URLSearchParams({startsOn: today, endsOn: today}));
    assert.equal(observation.status, 200);
    const input = {startsOn: today, endsOn: today, expectedSourceToken: observation.body.result.sourceToken, requestId: randomUUID(), reason: 'Synthetic report retention'};
    const save = body => request(path + '/evidence', {method: 'POST', body});
    assert.equal((await save({...input, expectedSourceToken: '0'.repeat(64)})).status, 409);
    assert.equal((await save({...input, actorId: 'forged'})).status, 400);
    const concurrent = await Promise.all([save(input), save(input)]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 201], JSON.stringify(concurrent));
    const saved = concurrent.find(response => response.status === 201).body;
    assert.equal(saved.replayed, false);
    assert.equal(concurrent.find(response => response.status === 200).body.csv, saved.csv);
    assert.equal(saved.evidence.result.includedHoursExact, '2');
    assert.equal(saved.evidence.artifact.sha256, createHash('sha256').update(saved.csv).digest('hex'));
    assert.equal(saved.evidence.artifact.bytes, Buffer.byteLength(saved.csv, 'utf8'));
    assert.equal((await pool.query('select count(*)::int n from project_contribution_evidence')).rows[0].n, 1);
    assert.equal((await save({...input, reason: 'Changed intent'})).status, 409);
    const receipt = await request(path + '/requests/' + input.requestId);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.deepEqual(receipt.body.evidence, saved.evidence);
    assert.equal(receipt.body.csv, undefined, 'reconciliation is a read of the receipt, not an export');
    const artifactPath = path + '/evidence/' + saved.evidence.id + '/artifact';
    assert.equal((await request(artifactPath)).body.csv, saved.csv);
    assert.equal((await request(path + '/requests/' + randomUUID())).status, 404);
    assert.equal((await request(artifactPath, {authenticated: false})).status, 401);
    assert.equal((await request(artifactPath, {identity: identities.reader})).status, 403);
    // A reader may still see the project while lacking one retained worker.
    // Never trim the original artifact or leak that worker through aggregates.
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('synthetic-retained-viewer','SYN-RETAINED-VIEWER','Synthetic scoped viewer','retained-viewer@example.test','Consultant','Delivery','US','director-commercial','Active',$1,$2)`, [f.organizationId, f.legalEntityId]);
    await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
      values('synthetic-retained-viewer-assignment','synthetic-retained-viewer',$1,0,$2,$2,true,'Active',$3,$4)`, [f.projectId, today, f.organizationId, f.legalEntityId]);
    await pool.query("update users set employee_record_id='synthetic-retained-viewer',employee_id='SYN-RETAINED-VIEWER' where id=$1", [identities.denied.id]);
    await pool.query(`insert into user_permission_grants(user_id,permission_key) select $1,unnest($2::text[]) on conflict do nothing`,
      [identities.denied.id, ['projects.view', 'employees.view', 'reports.view_utilization', 'reports.export']]);
    const scoped = await request(path + '/period?' + new URLSearchParams({startsOn: today, endsOn: today}), {identity: identities.denied});
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.result.workerCount, 1);
    assert.equal((await request(artifactPath, {identity: identities.denied})).status, 404, 'project access must not authorize retained hidden workers');
    const historyPath = path + '/evidence?' + new URLSearchParams({startsOn: today, endsOn: today});
    const hiddenHistory = await request(historyPath, {identity: identities.denied});
    assert.equal(hiddenHistory.status, 200);
    assert.deepEqual(hiddenHistory.body.evidence, []);
    assert.equal(hiddenHistory.body.nextBefore, null);
    assert.equal((await request(historyPath + '&before=' + saved.evidence.id, {identity: identities.denied})).status, 404);
    assert.equal((await request(path + '/requests/' + input.requestId, {identity: identities.denied})).status, 404, 'request receipts are actor and role bound');
    assert.equal((await request(artifactPath.replace(f.projectId, f.foreignClientId))).status, 404);
    for (const permission of ['reports.export', 'reports.view_utilization', 'projects.view', 'employees.view']) {
      await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1", [permission]);
      assert.equal((await request(artifactPath)).status, 403, permission);
      assert.equal((await request(path + '/requests/' + input.requestId)).status, 403, permission);
      assert.equal((await save(input)).status, 403, permission);
      await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key=$1", [permission]);
    }
    // Revoke after request middleware has run but while the command is waiting
    // on its request lock. Authority must be read again after that wait.
    const waitingInput = {...input, requestId: randomUUID()};
    const lockKey = JSON.stringify(['project-evidence', {organizationId: f.organizationId, legalEntityId: f.legalEntityId},
      f.projectId, identities.manager.id, 'Admin', waitingInput.requestId]);
    const blocker = await pool.connect();
    let pending;
    try {
      await blocker.query('select pg_advisory_lock(hashtextextended($1,0))', [lockKey]);
      pending = save(waitingInput);
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like '%pg_advisory_lock%'");
        if (waiting.rowCount) {observed = true; break;}
        await delay(25);
      }
      assert.equal(observed, true, 'observe the actual blocked command before revoking');
      await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='reports.export'");
      await blocker.query('select pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
      assert.equal((await pending).status, 403, 'revocation during command wait must be honored');
    } finally {
      await blocker.query('select pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
      blocker.release();
      if (pending) await pending;
      await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='reports.export'");
    }
    await assert.rejects(pool.query('update project_contribution_evidence set reason=$1 where id=$2', ['Rewrite', saved.evidence.id]));
    await assert.rejects(pool.query('delete from project_contribution_evidence where id=$1', [saved.evidence.id]));
    const tamper = await pool.connect();
    try {
      for (const patch of [{artifact_sha256: '0'.repeat(64)}, {source_token: '0'.repeat(64)}, {worker_ids: [f.foreignOwnerId]}]) {
        await tamper.query('begin');
        const id = randomUUID();
        await tamper.query("select set_config('workos.project_contribution_context',$1,true)", [JSON.stringify({recordId: id,
          actorId: identities.manager.id, activeRole: 'Admin', organizationId: f.organizationId, legalEntityId: f.legalEntityId})]);
        await assert.rejects(tamper.query(`insert into project_contribution_evidence select (jsonb_populate_record(null::project_contribution_evidence,
          to_jsonb(e)||$2::jsonb)).* from project_contribution_evidence e where id=$1`,
        [saved.evidence.id, JSON.stringify({...patch, id, request_id: randomUUID()})]), error => error.code === 'PCE02');
        await tamper.query('rollback');
      }
    } finally {await tamper.query('rollback'); tamper.release();}
    const latest = await request(path + '/period?' + new URLSearchParams({startsOn: today, endsOn: today}));
    await pool.query(`create function synthetic_reject_project_audit() returns trigger language plpgsql as $$begin
      if new.entity_type='ProjectContributionEvidence' then raise exception 'Synthetic audit refusal'; end if; return new; end $$;
      create trigger synthetic_reject_project_audit before insert on audit_logs for each row execute function synthetic_reject_project_audit()`);
    assert.equal((await save({...input, requestId: randomUUID(), expectedSourceToken: latest.body.result.sourceToken})).status, 503);
    assert.equal((await pool.query('select count(*)::int n from project_contribution_evidence')).rows[0].n, 1, 'audit failure must roll back retention');
    assert.equal((await request(artifactPath)).status, 503, 'audit failure must not return artifact bytes');
    await pool.query('drop trigger synthetic_reject_project_audit on audit_logs; drop function synthetic_reject_project_audit()');
    // Later source changes cannot rewrite a retained artifact or an exact retry.
    await pool.query(`insert into working_calendar_holidays(id,organization_id,calendar_id,holiday_date,label,holiday_type,active,effective_from)
      values('synthetic-retention-holiday',$1,'synthetic-actual-calendar',$2,'Synthetic holiday','Company',true,'1970-01-01')`, [f.organizationId, today]);
    assert.equal((await save({...input, requestId: randomUUID()})).status, 409);
    assert.equal((await save(input)).body.csv, saved.csv);
    assert.equal((await request(artifactPath)).body.csv, saved.csv);
    const audit = await pool.query("select action from audit_logs where entity_type='ProjectContributionEvidence' and entity_id=$1", [saved.evidence.id]);
    assert.equal(audit.rows.filter(row => row.action === 'Retain Project Contribution Evidence').length, 1);
    assert.equal(audit.rows.filter(row => row.action === 'Retrieve Project Contribution Artifact').length, 2);
    const finalObservation = await request(path + '/period?' + new URLSearchParams({startsOn: today, endsOn: today}));
    for (let index = 0; index < 11; index++) assert.equal((await save({...input, requestId: randomUUID(), expectedSourceToken: finalObservation.body.result.sourceToken})).status, 201);
    const page = await request(historyPath);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.evidence.length, 10);
    assert.equal(page.body.nextBefore, page.body.evidence[9].id);
    const older = await request(historyPath + '&before=' + page.body.nextBefore);
    assert.equal(older.status, 200, JSON.stringify(older.body));
    assert.equal(older.body.evidence.length, 2);
    assert.equal(older.body.nextBefore, null);
    assert.equal(new Set([...page.body.evidence, ...older.body.evidence].map(row => row.id)).size, 12);
    assert.equal(older.body.evidence.at(-1).id, saved.evidence.id);
    assert.equal((await request(historyPath + '&before=' + randomUUID())).status, 404);
    assert.equal((await request(historyPath + '&limit=1000')).status, 400);
  });
});
console.log('Project report evidence: fresh/096 upgrade/replay, unchanged sources, real API retention, concurrent idempotency, strict input, source CAS, immutable artifact, current permission and audit checks passed.');
