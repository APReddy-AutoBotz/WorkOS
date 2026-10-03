import assert from 'node:assert/strict';
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

const port = 4339;
const origin = `http://127.0.0.1:${port}`;
const loginSecret = 'WOS-Worker-Life-42!';
const scope = { 'x-organization-id': 'org-worker', 'x-legal-entity-id': 'legal-worker' };

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-worker-reactivation-acceptance-secret',
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

const employeeBody = (code, name = code) => ({
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
});

const loadWorker = async employeeId => {
  const profile = (await pool.query('select * from worker_profiles where employee_id=$1', [employeeId])).rows[0];
  const history = (await pool.query('select * from worker_history where employee_id=$1 order by effective_from,id', [employeeId])).rows;
  const employee = (await pool.query('select * from employees where id=$1', [employeeId])).rows[0];
  const user = (await pool.query('select * from users where employee_record_id=$1', [employeeId])).rows[0];
  const scopes = user ? (await pool.query('select * from user_organization_scopes where user_id=$1 order by organization_id,legal_entity_id', [user.id])).rows : [];
  const auditCount = Number((await pool.query("select count(*) from audit_logs where module='Workforce' and entity_id=$1", [employeeId])).rows[0].count);
  const mutationAuditCount = Number((await pool.query("select count(*) from audit_logs where module in ('Employee','Import') and entity_id=$1", [employeeId])).rows[0].count);
  return { profile, history, employee, user, scopes, auditCount, mutationAuditCount };
};
const exactScope = state => state.scopes.find(row => row.organization_id === 'org-worker' && row.legal_entity_id === 'legal-worker');
const altScope = state => state.scopes.find(row => row.organization_id === 'org-worker' && row.legal_entity_id === 'legal-worker-alt');
const dateOnly = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const previousDay = value => {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};
const exitWorker = async (employeeId, key) => call('POST', `/api/organization-setup/workers/${employeeId}/transition`, {
  token: adminToken,
  body: { status: 'Exited', effectiveFrom: previousDay(new Date().toISOString().slice(0, 10)), reason: 'synthetic exit before reactivation acceptance', idempotencyKey: key },
});
const assertLifecycleState = (state, status) => {
  const terminal = ['Disabled', 'Exited'].includes(status);
  const latest = state.history.at(-1);
  assert.equal(state.profile.lifecycle_status, status);
  assert.equal(state.employee.status, terminal ? 'Exited' : status);
  assert.equal(latest?.status, status);
  assert.equal(dateOnly(state.profile.effective_from), dateOnly(latest?.effective_from));
  assert.equal(latest?.effective_to, null);
  assert.equal(state.user.status, terminal ? 'Disabled' : 'Active');
  assert.equal(exactScope(state)?.active, !terminal);
};

let adminToken = '';
try {
  await check('existing synthetic admin can authenticate for reactivation acceptance', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'worker-admin', password: loginSecret, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    adminToken = response.body.token;
    assert.ok(adminToken);
  });

  await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from)
    values('legal-worker-alt','org-worker','LEGAL-WORKER-ALT','Worker Alternate Legal','2026-01-01') on conflict(id) do nothing`);
  await pool.query(`insert into legal_entity_profile_versions(
    legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from,effective_to,authority_effective_to
  ) values(
    'legal-worker-alt','org-worker','Worker Alternate Legal','US','Active','USD',
    '{"line1":"Synthetic alternate","city":"Synthetic","countryCode":"US"}'::jsonb,
    '2026-01-01',null,null
  ) on conflict(legal_entity_id,effective_from) do update set
    organization_id=excluded.organization_id,legal_name=excluded.legal_name,country_code=excluded.country_code,
    status=excluded.status,reporting_currency=excluded.reporting_currency,address=excluded.address,
    effective_to=excluded.effective_to,authority_effective_to=excluded.authority_effective_to`);

  let exitedWorkerId = '';
  await check('Exited to Active restores linked user and only the authoritative legal scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-EXIT', 'Reactivation Exit Worker') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    exitedWorkerId = created.body.id;
    let state = await loadWorker(exitedWorkerId);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
      values($1,'org-worker','legal-worker-alt',true)
      on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [state.user.id]);

    const exited = await call('POST', `/api/organization-setup/workers/${exitedWorkerId}/transition`, {
      token: adminToken,
      body: { status: 'Exited', effectiveFrom: '2026-04-01', reason: 'exit before reactivation', idempotencyKey: 'worker-react-exit-001' },
    });
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    state = await loadWorker(exitedWorkerId);
    assert.equal(state.user.status, 'Disabled');
    assert.equal(exactScope(state)?.active, false);
    assert.equal(altScope(state)?.active, true, 'terminal transition must not alter another legal scope');

    const beforeHistory = state.history.length;
    const beforeAudit = state.auditCount;
    const active = await call('POST', `/api/organization-setup/workers/${exitedWorkerId}/transition`, {
      token: adminToken,
      body: { status: 'Active', effectiveFrom: '2026-05-01', reason: 'approved reactivation', idempotencyKey: 'worker-react-active-001' },
    });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.equal(active.body.replayed, false);
    state = await loadWorker(exitedWorkerId);
    assert.equal(state.profile.lifecycle_status, 'Active');
    assert.equal(state.employee.status, 'Active');
    assert.equal(state.user.status, 'Active');
    assert.equal(exactScope(state)?.active, true);
    assert.equal(altScope(state)?.active, true, 'reactivation must leave other legal scopes unchanged');
    assert.equal(state.history.length, beforeHistory + 1);
    assert.equal(state.auditCount, beforeAudit + 1);
  });

  await check('reactivation idempotency replay does not duplicate identity, history, or audit mutations', async () => {
    const before = await loadWorker(exitedWorkerId);
    const replay = await call('POST', `/api/organization-setup/workers/${exitedWorkerId}/transition`, {
      token: adminToken,
      body: { status: 'Active', effectiveFrom: '2026-05-01', reason: 'approved reactivation', idempotencyKey: 'worker-react-active-001' },
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    const after = await loadWorker(exitedWorkerId);
    assert.equal(after.history.length, before.history.length);
    assert.equal(after.auditCount, before.auditCount);
    assert.equal(after.user.status, 'Active');
    assert.equal(exactScope(after)?.active, true);
    assert.equal(altScope(after)?.active, true);
  });

  await check('employee save reactivation atomically converges employee, profile, history, and linked scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-SAVE', 'Employee Save Reactivation') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    let state = await loadWorker(created.body.id);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
      values($1,'org-worker','legal-worker-alt',true)
      on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [state.user.id]);

    const exited = await exitWorker(created.body.id, 'worker-react-save-exit-001');
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    state = await loadWorker(created.body.id);
    assertLifecycleState(state, 'Exited');
    const before = state;

    const reactivation = employeeBody('E-REACT-SAVE', 'Employee Save Reactivation');
    reactivation.status = 'On Leave';
    reactivation.exit_date = dateOnly(before.history.at(-1).effective_from);
    const response = await call('POST', '/api/employees', { token: adminToken, body: reactivation });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    state = await loadWorker(created.body.id);
    assertLifecycleState(state, 'On Leave');
    assert.equal(state.employee.exit_date, null, 'reactivation must clear the current terminal exit date');
    assert.equal(state.history.length, before.history.length + 1);
    assert.equal(dateOnly(state.history.at(-2).effective_to), previousDay(dateOnly(state.history.at(-1).effective_from)));
    assert.equal(state.mutationAuditCount, before.mutationAuditCount + 1);
    assert.equal(altScope(state)?.active, true, 'reactivation must preserve unrelated legal-entity scope');
  });

  await check('employee import reactivation atomically converges employee, profile, history, and linked scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-IMPORT', 'Employee Import Reactivation') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    let state = await loadWorker(created.body.id);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
      values($1,'org-worker','legal-worker-alt',true)
      on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [state.user.id]);

    const exited = await exitWorker(created.body.id, 'worker-react-import-exit-001');
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    state = await loadWorker(created.body.id);
    assertLifecycleState(state, 'Exited');
    const before = state;
    const importResult = await call('POST', '/api/imports/employees/apply', {
      token: adminToken,
      body: {
        fileName: 'synthetic-worker-reactivation.csv',
        rows: [{
          employeeId: 'E-REACT-IMPORT',
          name: 'Employee Import Reactivation',
          email: 'e-react-import@example.test',
          designation: 'Engineer',
          department: 'Delivery',
          country: 'Synthetic',
          primaryCountryDirectorId: 'cd-worker',
          mappedCountryDirectorIds: [],
          status: 'Active',
          exitDate: dateOnly(before.history.at(-1).effective_from),
          roles: ['Employee'],
        }],
      },
    });
    assert.equal(importResult.status, 200, JSON.stringify(importResult.body));
    assert.equal(importResult.body.status, 'Success');
    assert.equal(importResult.body.validRows, 1);
    assert.equal(importResult.body.errorRows, 0);

    state = await loadWorker(created.body.id);
    assertLifecycleState(state, 'Active');
    assert.equal(state.employee.exit_date, null, 'employee import reactivation must clear the current terminal exit date');
    assert.equal(state.history.length, before.history.length + 1);
    assert.equal(dateOnly(state.history.at(-2).effective_to), previousDay(dateOnly(state.history.at(-1).effective_from)));
    assert.equal(state.mutationAuditCount, before.mutationAuditCount + 1);
    assert.equal(altScope(state)?.active, true, 'import reactivation must preserve unrelated legal-entity scope');
  });

  await check('a rejected import reactivation rolls back only its row and continues valid rows', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-ROW-CONFLICT', 'Import Reactivation Conflict') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const exited = await exitWorker(created.body.id, 'worker-react-row-conflict-exit-001');
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    const terminal = await loadWorker(created.body.id);
    const terminalHistory = terminal.history.at(-1);
    await pool.query(`update worker_history set status='Active'
      where employee_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker' and effective_from=$2::date`,
    [created.body.id, dateOnly(terminalHistory.effective_from)]);
    const mismatchedBefore = await loadWorker(created.body.id);

    try {
      const importResult = await call('POST', '/api/imports/employees/apply', {
        token: adminToken,
        body: {
          fileName: 'synthetic-worker-reactivation-partial.csv',
          rows: [
            {
              employeeId: 'E-REACT-ROW-CONFLICT',
              name: 'Must Roll Back Import Reactivation',
              email: 'must-roll-back-reactivation@example.test',
              designation: 'Engineer',
              department: 'Delivery',
              country: 'Synthetic',
              primaryCountryDirectorId: 'cd-worker',
              mappedCountryDirectorIds: [],
              status: 'Active',
              exitDate: dateOnly(terminalHistory.effective_from),
              roles: ['Employee'],
            },
            {
              employeeId: 'E-REACT-IMPORT-PARTIAL',
              name: 'Valid Partial Import Worker',
              email: 'e-react-import-partial@example.test',
              designation: 'Engineer',
              department: 'Delivery',
              country: 'Synthetic',
              primaryCountryDirectorId: 'cd-worker',
              mappedCountryDirectorIds: [],
              status: 'Active',
              roles: ['Employee'],
              initialPassword: 'E-REACT-IMPORT-PARTIAL-Credential-42!d',
            },
          ],
        },
      });
      assert.equal(importResult.status, 200, JSON.stringify(importResult.body));
      assert.equal(importResult.body.status, 'Partial');
      assert.equal(importResult.body.validRows, 1);
      assert.equal(importResult.body.errorRows, 1);
      assert.equal(importResult.body.errors[0].rowNumber, 2);
      assert.equal(importResult.body.errors[0].field, 'status');
      assert.equal(importResult.body.errors[0].code, 'WORKER_VERSION_CONFLICT');

      const afterRejectedRow = await loadWorker(created.body.id);
      assert.equal(afterRejectedRow.profile.lifecycle_status, mismatchedBefore.profile.lifecycle_status);
      assert.equal(afterRejectedRow.employee.name, mismatchedBefore.employee.name);
      assert.equal(afterRejectedRow.employee.email, mismatchedBefore.employee.email);
      assert.equal(afterRejectedRow.employee.status, mismatchedBefore.employee.status);
      assert.equal(dateOnly(afterRejectedRow.employee.exit_date), dateOnly(mismatchedBefore.employee.exit_date));
      assert.equal(afterRejectedRow.user.status, mismatchedBefore.user.status);
      assert.equal(afterRejectedRow.history.length, mismatchedBefore.history.length);
      assert.equal(afterRejectedRow.history.at(-1).status, mismatchedBefore.history.at(-1).status);
      assert.equal(afterRejectedRow.mutationAuditCount, mismatchedBefore.mutationAuditCount);
      assert.equal(exactScope(afterRejectedRow)?.active, false);

      const validRow = (await pool.query("select id from employees where employee_id='E-REACT-IMPORT-PARTIAL' and organization_id='org-worker' and legal_entity_id='legal-worker'" )).rows[0];
      assert.ok(validRow, 'the valid row must commit after a rejected reactivation row');
      assertLifecycleState(await loadWorker(validRow.id), 'Active');
    } finally {
      await pool.query(`update worker_history set status='Exited'
        where employee_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker' and effective_from=$2::date`,
      [created.body.id, dateOnly(terminalHistory.effective_from)]);
    }
  });

  await check('a rejected direct-save reactivation rolls back employee and identity mutations', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-SAVE-ROW-CONFLICT', 'Direct Save Reactivation Conflict') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const exited = await exitWorker(created.body.id, 'worker-react-save-row-conflict-exit-001');
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    const terminal = await loadWorker(created.body.id);
    const terminalHistory = terminal.history.at(-1);
    await pool.query(`update worker_history set status='Active'
      where employee_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker' and effective_from=$2::date`,
    [created.body.id, dateOnly(terminalHistory.effective_from)]);
    const mismatchedBefore = await loadWorker(created.body.id);

    try {
      const attempted = employeeBody('E-REACT-SAVE-ROW-CONFLICT', 'Must Roll Back Direct Save');
      attempted.email = 'must-roll-back-direct-save@example.test';
      attempted.status = 'On Leave';
      attempted.exit_date = dateOnly(terminalHistory.effective_from);
      const response = await call('POST', '/api/employees', { token: adminToken, body: attempted });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, 'WORKER_VERSION_CONFLICT');

      const afterRejectedSave = await loadWorker(created.body.id);
      assert.equal(afterRejectedSave.profile.lifecycle_status, mismatchedBefore.profile.lifecycle_status);
      assert.equal(afterRejectedSave.employee.name, mismatchedBefore.employee.name);
      assert.equal(afterRejectedSave.employee.email, mismatchedBefore.employee.email);
      assert.equal(afterRejectedSave.employee.status, mismatchedBefore.employee.status);
      assert.equal(dateOnly(afterRejectedSave.employee.exit_date), dateOnly(mismatchedBefore.employee.exit_date));
      assert.equal(afterRejectedSave.user.status, mismatchedBefore.user.status);
      assert.deepEqual(afterRejectedSave.scopes.map(row => [row.organization_id, row.legal_entity_id, row.active]),
        mismatchedBefore.scopes.map(row => [row.organization_id, row.legal_entity_id, row.active]));
      assert.deepEqual(afterRejectedSave.history.map(row => [row.status, dateOnly(row.effective_from), row.effective_to && dateOnly(row.effective_to)]),
        mismatchedBefore.history.map(row => [row.status, dateOnly(row.effective_from), row.effective_to && dateOnly(row.effective_to)]));
      assert.equal(afterRejectedSave.mutationAuditCount, mismatchedBefore.mutationAuditCount);
      assert.equal(exactScope(afterRejectedSave)?.active, false);
    } finally {
      await pool.query(`update worker_history set status='Exited'
        where employee_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker' and effective_from=$2::date`,
      [created.body.id, dateOnly(terminalHistory.effective_from)]);
    }
  });

  await check('Disabled to On Leave restores linked user and exact scope', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-DISABLED', 'Reactivation Disabled Worker') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const disabled = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'Disabled', effectiveFrom: '2026-04-01', reason: 'disable before leave', idempotencyKey: 'worker-react-disabled-001' },
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    let state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'Disabled');
    assert.equal(state.user.status, 'Disabled');
    assert.equal(exactScope(state)?.active, false);

    const leave = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'On Leave', effectiveFrom: '2026-05-01', reason: 'approved return on leave', idempotencyKey: 'worker-react-leave-001' },
    });
    assert.equal(leave.status, 200, JSON.stringify(leave.body));
    state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'On Leave');
    assert.equal(state.employee.status, 'On Leave');
    assert.equal(state.user.status, 'Active');
    assert.equal(exactScope(state)?.active, true);
  });

  await check('missing exact linked scope fails closed and rolls back worker, user, history, and audit writes', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-CONFLICT', 'Reactivation Conflict Worker') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const exited = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'Exited', effectiveFrom: '2026-04-01', reason: 'exit before conflict', idempotencyKey: 'worker-react-conflict-exit-001' },
    });
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    let before = await loadWorker(created.body.id);
    assert.equal(before.user.status, 'Disabled');
    await pool.query(`delete from user_organization_scopes where user_id=$1 and organization_id='org-worker' and legal_entity_id='legal-worker'`, [before.user.id]);
    before = await loadWorker(created.body.id);
    const response = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'Active', effectiveFrom: '2026-05-01', reason: 'must fail without exact scope', idempotencyKey: 'worker-react-conflict-active-001' },
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'WORKER_IDENTITY_SYNC_CONFLICT');
    const after = await loadWorker(created.body.id);
    assert.equal(after.profile.lifecycle_status, 'Exited');
    assert.equal(after.employee.status, 'Exited');
    assert.equal(after.user.status, 'Disabled', 'user activation must rollback with the failed transition');
    assert.equal(after.history.length, before.history.length);
    assert.equal(after.auditCount, before.auditCount);
    assert.equal(exactScope(after), undefined);
  });

  await check('reactivation without a linked user remains valid and does not invent identity', async () => {
    const created = await call('POST', '/api/employees', { token: adminToken, body: employeeBody('E-REACT-NOUSER', 'Reactivation No User Worker') });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    let state = await loadWorker(created.body.id);
    const userId = state.user.id;
    await pool.query('delete from user_roles where user_id=$1', [userId]);
    await pool.query('delete from user_organization_scopes where user_id=$1', [userId]);
    await pool.query('delete from users where id=$1', [userId]);
    state = await loadWorker(created.body.id);
    assert.equal(state.user, undefined);

    const exited = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'Exited', effectiveFrom: '2026-04-01', reason: 'no user exit', idempotencyKey: 'worker-react-nouser-exit-001' },
    });
    assert.equal(exited.status, 200, JSON.stringify(exited.body));
    const active = await call('POST', `/api/organization-setup/workers/${created.body.id}/transition`, {
      token: adminToken,
      body: { status: 'Active', effectiveFrom: '2026-05-01', reason: 'no user reactivation', idempotencyKey: 'worker-react-nouser-active-001' },
    });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    state = await loadWorker(created.body.id);
    assert.equal(state.profile.lifecycle_status, 'Active');
    assert.equal(state.employee.status, 'Active');
    assert.equal(state.user, undefined, 'reactivation must not invent a user record');
    assert.equal(state.scopes.length, 0);
  });
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log('Worker reactivation identity acceptance passed');
}
