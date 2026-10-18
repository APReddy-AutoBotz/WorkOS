import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {runMigrations} from '../server/migrate.mjs';
import {readDisposablePostgresTarget} from './helpers/disposable-postgres-target.mjs';

// Diagnostic only: real API and PostgreSQL, isolated from all application data.
// Required invariant: WOS-NFR-SEC-003 invalidates sessions for removed roles.
const rawUrl = process.env.WORKOS_TEST_DATABASE_URL;
if (!rawUrl) throw new Error('A disposable local WORKOS_TEST_DATABASE_URL is required; this probe never skips.');
const adminUrl = readDisposablePostgresTarget(rawUrl);
const {Client, Pool} = pg;
const databaseName = `workos_audit_role_probe_${randomBytes(8).toString('hex')}`;
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const admin = new Client({connectionString: adminUrl.toString()});
let created = false;
let pool;
let child;
const results = [];

const childExited = proc => new Promise(resolveExit => {
  if (proc.exitCode !== null || proc.signalCode !== null) resolveExit();
  else proc.once('exit', resolveExit);
});
const stopChild = async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (!await Promise.race([childExited(child).then(() => true), delay(2500).then(() => false)])) {
    child.kill('SIGKILL');
    await Promise.race([childExited(child), delay(2500)]);
    assert(child.exitCode !== null || child.signalCode !== null, 'the disposable API child must stop before database cleanup');
  }
};
const availablePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
};

await admin.connect();
try {
  await admin.query(`create database ${quote(databaseName)}`);
  created = true;
  const databaseUrl = new URL(adminUrl.toString());
  databaseUrl.pathname = `/${databaseName}`;
  pool = new Pool({connectionString: databaseUrl.toString(), max: 3});
  const migrated = await runMigrations({pool, rootDir: resolve(fileURLToPath(new URL('../server/', import.meta.url))), logger: {log() {}}});
  assert.equal(migrated.status.isCurrent, true, 'the disposable database must use the complete unchanged migration manifest');
  const userId = randomUUID();
  await pool.query(`insert into roles(name) values ('HR'),('Employee') on conflict (name) do nothing`);
  await pool.query(`insert into users(id,username,email,status)
    values ($1,'synthetic-role-reader','synthetic-role-reader@example.test','Active')`, [userId]);
  await pool.query(`insert into user_roles(user_id,role_id) select $1,id from roles where name in ('HR','Employee')`, [userId]);
  await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true)`, [userId]);
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    values ('HR','audit.view',true),('Employee','audit.view',false)
    on conflict (role_name,permission_key) do update set enabled=excluded.enabled`);
  const sentinel = 'synthetic-role-revocation-sentinel';
  const inserted = await pool.query(`insert into audit_logs
    (user_id,user_name,user_role,active_role,source,module,action,details,entity_type,entity_id,organization_id,legal_entity_id)
    values ($1,'Synthetic role reader','HR','HR','Synthetic role probe','Audit Role Probe','Review Evidence',
      'Synthetic disposable evidence only','RoleProbe',$2,'org-default','legal-default') returning id`, [userId, sentinel]);
  const rowId = String(inserted.rows[0].id);
  const snapshot = async () => JSON.stringify((await pool.query('select * from audit_logs order by id')).rows);
  const before = await snapshot();

  const port = await availablePort();
  const secret = randomBytes(48).toString('hex');
  const sign = role => {
    const body = Buffer.from(JSON.stringify({sub: userId, username: 'synthetic-role-reader', activeRole: role,
      exp: Date.now() + 15 * 60_000})).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  // Match the established real migration/API fixture profile, with fallback off.
  child = spawn(process.execPath, ['server/index.mjs'], {cwd: process.cwd(), env: {
    PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test', APP_MODE: 'test', PORT: String(port),
    DATABASE_URL: databaseUrl.toString(), PGSSLMODE: 'disable', API_SESSION_SECRET: secret, APP_URL: baseUrl,
    IDENTITY_PROVIDER: 'local', AUTO_SEED_DEMO: 'false', RESET_DEMO_DATA: 'false',
    ALLOW_TEST_FALLBACK: 'false', VITE_ALLOW_TEST_FALLBACK: 'false',
  }, stdio: ['ignore', 'ignore', 'ignore']});
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline && !spawnFailed && child.exitCode === null && child.signalCode === null) {
    try {
      ready = (await fetch(`${baseUrl}/api/health/live`, {signal: AbortSignal.timeout(300)})).status === 200;
      if (ready) break;
    } catch { /* The isolated child may still be starting. */ }
    await delay(100);
  }
  assert(ready, 'the disposable real API must start; subprocess output and credentials are never printed');
  const paths = ['/api/audit-logs', '/api/v1/audit-logs'];
  const request = async (path, token) => {
    const response = await fetch(`${baseUrl}${path}`, {headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      'X-Organization-Id': 'org-default', 'X-Legal-Entity-Id': 'legal-default',
    }, signal: AbortSignal.timeout(5000)});
    const body = await response.json();
    return {status: response.status, sentinelVisible: Array.isArray(body)
      && body.some(row => String(row.id) === rowId && row.entity_id === sentinel)};
  };
  // Mint the session while HR is genuinely assigned. The same unexpired token
  // is replayed after only that role assignment is removed; it is not forged.
  const originalSession = sign('HR');
  for (const path of paths) {
    assert.equal((await request(path)).status, 401, 'missing authentication is denied');
    assert.deepEqual(await request(path, sign('Employee')), {status: 403, sentinelVisible: false},
      'an assigned role without audit permission is denied');
    assert.deepEqual(await request(path, originalSession), {status: 200, sentinelVisible: true},
      'the genuinely assigned active HR role must read its authorized exact pair before revocation');
  }
  const removed = await pool.query(`delete from user_roles ur using roles r
    where ur.role_id=r.id and ur.user_id=$1 and r.name='HR' returning ur.user_id`, [userId]);
  assert.equal(removed.rowCount, 1, 'exactly the original active role is revoked');
  const state = (await pool.query(`select u.status,
    exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name='HR') as hr_assigned,
    exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name='Employee') as other_role_assigned,
    exists(select 1 from user_organization_scopes s where s.user_id=u.id and s.organization_id='org-default'
      and s.legal_entity_id='legal-default' and s.active) as scope_active,
    exists(select 1 from role_permissions where role_name='HR' and permission_key='audit.view' and enabled) as hr_template_still_enabled
    from users u where u.id=$1`, [userId])).rows[0];
  assert.deepEqual(state, {status: 'Active', hr_assigned: false, other_role_assigned: true,
    scope_active: true, hr_template_still_enabled: true});
  for (const path of paths) {
    const observed = await request(path, originalSession);
    results.push({path, phase: 'removed-active-role', expected: '401 or 403 without audit data', ...observed,
      conforms: [401, 403].includes(observed.status) && !observed.sentinelVisible});
  }
  assert.equal(await snapshot(), before, 'read probes and fixture role removal do not modify append-only audit evidence');
  console.log(JSON.stringify({probe: 'scoped-audit-removed-active-role', requirement: 'WOS-NFR-SEC-003',
    profile: 'isolated real PostgreSQL/API test profile; fallback disabled',
    assignedRolePositive: true, noAuthenticationNegative: true, noPermissionNegative: true,
    fixtureState: state, auditUnchanged: true, results}, null, 2));
  assert(results.every(result => result.conforms), 'Removed active roles must invalidate access under the original session; see sanitized observations above.');
} finally {
  try { await stopChild(); }
  finally {
    try { await pool?.end(); }
    finally {
      try {
        if (created) {
          await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [databaseName]);
          await admin.query(`drop database if exists ${quote(databaseName)}`);
        }
      } finally { await admin.end(); }
    }
  }
}
