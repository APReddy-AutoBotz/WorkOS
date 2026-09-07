import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const port = 4332;
const origin = `http://127.0.0.1:${port}`;
const loginSecret = 'WOS-U8-U9-Reporting-42!';
const adminId = '00000000-0000-0000-0000-000000000981';
const scope = { 'x-organization-id': 'org-u8u9', 'x-legal-entity-id': 'legal-u8u9' };

await pool.query(`insert into country_directors(id,name,region) values('cd-u8u9','U8 U9 Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values('org-u8u9','ORG-U8U9','U8 U9 Reporting Org','2026-01-01') on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values('legal-u8u9','org-u8u9','LEGAL-U8U9','U8 U9 Reporting Legal','2026-01-01') on conflict(id) do nothing`);
await pool.query(`insert into legal_entity_profile_versions(
  legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from,effective_to,authority_effective_to
) values
  ('legal-u8u9','org-u8u9','U8 U9 Reporting Legal','US','Active','USD','{"line1":"Synthetic acceptance","city":"Synthetic","countryCode":"US"}'::jsonb,'2026-01-01',null,null)
on conflict(legal_entity_id,effective_from) do update set
  organization_id=excluded.organization_id,legal_name=excluded.legal_name,country_code=excluded.country_code,
  status=excluded.status,reporting_currency=excluded.reporting_currency,address=excluded.address,
  effective_to=excluded.effective_to,authority_effective_to=excluded.authority_effective_to`);
const adminHash = await hashPassword(loginSecret);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-u8u9','ADMIN-U8U9','U8 U9 Admin','u8u9-admin@example.test','System Administrator','Administration','Synthetic','cd-u8u9','Active','org-u8u9','legal-u8u9')
 on conflict(id) do nothing`);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'u8u9-admin','ADMIN-U8U9','admin-u8u9','u8u9-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist after migrations');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminId, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
 values($1,'org-u8u9','legal-u8u9',true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminId]);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-u8u9-reporting-acceptance-secret',
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

const call = async (method, route, { token, body } = {}) => {
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
const periodBody = (code, startsOn, endsOn, status, frequency) => ({ code, name: code, frequency, startsOn, endsOn, status });
const employeeBody = code => ({
  employee_id: code,
  name: code,
  email: `${code.toLowerCase()}@example.test`,
  designation: 'Engineer',
  department: 'Delivery',
  country: 'Synthetic',
  primary_country_director_id: 'cd-u8u9',
  mapped_country_director_ids: [],
  roles: ['Employee'],
  initial_password: `${code}-Credential-42!`,
  joining_date: '2026-01-01',
  status: 'Active',
});
const timesheetBody = (employeeId, weekEnding, workDate, status = 'Draft') => ({
  employee_id: employeeId,
  week_ending: weekEnding,
  status,
  entries: [{ work_type: 'Client Misc Task', client_name: 'Synthetic Client', work_date: workDate, hours: 8, remark: 'U8 U9 reporting acceptance', billable: false }],
});
const timesheetCount = async (employeeId, weekEnding) => Number((await pool.query(
  `select count(*)::int count from timesheets where organization_id='org-u8u9' and legal_entity_id='legal-u8u9' and employee_id=$1 and week_ending=$2`,
  [employeeId, weekEnding],
)).rows[0].count);

let adminToken = '';
try {
  await check('reporting guard retains one locked query at 100 dates and rejects 101 before querying', async () => {
    const moduleUrl = `${pathToFileURL(path.join(targetRoot, 'server/reporting-periods.mjs')).href}?u8u9=${Date.now()}`;
    const { assertReportingPeriodAllows, REPORTING_PERIOD_OPERATIONS } = await import(moduleUrl);
    const makeDates = count => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10));
    const queries = [];
    const database = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: params[2].map((date, index) => ({
          relevant_date: date,
          id: `weekly-${index}`,
          code: `W-${index}`,
          name: `W-${index}`,
          starts_on: date,
          ends_on: date,
          status: 'Open',
          frequency: 'Weekly',
        })) };
      },
    };
    await assertReportingPeriodAllows(database, {
      organizationId: 'org-bound',
      legalEntityId: 'legal-bound',
      relevantDates: makeDates(100),
      operation: REPORTING_PERIOD_OPERATIONS.CONTENT,
    });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[2].length, 100);
    assert.match(queries[0].sql, /for share of p/i);
    const neverQuery = { query: async () => { throw new Error('database query must not run above the bound'); } };
    await assert.rejects(
      () => assertReportingPeriodAllows(neverQuery, {
        organizationId: 'org-bound',
        legalEntityId: 'legal-bound',
        relevantDates: makeDates(101),
        operation: REPORTING_PERIOD_OPERATIONS.CONTENT,
      }),
      error => error?.code === 'REPORTING_PERIOD_DATE_LIMIT',
    );
  });

  await check('reporting guard fails closed on missing or duplicate Weekly authority', async () => {
    const moduleUrl = `${pathToFileURL(path.join(targetRoot, 'server/reporting-periods.mjs')).href}?missing=${Date.now()}`;
    const { assertReportingPeriodAllows, REPORTING_PERIOD_OPERATIONS } = await import(moduleUrl);
    const missing = { query: async () => ({ rows: [{ relevant_date: '2026-05-01', id: 'm1', code: 'M1', status: 'Open', frequency: 'Monthly' }] }) };
    await assert.rejects(
      () => assertReportingPeriodAllows(missing, { organizationId: 'o', legalEntityId: 'l', relevantDates: ['2026-05-01'], operation: REPORTING_PERIOD_OPERATIONS.CONTENT }),
      error => error?.code === 'REPORTING_PERIOD_MISSING',
    );
    const duplicate = { query: async () => ({ rows: [
      { relevant_date: '2026-05-01', id: 'w1', code: 'W1', status: 'Open', frequency: 'Weekly' },
      { relevant_date: '2026-05-01', id: 'w2', code: 'W2', status: 'Open', frequency: 'Weekly' },
    ] }) };
    await assert.rejects(
      () => assertReportingPeriodAllows(duplicate, { organizationId: 'o', legalEntityId: 'l', relevantDates: ['2026-05-01'], operation: REPORTING_PERIOD_OPERATIONS.CONTENT }),
      error => error?.code === 'REPORTING_PERIOD_AMBIGUOUS',
    );
  });

  await check('synthetic admin login resolves U8 U9 reporting identity', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'u8u9-admin', password: loginSecret, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    adminToken = response.body.token;
    assert.ok(adminToken);
  });

  await check('Weekly Monthly and Fiscal authorities coexist while invalid frequency is rejected', async () => {
    const invalid = await call('POST', '/api/organization-setup/reporting-periods', {
      token: adminToken,
      body: periodBody('U8-BAD', '2026-08-01', '2026-08-31', 'Open', 'Quarterly'),
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    const specs = [
      ['U8-WEEK', '2026-07-27', '2026-08-02', 'Open', 'Weekly'],
      ['U8-JUL', '2026-07-01', '2026-07-31', 'Financially Locked', 'Monthly'],
      ['U8-AUG', '2026-08-01', '2026-08-31', 'Open', 'Monthly'],
      ['U8-FY', '2026-01-01', '2026-12-31', 'Open', 'Fiscal'],
    ];
    for (const spec of specs) {
      const created = await call('POST', '/api/organization-setup/reporting-periods', { token: adminToken, body: periodBody(...spec) });
      assert.equal(created.status, 201, `${spec[0]} ${JSON.stringify(created.body)}`);
      assert.equal(created.body.frequency, spec[4]);
    }
    const covering = (await pool.query(`select frequency,status from reporting_periods where organization_id='org-u8u9' and legal_entity_id='legal-u8u9' and '2026-08-02'::date between starts_on and ends_on order by frequency`)).rows;
    assert.deepEqual(covering.map(row => row.frequency), ['Fiscal', 'Monthly', 'Weekly']);
    const overlap = await call('POST', '/api/organization-setup/reporting-periods', {
      token: adminToken,
      body: periodBody('U8-WEEK-OVERLAP', '2026-07-28', '2026-08-02', 'Open', 'Weekly'),
    });
    assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
    assert.equal(overlap.body.code, 'REPORTING_PERIOD_OVERLAP');
  });

  const workers = {};
  for (const code of ['E-U8-LOCK','E-U8-OK','E-U8-DEC','E-U8-MISS']) {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody(code) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    workers[code] = created.body.id;
  }

  await check('direct cross-boundary content is blocked by locked Monthly authority with zero timesheet write', async () => {
    assert.equal(await timesheetCount(workers['E-U8-LOCK'], '2026-08-02'), 0);
    const response = await call('POST', '/api/timesheets', {
      token: adminToken,
      body: timesheetBody(workers['E-U8-LOCK'], '2026-08-02', '2026-07-31', 'Draft'),
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'REPORTING_PERIOD_CLOSED');
    assert.equal(await timesheetCount(workers['E-U8-LOCK'], '2026-08-02'), 0);
  });

  await check('timesheet import preserves partial semantics and never persists the locked group', async () => {
    const response = await call('POST', '/api/imports/timesheets/apply', {
      token: adminToken,
      body: {
        fileName: 'u8u9-cross-boundary.csv',
        rows: [
          { employeeId: 'E-U8-LOCK', weekEnding: '2026-08-02', workType: 'Client Misc Task', clientName: 'Synthetic Client', date: '2026-07-31', hours: 8, billable: false, status: 'Draft' },
          { employeeId: 'E-U8-OK', weekEnding: '2026-08-02', workType: 'Client Misc Task', clientName: 'Synthetic Client', date: '2026-08-01', hours: 8, billable: false, status: 'Draft' },
        ],
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Partial', JSON.stringify(response.body));
    assert.equal(response.body.validRows, 1, JSON.stringify(response.body));
    assert.ok(response.body.errors.some(error => error.code === 'REPORTING_PERIOD_CLOSED'), JSON.stringify(response.body));
    assert.equal(await timesheetCount(workers['E-U8-LOCK'], '2026-08-02'), 0);
    assert.equal(await timesheetCount(workers['E-U8-OK'], '2026-08-02'), 1);
  });

  await check('Open Weekly and Fiscal cannot bypass Approval Closed Monthly decision authority', async () => {
    const submitted = await call('POST', '/api/timesheets', {
      token: adminToken,
      body: timesheetBody(workers['E-U8-DEC'], '2026-08-02', '2026-08-01', 'Submitted'),
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const closeMonthly = await call('POST', '/api/organization-setup/reporting-periods', {
      token: adminToken,
      body: periodBody('U8-AUG', '2026-08-01', '2026-08-31', 'Approval Closed', 'Monthly'),
    });
    assert.equal(closeMonthly.status, 200, JSON.stringify(closeMonthly.body));
    const decision = await call('PATCH', `/api/timesheets/${submitted.body.id}/status`, { token: adminToken, body: { status: 'Approved' } });
    assert.equal(decision.status, 409, JSON.stringify(decision.body));
    assert.equal(decision.body.code, 'REPORTING_PERIOD_CLOSED');
    assert.equal((await pool.query(`select status from timesheets where id=$1`, [submitted.body.id])).rows[0].status, 'Submitted');
  });

  await check('Monthly and Fiscal authority without Weekly still fails closed before timesheet mutation', async () => {
    const june = await call('POST', '/api/organization-setup/reporting-periods', {
      token: adminToken,
      body: periodBody('U8-JUN', '2026-06-01', '2026-06-30', 'Open', 'Monthly'),
    });
    assert.equal(june.status, 201, JSON.stringify(june.body));
    const response = await call('POST', '/api/timesheets', {
      token: adminToken,
      body: timesheetBody(workers['E-U8-MISS'], '2026-06-14', '2026-06-14', 'Draft'),
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'REPORTING_PERIOD_MISSING');
    assert.equal(await timesheetCount(workers['E-U8-MISS'], '2026-06-14'), 0);
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
console.log(JSON.stringify({ status: 'PASS', checks: 'U8/U9 multi-frequency per-entry reporting authority' }));