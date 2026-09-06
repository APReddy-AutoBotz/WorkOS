import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const pg = requireFromTarget('pg');
const pool = new pg.Pool({ connectionString: databaseUrl });
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) {
    failures.push({ name, message: error?.message || String(error), stack: error?.stack });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
  }
};

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
  return `scrypt$${salt}$${key}`;
};

const port = 4328;
const origin = `http://127.0.0.1:${port}`;
const loginSecret = 'WOS-Reporting-Period-42!';
const adminId = '00000000-0000-0000-0000-000000000951';
const primaryScope = { 'x-organization-id': 'org-rp', 'x-legal-entity-id': 'legal-rp' };
const otherScope = { 'x-organization-id': 'org-rp', 'x-legal-entity-id': 'legal-rp-other' };

await pool.query(`insert into country_directors(id,name,region) values('cd-rp','Reporting Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values('org-rp','ORG-RP','Reporting Acceptance Org','2026-01-01') on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values
 ('legal-rp','org-rp','LEGAL-RP','Reporting Acceptance Legal','2026-01-01'),
 ('legal-rp-other','org-rp','LEGAL-RP-OTHER','Reporting Other Legal','2026-01-01')
 on conflict(id) do nothing`);
const adminHash = await hashPassword(loginSecret);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-rp','ADMIN-RP','Reporting Admin','reporting-admin@example.test','System Administrator','Administration','Synthetic','cd-rp','Active','org-rp','legal-rp')
 on conflict(id) do nothing`);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'reporting-admin','ADMIN-RP','admin-rp','reporting-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist after migrations');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminId, adminRole.id]);
for (const legalEntityId of ['legal-rp', 'legal-rp-other']) {
  await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
    values($1,'org-rp',$2,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminId, legalEntityId]);
}

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-reporting-period-acceptance-secret',
    API_PORT: String(port),
    PORT: String(port),
    APP_MODE: 'test',
    ALLOW_TEST_FALLBACK: 'false',
    LOCAL_LOGIN_ENABLED: 'true',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { serverLog += chunk; process.stderr.write(chunk); });

const waitReady = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready: ${serverLog}`);
};
await waitReady();

const call = async (method, route, { token, body, scope = primaryScope } = {}) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...scope,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};

const periodBody = (code, startsOn, endsOn, status, name = code, frequency = 'Weekly') => ({ code, name, frequency, startsOn, endsOn, status });
const employeeBody = (code, name = code) => ({
  employee_id: code,
  name,
  email: `${code.toLowerCase()}@example.test`,
  designation: 'Engineer',
  department: 'Delivery',
  country: 'Synthetic',
  primary_country_director_id: 'cd-rp',
  mapped_country_director_ids: [],
  roles: ['Employee'],
  initial_password: `${code}-Credential-42!`,
  joining_date: '2026-01-01',
  status: 'Active',
});
const timesheetBody = (employeeId, weekEnding, status = 'Draft', hours = 8) => ({
  employee_id: employeeId,
  week_ending: weekEnding,
  status,
  entries: [{ work_type: 'Client Misc Task', client_name: 'Synthetic Client', work_date: weekEnding, hours, remark: 'Reporting-period acceptance', billable: false }],
});
const snapshot = async (employeeId, weekEnding) => {
  const timesheet = (await pool.query(`select * from timesheets where organization_id='org-rp' and legal_entity_id='legal-rp' and employee_id=$1 and week_ending=$2`, [employeeId, weekEnding])).rows[0] || null;
  const entries = timesheet ? (await pool.query(`select project_id,work_type,client_name,work_date,hours,remark,billable from timesheet_entries where timesheet_id=$1 order by id`, [timesheet.id])).rows : [];
  return { timesheet, entries };
};
const expectPeriodBlock = async (routeCall, employeeId, weekEnding, code = 'REPORTING_PERIOD_CLOSED') => {
  const before = await snapshot(employeeId, weekEnding);
  const response = await routeCall();
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, code, JSON.stringify(response.body));
  const after = await snapshot(employeeId, weekEnding);
  assert.deepEqual(after, before);
  return response;
};
const pendingApprovalFor = async (timesheetId) => (await pool.query(`select * from approval_records where entity_type='Timesheet' and entity_id=$1 and status='Pending' order by created_at desc limit 1`, [String(timesheetId)])).rows[0];

let adminToken = '';
try {
  await check('synthetic admin login resolves exact reporting-period acceptance identity', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'reporting-admin', password: loginSecret, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    adminToken = response.body.token;
    assert.ok(adminToken);
  });

  await check('Open period authoring is scoped, transactional and audited with actor/new evidence', async () => {
    const response = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', 'Open') });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.legal_entity_id, 'legal-rp');
    const audit = (await pool.query(`select * from audit_logs where module='Organization Setup' and entity_type='Reporting Period' and entity_id=$1 order by created_at desc limit 1`, [response.body.id])).rows[0];
    assert.ok(audit);
    assert.equal(audit.user_id, adminId);
    assert.equal(audit.active_role, 'Admin');
    assert.equal(audit.new_value.status, 'Open');
    assert.equal(audit.old_value, null);
  });

  await check('concurrent same-scope overlapping period authoring serializes to one commit and one rejection', async () => {
    const beforeAudit = Number((await pool.query(`select count(*)::int count from audit_logs where module='Organization Setup' and entity_type='Reporting Period'`)).rows[0].count);
    const [a, b] = await Promise.all([
      call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-RACE-A', '2026-06-22', '2026-06-28', 'Open') }),
      call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-RACE-B', '2026-06-22', '2026-06-28', 'Open') }),
    ]);
    assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [201, 409], `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    const rows = Number((await pool.query(`select count(*)::int count from reporting_periods where organization_id='org-rp' and legal_entity_id='legal-rp' and starts_on='2026-06-22' and ends_on='2026-06-28'`)).rows[0].count);
    assert.equal(rows, 1);
    const afterAudit = Number((await pool.query(`select count(*)::int count from audit_logs where module='Organization Setup' and entity_type='Reporting Period'`)).rows[0].count);
    assert.equal(afterAudit, beforeAudit + 1);
  });

  await check('cross-legal reporting periods are isolated and same dates are allowed in the other legal entity', async () => {
    const created = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, scope: otherScope, body: periodBody('RP-OPEN-OTHER', '2026-08-24', '2026-08-30', 'Open') });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const primary = await call('GET', '/api/organization-setup/reporting-periods', { token: adminToken });
    assert.equal(primary.status, 200, JSON.stringify(primary.body));
    assert.ok(primary.body.some(period => period.code === 'RP-OPEN'));
    assert.ok(!primary.body.some(period => period.code === 'RP-OPEN-OTHER'));
    const foreign = await call('GET', '/api/organization-setup/reporting-periods', { token: adminToken, scope: otherScope });
    assert.ok(foreign.body.some(period => period.code === 'RP-OPEN-OTHER'));
  });

  const workers = {};
  for (const code of ['E-RP-A','E-RP-B','E-RP-C','E-RP-D','E-RP-E','E-RP-F']) {
    const response = await call('POST', '/api/employees', { token: adminToken, body: employeeBody(code) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    workers[code] = response.body.id;
  }

  await check('Open allows canonical content save and import', async () => {
    const save = await call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-A'], '2026-08-30', 'Draft') });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const imported = await call('POST', '/api/imports/timesheets/apply', { token: adminToken, body: { fileName: 'rp-open.csv', rows: [{ employeeId: 'E-RP-B', weekEnding: '2026-08-30', workType: 'Client Misc Task', clientName: 'Synthetic Client', date: '2026-08-30', hours: 8, billable: false, status: 'Draft' }] } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.status, 'Success', JSON.stringify(imported.body));
  });

  let openGenericTimesheetId;
  let openGenericApprovalId;
  await check('Open allows generic approval decision on a submitted timesheet', async () => {
    const submitted = await call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-A'], '2026-08-30', 'Submitted', 7) });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    openGenericTimesheetId = submitted.body.id;
    const approval = await pendingApprovalFor(openGenericTimesheetId);
    assert.ok(approval);
    openGenericApprovalId = approval.id;
    const decision = await call('PATCH', `/api/approvals/${approval.id}/status`, { token: adminToken, body: { status: 'Approved', comments: 'Open-period approval' } });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    assert.equal((await pool.query(`select status from timesheets where id=$1`, [openGenericTimesheetId])).rows[0].status, 'Approved');
  });

  let submissionTimesheetId;
  await check('prepare multiple already-submitted timesheets while period is Open', async () => {
    for (const code of ['E-RP-C','E-RP-E','E-RP-F']) {
      const submitted = await call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers[code], '2026-08-30', 'Submitted', 6) });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      if (code === 'E-RP-C') submissionTimesheetId = submitted.body.id;
    }
  });

  await check('Open transitions to Submission Closed with audited old/new state and immutable closed boundaries', async () => {
    const response = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', 'Submission Closed') });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const audit = (await pool.query(`select * from audit_logs where module='Organization Setup' and entity_type='Reporting Period' and entity_id=$1 order by created_at desc limit 1`, [response.body.id])).rows[0];
    assert.equal(audit.old_value.status, 'Open');
    assert.equal(audit.new_value.status, 'Submission Closed');
    const immutable = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', 'Submission Closed', 'Renamed Closed Period') });
    assert.equal(immutable.status, 409, JSON.stringify(immutable.body));
    assert.equal(immutable.body.code, 'REPORTING_PERIOD_IMMUTABLE');
  });

  await check('Submission Closed blocks content save/import with no write but permits decision on already-submitted work', async () => {
    await expectPeriodBlock(() => call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-D'], '2026-08-30', 'Draft') }), workers['E-RP-D'], '2026-08-30');
    const beforeImport = await snapshot(workers['E-RP-D'], '2026-08-30');
    const imported = await call('POST', '/api/imports/timesheets/apply', { token: adminToken, body: { fileName: 'rp-submission-closed.csv', rows: [{ employeeId: 'E-RP-D', weekEnding: '2026-08-30', workType: 'Client Misc Task', clientName: 'Synthetic Client', date: '2026-08-30', hours: 8, billable: false, status: 'Draft' }] } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.status, 'Failed', JSON.stringify(imported.body));
    assert.equal(imported.body.validRows, 0, JSON.stringify(imported.body));
    assert.ok(imported.body.errors.some(error => error.code === 'REPORTING_PERIOD_CLOSED'), JSON.stringify(imported.body));
    assert.deepEqual(await snapshot(workers['E-RP-D'], '2026-08-30'), beforeImport);
    const decision = await call('PATCH', `/api/timesheets/${submissionTimesheetId}/status`, { token: adminToken, body: { status: 'Approved' } });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
  });

  await check('Approval Closed blocks direct and generic decisions with no linked-state mutation', async () => {
    const transition = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', 'Approval Closed') });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    const eTimesheet = (await pool.query(`select * from timesheets where employee_id=$1 and week_ending='2026-08-30'`, [workers['E-RP-E']])).rows[0];
    const eBefore = await snapshot(workers['E-RP-E'], '2026-08-30');
    const direct = await call('PATCH', `/api/timesheets/${eTimesheet.id}/status`, { token: adminToken, body: { status: 'Approved' } });
    assert.equal(direct.status, 409, JSON.stringify(direct.body));
    assert.equal(direct.body.code, 'REPORTING_PERIOD_CLOSED');
    assert.deepEqual(await snapshot(workers['E-RP-E'], '2026-08-30'), eBefore);
    const fTimesheet = (await pool.query(`select * from timesheets where employee_id=$1 and week_ending='2026-08-30'`, [workers['E-RP-F']])).rows[0];
    const approval = await pendingApprovalFor(fTimesheet.id);
    assert.ok(approval);
    const generic = await call('PATCH', `/api/approvals/${approval.id}/status`, { token: adminToken, body: { status: 'Approved', comments: 'must remain blocked' } });
    assert.equal(generic.status, 409, JSON.stringify(generic.body));
    assert.equal(generic.body.code, 'REPORTING_PERIOD_CLOSED');
    assert.equal((await pool.query(`select status from timesheets where id=$1`, [fTimesheet.id])).rows[0].status, 'Submitted');
    assert.equal((await pool.query(`select status from approval_records where id=$1`, [approval.id])).rows[0].status, 'Pending');
  });

  await check('Financially Locked and Closed block all governed content and decision paths', async () => {
    for (const state of ['Financially Locked', 'Closed']) {
      const transition = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', state) });
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
      await expectPeriodBlock(() => call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-D'], '2026-08-30', 'Draft') }), workers['E-RP-D'], '2026-08-30');
      const eTimesheet = (await pool.query(`select * from timesheets where employee_id=$1 and week_ending='2026-08-30'`, [workers['E-RP-E']])).rows[0];
      const direct = await call('PATCH', `/api/timesheets/${eTimesheet.id}/status`, { token: adminToken, body: { status: 'Approved' } });
      assert.equal(direct.status, 409, JSON.stringify(direct.body));
      assert.equal(direct.body.code, 'REPORTING_PERIOD_CLOSED');
    }
    const reopen = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OPEN', '2026-08-24', '2026-08-30', 'Open') });
    assert.equal(reopen.status, 409, JSON.stringify(reopen.body));
    assert.equal(reopen.body.code, 'REPORTING_PERIOD_TRANSITION_CONFLICT');
  });

  await check('Planned is not operationally Open and missing authority fails closed without writes', async () => {
    const planned = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-PLANNED', '2026-08-17', '2026-08-23', 'Planned') });
    assert.equal(planned.status, 201, JSON.stringify(planned.body));
    await expectPeriodBlock(() => call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-D'], '2026-08-23', 'Draft') }), workers['E-RP-D'], '2026-08-23');
    await expectPeriodBlock(() => call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-D'], '2026-08-16', 'Draft') }), workers['E-RP-D'], '2026-08-16', 'REPORTING_PERIOD_MISSING');
  });

  await check('ambiguous persisted authority fails closed and database overlap protection can be restored', async () => {
    await pool.query(`alter table reporting_periods drop constraint reporting_period_frequency_ranges_no_overlap`);
    await pool.query(`insert into reporting_periods(organization_id,legal_entity_id,code,name,frequency,starts_on,ends_on,status) values
      ('org-rp','legal-rp','RP-AMB-A','Ambiguous A','Weekly','2026-08-03','2026-08-09','Open'),
      ('org-rp','legal-rp','RP-AMB-B','Ambiguous B','Weekly','2026-08-03','2026-08-09','Open')`);
    await expectPeriodBlock(() => call('POST', '/api/timesheets', { token: adminToken, body: timesheetBody(workers['E-RP-D'], '2026-08-09', 'Draft') }), workers['E-RP-D'], '2026-08-09', 'REPORTING_PERIOD_AMBIGUOUS');
    await pool.query(`delete from reporting_periods where code='RP-AMB-B' and organization_id='org-rp' and legal_entity_id='legal-rp'`);
    await pool.query(`alter table reporting_periods add constraint reporting_period_frequency_ranges_no_overlap exclude using gist
      (organization_id with =, legal_entity_id with =, frequency with =, daterange(starts_on,ends_on + 1,'[)') with &&)`);
  });

  await check('invalid/overlapping authoring rolls back period and audit state atomically', async () => {
    const beforePeriod = Number((await pool.query(`select count(*)::int count from reporting_periods`)).rows[0].count);
    const beforeAudit = Number((await pool.query(`select count(*)::int count from audit_logs where module='Organization Setup' and entity_type='Reporting Period'`)).rows[0].count);
    const invalid = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-BAD', '2026-09-01', '2026-08-31', 'Open') });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    const overlap = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody('RP-OVERLAP', '2026-08-24', '2026-08-30', 'Open') });
    assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
    assert.equal(Number((await pool.query(`select count(*)::int count from reporting_periods`)).rows[0].count), beforePeriod);
    assert.equal(Number((await pool.query(`select count(*)::int count from audit_logs where module='Organization Setup' and entity_type='Reporting Period'`)).rows[0].count), beforeAudit);
  });

  await check('generic approval cannot decide a linked timesheet from another legal entity', async () => {
    const worker = await call('POST', '/api/employees', { token: adminToken, scope: otherScope, body: employeeBody('E-RP-OTHER', 'Reporting Other Worker') });
    assert.equal(worker.status, 200, JSON.stringify(worker.body));
    const submitted = await call('POST', '/api/timesheets', { token: adminToken, scope: otherScope, body: timesheetBody(worker.body.id, '2026-08-30', 'Submitted') });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const approval = await pendingApprovalFor(submitted.body.id);
    assert.ok(approval);
    const decision = await call('PATCH', `/api/approvals/${approval.id}/status`, { token: adminToken, body: { status: 'Approved', comments: 'cross-scope denial' } });
    assert.ok(decision.status >= 400 && decision.status < 500, JSON.stringify(decision.body));
    assert.equal((await pool.query(`select status from timesheets where id=$1`, [submitted.body.id])).rows[0].status, 'Submitted');
    assert.equal((await pool.query(`select status from approval_records where id=$1`, [approval.id])).rows[0].status, 'Pending');
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve)).catch(() => {});
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', checks: 'reporting-period authority/audit matrix' }));
