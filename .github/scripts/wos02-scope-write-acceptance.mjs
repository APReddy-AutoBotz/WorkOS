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
const hashPassword = async password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
  return `scrypt$${salt}$${key}`;
};

const password = 'WOS-Scope-Closure-42!';
const adminUserId = '00000000-0000-0000-0000-000000000901';
const port = 4321;
const origin = `http://127.0.0.1:${port}`;
const scopeA = { 'x-organization-id': 'org-scope', 'x-legal-entity-id': 'legal-scope-a' };
const scopeB = { 'x-organization-id': 'org-scope', 'x-legal-entity-id': 'legal-scope-b' };

await pool.query(`insert into country_directors(id,name,region) values('cd-scope','Scope Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values
 ('org-scope','ORG-SCOPE','Scope Org','2026-01-01'),
 ('org-duplicate','ORG-DUPLICATE','Duplicate Org','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values
 ('legal-scope-a','org-scope','LEGAL-SCOPE-A','Scope Legal A','2026-01-01'),
 ('legal-scope-b','org-scope','LEGAL-SCOPE-B','Scope Legal B','2026-01-01'),
 ('legal-duplicate','org-duplicate','LEGAL-DUPLICATE','Duplicate Legal','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('legal-b-employee','E-LEGAL-B','Legal B Employee','legal-b-employee@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-scope','legal-scope-b')
 on conflict(id) do nothing`);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-scope','ADMIN-SCOPE','Scope Admin','scope-admin@example.test','System Administrator','Administration','Synthetic','cd-scope','Active','org-scope','legal-scope-a')
 on conflict(id) do nothing`);
const adminHash = await hashPassword(password);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'scope-admin','ADMIN-SCOPE','admin-scope','scope-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminUserId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminUserId, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values
 ($1,'org-scope','legal-scope-a',true),($1,'org-scope','legal-scope-b',true)
 on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminUserId]);
// Retained timesheet scope-write checks predate WOS-02 reporting-period authority.
// Provision explicit Open authority for the exact weeks exercised below so these
// checks continue to test legal-entity ownership rather than fail earlier on
// the now-correct REPORTING_PERIOD_MISSING guard.
await pool.query(`insert into reporting_periods(organization_id,legal_entity_id,code,name,starts_on,ends_on,status) values
 ('org-scope','legal-scope-a','RP-SCOPE-0816','Scope Week 0816','2026-08-10','2026-08-16','Open'),
 ('org-scope','legal-scope-a','RP-SCOPE-0823','Scope Week 0823','2026-08-17','2026-08-23','Open'),
 ('org-scope','legal-scope-a','RP-SCOPE-0830','Scope Week 0830','2026-08-24','2026-08-30','Open')
 on conflict(organization_id,legal_entity_id,code) do nothing`);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-scope-write-acceptance-secret',
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

let token = '';
let employeeA = '';
let importedEmployeeA = '';
let clientA = '';
try {
  await check('scope admin login succeeds', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'scope-admin', password, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    token = response.body.token;
    assert.ok(token);
  });

  await check('client import same-scope positive persists organization and legal entity', async () => {
    const response = await call('POST', '/api/imports/clients/apply', { token, scope: scopeA, body: {
      fileName: 'scope-client.csv',
      rows: [{ name: 'Scope Client A', industry: 'Synthetic', accountOwnerId: 'admin-scope', status: 'Active' }],
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const row = (await pool.query(`select id,organization_id,legal_entity_id from clients where name='Scope Client A'`)).rows[0];
    assert.equal(row.organization_id, 'org-scope');
    assert.equal(row.legal_entity_id, 'legal-scope-a');
    clientA = row.id;
  });

  await pool.query(`insert into clients(id,name,industry,status,organization_id,legal_entity_id)
    values('client-scope-b','Scope Client B','Synthetic','Active','org-scope','legal-scope-b')`);
  await check('client import cross-legal existing ID is denied with no mutation', async () => {
    const before = (await pool.query(`select name from clients where id='client-scope-b'`)).rows[0].name;
    const response = await call('POST', '/api/imports/clients/apply', { token, scope: scopeA, body: {
      fileName: 'cross-legal-client.csv',
      rows: [{ id: 'client-scope-b', name: 'Cross Legal Rewrite', industry: 'Synthetic', status: 'Active' }],
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Failed', JSON.stringify(response.body));
    assert.equal((await pool.query(`select name from clients where id='client-scope-b'`)).rows[0].name, before);
  });

  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values('dup-canon-other','E-DUP-CANON','Duplicate Canon Other','dup-canon-other@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-duplicate','legal-duplicate')`);
  await check('canonical employee save supports organization-scoped duplicate employee code without ID reuse', async () => {
    const response = await call('POST', '/api/employees', { token, scope: scopeA, body: {
      employee_id: 'E-DUP-CANON', name: 'Duplicate Canon A', email: 'dup-canon-a@example.test', designation: 'Engineer', department: 'Delivery', country: 'Synthetic',
      primary_country_director_id: 'cd-scope', mapped_country_director_ids: [], roles: ['Employee'], initial_password: 'Duplicate-Canon-42!', status: 'Active',
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = (await pool.query(`select id,organization_id,legal_entity_id from employees where employee_id='E-DUP-CANON' order by organization_id`)).rows;
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.deepEqual(rows.map(row => row.organization_id), ['org-duplicate','org-scope']);
    assert.notEqual(rows[0].id, rows[1].id);
    employeeA = rows.find(row => row.organization_id === 'org-scope' && row.legal_entity_id === 'legal-scope-a').id;
  });

  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values('dup-import-other','E-DUP-IMPORT','Duplicate Import Other','dup-import-other@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-duplicate','legal-duplicate')`);
  await check('employee import supports organization-scoped duplicate employee code without ID reuse', async () => {
    const response = await call('POST', '/api/imports/employees/apply', { token, scope: scopeA, body: {
      fileName: 'scope-employee.csv', rows: [{ employeeId: 'E-DUP-IMPORT', name: 'Duplicate Import A', email: 'dup-import-a@example.test', designation: 'Engineer', department: 'Delivery', country: 'Synthetic', primaryCountryDirectorId: 'cd-scope', roles: ['Employee'], initialPassword: 'Duplicate-Import-42!', status: 'Active' }],
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const rows = (await pool.query(`select id,organization_id,legal_entity_id from employees where employee_id='E-DUP-IMPORT' order by organization_id`)).rows;
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.deepEqual(rows.map(row => row.organization_id), ['org-duplicate','org-scope']);
    assert.notEqual(rows[0].id, rows[1].id);
    importedEmployeeA = rows.find(row => row.organization_id === 'org-scope' && row.legal_entity_id === 'legal-scope-a').id;
  });

  await check('project create same-scope positive persists exact ownership', async () => {
    const response = await call('POST', '/api/projects', { token, scope: scopeA, body: {
      id: 'project-scope-a', project_code: 'P-SCOPE-A', name: 'Project Scope A', client_id: clientA, manager_id: 'admin-scope', start_date: '2026-01-01', end_date: '2026-12-31', status: 'Active', billable: true,
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = (await pool.query(`select organization_id,legal_entity_id from projects where id='project-scope-a'`)).rows[0];
    assert.equal(row.organization_id, 'org-scope');
    assert.equal(row.legal_entity_id, 'legal-scope-a');
  });

  await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,start_date,end_date,status,billable,organization_id,legal_entity_id)
    values('project-scope-b','P-SCOPE-B','Project Scope B','client-scope-b','Scope Client B','legal-b-employee','Legal B Employee','2026-01-01','2026-12-31','Active',true,'org-scope','legal-scope-b')`);
  await check('project existing ID cross-legal update is denied with no mutation', async () => {
    const response = await call('POST', '/api/projects', { token, scope: scopeA, body: {
      id: 'project-scope-b', project_code: 'P-HIJACK', name: 'Project Hijack', client_id: clientA, manager_id: 'admin-scope', start_date: '2026-01-01', end_date: '2026-12-31', status: 'Active', billable: true,
    } });
    assert.ok([403,404].includes(response.status), JSON.stringify(response.body));
    const row = (await pool.query(`select project_code,name,legal_entity_id from projects where id='project-scope-b'`)).rows[0];
    assert.equal(row.project_code, 'P-SCOPE-B');
    assert.equal(row.name, 'Project Scope B');
    assert.equal(row.legal_entity_id, 'legal-scope-b');
  });

  await check('allocation same-scope positive persists exact organization and legal entity', async () => {
    const response = await call('POST', '/api/allocations', { token, scope: scopeA, body: {
      id: 'alloc-scope-a', employee_id: employeeA, project_id: 'project-scope-a', percentage: 50, start_date: '2026-01-01', end_date: '2026-12-31', billable: true, status: 'Active',
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = (await pool.query(`select organization_id,legal_entity_id from project_allocations where id='alloc-scope-a'`)).rows[0];
    assert.equal(row.organization_id, 'org-scope');
    assert.equal(row.legal_entity_id, 'legal-scope-a');
  });

  await check('allocation same-org cross-legal references are denied with no write', async () => {
    const response = await call('POST', '/api/allocations', { token, scope: scopeA, body: {
      id: 'alloc-cross-legal', employee_id: 'legal-b-employee', project_id: 'project-scope-b', percentage: 10, start_date: '2026-01-01', end_date: '2026-12-31', billable: true, status: 'Active',
    } });
    assert.ok([403,404,422].includes(response.status), JSON.stringify(response.body));
    assert.equal((await pool.query(`select count(*)::int count from project_allocations where id='alloc-cross-legal'`)).rows[0].count, 0);
  });

  await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,status,billable,organization_id,legal_entity_id)
    values('alloc-scope-b','legal-b-employee','project-scope-b',50,'2026-01-01','2026-12-31','Active',true,'org-scope','legal-scope-b')`);
  await check('allocation existing ID cross-legal update is denied with no mutation', async () => {
    const response = await call('POST', '/api/allocations', { token, scope: scopeA, body: {
      id: 'alloc-scope-b', employee_id: employeeA, project_id: 'project-scope-a', percentage: 20, start_date: '2026-01-01', end_date: '2026-12-31', billable: true, status: 'Active',
    } });
    assert.ok([403,404].includes(response.status), JSON.stringify(response.body));
    const row = (await pool.query(`select employee_id,project_id,percentage,legal_entity_id from project_allocations where id='alloc-scope-b'`)).rows[0];
    assert.equal(row.employee_id, 'legal-b-employee');
    assert.equal(row.project_id, 'project-scope-b');
    assert.equal(Number(row.percentage), 50);
    assert.equal(row.legal_entity_id, 'legal-scope-b');
  });

  await check('timesheet same-scope positive persists exact legal ownership', async () => {
    const response = await call('POST', '/api/timesheets', { token, scope: scopeA, body: {
      employee_id: employeeA, week_ending: '2026-08-30', status: 'Draft', entries: [{ project_id: 'project-scope-a', work_type: 'Project Work', work_date: '2026-08-24', hours: 8, billable: true }],
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = (await pool.query(`select organization_id,legal_entity_id from timesheets where employee_id=$1 and week_ending='2026-08-30'`, [employeeA])).rows[0];
    assert.equal(row.organization_id, 'org-scope');
    assert.equal(row.legal_entity_id, 'legal-scope-a');
  });

  await check('timesheet same-org cross-legal employee reference is denied with no write', async () => {
    const response = await call('POST', '/api/timesheets', { token, scope: scopeA, body: {
      employee_id: 'legal-b-employee', week_ending: '2026-08-23', status: 'Draft', entries: [{ project_id: 'project-scope-b', work_type: 'Project Work', work_date: '2026-08-17', hours: 8, billable: true }],
    } });
    assert.ok([403,404,422].includes(response.status), JSON.stringify(response.body));
    assert.equal((await pool.query(`select count(*)::int count from timesheets where employee_id='legal-b-employee' and week_ending='2026-08-23'`)).rows[0].count, 0);
  });

  await check('timesheet same-org cross-legal project reference is denied with no write', async () => {
    const response = await call('POST', '/api/timesheets', { token, scope: scopeA, body: {
      employee_id: employeeA, week_ending: '2026-08-16', status: 'Draft', entries: [{ project_id: 'project-scope-b', work_type: 'Project Work', work_date: '2026-08-10', hours: 8, billable: true }],
    } });
    assert.ok([403,404,422].includes(response.status), JSON.stringify(response.body));
    assert.equal((await pool.query(`select count(*)::int count from timesheets where employee_id=$1 and week_ending='2026-08-16'`, [employeeA])).rows[0].count, 0);
  });

  await check('database constraints reject alternate cross-legal allocation writes', async () => {
    await assert.rejects(
      () => pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,status,billable,organization_id,legal_entity_id)
        values('alloc-db-cross',$1,'project-scope-b',10,'2026-01-01','2026-12-31','Active',true,'org-scope','legal-scope-a')`, [employeeA]),
      error => error?.code === '23503',
    );
  });

  await check('database constraints reject alternate cross-legal timesheet writes', async () => {
    await assert.rejects(
      () => pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
        values('legal-b-employee','2026-08-09','Draft',0,0,'org-scope','legal-scope-a')`),
      error => error?.code === '23503',
    );
  });

  assert.ok(importedEmployeeA, 'employee import positive did not create legal-A record');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000); });
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'passed', checks: 15 }, null, 2));
