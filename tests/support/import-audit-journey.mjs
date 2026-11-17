import {startFixtureServer} from './compiled-fixture-server.mjs';
// Test-only harness. Reuses migration-runner-smoke's local-service allowlist,
// randomized database isolation, real migrations/API and guaranteed teardown.
import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer as createSocketServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createDisposablePool,closeDisposablePool} from './disposable-postgres.mjs';
import {runMigrations} from '../../server/migrate.mjs';

export const localDatabaseUrl = value => {
  if (!value) throw new Error('WORKOS_TEST_DATABASE_URL must point to a disposable local PostgreSQL service.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', 'postgres', '::1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('Import/audit journey only creates databases on a local PostgreSQL service.');
  }
  // Do not allow query-string connection parameters to override the checked
  // hostname/database (libpq-style host, hostaddr, service and dbname options).
  if (url.search || url.hash) throw new Error('Import/audit journey database URL must not contain options or fragments.');
  return url;
};

export const signJourneySession = (payload, secret) => {
  const body = Buffer.from(JSON.stringify({sid: randomUUID(), ...payload})).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};

const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
const root = fileURLToPath(new URL('../../', import.meta.url));
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));
const availablePort = async () => {
  const socket = createSocketServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
};
const waitForExit = child => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
const stopApi = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (!(await Promise.race([waitForExit(child).then(() => true), delay(2500).then(() => false)]))) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
};

export const journeyFixture = Object.freeze({
  organizationId: 'org-default', legalEntityId: 'legal-default',
  otherLegalEntityId: 'legal-journey-other',
  projectCode: 'SYNTHETIC-IMPORT-AUDIT-001',
  projectName: 'Synthetic import audit acceptance project',
  fileName: 'synthetic-project-import-audit.csv',
  clientId: 'client-journey', clientName: 'Synthetic journey client',
  managerId: 'worker-journey-manager', managerEmployeeId: 'SYNTHETIC-JOURNEY-MANAGER',
  producerUsername: 'synthetic-avery-producer', reviewerUsername: 'synthetic-morgan-reviewer',
});

const seedJourney = async pool => {
  const producerId = randomUUID();
  const reviewerId = randomUUID();
  const f = journeyFixture;
  await pool.query(`insert into roles(name) values ('Admin') on conflict (name) do nothing`);
  await pool.query(`insert into legal_entities (id,organization_id,code,name,country_code,effective_from)
    values ($1,$2,'JOURNEY-OTHER','Synthetic other legal entity','US',date '1970-01-01')`,
  [f.otherLegalEntityId, f.organizationId]);
  await pool.query(`insert into legal_entity_profile_versions
      (legal_entity_id,organization_id,legal_name,reporting_currency,address,country_code,status,effective_from)
    values ($1,$2,'Synthetic other legal entity','USD',
      '{"line1":"Synthetic street","city":"Synthetic city","countryCode":"US"}'::jsonb,
      'US','Active',date '1970-01-01')`, [f.otherLegalEntityId, f.organizationId]);
  await pool.query(`insert into country_directors(id,name,region)
    values ('director-journey','Synthetic journey director','Synthetic region')`);
  await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values ($1,$2,'Synthetic journey manager','journey-manager@example.test','Manager','Delivery','US',
      'director-journey','Active',$3,$4)`,
  [f.managerId, f.managerEmployeeId, f.organizationId, f.legalEntityId]);
  await pool.query(`insert into clients(id,name,account_owner_id,status,organization_id,legal_entity_id)
    values ($1,$2,$3,'Active',$4,$5)`,
  [f.clientId, f.clientName, f.managerId, f.organizationId, f.legalEntityId]);
  for (const [id, username] of [[producerId, f.producerUsername], [reviewerId, f.reviewerUsername]]) {
    await pool.query(`insert into users(id,username,email,status) values ($1,$2,$3,'Active')`,
      [id, username, `${username}@example.test`]);
    await pool.query(`insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'`, [id]);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
      values ($1,$2,$3,true)`, [id, f.organizationId, f.legalEntityId]);
  }
  await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
    values ($1,$2,$3,true)`, [reviewerId, f.organizationId, f.otherLegalEntityId]);
  assert.equal((await pool.query('select count(*)::int as count from user_permission_grants')).rows[0].count, 0,
    'use migrated canonical permissions only, never seed an audit or import grant');
  return {producerId, reviewerId};
};

export const withImportAuditJourney = async test => {
  const adminUrl = localDatabaseUrl(process.env.WORKOS_TEST_DATABASE_URL);
  const admin = new pg.Client({connectionString: adminUrl.toString()});
  const name = `workos_import_audit_${randomBytes(8).toString('hex')}`;
  let created = false;
  let pool;
  let api;
  let fixtureServer;
  await admin.connect();
  try {
    await admin.query(`create database ${quoteIdentifier(name)}`);
    created = true;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${name}`;
    pool = createDisposablePool({connectionString: databaseUrl.toString(), max: 4});
    await runMigrations({pool, rootDir: serverDir, logger: {log() {}}});
    const identities = await seedJourney(pool);
    const secret = randomBytes(48).toString('base64url');
    const port = await availablePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, ['server/index.mjs'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test', APP_MODE: 'test', PORT: String(port),
      DATABASE_URL: databaseUrl.toString(), PGSSLMODE: 'disable', API_SESSION_SECRET: secret,
      APP_URL: apiUrl, IDENTITY_PROVIDER: 'local', API_SESSION_TTL_HOURS: '0.25',
      AUTO_SEED_DEMO: 'false', RESET_DEMO_DATA: 'false', ALLOW_TEST_FALLBACK: 'false',
      VITE_ALLOW_TEST_FALLBACK: 'false', ENTRA_ENABLED: 'false', TEAMS_ENABLED: 'false',
      NOTIFICATION_PROVIDER: 'mock', TEAMS_PROVIDER: 'mock',
    }});
    // Do not retain process logs, which could accidentally contain a session or
    // connection string if a future server error becomes more verbose.
    api.stdout.resume();
    api.stderr.resume();
    let launchError;
    api.on('error', error => { launchError = error; });
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      assert.equal(api.exitCode, null, 'actual API must remain running');
      try {
        const response = await fetch(`${apiUrl}/api/health`, {signal: AbortSignal.timeout(500)});
        if (response.ok && (await response.json()).database === 'connected') { ready = true; break; }
      } catch { /* wait for the actual API listener */ }
      await delay(100);
    }
    assert.equal(ready, true, 'actual API must connect to the migrated disposable database');
    fixtureServer = await startFixtureServer({root, apiUrl, application: true, mode: 'test',
      publicEnv: {VITE_DISABLE_DEMO_FALLBACK: 'true', VITE_TERM_PROJECT: 'project'}});
    const browserUrl = fixtureServer.url;
    const bootstrap = async (id, username) => {
      // Only authentication bootstrap is synthetic. /auth/me, active account,
      // currently assigned role, effective permissions and all scopes stay real.
      const token = signJourneySession({sub: id, username, activeRole: 'Admin', exp: Date.now() + 15 * 60_000}, secret);
      const response = await fetch(`${browserUrl}/api/auth/me`, {headers: {Authorization: `Bearer ${token}`}});
      assert.equal(response.status, 200, 'named account must pass the normal identity middleware');
      const identity = await response.json();
      assert.equal(identity.id, id);
      assert.equal(identity.username, username);
      assert.equal(identity.activeRole, 'Admin');
      assert.ok(identity.permissions.includes('imports.manage'));
      assert.ok(identity.permissions.includes('audit.view'));
      const scopesResponse = await fetch(`${browserUrl}/api/auth/organization-scopes`, {headers: {Authorization: `Bearer ${token}`}});
      assert.equal(scopesResponse.status, 200);
      const scopes = await scopesResponse.json();
      assert.deepEqual(scopes.map(scope => scope.legalEntityId).sort(),
        (id === identities.reviewerId
          ? [journeyFixture.legalEntityId, journeyFixture.otherLegalEntityId]
          : [journeyFixture.legalEntityId]).sort(), 'fixture must have real current effective scope profiles');
      return {token, session: {
        id: identity.employeeRecordId || identity.employeeId || identity.id,
        employeeId: identity.employeeId, userName: identity.username, name: identity.name || identity.username,
        email: identity.email, role: identity.activeRole, availableRoles: identity.roles,
        permissions: identity.permissions, permissionRole: identity.permissionRole,
      }, scope: {organizationId: journeyFixture.organizationId, legalEntityId: journeyFixture.legalEntityId}};
    };
    await test({pool, browserUrl, ...identities,
      producer: await bootstrap(identities.producerId, journeyFixture.producerUsername),
      reviewer: await bootstrap(identities.reviewerId, journeyFixture.reviewerUsername)});
  } finally {
    // Stop every client before dropping only the randomized database we created.
    try { if (fixtureServer) await fixtureServer.close(); } finally {
      try { if (api) await stopApi(api); } finally {
        try { if (pool) await closeDisposablePool(pool); } finally {
          try {
            if (created) {
              await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [name]);
              await admin.query(`drop database if exists ${quoteIdentifier(name)}`);
            }
          } finally { await admin.end(); }
        }
      }
    }
  }
};
