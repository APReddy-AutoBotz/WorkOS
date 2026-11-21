import assert from 'node:assert/strict';
import {appendFile, readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {runMigrations} from '../server/migrate.mjs';
import {
  commercialFixture, migrateCommercialDatabase, seedCommercialIdentities, seedCommercialReferences,
  withCommercialApi, withCommercialDatabase, withCommercialMigrationsThrough,
} from './support/commercial-drafting-test.mjs';

async function seedCommercialLines(request) {
  async function create(path, body) {
    const result = await request(path, {method: 'POST', body});
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  const terms = {startsOn: '2024-01-01', endsOn: '2024-12-31', currency: 'USD',
    model: 'milestone', clientId: commercialFixture.clientId, reason: 'Synthetic scale fixture'};
  const contract = await create('/contracts', {...terms, number: 'PROFILE-CONTRACT', name: 'Synthetic delivery',
    effectiveFrom: terms.startsOn, value: '50000', billingTerms: 'Synthetic terms', documents: []});
  const engagement = await create('/engagements', {...terms, code: 'PROFILE-ENGAGEMENT', name: 'Synthetic engagement',
    attributionId: null, ownerId: commercialFixture.ownerId, contractId: contract.id, contractVersionId: contract.versions[0].id, budget: '50000'});
  for (let i = 1; i <= 50; i++) {
    await create('/milestones', {engagementId: engagement.id, code: 'PROFILE-M-' + i, name: 'Synthetic milestone ' + i,
      dueOn: '2024-06-30', amount: '1000', currency: 'USD', reason: 'Synthetic scale fixture'});
  }
}

await withCommercialDatabase(async database => {
  const {pool} = database;
  // Import historical work into its original schema, then exercise the upgraded installation.
  await withCommercialMigrationsThrough(43, async rootDir => {
    await runMigrations({pool, rootDir, logger: {log() {}}});
    await seedCommercialReferences(pool);
    await pool.query(await readFile(new URL('./support/standard-profile.sql', import.meta.url), 'utf8'));
  });
  await migrateCommercialDatabase(pool);
  const identities = await seedCommercialIdentities(pool);
  const {rows: accounts} = await pool.query(`select u.id,u.username,e.id as worker,r.name as role
    from users u join employees e on e.id=u.employee_record_id join user_roles ur on ur.user_id=u.id
    join roles r on r.id=ur.role_id where u.username like 'PROFILE-%' order by substring(u.username from 9)::int`);
  assert.equal(accounts.length, 250);
  const {rows: [volume]} = await pool.query(`select count(distinct t.id)::int sheets, count(*)::int entries
    from timesheets t join timesheet_entries e on e.timesheet_id=t.id where t.employee_id like 'profile-worker-%'`);
  assert.deepEqual(volume, {sheets: 2000, entries: 10000});

  await withCommercialApi({...database, identities}, async ({request, tokenFor}) => {
    await seedCommercialLines(request);
    await pool.query('analyze');
    const header = await pool.query("select id from timesheets where employee_id='profile-worker-1' limit 1");
    const plan = await pool.query('explain (analyze, buffers, format json) select work_date,hours from timesheet_entries where timesheet_id=$1 order by work_date', [header.rows[0].id]);
    assert.ok(JSON.stringify(plan.rows[0]).includes('timesheet_entries_header_date_idx'), 'Header lookup must use the indexed path on Standard-profile data');
    const sessions = accounts.slice(0,90).map(account => ({
      ...account, headers: {Authorization: 'Bearer ' + tokenFor(account)},
    }));
    const samples = {};
    const thresholds = {};
    const receipts = new Map();
    const reviewed = new Map();
    const states = {save: 'Draft', submit: 'Submitted', review: 'Submitted', approve: 'Approved'};
    const reviewers = sessions.slice(75);
    for (const [phase, status] of Object.entries(states)) {
      const readKey = 'read during ' + phase;
      const reportKey = 'report during ' + phase;
      samples[phase] = [];
      samples[readKey] = [];
      samples[reportKey] = [];
      thresholds[phase] = phase === 'review' ? 2000 : 3000;
      thresholds[readKey] = 2000;
      thresholds[reportKey] = 5000;
      for (let round = 0; round < 6; round++) {
        const week = new Date(Date.UTC(2024, 2, 3 + round * 7)).toISOString().slice(0,10);
        await Promise.all(sessions.slice(0,75).map(async (employee, index) => {
          const decision = phase === 'approve' && index >= 5 && index < 20;
          const actor = (decision || (phase === 'review' && index >= 5 && index < 20)) ? reviewers[index - 5] : employee;
          const worker = employee.worker;
          const options = {authenticated: false, headers: actor.headers};
          const start = performance.now();
          if (index < 5) {
            const result = await request('/api/reports/planned-utilization?date=2024-02-01', options);
            samples[reportKey].push(performance.now() - start);
            assert.equal(result.status, 200);
            const workers = result.body.rows.filter(row => row.id.startsWith('profile-worker-'));
            assert.equal(workers.length, 250);
            assert.ok(workers.every(row => Number(row.planned_utilization) === 100));
            assert.ok(result.body.rows.every(row => row.id !== commercialFixture.otherOwnerId && row.id !== commercialFixture.foreignOwnerId));
          } else if (index >= 20) {
            const result = await request('/api/timesheets', options);
            samples[readKey].push(performance.now() - start);
            assert.equal(result.status, 200);
            assert.equal(result.body.length, 8);
            assert.ok(result.body.every(sheet => sheet.employee_id === worker && sheet.entries.length === 5));
          } else if (phase === 'review') {
            const result = await request('/api/timesheets?view=direct-report-review', options);
            samples.review.push(performance.now() - start);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.length, 14);
            assert.ok(result.body.every(row => row.employee_id === worker && row.status !== 'Draft'));
            const sheet = result.body.find(row => row.week_ending === week);
            assert.equal(sheet.status, 'Submitted');
            assert.match(sheet.write_token, /^[a-f0-9]{64}$/);
            reviewed.set(sheet.id, sheet.write_token);
          } else {
            const key = worker + '/' + week;
            const draft = receipts.get(key);
            const result = decision
              ? await request('/api/timesheets/' + draft.id + '/status', {...options, method: 'PATCH', body: {status, expected_write_token: reviewed.get(draft.id)}})
              : await request('/api/timesheets', {...options, method: 'POST', body: {
                employee_id: worker, week_ending: week, status, expected_write_token: draft?.write_token ?? null,
                entries: [{work_type: 'Client Misc Task', client_name: 'Synthetic client', work_date: week,
                  hours: '1', remark: 'Synthetic work', billable: false}],
              }});
            samples[phase].push(performance.now() - start);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.status, status);
            assert.equal(result.body.employee_id, worker);
            if (phase === 'save') receipts.set(key, result.body);
            else assert.equal(result.body.id, draft.id);
            if (decision) assert.equal(result.body.approved_by, actor.username);
          }
        }));
      }
      const persisted = await pool.query(`select count(*)::int sheets, sum(total_hours)::int hours
        from timesheets where status=$1 and id=any($2::uuid[])`, [status, [...receipts.values()].map(row => row.id)]);
      assert.deepEqual(persisted.rows[0], {sheets: 90, hours: 90});
      if (phase === 'save') {
        const leadView = await request('/api/timesheets?view=direct-report-review', {authenticated:false, headers:reviewers[0].headers});
        assert.equal(leadView.status, 200);
        assert.equal(leadView.body.length, 8);
        assert.ok(leadView.body.every(sheet => sheet.employee_id === sessions[5].worker && sheet.status === 'Approved'));
      }
      if (phase === 'review') assert.equal(reviewed.size, 90);
      if (phase === 'submit') {
        const deniedList = await request('/api/timesheets?view=direct-report-review', {authenticated:false,headers:sessions[5].headers});
        assert.equal(deniedList.status, 403);
        const personalList = await request('/api/timesheets', {authenticated:false,headers:reviewers[0].headers});
        assert.equal(personalList.status, 200);
        assert.equal(personalList.body.length, 8);
        assert.ok(personalList.body.every(sheet => sheet.employee_id === reviewers[0].worker));
        const submitted = receipts.get('profile-worker-6/2024-03-03');
        const denied = await request('/api/timesheets/' + submitted.id + '/status', {
          authenticated: false, headers: reviewers[1].headers, method: 'PATCH', body: {status: 'Approved'},
        });
        assert.equal(denied.status, 403, 'A different team lead cannot approve this employee’s work');
      }
    }
    await pool.query("update role_permissions set enabled=false where role_name='TeamLead' and permission_key='timesheets.approve'");
    const revoked = await request('/api/timesheets?view=direct-report-review', {authenticated:false, headers:reviewers[0].headers});
    assert.equal(revoked.status, 403);
    const evidence = await pool.query(`select count(distinct t.id)::int sheets, count(*)::int decisions
      from timesheets t join work_submission_evidence w on w.timesheet_id=t.id
      join work_submission_decisions d on d.submission_id=w.id
      join users author on author.id=w.actor_id and author.employee_record_id=t.employee_id
      join employees e on e.id=t.employee_id
      join users reviewer on reviewer.id=d.actor_id and reviewer.employee_record_id=e.reporting_manager_id
      where t.id=any($1::uuid[]) and d.status='Approved' and d.actor_id<>w.actor_id and d.active_role='TeamLead'`,
    [[...receipts.values()].map(row => row.id)]);
    assert.deepEqual(evidence.rows[0], {sheets: 90, decisions: 90});
    const report = ['## Standard-profile API performance', '',
      '250 synthetic accounts, 75 concurrent sessions, 25 clients, 50 projects, 250 assignments, 10,000 work entries, 2,000 submission audit rows and 50 commercial milestones.', '',
      '| Operation | Samples | p95 (ms) | Max (ms) | Target (ms) |', '|---|---:|---:|---:|---:|'];
    const violations = [];
    for (const [operation, durations] of Object.entries(samples)) {
      durations.sort((a,b) => a-b);
      const p95 = durations[Math.ceil(durations.length * 0.95)-1];
      const maximum = durations.at(-1);
      report.push(`| ${operation} | ${durations.length} | ${Math.ceil(p95)} | ${Math.ceil(maximum)} | ${thresholds[operation]} |`);
      if ((operation.startsWith('report during ') ? maximum : p95) > thresholds[operation]) violations.push(operation);
    }
    const markdown = report.join('\n') + '\n';
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
    assert.deepEqual(violations, [], 'Standard-profile response targets exceeded');
  });
});
