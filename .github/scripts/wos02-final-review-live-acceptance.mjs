import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

const today = new Date().toISOString().slice(0, 10);
const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const adminId = '00000000-0000-0000-0000-000000000701';
const otherUserId = '00000000-0000-0000-0000-000000000702';
const otherTimesheetId = '00000000-0000-0000-0000-000000000730';
const password = 'WOS-Final-Closure-42!';
const scopeA = { 'x-organization-id': 'org-final', 'x-legal-entity-id': 'legal-a' };
const scopeB = { 'x-organization-id': 'org-final', 'x-legal-entity-id': 'legal-b' };
const scopeFuture = { 'x-organization-id': 'org-final', 'x-legal-entity-id': 'legal-future' };
const scopeExpired = { 'x-organization-id': 'org-final', 'x-legal-entity-id': 'legal-expired' };

await pool.query(`insert into country_directors(id,name,region) values('cd-final','Final Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values
 ('org-final','ORG-FINAL','Final Org','2026-01-01'),
 ('org-other','ORG-OTHER','Other Org','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from,effective_to) values
 ('legal-a','org-final','LEGAL-A','Legal A','2026-01-01',null),
 ('legal-b','org-final','LEGAL-B','Legal B','2026-01-01',null),
 ('legal-future','org-final','LEGAL-FUT','Future Legal','2099-01-01',null),
 ('legal-expired','org-final','LEGAL-EXP','Expired Legal','2025-01-01','2025-12-31'),
 ('legal-other','org-other','LEGAL-O','Other Legal','2026-01-01',null)
 on conflict(id) do nothing`);

const adminHash = await hashPassword(password);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-final','ADMIN-FINAL','Final Admin','final-admin@example.test','System Administrator','Administration','Synthetic','cd-final','Active','org-final','legal-a')
 on conflict(id) do nothing`);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'final-admin','ADMIN-FINAL','admin-final','final-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist after migrations');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminId, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values
 ($1,'org-final','legal-a',true),
 ($1,'org-final','legal-b',true),
 ($1,'org-final','legal-future',true),
 ($1,'org-final','legal-expired',true)
 on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminId]);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-final-acceptance-secret',
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

const call = async (method, route, { token, scope, body } = {}) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(scope || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};

let adminToken = '';
try {
  await check('local synthetic admin login binds exact employee record identity', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'final-admin', password, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.employeeRecordId, 'admin-final');
    adminToken = response.body.token;
    assert.ok(adminToken);
  });

  await check('multi-scope discovery excludes future and expired legal entities and enforces explicit selection', async () => {
    const scopes = await call('GET', '/api/auth/organization-scopes', { token: adminToken });
    assert.equal(scopes.status, 200, JSON.stringify(scopes.body));
    const keys = scopes.body.map(row => `${row.organizationId}:${row.legalEntityId}`).sort();
    assert.deepEqual(keys, ['org-final:legal-a', 'org-final:legal-b']);
    const ambiguous = await call('GET', '/api/auth/me', { token: adminToken });
    assert.equal(ambiguous.status, 403);
    assert.equal((await call('GET', '/api/auth/me', { token: adminToken, scope: scopeA })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: adminToken, scope: scopeFuture })).status, 403);
    assert.equal((await call('GET', '/api/auth/me', { token: adminToken, scope: scopeExpired })).status, 403);
  });

  await check('canonical employee create/upsert propagates ownership and provisions user scope atomically', async () => {
    const body = {
      employee_id: 'E-SCOPED',
      name: 'Scoped Employee',
      email: 'scoped@example.test',
      designation: 'Engineer',
      department: 'Delivery',
      country: 'Synthetic',
      primary_country_director_id: 'cd-final',
      mapped_country_director_ids: [],
      roles: ['Employee'],
      initial_password: 'Scoped-User-42!',
      status: 'Active',
    };
    const first = await call('POST', '/api/employees', { token: adminToken, scope: scopeA, body });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await call('POST', '/api/employees', { token: adminToken, scope: scopeA, body: { ...body, name: 'Scoped Employee Updated', initial_password: undefined } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const employees = (await pool.query(`select id,organization_id,legal_entity_id,name from employees where organization_id='org-final' and employee_id='E-SCOPED'`)).rows;
    assert.equal(employees.length, 1);
    assert.equal(employees[0].organization_id, 'org-final');
    assert.equal(employees[0].legal_entity_id, 'legal-a');
    assert.equal(employees[0].name, 'Scoped Employee Updated');
    const user = (await pool.query(`select id,employee_record_id from users where employee_record_id=$1`, [employees[0].id])).rows[0];
    assert.ok(user);
    const scope = (await pool.query(`select count(*)::int count from user_organization_scopes where user_id=$1 and organization_id='org-final' and legal_entity_id='legal-a' and active`, [user.id])).rows[0];
    assert.equal(scope.count, 1);
  });

  await check('duplicate employee codes across organizations retain unambiguous record identity and employee-code login fails closed', async () => {
    const otherHash = await hashPassword(password);
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('other-e','E-SCOPED','Other Scoped','other-scoped@example.test','Engineer','Delivery','Synthetic','cd-final','Active','org-other','legal-other')`);
    await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
      values($1,'other-user','E-SCOPED','other-e','other-user@example.test',$2,'Active')`, [otherUserId, otherHash]);
    const employeeRole = (await pool.query(`select id from roles where name='Employee' limit 1`)).rows[0];
    await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [otherUserId, employeeRole.id]);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,'org-other','legal-other',true)`, [otherUserId]);
    const named = await call('POST', '/api/auth/login', { body: { username: 'other-user', password } });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.equal(named.body.employeeRecordId, 'other-e');
    const ambiguous = await call('POST', '/api/auth/login', { body: { username: 'E-SCOPED', password } });
    assert.equal(ambiguous.status, 401, `ambiguous employee-code login authenticated as ${JSON.stringify(ambiguous.body)}`);
  });

  await check('protected employee reads and mutations are organization/legal scoped', async () => {
    const inA = await call('GET', '/api/employees', { token: adminToken, scope: scopeA });
    assert.equal(inA.status, 200);
    assert.equal(inA.body.some(row => row.id === 'other-e'), false);
    const inB = await call('GET', '/api/employees', { token: adminToken, scope: scopeB });
    assert.equal(inB.status, 200);
    assert.equal(inB.body.some(row => row.employee_id === 'E-SCOPED'), false);
    const deniedMutation = await call('DELETE', '/api/employees/other-e', { token: adminToken, scope: scopeA, body: { reason: 'cross-scope negative' } });
    assert.ok([403, 404].includes(deniedMutation.status), JSON.stringify(deniedMutation.body));
    assert.equal((await pool.query(`select status from employees where id='other-e'`)).rows[0].status, 'Active');
  });

  let workerTypeId;
  await check('governed setup authoring and current-effective readiness use persisted server facts', async () => {
    const workerType = await call('POST', '/api/organization-setup/catalogs/worker_type', { token: adminToken, scope: scopeA, body: { code: 'WT-FINAL', name: 'Final Worker', effectiveFrom: '2026-01-01' } });
    assert.equal(workerType.status, 201, JSON.stringify(workerType.body));
    workerTypeId = workerType.body.id;
    const futureCalendar = await call('POST', '/api/organization-setup/calendars', { token: adminToken, scope: scopeA, body: { code: 'CAL-FUTURE', name: 'Future Calendar', timezone: 'UTC', workingDays: [1,2,3,4,5], hoursPerDay: 8, applicability: { type: 'legal_entity' }, effectiveFrom: '2099-01-01' } });
    assert.equal(futureCalendar.status, 201, JSON.stringify(futureCalendar.body));
    const oldPeriod = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, scope: scopeA, body: { code: 'PERIOD-OLD', name: 'Old Period', frequency: 'Weekly', startsOn: '2025-01-01', endsOn: '2025-12-31', status: 'Closed' } });
    assert.equal(oldPeriod.status, 201, JSON.stringify(oldPeriod.body));
    const before = await call('GET', '/api/organization-setup/readiness?ready=true', { token: adminToken, scope: scopeA });
    assert.equal(before.status, 200);
    assert.equal(before.body.ready, false);
    assert.equal(before.body.authority, 'persisted-server-state');
    const calendar = await call('POST', '/api/organization-setup/calendars', { token: adminToken, scope: scopeA, body: { code: 'CAL-CURRENT', name: 'Current Calendar', timezone: 'UTC', workingDays: [1,2,3,4,5], hoursPerDay: 8, applicability: { type: 'legal_entity' }, effectiveFrom: '2026-01-01' } });
    assert.equal(calendar.status, 201, JSON.stringify(calendar.body));
    for (const frequency of ['Weekly', 'Monthly', 'Fiscal']) {
      const period = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, scope: scopeA, body: { code: `PERIOD-CURRENT-${frequency.toUpperCase()}`, name: `Current ${frequency} Period`, frequency, startsOn: today, endsOn: today, status: 'Open' } });
      assert.equal(period.status, 201, `${frequency} ${JSON.stringify(period.body)}`);
    }
    const after = await call('GET', '/api/organization-setup/readiness', { token: adminToken, scope: scopeA });
    assert.equal(after.status, 200);
    assert.equal(after.body.checks.organization, true, JSON.stringify(after.body));
    assert.equal(after.body.checks.legal_entity, true, JSON.stringify(after.body));
    assert.equal(after.body.checks.worker_type, true, JSON.stringify(after.body));
    assert.equal(after.body.checks.calendars, true, JSON.stringify(after.body));
    assert.equal(after.body.checks.reporting_period, true, JSON.stringify(after.body));
    assert.equal(after.body.identity, undefined);
    assert.equal(after.body.ready, false, JSON.stringify(after.body));
    assert.equal(after.body.authority, 'persisted-server-state');
    assert.equal(after.body.checks.production_readiness, false, JSON.stringify(after.body));
  });

  await check('terminology is effective-dated at API and consumed by runtime frontend', async () => {
    const current = await call('POST', '/api/organization-setup/terminology', { token: adminToken, scope: scopeA, body: { terms: { employee: 'Colleague', project: 'Engagement' }, effectiveFrom: '2026-01-01' } });
    assert.equal(current.status, 201, JSON.stringify(current.body));
    const future = await call('POST', '/api/organization-setup/terminology', { token: adminToken, scope: scopeA, body: { terms: { employee: 'Future Colleague' }, effectiveFrom: '2099-01-01' } });
    assert.equal(future.status, 201, JSON.stringify(future.body));
    const resolved = await call('GET', '/api/organization-setup/terminology', { token: adminToken, scope: scopeA });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.terms.employee, 'Colleague');
    const frontendFiles = ['src/App.tsx','src/config/RuntimeTerminology.tsx','src/config/productConfig.ts','src/services/apiClient.ts'];
    const runtimeText = frontendFiles.map(file => readFileSync(path.join(targetRoot, file), 'utf8')).join('\n');
    assert.match(runtimeText, /organization-setup\/terminology/);
    assert.match(runtimeText, /applyPersistedTerminology/);
    assert.match(runtimeText, /workos:organization-scope-changed/);
  });

  await check('working-calendar non-overlap is independently enforced by database', async () => {
    await pool.query(`insert into working_calendars(organization_id,legal_entity_id,applicability_type,code,name,timezone,working_days,hours_per_day,effective_from,effective_to)
      values('org-final','legal-a','legal_entity','CAL-OVERLAP','Overlap Baseline','UTC',array[1,2,3,4,5],8,'2026-01-01','2026-12-31')`);
    await assert.rejects(
      () => pool.query(`insert into working_calendars(organization_id,legal_entity_id,applicability_type,code,name,timezone,working_days,hours_per_day,effective_from,effective_to)
        values('org-final','legal-a','legal_entity','CAL-OVERLAP','Overlap Conflict','UTC',array[1,2,3,4,5],8,'2026-06-01','2026-09-30')`),
      error => error?.code === '23P01',
    );
  });

  const scopedEmployee = (await pool.query(`select id from employees where organization_id='org-final' and employee_id='E-SCOPED'`)).rows[0].id;
  await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,worker_type_id,lifecycle_status,effective_from)
    values($1,'org-final','legal-a',$2,'Active','2026-01-01')
    on conflict(employee_id) do update set worker_type_id=excluded.worker_type_id,organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id,lifecycle_status='Active',effective_from='2026-01-01'`, [scopedEmployee, workerTypeId]);
  await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)
    values($1,'org-final','legal-a','2026-01-01','Active','{"seed":true}'::jsonb) on conflict do nothing`, [scopedEmployee]);

  await check('future-dated worker transition fails closed without premature current-state mutation', async () => {
    const response = await call('POST', `/api/organization-setup/workers/${scopedEmployee}/transition`, { token: adminToken, scope: scopeA, body: { status: 'Exited', effectiveFrom: '2099-01-01', reason: 'future acceptance', idempotencyKey: 'future-transition-701' } });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'FUTURE_TRANSITION_UNSUPPORTED');
    const state = (await pool.query(`select e.status,wp.lifecycle_status from employees e join worker_profiles wp on wp.employee_id=e.id where e.id=$1`, [scopedEmployee])).rows[0];
    assert.equal(state.status, 'Active');
    assert.equal(state.lifecycle_status, 'Active');
  });

  await pool.query(`insert into clients(id,name,status,organization_id,legal_entity_id) values('client-final','Final Client','Active','org-final','legal-a') on conflict(id) do nothing`);
  await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,billable,start_date,end_date,status,organization_id,legal_entity_id)
    values('project-final','P-FINAL','Final Project','client-final','Final Client','admin-final','Final Admin',true,'2026-01-01','2026-12-31','Active','org-final','legal-a') on conflict(id) do nothing`);

  await check('canonical allocation import creates a scoped allocation', async () => {
    const response = await call('POST', '/api/imports/allocations/apply', { token: adminToken, scope: scopeA, body: { fileName: 'synthetic-allocation.csv', rows: [{ id: 'alloc-import-final', employeeId: scopedEmployee, projectId: 'project-final', percentage: 50, startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', billable: true }] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const row = (await pool.query(`select organization_id from project_allocations where id='alloc-import-final'`)).rows[0];
    assert.equal(row?.organization_id, 'org-final');
  });

  await check('cross-legal allocation import is denied with no write', async () => {
    const response = await call('POST', '/api/imports/allocations/apply', { token: adminToken, scope: scopeB, body: { fileName: 'cross-legal-allocation.csv', rows: [{ id: 'alloc-cross-legal', employeeId: scopedEmployee, projectId: 'project-final', percentage: 10, startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', billable: true }] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Failed', JSON.stringify(response.body));
    assert.equal((await pool.query(`select count(*)::int count from project_allocations where id='alloc-cross-legal'`)).rows[0].count, 0);
  });

  await check('canonical timesheet import uses a valid past week and creates scoped timesheet state', async () => {
    const coveringPeriods = await pool.query(`select id from reporting_periods
      where organization_id='org-final' and legal_entity_id='legal-a' and status='Open'
        and starts_on <= '2026-08-24' and ends_on >= '2026-08-24'`);
    if (coveringPeriods.rowCount === 0) {
      await pool.query(`insert into reporting_periods(organization_id,legal_entity_id,code,name,starts_on,ends_on,status)
        values('org-final','legal-a','PERIOD-IMPORT-WEEK','Timesheet Import Week','2026-08-24','2026-08-30','Open')`);
    }
    const authoritativePeriods = await pool.query(`select count(*)::int count from reporting_periods
      where organization_id='org-final' and legal_entity_id='legal-a' and status='Open'
        and starts_on <= '2026-08-24' and ends_on >= '2026-08-24'`);
    assert.equal(authoritativePeriods.rows[0].count, 1, 'timesheet import fixture requires exactly one authoritative Open period');
    const response = await call('POST', '/api/imports/timesheets/apply', { token: adminToken, scope: scopeA, body: { fileName: 'synthetic-timesheet.csv', rows: [{ employeeId: scopedEmployee, weekEnding: '2026-08-30', workType: 'Project Work', projectId: 'project-final', date: '2026-08-24', hours: 8, billable: true, status: 'Draft' }] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const row = (await pool.query(`select organization_id from timesheets where employee_id=$1 and week_ending='2026-08-30'`, [scopedEmployee])).rows[0];
    assert.equal(row?.organization_id, 'org-final');
  });

  await check('cross-legal timesheet import is denied with no write', async () => {
    const response = await call('POST', '/api/imports/timesheets/apply', { token: adminToken, scope: scopeB, body: { fileName: 'cross-legal-timesheet.csv', rows: [{ employeeId: scopedEmployee, weekEnding: '2026-08-23', workType: 'Project Work', projectId: 'project-final', date: '2026-08-17', hours: 8, billable: true, status: 'Draft' }] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Failed', JSON.stringify(response.body));
    assert.equal((await pool.query(`select count(*)::int count from timesheets where employee_id=$1 and week_ending='2026-08-23'`, [scopedEmployee])).rows[0].count, 0);
  });

  await check('canonical employee deactivation is independently blocked by active dependency with no write', async () => {
    await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,status,billable,organization_id,legal_entity_id)
      values('alloc-deactivation-final',$1,'project-final',10,'2026-01-01','2026-12-31','Active',true,'org-final','legal-a')
      on conflict(id) do update set status='Active'`, [scopedEmployee]);
    const before = (await pool.query(`select status from employees where id=$1`, [scopedEmployee])).rows[0].status;
    const response = await call('DELETE', `/api/employees/${scopedEmployee}`, { token: adminToken, scope: scopeA, body: { reason: 'dependency acceptance' } });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'WORKER_DEPENDENCY_CONFLICT');
    const after = (await pool.query(`select status from employees where id=$1`, [scopedEmployee])).rows[0].status;
    assert.equal(after, before);
  });

  await check('cross-organization timesheet approval is denied with no mutation', async () => {
    await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,submitted_at,organization_id,legal_entity_id)
      values($1,'other-e','2026-08-16','Submitted',8,8,now(),'org-other','legal-other')`, [otherTimesheetId]);
    const response = await call('PATCH', `/api/timesheets/${otherTimesheetId}/status`, { token: adminToken, scope: scopeA, body: { status: 'Approved' } });
    assert.ok([403, 404].includes(response.status), JSON.stringify(response.body));
    assert.equal((await pool.query(`select status from timesheets where id=$1`, [otherTimesheetId])).rows[0].status, 'Submitted');
  });

  await check('worker history preserves per-version legal ownership without violating current-scope FK', async () => {
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('worker-transfer','W-TRANSFER','Transfer Worker','transfer@example.test','Engineer','Delivery','Synthetic','cd-final','Active','org-final','legal-b')`);
    await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,worker_type_id,lifecycle_status,effective_from)
      values('worker-transfer','org-final','legal-b',$1,'Active','2026-07-01')`, [workerTypeId]);
    await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,effective_to,status,snapshot)
      values('worker-transfer','org-final','legal-a','2026-01-01','2026-06-30','Active','{"phase":"a"}'::jsonb)`);
    await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)
      values('worker-transfer','org-final','legal-b','2026-07-01','Active','{"phase":"b"}'::jsonb)`);
    const rows = (await pool.query(`select legal_entity_id from worker_history where employee_id='worker-transfer' order by effective_from`)).rows.map(row => row.legal_entity_id);
    assert.deepEqual(rows, ['legal-a', 'legal-b']);
    const oldScope = await call('GET', '/api/organization-setup/workers/worker-transfer/history', { token: adminToken, scope: scopeA });
    assert.equal(oldScope.status, 200, JSON.stringify(oldScope.body));
    assert.deepEqual([...new Set(oldScope.body.map(row => row.legal_entity_id))], ['legal-a']);
    const currentScope = await call('GET', '/api/organization-setup/workers/worker-transfer/history', { token: adminToken, scope: scopeB });
    assert.equal(currentScope.status, 200, JSON.stringify(currentScope.body));
    assert.deepEqual([...new Set(currentScope.body.map(row => row.legal_entity_id))], ['legal-b']);
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000); });
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'passed', checks: 17, today }, null, 2));
