// Synthetic, local-only PostgreSQL/API acceptance fixture. No browser or live
// identity provider is launched, and no database URL or signed session is logged.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createDisposablePool,closeDisposablePool} from './disposable-postgres.mjs';
import {runMigrations} from '../../server/migrate.mjs';
import {localDatabaseUrl, signJourneySession} from './import-audit-journey.mjs';

export const commercialServerDir = fileURLToPath(new URL('../../server/', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
export const commercialPermissions = Object.freeze(['commercial.contracts.view', 'commercial.contracts.manage']);
export const commercialFixture = Object.freeze({
  organizationId: 'org-default', legalEntityId: 'legal-default',
  otherLegalEntityId: 'legal-commercial-other',
  otherOrganizationId: 'org-commercial-other', foreignLegalEntityId: 'legal-commercial-foreign',
  ownerId: 'employee-commercial-owner', otherOwnerId: 'employee-commercial-other-owner',
  foreignOwnerId: 'employee-commercial-foreign-owner', clientId: 'client-commercial',
  otherClientId: 'client-commercial-other', foreignClientId: 'client-commercial-foreign',
  businessUnitId: 'catalog-commercial-bu', costCentreId: 'catalog-commercial-cost',
  sharedBusinessUnitId: 'catalog-commercial-shared-bu', inactiveAttributionId: 'catalog-commercial-inactive',
  expiredAttributionId: 'catalog-commercial-expired', futureAttributionId: 'catalog-commercial-future',
  otherAttributionId: 'catalog-commercial-other', foreignAttributionId: 'catalog-commercial-foreign',
  invalidTypeAttributionId: 'catalog-commercial-department', projectId: 'project-commercial-legacy',
  allocationId: 'allocation-commercial-legacy', timesheetId: '9d2644d5-68c8-4da5-a7f0-6c77800cf512',
  workId: '55da358d-89b3-411d-8872-c278c4fc9d3e',
});

export const withCommercialDatabase = async test => {
  // Reuse the allowlist including the prohibition on libpq URL overrides. A
  // missing service is a required-test failure, never a passing skip.
  const adminUrl = localDatabaseUrl(process.env.WORKOS_TEST_DATABASE_URL);
  const admin = new pg.Client({connectionString: adminUrl.toString()});
  const name = `workos_commercial_${randomBytes(8).toString('hex')}`;
  let created = false;
  let pool;
  await admin.connect();
  try {
    await admin.query(`create database ${quoteIdentifier(name)}`);
    created = true;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${name}`;
    pool = createDisposablePool({connectionString: databaseUrl.toString(), max: 6});
    return await test({pool, databaseUrl: databaseUrl.toString()});
  } finally {
    try { if (pool) await closeDisposablePool(pool); } finally {
      try {
        if (created) {
          await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [name]);
          await admin.query(`drop database if exists ${quoteIdentifier(name)}`);
        }
      } finally { await admin.end(); }
    }
  }
};

export const migrateCommercialDatabase = pool => runMigrations({pool, rootDir: commercialServerDir, logger: {log() {}}});

export const withPreCommercialMigrations = test => withCommercialMigrationsThrough(39,test);

export const withCommercialMigrationsThrough = async (lastVersion,test) => {
  const directory = await mkdtemp(join(tmpdir(), 'workos-commercial-upgrade-'));
  try {
    await mkdir(join(directory, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(directory, 'schema.sql'));
    for (const file of (await readdir(join(commercialServerDir, 'migrations'))).sort()) {
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(file) && (typeof lastVersion === 'number' ? Number(file.slice(0, 3)) <= lastVersion : file <= lastVersion + '.sql')) {
        await copyFile(join(commercialServerDir, 'migrations', file), join(directory, 'migrations', file));
      }
    }
    return await test(directory);
  } finally { await rm(directory, {recursive: true, force: true}); }
};

export const seedCommercialReferences = async pool => {
  const f = commercialFixture;
  await pool.query(`insert into organizations(id,code,name,effective_from)
    values ($1,'SYNTHETIC-COMMERCIAL-OTHER','Synthetic other organization',date '1970-01-01')`, [f.otherOrganizationId]);
  for (const [id, organizationId, code] of [
    [f.otherLegalEntityId, f.organizationId, 'SYNTHETIC-OTHER'],
    [f.foreignLegalEntityId, f.otherOrganizationId, 'SYNTHETIC-FOREIGN'],
  ]) {
    await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,effective_from)
      values ($1,$2,$3,'Synthetic commercial legal entity','US',date '1970-01-01')`, [id, organizationId, code]);
    await pool.query(`insert into legal_entity_profile_versions
      (legal_entity_id,organization_id,legal_name,reporting_currency,address,country_code,status,effective_from)
      values ($1,$2,'Synthetic commercial legal entity','USD',
        '{"line1":"Synthetic street","city":"Synthetic city","countryCode":"US"}'::jsonb,
        'US','Active',date '1970-01-01')`, [id, organizationId]);
  }
  await pool.query(`insert into country_directors(id,name,region)
    values ('director-commercial','Synthetic commercial director','Synthetic region')`);
  for (const [ownerId, clientId, organizationId, legalEntityId, suffix] of [
    [f.ownerId, f.clientId, f.organizationId, f.legalEntityId, 'local'],
    [f.otherOwnerId, f.otherClientId, f.organizationId, f.otherLegalEntityId, 'other'],
    [f.foreignOwnerId, f.foreignClientId, f.otherOrganizationId, f.foreignLegalEntityId, 'foreign'],
  ]) {
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,
      primary_country_director_id,status,organization_id,legal_entity_id)
      values ($1,$2,'Synthetic commercial owner',$3,'Manager','Delivery','US','director-commercial','Active',$4,$5)`,
    [ownerId, `SYNTHETIC-COMMERCIAL-${suffix.toUpperCase()}`, `commercial-${suffix}@example.test`, organizationId, legalEntityId]);
    await pool.query(`insert into clients(id,name,account_owner_id,status,organization_id,legal_entity_id)
      values ($1,$2,$3,'Active',$4,$5)`, [clientId, `Synthetic commercial ${suffix} client`, ownerId, organizationId, legalEntityId]);
  }
  for (const [id, organizationId, legalEntityId, type, active, from, to] of [
    [f.businessUnitId, f.organizationId, f.legalEntityId, 'business_unit', true, '1970-01-01', null],
    [f.costCentreId, f.organizationId, f.legalEntityId, 'cost_centre', true, '1970-01-01', null],
    [f.sharedBusinessUnitId, f.organizationId, null, 'business_unit', true, '1970-01-01', null],
    [f.inactiveAttributionId, f.organizationId, f.legalEntityId, 'business_unit', false, '1970-01-01', null],
    [f.expiredAttributionId, f.organizationId, f.legalEntityId, 'cost_centre', true, '1970-01-01', '2000-01-01'],
    [f.futureAttributionId, f.organizationId, f.legalEntityId, 'business_unit', true, '9999-01-01', null],
    [f.otherAttributionId, f.organizationId, f.otherLegalEntityId, 'business_unit', true, '1970-01-01', null],
    [f.foreignAttributionId, f.otherOrganizationId, f.foreignLegalEntityId, 'cost_centre', true, '1970-01-01', null],
    [f.invalidTypeAttributionId, f.organizationId, f.legalEntityId, 'department', true, '1970-01-01', null],
  ]) {
    await pool.query(`insert into organization_catalog_items
      (id,organization_id,legal_entity_id,catalog_type,code,name,active,effective_from,effective_to)
      values ($1,$2,$3,$4,$1,'Synthetic commercial attribution',$5,$6,$7)`,
    [id, organizationId, legalEntityId, type, active, from, to]);
  }
};

export const seedCommercialLegacyWork = async pool => {
  const f = commercialFixture;
  await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,
    project_type,billable,start_date,end_date,status,country,notes,organization_id,legal_entity_id)
    values ($1,'SYNTHETIC-COMMERCIAL-LEGACY','Synthetic legacy delivery',$2,
      'Synthetic commercial local client',$3,'Synthetic commercial owner','Synthetic legacy model',true,
      date '2020-03-08',date '2021-11-07','Completed','US','Synthetic legacy snapshot only',$4,$5)`,
  [f.projectId, f.clientId, f.ownerId, f.organizationId, f.legalEntityId]);
  await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,
    billable,status,organization_id,legal_entity_id)
    values ($1,$2,$3,37.5,date '2020-03-08',date '2021-11-07',true,'Completed',$4,$5)`,
  [f.allocationId, f.ownerId, f.projectId, f.organizationId, f.legalEntityId]);
  await pool.query(`insert into timesheets(id,employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
    values ($1,$2,date '2020-03-15','Approved',7.25,7.25,$3,$4)`,
  [f.timesheetId, f.ownerId, f.organizationId, f.legalEntityId]);
  await pool.query(`insert into timesheet_entries(id,timesheet_id,project_id,work_type,work_date,hours,remark,billable)
    values ($1,$2,$3,'Project Work',date '2020-03-08',7.25,'Synthetic preserved work',true)`,
  [f.workId, f.timesheetId, f.projectId]);
};

export const seedCommercialIdentities = async pool => {
  const identities = {};
  await pool.query(`insert into roles(name) values ('Admin'),('Employee'),('TeamLead') on conflict(name) do nothing`);
  for (const [name, role] of [['manager', 'Admin'], ['reader', 'Employee'], ['denied', 'TeamLead']]) {
    const id = randomUUID();
    const username = `synthetic-commercial-${name}`;
    await pool.query(`insert into users(id,username,email,status) values ($1,$2,$3,'Active')`, [id, username, `${username}@example.test`]);
    await pool.query(`insert into user_roles(user_id,role_id) select $1,id from roles where name=$2`, [id, role]);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
      values ($1,$2,$3,true)`, [id, commercialFixture.organizationId, commercialFixture.legalEntityId]);
    identities[name] = {id, username, role};
  }
  // These are synthetic fixtures in our randomized test database, not live
  // permissions, user grants, or default product access.
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    values ('Admin','commercial.contracts.view',true),('Admin','commercial.contracts.manage',true),
      ('Employee','commercial.contracts.view',true)
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`);
  return identities;
};

const availablePort = async () => {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
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

export const withCommercialApi = async ({databaseUrl, identities, timeZone = 'UTC',
  sessionTtlHours = '0.25', sessionSecret = null, emailProvider = 'mock', onServerError = null, financeProviderFixture = false, runBackgroundWorkers = false, apiRoot = root}, test) => {
  const port = await availablePort();
  const secret = sessionSecret || randomBytes(48).toString('base64url');
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...(financeProviderFixture ? ['--import','./tests/support/lost-finance-receipt.mjs'] : []),'server/index.mjs'], {cwd: apiRoot, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...(financeProviderFixture ? {FINANCE_EXPORT_ENDPOINT:'https://finance.example.invalid/fixture', FINANCE_EXPORT_TOKEN:secret,WORKOS_FIXTURE_REJECT_INVOICE:String(financeProviderFixture==='reject')} : {}),
    PATH: process.env.PATH, TZ: timeZone, NODE_ENV: runBackgroundWorkers ? 'development' : 'test', APP_MODE: 'test', PORT: String(port),
    DATABASE_URL: databaseUrl, PGSSLMODE: 'disable', API_SESSION_SECRET: secret, APP_URL: baseUrl,
    IDENTITY_PROVIDER: 'local', API_SESSION_TTL_HOURS: sessionTtlHours, AUTO_SEED_DEMO: 'false', RESET_DEMO_DATA: 'false',
    ALLOW_TEST_FALLBACK: 'false', VITE_ALLOW_TEST_FALLBACK: 'false', ENTRA_ENABLED: 'false', TEAMS_ENABLED: 'false',
    NOTIFICATION_PROVIDER: 'mock', TEAMS_PROVIDER: 'mock', EMAIL_PROVIDER: emailProvider,
  }});
  child.stdout.resume();
  if(typeof onServerError==='function')child.stderr.on('data',chunk=>onServerError(chunk.toString()));
  child.stderr.resume();
  let launchError;
  child.on('error', error => { launchError = error; });
  const tokenFor = (value = identities.manager, role, providerClaims = {}) => {
    const identity = typeof value === 'string' ? Object.values(identities).find(item => item.id === value) : value;
    assert.ok(identity, 'session bootstrap must identify a synthetic fixture account');
    return signJourneySession({identityProvider: providerClaims.identityProvider, entraGroups: providerClaims.entraGroups,
      sub: identity.id, username: identity.username,
      activeRole: role || identity.role, employeeRecordId: identity.employeeRecordId, employeeId: identity.employeeId, countryDirectorId: identity.countryDirectorId, exp: Date.now() + 15 * 60_000}, secret);
  };
  const request = async (path, {method = 'GET', body, identity = identities.manager,
    role, scope = commercialFixture, authenticated = true, headers = {}} = {}) => {
    const response = await fetch(`${baseUrl}${path.startsWith('/api/') ? path : `/api/v1/commercial-drafting${path}`}`, {
      method, headers: {...(authenticated ? {Authorization: `Bearer ${tokenFor(identity, role)}`} : {}),
        'x-organization-id': scope.organizationId, 'x-legal-entity-id': scope.legalEntityId,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15_000),
    });
    return {response, status: response.status, body: await response.json()};
  };
  try {
    let ready = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, 'actual commercial API must remain running');
      assert.equal(child.signalCode, null, 'actual commercial API must not be terminated');
      try {
        const response = await fetch(`${baseUrl}/api/health`, {signal: AbortSignal.timeout(500)});
        if (response.ok && (await response.json()).database === 'connected') { ready = true; break; }
      } catch { /* Wait for the real listener and PostgreSQL health check. */ }
      await delay(100);
    }
    assert.equal(ready, true, 'actual commercial API must connect to the migrated disposable PostgreSQL database');
    await test({baseUrl, request, tokenFor});
  } finally { await stopApi(child); }
};

// Shared real-backend fixture for a separate hosted React/browser journey. The
// caller owns its Vite/browser lifecycle; this wrapper owns PostgreSQL and API.
export const withCommercialDraftingApi = async (test, {upgrade = false, through = undefined, timeZone = 'UTC', afterApi = undefined} = {}) =>
  withCommercialDatabase(async ({pool, databaseUrl}) => {
    if (upgrade) {
      await withPreCommercialMigrations(async rootDir => {
        await runMigrations({pool, rootDir, logger: {log() {}}});
        await seedCommercialReferences(pool);
        await seedCommercialLegacyWork(pool);
        if (through) await withCommercialMigrationsThrough(through,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
        else await migrateCommercialDatabase(pool);
      });
    } else {
      await migrateCommercialDatabase(pool);
      await seedCommercialReferences(pool);
    }
    const identities = await seedCommercialIdentities(pool);
    await withCommercialApi({databaseUrl, identities, timeZone}, async api => test({...api, pool, identities,
      actorId: identities.manager.id, scope: {organizationId: commercialFixture.organizationId, legalEntityId: commercialFixture.legalEntityId},
      ownerId: commercialFixture.ownerId, clientId: commercialFixture.clientId, attributionId: commercialFixture.businessUnitId,
      businessUnitId: commercialFixture.businessUnitId, costCentreId: commercialFixture.costCentreId}));
    if (afterApi) await afterApi({pool,databaseUrl,identities});
  });
