// Controller owner-trigger marker: run complete acceptance after date-contract correction.
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

const port = 4327;
const origin = `http://127.0.0.1:${port}`;
const loginSecret = 'WOS-Worker-Life-42!';
const adminId = '00000000-0000-0000-0000-000000000901';
const scope = { 'x-organization-id': 'org-worker', 'x-legal-entity-id': 'legal-worker' };

await pool.query(`insert into country_directors(id,name,region) values('cd-worker','Worker Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values('org-worker','ORG-WORKER','Worker Acceptance Org','2026-01-01') on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values('legal-worker','org-worker','LEGAL-WORKER','Worker Acceptance Legal','2026-01-01') on conflict(id) do nothing`);
await pool.query(`insert into legal_entity_profile_versions(
  legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from,effective_to,authority_effective_to
) values(
  'legal-worker','org-worker','Worker Acceptance Legal','US','Active','USD',
  '{\"line1\":\"Synthetic acceptance\",\"city\":\"Synthetic\",\"countryCode\":\"US\"}'::jsonb,
  '2026-01-01',null,null
) on conflict(legal_entity_id,effective_from) do update set
  organization_id=excluded.organization_id,legal_name=excluded.legal_name,country_code=excluded.country_code,
  status=excluded.status,reporting_currency=excluded.reporting_currency,address=excluded.address,
  effective_to=excluded.effective_to,authority_effective_to=excluded.authority_effective_to`);
const adminHash = await hashPassword(loginSecret);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-worker','ADMIN-WORKER','Worker Admin','worker-admin@example.test','System Administrator','Administration','Synthetic','cd-worker','Active','org-worker','legal-worker')
 on conflict(id) do nothing`);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'worker-admin','ADMIN-WORKER','admin-worker','worker-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist after migrations');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminId, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
 values($1,'org-worker','legal-worker',true)
 on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminId]);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-worker-lifecycle-acceptance-secret',
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

const employeeBody = (code, name = code, extra = {}) => ({
  employee_id: code,
  name,
  email: `${code.toLowerCase()}@example.test`,
  designation: 'Engineer',
  department: 'Delivery',
  country: 'Synthetic',
  primary_country_director_id: 'cd-worker',
  mapped_country_director_ids: [],
  roles: ['Employee'],
  initial_password: `${code}-Credential-42!d`,
  joining_date: '2026-01-01',
  status: 'Active',
  ...extra,
});

const loadWorker = async (employeeId) => {
  const profile = (await pool.query(`select * from worker_profiles where employee_id=$1`, [employeeId])).rows[0];
  const history = (await pool.query(`select * from worker_history where employee_id=$1 order by effective_from,id`, [employeeId])).rows;
  const employee = (await pool.query(`select * from employees where id=$1`, [employeeId])).rows[0];
  const user = (await pool.query(`select * from users where employee_record_id=$1`, [employeeId])).rows[0];
  const userScope = user ? (await pool.query(`select * from user_organization_scopes where user_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker'`, [user.id])).rows[0] : null;
  return { profile, history, employee, user, userScope };
};

let adminToken = '';
try {
  await check('synthetic admin login is available for exact worker acceptance', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'worker-admin', password: loginSecret, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.employeeRecordId, 'admin-worker');
    adminToken = response.body.token;
    assert.ok(adminToken);
  });

  let saveWorkerId = '';
  await check('canonical employee save creates exactly one legally-owned worker profile and initial history', async () => {
    const response = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-SAVE', 'Worker Save') });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    saveWorkerId = response.body.id;
    const state = await loadWorker(saveWorkerId);
    assert.ok(state.profile);
    assert.equal(state.profile.organization_id, 'org-worker');
    assert.equal(state.profile.legal_entity_id, 'legal-worker');
    assert.equal(state.profile.lifecycle_status, 'Active');
    assert.equal(new Date(state.profile.effective_from).toISOString().slice(0, 10), '2026-01-01');
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].organization_id, 'org-worker');
    assert.equal(state.history[0].legal_entity_id, 'legal-worker');
    assert.equal(state.history[0].status, 'Active');
    assert.ok(state.user);
    assert.equal(state.user.status, 'Active');
    assert.equal(state.userScope?.active, true);
  });

  await check('canonical employee update preserves existing worker profile and history without reset or duplication', async () => {
    const before = await loadWorker(saveWorkerId);
    const body = employeeBody('E-WORKER-SAVE', 'Worker Save Updated');
    delete body.initial_password;
    const response = await call('POST', '/api/employees', { token: adminToken, body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.id, saveWorkerId);
    const after = await loadWorker(saveWorkerId);
    assert.equal(after.profile.employee_id, before.profile.employee_id);
    assert.equal(String(after.profile.effective_from), String(before.profile.effective_from));
    assert.equal(after.history.length, 1);
    assert.equal(after.history[0].id, before.history[0].id);
    assert.equal(after.employee.name, 'Worker Save Updated');
  });

  let importWorkerId = '';
  const importRow = {
    employeeId: 'E-WORKER-IMPORT',
    name: 'Worker Import',
    email: 'e-worker-import@example.test',
    designation: 'Engineer',
    department: 'Delivery',
    country: 'Synthetic',
    primaryCountryDirectorId: 'cd-worker',
    mappedCountryDirectorIds: [],
    joiningDate: '2026-01-01',
    roles: ['Employee'],
    initialPassword: 'E-WORKER-IMPORT-Credential-42!',
    status: 'Active',
  };
  await check('canonical employee import creates exactly one legally-owned worker profile and initial history', async () => {
    const response = await call('POST', '/api/imports/employees/apply', { token: adminToken, body: { fileName: 'worker-lifecycle.csv', rows: [importRow] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const employee = (await pool.query(`select id from employees where employee_id='E-WORKER-IMPORT' and organization_id='org-worker' and legal_entity_id='legal-worker'`)).rows[0];
    assert.ok(employee);
    importWorkerId = employee.id;
    const state = await loadWorker(importWorkerId);
    assert.equal(state.profile?.organization_id, 'org-worker');
    assert.equal(state.profile?.legal_entity_id, 'legal-worker');
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].legal_entity_id, 'legal-worker');
    assert.ok(state.user);
    assert.equal(state.userScope?.active, true);
  });

  await check('employee re-import preserves initial lifecycle state without duplicate or reset', async () => {
    const before = await loadWorker(importWorkerId);
    const replayRow = { ...importRow, name: 'Worker Import Updated' };
    delete replayRow.initialPassword;
    const response = await call('POST', '/api/imports/employees/apply', { token: adminToken, body: { fileName: 'worker-lifecycle-replay.csv', rows: [replayRow] } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'Success', JSON.stringify(response.body));
    const after = await loadWorker(importWorkerId);
    assert.equal(after.history.length, 1);
    assert.equal(after.history[0].id, before.history[0].id);
    assert.equal(String(after.profile.effective_from), String(before.profile.effective_from));
    assert.equal(after.employee.name, 'Worker Import Updated');
  });

  await check('Active and On Leave transitions preserve linked account and organization scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-ACTIVE', 'Worker Active') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const leave = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, { token: adminToken, body: { status: 'On Leave', effectiveFrom: '2026-02-01', reason: 'leave acceptance', idempotencyKey: 'worker-leave-acceptance-901' } });
    assert.equal(leave.status, 200, JSON.stringify(leave.body));
    let state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'On Leave');
    assert.equal(state.user.status, 'Active');
    assert.equal(state.userScope.active, true);
    const active = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, { token: adminToken, body: { status: 'Active', effectiveFrom: '2026-03-01', reason: 'active acceptance', idempotencyKey: 'worker-active-acceptance-901' } });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'Active');
    assert.equal(state.user.status, 'Active');
    assert.equal(state.userScope.active, true);
    assert.equal(state.history.length, 3);
  });

  let exitWorkerId = '';
  await check('successful Exited transition atomically disables linked user and exact organization/legal scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-EXIT', 'Worker Exit') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    exitWorkerId = created.body.id;
    const response = await call('POST', `/api/organization-setup/workers/${exitWorkerId}/transition`, { token: adminToken, body: { status: 'Exited', effectiveFrom: '2026-04-01', reason: 'exit acceptance', idempotencyKey: 'worker-exit-acceptance-901' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.replayed, false);
    const state = await loadWorker(exitWorkerId);
    assert.equal(state.profile.lifecycle_status, 'Exited');
    assert.equal(state.employee.status, 'Exited');
    assert.equal(state.user.status, 'Disabled');
    assert.equal(state.userScope.active, false);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[1].status, 'Exited');
  });

  await check('leaver idempotency replay does not duplicate history or repeat unsafe state changes', async () => {
    const before = await loadWorker(exitWorkerId);
    const response = await call('POST', `/api/organization-setup/workers/${exitWorkerId}/transition`, { token: adminToken, body: { status: 'Exited', effectiveFrom: '2026-04-01', reason: 'exit acceptance', idempotencyKey: 'worker-exit-acceptance-901' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.replayed, true);
    const after = await loadWorker(exitWorkerId);
    assert.equal(after.history.length, before.history.length);
    assert.equal(after.user.status, 'Disabled');
    assert.equal(after.userScope.active, false);
    assert.equal(after.profile.lifecycle_status, 'Exited');
  });

  await check('successful Disabled transition disables linked user and exact organization/legal scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-DISABLE', 'Worker Disable') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const response = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, { token: adminToken, body: { status: 'Disabled', effectiveFrom: '2026-05-01', reason: 'disable acceptance', idempotencyKey: 'worker-disable-acceptance-901' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'Disabled');
    assert.equal(state.employee.status, 'Exited');
    assert.equal(state.user.status, 'Disabled');
    assert.equal(state.userScope.active, false);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[1].status, 'Disabled');
  });

  await check('dependency-blocked leaver transition leaves worker account scope and history unchanged', async () => {
    const manager = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-BLOCK', 'Worker Block') });
    assert.equal(manager.status, 200, JSON.stringify(manager.body));
    const report = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-REPORT', 'Worker Report', { reporting_manager_id: manager.body.id }) });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const before = await loadWorker(manager.body.id);
    const response = await call('POST', `/api/organization-setup/workers/${manager.body.id}/transition`, { token: adminToken, body: { status: 'Exited', effectiveFrom: '2026-06-01', reason: 'blocked exit acceptance', idempotencyKey: 'worker-blocked-acceptance-901' } });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'WORKER_DEPENDENCY_CONFLICT');
    const after = await loadWorker(manager.body.id);
    assert.equal(after.profile.lifecycle_status, before.profile.lifecycle_status);
    assert.equal(after.employee.status, before.employee.status);
    assert.equal(after.user.status, 'Active');
    assert.equal(after.userScope.active, true);
    assert.equal(after.history.length, before.history.length);
    assert.equal(after.history.at(-1).id, before.history.at(-1).id);
  });

  await check('identity synchronization failure rolls the leaver transition back fail-closed', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-WORKER-SYNCFAIL', 'Worker Sync Fail') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const before = await loadWorker(created.body.id);
    await pool.query(`delete from user_organization_scopes where user_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker'`, [before.user.id]);
    const response = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, { token: adminToken, body: { status: 'Exited', effectiveFrom: '2026-07-01', reason: 'sync failure acceptance', idempotencyKey: 'worker-syncfail-acceptance-901' } });
    assert.equal(response.status, 500, JSON.stringify(response.body));
    const after = await loadWorker(created.body.id);
    assert.equal(after.profile.lifecycle_status, 'Active');
    assert.equal(after.employee.status, 'Active');
    assert.equal(after.user.status, 'Active');
    assert.equal(after.history.length, before.history.length);
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exit(1);
}
console.log('WORKER_LIFECYCLE_ACCEPTANCE_OK');
