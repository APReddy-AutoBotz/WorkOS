import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID, scryptSync} from 'node:crypto';
const legacyScopeToken = randomBytes(32).toString('hex');
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createDisposablePool,closeDisposablePool} from './support/disposable-postgres.mjs';
import {createProjectCodeLockKey, hashEmployeeImportRequest, hashImportRequest} from '../server/modules/imports/idempotency.mjs';
import {getMigrationManifest, getMigrationStatus, runMigrations} from '../server/migrate.mjs';

const {Client} = pg;
const serverDir = resolve(fileURLToPath(new URL('../server/', import.meta.url)));
const testDatabaseUrl = process.env.WORKOS_TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('WORKOS_TEST_DATABASE_URL must point to a disposable local PostgreSQL service.');
}

const adminUrl = new URL(testDatabaseUrl);
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)) {
  throw new Error('WORKOS_TEST_DATABASE_URL must use PostgreSQL.');
}
const allowedHosts = new Set(['localhost', '127.0.0.1', 'postgres', '::1', '[::1]']);
if (!allowedHosts.has(adminUrl.hostname.toLowerCase())) {
  throw new Error('Migration smoke tests only create databases on a local PostgreSQL service.');
}

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const withDisposableDatabase = async (test, {maxPoolSize = 4} = {}) => {
  const name = `workos_migration_smoke_${randomBytes(8).toString('hex')}`;
  const admin = new Client({connectionString: adminUrl.toString()});
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create database ${quoteIdentifier(name)}`);
    created = true;
    const databaseUrl = new URL(testDatabaseUrl);
    databaseUrl.pathname = `/${name}`;
    const pool = createDisposablePool({connectionString: databaseUrl.toString(), max: maxPoolSize});
    try {
      return await test(pool, databaseUrl.toString());
    } finally {
      await closeDisposablePool(pool);
    }
  } finally {
    if (created) {
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [name],
      );
      await admin.query(`drop database if exists ${quoteIdentifier(name)}`);
    }
    await admin.end();
  }
};

const manifest = await getMigrationManifest({rootDir: serverDir});
const quietLogger = {log() {}};

const findAvailablePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return port;
};

const signTestSession = (payload, secret) => {
  const body = Buffer.from(JSON.stringify({sid: randomUUID(), ...payload})).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const assertVersionedErrorResponse = (response, body, expected) => {
  assert.deepEqual({code: body?.error?.code, message: body?.error?.message}, expected);
  assert.ok(body.error.correlationId, 'versioned error must carry a correlation ID');
  assert.ok(body.error.operationId, 'versioned POST error must carry an operation ID');
  assert.equal(body.error.correlationId, response.headers.get('x-correlation-id'),
    'versioned error correlation ID must match its response header');
  assert.equal(body.error.operationId, response.headers.get('x-operation-id'),
    'versioned error operation ID must match its response header');
};

const waitForChildExit = child => new Promise(resolveExit => {
  if (child.exitCode !== null || child.signalCode !== null) resolveExit();
  else child.once('exit', resolveExit);
});

const stopChild = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const graceful = await Promise.race([waitForChildExit(child).then(() => true), delay(2500).then(() => false)]);
  if (!graceful) {
    child.kill('SIGKILL');
    await Promise.race([waitForChildExit(child), delay(2500)]);
  }
};

const withImportApi = async (databaseUrl, actorId, test) => {
  const port = await findAvailablePort();
  const secret = randomBytes(32).toString('base64url');
  const childEnvironment = {
    PATH: process.env.PATH,
    TZ: 'UTC',
    NODE_ENV: 'test',
    APP_MODE: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    PGSSLMODE: 'disable',
    API_SESSION_SECRET: secret,
    APP_URL: `http://127.0.0.1:${port}`,
    IDENTITY_PROVIDER: 'local',
    AUTO_SEED_DEMO: 'false',
    RESET_DEMO_DATA: 'false',
    ALLOW_TEST_FALLBACK: 'false',
    VITE_ALLOW_TEST_FALLBACK: 'false',
  };
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collectOutput = chunk => {
    output = `${output}${chunk}`;
    if (output.length > 12_000) output = output.slice(-12_000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenFor = (userId, username = `synthetic-scope-${userId}`, activeRole = 'Admin', employeeClaims = {}) => signTestSession({
    ...employeeClaims,
    sub: userId,
    username,
    activeRole,
    exp: Date.now() + 15 * 60_000,
  }, secret);
  const token = tokenFor(actorId, 'synthetic-import-admin');

  try {
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Import API exited before listening: ${output}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/health/live`, {signal: AbortSignal.timeout(300)});
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // The child may still be importing modules or binding its port.
      }
      await delay(100);
    }
    assert.equal(ready, true, `import API must start for its PostgreSQL contract test: ${output}`);
    await test({baseUrl, token, tokenFor});
  } finally {
    await stopChild(child);
  }
};

await withDisposableDatabase(async (pool, databaseUrl) => {
  let checkedOutClients = 0;
  const guardedPool = {
    async connect() {
      const client = await pool.connect();
      checkedOutClients += 1;
      const release = client.release.bind(client);
      let released = false;
      client.release = (...args) => {
        if (!released) {
          released = true;
          checkedOutClients -= 1;
        }
        return release(...args);
      };
      return client;
    },
    query(...args) {
      assert.equal(checkedOutClients, 0,
        'migration status must use the checked-out client or release it before querying through the pool');
      return pool.query(...args);
    },
  };

  const result = await runMigrations({pool: guardedPool, rootDir: serverDir, logger: quietLogger});
  assert.equal(result.status.isCurrent, true,
    'a single-connection pool must return migration status after applying migrations');
  assert.equal(checkedOutClients, 0, 'the migration runner releases its checked-out client');
  const auditColumns = await pool.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='audit_logs'
      and column_name in ('correlation_id','operation_id','import_batch_id','source_identifier','import_processing_result','organization_id','legal_entity_id')`);
  assert.deepEqual(auditColumns.rows.map(row => row.column_name).sort(), [
    'correlation_id', 'import_batch_id', 'import_processing_result', 'legal_entity_id', 'operation_id',
    'organization_id', 'source_identifier',
  ], 'fresh installs must include request trace, import provenance, and nullable audit scope fields');
  const scopedHistoryColumns = await pool.query(`select table_name,column_name from information_schema.columns
    where table_schema='public'
      and table_name in ('import_export_logs','integration_event_logs','teams_action_tokens')
      and column_name in ('organization_id','legal_entity_id')
    order by table_name,column_name`);
  assert.deepEqual(scopedHistoryColumns.rows, [
    {table_name: 'import_export_logs', column_name: 'legal_entity_id'},
    {table_name: 'import_export_logs', column_name: 'organization_id'},
    {table_name: 'integration_event_logs', column_name: 'legal_entity_id'},
    {table_name: 'integration_event_logs', column_name: 'organization_id'},
    {table_name: 'teams_action_tokens', column_name: 'legal_entity_id'},
    {table_name: 'teams_action_tokens', column_name: 'organization_id'},
  ], 'fresh installs must scope histories and open action-token aggregates');
  const batchIndex = await pool.query(`select indexdef from pg_indexes
    where schemaname='public' and tablename='audit_logs' and indexname='audit_logs_import_batch_id_idx'`);
  assert.equal(batchIndex.rowCount, 1, 'fresh installs must index import-batch audit lookups');
  assert.match(batchIndex.rows[0].indexdef, /where\s+\(import_batch_id is not null\)/i,
    'the batch index must omit audit rows with no import provenance');
  const provenanceReferenceColumn = await pool.query(`select is_nullable,column_default
    from information_schema.columns where table_schema='public' and table_name='identity_provider_links'
      and column_name='provenance_reference'`);
  assert.equal(provenanceReferenceColumn.rowCount, 1);
  assert.equal(provenanceReferenceColumn.rows[0].is_nullable, 'NO',
    'identity-link provenance references must be present on every row');
  assert.match(provenanceReferenceColumn.rows[0].column_default, /gen_random_uuid\(\)/i,
    'new identity-link provenance references must be generated independently of provider identity values');
  const provenanceReferenceIndex = await pool.query(`select indexdef from pg_indexes
    where schemaname='public' and tablename='identity_provider_links'
      and indexname='identity_provider_links_provenance_reference_uidx'`);
  assert.equal(provenanceReferenceIndex.rowCount, 1);
  assert.match(provenanceReferenceIndex.rows[0].indexdef, /unique/i,
    'identity-link provenance references must be unique');
  const deploymentAuditPermission = await pool.query(`select pd.protected,rp.role_name,rp.enabled
    from permission_definitions pd join role_permissions rp on rp.permission_key=pd.permission_key
    where pd.permission_key='audit.deployment.view' order by rp.role_name`);
  assert.deepEqual(deploymentAuditPermission.rows, [
    {protected: true, role_name: 'Admin', enabled: false},
    {protected: true, role_name: 'CountryDirector', enabled: false},
    {protected: true, role_name: 'Employee', enabled: false},
    {protected: true, role_name: 'HR', enabled: false},
    {protected: true, role_name: 'ProjectManager', enabled: false},
    {protected: true, role_name: 'TeamLead', enabled: false},
  ], 'fresh installs must register deployment audit as protected and deny it to every role by default');
  const defaultDeploymentAuditGrants = await pool.query(`select count(*)::int as count from user_permission_grants
    where permission_key='audit.deployment.view'`);
  assert.equal(defaultDeploymentAuditGrants.rows[0].count, 0,
    'fresh installs must not create any live deployment audit user grants');
  const organizationAuditPermission = await pool.query(`select pd.protected,rp.role_name,rp.enabled
    from permission_definitions pd join role_permissions rp on rp.permission_key=pd.permission_key
    where pd.permission_key='audit.organization.view' order by rp.role_name`);
  assert.deepEqual(organizationAuditPermission.rows, [
    {protected: true, role_name: 'Admin', enabled: false},
    {protected: true, role_name: 'CountryDirector', enabled: false},
    {protected: true, role_name: 'Employee', enabled: false},
    {protected: true, role_name: 'HR', enabled: false},
    {protected: true, role_name: 'ProjectManager', enabled: false},
    {protected: true, role_name: 'TeamLead', enabled: false},
  ], 'fresh installs must register organization audit as protected and deny it to every role by default');
  const defaultOrganizationAuditGrants = await pool.query('select count(*)::int as count from organization_audit_grants');
  assert.equal(defaultOrganizationAuditGrants.rows[0].count, 0,
    'fresh installs must not create any live organization audit designations');

  const actorId = randomUUID();
  const singleScopeActorId = randomUUID();
  const multiScopeActorId = randomUUID();
  const importHistoryOnlyActorId = randomUUID();
  const auditDeniedActorId = randomUUID();
  const unassignedAuditActorId = randomUUID();
  const disabledOrganizationAuditorId = randomUUID();
  const scopeFreeAuditorId = randomUUID();
  const scopeFreeAuditorPassword = randomBytes(32).toString('base64url');
  const updatedScopeFreeAuditorPassword = randomBytes(32).toString('base64url');
  const scopeFreeAuditorPasswordSalt = 'synthetic-scope-free-auditor-test-salt';
  await pool.query(`insert into roles(name) values ('Admin'),('Employee') on conflict (name) do nothing`);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-import-admin','synthetic-import-admin@example.test','Active')`, [actorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Admin'`, [actorId]);
  await pool.query(`insert into user_permission_grants (user_id,permission_key,granted_by,active_role)
    values ($1,'imports.manage',$1,'Admin')`, [actorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true) on conflict do nothing`, [actorId]);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-import-history-only','synthetic-import-history-only@example.test','Active')`, [importHistoryOnlyActorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Employee'`, [importHistoryOnlyActorId]);
  await pool.query(`insert into user_permission_grants (user_id,permission_key,granted_by,active_role)
    values ($1,'imports.manage',$2,'Employee')`, [importHistoryOnlyActorId, actorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true)`, [importHistoryOnlyActorId]);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-single-scope-admin','synthetic-single-scope-admin@example.test','Active')`, [singleScopeActorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Admin'`, [singleScopeActorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true)`, [singleScopeActorId]);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-no-audit','synthetic-no-audit@example.test','Active')`, [auditDeniedActorId]);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-unassigned-auditor','synthetic-unassigned-auditor@example.test','Active')`, [unassignedAuditActorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Employee'`, [auditDeniedActorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true)`, [auditDeniedActorId]);
  await pool.query(`insert into users (id,username,email,password_hash,status,must_change_password)
    values ($1,'synthetic-scope-free-auditor','synthetic-scope-free-auditor@example.test',$2,'Active',true)`, [
    scopeFreeAuditorId,
    `scrypt$${scopeFreeAuditorPasswordSalt}$${scryptSync(scopeFreeAuditorPassword, scopeFreeAuditorPasswordSalt, 64).toString('hex')}`,
  ]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Employee'`, [scopeFreeAuditorId]);
  await pool.query(`insert into user_permission_grants (user_id,permission_key,granted_by,active_role)
    values ($1,'audit.deployment.view',$2,'Admin')`, [scopeFreeAuditorId, actorId]);
  await pool.query(`insert into organizations (id,code,name,effective_from)
    values ('org-scope-beta','SCOPE-BETA','Synthetic Scope Beta',date '1970-01-01')`);
  await pool.query(`insert into organization_profile_versions
      (organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,
       base_currency,fiscal_year_start,default_week_start,effective_from)
    values ('org-scope-beta','Synthetic Scope Beta LLC','Synthetic Scope Beta LLC','Synthetic WorkOS',
      'support@example.invalid','en-US','UTC','USD','01-01',1,date '1970-01-01')`);
  await pool.query(`insert into legal_entities (id,organization_id,code,name,country_code,effective_from)
    values ('legal-scope-beta','org-scope-beta','SCOPE-BETA','Synthetic Scope Beta Legal Entity','US',date '1970-01-01')`);
  await pool.query(`insert into legal_entity_profile_versions
      (legal_entity_id,organization_id,legal_name,reporting_currency,address,effective_from,country_code,status)
    values ('legal-scope-beta','org-scope-beta','Synthetic Scope Beta Legal Entity LLC','USD',
      jsonb_build_object('line1','Synthetic Test Address','city','Test City','countryCode','US'),
      date '1970-01-01','US','Active')`);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-scope-beta','legal-scope-beta',true)`, [auditDeniedActorId]);
  await pool.query(`insert into legal_entities (id,organization_id,code,name,country_code,effective_from)
    values ('legal-default-other','org-default','DEFAULT-OTHER','Synthetic Other Default Legal Entity','US',date '1970-01-01')`);
  await pool.query(`insert into legal_entity_profile_versions
      (legal_entity_id,organization_id,legal_name,reporting_currency,address,effective_from,country_code,status)
    values ('legal-default-other','org-default','Synthetic Other Default Legal Entity LLC','USD',
      jsonb_build_object('line1','Synthetic Test Address','city','Other Test City','countryCode','US'),
      date '1970-01-01','US','Active')`);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-multi-scope-admin','synthetic-multi-scope-admin@example.test','Active')`, [multiScopeActorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Admin'`, [multiScopeActorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true),($1,'org-default','legal-default-other',true),
      ($1,'org-scope-beta','legal-scope-beta',true)`, [multiScopeActorId]);
  await pool.query(`insert into country_directors (id,name,region)
    values ('cd-import-provenance-test','Synthetic Director','Synthetic') on conflict (id) do nothing`);
  await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values ('employee-scope-beta','EMP-SCOPE-BETA','Synthetic Beta Employee','beta-employee@example.test',
      'Consultant','Engineering','US','cd-import-provenance-test','Active','org-scope-beta','legal-scope-beta'),
      ('employee-cross-legal','EMP-CROSS-LEGAL-SCOPE-TEST','Synthetic Cross-Legal Employee','cross-legal-employee@example.test',
      'Consultant','Engineering','US','cd-import-provenance-test','Active','org-default','legal-default-other')`);
  await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values ('employee-allocation-target','EMP-ALLOCATION-TARGET','Synthetic Allocation Target','allocation-target@example.test',
      'Consultant','Engineering','US','cd-import-provenance-test','Active','org-default','legal-default')`);
  await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,reporting_manager_id,primary_country_director_id,status,organization_id,legal_entity_id)
    values
      ('employee-dryrun-cycle-a','EMP-DRYRUN-CYCLE-A','Synthetic Dry Run Cycle A','dryrun-cycle-a@example.test',
        'Consultant','Engineering','US','employee-allocation-target','cd-import-provenance-test','Active','org-default','legal-default'),
      ('employee-dryrun-cycle-b','EMP-DRYRUN-CYCLE-B','Synthetic Dry Run Cycle B','dryrun-cycle-b@example.test',
        'Consultant','Engineering','US','employee-allocation-target','cd-import-provenance-test','Active','org-default','legal-default')`);
  await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,reporting_manager_id,primary_country_director_id,status,organization_id,legal_entity_id)
    values
      ('employee-dryrun-exit-a','EMP-DRYRUN-EXIT-A','Synthetic Dry Run Exit Report','dryrun-exit-a@example.test',
        'Consultant','Engineering','US','employee-dryrun-exit-b','cd-import-provenance-test','Active','org-default','legal-default'),
      ('employee-dryrun-exit-b','EMP-DRYRUN-EXIT-B','Synthetic Dry Run Exit Manager','dryrun-exit-b@example.test',
        'Consultant','Engineering','US',null,'cd-import-provenance-test','Active','org-default','legal-default'),
      ('employee-dryrun-exit-c','EMP-DRYRUN-EXIT-C','Synthetic Dry Run New Manager','dryrun-exit-c@example.test',
        'Consultant','Engineering','US',null,'cd-import-provenance-test','Active','org-default','legal-default')`);
  await pool.query(`insert into audit_logs (user_id,user_name,user_role,active_role,source,module,action,entity_type,entity_id,details)
    values ('legacy-null-scope-actor','Legacy actor','Admin','Admin','Web','Legacy','Legacy Scope Row','Test','legacy-null-audit','historical row without scope')`);
  await pool.query(`insert into import_export_logs (operation,channel,file_name,status,user_name)
    values ('Import','Legacy','legacy-null-scope.csv','Success','Legacy actor')`);
  await pool.query(`insert into integration_event_logs (id,provider,event_type,entity_type,entity_id,status,response_payload)
    values ('legacy-null-scope-event','entra','LegacyScopeEvent','IdentityProviderLink','legacy-subject','Failed',
      '{"provider_subject":"legacy-subject","provider_upn":"legacy@example.test"}'::jsonb)`);
  await pool.query(`insert into teams_action_tokens (token,entity_type,entity_id,action,expires_at)
    values ('legacy-null-scope-token','PortalLink','legacy-portal','open_portal',now()+interval '1 hour')`);
  await pool.query(`insert into reporting_periods
      (id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values
      ('period-timesheet-import-week-06','org-default','legal-default','WOS03B-WEEK-2026-06',
        'Synthetic Weekly Test Period 06',date '2026-02-01',date '2026-02-07','Open','Weekly'),
      ('period-timesheet-import-week-07','org-default','legal-default','WOS03B-WEEK-2026-07',
        'Synthetic Weekly Test Period 07',date '2026-02-08',date '2026-02-14','Open','Weekly'),
      ('period-timesheet-import-week-08','org-default','legal-default','WOS03B-WEEK-2026-08',
        'Synthetic Weekly Test Period 08',date '2026-02-15',date '2026-02-21','Open','Weekly'),
      ('period-timesheet-import-week-09','org-default','legal-default','WOS03B-WEEK-2026-09',
        'Synthetic Weekly Test Period 09',date '2026-02-22',date '2026-02-28','Open','Weekly')`);

  // Exercise the real route as a signed user with an explicit organization scope and imports.manage grant.
  await withImportApi(databaseUrl, actorId, async ({baseUrl, token, tokenFor}) => {
    const scopedHeaders = (authToken, organizationId = 'org-default', legalEntityId = 'legal-default', extra = {}) => ({
      Authorization: `Bearer ${authToken}`,
      'X-Organization-ID': organizationId,
      'X-Legal-Entity-ID': legalEntityId,
      ...extra,
    });
    const multiScopeReadinessToken = tokenFor(multiScopeActorId, 'synthetic-multi-scope-admin');
    await pool.query(`insert into audit_logs
        (user_id,user_name,user_role,active_role,source,module,action,entity_type,entity_id,new_value,details)
      values
        ('legacy-import-readiness','Legacy importer','Admin','Admin','Employee Master CSV','Import',
          'Import Create Employee','Employee','legacy-import-readiness',
          '{"id":"employee-legacy-readiness","employee_id":"EMP-LEGACY-READINESS","organization_id":"org-default","legal_entity_id":"legal-default"}'::jsonb,
          'Historical employee import retained its exact scope in the saved row')`);

    const defaultReadinessResponse = await fetch(`${baseUrl}/api/organization-setup/readiness`, {
      headers: scopedHeaders(token, 'org-default', 'legal-default'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(defaultReadinessResponse.status, 200);
    const defaultReadiness = await defaultReadinessResponse.json();
    assert.equal(defaultReadiness.checks.imports, true,
      'readiness must preserve a legitimate legacy import whose saved row identifies the exact selected scope');
    const legacyReadinessAudit = await pool.query(`select organization_id,legal_entity_id,new_value
      from audit_logs where entity_id='legacy-import-readiness'`);
    assert.deepEqual(legacyReadinessAudit.rows, [{
      organization_id: null,
      legal_entity_id: null,
      new_value: {
        id: 'employee-legacy-readiness',
        employee_id: 'EMP-LEGACY-READINESS',
        organization_id: 'org-default',
        legal_entity_id: 'legal-default',
      },
    }], 'readiness compatibility must leave the historical audit row and its null scope unchanged');
    const defaultAuditResponse = await fetch(`${baseUrl}/api/audit-logs`, {
      headers: scopedHeaders(token, 'org-default', 'legal-default'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(defaultAuditResponse.status, 200);
    const defaultAuditHistory = await defaultAuditResponse.json();
    assert.equal(defaultAuditHistory.some(row => row.entity_id === 'legacy-import-readiness'), false,
      'the compatibility readiness check must not expose a null-scope legacy row in ordinary scoped history');

    const otherLegalReadinessResponse = await fetch(`${baseUrl}/api/organization-setup/readiness`, {
      headers: scopedHeaders(multiScopeReadinessToken, 'org-default', 'legal-default-other'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(otherLegalReadinessResponse.status, 200);
    const otherLegalReadiness = await otherLegalReadinessResponse.json();
    assert.equal(otherLegalReadiness.checks.imports, false,
      'an import from another legal entity in the same organization must not satisfy selected-scope readiness');

    const genericImportAuditResponse = await fetch(`${baseUrl}/api/audit-events`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeReadinessToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({
        action: 'Import',
        module: 'Import',
        details: 'Synthetic generic audit marker, not an applied import',
        entityType: 'Import',
        entityId: 'generic-import-marker-beta',
        newValue: {organization_id: 'org-scope-beta', legal_entity_id: 'legal-scope-beta'},
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(genericImportAuditResponse.status, 201,
      'the existing generic audit event endpoint remains available for its supported action');
    const betaReadinessResponse = await fetch(`${baseUrl}/api/organization-setup/readiness`, {
      headers: scopedHeaders(multiScopeReadinessToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(betaReadinessResponse.status, 200);
    const betaReadiness = await betaReadinessResponse.json();
    assert.equal(betaReadiness.checks.imports, false,
      'a generic Import audit marker must not satisfy readiness even when its scope and payload match');

    const roleMappingResponse = await fetch(`${baseUrl}/api/integrations/entra-role-mappings`, {
      method: 'POST',
      headers: scopedHeaders(token, 'org-default', 'legal-default', {'Content-Type': 'application/json'}),
      body: JSON.stringify({
        group_id: 'synthetic-deployment-role-map',
        group_name: 'Synthetic Deployment Role',
        role_name: 'Employee',
        active: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleMappingResponse.status, 200,
      'deployment-level Entra role mappings must retain their current API behavior');
    const roleMapping = await roleMappingResponse.json();
    const roleMappingAudit = await pool.query(`select organization_id,legal_entity_id
      from audit_logs where entity_type='EntraRoleMapping' and entity_id=$1`, [roleMapping.id]);
    assert.deepEqual(roleMappingAudit.rows, [{organization_id: null, legal_entity_id: null}],
      'deployment-level role mapping audit must not be attributed to the caller’s selected scope');
    const roleMappingEvent = await pool.query(`select organization_id,legal_entity_id
      from integration_event_logs where event_type='RoleMappingUpserted' and entity_id=$1`, [roleMapping.id]);
    assert.deepEqual(roleMappingEvent.rows, [{organization_id: null, legal_entity_id: null}],
      'deployment-level role mapping integration event must remain unscoped');
    for (const [authToken, organizationId, legalEntityId] of [
      [token, 'org-default', 'legal-default'],
      [multiScopeReadinessToken, 'org-scope-beta', 'legal-scope-beta'],
    ]) {
      const [auditResponse, eventResponse] = await Promise.all([
        fetch(`${baseUrl}/api/audit-logs`, {
          headers: scopedHeaders(authToken, organizationId, legalEntityId),
          signal: AbortSignal.timeout(5000),
        }),
        fetch(`${baseUrl}/api/integrations/events`, {
          headers: scopedHeaders(authToken, organizationId, legalEntityId),
          signal: AbortSignal.timeout(5000),
        }),
      ]);
      assert.equal(auditResponse.status, 200);
      assert.equal(eventResponse.status, 200);
      const [auditHistory, eventHistory] = await Promise.all([auditResponse.json(), eventResponse.json()]);
      assert.equal(auditHistory.some(row => row.entity_id === roleMapping.id), false,
        'scoped audit history must omit deployment-level role mapping mutations for every organization');
      assert.equal(eventHistory.some(row => row.entity_id === roleMapping.id), false,
        'scoped integration history must omit deployment-level role mapping mutations for every organization');
    }

    const apply = body => fetch(`${baseUrl}/api/imports/employees/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': 'legal-default',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyEmployeesV1 = (body, idempotencyKey, legalEntityId = 'legal-default') => {
      const extraHeaders = {'Content-Type': 'application/json'};
      if (idempotencyKey !== undefined) extraHeaders['Idempotency-Key'] = idempotencyKey;
      return fetch(`${baseUrl}/api/v1/imports/employees/apply`, {
        method: 'POST',
        headers: scopedHeaders(token, 'org-default', legalEntityId, extraHeaders),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    };
    const applyClients = body => fetch(`${baseUrl}/api/imports/clients/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': 'legal-default',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyClientsV1 = (body, idempotencyKey) => {
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': 'legal-default',
      };
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      return fetch(`${baseUrl}/api/v1/imports/clients/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    };
    const applyProjects = (body, legalEntityId = 'legal-default') => fetch(`${baseUrl}/api/imports/projects/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': legalEntityId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyProjectsV1 = (body, idempotencyKey, legalEntityId = 'legal-default') => {
      const headers = {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': legalEntityId,
      };
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      return fetch(baseUrl + '/api/v1/imports/projects/apply', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    };
    const saveProject = body => fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: scopedHeaders(token, 'org-default', 'legal-default', {'Content-Type': 'application/json'}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyAllocations = body => fetch(`${baseUrl}/api/imports/allocations/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': 'legal-default',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyTimesheets = body => fetch(`${baseUrl}/api/imports/timesheets/apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': 'legal-default',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const applyOperationalImportV1 = (channel, body, idempotencyKey, {
      legalEntityId = 'legal-default',
      authToken = token,
    } = {}) => {
      const headers = {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'X-Organization-ID': 'org-default',
        'X-Legal-Entity-ID': legalEntityId,
      };
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      return fetch(`${baseUrl}/api/v1/imports/${channel}/apply`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
    };

    const employeeIdempotencyKey = 'employee-master-v1-idempotency-test';
    const firstEmployeePassword = randomBytes(32).toString('base64url');
    const replayEmployeePasswordA = randomBytes(32).toString('base64url');
    const replayEmployeePasswordB = randomBytes(32).toString('base64url');
    const employeeV1Request = {
      schemaVersion: 'employee-master/1',
      fileName: `synthetic-employee-${firstEmployeePassword}.csv`,
      totalRows: 2,
      clientErrors: [{
        rowNumber: 3,
        field: 'mappedCountryDirectorIds',
        message: `Country director ${firstEmployeePassword} does not exist.`,
      }],
      rows: [{
        employeeId: 'EMP-IMPORT-V1-IDEMPOTENT',
        name: 'Synthetic Idempotent Employee',
        email: 'employee-import-v1-idempotent@example.test',
        primaryCountryDirectorId: 'cd-import-provenance-test',
        initialPassword: firstEmployeePassword,
      }],
    };
    const employeeV1Retry = initialPassword => ({
      ...employeeV1Request,
      rows: [{...employeeV1Request.rows[0], initialPassword}],
    });
    const employeeMissingKeyResponse = await applyEmployeesV1(employeeV1Request, undefined);
    assert.equal(employeeMissingKeyResponse.status, 400);
    assert.equal((await employeeMissingKeyResponse.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const employeeUnsupportedSchemaResponse = await applyEmployeesV1({
      ...employeeV1Request, schemaVersion: 'employee-master/2',
    }, 'employee-master-unsupported-schema');
    assert.equal(employeeUnsupportedSchemaResponse.status, 400);
    assert.equal((await employeeUnsupportedSchemaResponse.json()).error.code, 'UNSUPPORTED_SCHEMA_VERSION');
    const previewCredentialEcho = randomBytes(32).toString('base64url');
    const employeeDryRunRequest = {
      schemaVersion: 'employee-master/1',
      dryRun: true,
      fileName: 'Employee Master import.csv',
      totalRows: 2,
      clientErrors: [{
        rowNumber: 2,
        field: 'email',
        message: `Untrusted preview diagnostic echoed ${previewCredentialEcho}`,
        sourceIdentifier: previewCredentialEcho,
      }],
      rows: [{
        employeeId: 'EMP-IMPORT-V1-IDEMPOTENT',
        name: 'Synthetic Idempotent Employee',
        email: 'employee-import-v1-idempotent@example.test',
        primaryCountryDirectorId: 'cd-import-provenance-test',
        initialPasswordPresent: true,
      }],
    };
    const unsafeEmployeeDryRunResponse = await applyEmployeesV1({
      ...employeeDryRunRequest,
      rows: [{...employeeDryRunRequest.rows[0], initialPassword: previewCredentialEcho}],
    }, 'employee-master-dry-run-unsafe-credential');
    assert.equal(unsafeEmployeeDryRunResponse.status, 400,
      'server dry-run rejects credential values instead of accepting or retaining them');
    assert.equal((await unsafeEmployeeDryRunResponse.json()).error.code, 'EMPLOYEE_DRY_RUN_CREDENTIAL_FORBIDDEN');
    const unsafeLabelResponse = await applyEmployeesV1({
      ...employeeDryRunRequest, fileName: `synthetic-${previewCredentialEcho}.csv`,
    }, 'employee-master-dry-run-unsafe-label');
    assert.equal(unsafeLabelResponse.status, 400,
      'server dry-run requires the fixed safe batch label');
    assert.equal((await unsafeLabelResponse.json()).error.code, 'EMPLOYEE_DRY_RUN_LABEL_REQUIRED');
    const employeeDryRunKey = 'employee-master-dry-run-idempotency-test';
    const dryRunStateBefore = await pool.query(`select
        (select count(*)::int from employees where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as employee_rows,
        (select count(*)::int from users where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as user_rows,
        (select count(*)::int from user_roles ur join users u on u.id=ur.user_id where u.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as role_rows,
        (select count(*)::int from user_organization_scopes s join users u on u.id=s.user_id where u.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as scope_rows,
        (select count(*)::int from worker_profiles wp join employees e on e.id=wp.employee_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as worker_profile_rows,
        (select count(*)::int from worker_history wh join employees e on e.id=wh.employee_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as worker_history_rows`);
    const employeeDryRunResponses = await Promise.all([
      applyEmployeesV1(employeeDryRunRequest, employeeDryRunKey),
      applyEmployeesV1(employeeDryRunRequest, employeeDryRunKey),
    ]);
    assert.deepEqual(employeeDryRunResponses.map(response => response.status), [200, 200],
      'same-key Employee dry-run requests serialize and return the saved result');
    const employeeDryRunBodies = await Promise.all(employeeDryRunResponses.map(response => response.json()));
    assert.deepEqual(employeeDryRunBodies.map(body => body.replayed).sort(), [false, true],
      'Employee dry-run replay distinguishes the first accepted response from the stored result');
    assert(employeeDryRunBodies.every(body => body.status === 'Dry Run' && body.validRows === 1 && body.errorRows === 1));
    assert(employeeDryRunBodies.every(body => body.log.schema_version === 'employee-master/1' && body.log.dry_run === true));
    assert(employeeDryRunBodies.every(body => body.log.file_name === 'Employee Master import.csv'));
    assert.equal(JSON.stringify(employeeDryRunBodies).includes(previewCredentialEcho), false,
      'server dry-run response and diagnostics omit untrusted client messages/source identifiers');
    const employeeDryRunBatchId = employeeDryRunBodies[0].log.id;
    assert.equal(employeeDryRunBodies[1].log.id, employeeDryRunBatchId);
    const employeeDryRunAfter = await pool.query(`select
        (select count(*)::int from employees where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as employee_rows,
        (select count(*)::int from users where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as user_rows,
        (select count(*)::int from user_roles ur join users u on u.id=ur.user_id where u.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as role_rows,
        (select count(*)::int from user_organization_scopes s join users u on u.id=s.user_id where u.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as scope_rows,
        (select count(*)::int from worker_profiles wp join employees e on e.id=wp.employee_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as worker_profile_rows,
        (select count(*)::int from worker_history wh join employees e on e.id=wh.employee_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as worker_history_rows`);
    assert.deepEqual(employeeDryRunAfter.rows, dryRunStateBefore.rows,
      'Employee dry-run leaves employee, linked account, role, scope and lifecycle data unchanged');
    const employeeDryRunEvidence = await pool.query(`select l.file_name,l.errors,l.schema_version,l.dry_run,
        i.channel,i.request_hash,count(distinct a.id)::int as audit_rows
      from import_export_logs l
      join import_export_idempotency i on i.batch_id=l.id
      left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id,i.channel,i.request_hash`, [employeeDryRunBatchId]);
    assert.equal(employeeDryRunEvidence.rowCount, 1);
    const savedDryRun = employeeDryRunEvidence.rows[0];
    assert.equal(savedDryRun.file_name, 'Employee Master import.csv');
    assert.equal(savedDryRun.schema_version, 'employee-master/1');
    assert.equal(savedDryRun.dry_run, true);
    assert.equal(savedDryRun.channel, 'Employee Master Dry Run');
    assert.equal(savedDryRun.audit_rows, 1,
      'dry-run stores one batch audit and no per-employee row audit');
    assert.equal(JSON.stringify(savedDryRun).includes(previewCredentialEcho), false,
      'preview batch, diagnostic, idempotency channel and durable request hash retain no echoed credential text');
    assert.equal(savedDryRun.request_hash, hashEmployeeImportRequest({
      schemaVersion: 'employee-master/1',
      totalRows: 2,
      clientErrors: [{rowNumber: 2, field: 'email'}],
      rows: employeeDryRunRequest.rows,
    }), 'dry-run request identity stores only canonical nonsecret employee fields and safe error structure');
    const employeeManagerCycleBefore = await pool.query(`select id,reporting_manager_id
      from employees where id in ('employee-dryrun-cycle-a','employee-dryrun-cycle-b') order by id`);
    const employeeManagerCyclePreview = await applyEmployeesV1({
      schemaVersion: 'employee-master/1',
      dryRun: true,
      fileName: 'Employee Master import.csv',
      totalRows: 2,
      rows: [
        {...employeeDryRunRequest.rows[0], employeeId: 'EMP-DRYRUN-CYCLE-A',
          name: 'Synthetic Dry Run Cycle A', email: 'dryrun-cycle-a@example.test', reportingManagerId: 'EMP-DRYRUN-CYCLE-B'},
        {...employeeDryRunRequest.rows[0], employeeId: 'EMP-DRYRUN-CYCLE-B',
          name: 'Synthetic Dry Run Cycle B', email: 'dryrun-cycle-b@example.test', reportingManagerId: 'EMP-DRYRUN-CYCLE-A'},
      ],
    }, 'employee-master-dry-run-manager-cycle-test');
    assert.equal(employeeManagerCyclePreview.status, 200);
    const employeeManagerCycleBody = await employeeManagerCyclePreview.json();
    assert.equal(employeeManagerCycleBody.validRows, 1,
      'dry-run simulates an earlier accepted reporting-manager edge before validating later rows');
    assert.equal(employeeManagerCycleBody.errors[0].rowNumber, 3);
    assert.equal(employeeManagerCycleBody.errors[0].field, 'reportingManagerId');
    assert.equal(JSON.stringify(employeeManagerCycleBody).includes('EMP-DRYRUN-CYCLE-A'), false,
      'the manager-cycle diagnostic omits employee source identifiers');
    const employeeManagerCycleAfter = await pool.query(`select id,reporting_manager_id
      from employees where id in ('employee-dryrun-cycle-a','employee-dryrun-cycle-b') order by id`);
    assert.deepEqual(employeeManagerCycleAfter.rows, employeeManagerCycleBefore.rows,
      'manager-cycle preview performs no employee relationship changes');
    const employeeExitSimulationBefore = await pool.query(`select id,status,reporting_manager_id
      from employees where id in ('employee-dryrun-exit-a','employee-dryrun-exit-b','employee-dryrun-exit-c') order by id`);
    const employeeExitWithReportPreview = await applyEmployeesV1({
      ...employeeDryRunRequest,
      totalRows: 1,
      clientErrors: [],
      rows: [{...employeeDryRunRequest.rows[0], employeeId: 'EMP-DRYRUN-EXIT-B',
        name: 'Synthetic Dry Run Exit Manager', email: 'dryrun-exit-b@example.test',
        status: 'Exited', exitDate: '2026-10-01', reportingManagerId: undefined}],
    }, 'employee-master-dry-run-exit-with-report-test');
    assert.equal(employeeExitWithReportPreview.status, 200);
    const employeeExitWithReportBody = await employeeExitWithReportPreview.json();
    assert.equal(employeeExitWithReportBody.validRows, 0,
      'preview still refuses to exit a manager with an active report remaining in scope');
    assert.equal(employeeExitWithReportBody.errors[0].code, 'WORKER_DEPENDENCY_CONFLICT');
    const employeeExitAfterReportMovePreview = await applyEmployeesV1({
      ...employeeDryRunRequest,
      totalRows: 2,
      clientErrors: [],
      rows: [
        {...employeeDryRunRequest.rows[0], employeeId: 'EMP-DRYRUN-EXIT-A',
          name: 'Synthetic Dry Run Exit Report', email: 'dryrun-exit-a@example.test',
          reportingManagerId: 'employee-dryrun-exit-c'},
        {...employeeDryRunRequest.rows[0], employeeId: 'EMP-DRYRUN-EXIT-B',
          name: 'Synthetic Dry Run Exit Manager', email: 'dryrun-exit-b@example.test',
          status: 'Exited', exitDate: '2026-10-01', reportingManagerId: undefined},
      ],
    }, 'employee-master-dry-run-exit-after-report-move-test');
    assert.equal(employeeExitAfterReportMovePreview.status, 200);
    const employeeExitAfterReportMoveBody = await employeeExitAfterReportMovePreview.json();
    assert.equal(employeeExitAfterReportMoveBody.validRows, 2,
      'exit preflight accounts for an earlier same-file manager reassignment');
    assert.equal(employeeExitAfterReportMoveBody.errorRows, 0);
    const employeeExitSimulationAfter = await pool.query(`select id,status,reporting_manager_id
      from employees where id in ('employee-dryrun-exit-a','employee-dryrun-exit-b','employee-dryrun-exit-c') order by id`);
    assert.deepEqual(employeeExitSimulationAfter.rows, employeeExitSimulationBefore.rows,
      'exit preview simulates the report move without changing employee rows');
    const crossLegalManagerPreview = await applyEmployeesV1({
      ...employeeDryRunRequest,
      totalRows: 1,
      clientErrors: [],
      rows: [{
        ...employeeDryRunRequest.rows[0],
        employeeId: 'EMP-IMPORT-V1-MANAGER-SCOPE-TEST',
        name: 'Synthetic Employee With Out-of-Scope Manager',
        email: 'employee-import-v1-manager-scope@example.test',
        reportingManagerId: 'EMP-SCOPE-BETA',
      }],
    }, 'employee-master-dry-run-manager-scope-test');
    assert.equal(crossLegalManagerPreview.status, 200);
    const crossLegalManagerBody = await crossLegalManagerPreview.json();
    assert.equal(crossLegalManagerBody.validRows, 0,
      'Employee dry-run rejects manager references outside the selected legal entity');
    assert.equal(crossLegalManagerBody.errors[0].field, 'reportingManagerId');
    assert.equal(JSON.stringify(crossLegalManagerBody).includes('EMP-SCOPE-BETA'), false,
      'scope-conflict diagnostics do not disclose the out-of-scope employee identifier');
    assert.equal((await pool.query(`select count(*)::int as rows from employees where employee_id='EMP-IMPORT-V1-MANAGER-SCOPE-TEST'`)).rows[0].rows, 0,
      'a rejected cross-legal-entity manager reference cannot create an employee');
    const crossLegalEmployeeFixture = await pool.query(`select organization_id,legal_entity_id
      from employees where employee_id='EMP-CROSS-LEGAL-SCOPE-TEST'`);
    assert.deepEqual(crossLegalEmployeeFixture.rows, [{organization_id: 'org-default', legal_entity_id: 'legal-default-other'}],
      'the conflicting Employee identifier belongs to the selected organization but a different legal entity');
    const crossLegalEmployeePreview = await applyEmployeesV1({
      ...employeeDryRunRequest,
      totalRows: 1,
      clientErrors: [],
      rows: [{
        ...employeeDryRunRequest.rows[0],
        employeeId: 'EMP-CROSS-LEGAL-SCOPE-TEST',
        name: 'Synthetic Colliding Employee Identifier',
        email: 'employee-import-v1-cross-legal@example.test',
        reportingManagerId: undefined,
      }],
    }, 'employee-master-dry-run-cross-legal-employee-test');
    assert.equal(crossLegalEmployeePreview.status, 200);
    const crossLegalEmployeeBody = await crossLegalEmployeePreview.json();
    assert.equal(crossLegalEmployeeBody.validRows, 0,
      'Employee dry-run detects identifiers owned by another legal entity within the same organization');
    assert.equal(crossLegalEmployeeBody.errors[0].code, 'EMPLOYEE_SCOPE_CONFLICT');
    assert.equal(JSON.stringify(crossLegalEmployeeBody).includes('EMP-CROSS-LEGAL-SCOPE-TEST'), false,
      'scope conflicts use a generic safe preview diagnostic without exposing the conflicting identifier');
    const changedDryRunPresence = await applyEmployeesV1({
      ...employeeDryRunRequest,
      rows: [{...employeeDryRunRequest.rows[0], initialPasswordPresent: false}],
    }, employeeDryRunKey);
    assert.equal(changedDryRunPresence.status, 409,
      'a changed non-secret credential-presence indicator conflicts under a reused preview key');
    assert.equal((await changedDryRunPresence.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await pool.query(`select count(*)::int as batches from import_export_logs where id=$1`, [employeeDryRunBatchId])).rows[0].batches, 1,
      'replayed or conflicting preview requests create no additional batches');
    const missingPreviewCredential = await applyEmployeesV1({
      ...employeeDryRunRequest,
      clientErrors: [],
      rows: [{...employeeDryRunRequest.rows[0], initialPasswordPresent: false}],
    }, 'employee-master-dry-run-missing-initial-password');
    assert.equal(missingPreviewCredential.status, 200);
    const missingPreviewCredentialBody = await missingPreviewCredential.json();
    assert.equal(missingPreviewCredentialBody.validRows, 0);
    assert.equal(missingPreviewCredentialBody.errors[0].field, 'initialPassword');
    assert.equal(missingPreviewCredentialBody.errors[0].message,
      'A new employee account requires an initial password before apply.');
    assert.equal(JSON.stringify(missingPreviewCredentialBody).includes(previewCredentialEcho), false);
    assert.equal((await pool.query(`select count(*)::int as rows from employees where employee_id='EMP-IMPORT-V1-IDEMPOTENT'`)).rows[0].rows, 0,
      'Employee Master preview and rejected requests must not write employee rows');
    const employeeRequestHash = hashEmployeeImportRequest(employeeV1Request);
    assert.equal(employeeRequestHash, hashEmployeeImportRequest(employeeV1Retry(replayEmployeePasswordA)),
      'Employee password-only retries retain the first request’s unchanged filename and diagnostic text without fingerprinting either');
    assert.notEqual(employeeRequestHash, hashImportRequest(employeeV1Request),
      'Employee Master durable request identity must not include the submitted credential');
    const employeeV1FirstResponse = await applyEmployeesV1(employeeV1Request, employeeIdempotencyKey);
    assert.equal(employeeV1FirstResponse.status, 200);
    const employeeV1FirstBody = await employeeV1FirstResponse.json();
    assert.equal(employeeV1FirstBody.status, 'Partial');
    assert.equal(employeeV1FirstBody.replayed, false, 'the initial Employee Master v1 result is explicitly marked as first accepted');
    assert.equal(JSON.stringify(employeeV1FirstBody.errors).includes(firstEmployeePassword), false,
      'Employee Master response diagnostics must redact a submitted credential echoed in client errors');
    assert.equal(employeeV1FirstBody.log.schema_version, 'employee-master/1');
    assert.equal(employeeV1FirstBody.log.dry_run, false);
    assert.equal(employeeV1FirstBody.log.file_name, 'Employee Master import.csv',
      'versioned Employee batches use a server-controlled safe label instead of retaining an arbitrary submitted filename');
    assert.equal(employeeV1FirstBody.errors[0].message, 'The Employee Master row failed preflight validation.',
      'versioned Employee batch history uses server-controlled preflight text');
    assert.equal(JSON.stringify(employeeV1FirstBody).includes(firstEmployeePassword), false,
      'the versioned Employee Master result must not return the submitted credential');
    const employeeV1FirstBatchId = employeeV1FirstBody.log.id;
    const employeeV1InitialState = await pool.query(`select
        (select u.password_hash from users u join employees e on e.id=u.employee_record_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as password_hash,
        (select count(*)::int from employees where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as employee_rows,
        (select count(*)::int from users where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as user_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows,
        (select count(*)::int from import_export_logs where id=$1) as batch_rows,
        (select count(*)::int from import_export_idempotency where batch_id=$1) as idempotency_rows`,
    [employeeV1FirstBatchId]);
    const initialState = employeeV1InitialState.rows[0];
    assert.deepEqual({employee_rows: initialState.employee_rows, user_rows: initialState.user_rows,
      audit_rows: initialState.audit_rows, batch_rows: initialState.batch_rows, idempotency_rows: initialState.idempotency_rows},
    {employee_rows: 1, user_rows: 1, audit_rows: 1, batch_rows: 1, idempotency_rows: 1},
    'the first Employee Master v1 result, employee/user writes, audit and idempotency row commit atomically');
    assert.equal(typeof initialState.password_hash, 'string');
    const employeeV1Idempotency = await pool.query(`select request_hash from import_export_idempotency where batch_id=$1`,
      [employeeV1FirstBatchId]);
    assert.deepEqual(employeeV1Idempotency.rows, [{request_hash: employeeRequestHash}],
      'the durable retry record stores the canonical password-omitting request hash only');
    assert.equal(JSON.stringify(employeeV1Idempotency.rows).includes(firstEmployeePassword), false);

    const employeeConcurrentReplayResponses = await Promise.all([
      applyEmployeesV1(employeeV1Retry(replayEmployeePasswordA), employeeIdempotencyKey),
      applyEmployeesV1(employeeV1Retry(replayEmployeePasswordB), employeeIdempotencyKey),
    ]);
    assert.deepEqual(employeeConcurrentReplayResponses.map(response => response.status), [200, 200],
      'concurrent password-only retries must both return the first accepted result');
    const employeeConcurrentReplayBodies = await Promise.all(employeeConcurrentReplayResponses.map(response => response.json()));
    assert(employeeConcurrentReplayBodies.every(body => body.replayed === true),
      'same-key Employee Master replay responses identify the saved first result');
    assert(employeeConcurrentReplayBodies.every(body => body.log.id === employeeV1FirstBatchId),
      'password-only retries must replay the same persisted import batch');
    assert(employeeConcurrentReplayBodies.every(body => body.validRows === employeeV1FirstBody.validRows
      && body.errorRows === employeeV1FirstBody.errorRows && body.status === employeeV1FirstBody.status));
    const employeeChangedCanonicalResponse = await applyEmployeesV1({
      ...employeeV1Request,
      rows: [{...employeeV1Request.rows[0], name: 'Changed Synthetic Idempotent Employee'}],
    }, employeeIdempotencyKey);
    assert.equal(employeeChangedCanonicalResponse.status, 409,
      'changing a non-credential Employee Master field under the same key must conflict');
    assert.equal((await employeeChangedCanonicalResponse.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
    const employeeV1FinalState = await pool.query(`select
        (select u.password_hash from users u join employees e on e.id=u.employee_record_id where e.employee_id='EMP-IMPORT-V1-IDEMPOTENT') as password_hash,
        (select count(*)::int from employees where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as employee_rows,
        (select count(*)::int from users where employee_id='EMP-IMPORT-V1-IDEMPOTENT') as user_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows,
        (select count(*)::int from import_export_logs where id=$1) as batch_rows,
        (select count(*)::int from import_export_idempotency where batch_id=$1) as idempotency_rows`,
    [employeeV1FirstBatchId]);
    assert.deepEqual(employeeV1FinalState.rows[0], initialState,
      'password-only replay and changed-field conflict must not change credentials or create duplicate domain, audit, batch or idempotency records');
    const employeeV1SavedEvidence = await pool.query(`select l.file_name,l.errors,a.details,a.new_value
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id where l.id=$1`, [employeeV1FirstBatchId]);
    assert.equal(JSON.stringify(employeeV1SavedEvidence.rows).includes(firstEmployeePassword), false,
      'the persisted batch and audit evidence must not contain the submitted credential');
    assert.equal(JSON.stringify(employeeV1SavedEvidence.rows).includes(replayEmployeePasswordA), false);
    assert.equal(JSON.stringify(employeeV1SavedEvidence.rows).includes(replayEmployeePasswordB), false);

    const legacyEmployeeEchoPassword = randomBytes(32).toString('base64url');
    const legacyEchoResponse = await apply({
      fileName: `synthetic-legacy-${legacyEmployeeEchoPassword}.csv`,
      totalRows: 1,
      clientErrors: [{rowNumber: 3, field: 'email', message: `Legacy diagnostic echoed ${legacyEmployeeEchoPassword}.`}],
      rows: [{
        employeeId: 'EMP-IMPORT-LEGACY-REDACTION',
        name: 'Synthetic Legacy Redaction Employee',
        email: 'employee-import-legacy-redaction@example.test',
        primaryCountryDirectorId: 'cd-import-provenance-test',
        initialPassword: legacyEmployeeEchoPassword,
      }],
    });
    assert.equal(legacyEchoResponse.status, 200);
    const legacyEchoBody = await legacyEchoResponse.json();
    assert.equal(Object.hasOwn(legacyEchoBody, 'replayed'), false,
      'the legacy Employee Master response shape remains unchanged');
    assert.equal(JSON.stringify(legacyEchoBody).includes(legacyEmployeeEchoPassword), false,
      'legacy Employee Master responses must redact credentials echoed in filenames or diagnostics');
    const legacyEchoSavedEvidence = await pool.query(`select l.file_name,l.errors,a.details,a.new_value
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id where l.id=$1`, [legacyEchoBody.log.id]);
    assert.equal(JSON.stringify(legacyEchoSavedEvidence.rows).includes(legacyEmployeeEchoPassword), false,
      'legacy Employee Master history and audit must not retain credentials echoed in filenames or diagnostics');

    const partialResponse = await apply({
      fileName: 'synthetic-partial.csv',
      totalRows: 3,
      clientErrors: [{
        rowNumber: 2,
        field: 'email',
        message: 'Email is required.',
        sourceIdentifier: 'EMP-IMPORT-PREFLIGHT-FAILED',
      }],
      rows: [
        {
          employeeId: 'EMP-IMPORT-FAILED',
          name: 'Synthetic Failed Row',
          email: 'employee-import-failed@example.test',
        },
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          joiningDate: '2025-01-01',
          name: 'Synthetic Success Row',
          email: 'employee-import-success@example.test',
          primaryCountryDirectorId: 'cd-import-provenance-test',
          initialPassword: randomBytes(32).toString('base64url'),
        },
      ],
    });
    assert.equal(partialResponse.status, 200);
    const partialBody = await partialResponse.json();
    assert.equal(Object.hasOwn(partialBody.log, 'schema_version'), false,
      'the legacy Employee Master apply response must preserve its established batch DTO');
    assert.equal(Object.hasOwn(partialBody.log, 'dry_run'), false,
      'the legacy Employee Master response must not gain versioned operation fields');
    assert.deepEqual({status: partialBody.status, totalRows: partialBody.totalRows,
      validRows: partialBody.validRows, errorRows: partialBody.errorRows},
    {status: 'Partial', totalRows: 3, validRows: 1, errorRows: 2},
    'the real employee apply route must preserve its partial result counts');
    assert.deepEqual(partialBody.errors, [{
      rowNumber: 2,
      field: 'email',
      message: 'Email is required.',
      sourceIdentifier: 'EMP-IMPORT-PREFLIGHT-FAILED',
    }, {
      rowNumber: 3,
      field: 'primaryCountryDirectorId',
      message: 'Primary country director is required.',
      sourceIdentifier: 'EMP-IMPORT-FAILED',
    }], 'the real employee apply route must preserve its existing row-error shape');
    const partialLog = (await pool.query(`select * from import_export_logs where id=$1`, [partialBody.log.id])).rows[0];
    const partialAudit = await pool.query(`select source,source_identifier,import_batch_id,import_processing_result,details,organization_id,legal_entity_id
      from audit_logs where import_batch_id=$1`, [partialBody.log.id]);
    assert.equal(partialLog.status, 'Partial');
    assert.equal(partialLog.total_rows, 3);
    assert.equal(partialLog.valid_rows, 1);
    assert.equal(partialLog.error_rows, 2);
    assert.deepEqual(partialLog.errors, partialBody.errors,
      'employee rejection identifiers and original row numbers must match between HTTP response and persisted history');
    assert.doesNotMatch(JSON.stringify(partialLog.errors), /employee-failed@example\.test|Synthetic Failed Row/,
      'rejection provenance must not retain raw CSV fields');
    assert.equal(partialLog.organization_id, 'org-default');
    assert.equal(partialLog.legal_entity_id, 'legal-default');
    assert.equal(partialAudit.rowCount, 1, 'a partial batch must audit only the successful row');
    assert.deepEqual(partialAudit.rows[0], {
      source: 'Employee Master CSV',
      source_identifier: 'EMP-IMPORT-SUCCESS',
      import_batch_id: partialBody.log.id,
      import_processing_result: 'Success',
      details: 'Created employee master record from CSV import',
      organization_id: 'org-default',
      legal_entity_id: 'legal-default',
    }, 'the persisted success audit must link source, identifier, result and batch');
    assert.doesNotMatch(partialAudit.rows[0].details, /EMP-IMPORT-SUCCESS|synthetic-partial\.csv/,
      'audit details must not duplicate row identifiers or expose uploaded file contents');

    const malformedIdentifierResponse = await apply({
      fileName: 'synthetic-malformed-error-id.csv',
      totalRows: 1,
      rows: [{
        employeeId: 'EMP-IMPORT-MALFORMED-ERROR',
        name: 'Synthetic Malformed Error ID',
        email: 'employee-malformed-error@example.test',
      }],
      clientErrors: [{rowNumber: 2, field: 'email', message: 'Invalid.', sourceIdentifier: `EMP-${'X'.repeat(200)}`}],
    });
    assert.equal(malformedIdentifierResponse.status, 400,
      'an overlong client-supplied source identifier must fail validation before import side effects');

    const failedResponse = await apply({
      fileName: 'synthetic-failed.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-ALL-FAILED',
        name: 'Synthetic Failed Batch Row',
        email: 'employee-import-all-failed@example.test',
      }],
    });
    assert.equal(failedResponse.status, 200);
    const failedBody = await failedResponse.json();
    assert.equal(failedBody.status, 'Failed');
    assert.equal(failedBody.validRows, 0);
    assert.equal(failedBody.errorRows, 1);
    const failedBatch = await pool.query(`select l.status,count(a.id)::int as audit_rows
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id`, [failedBody.log.id]);
    assert.deepEqual(failedBatch.rows, [{status: 'Failed', audit_rows: 0}],
      'a validation-failed batch must retain its result without success audit events');

    await pool.query(`create or replace function reject_synthetic_employee_import_log()
      returns trigger language plpgsql as $$ begin
        if new.file_name='synthetic-rollback.csv' then raise exception 'synthetic import-log failure'; end if;
        return new;
      end; $$`);
    await pool.query(`create trigger reject_synthetic_employee_import_log
      before insert on import_export_logs for each row execute function reject_synthetic_employee_import_log()`);
    const rollbackResponse = await apply({
      fileName: 'synthetic-rollback.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-ROLLBACK',
        name: 'Synthetic Rolled Back Row',
        email: 'employee-import-rollback@example.test',
        primaryCountryDirectorId: 'cd-import-provenance-test',
        initialPassword: randomBytes(32).toString('base64url'),
      }],
    });
    assert.equal(rollbackResponse.status, 500, 'a failed batch-log write must return the legacy generic failure');
    assert.deepEqual(await rollbackResponse.json(), {error: 'Employee import apply failed'});
    const rollbackRows = await pool.query(`select
        (select count(*)::int from employees where employee_id='EMP-IMPORT-ROLLBACK') as employee_rows,
        (select count(*)::int from audit_logs where source_identifier='EMP-IMPORT-ROLLBACK') as audit_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-rollback.csv') as batch_rows`);
    assert.deepEqual(rollbackRows.rows, [{employee_rows: 0, audit_rows: 0, batch_rows: 0}],
      'an import-log failure must roll back employee writes and row audits with no orphan batch reference');

    const clientPartialResponse = await applyClients({
      fileName: 'synthetic-client-partial.csv',
      totalRows: 3,
      rows: [
        {id: 'client-import-source-1', name: 'Synthetic Client With Source ID'},
        {name: 'Synthetic Client Without Source ID'},
        {id: 'client-import-rejected', name: 'Synthetic Client Rejected', accountOwnerId: 'missing-owner'},
      ],
    });
    assert.equal(clientPartialResponse.status, 200);
    const clientPartialBody = await clientPartialResponse.json();
    assert.equal(Object.hasOwn(clientPartialBody.log, 'schema_version'), false,
      'the legacy Client Master apply response must preserve its established batch DTO');
    assert.equal(Object.hasOwn(clientPartialBody.log, 'dry_run'), false,
      'new import contract fields must not change the legacy Client Master apply response');
    assert.deepEqual({status: clientPartialBody.status, totalRows: clientPartialBody.totalRows,
      validRows: clientPartialBody.validRows, errorRows: clientPartialBody.errorRows},
    {status: 'Partial', totalRows: 3, validRows: 2, errorRows: 1},
    'the real client apply route must preserve its partial batch counts');
    assert.deepEqual(clientPartialBody.errors, [{
      rowNumber: 4,
      field: 'accountOwnerId',
      message: 'Account owner employee record does not exist or is exited.',
      sourceIdentifier: 'client-import-rejected',
    }], 'the real client apply route must preserve its row-error shape');
    const clientPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [clientPartialBody.log.id])).rows[0];
    assert.equal(clientPartialLog.id, clientPartialBody.log.id, 'client batch history must return its persisted server batch ID');
    assert.equal(clientPartialLog.status, 'Partial');
    assert.equal(clientPartialLog.organization_id, 'org-default');
    assert.equal(clientPartialLog.legal_entity_id, 'legal-default');
    assert.equal(clientPartialLog.total_rows, 3);
    assert.equal(clientPartialLog.valid_rows, 2);
    assert.equal(clientPartialLog.error_rows, 1);
    assert.deepEqual(clientPartialLog.errors, clientPartialBody.errors,
      'client rejection identifier must match between HTTP response and persisted history');
    const clientPartialAudit = await pool.query(`select source,source_identifier,import_batch_id,import_processing_result,details
      from audit_logs where import_batch_id=$1 order by source_identifier nulls last`, [clientPartialBody.log.id]);
    assert.equal(clientPartialAudit.rowCount, 2, 'a partial client batch must audit only the successful rows');
    assert.deepEqual(clientPartialAudit.rows, [
      {
        source: 'Client Master CSV',
        source_identifier: 'client-import-source-1',
        import_batch_id: clientPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created client Synthetic Client With Source ID from synthetic-client-partial.csv',
      },
      {
        source: 'Client Master CSV',
        source_identifier: null,
        import_batch_id: clientPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created client Synthetic Client Without Source ID from synthetic-client-partial.csv',
      },
    ], 'client row audits must retain the input source ID only when supplied and link to the same batch');

    const clientLegacyBlankId = await applyClients({
      fileName: 'synthetic-client-legacy-blank-id.csv',
      rows: [{id: '', name: 'Synthetic Client Legacy Blank ID'}],
    });
    assert.equal(clientLegacyBlankId.status, 400,
      'legacy Client Master requests must retain strict blank-ID validation');
    const clientLegacyBlankStatus = await applyClients({
      fileName: 'synthetic-client-legacy-blank-status.csv',
      rows: [{name: 'Synthetic Client Legacy Blank Status', status: ''}],
    });
    assert.equal(clientLegacyBlankStatus.status, 400,
      'legacy Client Master requests must retain strict blank-status validation');

    const clientFailedResponse = await applyClients({
      fileName: 'synthetic-client-failed.csv',
      rows: [{name: 'Synthetic Client Failed Batch', accountOwnerId: 'missing-owner'}],
    });
    assert.equal(clientFailedResponse.status, 200);
    const clientFailedBody = await clientFailedResponse.json();
    assert.equal(clientFailedBody.status, 'Failed');
    assert.equal(clientFailedBody.validRows, 0);
    assert.equal(clientFailedBody.errorRows, 1);
    assert.equal(clientFailedBody.errors[0].sourceIdentifier, null,
      'a rejected client row without an upstream ID must retain null provenance');
    const clientFailedLog = (await pool.query(`select errors from import_export_logs where id=$1`, [clientFailedBody.log.id])).rows[0];
    assert.deepEqual(clientFailedLog.errors, clientFailedBody.errors,
      'failed client import history must preserve its null source-ID response shape');
    const clientFailedBatch = await pool.query(`select l.status,count(a.id)::int as audit_rows
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id`, [clientFailedBody.log.id]);
    assert.deepEqual(clientFailedBatch.rows, [{status: 'Failed', audit_rows: 0}],
      'a client batch with no saved rows must retain its failed result without success audit events');

    const clientV1DryRunKey = 'synthetic-client-v1-dry-run-0001';
    const clientV1DryRunBody = {
      schemaVersion: 'client-master/1',
      dryRun: true,
      fileName: 'synthetic-client-v1-dry-run.csv',
      totalRows: 2,
      rows: [
        {id: 'client-v1-dry-run-valid', name: 'Synthetic Client Dry Run Valid', countryDirectorIds: 'cd-import-provenance-test'},
        {id: 'client-v1-dry-run-rejected', name: 'Synthetic Client Dry Run Rejected', accountOwnerId: 'missing-owner'},
      ],
    };
    const clientV1DryRunResponse = await applyClientsV1(clientV1DryRunBody, clientV1DryRunKey);
    assert.equal(clientV1DryRunResponse.status, 200, 'the versioned client route must accept a schema-tagged dry run');
    const clientV1DryRunResult = await clientV1DryRunResponse.json();
    assert.deepEqual({status: clientV1DryRunResult.status, totalRows: clientV1DryRunResult.totalRows,
      validRows: clientV1DryRunResult.validRows, errorRows: clientV1DryRunResult.errorRows},
    {status: 'Dry Run', totalRows: 2, validRows: 1, errorRows: 1},
    'client dry-run results must report valid and rejected rows without applying them');
    assert.deepEqual(clientV1DryRunResult.errors, [{
      rowNumber: 3,
      field: 'accountOwnerId',
      message: 'Account owner employee record does not exist or is exited.',
      sourceIdentifier: 'client-v1-dry-run-rejected',
    }], 'client dry-run validation must preserve row diagnostics and source identifiers');
    assert.equal(clientV1DryRunResult.log.schema_version, 'client-master/1');
    assert.equal(clientV1DryRunResult.log.dry_run, true);
    const clientV1DryRunState = await pool.query(`select
        (select count(*)::int from clients where id in ('client-v1-dry-run-valid','client-v1-dry-run-rejected')) as client_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows,
        (select count(*)::int from import_export_idempotency where batch_id=$1) as idempotency_rows
      from import_export_logs where id=$1`, [clientV1DryRunResult.log.id]);
    assert.deepEqual(clientV1DryRunState.rows, [{client_rows: 0, audit_rows: 1, idempotency_rows: 1}],
      'client dry run must write only its batch/audit/idempotency evidence, never client rows');
    const clientV1DryRunReplay = await applyClientsV1(clientV1DryRunBody, clientV1DryRunKey);
    const clientV1DryRunReplayBody = await clientV1DryRunReplay.json();
    assert.equal(clientV1DryRunReplay.status, 200);
    assert.equal(clientV1DryRunReplayBody.log.id, clientV1DryRunResult.log.id,
      'an identical client dry-run retry must replay the original batch');
    assert.equal((await pool.query(`select count(*)::int as count from import_export_logs where file_name=$1`,
      [clientV1DryRunBody.fileName])).rows[0].count, 1,
    'an identical dry-run replay must not create a second history batch');

    const clientBlankOptionalFieldsBody = {
      schemaVersion: 'client-master/1',
      dryRun: true,
      fileName: 'synthetic-client-v1-blank-optional-fields.csv',
      totalRows: 1,
      rows: [{id: '', name: 'Synthetic Client Blank Optional Fields', industry: '', accountOwnerId: '', countryDirectorIds: '', status: ''}],
    };
    const clientBlankOptionalFieldsResponse = await applyClientsV1(
      clientBlankOptionalFieldsBody,
      'synthetic-client-v1-blank-optional-fields-dry-run',
    );
    assert.equal(clientBlankOptionalFieldsResponse.status, 200,
      'blank optional Client Master ID and status cells must be treated as omitted during server dry run');
    const clientBlankOptionalFieldsResult = await clientBlankOptionalFieldsResponse.json();
    assert.deepEqual({status: clientBlankOptionalFieldsResult.status, validRows: clientBlankOptionalFieldsResult.validRows,
      errorRows: clientBlankOptionalFieldsResult.errorRows}, {status: 'Dry Run', validRows: 1, errorRows: 0});
    assert.equal((await pool.query(`select count(*)::int as count from clients
      where name='Synthetic Client Blank Optional Fields' and organization_id='org-default' and legal_entity_id='legal-default'`)).rows[0].count, 0,
    'a blank optional Client Master dry run must not write its client row');
    const clientBlankOptionalFieldsReplay = await applyClientsV1({
      ...clientBlankOptionalFieldsBody,
      rows: [{name: 'Synthetic Client Blank Optional Fields', industry: '', accountOwnerId: '', countryDirectorIds: ''}],
    }, 'synthetic-client-v1-blank-optional-fields-dry-run');
    assert.equal(clientBlankOptionalFieldsReplay.status, 200,
      'blank optional cells and omitted optional values must canonicalize to the same idempotent dry-run request');
    assert.equal((await clientBlankOptionalFieldsReplay.json()).log.id, clientBlankOptionalFieldsResult.log.id);
    const clientBlankOptionalFieldsApplyResponse = await applyClientsV1({
      ...clientBlankOptionalFieldsBody,
      dryRun: false,
    }, 'synthetic-client-v1-blank-optional-fields-apply');
    assert.equal(clientBlankOptionalFieldsApplyResponse.status, 200,
      'blank optional Client Master ID and status cells must be accepted on apply');
    const clientBlankOptionalFieldsApply = await clientBlankOptionalFieldsApplyResponse.json();
    assert.equal(clientBlankOptionalFieldsApply.status, 'Success');
    const clientBlankOptionalFieldsStored = await pool.query(`select id,status from clients
      where name='Synthetic Client Blank Optional Fields' and organization_id='org-default' and legal_entity_id='legal-default'`);
    assert.equal(clientBlankOptionalFieldsStored.rowCount, 1);
    assert.match(clientBlankOptionalFieldsStored.rows[0].id, /^client-/,
      'an omitted Client Master ID must continue to use the server-generated ID path');
    assert.equal(clientBlankOptionalFieldsStored.rows[0].status, 'Active',
      'an omitted Client Master status must use the existing default');
    const clientV1ChangedDryRunResponse = await applyClientsV1({
      ...clientV1DryRunBody,
      rows: clientV1DryRunBody.rows.map((row, index) => index === 0 ? {...row, name: 'Changed Client Under Reused Key'} : row),
    }, clientV1DryRunKey);
    assert.equal(clientV1ChangedDryRunResponse.status, 409,
      'changed canonical client input must conflict under a reused idempotency key');
    assertVersionedErrorResponse(clientV1ChangedDryRunResponse, await clientV1ChangedDryRunResponse.json(), {
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This Idempotency-Key was already used with a different request.',
    });

    const clientV1UpdateDryRunResponse = await applyClientsV1({
      schemaVersion: 'client-master/1',
      dryRun: true,
      fileName: 'synthetic-client-v1-update-dry-run.csv',
      totalRows: 1,
      rows: [{id: 'client-import-source-1', name: 'Must Not Replace Existing Client', countryDirectorIds: 'cd-import-provenance-test'}],
    }, 'synthetic-client-v1-update-dry-run-0001');
    assert.equal(clientV1UpdateDryRunResponse.status, 200);
    const clientV1UpdateDryRun = await clientV1UpdateDryRunResponse.json();
    assert.equal(clientV1UpdateDryRun.status, 'Dry Run');
    const clientV1UpdateNoWriteState = await pool.query(`select c.name,
        (select count(*)::int from client_country_director_map where client_id=c.id) as director_links,
        (select count(*)::int from projects where client_id=c.id) as linked_projects
      from clients c where c.id='client-import-source-1'`);
    assert.deepEqual(clientV1UpdateNoWriteState.rows, [{
      name: 'Synthetic Client With Source ID', director_links: 0, linked_projects: 0,
    }], 'a dry run against an existing client must not update the client, director links or project associations');

    const clientV1ApplyKey = 'synthetic-client-v1-apply-0001';
    const clientV1ApplyBody = {
      ...clientV1DryRunBody,
      dryRun: false,
      fileName: 'synthetic-client-v1-apply.csv',
      rows: [clientV1DryRunBody.rows[0]],
      totalRows: 1,
    };
    const clientV1ApplyResponse = await applyClientsV1(clientV1ApplyBody, clientV1ApplyKey);
    assert.equal(clientV1ApplyResponse.status, 200);
    const clientV1ApplyResult = await clientV1ApplyResponse.json();
    assert.deepEqual({status: clientV1ApplyResult.status, validRows: clientV1ApplyResult.validRows,
      errorRows: clientV1ApplyResult.errorRows, dryRun: clientV1ApplyResult.log.dry_run,
      schemaVersion: clientV1ApplyResult.log.schema_version},
    {status: 'Success', validRows: 1, errorRows: 0, dryRun: false, schemaVersion: 'client-master/1'},
    'versioned client apply must persist schema and non-dry-run result metadata');
    assert.deepEqual((await pool.query(`select id,name,organization_id,legal_entity_id from clients where id=$1`,
      ['client-v1-dry-run-valid'])).rows, [{
      id: 'client-v1-dry-run-valid',
      name: 'Synthetic Client Dry Run Valid',
      organization_id: 'org-default',
      legal_entity_id: 'legal-default',
    }], 'the versioned apply path must persist the previously dry-run validated client in its selected scope');
    const clientV1ApplyReplay = await applyClientsV1(clientV1ApplyBody, clientV1ApplyKey);
    const clientV1ApplyReplayBody = await clientV1ApplyReplay.json();
    assert.equal(clientV1ApplyReplay.status, 200);
    assert.equal(clientV1ApplyReplayBody.log.id, clientV1ApplyResult.log.id,
      'an identical client apply retry must return the original batch');
    const clientV1ChangedApplyResponse = await applyClientsV1({
      ...clientV1ApplyBody,
      rows: [{...clientV1ApplyBody.rows[0], name: 'Changed Client Under Applied Key'}],
    }, clientV1ApplyKey);
    assert.equal(clientV1ChangedApplyResponse.status, 409,
      'changed client apply input must conflict under the same idempotency key');

    const clientV1ConcurrentBody = {
      ...clientV1ApplyBody,
      fileName: 'synthetic-client-v1-concurrent.csv',
      rows: [{id: 'client-v1-concurrent', name: 'Synthetic Concurrent Client'}],
    };
    const clientV1ConcurrentResponses = await Promise.all([
      applyClientsV1(clientV1ConcurrentBody, 'synthetic-client-v1-concurrent-0001'),
      applyClientsV1(clientV1ConcurrentBody, 'synthetic-client-v1-concurrent-0001'),
    ]);
    assert.deepEqual(clientV1ConcurrentResponses.map(response => response.status), [200, 200],
      'concurrent identical client requests must both resolve from the idempotent operation');
    const clientV1ConcurrentResults = await Promise.all(clientV1ConcurrentResponses.map(response => response.json()));
    assert.equal(clientV1ConcurrentResults[0].log.id, clientV1ConcurrentResults[1].log.id,
      'concurrent identical client requests must return the same persisted batch');
    const clientV1ConcurrentState = await pool.query(`select
        (select count(*)::int from clients where id='client-v1-concurrent') as client_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-client-v1-concurrent.csv') as batch_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows,
        (select count(*)::int from import_export_idempotency where batch_id=$1) as idempotency_rows`,
    [clientV1ConcurrentResults[0].log.id]);
    assert.deepEqual(clientV1ConcurrentState.rows, [{client_rows: 1, batch_rows: 1, audit_rows: 1, idempotency_rows: 1}],
      'concurrent client retries must write one client, one audit, one batch and one idempotency record');

    const clientV1MissingKeyResponse = await applyClientsV1({schemaVersion: 'client-master/1', fileName: 'missing-key.csv', rows: []});
    assert.equal(clientV1MissingKeyResponse.status, 400, 'versioned client apply must require an idempotency key');
    assertVersionedErrorResponse(clientV1MissingKeyResponse, await clientV1MissingKeyResponse.json(), {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    });
    const clientV1UnsupportedSchemaResponse = await applyClientsV1({
      schemaVersion: 'client-master/999', dryRun: true, fileName: 'unsupported-schema.csv', rows: [],
    }, 'synthetic-client-v1-unsupported-schema');
    assert.equal(clientV1UnsupportedSchemaResponse.status, 400, 'versioned client import must reject unknown schemas before side effects');
    assertVersionedErrorResponse(clientV1UnsupportedSchemaResponse, await clientV1UnsupportedSchemaResponse.json(), {
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: 'The client import schema version is not supported.',
    });
    const clientV1InvalidNonblankOption = await applyClientsV1({
      schemaVersion: 'client-master/1', dryRun: true, fileName: 'invalid-nonblank-client-option.csv',
      rows: [{id: '   ', name: 'Synthetic Client Invalid Option', status: 'Archived'}],
    }, 'synthetic-client-v1-invalid-nonblank-option');
    assert.equal(clientV1InvalidNonblankOption.status, 400,
      'nonblank invalid Client Master status values must still fail schema validation');
    assertVersionedErrorResponse(clientV1InvalidNonblankOption, await clientV1InvalidNonblankOption.json(), {
      code: 'INVALID_IMPORT_REQUEST',
      message: 'The client import request is invalid.',
    });

    await pool.query(`insert into organizations (id,code,name,effective_from)
      values ('org-client-outside','CLIENT-OUTSIDE','Synthetic Client Outside Organization',date '1970-01-01')`);
    await pool.query(`insert into legal_entities (id,organization_id,code,name,effective_from)
      values ('legal-client-outside','org-client-outside','CLIENT-OUTSIDE','Synthetic Client Outside Legal Entity',date '1970-01-01')`);
    await pool.query(`insert into clients (id,name,industry,status,organization_id,legal_entity_id)
      values ('client-import-cross-scope','Synthetic Client Outside Scope','Outside Industry','Active','org-client-outside','legal-client-outside')`);
    const clientCrossScopeResponse = await applyClients({
      fileName: 'synthetic-client-cross-scope.csv',
      rows: [{id: 'client-import-cross-scope', name: 'Synthetic Client Outside Scope', industry: 'Unauthorized Change'}],
    });
    assert.equal(clientCrossScopeResponse.status, 200);
    const clientCrossScopeBody = await clientCrossScopeResponse.json();
    assert.equal(clientCrossScopeBody.status, 'Failed');
    assert.equal(clientCrossScopeBody.validRows, 0);
    assert.deepEqual(clientCrossScopeBody.errors, [{
      rowNumber: 2,
      field: 'id',
      message: 'Client is not available in the authorized organization and legal entity.',
      sourceIdentifier: 'client-import-cross-scope',
    }], 'the client apply route must preserve its existing non-disclosing cross-scope error');
    const clientCrossScopeState = await pool.query(`select c.name,c.industry,c.organization_id,c.legal_entity_id,
        count(a.id)::int as audit_rows
      from clients c left join audit_logs a on a.source_identifier='client-import-cross-scope'
      where c.id='client-import-cross-scope'
      group by c.id`);
    assert.deepEqual(clientCrossScopeState.rows, [{
      name: 'Synthetic Client Outside Scope',
      industry: 'Outside Industry',
      organization_id: 'org-client-outside',
      legal_entity_id: 'legal-client-outside',
      audit_rows: 0,
    }], 'a cross-scope client import must not update the foreign row or write an audit event');

    await pool.query(`insert into legal_entities (id,organization_id,code,name,effective_from)
      values ('legal-client-outside-same-org','org-default','CLIENT-OTHER-LEGAL','Synthetic Other Legal Entity',date '1970-01-01')`);
    await pool.query(`insert into legal_entity_profile_versions
        (legal_entity_id,organization_id,legal_name,reporting_currency,address,effective_from,country_code,status)
      values ('legal-client-outside-same-org','org-default','Synthetic Other Legal Entity LLC','USD',
        jsonb_build_object('line1','Synthetic Test Address','city','Test City','countryCode','US'),
        date '1970-01-01','US','Active')`);
    await pool.query(`insert into clients (id,name,industry,status,organization_id,legal_entity_id)
      values ('client-import-v1-ambiguous-label','Synthetic Different Client Label','Synthetic Industry','Active','org-default','legal-default')`);
    await pool.query(`insert into clients (id,name,industry,status,organization_id,legal_entity_id)
      values ('client-import-cross-legal','Synthetic Client Outside Legal Scope','Other Legal Industry','Active','org-default','legal-client-outside-same-org')`);
    const clientCrossLegalResponse = await applyClients({
      fileName: 'synthetic-client-cross-legal.csv',
      rows: [{id: 'client-import-cross-legal', name: 'Synthetic Client Outside Legal Scope', industry: 'Unauthorized Change'}],
    });
    assert.equal(clientCrossLegalResponse.status, 200);
    const clientCrossLegalBody = await clientCrossLegalResponse.json();
    assert.equal(clientCrossLegalBody.status, 'Failed');
    assert.equal(clientCrossLegalBody.validRows, 0);
    assert.deepEqual(clientCrossLegalBody.errors, [{
      rowNumber: 2,
      field: 'id',
      message: 'Client is not available in the authorized organization and legal entity.',
      sourceIdentifier: 'client-import-cross-legal',
    }], 'the client apply route must reject a foreign legal entity inside the same organization');
    const clientCrossLegalState = await pool.query(`select c.name,c.industry,c.organization_id,c.legal_entity_id,
        count(a.id)::int as audit_rows
      from clients c left join audit_logs a on a.source_identifier='client-import-cross-legal'
      where c.id='client-import-cross-legal'
      group by c.id`);
    assert.deepEqual(clientCrossLegalState.rows, [{
      name: 'Synthetic Client Outside Legal Scope',
      industry: 'Other Legal Industry',
      organization_id: 'org-default',
      legal_entity_id: 'legal-client-outside-same-org',
      audit_rows: 0,
    }], 'a same-organization cross-legal-entity import must not update the foreign row or write an audit event');
    await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
      values ($1,'org-default','legal-client-outside-same-org',true) on conflict do nothing`, [actorId]);
    await pool.query(`insert into employees
        (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values
        ('e-project-race-other','EMP-PROJECT-RACE-OTHER','Synthetic Other-Legal Project Manager',
          'project-race-manager@example.test','Manager','Delivery','US','cd-import-provenance-test','Active',
          'org-default','legal-client-outside-same-org')`);

    const projectPartialResponse = await applyProjects({
      fileName: 'synthetic-project-partial.csv',
      totalRows: 2,
      rows: [
        {
          projectCode: 'PROJECT-IMPORT-SOURCE-1',
          name: 'Synthetic Project With Provenance',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'EMP-IMPORT-SUCCESS',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
        {
          projectCode: 'PROJECT-IMPORT-REJECTED',
          name: 'Synthetic Project Rejected',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'missing-project-manager',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
      ],
    });
    assert.equal(projectPartialResponse.status, 200);
    const projectPartialBody = await projectPartialResponse.json();
    assert.deepEqual({status: projectPartialBody.status, totalRows: projectPartialBody.totalRows,
      validRows: projectPartialBody.validRows, errorRows: projectPartialBody.errorRows},
    {status: 'Partial', totalRows: 2, validRows: 1, errorRows: 1},
    'the real project apply route must preserve its partial batch counts');
    assert.deepEqual(projectPartialBody.errors, [{
      rowNumber: 3,
      field: 'managerId',
      message: 'Project manager employee record does not exist or is exited.',
      sourceIdentifier: 'PROJECT-IMPORT-REJECTED',
    }], 'the real project apply route must preserve its row-error shape');
    assert.equal(Object.hasOwn(projectPartialBody.log, 'schema_version'), false,
      'the legacy project apply response must preserve its established batch DTO');
    assert.equal(Object.hasOwn(projectPartialBody.log, 'dry_run'), false,
      'new import contract fields must not change the legacy project apply response');
    const projectPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [projectPartialBody.log.id])).rows[0];
    assert.equal(projectPartialLog.id, projectPartialBody.log.id, 'project batch history must return its persisted server batch ID');
    assert.equal(projectPartialLog.status, 'Partial');
    assert.equal(projectPartialLog.organization_id, 'org-default');
    assert.equal(projectPartialLog.legal_entity_id, 'legal-default');
    assert.equal(projectPartialLog.total_rows, 2);
    assert.equal(projectPartialLog.valid_rows, 1);
    assert.equal(projectPartialLog.error_rows, 1);
    assert.deepEqual(projectPartialLog.errors, projectPartialBody.errors,
      'project rejection identifier must match between HTTP response and persisted history');
    const projectPartialAudit = await pool.query(`select source,source_identifier,import_batch_id,import_processing_result,details
      from audit_logs where import_batch_id=$1`, [projectPartialBody.log.id]);
    assert.deepEqual(projectPartialAudit.rows, [{
      source: 'Project Master CSV',
      source_identifier: 'PROJECT-IMPORT-SOURCE-1',
      import_batch_id: projectPartialBody.log.id,
      import_processing_result: 'Success',
      details: 'Created project PROJECT-IMPORT-SOURCE-1 from synthetic-project-partial.csv',
    }], 'project row audits must retain required source code, result and shared batch linkage');

    const projectLegacyBlankStatus = await applyProjects({
      fileName: 'synthetic-project-legacy-blank-status.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-LEGACY-BLANK-STATUS',
        name: 'Synthetic Project Legacy Blank Status',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: '',
      }],
    });
    assert.equal(projectLegacyBlankStatus.status, 400,
      'legacy Project Master requests must retain strict blank-status validation');

    const projectUpdateResponse = await applyProjects({
      fileName: 'synthetic-project-update.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-SOURCE-1',
        name: 'Synthetic Project Updated In Same Legal Entity',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: 'Active',
      }],
    });
    assert.equal(projectUpdateResponse.status, 200);
    const projectUpdateBody = await projectUpdateResponse.json();
    assert.equal(projectUpdateBody.status, 'Success', 'same-scope project-code reimports must retain the existing upsert behavior');
    assert.equal(projectUpdateBody.validRows, 1);
    assert.equal(projectUpdateBody.errorRows, 0);
    const projectUpdateState = await pool.query(`select name,status,organization_id,legal_entity_id
      from projects where organization_id='org-default' and legal_entity_id='legal-default' and project_code='PROJECT-IMPORT-SOURCE-1'`);
    assert.deepEqual(projectUpdateState.rows, [{
      name: 'Synthetic Project Updated In Same Legal Entity',
      status: 'Active',
      organization_id: 'org-default',
      legal_entity_id: 'legal-default',
    }], 'same-legal-entity project reimports must update the existing scoped project');
    const projectUpdateAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result
      from audit_logs where import_batch_id=$1`, [projectUpdateBody.log.id]);
    assert.deepEqual(projectUpdateAudit.rows, [{
      action: 'Import Update Project',
      source: 'Project Master CSV',
      source_identifier: 'PROJECT-IMPORT-SOURCE-1',
      import_batch_id: projectUpdateBody.log.id,
      import_processing_result: 'Success',
    }], 'same-scope project upserts must retain update audit behavior and provenance');

    const projectV1Body = {
      schemaVersion: 'project-master/1',
      fileName: 'synthetic-project-v1-idempotent.csv',
      totalRows: 1,
      rows: [{
        projectCode: 'PROJECT-IMPORT-V1-IDEMPOTENT',
        name: 'Synthetic Project Idempotent Apply',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    };
    const projectV1Reordered = {
      rows: [{
        endDate: '2026-12-31',
        startDate: '2026-01-01',
        managerId: 'EMP-IMPORT-SUCCESS',
        client: 'Synthetic Client With Source ID',
        clientId: 'client-import-source-1',
        name: 'Synthetic Project Idempotent Apply',
        projectCode: 'PROJECT-IMPORT-V1-IDEMPOTENT',
      }],
      totalRows: 1,
      fileName: 'synthetic-project-v1-idempotent.csv',
      schemaVersion: 'project-master/1',
    };
    const projectV1Key = 'synthetic-project-import-key-0001';
    const [projectV1Response1, projectV1Response2] = await Promise.all([
      applyProjectsV1(projectV1Body, projectV1Key),
      applyProjectsV1(projectV1Reordered, projectV1Key),
    ]);
    assert.deepEqual([projectV1Response1.status, projectV1Response2.status], [200, 200],
      'concurrent identical versioned project imports must both return success');
    const [projectV1Result1, projectV1Result2] = await Promise.all([
      projectV1Response1.json(),
      projectV1Response2.json(),
    ]);
    assert.deepEqual(projectV1Result2, projectV1Result1,
      'same-key equivalent requests must replay the original result independent of JSON property order');
    assert.equal(projectV1Result1.status, 'Success');
    assert.equal(projectV1Result1.log.schema_version, 'project-master/1');
    assert.equal(projectV1Result1.log.dry_run, false);
    assert.equal(Object.hasOwn(projectV1Result1.log, 'idempotency_key'), false,
      'the retry credential must not be returned in the public batch DTO');
    const projectV1Persisted = await pool.query(
      "select (select count(*)::int from projects where project_code='PROJECT-IMPORT-V1-IDEMPOTENT' and organization_id='org-default' and legal_entity_id='legal-default') as project_rows, (select count(*)::int from import_export_logs where file_name='synthetic-project-v1-idempotent.csv') as batch_rows, (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows, (select count(*)::int from import_export_idempotency where batch_id=$1 and organization_id='org-default' and legal_entity_id='legal-default' and actor_id=$2 and channel='Project Master' and idempotency_key=$3 and request_hash ~ '^[a-f0-9]{64}$') as idempotency_rows",
      [projectV1Result1.log.id, actorId, projectV1Key],
    );
    assert.deepEqual(projectV1Persisted.rows, [{
      project_rows: 1,
      batch_rows: 1,
      audit_rows: 1,
      idempotency_rows: 1,
    }], 'concurrent retries must apply one project, audit and batch and bind the key to actor and scope');

    const projectV1ReplayResponse = await applyProjectsV1(projectV1Body, projectV1Key);
    assert.equal(projectV1ReplayResponse.status, 200);
    assert.deepEqual(await projectV1ReplayResponse.json(), projectV1Result1,
      'an identical later retry must return the saved batch result without mutation');
    const projectV1ConflictResponse = await applyProjectsV1({
      ...projectV1Body,
      rows: [{...projectV1Body.rows[0], name: 'Changed Payload Must Not Apply'}],
    }, projectV1Key);
    assert.equal(projectV1ConflictResponse.status, 409);
    assert.equal((await projectV1ConflictResponse.json()).error.code, 'IDEMPOTENCY_KEY_REUSED',
      'reusing the same key for a changed payload must return a stable conflict');
    const projectV1ConflictState = await pool.query(
      "select p.name, (select count(*)::int from import_export_logs where file_name='synthetic-project-v1-idempotent.csv') as batch_rows, (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows from projects p where p.project_code='PROJECT-IMPORT-V1-IDEMPOTENT' and p.organization_id='org-default' and p.legal_entity_id='legal-default'",
      [projectV1Result1.log.id],
    );
    assert.deepEqual(projectV1ConflictState.rows, [{
      name: 'Synthetic Project Idempotent Apply',
      batch_rows: 1,
      audit_rows: 1,
    }], 'a changed-payload conflict must leave the original project, batch and audit untouched');

    const projectRaceCode = 'PROJECT-IMPORT-V1-DIFFERENT-KEY-RACE';
    const projectRaceRequest = (name, fileName) => ({
      schemaVersion: 'project-master/1',
      fileName,
      rows: [{
        projectCode: projectRaceCode,
        name,
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    const [projectRaceResponse1, projectRaceResponse2] = await Promise.all([
      applyProjectsV1(projectRaceRequest('Synthetic Project Race Writer One', 'synthetic-project-race-one.csv'), 'synthetic-project-race-key-0001'),
      applyProjectsV1(projectRaceRequest('Synthetic Project Race Writer Two', 'synthetic-project-race-two.csv'), 'synthetic-project-race-key-0002'),
    ]);
    assert.deepEqual([projectRaceResponse1.status, projectRaceResponse2.status], [200, 200],
      'concurrent distinct-key project imports must serialize without losing either accepted outcome');
    const [projectRaceResult1, projectRaceResult2] = await Promise.all([
      projectRaceResponse1.json(),
      projectRaceResponse2.json(),
    ]);
    assert.deepEqual([projectRaceResult1.status, projectRaceResult2.status], ['Success', 'Success']);
    const projectRaceAudit = await pool.query(
      'select count(*)::int as audit_rows, count(*) filter (where action=\'Import Create Project\' and old_value is null)::int as creates, count(*) filter (where action=\'Import Update Project\' and old_value is not null)::int as updates_with_prior from audit_logs where import_batch_id=any($1::uuid[]) and source_identifier=$2',
      [[projectRaceResult1.log.id, projectRaceResult2.log.id], projectRaceCode],
    );
    assert.deepEqual(projectRaceAudit.rows, [{audit_rows: 2, creates: 1, updates_with_prior: 1}],
      'distinct-key concurrent reimports must record one create and one update with its true prior state');
    const projectRaceFinal = await pool.query(
      'select count(*)::int as project_rows, min(name) as only_name from projects where project_code=$1 and organization_id=\'org-default\' and legal_entity_id=\'legal-default\'',
      [projectRaceCode],
    );
    assert.equal(projectRaceFinal.rows[0].project_rows, 1);
    assert(['Synthetic Project Race Writer One', 'Synthetic Project Race Writer Two'].includes(projectRaceFinal.rows[0].only_name),
      'concurrent project updates must retain exactly one latest project row');

    const projectAmbiguousClientResponse = await applyProjectsV1({
      schemaVersion: 'project-master/1',
      fileName: 'synthetic-project-v1-client-id-authority.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-V1-CLIENT-ID-AUTHORITY',
        name: 'Synthetic Project Uses Authoritative Client ID',
        clientId: 'client-import-source-1',
        client: 'Synthetic Different Client Label',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    }, 'synthetic-project-client-id-authority-key');
    assert.equal(projectAmbiguousClientResponse.status, 200);
    assert.equal((await projectAmbiguousClientResponse.json()).status, 'Success');
    const projectAmbiguousClientState = await pool.query(
      "select client_id,client from projects where project_code='PROJECT-IMPORT-V1-CLIENT-ID-AUTHORITY' and organization_id='org-default' and legal_entity_id='legal-default'",
    );
    assert.deepEqual(projectAmbiguousClientState.rows, [{
      client_id: 'client-import-source-1',
      client: 'Synthetic Client With Source ID',
    }], 'a versioned clientId is authoritative; a conflicting label must not bind the project to a different client');

    const projectLockOrderRows = {
      A: {
        projectCode: 'PROJECT-IMPORT-V1-LOCK-ORDER-A',
        name: 'Synthetic Lock-Order Project A',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      },
      B: {
        projectCode: 'PROJECT-IMPORT-V1-LOCK-ORDER-B',
        name: 'Synthetic Lock-Order Project B',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      },
    };
    const [projectLockOrderResponse1, projectLockOrderResponse2] = await Promise.all([
      applyProjectsV1({schemaVersion: 'project-master/1', fileName: 'synthetic-project-lock-order-ab.csv', rows: [projectLockOrderRows.A, projectLockOrderRows.B]}, 'synthetic-project-lock-order-key-1'),
      applyProjectsV1({schemaVersion: 'project-master/1', fileName: 'synthetic-project-lock-order-ba.csv', rows: [projectLockOrderRows.B, projectLockOrderRows.A]}, 'synthetic-project-lock-order-key-2'),
    ]);
    assert.deepEqual([projectLockOrderResponse1.status, projectLockOrderResponse2.status], [200, 200],
      'reversed-order overlapping multi-row imports must avoid advisory-lock deadlock');
    const [projectLockOrderResult1, projectLockOrderResult2] = await Promise.all([
      projectLockOrderResponse1.json(),
      projectLockOrderResponse2.json(),
    ]);
    assert.deepEqual([projectLockOrderResult1.status, projectLockOrderResult2.status], ['Success', 'Success']);
    const projectLockOrderState = await pool.query(
      "select (select count(*)::int from projects where project_code=any(array['PROJECT-IMPORT-V1-LOCK-ORDER-A','PROJECT-IMPORT-V1-LOCK-ORDER-B']) and organization_id='org-default' and legal_entity_id='legal-default') as project_rows, (select count(*)::int from audit_logs where import_batch_id=any($1::uuid[])) as audit_rows, (select count(*)::int from audit_logs where import_batch_id=any($1::uuid[]) and action='Import Create Project') as create_audits, (select count(*)::int from audit_logs where import_batch_id=any($1::uuid[]) and action='Import Update Project' and old_value is not null) as update_audits",
      [[projectLockOrderResult1.log.id, projectLockOrderResult2.log.id]],
    );
    assert.deepEqual(projectLockOrderState.rows, [{project_rows: 2, audit_rows: 4, create_audits: 2, update_audits: 2}],
      'sorted project-code locks must allow both concurrent batches to commit one create and one update per project');

    const crossRouteProjectCode = 'PROJECT-IMPORT-V1-CROSS-ROUTE-LOCK';
    const crossRouteBarrierKey = 'synthetic-cross-route-trigger-barrier';
    const crossRouteLockKey = createProjectCodeLockKey({organizationId: 'org-default', projectCode: crossRouteProjectCode});
    const crossRouteLifecycleLockKey = 'commercial-lifecycle:org-default:legal-default';
    await pool.query('create sequence synthetic_project_cross_route_barrier start with 1');
    await pool.query(`create or replace function pause_synthetic_project_cross_route_insert()
      returns trigger language plpgsql as $$ begin
        if new.project_code='${crossRouteProjectCode}' then
          perform nextval('synthetic_project_cross_route_barrier');
          perform pg_advisory_xact_lock(hashtextextended('${crossRouteBarrierKey}', 0));
        end if;
        return new;
      end; $$`);
    await pool.query(`create trigger pause_synthetic_project_cross_route_insert
      before insert on projects for each row execute function pause_synthetic_project_cross_route_insert()`);
    const crossRouteManagerId = (await pool.query(
      "select id from employees where employee_id='EMP-IMPORT-SUCCESS' and organization_id='org-default' and legal_entity_id='legal-default'",
    )).rows[0].id;
    const crossRouteBarrierClient = new Client({connectionString: databaseUrl});
    await crossRouteBarrierClient.connect();
    let directProjectSave;
    let concurrentProjectImport;
    try {
      await crossRouteBarrierClient.query('select pg_advisory_lock(hashtextextended($1, 0))', [crossRouteBarrierKey]);
      directProjectSave = saveProject({
        project_code: crossRouteProjectCode,
        name: 'Synthetic Project Created Through Projects API',
        client_id: 'client-import-source-1',
        manager_id: crossRouteManagerId,
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        status: 'Active',
        billable: true,
      });
      let directInsertStarted = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const barrier = await pool.query('select is_called from synthetic_project_cross_route_barrier');
        if (barrier.rows[0]?.is_called) {
          directInsertStarted = true;
          break;
        }
        await delay(10);
      }
      assert.equal(directInsertStarted, true, 'the direct projects writer must reach its controlled insert barrier');

      const readAdvisoryLockCounts = async (lockKey,granted) => (await pool.query(`
        select count(*)::int as count
        from pg_locks l
        cross join (select hashtextextended($1, 0) as lock_key) expected
        where l.locktype='advisory' and l.granted=$2 and l.objsubid=1
          and l.classid::bigint=((expected.lock_key >> 32) & 4294967295)
          and l.objid::bigint=(expected.lock_key & 4294967295)
      `, [lockKey, granted])).rows[0].count;
      assert.equal(await readAdvisoryLockCounts(crossRouteLockKey,true), 1,
        'the direct project writer must hold the shared project-code lock before its insert proceeds');
      assert.equal(await readAdvisoryLockCounts(crossRouteLifecycleLockKey,true),1,
        'the direct writer must hold the common scope lifecycle lock before the project-code/insert barrier');

      concurrentProjectImport = applyProjectsV1({
        schemaVersion: 'project-master/1',
        fileName: 'synthetic-project-cross-route-lock.csv',
        rows: [{
          projectCode: crossRouteProjectCode,
          name: 'Synthetic Project Updated Through Import API',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'EMP-IMPORT-SUCCESS',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          status: 'Active',
        }],
      }, 'synthetic-project-cross-route-key');
      let importWaitingForLifecycleLock = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await readAdvisoryLockCounts(crossRouteLifecycleLockKey,false) > 0) {
          importWaitingForLifecycleLock = true;
          break;
        }
        await delay(10);
      }
      assert.equal(importWaitingForLifecycleLock, true,
        'the import must wait on the earlier common lifecycle lock while the direct writer holds both lifecycle and project-code locks');
      assert.equal(await readAdvisoryLockCounts(crossRouteLifecycleLockKey,false),1,
        'exactly the concurrent import must wait on the scoped lifecycle key before the direct insert is released');
    } finally {
      await crossRouteBarrierClient.query('select pg_advisory_unlock(hashtextextended($1, 0))', [crossRouteBarrierKey]);
      await crossRouteBarrierClient.end();
      await Promise.allSettled([directProjectSave, concurrentProjectImport].filter(Boolean));
    }
    const [directProjectSaveResponse, concurrentProjectImportResponse] = await Promise.all([
      directProjectSave,
      concurrentProjectImport,
    ]);
    assert.deepEqual([directProjectSaveResponse.status, concurrentProjectImportResponse.status], [200, 200],
      'the direct project writer and concurrent import must serialize without a uniqueness failure');
    const [directProjectSaveResult, concurrentProjectImportResult] = await Promise.all([
      directProjectSaveResponse.json(),
      concurrentProjectImportResponse.json(),
    ]);
    assert.equal(concurrentProjectImportResult.status, 'Success');
    assert.equal(directProjectSaveResult.name, 'Synthetic Project Created Through Projects API');
    const crossRouteProjectAudit = await pool.query(`select action,old_value,import_batch_id,source_identifier
      from audit_logs where entity_id=$1 or source_identifier=$2 order by created_at`,
    [directProjectSaveResult.id, crossRouteProjectCode]);
    assert.equal(crossRouteProjectAudit.rowCount, 2,
      'the cross-route create and import update must each retain one project audit');
    assert.equal(crossRouteProjectAudit.rows.filter(row => row.action === 'Create Project' && row.old_value === null).length, 1,
      'the direct project save must be audited as a create with no prior value');
    assert.equal(crossRouteProjectAudit.rows.filter(row => row.action === 'Import Update Project' && row.old_value !== null && row.import_batch_id === concurrentProjectImportResult.log.id).length, 1,
      'the serialized import must be audited as an update with the direct save as its prior value');
    const crossRouteFinalProject = await pool.query(
      'select name from projects where project_code=$1 and organization_id=\'org-default\' and legal_entity_id=\'legal-default\'',
      [crossRouteProjectCode],
    );
    assert.deepEqual(crossRouteFinalProject.rows, [{name: 'Synthetic Project Updated Through Import API'}],
      'the import update must remain the committed final project state');
    await pool.query('drop trigger pause_synthetic_project_cross_route_insert on projects');
    await pool.query('drop function pause_synthetic_project_cross_route_insert()');
    await pool.query('drop sequence synthetic_project_cross_route_barrier');

    const projectV1NoKey = await applyProjectsV1(projectV1Body, undefined);
    assert.equal(projectV1NoKey.status, 400);
    assert.equal((await projectV1NoKey.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED',
      'the versioned project contract must require an idempotency key');
    const projectV1UnsupportedSchema = await applyProjectsV1({
      ...projectV1Body,
      schemaVersion: 'project-master/99',
    }, 'synthetic-project-import-key-unsupported');
    assert.equal(projectV1UnsupportedSchema.status, 400);
    assert.equal((await projectV1UnsupportedSchema.json()).error.code, 'UNSUPPORTED_SCHEMA_VERSION',
      'unsupported project schema versions must fail before any data write');
    const projectV1InvalidNonblankStatus = await applyProjectsV1({
      schemaVersion: 'project-master/1',
      dryRun: true,
      fileName: 'invalid-nonblank-project-status.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-V1-INVALID-STATUS',
        name: 'Synthetic Project Invalid Status',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: 'Archived',
      }],
    }, 'synthetic-project-invalid-nonblank-status');
    assert.equal(projectV1InvalidNonblankStatus.status, 400,
      'nonblank invalid Project Master status values must still fail schema validation');
    assert.equal((await projectV1InvalidNonblankStatus.json()).error.code, 'INVALID_IMPORT_REQUEST');

    const emptyVersionedApply = await applyProjectsV1({
      schemaVersion: 'project-master/1',
      fileName: 'synthetic-project-empty-apply.csv',
      rows: [],
    }, 'synthetic-project-empty-apply-key');
    assert.equal(emptyVersionedApply.status, 400,
      'versioned apply must reject an empty row set while preserving empty-row support for dry run');
    assert.equal((await emptyVersionedApply.json()).error.code, 'INVALID_IMPORT_REQUEST');

    const projectV1OtherScopeBody = {
      schemaVersion: 'project-master/1',
      fileName: 'synthetic-project-v1-other-scope.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-V1-OTHER-SCOPE',
        name: 'Synthetic Project In Other Legal Entity',
        clientId: 'client-import-cross-legal',
        client: 'Synthetic Client Outside Legal Scope',
        managerId: 'EMP-PROJECT-RACE-OTHER',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    };
    const projectV1OtherScopeResponse = await applyProjectsV1(
      projectV1OtherScopeBody,
      projectV1Key,
      'legal-client-outside-same-org',
    );
    assert.equal(projectV1OtherScopeResponse.status, 200,
      'the same actor and key must be independent in a different legal-entity scope');
    const projectV1OtherScopeResult = await projectV1OtherScopeResponse.json();
    assert.equal(projectV1OtherScopeResult.status, 'Success');
    const sameKeyScopes = await pool.query(
      "select organization_id,legal_entity_id,count(*)::int as rows from import_export_idempotency where actor_id=$1 and channel='Project Master' and idempotency_key=$2 group by organization_id,legal_entity_id order by legal_entity_id",
      [actorId, projectV1Key],
    );
    assert.deepEqual(sameKeyScopes.rows, [
      {organization_id: 'org-default', legal_entity_id: 'legal-client-outside-same-org', rows: 1},
      {organization_id: 'org-default', legal_entity_id: 'legal-default', rows: 1},
    ], 'idempotency keys must be isolated by the server-resolved legal-entity scope');

    const projectDryRunBody = {
      schemaVersion: 'project-master/1',
      dryRun: true,
      fileName: 'synthetic-project-dry-run.csv',
      totalRows: 2,
      rows: [
        {
          projectCode: 'PROJECT-IMPORT-SOURCE-1',
          name: 'Dry Run Must Not Change This Project',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'EMP-IMPORT-SUCCESS',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
        {
          projectCode: 'PROJECT-IMPORT-DRY-RUN-REJECTED',
          name: 'Invalid Dry Run Project',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'missing-project-manager',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
      ],
    };
    const projectDryRunKey = 'synthetic-project-dry-run-key-0001';
    const projectDryRunResponse = await applyProjectsV1(projectDryRunBody, projectDryRunKey);
    assert.equal(projectDryRunResponse.status, 200);
    const projectDryRunResult = await projectDryRunResponse.json();
    assert.deepEqual({
      status: projectDryRunResult.status,
      totalRows: projectDryRunResult.totalRows,
      validRows: projectDryRunResult.validRows,
      errorRows: projectDryRunResult.errorRows,
    }, {status: 'Dry Run', totalRows: 2, validRows: 1, errorRows: 1},
    'a dry run must report rows that would apply and row validation errors');
    assert.deepEqual(projectDryRunResult.errors, [{
      rowNumber: 3,
      field: 'managerId',
      message: 'Project manager employee record does not exist or is exited.',
      sourceIdentifier: 'PROJECT-IMPORT-DRY-RUN-REJECTED',
    }]);
    assert.equal(projectDryRunResult.log.dry_run, true);
    assert.equal(projectDryRunResult.log.schema_version, 'project-master/1');
    const projectDryRunState = await pool.query(
      "select (select name from projects where project_code='PROJECT-IMPORT-SOURCE-1' and organization_id='org-default' and legal_entity_id='legal-default') as existing_name, (select count(*)::int from projects where project_code='PROJECT-IMPORT-DRY-RUN-REJECTED' and organization_id='org-default' and legal_entity_id='legal-default') as rejected_project_rows, (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Project') as project_audits, (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='ImportBatch' and import_processing_result='Dry Run') as dry_run_audits, (select count(*)::int from import_export_logs where id=$1 and dry_run=true and schema_version='project-master/1' and status='Dry Run') as batch_rows",
      [projectDryRunResult.log.id],
    );
    assert.deepEqual(projectDryRunState.rows, [{
      existing_name: 'Synthetic Project Updated In Same Legal Entity',
      rejected_project_rows: 0,
      project_audits: 0,
      dry_run_audits: 1,
      batch_rows: 1,
    }], 'dry-run may retain its batch/audit evidence but must not write project records or row audits');
    const projectBlankStatusBody = {
      schemaVersion: 'project-master/1',
      dryRun: true,
      fileName: 'synthetic-project-blank-status.csv',
      totalRows: 1,
      rows: [{
        projectCode: 'PROJECT-IMPORT-V1-BLANK-STATUS',
        name: 'Synthetic Project Blank Status',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: '',
      }],
    };
    const projectBlankStatusDryRunResponse = await applyProjectsV1(
      projectBlankStatusBody,
      'synthetic-project-blank-status-dry-run',
    );
    assert.equal(projectBlankStatusDryRunResponse.status, 200,
      'a blank optional Project Master status cell must be treated as omitted during dry run');
    const projectBlankStatusDryRun = await projectBlankStatusDryRunResponse.json();
    assert.deepEqual({status: projectBlankStatusDryRun.status, validRows: projectBlankStatusDryRun.validRows,
      errorRows: projectBlankStatusDryRun.errorRows}, {status: 'Dry Run', validRows: 1, errorRows: 0});
    assert.equal((await pool.query(`select count(*)::int as count from projects
      where project_code='PROJECT-IMPORT-V1-BLANK-STATUS' and organization_id='org-default' and legal_entity_id='legal-default'`)).rows[0].count, 0,
    'a blank Project Master dry run must not write its project row');
    const projectBlankStatusDryRunReplay = await applyProjectsV1({
      ...projectBlankStatusBody,
      rows: [{...projectBlankStatusBody.rows[0], status: undefined}],
    }, 'synthetic-project-blank-status-dry-run');
    assert.equal(projectBlankStatusDryRunReplay.status, 200,
      'blank and omitted Project Master status cells must canonicalize to the same idempotent request');
    assert.equal((await projectBlankStatusDryRunReplay.json()).log.id, projectBlankStatusDryRun.log.id);
    const projectBlankStatusApplyResponse = await applyProjectsV1({
      ...projectBlankStatusBody,
      dryRun: false,
    }, 'synthetic-project-blank-status-apply');
    assert.equal(projectBlankStatusApplyResponse.status, 200,
      'a blank optional Project Master status cell must be accepted on apply');
    const projectBlankStatusApply = await projectBlankStatusApplyResponse.json();
    assert.equal(projectBlankStatusApply.status, 'Success');
    assert.deepEqual((await pool.query(`select status from projects
      where project_code='PROJECT-IMPORT-V1-BLANK-STATUS' and organization_id='org-default' and legal_entity_id='legal-default'`)).rows,
    [{status: 'Proposed'}], 'an omitted Project Master status must preserve the existing Proposed default');
    const projectDryRunReplay = await applyProjectsV1(projectDryRunBody, projectDryRunKey);
    assert.equal(projectDryRunReplay.status, 200);
    assert.deepEqual(await projectDryRunReplay.json(), projectDryRunResult,
      'a repeated dry run must replay the same stored result without duplicate audit or batch records');

    const allRejectedDryRunBody = {
      schemaVersion: 'project-master/1',
      dryRun: true,
      fileName: 'synthetic-project-all-rejected.csv',
      totalRows: 1,
      rows: [],
      clientErrors: [{rowNumber: 2, field: 'projectCode', message: 'Project code is required.', sourceIdentifier: null}],
    };
    const allRejectedDryRunKey = 'synthetic-project-all-rejected-dry-run-key';
    const allRejectedDryRunResponse = await applyProjectsV1(allRejectedDryRunBody, allRejectedDryRunKey);
    assert.equal(allRejectedDryRunResponse.status, 200,
      'the versioned dry run must accept an empty valid-row set so fully rejected CSVs retain server evidence');
    const allRejectedDryRunResult = await allRejectedDryRunResponse.json();
    assert.deepEqual({
      status: allRejectedDryRunResult.status,
      totalRows: allRejectedDryRunResult.totalRows,
      validRows: allRejectedDryRunResult.validRows,
      errorRows: allRejectedDryRunResult.errorRows,
    }, {status: 'Dry Run', totalRows: 1, validRows: 0, errorRows: 1});
    assert.deepEqual(allRejectedDryRunResult.errors, allRejectedDryRunBody.clientErrors,
      'an empty server dry run must retain preflight diagnostics without inventing row outcomes');
    const allRejectedDryRunState = await pool.query(
      "select (select count(*)::int from projects where project_code='SYNTHETIC-ALL-REJECTED-PROJECT' and organization_id='org-default' and legal_entity_id='legal-default') as project_rows, (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Project') as project_audits, (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='ImportBatch' and import_processing_result='Dry Run') as dry_run_audits, (select count(*)::int from import_export_logs where id=$1 and dry_run=true and status='Dry Run') as batch_rows",
      [allRejectedDryRunResult.log.id],
    );
    assert.deepEqual(allRejectedDryRunState.rows, [{project_rows: 0, project_audits: 0, dry_run_audits: 1, batch_rows: 1}],
      'a zero-valid-row server dry run records only the batch and dry-run evidence, never project data or project-row audits');
    const allRejectedDryRunReplay = await applyProjectsV1(allRejectedDryRunBody, allRejectedDryRunKey);
    assert.equal(allRejectedDryRunReplay.status, 200);
    assert.deepEqual(await allRejectedDryRunReplay.json(), allRejectedDryRunResult,
      'a repeated empty dry run replays the same batch and diagnostics');

    const projectFailedResponse = await applyProjects({
      fileName: 'synthetic-project-failed.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-FAILED',
        name: 'Synthetic Project Failed Batch',
        client: 'Missing Active Client',
        managerId: 'missing-project-manager',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    assert.equal(projectFailedResponse.status, 200);
    const projectFailedBody = await projectFailedResponse.json();
    assert.equal(projectFailedBody.status, 'Failed');
    assert.equal(projectFailedBody.validRows, 0);
    assert.equal(projectFailedBody.errorRows, 2);
    const projectFailedBatch = await pool.query(`select l.status,count(a.id)::int as audit_rows
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id`, [projectFailedBody.log.id]);
    assert.deepEqual(projectFailedBatch.rows, [{status: 'Failed', audit_rows: 0}],
      'a project batch with no saved rows must retain its failed result without success audit events');

    await pool.query(`insert into projects (id,project_code,name,client,manager_name,start_date,end_date,status,organization_id,legal_entity_id)
      values ('project-import-cross-legal','PROJECT-IMPORT-CROSS-LEGAL','Synthetic Foreign Project','Foreign Client','Foreign Manager',
        date '2026-01-01',date '2026-12-31','Proposed','org-default','legal-client-outside-same-org')`);
    const projectCrossLegalResponse = await applyProjects({
      fileName: 'synthetic-project-cross-legal.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-CROSS-LEGAL',
        name: 'Unauthorized Project Import Change',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    assert.equal(projectCrossLegalResponse.status, 200);
    const projectCrossLegalBody = await projectCrossLegalResponse.json();
    assert.equal(projectCrossLegalBody.status, 'Failed');
    assert.equal(projectCrossLegalBody.validRows, 0);
    assert.deepEqual(projectCrossLegalBody.errors, [{
      rowNumber: 2,
      field: 'projectCode',
      message: 'Project code belongs to another legal entity in this organization.',
      code: 'PROJECT_SCOPE_CONFLICT',
      sourceIdentifier: 'PROJECT-IMPORT-CROSS-LEGAL',
    }], 'the project import must retain its same-organization cross-legal code conflict');
    const projectCrossLegalState = await pool.query(`select p.name,p.organization_id,p.legal_entity_id,
        count(a.id)::int as audit_rows
      from projects p left join audit_logs a on a.source_identifier='PROJECT-IMPORT-CROSS-LEGAL'
      where p.id='project-import-cross-legal'
      group by p.id`);
    assert.deepEqual(projectCrossLegalState.rows, [{
      name: 'Synthetic Foreign Project',
      organization_id: 'org-default',
      legal_entity_id: 'legal-client-outside-same-org',
      audit_rows: 0,
    }], 'a cross-legal project import must not adopt or audit the foreign project');
    const projectV1CrossLegalResponse = await applyProjectsV1({
      schemaVersion: 'project-master/1',
      fileName: 'synthetic-project-v1-cross-legal.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-CROSS-LEGAL',
        name: 'Synthetic Versioned Cross-Legal Attempt',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    }, 'synthetic-project-v1-cross-legal-key');
    assert.equal(projectV1CrossLegalResponse.status, 200);
    const projectV1CrossLegalResult = await projectV1CrossLegalResponse.json();
    assert.equal(projectV1CrossLegalResult.status, 'Failed');
    assert.deepEqual(projectV1CrossLegalResult.errors, [{
      rowNumber: 2,
      field: 'projectCode',
      message: 'Project code is not available in the authorized scope.',
      code: 'PROJECT_SCOPE_CONFLICT',
      sourceIdentifier: 'PROJECT-IMPORT-CROSS-LEGAL',
    }], 'the versioned scope-conflict response must not confirm a project exists in a different legal entity');

    const projectRaceResponses = await Promise.all([
      applyProjects({
        fileName: 'synthetic-project-race-default.csv',
        rows: [{
          projectCode: 'PROJECT-IMPORT-CROSS-LEGAL-RACE',
          name: 'Synthetic Default-Legal Project',
          clientId: 'client-import-source-1',
          client: 'Synthetic Client With Source ID',
          managerId: 'EMP-IMPORT-SUCCESS',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        }],
      }),
      applyProjects({
        fileName: 'synthetic-project-race-other.csv',
        rows: [{
          projectCode: 'PROJECT-IMPORT-CROSS-LEGAL-RACE',
          name: 'Synthetic Other-Legal Project',
          clientId: 'client-import-cross-legal',
          client: 'Synthetic Client Outside Legal Scope',
          managerId: 'EMP-PROJECT-RACE-OTHER',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        }],
      }, 'legal-client-outside-same-org'),
    ]);
    const projectRaceBodies = await Promise.all(projectRaceResponses.map(response => response.json()));
    assert.deepEqual(projectRaceResponses.map(response => response.status), [200, 200],
      'both concurrent project import requests must return their row-level outcomes');
    assert.deepEqual(projectRaceBodies.map(body => body.status).sort(), ['Failed', 'Success'],
      'concurrent project-code imports across legal entities must serialize one winner and reject one row');
    const projectRaceFailure = projectRaceBodies.find(body => body.status === 'Failed');
    assert.deepEqual(projectRaceFailure.errors, [{
      rowNumber: 2,
      field: 'projectCode',
      message: 'Project code belongs to another legal entity in this organization.',
      code: 'PROJECT_SCOPE_CONFLICT',
      sourceIdentifier: 'PROJECT-IMPORT-CROSS-LEGAL-RACE',
    }], 'a serialized project-code loser must receive the existing row-local scope error');
    const projectRaceWinner = projectRaceBodies.find(body => body.status === 'Success');
    assert.equal(projectRaceWinner.validRows, 1);
    const projectRaceState = await pool.query(`select p.name,p.client_id,p.manager_id,p.legal_entity_id,
        count(a.id)::int as audit_rows,
        (count(a.id) filter (where a.import_batch_id=$1))::int as winning_batch_audits
      from projects p left join audit_logs a on a.source_identifier=p.project_code
      where p.organization_id='org-default' and p.project_code='PROJECT-IMPORT-CROSS-LEGAL-RACE'
      group by p.id`, [projectRaceWinner.log.id]);
    assert.equal(projectRaceState.rowCount, 1, 'concurrent imports must leave one organization-scoped project');
    const committedProject = projectRaceState.rows[0];
    assert.equal(projectRaceState.rows[0].audit_rows, 1, 'the losing legal entity must not write a row audit');
    assert.equal(projectRaceState.rows[0].winning_batch_audits, 1,
      'the surviving project audit must link to the successful batch only');
    if (committedProject.legal_entity_id === 'legal-default') {
      assert.equal(committedProject.name, 'Synthetic Default-Legal Project');
      assert.equal(committedProject.client_id, 'client-import-source-1');
      assert.equal(committedProject.manager_id, (await pool.query(`select id from employees where employee_id='EMP-IMPORT-SUCCESS'`)).rows[0].id);
    } else {
      assert.equal(committedProject.legal_entity_id, 'legal-client-outside-same-org');
      assert.equal(committedProject.name, 'Synthetic Other-Legal Project');
      assert.equal(committedProject.client_id, 'client-import-cross-legal');
      assert.equal(committedProject.manager_id, 'e-project-race-other');
    }
    const projectRaceFailureAudit = await pool.query(`select count(*)::int as audit_rows
      from audit_logs where import_batch_id=$1`, [projectRaceFailure.log.id]);
    assert.deepEqual(projectRaceFailureAudit.rows, [{audit_rows: 0}],
      'a rejected race-loser batch must not contain row audit events');

    await pool.query(`create or replace function reject_synthetic_project_import_log()
      returns trigger language plpgsql as $$ begin
        if new.file_name='synthetic-project-rollback.csv' then raise exception 'synthetic project import-log failure'; end if;
        return new;
      end; $$`);
    await pool.query(`create trigger reject_synthetic_project_import_log
      before insert on import_export_logs for each row execute function reject_synthetic_project_import_log()`);
    const projectRollbackResponse = await applyProjects({
      fileName: 'synthetic-project-rollback.csv',
      rows: [{
        projectCode: 'PROJECT-IMPORT-ROLLBACK',
        name: 'Synthetic Project Rolled Back',
        clientId: 'client-import-source-1',
        client: 'Synthetic Client With Source ID',
        managerId: 'EMP-IMPORT-SUCCESS',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    assert.equal(projectRollbackResponse.status, 500, 'a failed project batch-log write must return the legacy generic failure');
    assert.deepEqual(await projectRollbackResponse.json(), {error: 'Project import apply failed'});
    const projectRollbackRows = await pool.query(`select
        (select count(*)::int from projects where organization_id='org-default' and legal_entity_id='legal-default' and project_code='PROJECT-IMPORT-ROLLBACK') as project_rows,
        (select count(*)::int from audit_logs where source_identifier='PROJECT-IMPORT-ROLLBACK') as audit_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-project-rollback.csv') as batch_rows`);
    assert.deepEqual(projectRollbackRows.rows, [{project_rows: 0, audit_rows: 0, batch_rows: 0}],
      'a failed project batch-log write must roll back the project row and audit with no orphan batch reference');

    await pool.query(`create or replace function reject_synthetic_client_import_log()
      returns trigger language plpgsql as $$ begin
        if new.file_name='synthetic-client-rollback.csv' then raise exception 'synthetic client import-log failure'; end if;
        return new;
      end; $$`);
    await pool.query(`create trigger reject_synthetic_client_import_log
      before insert on import_export_logs for each row execute function reject_synthetic_client_import_log()`);
    const clientRollbackResponse = await applyClients({
      fileName: 'synthetic-client-rollback.csv',
      rows: [{id: 'client-import-rollback', name: 'Synthetic Client Rolled Back'}],
    });
    assert.equal(clientRollbackResponse.status, 500, 'a failed client batch-log write must return the legacy generic failure');
    assert.deepEqual(await clientRollbackResponse.json(), {error: 'Client import apply failed'});
    const clientRollbackRows = await pool.query(`select
        (select count(*)::int from clients where organization_id='org-default' and legal_entity_id='legal-default' and name='Synthetic Client Rolled Back') as client_rows,
        (select count(*)::int from audit_logs where source_identifier='client-import-rollback') as audit_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-client-rollback.csv') as batch_rows`);
    assert.deepEqual(clientRollbackRows.rows, [{client_rows: 0, audit_rows: 0, batch_rows: 0}],
      'a failed client batch-log write must roll back the client row and audit with no orphan batch reference');

    await pool.query(`insert into project_allocations
        (id,employee_id,project_id,role_on_project,percentage,start_date,end_date,billable,status,comments,organization_id,legal_entity_id)
      values ('allocation-import-cross-legal','e-project-race-other','project-import-cross-legal','Synthetic Manager',15,
        date '2026-02-01',date '2026-03-01',true,'Active','Synthetic foreign allocation','org-default','legal-client-outside-same-org')`);
    const allocationPartialResponse = await applyAllocations({
      fileName: 'synthetic-allocation-partial.csv',
      totalRows: 3,
      rows: [
        {
          id: 'allocation-import-source-1',
          employeeId: 'EMP-IMPORT-SUCCESS',
          projectId: 'PROJECT-IMPORT-SOURCE-1',
          percentage: 25,
          startDate: '2026-02-01',
          endDate: '2026-03-01',
          status: 'Active',
        },
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          projectId: 'PROJECT-IMPORT-SOURCE-1',
          percentage: 10,
          startDate: '2026-02-01',
          endDate: '2026-03-01',
          status: 'Active',
        },
        {
          id: 'allocation-import-cross-legal',
          employeeId: 'EMP-IMPORT-SUCCESS',
          projectId: 'PROJECT-IMPORT-SOURCE-1',
          percentage: 5,
          startDate: '2026-02-01',
          endDate: '2026-03-01',
          status: 'Active',
        },
      ],
    });
    assert.equal(allocationPartialResponse.status, 200);
    const allocationPartialBody = await allocationPartialResponse.json();
    assert.deepEqual({status: allocationPartialBody.status, totalRows: allocationPartialBody.totalRows,
      validRows: allocationPartialBody.validRows, errorRows: allocationPartialBody.errorRows},
    {status: 'Partial', totalRows: 3, validRows: 2, errorRows: 1},
    'the real allocation apply route must preserve its partial batch counts');
    assert.deepEqual(allocationPartialBody.errors, [{
      rowNumber: 4,
      field: 'id',
      message: 'Allocation is not available in the authorized organization and legal entity.',
      sourceIdentifier: 'allocation-import-cross-legal',
    }], 'the real allocation apply route must preserve its existing non-disclosing cross-legal error');
    const allocationPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [allocationPartialBody.log.id])).rows[0];
    assert.equal(allocationPartialLog.id, allocationPartialBody.log.id,
      'allocation batch history must return its persisted server batch ID');
    assert.equal(allocationPartialLog.status, 'Partial');
    assert.equal(allocationPartialLog.organization_id, 'org-default');
    assert.equal(allocationPartialLog.legal_entity_id, 'legal-default');
    assert.equal(allocationPartialLog.total_rows, 3);
    assert.equal(allocationPartialLog.valid_rows, 2);
    assert.equal(allocationPartialLog.error_rows, 1);
    assert.deepEqual(allocationPartialLog.errors, allocationPartialBody.errors,
      'allocation rejection identifier must match between HTTP response and persisted history');
    const allocationPartialAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result,details
      from audit_logs where import_batch_id=$1 order by source_identifier nulls last`, [allocationPartialBody.log.id]);
    assert.deepEqual(allocationPartialAudit.rows, [
      {
        action: 'Import Create Allocation',
        source: 'Allocation Control CSV',
        source_identifier: 'allocation-import-source-1',
        import_batch_id: allocationPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created allocation for EMP-IMPORT-SUCCESS on PROJECT-IMPORT-SOURCE-1 from synthetic-allocation-partial.csv',
      },
      {
        action: 'Import Create Allocation',
        source: 'Allocation Control CSV',
        source_identifier: null,
        import_batch_id: allocationPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created allocation for EMP-IMPORT-SUCCESS on PROJECT-IMPORT-SOURCE-1 from synthetic-allocation-partial.csv',
      },
    ], 'successful allocation row audits must preserve only supplied source IDs and share the batch ID');
    const crossLegalAllocationState = await pool.query(`select pa.id,pa.employee_id,pa.project_id,pa.percentage,
        pa.organization_id,pa.legal_entity_id,count(a.id)::int as audit_rows
      from project_allocations pa
      left join audit_logs a on a.entity_type='Allocation' and a.entity_id=pa.id
      where pa.id='allocation-import-cross-legal'
      group by pa.id`);
    assert.deepEqual(crossLegalAllocationState.rows, [{
      id: 'allocation-import-cross-legal',
      employee_id: 'e-project-race-other',
      project_id: 'project-import-cross-legal',
      percentage: '15',
      organization_id: 'org-default',
      legal_entity_id: 'legal-client-outside-same-org',
      audit_rows: 0,
    }], 'an allocation in another legal entity must remain unchanged and unaudited by the rejected import');

    const allocationUpdateResponse = await applyAllocations({
      fileName: 'synthetic-allocation-update.csv',
      rows: [{
        id: 'allocation-import-source-1',
        employeeId: 'EMP-IMPORT-SUCCESS',
        projectId: 'PROJECT-IMPORT-SOURCE-1',
        percentage: 40,
        startDate: '2026-02-01',
        endDate: '2026-03-01',
        status: 'Active',
        comments: 'Synthetic same-scope update',
      }],
    });
    assert.equal(allocationUpdateResponse.status, 200);
    const allocationUpdateBody = await allocationUpdateResponse.json();
    assert.equal(allocationUpdateBody.status, 'Success', 'same-scope allocation upserts must remain supported');
    assert.equal(allocationUpdateBody.validRows, 1);
    assert.equal(allocationUpdateBody.errorRows, 0);
    const allocationUpdateState = await pool.query(`select percentage,comments,organization_id,legal_entity_id
      from project_allocations where id='allocation-import-source-1'`);
    assert.deepEqual(allocationUpdateState.rows, [{
      percentage: '40',
      comments: 'Synthetic same-scope update',
      organization_id: 'org-default',
      legal_entity_id: 'legal-default',
    }], 'same-scope allocation reimports must retain their existing update behavior');
    const allocationUpdateAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result
      from audit_logs where import_batch_id=$1`, [allocationUpdateBody.log.id]);
    assert.deepEqual(allocationUpdateAudit.rows, [{
      action: 'Import Update Allocation',
      source: 'Allocation Control CSV',
      source_identifier: 'allocation-import-source-1',
      import_batch_id: allocationUpdateBody.log.id,
      import_processing_result: 'Success',
    }], 'same-scope allocation upserts must preserve update audit behavior and provenance');

    const allocationFailedResponse = await applyAllocations({
      fileName: 'synthetic-allocation-failed.csv',
      rows: [{
        id: 'allocation-import-failed-source',
        employeeId: 'missing-allocation-employee',
        projectId: 'PROJECT-IMPORT-SOURCE-1',
        percentage: 10,
        startDate: '2026-02-01',
        endDate: '2026-03-01',
      }],
    });
    assert.equal(allocationFailedResponse.status, 200);
    const allocationFailedBody = await allocationFailedResponse.json();
    assert.equal(allocationFailedBody.status, 'Failed');
    assert.equal(allocationFailedBody.validRows, 0);
    assert.equal(allocationFailedBody.errorRows, 1);
    const allocationFailedBatch = await pool.query(`select l.status,count(a.id)::int as audit_rows
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id`, [allocationFailedBody.log.id]);
    assert.deepEqual(allocationFailedBatch.rows, [{status: 'Failed', audit_rows: 0}],
      'a validation-failed allocation batch must retain its result without success audit events');

    await pool.query(`insert into system_settings (key,value,updated_at)
      values ('blockOverAllocation','true'::jsonb,now())
      on conflict (key) do update set value=excluded.value,updated_at=excluded.updated_at`);
    const allocationOverLimitResponse = await applyAllocations({
      fileName: 'synthetic-allocation-over-limit.csv',
      rows: [{
        id: 'allocation-import-over-limit',
        employeeId: 'EMP-IMPORT-SUCCESS',
        projectId: 'PROJECT-IMPORT-SOURCE-1',
        percentage: 60,
        startDate: '2026-02-01',
        endDate: '2026-03-01',
      }],
    });
    assert.equal(allocationOverLimitResponse.status, 200);
    const allocationOverLimitBody = await allocationOverLimitResponse.json();
    assert.deepEqual({status: allocationOverLimitBody.status, validRows: allocationOverLimitBody.validRows,
      errorRows: allocationOverLimitBody.errorRows},
    {status: 'Failed', validRows: 0, errorRows: 1},
    'the enabled over-allocation policy must reject the row without changing batch result semantics');
    assert.deepEqual(allocationOverLimitBody.errors, [{
      rowNumber: 2,
      field: 'percentage',
      message: 'Allocation would exceed 100% for overlapping dates (110%).',
      sourceIdentifier: 'allocation-import-over-limit',
    }], 'the real allocation apply route must preserve its scoped over-allocation guard');
    const allocationOverLimitAudit = await pool.query(`select count(*)::int as audit_rows
      from audit_logs where import_batch_id=$1`, [allocationOverLimitBody.log.id]);
    assert.deepEqual(allocationOverLimitAudit.rows, [{audit_rows: 0}],
      'an over-allocation rejection must not write a success audit');
    await pool.query(`update system_settings set value='false'::jsonb,updated_at=now()
      where key='blockOverAllocation'`);

    await pool.query(`create or replace function reject_synthetic_allocation_import_log()
      returns trigger language plpgsql as $$ begin
        if new.file_name='synthetic-allocation-rollback.csv' then raise exception 'synthetic allocation import-log failure'; end if;
        return new;
      end; $$`);
    await pool.query(`create trigger reject_synthetic_allocation_import_log
      before insert on import_export_logs for each row execute function reject_synthetic_allocation_import_log()`);
    const allocationRollbackResponse = await applyAllocations({
      fileName: 'synthetic-allocation-rollback.csv',
      rows: [{
        id: 'allocation-import-rollback',
        employeeId: 'EMP-IMPORT-SUCCESS',
        projectId: 'PROJECT-IMPORT-SOURCE-1',
        percentage: 5,
        startDate: '2026-02-01',
        endDate: '2026-03-01',
      }],
    });
    assert.equal(allocationRollbackResponse.status, 500,
      'a failed allocation batch-log write must return the legacy generic failure');
    assert.deepEqual(await allocationRollbackResponse.json(), {error: 'Allocation import apply failed'});
    const allocationRollbackRows = await pool.query(`select
        (select count(*)::int from project_allocations where id='allocation-import-rollback') as allocation_rows,
        (select count(*)::int from audit_logs where source_identifier='allocation-import-rollback') as audit_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-allocation-rollback.csv') as batch_rows`);
    assert.deepEqual(allocationRollbackRows.rows, [{allocation_rows: 0,audit_rows: 0,batch_rows: 0}],
      'a failed allocation batch-log write must roll back the allocation and audit with no orphan batch reference');

    const v1AllocationBody = {
      schemaVersion: 'allocation-control/1', dryRun: true, fileName: 'synthetic-allocation-v1-dry-run.csv',
      totalRows: 1, clientErrors: [], rows: [{
        id: '', employeeId: 'EMP-IMPORT-SUCCESS', projectId: 'PROJECT-IMPORT-SOURCE-1',
        percentage: 5, startDate: '2026-02-01', endDate: '2026-03-01', status: '',
      }],
    };
    const missingAllocationKey = await applyOperationalImportV1('allocations', v1AllocationBody, undefined);
    assert.equal(missingAllocationKey.status, 400);
    assertVersionedErrorResponse(missingAllocationKey, await missingAllocationKey.json(), {
      code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'The Idempotency-Key header is required.',
    });
    const invalidAllocationKey = await applyOperationalImportV1('allocations', v1AllocationBody, 'bad key');
    assert.equal(invalidAllocationKey.status, 400);
    assertVersionedErrorResponse(invalidAllocationKey, await invalidAllocationKey.json(), {
      code: 'INVALID_IDEMPOTENCY_KEY', message: 'The Idempotency-Key header is invalid.',
    });
    const deniedAllocationV1 = await applyOperationalImportV1('allocations', v1AllocationBody, 'allocation-v1-denied-key', {
      authToken: tokenFor(auditDeniedActorId, 'synthetic-no-audit', 'Employee'),
    });
    assert.equal(deniedAllocationV1.status, 403);
    assertVersionedErrorResponse(deniedAllocationV1, await deniedAllocationV1.json(), {
      code: 'FORBIDDEN', message: 'Insufficient permission privileges',
    });
    const missingAllocationSchema = await applyOperationalImportV1('allocations', {
      ...v1AllocationBody, schemaVersion: undefined,
    }, 'allocation-v1-missing-schema-key');
    assert.equal(missingAllocationSchema.status, 400);
    assertVersionedErrorResponse(missingAllocationSchema, await missingAllocationSchema.json(), {
      code:'SCHEMA_VERSION_REQUIRED',message:'The Allocation Control import schema version is required.',
    });
    const unsupportedAllocationSchema = await applyOperationalImportV1('allocations', {
      ...v1AllocationBody, schemaVersion: 'allocation-control/99',
    }, 'allocation-v1-unsupported-schema');
    assert.equal(unsupportedAllocationSchema.status, 400);
    assertVersionedErrorResponse(unsupportedAllocationSchema, await unsupportedAllocationSchema.json(), {
      code: 'UNSUPPORTED_SCHEMA_VERSION', message: 'The Allocation Control import schema version is not supported.',
    });

    const v1AllocationPreview = await applyOperationalImportV1('allocations', v1AllocationBody, 'allocation-v1-dry-run-key');
    assert.equal(v1AllocationPreview.status, 200);
    const v1AllocationPreviewBody = await v1AllocationPreview.json();
    assert.deepEqual({status: v1AllocationPreviewBody.status, validRows: v1AllocationPreviewBody.validRows,
      errorRows: v1AllocationPreviewBody.errorRows, schemaVersion: v1AllocationPreviewBody.log.schema_version,
      dryRun: v1AllocationPreviewBody.log.dry_run},
    {status: 'Dry Run', validRows: 1, errorRows: 0, schemaVersion: 'allocation-control/1', dryRun: true},
    'v1 Allocation Control records a versioned dry-run batch and normalizes blank optional ID/status cells');
    const v1AllocationPreviewRows = await pool.query(`select
        (select count(*)::int from project_allocations where id='allocation-v1-dry-run') as allocation_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Allocation') as row_audits,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='ImportBatch'
          and action='Dry Run Allocation Control Import' and import_processing_result='Dry Run') as dry_run_audits,
        (select count(*)::int from import_export_idempotency where batch_id=$1 and channel='Allocation Control') as key_rows`,
    [v1AllocationPreviewBody.log.id]);
    assert.deepEqual(v1AllocationPreviewRows.rows, [{allocation_rows:0,row_audits:0,dry_run_audits:1,key_rows:1}],
      'Allocation Control dry run writes only batch/audit/idempotency evidence, not the allocation');
    const emptyAllocationDryRun = await applyOperationalImportV1('allocations', {
      ...v1AllocationBody, fileName:'synthetic-allocation-v1-empty-dry-run.csv', totalRows:1, rows:[],
      clientErrors:[{rowNumber:2,field:'header',message:'Synthetic preflight rejected every row.'}],
    }, 'allocation-v1-empty-dry-run-key');
    const emptyAllocationDryRunBody = await emptyAllocationDryRun.json();
    assert.deepEqual({status:emptyAllocationDryRunBody.status,validRows:emptyAllocationDryRunBody.validRows,
      errorRows:emptyAllocationDryRunBody.errorRows,dryRun:emptyAllocationDryRunBody.log.dry_run},
    {status:'Dry Run',validRows:0,errorRows:1,dryRun:true},
    'a zero-valid-row Allocation Control dry run still persists its diagnostic batch');
    const v1AllocationPreviewRetry = await applyOperationalImportV1('allocations', v1AllocationBody, 'allocation-v1-dry-run-key');
    const v1AllocationPreviewRetryBody = await v1AllocationPreviewRetry.json();
    assert.equal(v1AllocationPreviewRetryBody.log.id, v1AllocationPreviewBody.log.id,
      'an identical Allocation Control dry-run retry replays the original batch');
    assert.equal((await pool.query(`select count(*)::int as rows from import_export_logs where file_name=$1`, [v1AllocationBody.fileName])).rows[0].rows, 1,
      'an Allocation Control retry does not create a duplicate batch');
    const v1AllocationChangedKey = await applyOperationalImportV1('allocations', {
      ...v1AllocationBody, rows: [{...v1AllocationBody.rows[0], percentage: 6}],
    }, 'allocation-v1-dry-run-key');
    assert.equal(v1AllocationChangedKey.status, 409);
    assertVersionedErrorResponse(v1AllocationChangedKey, await v1AllocationChangedKey.json(), {
      code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request.',
    });

    const naturalDuplicateAllocationBody = {
      ...v1AllocationBody,
      fileName: 'synthetic-allocation-v1-duplicate.csv', totalRows: 2,
      rows: [
        {...v1AllocationBody.rows[0], id: 'allocation-v1-duplicate-a'},
        {...v1AllocationBody.rows[0], id: 'allocation-v1-duplicate-b'},
      ],
    };
    const naturalDuplicateAllocation = await applyOperationalImportV1('allocations', naturalDuplicateAllocationBody, 'allocation-v1-duplicate-key');
    const naturalDuplicateAllocationResult = await naturalDuplicateAllocation.json();
    assert.deepEqual({status: naturalDuplicateAllocationResult.status, validRows: naturalDuplicateAllocationResult.validRows,
      errorRows: naturalDuplicateAllocationResult.errorRows}, {status:'Dry Run',validRows:1,errorRows:1},
    'v1 server validation enforces the same employee/project/date natural duplicate key used by the UI');
    assert.equal(naturalDuplicateAllocationResult.errors[0].field, 'allocationKey');
    assert.equal(naturalDuplicateAllocationResult.errors[0].rowNumber, 3);

    const allocationAliasIds = await pool.query(`select e.id as employee_id,p.id as project_id
      from employees e cross join projects p
      where e.employee_id='EMP-IMPORT-SUCCESS' and p.project_code='PROJECT-IMPORT-SOURCE-1'
        and e.organization_id='org-default' and e.legal_entity_id='legal-default'
        and p.organization_id='org-default' and p.legal_entity_id='legal-default'`);
    assert.equal(allocationAliasIds.rowCount, 1, 'canonical allocation duplicate fixtures are available in the selected scope');
    const aliasDuplicateAllocationResponse = await applyOperationalImportV1('allocations', {
      ...v1AllocationBody,
      fileName: 'synthetic-allocation-v1-alias-duplicate.csv',
      totalRows: 2,
      rows: [
        {...v1AllocationBody.rows[0], id: 'allocation-v1-alias-duplicate-a'},
        {...v1AllocationBody.rows[0], id: 'allocation-v1-alias-duplicate-b',
          employeeId: allocationAliasIds.rows[0].employee_id, projectId: allocationAliasIds.rows[0].project_id},
      ],
    }, 'allocation-v1-alias-duplicate-key');
    const aliasDuplicateAllocation = await aliasDuplicateAllocationResponse.json();
    assert.deepEqual({validRows: aliasDuplicateAllocation.validRows, errorRows: aliasDuplicateAllocation.errorRows},
      {validRows: 1, errorRows: 1},
      'v1 Allocation Control detects duplicate natural keys when the same employee/project are supplied by different identifiers');
    assert.deepEqual({field: aliasDuplicateAllocation.errors[0].field, rowNumber: aliasDuplicateAllocation.errors[0].rowNumber},
      {field: 'allocationKey', rowNumber: 3});
    assert.equal((await pool.query(`select count(*)::int as rows from project_allocations
      where id in ('allocation-v1-alias-duplicate-a','allocation-v1-alias-duplicate-b')`)).rows[0].rows, 0,
    'canonical allocation duplicate dry-run leaves both candidate allocation rows unwritten');

    await pool.query(`update system_settings set value='true'::jsonb,updated_at=now() where key='blockOverAllocation'`);
    const cumulativeAllocationBody = {
      schemaVersion: 'allocation-control/1', dryRun: true, fileName: 'synthetic-allocation-v1-cumulative.csv',
      totalRows: 2, clientErrors: [], rows: [
        {id:'allocation-v1-cumulative-a',employeeId:'EMP-IMPORT-SUCCESS',projectId:'PROJECT-IMPORT-SOURCE-1',percentage:30,startDate:'2026-02-01',endDate:'2026-03-01',status:'Active'},
        {id:'allocation-v1-cumulative-b',employeeId:'EMP-IMPORT-SUCCESS',projectId:'PROJECT-IMPORT-SOURCE-1',percentage:30,startDate:'2026-02-01',endDate:'2026-02-28',status:'Active'},
      ],
    };
    const cumulativeAllocationResponse = await applyOperationalImportV1('allocations', cumulativeAllocationBody, 'allocation-v1-cumulative-key');
    const cumulativeAllocationResult = await cumulativeAllocationResponse.json();
    assert.deepEqual({status:cumulativeAllocationResult.status,validRows:cumulativeAllocationResult.validRows,errorRows:cumulativeAllocationResult.errorRows},
      {status:'Dry Run',validRows:1,errorRows:1},
      'the no-write Allocation Control dry run accounts for earlier accepted rows when validating cumulative over-allocation');
    assert.match(cumulativeAllocationResult.errors[0].message, /110%/);
    const cumulativeAllocationWrites = await pool.query(`select
        (select count(*)::int from project_allocations where id in ('allocation-v1-cumulative-a','allocation-v1-cumulative-b')) as allocation_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Allocation') as row_audits`,
    [cumulativeAllocationResult.log.id]);
    assert.deepEqual(cumulativeAllocationWrites.rows, [{allocation_rows:0,row_audits:0}],
      'cumulative dry-run validation keeps both accepted and rejected allocation candidates write-free');

    const allocationReassignmentIds = await pool.query(`select
        (select id from employees where employee_id='EMP-IMPORT-SUCCESS' and organization_id='org-default' and legal_entity_id='legal-default') as source_employee_id,
        (select id from employees where employee_id='EMP-ALLOCATION-TARGET' and organization_id='org-default' and legal_entity_id='legal-default') as target_employee_id,
        (select id from projects where project_code='PROJECT-IMPORT-SOURCE-1' and organization_id='org-default' and legal_entity_id='legal-default') as project_id`);
    assert.ok(allocationReassignmentIds.rows[0].source_employee_id && allocationReassignmentIds.rows[0].target_employee_id
      && allocationReassignmentIds.rows[0].project_id, 'reassignment fixtures resolve to the selected organization and legal entity');
    await pool.query(`insert into project_allocations
        (id,employee_id,project_id,role_on_project,percentage,start_date,end_date,billable,status,comments,organization_id,legal_entity_id)
      values
        ('allocation-v1-reassign-source',$1,$3,'Synthetic Source',50,date '2026-03-01',date '2026-03-31',true,'Active','Synthetic source assignment','org-default','legal-default'),
        ('allocation-v1-reassign-target',$2,$3,'Synthetic Target',40,date '2026-03-01',date '2026-03-31',true,'Active','Synthetic target load','org-default','legal-default'),
        ('allocation-v1-reassign-paused',$2,$3,'Synthetic Paused',70,date '2026-03-01',date '2026-03-31',true,'Paused','Synthetic paused assignment','org-default','legal-default')`,
    [allocationReassignmentIds.rows[0].source_employee_id, allocationReassignmentIds.rows[0].target_employee_id,
      allocationReassignmentIds.rows[0].project_id]);

    const reassignmentCandidate = {
      id: 'allocation-v1-reassign-source', employeeId: 'EMP-ALLOCATION-TARGET', projectId: 'PROJECT-IMPORT-SOURCE-1',
      percentage: 50, startDate: '2026-03-01', endDate: '2026-03-31', status: 'Active',
    };
    const reassignmentFromSourceResponse = await applyOperationalImportV1('allocations', {
      schemaVersion: 'allocation-control/1', dryRun: true, fileName: 'synthetic-allocation-v1-reassign-source.csv',
      totalRows: 2, clientErrors: [], rows: [
        reassignmentCandidate,
        {id: 'allocation-v1-reassign-source-followup', employeeId: 'EMP-IMPORT-SUCCESS',
          projectId: 'PROJECT-IMPORT-SOURCE-1', percentage: 60, startDate: '2026-03-02', endDate: '2026-03-30', status: 'Active'},
      ],
    }, 'allocation-v1-reassign-source-key');
    const reassignmentFromSource = await reassignmentFromSourceResponse.json();
    assert.deepEqual({validRows: reassignmentFromSource.validRows, errorRows: reassignmentFromSource.errorRows},
      {validRows: 2, errorRows: 0},
      'allocation dry-run removes a reassigned allocation from its source employee before validating later source rows');

    const reassignmentToTargetResponse = await applyOperationalImportV1('allocations', {
      schemaVersion: 'allocation-control/1', dryRun: true, fileName: 'synthetic-allocation-v1-reassign-target.csv',
      totalRows: 2, clientErrors: [], rows: [
        reassignmentCandidate,
        {id: 'allocation-v1-reassign-target-followup', employeeId: 'EMP-ALLOCATION-TARGET',
          projectId: 'PROJECT-IMPORT-SOURCE-1', percentage: 20, startDate: '2026-03-02', endDate: '2026-03-30', status: 'Active'},
      ],
    }, 'allocation-v1-reassign-target-key');
    const reassignmentToTarget = await reassignmentToTargetResponse.json();
    assert.deepEqual({validRows: reassignmentToTarget.validRows, errorRows: reassignmentToTarget.errorRows},
      {validRows: 1, errorRows: 1},
      'allocation dry-run adds a reassigned allocation to its destination employee before validating later target rows');
    assert.match(reassignmentToTarget.errors[0].message, /110%/);

    const blankStatusPausedAllocation = await applyOperationalImportV1('allocations', {
      schemaVersion: 'allocation-control/1', dryRun: true, fileName: 'synthetic-allocation-v1-paused-blank-status.csv',
      totalRows: 1, clientErrors: [], rows: [{
        id: 'allocation-v1-reassign-paused', employeeId: 'EMP-ALLOCATION-TARGET',
        projectId: 'PROJECT-IMPORT-SOURCE-1', percentage: 70,
        startDate: '2026-03-01', endDate: '2026-03-31', status: '',
      }],
    }, 'allocation-v1-paused-blank-status-key');
    const blankStatusPausedAllocationResult = await blankStatusPausedAllocation.json();
    assert.deepEqual({validRows: blankStatusPausedAllocationResult.validRows, errorRows: blankStatusPausedAllocationResult.errorRows},
      {validRows: 1, errorRows: 0},
      'over-allocation validation uses the effective preserved Paused status when the imported status cell is blank');
    assert.equal((await pool.query(`select count(*)::int as rows from project_allocations
      where id like 'allocation-v1-reassign-%-followup'`)).rows[0].rows, 0,
    'allocation reassignment dry-runs leave their candidate follow-up allocations unwritten');
    await pool.query(`update system_settings set value='false'::jsonb,updated_at=now() where key='blockOverAllocation'`);

    const allocationConcurrencyBody = {
      schemaVersion: 'allocation-control/1', dryRun: false, fileName: 'synthetic-allocation-v1-concurrent.csv',
      totalRows: 1, clientErrors: [], rows: [{
        id:'allocation-v1-concurrent',employeeId:'EMP-IMPORT-SUCCESS',projectId:'PROJECT-IMPORT-SOURCE-1',
        percentage:5,startDate:'2026-02-01',endDate:'2026-03-01',status:'Active',
      }],
    };
    const concurrentAllocationResponses = await Promise.all([
      applyOperationalImportV1('allocations', allocationConcurrencyBody, 'allocation-v1-concurrent-key'),
      applyOperationalImportV1('allocations', allocationConcurrencyBody, 'allocation-v1-concurrent-key'),
    ]);
    assert.deepEqual(concurrentAllocationResponses.map(response => response.status), [200,200],
      'concurrent same-key Allocation Control applies both return a result');
    const concurrentAllocationBodies = await Promise.all(concurrentAllocationResponses.map(response => response.json()));
    assert.equal(concurrentAllocationBodies[0].log.id, concurrentAllocationBodies[1].log.id,
      'concurrent same-key Allocation Control requests replay one operation batch');
    const concurrentAllocationState = await pool.query(`select
        (select count(*)::int from import_export_logs where id=$1) as batches,
        (select count(*)::int from project_allocations where id='allocation-v1-concurrent') as allocation_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Allocation') as row_audits,
        (select count(*)::int from import_export_idempotency where batch_id=$1) as key_rows`,
    [concurrentAllocationBodies[0].log.id]);
    assert.deepEqual(concurrentAllocationState.rows, [{batches:1,allocation_rows:1,row_audits:1,key_rows:1}],
      'concurrent same-key Allocation Control apply writes one target row, row audit, batch and key record');

    const multiScopeV1Token = tokenFor(multiScopeActorId, 'synthetic-multi-scope-admin');
    const allocationScopeBody = {...v1AllocationBody, fileName:'synthetic-allocation-scope-isolation.csv'};
    const allocationScopeDefault = await applyOperationalImportV1('allocations', allocationScopeBody, 'allocation-v1-scope-key', {
      authToken: multiScopeV1Token, legalEntityId: 'legal-default',
    });
    const allocationScopeDefaultBody = await allocationScopeDefault.json();
    const allocationScopeOther = await applyOperationalImportV1('allocations', allocationScopeBody, 'allocation-v1-scope-key', {
      authToken: multiScopeV1Token, legalEntityId: 'legal-default-other',
    });
    const allocationScopeOtherBody = await allocationScopeOther.json();
    assert.notEqual(allocationScopeDefaultBody.log.id, allocationScopeOtherBody.log.id,
      'the same actor/key/request resolves to an independent batch in a different legal-entity scope');
    assert.equal(allocationScopeOtherBody.status, 'Dry Run');
    assert.ok(allocationScopeOtherBody.errorRows > 0,
      'an entity outside the selected legal scope is treated as unavailable, not replayed from another scope');

    const timesheetForgedIdentifierResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-forged-source-id.csv',
      totalRows: 2,
      clientErrors: [{
        rowNumber: 2,
        field: 'employeeId',
        message: 'Preflight rejected the row.',
        sourceIdentifier: 'FORGED-TIMESHEET-EMPLOYEE-ID',
      }],
      rows: [{
        employeeId: 'EMP-PROJECT-RACE-OTHER',
        weekEnding: '2026-02-06',
        workType: 'Client Misc Task',
        clientName: 'Synthetic Client',
        category: 'Support',
        date: '2026-02-04',
        hours: 2,
        billable: false,
        status: 'Submitted',
      }],
    });
    assert.equal(timesheetForgedIdentifierResponse.status, 200);
    const timesheetForgedIdentifierBody = await timesheetForgedIdentifierResponse.json();
    assert.deepEqual(timesheetForgedIdentifierBody.errors, [{
      rowNumber: 2,
      field: 'employeeId',
      message: 'Preflight rejected the row.',
      sourceIdentifier: null,
    }, {
      rowNumber: 3,
      field: 'employeeId',
      message: 'Timesheet must reference an active employee.',
      sourceIdentifier: null,
    }], 'timesheet apply must discard client-claimed upstream IDs for both preflight and server rejections');
    const timesheetForgedIdentifierLog = (await pool.query(
      `select errors from import_export_logs where id=$1`,
      [timesheetForgedIdentifierBody.log.id],
    )).rows[0];
    assert.deepEqual(timesheetForgedIdentifierLog.errors, timesheetForgedIdentifierBody.errors,
      'timesheet rejection IDs must be null in both HTTP output and stored history');
    assert.equal(JSON.stringify(timesheetForgedIdentifierLog.errors).includes('FORGED-TIMESHEET-EMPLOYEE-ID'), false,
      'timesheet import history must not retain a client-forged source identifier');
    const timesheetForgedIdentifierState = await pool.query(`select
        (select count(*)::int from timesheets where employee_id='e-project-race-other' and week_ending=date '2026-02-06') as rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows`,
    [timesheetForgedIdentifierBody.log.id]);
    assert.deepEqual(timesheetForgedIdentifierState.rows, [{rows:0,audit_rows:0}],
      'the invalid timesheet batch must not mutate a cross-legal employee or create success audits');

    const timesheetPartialResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-partial.csv',
      totalRows: 4,
      rows: [
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          weekEnding: '2026-02-06',
          workType: 'Project Work',
          projectId: 'PROJECT-IMPORT-SOURCE-1',
          category: 'Delivery',
          date: '2026-02-02',
          hours: 8,
          remark: 'Synthetic project delivery',
          billable: true,
          status: 'Draft',
        },
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          weekEnding: '2026-02-06',
          workType: 'Client Misc Task',
          clientName: 'Synthetic Client With Source ID',
          category: 'Workshop',
          date: '2026-02-03',
          hours: 4,
          remark: 'Synthetic client workshop',
          billable: false,
          status: 'Draft',
        },
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          weekEnding: '2026-02-13',
          workType: 'Client Misc Task',
          clientName: 'Synthetic Client With Source ID',
          category: 'Support',
          date: '2026-02-11',
          hours: 3,
          billable: false,
          status: 'Submitted',
        },
        {
          employeeId: 'EMP-PROJECT-RACE-OTHER',
          weekEnding: '2026-02-06',
          workType: 'Client Misc Task',
          clientName: 'Synthetic Client With Source ID',
          category: 'Support',
          date: '2026-02-04',
          hours: 2,
          billable: false,
          status: 'Submitted',
        },
      ],
    });
    assert.equal(timesheetPartialResponse.status, 200);
    const timesheetPartialBody = await timesheetPartialResponse.json();
    assert.deepEqual({status: timesheetPartialBody.status, totalRows: timesheetPartialBody.totalRows,
      validRows: timesheetPartialBody.validRows, errorRows: timesheetPartialBody.errorRows},
    {status: 'Partial', totalRows: 4, validRows: 3, errorRows: 1},
    'the real timesheet apply route must preserve its input-entry partial counts');
    assert.deepEqual(timesheetPartialBody.errors, [{
      rowNumber: 5,
      field: 'employeeId',
      message: 'Timesheet must reference an active employee.',
      sourceIdentifier: null,
    }], 'a foreign legal-entity employee must remain a row-local timesheet import denial');
    const timesheetPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [timesheetPartialBody.log.id])).rows[0];
    assert.equal(timesheetPartialLog.id, timesheetPartialBody.log.id,
      'timesheet batch history must return its persisted server batch ID');
    assert.equal(timesheetPartialLog.status, 'Partial');
    assert.equal(timesheetPartialLog.organization_id, 'org-default');
    assert.equal(timesheetPartialLog.legal_entity_id, 'legal-default');
    assert.equal(timesheetPartialLog.total_rows, 4);
    assert.equal(timesheetPartialLog.valid_rows, 3,
      'the aggregate timesheet log must continue counting accepted input entries, not groups');
    assert.equal(timesheetPartialLog.error_rows, 1);
    assert.deepEqual(timesheetPartialLog.errors, timesheetPartialBody.errors,
      'timesheet rejection must preserve null upstream ID in HTTP response and persisted history');
    const timesheetPartialAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result,details,entity_id
      from audit_logs where import_batch_id=$1 order by details`, [timesheetPartialBody.log.id]);
    assert.equal(timesheetPartialAudit.rowCount, 2,
      'the import must write one audit event per persisted employee/week group, not one per CSV row');
    assert.deepEqual(timesheetPartialAudit.rows.map(row => ({
      action: row.action,
      source: row.source,
      source_identifier: row.source_identifier,
      import_batch_id: row.import_batch_id,
      import_processing_result: row.import_processing_result,
      details: row.details,
    })), [
      {
        action: 'Import Create Timesheet',
        source: 'Timesheet Import CSV',
        source_identifier: null,
        import_batch_id: timesheetPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created Draft timesheet for EMP-IMPORT-SUCCESS, week ending 2026-02-06 from synthetic-timesheet-partial.csv',
      },
      {
        action: 'Import Create Timesheet',
        source: 'Timesheet Import CSV',
        source_identifier: null,
        import_batch_id: timesheetPartialBody.log.id,
        import_processing_result: 'Success',
        details: 'Created Submitted timesheet for EMP-IMPORT-SUCCESS, week ending 2026-02-13 from synthetic-timesheet-partial.csv',
      },
    ], 'timesheet group audits must retain source, null absent upstream IDs, success result and shared batch link');
    assert(timesheetPartialAudit.rows.every(row => /^[0-9a-f-]{36}$/.test(row.entity_id)),
      'each timesheet group audit must point at its persisted timesheet entity');
    const timesheetPartialState = await pool.query(`select t.id::text as id,e.employee_id,t.week_ending::text as week_ending,t.status,
        t.total_hours::text as total_hours,t.billable_hours::text as billable_hours,count(te.id)::int as entries
      from timesheets t
      join employees e on e.id=t.employee_id
      left join timesheet_entries te on te.timesheet_id=t.id
      where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending in (date '2026-02-06',date '2026-02-13')
      group by t.id,e.employee_id order by t.week_ending`);
    assert.deepEqual(timesheetPartialState.rows.map(({id, ...row}) => row), [
      {employee_id:'EMP-IMPORT-SUCCESS',week_ending:'2026-02-06',status:'Draft',total_hours:'12',billable_hours:'8',entries:2},
      {employee_id:'EMP-IMPORT-SUCCESS',week_ending:'2026-02-13',status:'Submitted',total_hours:'3',billable_hours:'0',entries:1},
    ], 'timesheet provenance must preserve one grouped timesheet per employee/week and its input entries');
    const rejectedScopeTimesheet = await pool.query(`select
        (select count(*)::int from timesheets where employee_id='e-project-race-other' and week_ending=date '2026-02-06') as rows,
        (select count(*)::int from audit_logs where import_batch_id=$1
          and details like '%EMP-PROJECT-RACE-OTHER%') as audit_rows`,
    [timesheetPartialBody.log.id]);
    assert.deepEqual(rejectedScopeTimesheet.rows, [{rows:0,audit_rows:0}],
      'the rejected cross-legal employee row must not create timesheets or a successful group audit');

    const timesheetUpdateResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-update.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-SUCCESS',
        weekEnding: '2026-02-06',
        workType: 'Client Misc Task',
        clientName: 'Synthetic Client With Source ID',
        category: 'Updated Category',
        date: '2026-02-04',
        hours: 6,
        remark: 'Synthetic same-scope group update',
        billable: false,
        status: 'Submitted',
      }],
    });
    assert.equal(timesheetUpdateResponse.status, 200);
    const timesheetUpdateBody = await timesheetUpdateResponse.json();
    assert.equal(timesheetUpdateBody.status, 'Success', 'same-scope editable Draft imports retain group upsert behavior and may submit the replacement');
    assert.equal(timesheetUpdateBody.validRows, 1);
    assert.equal(timesheetUpdateBody.errorRows, 0);
    const timesheetUpdateState = await pool.query(`select t.id::text as id,t.status,t.total_hours::text as total_hours,
        t.billable_hours::text as billable_hours,count(te.id)::int as entries
      from timesheets t join employees e on e.id=t.employee_id
      left join timesheet_entries te on te.timesheet_id=t.id
      where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-06'
      group by t.id`);
    assert.deepEqual(timesheetUpdateState.rows, [{
      id: timesheetPartialState.rows[0].id,
      status: 'Submitted',
      total_hours: '6',
      billable_hours: '0',
      entries: 1,
    }], 'editable Draft-to-Submitted upsert preserves the group ID while replacing its entries');
    const timesheetUpdateAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result
      from audit_logs where import_batch_id=$1`, [timesheetUpdateBody.log.id]);
    assert.deepEqual(timesheetUpdateAudit.rows, [{
      action: 'Import Update Timesheet',
      source: 'Timesheet Import CSV',
      source_identifier: null,
      import_batch_id: timesheetUpdateBody.log.id,
      import_processing_result: 'Success',
    }], 'same-scope timesheet group updates must preserve provenance and update audit behavior');

    const retainedTimesheetSnapshot = async () => (await pool.query(`select jsonb_build_object(
        'header',to_jsonb(t),
        'entries',(select jsonb_agg(to_jsonb(e) order by e.id) from timesheet_entries e where e.timesheet_id=t.id),
        'submissions',(select jsonb_agg(to_jsonb(w) order by w.sequence) from work_submission_evidence w where w.timesheet_id=t.id),
        'decisions',(select jsonb_agg(to_jsonb(d) order by d.id) from work_submission_decisions d join work_submission_evidence w on w.id=d.submission_id where w.timesheet_id=t.id),
        'approvals',(select jsonb_agg(to_jsonb(a) order by a.id) from approval_records a where a.entity_type='Timesheet' and a.entity_id=t.id::text)
      ) value from timesheets t where t.id=$1`, [timesheetUpdateState.rows[0].id])).rows;
    const retainedSubmitted = await retainedTimesheetSnapshot();
    const protectedTimesheetResponse = await applyTimesheets({
      fileName:'synthetic-timesheet-protected-replacement.csv', rows:[{
        employeeId:'EMP-IMPORT-SUCCESS',weekEnding:'2026-02-06',workType:'Client Misc Task',
        clientName:'Synthetic forbidden replacement',date:'2026-02-04',hours:1,status:'Draft',
      }],
    });
    assert.equal(protectedTimesheetResponse.status,200);
    const protectedTimesheetBody = await protectedTimesheetResponse.json();
    assert.equal(protectedTimesheetBody.status,'Failed');assert.equal(protectedTimesheetBody.validRows,0);
    assert.equal(protectedTimesheetBody.errors[0]?.code,'WORK_HISTORY_IMMUTABLE');
    assert.deepEqual(await retainedTimesheetSnapshot(),retainedSubmitted,
      'Submitted replacement denial preserves the complete header, entries, immutable submissions, decisions and source approvals');
    assert.equal((await pool.query('select count(*)::int n from audit_logs where import_batch_id=$1 and entity_type=\'Timesheet\'', [protectedTimesheetBody.log.id])).rows[0].n,0,
      'denied Submitted replacement has no successful group audit');

    const timesheetFutureResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-future.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-SUCCESS',
        weekEnding: '2099-12-31',
        workType: 'Client Misc Task',
        clientName: 'Synthetic Client With Source ID',
        date: '2099-12-30',
        hours: 2,
        status: 'Submitted',
      }],
    });
    assert.equal(timesheetFutureResponse.status, 200);
    const timesheetFutureBody = await timesheetFutureResponse.json();
    assert.equal(timesheetFutureBody.status, 'Failed');
    assert.equal(timesheetFutureBody.validRows, 0);
    assert.deepEqual(timesheetFutureBody.errors, [{
      rowNumber: 2,
      field: 'date',
      message: 'Future work dates cannot be imported; Submitted headers must also end no later than today.',
      sourceIdentifier: null,
    }], 'future timesheet rows must retain their pre-existing rejection and error shape');
    const timesheetFutureAudit = await pool.query(`select count(*)::int as audit_rows
      from audit_logs where import_batch_id=$1`, [timesheetFutureBody.log.id]);
    assert.deepEqual(timesheetFutureAudit.rows, [{audit_rows:0}],
      'a future-dated failed batch must not write a group audit event');

    await pool.query(`update reporting_periods set status='Closed' where id='period-timesheet-import-week-08'`);
    const timesheetClosedPeriodResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-closed-period.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-SUCCESS',
        weekEnding: '2026-02-20',
        workType: 'Client Misc Task',
        clientName: 'Synthetic Client With Source ID',
        date: '2026-02-18',
        hours: 2,
        status: 'Submitted',
      }],
    });
    assert.equal(timesheetClosedPeriodResponse.status, 200);
    const timesheetClosedPeriodBody = await timesheetClosedPeriodResponse.json();
    assert.equal(timesheetClosedPeriodBody.status, 'Failed');
    assert.deepEqual(timesheetClosedPeriodBody.errors, [{
      rowNumber: 2,
      field: 'date',
      message: 'Reporting period WOS03B-WEEK-2026-08 does not permit this timesheet operation',
      code: 'REPORTING_PERIOD_CLOSED',
      sourceIdentifier: null,
    }], 'closed-period failures must preserve their scoped row-level outcome');
    const timesheetClosedPeriodState = await pool.query(`select
        (select count(*)::int from timesheets t join employees e on e.id=t.employee_id
          where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-20') as rows,
        (select count(*)::int from audit_logs where import_batch_id=$1) as audit_rows`,
    [timesheetClosedPeriodBody.log.id]);
    assert.deepEqual(timesheetClosedPeriodState.rows, [{rows:0,audit_rows:0}],
      'a closed reporting period must not persist a timesheet or success audit');
    await pool.query(`update reporting_periods set status='Open' where id='period-timesheet-import-week-08'`);

    await pool.query(`create or replace function reject_synthetic_timesheet_import_log()
      returns trigger language plpgsql as $$ begin
        if new.file_name='synthetic-timesheet-rollback.csv' then raise exception 'synthetic timesheet import-log failure'; end if;
        return new;
      end; $$`);
    await pool.query(`create trigger reject_synthetic_timesheet_import_log
      before insert on import_export_logs for each row execute function reject_synthetic_timesheet_import_log()`);
    const timesheetRollbackResponse = await applyTimesheets({
      fileName: 'synthetic-timesheet-rollback.csv',
      rows: [{
        employeeId: 'EMP-IMPORT-SUCCESS',
        weekEnding: '2026-02-27',
        workType: 'Client Misc Task',
        clientName: 'Synthetic Client With Source ID',
        date: '2026-02-25',
        hours: 2,
        status: 'Submitted',
      }],
    });
    assert.equal(timesheetRollbackResponse.status, 500,
      'a failed timesheet batch-log write must return the legacy generic failure');
    assert.deepEqual(await timesheetRollbackResponse.json(), {error: 'Timesheet import apply failed'});
    const timesheetRollbackRows = await pool.query(`select
        (select count(*)::int from timesheets t join employees e on e.id=t.employee_id
          where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27') as timesheet_rows,
        (select count(*)::int from timesheet_entries te join timesheets t on t.id=te.timesheet_id
          join employees e on e.id=t.employee_id
          where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27') as entry_rows,
        (select count(*)::int from audit_logs where source='Timesheet Import CSV'
          and details like '%synthetic-timesheet-rollback.csv%') as audit_rows,
        (select count(*)::int from import_export_logs where file_name='synthetic-timesheet-rollback.csv') as batch_rows`);
    assert.deepEqual(timesheetRollbackRows.rows, [{timesheet_rows:0,entry_rows:0,audit_rows:0,batch_rows:0}],
      'a failed timesheet batch-log write must roll back the timesheet, entries and group audit');

    const v1TimesheetBody = {
      schemaVersion: 'timesheet-import/1', dryRun: true, fileName: 'synthetic-timesheet-v1-dry-run.csv',
      totalRows: 3,
      clientErrors: [{rowNumber:2,field:'employeeId',message:'Synthetic client preflight rejection.',sourceIdentifier:'FORGED-TIMESHEET-SOURCE-ID'}],
      rows: [
        {employeeId:'EMP-IMPORT-SUCCESS',weekEnding:'2026-02-27',workType:'Client Misc Task',clientName:'Synthetic Client',date:'2026-02-25',hours:2,status:''},
        {employeeId:'EMP-IMPORT-SUCCESS',weekEnding:'2026-02-27',workType:'Client Misc Task',clientName:'Synthetic Client',date:'2026-02-25',hours:2,status:''},
      ],
    };
    const missingTimesheetKey = await applyOperationalImportV1('timesheets', v1TimesheetBody, undefined);
    assert.equal(missingTimesheetKey.status, 400);
    assertVersionedErrorResponse(missingTimesheetKey, await missingTimesheetKey.json(), {
      code:'IDEMPOTENCY_KEY_REQUIRED',message:'The Idempotency-Key header is required.',
    });
    const unsupportedTimesheetSchema = await applyOperationalImportV1('timesheets', {
      ...v1TimesheetBody, schemaVersion:'timesheet-import/99',
    }, 'timesheet-v1-unsupported-schema-key');
    assert.equal(unsupportedTimesheetSchema.status, 400);
    assertVersionedErrorResponse(unsupportedTimesheetSchema, await unsupportedTimesheetSchema.json(), {
      code:'UNSUPPORTED_SCHEMA_VERSION',message:'The timesheet import schema version is not supported.',
    });

    const v1TimesheetPreview = await applyOperationalImportV1('timesheets', v1TimesheetBody, 'timesheet-v1-dry-run-key');
    assert.equal(v1TimesheetPreview.status, 200);
    const v1TimesheetPreviewBody = await v1TimesheetPreview.json();
    assert.deepEqual({status:v1TimesheetPreviewBody.status,validRows:v1TimesheetPreviewBody.validRows,
      errorRows:v1TimesheetPreviewBody.errorRows,schemaVersion:v1TimesheetPreviewBody.log.schema_version,
      dryRun:v1TimesheetPreviewBody.log.dry_run},
    {status:'Dry Run',validRows:1,errorRows:2,schemaVersion:'timesheet-import/1',dryRun:true},
    'v1 Timesheet dry run preserves row-level duplicate/preflight results and records schema metadata');
    assert.deepEqual(v1TimesheetPreviewBody.errors.map(error => ({rowNumber:error.rowNumber,sourceIdentifier:error.sourceIdentifier})), [
      {rowNumber:2,sourceIdentifier:null},
      {rowNumber:4,sourceIdentifier:null},
    ], 'Timesheet Import continues to emit null source identifiers, including for forged caller-provided IDs');
    const v1TimesheetPreviewRows = await pool.query(`select
        (select count(*)::int from timesheets t join employees e on e.id=t.employee_id
          where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27') as timesheet_rows,
        (select count(*)::int from timesheet_entries te join timesheets t on t.id=te.timesheet_id
          join employees e on e.id=t.employee_id where e.employee_id='EMP-IMPORT-SUCCESS'
          and t.week_ending=date '2026-02-27') as entry_rows,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Timesheet') as row_audits,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='ImportBatch'
          and action='Dry Run Timesheet Import' and import_processing_result='Dry Run') as dry_run_audits,
        (select count(*)::int from import_export_idempotency where batch_id=$1 and channel='Timesheet Import') as key_rows`,
    [v1TimesheetPreviewBody.log.id]);
    assert.deepEqual(v1TimesheetPreviewRows.rows, [{timesheet_rows:0,entry_rows:0,row_audits:0,dry_run_audits:1,key_rows:1}],
      'Timesheet dry run writes only batch/audit/idempotency evidence, not timesheet headers or entries');
    const emptyTimesheetDryRun = await applyOperationalImportV1('timesheets', {
      ...v1TimesheetBody, fileName:'synthetic-timesheet-v1-empty-dry-run.csv', totalRows:1, rows:[],
      clientErrors:[{rowNumber:2,field:'header',message:'Synthetic preflight rejected every row.'}],
    }, 'timesheet-v1-empty-dry-run-key');
    const emptyTimesheetDryRunBody = await emptyTimesheetDryRun.json();
    assert.deepEqual({status:emptyTimesheetDryRunBody.status,validRows:emptyTimesheetDryRunBody.validRows,
      errorRows:emptyTimesheetDryRunBody.errorRows,dryRun:emptyTimesheetDryRunBody.log.dry_run},
    {status:'Dry Run',validRows:0,errorRows:1,dryRun:true},
    'a zero-valid-row Timesheet Import dry run still persists its diagnostic batch');
    const v1TimesheetPreviewRetry = await applyOperationalImportV1('timesheets', v1TimesheetBody, 'timesheet-v1-dry-run-key');
    const v1TimesheetPreviewRetryBody = await v1TimesheetPreviewRetry.json();
    assert.equal(v1TimesheetPreviewRetryBody.log.id, v1TimesheetPreviewBody.log.id,
      'an identical Timesheet Import dry-run retry replays the original batch');
    const v1TimesheetChangedKey = await applyOperationalImportV1('timesheets', {
      ...v1TimesheetBody, rows: [{...v1TimesheetBody.rows[0], hours:3}],
    }, 'timesheet-v1-dry-run-key');
    assert.equal(v1TimesheetChangedKey.status, 409);
    assertVersionedErrorResponse(v1TimesheetChangedKey, await v1TimesheetChangedKey.json(), {
      code:'IDEMPOTENCY_KEY_REUSED',message:'This Idempotency-Key was already used with a different request.',
    });

    const aliasDuplicateTimesheetResponse = await applyOperationalImportV1('timesheets', {
      schemaVersion: 'timesheet-import/1', dryRun: true,
      fileName: 'synthetic-timesheet-v1-alias-duplicate.csv', totalRows: 4, clientErrors: [],
      rows: [
        {employeeId: 'EMP-IMPORT-SUCCESS', weekEnding: '2026-02-27', workType: 'Client Misc Task',
          clientName: 'Synthetic Alias Task', date: '2026-02-25', hours: 2, status: 'Submitted'},
        {employeeId: allocationAliasIds.rows[0].employee_id, weekEnding: '2026-02-27', workType: 'Client Misc Task',
          clientName: 'Synthetic Alias Task', date: '2026-02-25', hours: 2, status: 'Submitted'},
        {employeeId: 'EMP-IMPORT-SUCCESS', weekEnding: '2026-02-27', workType: 'Project Work',
          projectId: 'PROJECT-IMPORT-SOURCE-1', date: '2026-02-25', hours: 1, status: 'Submitted'},
        {employeeId: allocationAliasIds.rows[0].employee_id, weekEnding: '2026-02-27', workType: 'Project Work',
          projectId: allocationAliasIds.rows[0].project_id, date: '2026-02-25', hours: 1, status: 'Submitted'},
      ],
    }, 'timesheet-v1-alias-duplicate-key');
    const aliasDuplicateTimesheet = await aliasDuplicateTimesheetResponse.json();
    assert.deepEqual({status: aliasDuplicateTimesheet.status, validRows: aliasDuplicateTimesheet.validRows,
      errorRows: aliasDuplicateTimesheet.errorRows}, {status: 'Dry Run', validRows: 2, errorRows: 2},
    'v1 Timesheet Import resolves employee and project aliases before checking natural duplicate keys');
    assert.deepEqual(aliasDuplicateTimesheet.errors.map(error => ({field: error.field, rowNumber: error.rowNumber})), [
      {field: 'timesheetEntryKey', rowNumber: 3},
      {field: 'timesheetEntryKey', rowNumber: 5},
    ]);
    assert.deepEqual((await pool.query(`select count(*)::int as rows from timesheets t join employees e on e.id=t.employee_id
      where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27'`)).rows, [{rows: 0}],
    'canonical duplicate Timesheet dry-run remains write-free');

    const outOfWeekTimesheetResponse = await applyOperationalImportV1('timesheets', {
      schemaVersion: 'timesheet-import/1', dryRun: true,
      fileName: 'synthetic-timesheet-v1-out-of-week.csv', totalRows: 1, clientErrors: [],
      rows: [{employeeId: 'EMP-IMPORT-SUCCESS', weekEnding: '2026-02-27',
        workType: 'Client Misc Task', clientName: 'Synthetic Out of Week Task',
        date: '2026-02-28', hours: 1, status: 'Submitted'}],
    }, 'timesheet-v1-out-of-week-key');
    const outOfWeekTimesheet = await outOfWeekTimesheetResponse.json();
    assert.deepEqual({validRows: outOfWeekTimesheet.validRows, errorRows: outOfWeekTimesheet.errorRows,
      field: outOfWeekTimesheet.errors[0]?.field}, {validRows: 0, errorRows: 1, field: 'date'},
    'versioned Timesheet Import rejects work dates outside the seven-day week ending without changing legacy behavior');
    assert.match(outOfWeekTimesheet.errors[0].message, /must fall within the seven-day period ending 2026-02-27/);

    const timesheetConcurrencyBody = {
      schemaVersion:'timesheet-import/1',dryRun:false,fileName:'synthetic-timesheet-v1-concurrent.csv',
      totalRows:2,clientErrors:[],rows:[
        {employeeId:'EMP-IMPORT-SUCCESS',weekEnding:'2026-02-27',workType:'Client Misc Task',clientName:'Synthetic Concurrent Client',date:'2026-02-25',hours:2,status:'Draft'},
        {employeeId:'EMP-IMPORT-SUCCESS',weekEnding:'2026-02-27',workType:'Client Misc Task',clientName:'Synthetic Concurrent Client',date:'2026-02-26',hours:3,status:'Draft'},
      ],
    };
    const concurrentTimesheetResponses = await Promise.all([
      applyOperationalImportV1('timesheets',timesheetConcurrencyBody,'timesheet-v1-concurrent-key'),
      applyOperationalImportV1('timesheets',timesheetConcurrencyBody,'timesheet-v1-concurrent-key'),
    ]);
    assert.deepEqual(concurrentTimesheetResponses.map(response => response.status), [200,200],
      'concurrent same-key Timesheet Import applies both return a result');
    const concurrentTimesheetBodies = await Promise.all(concurrentTimesheetResponses.map(response => response.json()));
    assert.equal(concurrentTimesheetBodies[0].log.id,concurrentTimesheetBodies[1].log.id,
      'concurrent same-key timesheet requests replay one operation batch');
    const concurrentTimesheetState = await pool.query(`select
        (select count(*)::int from timesheets t join employees e on e.id=t.employee_id
          where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27') as timesheets,
        (select count(*)::int from timesheet_entries te join timesheets t on t.id=te.timesheet_id
          join employees e on e.id=t.employee_id where e.employee_id='EMP-IMPORT-SUCCESS'
          and t.week_ending=date '2026-02-27') as entries,
        (select count(*)::int from audit_logs where import_batch_id=$1 and entity_type='Timesheet') as group_audits,
        (select count(*)::int from import_export_idempotency where batch_id=$1 and channel='Timesheet Import') as key_rows`,
    [concurrentTimesheetBodies[0].log.id]);
    assert.deepEqual(concurrentTimesheetState.rows, [{timesheets:1,entries:2,group_audits:1,key_rows:1}],
      'a same-key timesheet apply creates one group, its two entries, one group audit and one key record');
    assert.equal(concurrentTimesheetBodies[0].validRows,2,
      'Timesheet valid-row counts remain input-entry counts rather than timesheet-group counts');

    const timesheetReplacementBody = {
      ...timesheetConcurrencyBody, fileName:'synthetic-timesheet-v1-replacement.csv',
      rows:[{...timesheetConcurrencyBody.rows[0],date:'2026-02-24',hours:4}],
      totalRows:1,
    };
    const timesheetReplacement = await applyOperationalImportV1('timesheets',timesheetReplacementBody,'timesheet-v1-replacement-key');
    const timesheetReplacementBodyResult = await timesheetReplacement.json();
    assert.equal(timesheetReplacementBodyResult.status,'Success');
    const replacedTimesheetEntries = await pool.query(`select t.total_hours,count(te.id)::int as entry_count,
        min(te.hours)::numeric as hours from timesheets t join employees e on e.id=t.employee_id
        join timesheet_entries te on te.timesheet_id=t.id
      where e.employee_id='EMP-IMPORT-SUCCESS' and t.week_ending=date '2026-02-27'
      group by t.id`);
    assert.deepEqual(replacedTimesheetEntries.rows.map(row => ({
      total_hours:Number(row.total_hours), entry_count:row.entry_count, hours:Number(row.hours),
    })),[{total_hours:4,entry_count:1,hours:4}],
      'a distinct timesheet import key preserves editable Draft per-week replacement semantics rather than appending entries');

    const timesheetScopeBody = {...timesheetConcurrencyBody, fileName:'synthetic-timesheet-scope-isolation.csv',dryRun:true};
    const timesheetScopeDefault = await applyOperationalImportV1('timesheets',timesheetScopeBody,'timesheet-v1-scope-key',{
      authToken:multiScopeV1Token,legalEntityId:'legal-default',
    });
    const timesheetScopeDefaultBody = await timesheetScopeDefault.json();
    const timesheetScopeOther = await applyOperationalImportV1('timesheets',timesheetScopeBody,'timesheet-v1-scope-key',{
      authToken:multiScopeV1Token,legalEntityId:'legal-default-other',
    });
    const timesheetScopeOtherBody = await timesheetScopeOther.json();
    assert.notEqual(timesheetScopeDefaultBody.log.id,timesheetScopeOtherBody.log.id,
      'Timesheet Import idempotency records are isolated by the server-resolved legal-entity scope');
    assert.equal(timesheetScopeOtherBody.status,'Dry Run');
    assert.ok(timesheetScopeOtherBody.errorRows > 0,
      'out-of-scope timesheet employees are reported as unavailable and are never replayed from another legal entity');

    const multiScopeToken = tokenFor(multiScopeActorId, 'synthetic-multi-scope-admin');
    const employeeTokenWithoutAdminPermissions = tokenFor(auditDeniedActorId, 'synthetic-no-audit', 'Employee');
    const scopeFreeAuditorToken = tokenFor(scopeFreeAuditorId, 'synthetic-scope-free-auditor', 'Employee');
    const postScopedJson = (path, authToken, organizationId, legalEntityId, body) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: scopedHeaders(authToken, organizationId, legalEntityId, {'Content-Type': 'application/json'}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const getScoped = (path, authToken, organizationId, legalEntityId) => fetch(`${baseUrl}${path}`, {
      headers: scopedHeaders(authToken, organizationId, legalEntityId),
      signal: AbortSignal.timeout(5000),
    });

    // Exercise the extracted availability seam with the real identity, scope, permission and SQL layers.
    const availabilityActorId = randomUUID();
    const availabilityIds = ['availability-self', 'availability-report', 'availability-unrelated', 'availability-exited'];
    await pool.query(`insert into country_directors (id,name,region)
      values ('cd-availability-test','Synthetic Availability Director','Synthetic')`);
    await pool.query(`insert into employees
        (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      select id,upper(id),'Synthetic '||id,id||'@example.test','Consultant','Engineering','US',
        case when id='availability-unrelated' then 'cd-import-provenance-test' else 'cd-availability-test' end,
        case when id='availability-exited' then 'Exited' else 'Active' end,'org-default','legal-default'
      from unnest($1::text[]) as fixture(id)`, [availabilityIds]);
    await pool.query(`update employees set reporting_manager_id='availability-self' where id='availability-report'`);
    await pool.query(`insert into users (id,username,employee_id,email,status)
      values ($1,'synthetic-availability-user','AVAILABILITY-SELF','availability-user@example.test','Active')`, [availabilityActorId]);
    await pool.query("update users set employee_record_id='availability-self' where id=$1",[availabilityActorId]);
    await pool.query("update employees set designation='Country Director' where id='availability-self'");
    await pool.query(`insert into user_roles (user_id,role_id)
      select $1,id from roles where name in ('Employee','TeamLead','ProjectManager','CountryDirector')`, [availabilityActorId]);
    await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
      values ($1,'org-default','legal-default',true)`, [availabilityActorId]);
    await pool.query(`insert into projects
        (id,project_code,name,client,manager_id,manager_name,start_date,end_date,status,organization_id,legal_entity_id)
      values ('availability-project','AVAILABILITY-PROJECT','Synthetic Availability Project','Synthetic Client',
        'availability-self','Synthetic Manager',date '2026-01-01',date '2026-12-31','Active','org-default','legal-default')`);
    await pool.query(`insert into project_allocations
        (id,employee_id,project_id,percentage,start_date,end_date,status,organization_id,legal_entity_id)
      values ('availability-allocation','availability-report','availability-project',10,
        date '2026-01-01',date '2026-12-31','Active','org-default','legal-default')`);
    try {
      const auditCountBeforeAvailability = Number((await pool.query('select count(*)::int as count from audit_logs')).rows[0].count);
      const unauthenticatedAvailability = await fetch(`${baseUrl}/api/reports/availability`, {signal: AbortSignal.timeout(5000)});
      assert.equal(unauthenticatedAvailability.status, 401);
      await unauthenticatedAvailability.json();
      for (const [role, expectedIds] of [
        ['Employee', ['availability-self']],
        ['TeamLead', ['availability-self', 'availability-report']],
        ['ProjectManager', ['availability-self', 'availability-report']],
        ['CountryDirector', ['availability-self', 'availability-report']],
      ]) {
        const availabilityToken = tokenFor(availabilityActorId, 'synthetic-availability-user', role, {
          employeeRecordId: 'availability-self', employeeId: 'AVAILABILITY-SELF', countryDirectorId: 'cd-availability-test',
        });
        const response = await getScoped('/api/reports/availability?year=1900&employee_id=employee-scope-beta',
          availabilityToken, 'org-default', 'legal-default');
        assert.equal(response.status, 200, `${role} may read only its existing availability scope`);
        const body = await response.json();
        assert.deepEqual(body.map(row => row.employee_id).sort(), expectedIds.sort(),
          `${role} report excludes unrelated, exited, foreign-organization and foreign-legal-entity workers`);
        assert.ok(body.every(row => typeof row.availability_hours === 'string'), 'PostgreSQL numeric output stays unchanged');
        const wrongScope = await getScoped('/api/reports/availability', availabilityToken, 'org-scope-beta', 'legal-scope-beta');
        assert.equal(wrongScope.status, 403);
        assert.equal((await wrongScope.json()).code, 'ORG_SCOPE_DENIED');
      }
      for (const [organizationId, legalEntityId, expectedId] of [
        ['org-default', 'legal-default-other', 'employee-cross-legal'],
        ['org-scope-beta', 'legal-scope-beta', 'employee-scope-beta'],
      ]) {
        const response = await getScoped('/api/reports/availability', multiScopeToken, organizationId, legalEntityId);
        assert.equal(response.status, 200);
        const body = await response.json();
        const expected = (await pool.query(`select id from employees
          where organization_id=$1 and legal_entity_id=$2 and status<>'Exited' order by name`,
        [organizationId, legalEntityId])).rows.map(row => row.id);
        assert.deepEqual(body.map(row => row.employee_id), expected, 'Admin reads exactly the server-selected ownership pair');
        assert.ok(expected.includes(expectedId));
      }
      assert.equal(Number((await pool.query('select count(*)::int as count from audit_logs')).rows[0].count),
        auditCountBeforeAvailability, 'availability reads and refusals must not append mutation audit events');
    } finally {
      await pool.query(`delete from project_allocations where id='availability-allocation'`);
      await pool.query(`delete from projects where id='availability-project'`);
      await pool.query('delete from users where id=$1', [availabilityActorId]);
      await pool.query('delete from employees where id=any($1::text[])', [availabilityIds]);
      await pool.query(`delete from country_directors where id='cd-availability-test'`);
    }

    const crossScopeBalanceId = 'synthetic-cross-scope-leave-balance';
    await pool.query(`insert into leave_balances
        (id,employee_id,leave_type_id,policy_id,balance_year,opening_days,accrued_days,used_days,adjusted_days,pending_days,available_days)
      values ($1,'employee-scope-beta','leave-type-annual','leave-policy-global',2099,8,2,0,1,0,11)`, [crossScopeBalanceId]);
    const crossScopeBalanceAttempt = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-default', 'legal-default', {
        id: crossScopeBalanceId,
        employee_id: 'employee-scope-beta',
        leave_type_id: 'leave-type-annual',
        policy_id: 'leave-policy-global',
        year: 2099,
        opening_days: 88,
        accrued_days: 4,
        adjusted_days: 2,
      });
    assert.equal(crossScopeBalanceAttempt.status, 422,
      'a leave administrator cannot upsert another legal entity employee balance through the selected scope');
    assert.deepEqual(await crossScopeBalanceAttempt.json(), {
      error: 'Leave balance employee is not available in the active scope',
    }, 'an out-of-scope balance attempt must return a generic error without employee or balance data');
    const crossScopeBalanceAfterDenial = await pool.query(`select id,employee_id,opening_days,accrued_days,adjusted_days,available_days
      from leave_balances where id=$1`, [crossScopeBalanceId]);
    assert.deepEqual(crossScopeBalanceAfterDenial.rows, [{
      id: crossScopeBalanceId,
      employee_id: 'employee-scope-beta',
      opening_days: '8',
      accrued_days: '2',
      adjusted_days: '1',
      available_days: '11',
    }], 'a rejected cross-scope balance attempt must not mutate the employee balance');
    const crossScopeBalanceAuditAfterDenial = await pool.query(`select id from audit_logs
      where user_id=$1 and entity_type='LeaveBalance' and entity_id=$2`, [multiScopeActorId, crossScopeBalanceId]);
    assert.equal(crossScopeBalanceAuditAfterDenial.rowCount, 0,
      'a rejected cross-scope balance attempt must not create an audit row in the caller-selected scope');

    const defaultScopeEmployeeId = (await pool.query(`select id from employees where employee_id='EMP-IMPORT-SUCCESS'`)).rows[0]?.id;
    assert.ok(defaultScopeEmployeeId, 'the default-scope leave balance fixture employee exists');
    const balanceIdProbeBody = {
      employee_id: defaultScopeEmployeeId,
      leave_type_id: 'leave-type-annual',
      policy_id: 'leave-policy-global',
      year: 2100,
      opening_days: 5,
      accrued_days: 0,
      adjusted_days: 0,
    };
    const crossScopeBalanceIdProbe = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-default', 'legal-default', {...balanceIdProbeBody, id: crossScopeBalanceId});
    const unknownBalanceIdProbe = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-default', 'legal-default', {...balanceIdProbeBody, id: 'synthetic-unseen-leave-balance'});
    assert.equal(crossScopeBalanceIdProbe.status, 404,
      'a selected-scope employee cannot reveal another scope balance by supplying its ID');
    assert.equal(unknownBalanceIdProbe.status, crossScopeBalanceIdProbe.status,
      'an unknown ID and an out-of-scope ID must have the same response status');
    assert.deepEqual(await unknownBalanceIdProbe.json(), await crossScopeBalanceIdProbe.json(),
      'an unknown ID and an out-of-scope ID must have the same generic response body');
    const balanceIdProbeAudit = await pool.query(`select id from audit_logs
      where user_id=$1 and entity_type='LeaveBalance' and entity_id in ($2,$3)`,
    [multiScopeActorId, crossScopeBalanceId, 'synthetic-unseen-leave-balance']);
    assert.equal(balanceIdProbeAudit.rowCount, 0,
      'probing known or unknown IDs must not mutate a balance or create audit evidence');

    const authorizedBalanceCreate = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-default', 'legal-default', balanceIdProbeBody);
    assert.equal(authorizedBalanceCreate.status, 200,
      'a balance can still be created without a client-supplied ID');
    const authorizedBalanceCreateBody = await authorizedBalanceCreate.json();
    assert.match(authorizedBalanceCreateBody.id, /^leave-balance-/,
      'the server must generate the ID for a balance creation');
    assert.equal(authorizedBalanceCreateBody.employee_id, defaultScopeEmployeeId);
    const authorizedBalanceCreateAudit = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='LeaveBalance' and entity_id=$2`,
    [multiScopeActorId, authorizedBalanceCreateBody.id]);
    assert.deepEqual(authorizedBalanceCreateAudit.rows, [{
      action: 'Create Leave Balance', organization_id: 'org-default', legal_entity_id: 'legal-default',
    }], 'a no-ID creation must retain normal scoped audit ownership');
    const authorizedBalanceNaturalUpsert = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-default', 'legal-default', {...balanceIdProbeBody, opening_days: 7});
    assert.equal(authorizedBalanceNaturalUpsert.status, 200,
      'a no-ID upsert of an existing natural key must retain its existing API behavior');
    assert.equal((await authorizedBalanceNaturalUpsert.json()).id, authorizedBalanceCreateBody.id,
      'a no-ID upsert must update the existing employee/type/year balance');
    const authorizedBalanceNaturalUpsertAudit = await pool.query(`select action,old_value,new_value,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='LeaveBalance' and entity_id=$2`,
    [multiScopeActorId, authorizedBalanceCreateBody.id]);
    assert.equal(authorizedBalanceNaturalUpsertAudit.rowCount, 2,
      'a no-ID natural-key update must append a second audit outcome');
    const naturalKeyUpdateAudit = authorizedBalanceNaturalUpsertAudit.rows.find(row => row.action === 'Update Leave Balance');
    assert.ok(naturalKeyUpdateAudit, 'a no-ID natural-key upsert must be audited as an update');
    assert.deepEqual({
      old_opening_days: Number(naturalKeyUpdateAudit.old_value.opening_days),
      new_opening_days: Number(naturalKeyUpdateAudit.new_value.opening_days),
      organization_id: naturalKeyUpdateAudit.organization_id,
      legal_entity_id: naturalKeyUpdateAudit.legal_entity_id,
    }, {
      old_opening_days: 5,
      new_opening_days: 7,
      organization_id: 'org-default',
      legal_entity_id: 'legal-default',
    }, 'a no-ID natural-key update must retain accurate before/after and owner evidence');

    const authorizedBalanceUpdate = await postScopedJson('/api/leave/balances', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: crossScopeBalanceId,
        employee_id: 'employee-scope-beta',
        leave_type_id: 'leave-type-annual',
        policy_id: 'leave-policy-global',
        year: 2099,
        opening_days: 13,
        accrued_days: 3,
        adjusted_days: 1,
      });
    assert.equal(authorizedBalanceUpdate.status, 200,
      'a leave administrator can still update a balance within the selected employee scope');
    const authorizedBalanceBody = await authorizedBalanceUpdate.json();
    assert.equal(authorizedBalanceBody.id, crossScopeBalanceId);
    assert.equal(authorizedBalanceBody.employee_id, 'employee-scope-beta');
    const authorizedBalanceAudit = await pool.query(`select action,organization_id,legal_entity_id,old_value,new_value
      from audit_logs where user_id=$1 and entity_type='LeaveBalance' and entity_id=$2`,
    [multiScopeActorId, crossScopeBalanceId]);
    assert.equal(authorizedBalanceAudit.rowCount, 1,
      'an authorized in-scope balance update must retain its existing audit outcome');
    assert.deepEqual({
      action: authorizedBalanceAudit.rows[0].action,
      organization_id: authorizedBalanceAudit.rows[0].organization_id,
      legal_entity_id: authorizedBalanceAudit.rows[0].legal_entity_id,
      old_employee_id: authorizedBalanceAudit.rows[0].old_value.employee_id,
      new_employee_id: authorizedBalanceAudit.rows[0].new_value.employee_id,
      new_opening_days: Number(authorizedBalanceAudit.rows[0].new_value.opening_days),
    }, {
      action: 'Update Leave Balance',
      organization_id: 'org-scope-beta',
      legal_entity_id: 'legal-scope-beta',
      old_employee_id: 'employee-scope-beta',
      new_employee_id: 'employee-scope-beta',
      new_opening_days: 13,
    }, 'leave balance audit ownership must be derived from the server-resolved employee row');
    const unauthorizedBalanceHistory = await getScoped('/api/audit-logs', multiScopeToken, 'org-default', 'legal-default');
    const authorizedBalanceHistory = await getScoped('/api/audit-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    assert.equal((await unauthorizedBalanceHistory.json()).some(row => row.entity_id === crossScopeBalanceId), false,
      'the employee balance audit must remain absent from another legal entity history');
    assert.equal((await authorizedBalanceHistory.json()).some(row => row.entity_id === crossScopeBalanceId), true,
      'the employee balance audit must be visible in its server-resolved legal entity history');

    await assert.rejects(
      () => pool.query(`insert into audit_logs
        (user_id,user_name,user_role,module,action,details,organization_id,legal_entity_id)
        values ($1,'Synthetic actor','Admin','Scope Test','Reject Partial Scope','Must remain invalid',null,'legal-default')`, [multiScopeActorId]),
      error => error.code === '23514' && error.constraint === 'audit_logs_scope_pair_check',
      'organization audit migration must still reject a legal-entity owner without its organization',
    );
    await assert.rejects(
      () => pool.query(`insert into audit_logs
        (user_id,user_name,user_role,module,action,details,organization_id,legal_entity_id)
        values ($1,'Synthetic actor','Admin','Scope Test','Reject Unknown Organization','Must remain invalid','missing-organization',null)`, [multiScopeActorId]),
      error => error.code === '23503' && error.constraint === 'audit_logs_scope_organization_fk',
      'organization-level audit scope must reference a real organization',
    );

    const organizationProfileResponse = await fetch(`${baseUrl}/api/organization-setup/profile`, {
      method: 'PUT',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({
        name: 'Synthetic Scope Beta Updated',
        legalName: 'Synthetic Scope Beta Updated LLC',
        productDisplayName: 'Synthetic WorkOS Updated',
        supportContact: 'support@example.test',
        defaultLocale: 'en-US',
        defaultTimeZone: 'UTC',
        baseCurrency: 'USD',
        fiscalYearStart: '01-01',
        defaultWeekStart: 1,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationProfileResponse.status, 200, 'organization profile updates retain the selected-scope mutation route');
    const terminologyTerms = Object.fromEntries(['employee','manager','teamLead','businessUnit','region','regionalOwner','engagement','project','worklog']
      .map(key => [key, {singular: `Synthetic ${key}`, plural: `Synthetic ${key}s`, helpText: 'synthetic test label'}]));
    const organizationTerminologyResponse = await fetch(`${baseUrl}/api/v1/organization-setup/terminology`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({terms: terminologyTerms, effectiveFrom: new Date().toISOString().slice(0, 10)}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationTerminologyResponse.status, 201,
      'organization terminology updates retain the versioned selected-scope mutation route');
    const newLegalEntityDate = new Date().toISOString().slice(0, 10);
    const newLegalEntityResponse = await postScopedJson('/api/organization-setup/legal-entities', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        code: 'SYNTH-BETA-2',
        legalName: 'Synthetic Scope Beta Second Legal Entity LLC',
        reportingCurrency: 'USD',
        address: {line1: 'Synthetic second address', city: 'Test City', countryCode: 'US'},
        status: 'Active',
        effectiveFrom: newLegalEntityDate,
      });
    assert.equal(newLegalEntityResponse.status, 201,
      'an organization-scoped Admin can create a legal entity through the existing API route');
    const createdLegalEntity = await newLegalEntityResponse.json();
    const legalEntityCreateAudit = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where entity_id=$1 and entity_type='Legal Entity'`, [createdLegalEntity.id]);
    assert.deepEqual(legalEntityCreateAudit.rows, [{
      action: 'Create Legal Entity', organization_id: 'org-scope-beta', legal_entity_id: null,
    }], 'creating a legal entity must record its organization owner without inheriting the previously selected entity');
    const newLegalEntityUpdateResponse = await fetch(`${baseUrl}/api/organization-setup/legal-entities/${encodeURIComponent(createdLegalEntity.id)}`, {
      method: 'PUT',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', createdLegalEntity.id, {'Content-Type': 'application/json'}),
      body: JSON.stringify({
        code: 'SYNTH-BETA-2',
        legalName: 'Synthetic Scope Beta Second Legal Entity Updated LLC',
        reportingCurrency: 'USD',
        address: {line1: 'Synthetic second address', city: 'Updated Test City', countryCode: 'US'},
        status: 'Active',
        effectiveFrom: newLegalEntityDate,
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(newLegalEntityUpdateResponse.status, 200,
      'a legal-entity update retains its existing exact legal-entity scope');
    const legalEntityOwnershipRows = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where entity_id=$1 and entity_type='Legal Entity' order by action`, [createdLegalEntity.id]);
    assert.deepEqual(legalEntityOwnershipRows.rows, [
      {action: 'Create Legal Entity', organization_id: 'org-scope-beta', legal_entity_id: null},
      {action: 'Update Legal Entity', organization_id: 'org-scope-beta', legal_entity_id: createdLegalEntity.id},
    ], 'creation must be organization-owned and later edits must remain owned by the exact legal entity');
    const organizationOwnershipRows = await pool.query(`select entity_type,entity_id,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type in ('Organization','Terminology') order by entity_type`, [multiScopeActorId]);
    assert.deepEqual(organizationOwnershipRows.rows, [
      {entity_type: 'Organization', entity_id: 'org-scope-beta', organization_id: 'org-scope-beta', legal_entity_id: null},
      {entity_type: 'Terminology', entity_id: `org-scope-beta:${new Date().toISOString().slice(0, 10)}`, organization_id: 'org-scope-beta', legal_entity_id: null},
    ], 'organization-wide profile and terminology mutations must be audited at organization scope, not the selected legal entity');

    const ungrantedOrganizationScopes = await fetch(`${baseUrl}/api/organization-audit-scopes`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(ungrantedOrganizationScopes.status, 403,
      'organization audit designation must be required even for a multi-scope Admin');
    const ungrantedOrganizationRead = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(ungrantedOrganizationRead.status, 403,
      'organization audit data must be denied before an explicit designation exists');
    const genericOrganizationGrant = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId, permissionKey: 'audit.organization.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(genericOrganizationGrant.status, 422,
      'organization audit access must not be granted by the deployment-wide generic user grant route');
    const roleWideOrganizationGrant = await fetch(`${baseUrl}/api/permissions/roles/Admin`, {
      method: 'PATCH',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({permissionKey: 'audit.organization.view', enabled: true}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleWideOrganizationGrant.status, 422,
      'organization audit access must not be enabled for all users with a role');
    const selfOrganizationGrant = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: multiScopeActorId}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(selfOrganizationGrant.status, 422, 'a manager cannot designate themself as an organization auditor');
    const crossOrganizationGrant = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: singleScopeActorId}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(crossOrganizationGrant.status, 422,
      'an organization manager cannot designate a user who has no active access to that organization');
  const employeeGrantAttempt = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
    method: 'POST',
    headers: scopedHeaders(employeeTokenWithoutAdminPermissions, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
    body: JSON.stringify({userId: auditDeniedActorId}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(employeeGrantAttempt.status, 403,
    'an active organization member without permission-management authority cannot designate auditors');
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-disabled-org-auditor','synthetic-disabled-org-auditor@example.test','Disabled')`, [disabledOrganizationAuditorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Employee'`, [disabledOrganizationAuditorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-scope-beta','legal-scope-beta',true)`, [disabledOrganizationAuditorId]);
  const organizationGrantConfigResponse = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
    headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(organizationGrantConfigResponse.status, 200);
  const organizationGrantConfig = await organizationGrantConfigResponse.json();
  assert.equal(organizationGrantConfig.organizationId, 'org-scope-beta');
  assert.deepEqual(organizationGrantConfig.eligibleUsers.map(user => user.id), [auditDeniedActorId],
    'grant management must list only active, non-self users who currently belong to the selected organization');
  const employeeRevokeAttempt = await fetch(`${baseUrl}/api/permissions/organization-audit-grants/nonexistent-grant`, {
    method: 'DELETE',
    headers: scopedHeaders(employeeTokenWithoutAdminPermissions, 'org-scope-beta', 'legal-scope-beta'),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(employeeRevokeAttempt.status, 403,
    'a user without permission-management authority cannot revoke organization auditor designations');
  const disabledTargetGrant = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
    method: 'POST',
    headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
    body: JSON.stringify({userId: disabledOrganizationAuditorId}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(disabledTargetGrant.status, 422,
    'a permission manager cannot designate a disabled account, even when it retains a role and organization-scope row');
  await pool.query(`delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Admin')`, [multiScopeActorId]);
  const staleOrganizationGrantManager = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
    method: 'POST',
    headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
    body: JSON.stringify({userId: auditDeniedActorId}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(staleOrganizationGrantManager.status, 403,
    'a manager whose active role was removed must lose grant authority immediately');
  await pool.query(`insert into user_roles (user_id,role_id) select $1,id from roles where name='Admin'`, [multiScopeActorId]);
    const organizationGrantResponse = await fetch(`${baseUrl}/api/permissions/organization-audit-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationGrantResponse.status, 201,
      'a scoped permission manager can explicitly designate a different active user of any role for this organization');
    const organizationGrant = await organizationGrantResponse.json();
    assert.equal(organizationGrant.organization_id, 'org-scope-beta');
    const organizationGrantAudit = await pool.query(`select organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='OrganizationAuditGrant' and entity_id=$2`,
    [multiScopeActorId, organizationGrant.id]);
    assert.deepEqual(organizationGrantAudit.rows, [{organization_id: 'org-scope-beta', legal_entity_id: null}],
      'grant administration must be auditable at the affected organization scope');

    const organizationAuditorToken = tokenFor(auditDeniedActorId, 'synthetic-no-audit', 'Employee');
    const organizationAuditorSession = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationAuditorSession.status, 200,
      'an explicitly designated organization auditor can refresh identity without selecting a legal entity');
    const organizationAuditorPermissions = await organizationAuditorSession.json();
    assert(organizationAuditorPermissions.permissions.includes('audit.organization.view'),
      'the refreshed session receives the explicit organization-audit permission');
    const organizationScopesResponse = await fetch(`${baseUrl}/api/v1/organization-audit-scopes`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationScopesResponse.status, 200,
      'the versioned organization-audit scope reader supports identity-only access');
    assert.deepEqual(await organizationScopesResponse.json(), [{
      organization_id: 'org-scope-beta', organization_code: 'SCOPE-BETA',
      organization_name: 'Synthetic Scope Beta Updated', status: 'Active',
    }], 'an auditor must list only the organization explicitly designated for them');
    await pool.query(`insert into audit_logs
        (user_id,user_name,user_role,active_role,source,module,action,details,entity_type,entity_id,organization_id,legal_entity_id)
      values ($1,'Synthetic multi-scope Admin','Admin','Admin','Synthetic organization test','Organization Audit Test',
        'Other Organization Row','Must remain hidden','OrganizationAuditTest','organization-audit-other-org','org-default',null)`, [multiScopeActorId]);
    const organizationAuditLegacy = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    const organizationAuditVersioned = await fetch(`${baseUrl}/api/v1/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationAuditLegacy.status, 200,
      'an explicit organization auditor may read its organization-owned history without a selected scope');
    assert.equal(organizationAuditVersioned.status, 200);
    const organizationAuditRows = await organizationAuditLegacy.json();
    assert.deepEqual(await organizationAuditVersioned.json(), organizationAuditRows,
      'legacy and versioned organization-audit routes must preserve identical response data');
    assert(organizationAuditRows.some(row => row.entity_type === 'Organization' && row.action === 'Update Organization Profile'),
      'the organization view includes profile changes logged at organization scope');
    assert(organizationAuditRows.some(row => row.entity_type === 'Terminology' && row.action === 'Version Terminology'),
      'the organization view includes terminology changes logged at organization scope');
    assert(organizationAuditRows.some(row => row.entity_type === 'Legal Entity'
      && row.entity_id === createdLegalEntity.id && row.action === 'Create Legal Entity'),
    'the organization auditor can find legal-entity creation under its organization owner');
    assert(!organizationAuditRows.some(row => row.entity_type === 'Legal Entity'
      && row.entity_id === createdLegalEntity.id && row.action === 'Update Legal Entity'),
    'the organization reader excludes later legal-entity-specific edits');
    assert(organizationAuditRows.some(row => row.entity_type === 'OrganizationAuditGrant' && row.action === 'Grant Organization Audit Access'),
      'the organization view includes its explicit grant event');
    assert(!organizationAuditRows.some(row => ['deployment-scoped-beta','organization-audit-other-org'].includes(row.entity_id)),
      'the organization view must exclude legal-entity-scoped rows and every other organization');
    assert(!organizationAuditRows.some(row => row.organization_id === null || row.legal_entity_id !== null),
      'the organization view must exclude null-scope deployment and legal-entity records');
    const otherOrganizationAuditRead = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-default`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(otherOrganizationAuditRead.status, 404,
      'an organization auditor must not learn whether a different organization has audit records');
    const ordinaryBetaAudit = await getScoped('/api/audit-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    const ordinaryBetaAuditRows = await ordinaryBetaAudit.json();
    assert(!ordinaryBetaAuditRows.some(row => row.entity_type === 'Organization' || row.entity_type === 'Terminology'),
      'ordinary exact-pair history must not relabel or expose organization-wide audit records');
    assert(!ordinaryBetaAuditRows.some(row => row.entity_type === 'Legal Entity' && row.entity_id === createdLegalEntity.id),
      'the previously selected legal entity cannot read a new entity’s organization-owned creation event');
    const newLegalEntityAudit = await getScoped('/api/audit-logs', multiScopeToken, 'org-scope-beta', createdLegalEntity.id);
    const newLegalEntityAuditRows = await newLegalEntityAudit.json();
    assert(newLegalEntityAuditRows.some(row => row.entity_type === 'Legal Entity'
      && row.entity_id === createdLegalEntity.id && row.action === 'Update Legal Entity'),
    'the new legal entity’s exact-pair reader can see its subsequent update');
    assert(!newLegalEntityAuditRows.some(row => row.entity_type === 'Legal Entity'
      && row.entity_id === createdLegalEntity.id && row.action === 'Create Legal Entity'),
    'the legal-entity reader does not absorb the organization-owned creation event');
    await pool.query('delete from user_organization_scopes where user_id=$1', [auditDeniedActorId]);
    const scopeFreeOrganizationAudit = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(scopeFreeOrganizationAudit.status, 200,
      'an explicitly designated organization auditor can continue reading the organization-only view without legal-entity membership');
    await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
      values ($1,'org-default','legal-default',true),($1,'org-scope-beta','legal-scope-beta',true)`, [auditDeniedActorId]);
    await pool.query(`delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Employee')`, [auditDeniedActorId]);
    const staleOrganizationAuditor = await fetch(`${baseUrl}/api/organization-audit-scopes`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(staleOrganizationAuditor.status, 403,
      'removing the auditor active role must immediately deny organization audit access');
    await pool.query(`insert into user_roles (user_id,role_id) select $1,id from roles where name='Employee'`, [auditDeniedActorId]);
    await pool.query(`update users set status='Disabled' where id=$1`, [auditDeniedActorId]);
    const disabledOrganizationAuditor = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(disabledOrganizationAuditor.status, 403, 'disabled organization auditors must lose access immediately');
    await pool.query(`update users set status='Active' where id=$1`, [auditDeniedActorId]);
    const organizationRevokeResponse = await fetch(`${baseUrl}/api/permissions/organization-audit-grants/${encodeURIComponent(organizationGrant.id)}`, {
      method: 'DELETE',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(organizationRevokeResponse.status, 200, 'the selected-organization permission manager can revoke its auditor designation');
    const revokedOrganizationAuditor = await fetch(`${baseUrl}/api/organization-audit-logs?organizationId=org-scope-beta`, {
      headers: {Authorization: `Bearer ${organizationAuditorToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(revokedOrganizationAuditor.status, 403,
      'revoking the organization designation must remove access immediately');
    const organizationGrantAuditHistory = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='OrganizationAuditGrant' order by action`, [multiScopeActorId]);
    assert.deepEqual(organizationGrantAuditHistory.rows, [
      {action: 'Grant Organization Audit Access', organization_id: 'org-scope-beta', legal_entity_id: null},
      {action: 'Revoke Organization Audit Access', organization_id: 'org-scope-beta', legal_entity_id: null},
    ], 'grant and revoke history must remain append-only and organization-scoped');

    const globalSettingsResponse = await postScopedJson('/api/settings', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        expectedWeeklyHours: 40,
        utilizationThresholdHigh: 100,
        utilizationThresholdLow: 80,
        benchThreshold: 20,
      });
    assert.equal(globalSettingsResponse.status, 200,
      'deployment-wide settings must retain their existing API behavior for a multi-scope Admin');
    const globalRolePermissionResponse = await fetch(`${baseUrl}/api/permissions/roles/Admin`, {
      method: 'PATCH',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({permissionKey: 'employees.view', enabled: true}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(globalRolePermissionResponse.status, 200,
      'deployment-wide role permissions must retain their existing API behavior for a multi-scope Admin');
    const globalAuditScopes = await pool.query(`select entity_type,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type in ('SystemSettings','RolePermission')
      order by entity_type`, [multiScopeActorId]);
    assert.deepEqual(globalAuditScopes.rows, [
      {entity_type: 'RolePermission', organization_id: null, legal_entity_id: null},
      {entity_type: 'SystemSettings', organization_id: null, legal_entity_id: null},
    ], 'deployment-wide mutations must remain unscoped even when the Admin selected one legal entity');

    const globalCatalogCreate = await postScopedJson('/api/catalogs/industries', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {id: 'synthetic-global-audit-industry', name: 'Synthetic Global Audit Industry'});
    assert.equal(globalCatalogCreate.status, 200, 'deployment catalog creation must retain its current API behavior');
    const globalCatalogUpdate = await postScopedJson('/api/catalogs/industries', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {id: 'synthetic-global-audit-industry', name: 'Synthetic Global Audit Industry Updated'});
    assert.equal(globalCatalogUpdate.status, 200, 'deployment catalog updates must retain their current API behavior');
    const blockedDepartment = await pool.query(`select id from catalog_items
      where catalog_type='departments' and name='Engineering' limit 1`);
    assert.equal(blockedDepartment.rowCount, 1, 'the fixture must contain the department used by the synthetic employee');
    const blockedCatalogDelete = await fetch(`${baseUrl}/api/catalogs/departments/${encodeURIComponent(blockedDepartment.rows[0].id)}`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(blockedCatalogDelete.status, 409, 'a catalog item used by an employee must remain undeletable');
    const globalCatalogDelete = await fetch(`${baseUrl}/api/catalogs/industries/synthetic-global-audit-industry`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(globalCatalogDelete.status, 200, 'an unused deployment catalog item can retain its existing delete behavior');

    const globalCountryDirectorCreate = await postScopedJson('/api/country-directors', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {id: 'synthetic-global-audit-director', name: 'Synthetic Global Audit Director', region: 'Synthetic'});
    assert.equal(globalCountryDirectorCreate.status, 200, 'deployment country-director creation must retain its current API behavior');
    const globalCountryDirectorUpdate = await postScopedJson('/api/country-directors', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {id: 'synthetic-global-audit-director', name: 'Synthetic Global Audit Director Updated', region: 'Synthetic'});
    assert.equal(globalCountryDirectorUpdate.status, 200, 'deployment country-director updates must retain their current API behavior');
    const blockedCountryDirectorDelete = await fetch(`${baseUrl}/api/country-directors/cd-import-provenance-test`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(blockedCountryDirectorDelete.status, 409,
      'a country director referenced by an employee must remain undeletable');
    const globalCountryDirectorDelete = await fetch(`${baseUrl}/api/country-directors/synthetic-global-audit-director`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(globalCountryDirectorDelete.status, 200, 'an unmapped deployment country director can retain its existing delete behavior');
    const globalProducerAuditRows = await pool.query(`select entity_type,entity_id,action,organization_id,legal_entity_id
      from audit_logs where entity_id=any($1::text[]) and user_id=$2 order by entity_id,action`, [[
      'synthetic-global-audit-industry', blockedDepartment.rows[0].id, 'synthetic-global-audit-director', 'cd-import-provenance-test',
    ], multiScopeActorId]);
    assert.equal(globalProducerAuditRows.rowCount, 8,
      'create, update, blocked delete and successful delete outcomes must each leave an audit row for both deployment-wide producer families');
    assert(globalProducerAuditRows.rows.every(row => row.organization_id === null && row.legal_entity_id === null),
      'global catalog and country-director mutations, including blocked outcomes, must remain null-scope under tenant selection');
    assert(globalProducerAuditRows.rows.some(row => row.entity_id === blockedDepartment.rows[0].id && row.action === 'Deactivate Blocked'),
      'the blocked catalog mutation must preserve its audited failure outcome');
    assert(globalProducerAuditRows.rows.some(row => row.entity_id === 'cd-import-provenance-test' && row.action === 'Delete Blocked'),
      'the blocked country-director mutation must preserve its audited failure outcome');
    const scopedGlobalProducerAudit = await getScoped('/api/audit-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    const scopedGlobalProducerAuditRows = await scopedGlobalProducerAudit.json();
    assert(!scopedGlobalProducerAuditRows.some(row => ['synthetic-global-audit-industry', blockedDepartment.rows[0].id,
      'synthetic-global-audit-director', 'cd-import-provenance-test'].includes(row.entity_id)),
    'ordinary selected-entity audit history must exclude deployment-wide catalog and country-director changes');

    const notificationTemplateCreate = await postScopedJson('/api/notification-templates', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        event_type: 'SyntheticDeploymentAuditTemplate',
        channel: 'InApp',
        subject: 'Synthetic audit subject',
        body: 'Synthetic audit template body',
        active: true,
      });
    assert.equal(notificationTemplateCreate.status, 200,
      'deployment-wide notification-template creation must retain its existing API behavior');
    const notificationTemplate = await notificationTemplateCreate.json();
    const notificationTemplateUpdate = await postScopedJson('/api/notification-templates', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: notificationTemplate.id,
        event_type: 'SyntheticDeploymentAuditTemplate',
        channel: 'InApp',
        subject: 'Synthetic updated audit subject',
        body: 'Synthetic updated audit template body',
        active: true,
      });
    assert.equal(notificationTemplateUpdate.status, 200,
      'deployment-wide notification-template updates must retain their existing API behavior');
    const notificationTemplateAuditRows = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='NotificationTemplate' and entity_id=$2 order by action`,
    [multiScopeActorId, notificationTemplate.id]);
    assert.deepEqual(notificationTemplateAuditRows.rows, [
      {action: 'Create Notification Template', organization_id: null, legal_entity_id: null},
      {action: 'Update Notification Template', organization_id: null, legal_entity_id: null},
    ], 'notification-template create and update audit events must remain deployment-owned despite a selected legal entity');

    const globalLeaveTypeId = 'synthetic-global-audit-leave-type';
    const globalLeaveTypeCreate = await postScopedJson('/api/leave/types', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalLeaveTypeId,
        code: 'SYN_AUDIT_GLOBAL',
        name: 'Synthetic Global Audit Leave',
        paid: true,
        requires_approval: true,
        active: true,
      });
    assert.equal(globalLeaveTypeCreate.status, 200,
      'deployment-wide leave-type creation must retain its existing API behavior');
    const globalLeaveTypeUpdate = await postScopedJson('/api/leave/types', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalLeaveTypeId,
        code: 'SYN_AUDIT_GLOBAL',
        name: 'Synthetic Global Audit Leave Updated',
        paid: true,
        requires_approval: false,
        active: true,
      });
    assert.equal(globalLeaveTypeUpdate.status, 200,
      'deployment-wide leave-type updates must retain their existing API behavior');

    const globalLeavePolicyId = 'synthetic-global-audit-leave-policy';
    const globalLeavePolicyCreate = await postScopedJson('/api/leave/policies', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalLeavePolicyId,
        name: 'Synthetic Global Audit Leave Policy',
        annual_allowance_days: 12,
        carry_forward_days: 2,
        accrual_method: 'Annual',
        status: 'Active',
        leave_type_ids: [globalLeaveTypeId],
      });
    assert.equal(globalLeavePolicyCreate.status, 200,
      'deployment-wide leave-policy creation must retain its existing API behavior');
    const globalLeavePolicyUpdate = await postScopedJson('/api/leave/policies', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalLeavePolicyId,
        name: 'Synthetic Global Audit Leave Policy Updated',
        annual_allowance_days: 15,
        carry_forward_days: 3,
        accrual_method: 'Monthly',
        status: 'Active',
        leave_type_ids: [globalLeaveTypeId],
      });
    assert.equal(globalLeavePolicyUpdate.status, 200,
      'deployment-wide leave-policy updates and type-link replacement must retain their existing API behavior');

    const globalHolidayCalendarId = 'synthetic-global-audit-holiday-calendar';
    const globalHolidayCalendarCreate = await postScopedJson('/api/holiday-calendars', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalHolidayCalendarId,
        name: 'Synthetic Global Audit Calendar',
        country: 'GB',
        year: 2098,
        status: 'Active',
        holidays: [{id: 'synthetic-global-audit-holiday', name: 'Synthetic Audit Holiday', date: '2098-05-01', type: 'Public'}],
      });
    assert.equal(globalHolidayCalendarCreate.status, 200,
      'deployment-wide holiday-calendar creation must retain its existing API behavior');
    const globalHolidayCalendarUpdate = await postScopedJson('/api/holiday-calendars', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: globalHolidayCalendarId,
        name: 'Synthetic Global Audit Calendar Updated',
        country: 'GB',
        year: 2098,
        status: 'Active',
        holidays: [{id: 'synthetic-global-audit-holiday', name: 'Synthetic Audit Holiday Updated', date: '2098-05-02', type: 'Company'}],
      });
    assert.equal(globalHolidayCalendarUpdate.status, 200,
      'deployment-wide holiday-calendar updates must retain their existing API behavior');

    const leaveConfigEntityIds = [globalLeaveTypeId, globalLeavePolicyId, globalHolidayCalendarId];
    const leaveConfigAuditRows = await pool.query(`select entity_type,entity_id,action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_id=any($2::text[]) order by entity_type,action`,
    [multiScopeActorId, leaveConfigEntityIds]);
    assert.deepEqual(leaveConfigAuditRows.rows, [
      {entity_type: 'HolidayCalendar', entity_id: globalHolidayCalendarId, action: 'Create Holiday Calendar', organization_id: null, legal_entity_id: null},
      {entity_type: 'HolidayCalendar', entity_id: globalHolidayCalendarId, action: 'Update Holiday Calendar', organization_id: null, legal_entity_id: null},
      {entity_type: 'LeavePolicy', entity_id: globalLeavePolicyId, action: 'Create Leave Policy', organization_id: null, legal_entity_id: null},
      {entity_type: 'LeavePolicy', entity_id: globalLeavePolicyId, action: 'Update Leave Policy', organization_id: null, legal_entity_id: null},
      {entity_type: 'LeaveType', entity_id: globalLeaveTypeId, action: 'Create Leave Type', organization_id: null, legal_entity_id: null},
      {entity_type: 'LeaveType', entity_id: globalLeaveTypeId, action: 'Update Leave Type', organization_id: null, legal_entity_id: null},
    ], 'leave definitions, policies and calendars must be audited as deployment-owned despite a selected legal entity');
    assert(!JSON.stringify(leaveConfigAuditRows.rows).includes('org-scope-beta')
      && !JSON.stringify(leaveConfigAuditRows.rows).includes('legal-scope-beta'),
    'global leave-configuration audit metadata must not retain the caller selected scope');

    const blockedRoleDefinitionId = 'synthetic-global-audit-role-definition-blocked';
    const blockedRoleDefinitionCreate = await postScopedJson('/api/role-definitions', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: blockedRoleDefinitionId,
        name: 'Consultant',
        department: 'Engineering',
        description: 'Synthetic blocked global audit fixture',
        active: true,
      });
    assert.equal(blockedRoleDefinitionCreate.status, 200,
      'deployment-wide role-definition creation must retain its existing API behavior');
    const blockedRoleDefinitionDelete = await fetch(`${baseUrl}/api/role-definitions/${encodeURIComponent(blockedRoleDefinitionId)}`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(blockedRoleDefinitionDelete.status, 409,
      'a role definition used by an employee must remain undeactivatable');
    const blockedRoleDefinitionAudit = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='RoleDefinition' and entity_id=$2`,
    [multiScopeActorId, blockedRoleDefinitionId]);
    assert.deepEqual(blockedRoleDefinitionAudit.rows, [
      {action: 'Delete Blocked', organization_id: null, legal_entity_id: null},
    ], 'a blocked deployment-wide role deactivation must be recorded at deployment scope');
    await pool.query(`delete from role_definitions where id=$1`, [blockedRoleDefinitionId]);

    const successfulRoleDefinitionId = 'synthetic-global-audit-role-definition-success';
    const successfulRoleDefinitionCreate = await postScopedJson('/api/role-definitions', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta', {
        id: successfulRoleDefinitionId,
        name: 'Synthetic Unused Global Audit Role',
        department: 'Engineering',
        description: 'Synthetic successful global audit fixture',
        active: true,
      });
    assert.equal(successfulRoleDefinitionCreate.status, 200,
      'deployment-wide role-definition creation must retain its existing API behavior');
    const roleDefinitionDelete = await fetch(`${baseUrl}/api/role-definitions/${encodeURIComponent(successfulRoleDefinitionId)}`, {
      method: 'DELETE', headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleDefinitionDelete.status, 200,
      'an unused deployment-wide role definition must retain its existing deactivation behavior');
    const roleDefinitionAuditRows = await pool.query(`select action,organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='RoleDefinition' and entity_id=$2 order by created_at`,
    [multiScopeActorId, successfulRoleDefinitionId]);
    assert.deepEqual(roleDefinitionAuditRows.rows, [
      {action: 'Deactivate Role Definition', organization_id: null, legal_entity_id: null},
    ], 'successful deployment-wide role deactivation must be recorded at deployment scope');

    const classifiedGlobalAuditIds = [notificationTemplate.id, blockedRoleDefinitionId, successfulRoleDefinitionId, ...leaveConfigEntityIds];
    const scopedGlobalConfigurationAudit = await getScoped('/api/audit-logs', multiScopeToken,
      'org-scope-beta', 'legal-scope-beta');
    const scopedGlobalConfigurationAuditRows = await scopedGlobalConfigurationAudit.json();
    assert(!scopedGlobalConfigurationAuditRows.some(row => classifiedGlobalAuditIds.includes(row.entity_id)),
      'ordinary selected-entity audit history must exclude deployment-wide notification, role-definition and leave-configuration changes');

    const ungrantedGlobalRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ungrantedGlobalRead.status, 403,
      'an Admin without the explicit deployment-audit user grant must be denied even when role defaults are broad');
    await pool.query(`update role_permissions set enabled=true
      where role_name='Admin' and permission_key='audit.deployment.view'`);
    const roleOnlyGlobalRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleOnlyGlobalRead.status, 403,
      'an accidental role-wide permission row must not substitute for the explicit per-user auditor designation');
    const roleOnlyIntegrationRead = await fetch(`${baseUrl}/api/deployment-integration-events`, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleOnlyIntegrationRead.status, 403,
      'a role-wide default must not substitute for an explicit deployment-audit grant on integration history');
    await pool.query(`update role_permissions set enabled=false
      where role_name='Admin' and permission_key='audit.deployment.view'`);
    const employeeGlobalRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${employeeTokenWithoutAdminPermissions}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(employeeGlobalRead.status, 403, 'an active non-Admin without an explicit user grant must not read deployment-wide history');

    const selfGrantResponse = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: multiScopeActorId, permissionKey: 'audit.deployment.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(selfGrantResponse.status, 422, 'a permission manager cannot designate their own account');
    await pool.query(`update users set status='Disabled' where id=$1`, [auditDeniedActorId]);
    const inactiveTargetGrant = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId, permissionKey: 'audit.deployment.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(inactiveTargetGrant.status, 422, 'inactive accounts cannot be designated as deployment auditors');
    await pool.query(`update users set status='Active' where id=$1`, [auditDeniedActorId]);
    const rolelessTargetGrant = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: unassignedAuditActorId, permissionKey: 'audit.deployment.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(rolelessTargetGrant.status, 422,
      'an active account without an assigned role cannot be designated as an auditor');

    await pool.query(`delete from user_roles
      where user_id=$1 and role_id=(select id from roles where name='Admin')`, [multiScopeActorId]);
    const staleManagerGrant = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId, permissionKey: 'audit.deployment.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(staleManagerGrant.status, 403,
      'a stale Admin session cannot designate an auditor after its active role has been removed');
    await pool.query(`insert into user_roles (user_id,role_id)
      select $1,id from roles where name='Admin'`, [multiScopeActorId]);

    const roleWideAuditGrant = await fetch(`${baseUrl}/api/permissions/roles/Admin`, {
      method: 'PATCH',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({permissionKey: 'audit.deployment.view', enabled: true}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(roleWideAuditGrant.status, 422,
      'deployment audit access must not be enabled for all Admin accounts through role settings');
    const roleWideAuditState = await pool.query(`select role_name,enabled from role_permissions
      where permission_key='audit.deployment.view' order by role_name`);
    assert(roleWideAuditState.rows.every(row => row.enabled === false),
      'a rejected role-wide grant must leave every role denied');

    await pool.query(`insert into audit_logs
        (user_id,user_name,user_role,active_role,source,module,action,details,entity_type,entity_id,source_identifier,
         old_value,new_value,organization_id,legal_entity_id)
      values
        ($1,'Synthetic multi-scope Admin','Admin','Admin','Synthetic deployment test','Deployment Audit Test',
         'Sensitive Global Row','Synthetic deployment audit fixture','DeploymentAuditTest','deployment-global-sensitive','global-user@example.test',
         '{"provider_subject":"global-subject","nested":{"id":"global-user@example.test"}}'::jsonb,
         '{"provider_upn":"global-user@example.test","status":"Observed"}'::jsonb,null,null),
        ($1,'Synthetic multi-scope Admin','Admin','Admin','Synthetic deployment test','Deployment Audit Test',
         'Scoped Beta Row','Synthetic deployment audit fixture','DeploymentAuditTest','deployment-scoped-beta',null,null,null,'org-scope-beta','legal-scope-beta'),
        ($1,'Synthetic multi-scope Admin','Admin','Admin','Synthetic deployment test','Deployment Audit Test',
         'Scoped Row','Synthetic deployment audit fixture','DeploymentAuditTest','deployment-scoped',null,null,null,'org-default','legal-default')`, [multiScopeActorId]);

    const deploymentGrantResponse = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId, permissionKey: 'audit.deployment.view'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deploymentGrantResponse.status, 200,
      'the existing permission-management path may designate an active non-Admin user explicitly');
    const deploymentGrant = await deploymentGrantResponse.json();
    assert.equal(deploymentGrant.permission_key, 'audit.deployment.view');
    const deploymentGrantAudit = await pool.query(`select organization_id,legal_entity_id from audit_logs
      where user_id=$1 and entity_type='UserPermissionGrant' and entity_id=$2`, [multiScopeActorId, deploymentGrant.id]);
    assert.deepEqual(deploymentGrantAudit.rows, [{organization_id: null, legal_entity_id: null}],
      'granting deployment-level audit access must itself appear as a null-scope audit event');

    const ordinaryUserGrantResponse = await fetch(`${baseUrl}/api/permissions/user-grants`, {
      method: 'POST',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {'Content-Type': 'application/json'}),
      body: JSON.stringify({userId: auditDeniedActorId, permissionKey: 'projects.manage'}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ordinaryUserGrantResponse.status, 200,
      'user-specific grants must preserve their existing permission-management behavior');
    const ordinaryUserGrant = await ordinaryUserGrantResponse.json();
    const ordinaryUserGrantAudit = await pool.query(`select organization_id,legal_entity_id from audit_logs
      where user_id=$1 and entity_type='UserPermissionGrant' and entity_id=$2`, [multiScopeActorId, ordinaryUserGrant.id]);
    assert.deepEqual(ordinaryUserGrantAudit.rows, [{organization_id: null, legal_entity_id: null}],
      'deployment-wide user permission grants must not inherit the permission manager selected legal entity');

    const deploymentAuditResponse = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${employeeTokenWithoutAdminPermissions}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deploymentAuditResponse.status, 200,
      'a specifically granted non-Admin can read deployment history without selecting an organization scope');
    const deploymentAuditRows = await deploymentAuditResponse.json();
    assert(deploymentAuditRows.some(row => row.entity_id === 'deployment-global-sensitive'),
      'deployment history must include exact null-scope audit records');
    assert(!deploymentAuditRows.some(row => ['deployment-scoped-beta', 'deployment-scoped'].includes(row.entity_id)),
      'deployment history must exclude tenant-scoped records');
    const redactedGlobalRow = deploymentAuditRows.find(row => row.entity_id === 'deployment-global-sensitive');
    assert.equal(redactedGlobalRow.source_identifier, null,
      'deployment history must redact external identifiers using the shared audit DTO');
    assert.deepEqual(redactedGlobalRow.old_value, {nested: {}},
      'deployment history must recursively redact provider and personal identifiers');
    assert.deepEqual(redactedGlobalRow.new_value, {status: 'Observed'});
    assert(deploymentAuditRows.some(row => row.entity_id === ordinaryUserGrant.id),
      'the explicitly designated deployment reader must see deployment-wide user permission grants');
    assert(globalProducerAuditRows.rows.every(expected => deploymentAuditRows.some(row => row.entity_id === expected.entity_id
      && row.action === expected.action)),
    'the designated deployment reader must be able to retrieve every global catalog and country-director outcome');
    assert(classifiedGlobalAuditIds.every(entityId => deploymentAuditRows.some(row => row.entity_id === entityId)),
      'the designated deployment reader must be able to retrieve classified notification, role-definition and leave-configuration outcomes');
    assert(leaveConfigAuditRows.rows.every(expected => deploymentAuditRows.some(row => row.entity_id === expected.entity_id
      && row.action === expected.action)),
    'the designated deployment reader must expose all leave-type, leave-policy and holiday-calendar create/update outcomes');

    const scopeFreeWrongPassword = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${scopeFreeAuditorToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({currentPassword: randomBytes(32).toString('base64url'), newPassword: updatedScopeFreeAuditorPassword}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(scopeFreeWrongPassword.status, 401,
      'scope-free auditors must reach current-password verification without bypassing it');
    const unchangedScopeFreePassword = await pool.query(`select must_change_password from users where id=$1`, [scopeFreeAuditorId]);
    assert.equal(unchangedScopeFreePassword.rows[0].must_change_password, true,
      'an incorrect current password must not clear mandatory password change');

    const scopeFreePasswordChange = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${scopeFreeAuditorToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({currentPassword: scopeFreeAuditorPassword, newPassword: updatedScopeFreeAuditorPassword}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(scopeFreePasswordChange.status, 200,
      'a designated auditor without organization scope must complete a mandatory account password change');
    assert.deepEqual(await scopeFreePasswordChange.json(), {status: 'ok', mustChangePassword: false});
    const changedScopeFreePassword = await pool.query(`select password_hash,must_change_password from users where id=$1`, [scopeFreeAuditorId]);
    const [updatedPasswordScheme,updatedPasswordSalt,updatedPasswordHash] = changedScopeFreePassword.rows[0].password_hash.split('$');
    assert.equal(updatedPasswordScheme, 'scrypt', 'scope-free password change must retain the existing password hash scheme');
    assert.equal(changedScopeFreePassword.rows[0].must_change_password, false,
      'a successful password change must clear the mandatory-change flag');
    assert.equal(scryptSync(updatedScopeFreeAuditorPassword, updatedPasswordSalt, 64).toString('hex'), updatedPasswordHash,
      'scope-free password change must store a hash of the submitted new password');
    const passwordChangeAudit = await pool.query(`select organization_id,legal_entity_id from audit_logs
      where user_id=$1 and action='Change Password' and entity_id=$1`, [scopeFreeAuditorId]);
    assert.deepEqual(passwordChangeAudit.rows, [{organization_id: null, legal_entity_id: null}],
      'account-wide password changes must be recorded without assigning them to one legal entity');
    const scopeFreeAuditorGlobalRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${scopeFreeAuditorToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(scopeFreeAuditorGlobalRead.status, 200,
      'a designated scope-free auditor must retain access to the deployment audit reader after changing password');
    const scopeFreeAuditorRows = await scopeFreeAuditorGlobalRead.json();
    assert(scopeFreeAuditorRows.some(row => row.entity_type === 'User' && row.entity_id === scopeFreeAuditorId
      && row.action === 'Change Password'), 'the designated deployment reader must find the scope-free password audit event');

    const ordinaryUserRevoke = await fetch(`${baseUrl}/api/permissions/user-grants/${ordinaryUserGrant.id}`, {
      method: 'DELETE',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ordinaryUserRevoke.status, 200,
      'user-specific permission revocation must preserve its existing management behavior');
    const ordinaryUserGrantAndRevokeAudit = await pool.query(`select organization_id,legal_entity_id from audit_logs
      where user_id=$1 and entity_type='UserPermissionGrant' and entity_id=$2 order by created_at`,
    [multiScopeActorId, ordinaryUserGrant.id]);
    assert.deepEqual(ordinaryUserGrantAndRevokeAudit.rows, [
      {organization_id: null, legal_entity_id: null},
      {organization_id: null, legal_entity_id: null},
    ], 'both deployment-wide user grant and revoke events must be null-scope');

    await pool.query(`update users set status='Disabled' where id=$1`, [scopeFreeAuditorId]);
    const disabledCredentials = (await pool.query('select password_hash,must_change_password from users where id=$1', [scopeFreeAuditorId])).rows;
    const disabledScopeFreePasswordChange = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${scopeFreeAuditorToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({currentPassword: updatedScopeFreeAuditorPassword, newPassword: randomBytes(32).toString('base64url')}),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(disabledScopeFreePasswordChange.status, 403,
      'current-role middleware must reject disabled accounts before password changes');
    assert.equal((await disabledScopeFreePasswordChange.json()).code, 'SESSION_ROLE_REVOKED');
    assert.deepEqual((await pool.query('select password_hash,must_change_password from users where id=$1', [scopeFreeAuditorId])).rows,
      disabledCredentials, 'a disabled session must not change credentials');
    await pool.query(`update users set status='Active' where id=$1`, [scopeFreeAuditorId]);

    const staleActiveRoleToken = tokenFor(auditDeniedActorId, 'synthetic-no-audit', 'Admin');
    const staleActiveRoleRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${staleActiveRoleToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(staleActiveRoleRead.status, 403,
      'a permission grant cannot preserve access when the token role has been removed from the active account');

    await pool.query(`delete from user_roles
      where user_id=$1 and role_id=(select id from roles where name='Admin')`, [multiScopeActorId]);
    const staleManagerRevoke = await fetch(`${baseUrl}/api/permissions/user-grants/${deploymentGrant.id}`, {
      method: 'DELETE',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(staleManagerRevoke.status, 403,
      'a stale Admin session cannot revoke grants after its active role has been removed');
    const retainedAfterStaleRevoke = await pool.query(`select count(*)::int as count
      from user_permission_grants where id=$1`, [deploymentGrant.id]);
    assert.equal(retainedAfterStaleRevoke.rows[0].count, 1,
      'a rejected stale-role revocation must leave the explicit user grant intact');
    await pool.query(`insert into user_roles (user_id,role_id)
      select $1,id from roles where name='Admin'`, [multiScopeActorId]);

    await pool.query(`update users set status='Disabled' where id=$1`, [auditDeniedActorId]);
    const disabledAuditorRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${employeeTokenWithoutAdminPermissions}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(disabledAuditorRead.status, 403,
      'a previously designated but currently disabled account must lose deployment audit access immediately');
    await pool.query(`update users set status='Active' where id=$1`, [auditDeniedActorId]);

    const deploymentRevokeResponse = await fetch(`${baseUrl}/api/permissions/user-grants/${deploymentGrant.id}`, {
      method: 'DELETE',
      headers: scopedHeaders(multiScopeToken, 'org-scope-beta', 'legal-scope-beta'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deploymentRevokeResponse.status, 200, 'the authorized permission manager can revoke an individual deployment-audit grant');
    const deploymentRevokeAudit = await pool.query(`select organization_id,legal_entity_id
      from audit_logs where user_id=$1 and entity_type='UserPermissionGrant' and entity_id=$2`,
    [multiScopeActorId, deploymentGrant.id]);
    assert.equal(deploymentRevokeAudit.rowCount, 2,
      'the deployment auditor grant and revocation must both be recorded');
    assert(deploymentRevokeAudit.rows.every(row => row.organization_id === null && row.legal_entity_id === null),
      'the deployment auditor grant and revocation must both be recorded outside any selected tenant scope');
    const revokedAuditorRead = await fetch(`${baseUrl}/api/deployment-audit-logs`, {
      headers: {Authorization: `Bearer ${employeeTokenWithoutAdminPermissions}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(revokedAuditorRead.status, 403, 'revocation must remove deployment audit access immediately');
    const revokedIntegrationAuditorRead = await fetch(`${baseUrl}/api/v1/deployment-integration-events`, {
      headers: {Authorization: `Bearer ${employeeTokenWithoutAdminPermissions}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(revokedIntegrationAuditorRead.status, 403,
      'revoking the shared deployment-audit designation must immediately remove integration-history access too');

    for (const [organizationId, legalEntityId] of [
      ['org-default', 'legal-default'],
      ['org-scope-beta', 'legal-scope-beta'],
    ]) {
      const response = await getScoped('/api/audit-logs', multiScopeToken, organizationId, legalEntityId);
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert(!rows.some(row => ['synthetic-global-audit-industry', blockedDepartment.rows[0].id,
        'synthetic-global-audit-director', 'cd-import-provenance-test', ...classifiedGlobalAuditIds].includes(row.entity_id)),
      'selected-organization readers must exclude deployment-global catalog, country-director, notification, role-definition and leave-configuration outcomes');
      assert(!rows.some(row => row.user_id === multiScopeActorId
        && ['SystemSettings', 'RolePermission', 'UserPermissionGrant'].includes(row.entity_type)),
      'ordinary scoped history must not attribute deployment-wide configuration or auditor grants to the caller’s selected entity');
    }

    const auditAResponse = await postScopedJson('/api/audit-events', token, 'org-default', 'legal-default', {
      action: 'Import',
      module: 'Scoped History Test',
      details: 'Synthetic scope A audit marker',
      entityType: 'ScopedHistoryTest',
      entityId: 'scope-a-audit',
      newValue: {status: 'Linked', nested: {provider_subject: 'audit-subject-a', upn: 'audit-a@example.test'}},
    });
    assert.equal(auditAResponse.status, 201, 'scoped audit writes must retain the authenticated selected scope');
    const auditBResponse = await postScopedJson('/api/audit-events', multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {
      action: 'Import',
      module: 'Scoped History Test',
      details: 'Synthetic scope B audit marker',
      entityType: 'ScopedHistoryTest',
      entityId: 'scope-b-audit',
      newValue: {status: 'Linked', provider_subject: 'audit-subject-b'},
    });
    assert.equal(auditBResponse.status, 201, 'a multi-scope Admin may select an explicitly authorized second scope');
    const auditScopes = await pool.query(`select entity_id,organization_id,legal_entity_id from audit_logs
      where entity_id in ('scope-a-audit','scope-b-audit') order by entity_id`);
    assert.deepEqual(auditScopes.rows, [
      {entity_id: 'scope-a-audit', organization_id: 'org-default', legal_entity_id: 'legal-default'},
      {entity_id: 'scope-b-audit', organization_id: 'org-scope-beta', legal_entity_id: 'legal-scope-beta'},
    ], 'the audit writer must persist the verified request scope rather than a client body value');

    const importAResponse = await postScopedJson('/api/import-export-logs', token, 'org-default', 'legal-default', {
      operation: 'Import', channel: 'Scoped Test', fileName: 'scope-a-history.csv', status: 'Partial',
      totalRows: 1, validRows: 0, errorRows: 1,
      errors: [{rowNumber: 2, field: 'client', message: 'Invalid client.', sourceIdentifier: 'CLIENT-SCOPED-ERROR'}],
      organizationId: 'org-scope-beta', legalEntityId: 'legal-scope-beta',
    });
    assert.equal(importAResponse.status, 200);
    const importARows = await importAResponse.json();
    assert.equal(importARows[0].organization_id, 'org-default');
    assert.equal(importARows[0].legal_entity_id, 'legal-default', 'the import log route must ignore client scope fields');
    assert.deepEqual(importARows[0].errors, [{
      rowNumber: 2,
      field: 'client',
      message: 'Invalid client.',
      sourceIdentifier: 'CLIENT-SCOPED-ERROR',
    }], 'the legacy import-history writer must preserve the optional validated source identifier');
    const importBResponse = await postScopedJson('/api/import-export-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {
      operation: 'Import', channel: 'Scoped Test', fileName: 'scope-b-history.csv', status: 'Success',
      totalRows: 1, validRows: 1, errorRows: 0,
    });
    assert.equal(importBResponse.status, 200);

    const versionedImportPayload = {
      operation: 'Export', channel: 'Generic compatibility check', fileName: 'v1-history-compatibility.csv',
      status: 'Dry Run', totalRows: 2, validRows: 1, errorRows: 1,
      errors: [{rowNumber: 2, message: 'Synthetic diagnostic', sourceIdentifier: 'ROW-COMPAT-2'}],
      user_name: 'forged-actor', organizationId: 'org-scope-beta', legalEntityId: 'legal-scope-beta',
    };
    const importWriteResults = [];
    for (const prefix of ['/api', '/api/v1']) {
      const response = await postScopedJson(`${prefix}/import-export-logs`, token,
        'org-default', 'legal-default', versionedImportPayload);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.length, 1);
      assert.equal(result[0].organization_id, 'org-default');
      assert.equal(result[0].legal_entity_id, 'legal-default');
      assert.notEqual(result[0].user_name, 'forged-actor');
      assert.deepEqual(result[0].errors, versionedImportPayload.errors);
      importWriteResults.push(result[0]);
      const before = (await pool.query('select count(*)::int as count from import_export_logs')).rows[0].count;
      const invalid = await postScopedJson(`${prefix}/import-export-logs`, token,
        'org-default', 'legal-default', {...versionedImportPayload, errors: [{rowNumber: 1, message: 'Bad', sourceIdentifier: '  '}]});
      assert.equal(invalid.status, 400);
      if (prefix === '/api/v1') {
        const error = (await invalid.json()).error;
        assert.equal(error.code, 'BAD_REQUEST');
        assert.equal(error.correlationId, invalid.headers.get('x-correlation-id'));
        assert.equal(typeof error.operationId, 'string');
      }
      const denied = await postScopedJson(`${prefix}/import-export-logs`, employeeTokenWithoutAdminPermissions,
        'org-default', 'legal-default', versionedImportPayload);
      assert.equal(denied.status, 403);
      const outOfScope = await postScopedJson(`${prefix}/import-export-logs`,
        tokenFor(singleScopeActorId, 'synthetic-single-scope-admin'),
        'org-scope-beta', 'legal-scope-beta', versionedImportPayload);
      assert.equal(outOfScope.status, 403);
      assert.equal((await pool.query('select count(*)::int as count from import_export_logs')).rows[0].count, before,
        'invalid, unauthorized, and out-of-scope writes must leave history unchanged');
    }
    const stableImportFields = ({id, created_at, ...fields}) => fields;
    assert.deepEqual(stableImportFields(importWriteResults[0]), stableImportFields(importWriteResults[1]),
      'both routes must persist and return equivalent data except generated ID/timestamp');
    const persistedWrites = await pool.query('select * from import_export_logs where id=any($1::uuid[])',
      [importWriteResults.map(row => row.id)]);
    assert.equal(persistedWrites.rows.length, 2);
    assert(persistedWrites.rows.every(row => row.organization_id === 'org-default' && row.legal_entity_id === 'legal-default'));

    const employeeA = (await pool.query(`select id from employees where employee_id='EMP-IMPORT-SUCCESS'`)).rows[0];
    assert.ok(employeeA, 'the default-scope identity link fixture exists');
    const identityAResponse = await postScopedJson('/api/integrations/identity-links', token, 'org-default', 'legal-default', {
      id: 'scope-a-provider-subject',
      provenance_reference: 'caller-selected-provider-subject',
      employee_id: employeeA.id,
      provider: 'entra',
      provider_subject: 'scope-a-provider-subject',
      status: 'Linked',
    });
    assert.equal(identityAResponse.status, 200, 'identity-link writes must remain available inside the selected scope');
    const identityA = await identityAResponse.json();
    assert.match(identityA.provenance_reference,
      /^identity-link-ref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'identity-link history references must have a server-owned opaque UUID form');
    assert.notEqual(identityA.provenance_reference, 'scope-a-provider-subject',
      'history provenance references must not reuse client or provider identity values');
    assert.notEqual(identityA.provenance_reference, 'caller-selected-provider-subject',
      'the identity API must ignore caller attempts to choose its history reference');
    await assert.rejects(
      () => pool.query(`update identity_provider_links set provenance_reference=$2 where id=$1`,
        [identityA.id, `identity-link-ref-${randomUUID()}`]),
      error => error.code === '23514',
      'the database must reject mutation of a link provenance reference',
    );
    const identityAUpdateResponse = await postScopedJson('/api/integrations/identity-links', token, 'org-default', 'legal-default', {
      employee_id: employeeA.id,
      provider: 'entra',
      provider_subject: 'scope-a-provider-subject-updated',
      provider_upn: 'scope-a-provider-updated@example.test',
      status: 'Linked',
    });
    assert.equal(identityAUpdateResponse.status, 200, 'same-scope identity-link updates must retain their existing upsert behavior');
    const identityAUpdate = await identityAUpdateResponse.json();
    assert.equal(identityAUpdate.id, identityA.id,
      'a same-scope upsert without an optional source ID must preserve the existing business row ID');
    assert.equal(identityAUpdate.provenance_reference, identityA.provenance_reference,
      'identity provenance references must remain stable across updates');
    const identityBResponse = await postScopedJson('/api/integrations/identity-links', multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {
      id: 'scope-b-provider@example.test',
      employee_id: 'employee-scope-beta',
      provider: 'entra',
      provider_subject: 'scope-b-provider-subject',
      provider_upn: 'scope-b-provider@example.test',
      status: 'Linked',
    });
    assert.equal(identityBResponse.status, 200);
    const identityB = await identityBResponse.json();
    assert.notEqual(identityB.provenance_reference, 'scope-b-provider@example.test',
      'history provenance references must not reuse provider UPN values');
    assert.notEqual(identityB.provenance_reference, identityA.provenance_reference,
      'server-owned identity-link provenance references must be unique across links');
    await assert.rejects(
      () => pool.query(`insert into identity_provider_links
          (id,employee_id,provider,provider_subject,status,provenance_reference)
        values ('duplicate-provenance-row',$1,'local','duplicate-provenance-subject','Linked',$2)`,
      [employeeA.id, identityA.provenance_reference]),
      error => error.code === '23505',
      'the database must reject a duplicate identity-link provenance reference',
    );

    const identityAuditProvenance = await pool.query(`select action,source,entity_id,source_identifier,import_batch_id,
        import_processing_result,correlation_id,operation_id,old_value,new_value
      from audit_logs where entity_id=$1 and action in ('Create Identity Link','Update Identity Link') order by created_at`, [identityA.provenance_reference]);
    assert.equal(identityAuditProvenance.rowCount, 2, 'identity-link create and update must each retain an audit provenance record');
    assert(identityAuditProvenance.rows.every(row => row.source === 'Entra'
      && row.source_identifier === identityA.provenance_reference
      && row.entity_id === identityA.provenance_reference
      && row.import_batch_id === null
      && row.import_processing_result === 'Success'
      && row.correlation_id && row.operation_id),
    'identity provenance must identify the provider, safe internal link ID, successful result and request trace without inventing a batch');
    const identityUpdateAudit = identityAuditProvenance.rows.find(row => row.action === 'Update Identity Link');
    assert.equal(identityUpdateAudit.new_value.mutation, 'Updated');
    assert.equal(identityUpdateAudit.new_value.providerIdentifierChanged, true,
      'identity audit history must record a provider identifier change without storing its value');
    assert.equal(identityUpdateAudit.new_value.providerAccountChanged, true,
      'identity audit history must record an account-address change without storing its value');
    const identityCreateAudit = identityAuditProvenance.rows.find(row => row.action === 'Create Identity Link');
    assert.equal(identityCreateAudit.source_identifier, identityA.provenance_reference);
    assert.equal(identityCreateAudit.new_value.mutation, 'Created');
    assert.equal(identityCreateAudit.new_value.providerAccountChanged, false,
      'identity audit history must not claim an account-address change when the optional UPN is absent');
    assert(!JSON.stringify(identityAuditProvenance.rows).includes('scope-a-provider-subject')
      && !JSON.stringify(identityAuditProvenance.rows).includes('scope-a-provider@example.test')
      && !JSON.stringify(identityAuditProvenance.rows).includes('scope-a-provider-updated@example.test'),
    'audit provenance must not copy external identity identifiers or UPNs into history');
    const identityUpsertEvents = await pool.query(`select provider,event_type,entity_id,status,request_payload,response_payload
      from integration_event_logs where event_type='IdentityLinkUpserted' and entity_id=$1 order by created_at`, [identityA.provenance_reference]);
    assert.equal(identityUpsertEvents.rowCount, 2, 'identity-link create and update must each retain an integration result event');
    assert(identityUpsertEvents.rows.every(row => row.provider === 'entra' && row.status === 'Success'
      && row.entity_id === identityA.provenance_reference
      && row.response_payload.provenanceReference === identityA.provenance_reference
      && row.response_payload.status === 'Linked'), 'identity event provenance must retain source and processing result');
    const identityUpdateEvent = identityUpsertEvents.rows.find(row => row.response_payload.mutation === 'Updated');
    assert.ok(identityUpdateEvent, 'integration provenance must distinguish the identity-link update');
    assert.equal(identityUpdateEvent.response_payload.providerIdentifierChanged, true,
      'identity updates must record that the external provider identifier changed without storing its value');
    assert.equal(identityUpdateEvent.response_payload.providerAccountChanged, true,
      'identity updates must record that the external account address changed without storing its value');
    const identityCreateEvent = identityUpsertEvents.rows.find(row => row.response_payload.mutation === 'Created');
    assert.ok(identityCreateEvent);
    assert.equal(identityCreateEvent.response_payload.providerAccountChanged, false,
      'identity event provenance must not imply an account address changed when the optional UPN is absent');
    assert(!JSON.stringify(identityUpsertEvents.rows).includes('scope-a-provider-subject')
      && !JSON.stringify(identityUpsertEvents.rows).includes('scope-a-provider@example.test')
      && !JSON.stringify(identityUpsertEvents.rows).includes('scope-a-provider-updated@example.test'),
    'integration provenance payloads must not duplicate external identifiers already held in the protected identity-link row');

    const teamsAResponse = await postScopedJson('/api/integrations/teams-user-links', token, 'org-default', 'legal-default', {
      employee_id: employeeA.id,
      teams_user_id: 'scope-a-teams-user',
      teams_upn: 'scope-a-teams@example.test',
      teams_tenant_id: 'scope-a-tenant',
      status: 'Linked',
    });
    assert.equal(teamsAResponse.status, 200, 'Teams link writes must retain existing behavior inside scope');
    const teamsBResponse = await postScopedJson('/api/integrations/teams-user-links', multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {
      employee_id: 'employee-scope-beta',
      teams_user_id: 'scope-b-teams-user',
      teams_upn: 'scope-b-teams@example.test',
      teams_tenant_id: 'scope-b-tenant',
      status: 'Linked',
    });
    assert.equal(teamsBResponse.status, 200);
    const teamsCrossScopeWrite = await postScopedJson('/api/integrations/teams-user-links', token, 'org-default', 'legal-default', {
      employee_id: 'employee-scope-beta',
      teams_user_id: 'unauthorized-teams-user',
      status: 'Linked',
    });
    assert.equal(teamsCrossScopeWrite.status, 404,
      'Teams integration writes must not associate an out-of-scope employee with the selected scope');

    const actionExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
    const actionAResponse = await postScopedJson('/api/integrations/teams-action-tokens', token, 'org-default', 'legal-default', {
      entity_type: 'PortalLink', entity_id: 'scope-a-portal', action: 'open_portal',
      target_url: '/approvals', expires_at: actionExpiry,
    });
    assert.equal(actionAResponse.status, 200);
    const actionA = await actionAResponse.json();
    assert.ok(actionA.token);
    assert.ok(actionA.action_url);
    const actionBResponse = await postScopedJson('/api/integrations/teams-action-tokens', multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {
      entity_type: 'PortalLink', entity_id: 'scope-b-portal', action: 'open_portal',
      target_url: '/approvals', expires_at: actionExpiry,
    });
    assert.equal(actionBResponse.status, 200);
    const actionB = await actionBResponse.json();
    assert.ok(actionB.token);
    assert.ok(actionB.action_url);

    const actionSendResponse = await postScopedJson(
      `/api/integrations/teams-action-tokens/${encodeURIComponent(actionA.token)}/send`,
      token, 'org-default', 'legal-default', {
        recipient_employee_id: employeeA.id,
        title: 'Synthetic action notification',
        body: 'Please review this item.',
      });
    assert.equal(actionSendResponse.status, 200,
      'a scoped Teams action notification must keep its existing send behavior');

    const scopeLegacyToken = randomBytes(32).toString('hex');
    await pool.query(`insert into teams_action_tokens (token,entity_type,entity_id,action,expires_at)
      values ($1,'PortalLink','legacy-null-portal','open_portal',now()+interval '15 minutes')`, [scopeLegacyToken]);
    const beforeCrossScopeTokenActions = await pool.query(`select
        (select count(*)::int from integration_event_logs where event_type in ('TeamsActionTokenExecuted','TeamsActionNotificationSent')) as events,
        (select count(*)::int from audit_logs where action in ('Execute Teams Action Token','Send Teams Action Notification')) as audits,
        (select count(*)::int from notification_events where event_type='TeamsAction') as notifications`);
    for (const [candidate, label] of [
      [actionA.token, 'scope A token used from scope B'],
      [scopeLegacyToken, 'legacy null-scope token used from scope B'],
    ]) {
      const executeResponse = await postScopedJson(`/api/integrations/teams-action-tokens/${encodeURIComponent(candidate)}/execute`,
        multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {comments: 'must not execute cross-scope'});
      assert.equal(executeResponse.status, 404, `${label} must fail closed before execution`);
      const sendResponse = await postScopedJson(`/api/integrations/teams-action-tokens/${encodeURIComponent(candidate)}/send`,
        multiScopeToken, 'org-scope-beta', 'legal-scope-beta', {recipient_employee_id: 'employee-scope-beta'});
      assert.equal(sendResponse.status, 404, `${label} must fail closed before notification send`);
    }
    const afterCrossScopeTokenActions = await pool.query(`select
        (select count(*)::int from integration_event_logs where event_type in ('TeamsActionTokenExecuted','TeamsActionNotificationSent')) as events,
        (select count(*)::int from audit_logs where action in ('Execute Teams Action Token','Send Teams Action Notification')) as audits,
        (select count(*)::int from notification_events where event_type='TeamsAction') as notifications`);
    assert.deepEqual(afterCrossScopeTokenActions.rows, beforeCrossScopeTokenActions.rows,
      'rejected cross-scope and legacy token attempts must not create event, audit, or notification side effects');
    const rejectedTokenState = await pool.query(`select token,used_at from teams_action_tokens
      where token in ($1,$2) order by token`, [actionA.token, scopeLegacyToken]);
    assert.deepEqual(rejectedTokenState.rows, [
      {token: actionA.token, used_at: null},
      {token: scopeLegacyToken, used_at: null},
    ].sort((a,b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0), 'rejected cross-scope and legacy token attempts must leave tokens unused');

    await pool.query(`insert into integration_event_logs
        (id,provider,event_type,entity_type,entity_id,status,response_payload,organization_id,legal_entity_id)
      values
        ('scope-a-failure','test','ScopeAFailure','ScopedTest','scope-a','Failed','{"provider_subject":"failure-subject-a"}'::jsonb,'org-default','legal-default'),
        ('scope-b-failure','test','ScopeBFailure','ScopedTest','scope-b','Failed','{"provider_subject":"failure-subject-b"}'::jsonb,'org-scope-beta','legal-scope-beta'),
        ('same-org-other-legal-event','test','SameOrgOtherLegal','ScopedTest','same-org-other-legal','Failed',
          '{"provider_subject":"failure-subject-same-org"}'::jsonb,'org-default','legal-client-outside-same-org')`);

    const auditReadA = await getScoped('/api/audit-logs', token, 'org-default', 'legal-default');
    assert.equal(auditReadA.status, 200);
    const auditRowsA = await auditReadA.json();
    assert(auditRowsA.length > 0);
    assert(auditRowsA.every(row => row.organization_id === 'org-default' && row.legal_entity_id === 'legal-default'),
      'Admin audit reads must be restricted to the exact selected organization and legal entity');
    assert(!auditRowsA.some(row => row.entity_id === 'legacy-null-audit'), 'null-scope legacy audit rows must remain hidden');
    assert(!auditRowsA.some(row => row.entity_id === 'scope-b-audit'), 'Admin must not bypass scope for the second organization');
    const scopedMarkerA = auditRowsA.find(row => row.entity_id === 'scope-a-audit');
    assert.equal(scopedMarkerA.new_value.nested.provider_subject, undefined,
      'general audit DTOs must redact nested identity subjects as well as top-level values');
    assert.equal(scopedMarkerA.new_value.nested.upn, undefined,
      'general audit DTOs must redact nested UPNs');
    const identityAuditA = auditRowsA.find(row => row.entity_id === identityA.provenance_reference && row.action === 'Create Identity Link');
    assert.ok(identityAuditA, 'the scoped identity mutation must remain auditable inside its scope');
    assert.equal(identityAuditA.source, 'Entra');
    assert.equal(identityAuditA.source_identifier, identityA.provenance_reference);
    assert.equal(identityAuditA.entity_id, identityA.provenance_reference);
    assert.equal(identityAuditA.import_batch_id, null);
    assert.equal(identityAuditA.import_processing_result, 'Success');
    const identityAuditAUpdate = auditRowsA.find(row => row.entity_id === identityA.provenance_reference && row.action === 'Update Identity Link');
    assert.ok(identityAuditAUpdate, 'the identity update must remain auditable under its stable provenance reference');
    assert.equal(identityAuditAUpdate.source_identifier, identityA.provenance_reference);
    assert.equal(identityAuditA.new_value.provider_subject, undefined, 'audit DTOs must redact identity provider subjects');
    assert.equal(identityAuditA.new_value.provider_upn, undefined, 'audit DTOs must redact identity provider UPNs');
    assert.equal(identityAuditA.new_value.status, 'Linked');
    const actionNotificationAudit = auditRowsA.find(row => row.entity_id === 'scope-a-portal' && row.action === 'Send Notification');
    assert.ok(actionNotificationAudit,
      'the real Teams send route must retain its notification audit event inside the selected scope');
    assert.match(actionNotificationAudit.new_value.body, /Action link: \[redacted action URL\]/,
      'scoped audit history must replace the bearer action URL embedded in notification text');
    assert(!JSON.stringify(actionNotificationAudit).includes(actionA.action_url),
      'scoped audit history must not reveal the bearer action URL embedded in notification text');

    const auditReadAV1 = await getScoped('/api/v1/audit-logs', token, 'org-default', 'legal-default');
    assert.equal(auditReadAV1.status, 200, 'the versioned audit-history route must return a scoped authorized history');
    const auditRowsAV1 = await auditReadAV1.json();
    assert.deepEqual(
      [...auditRowsAV1].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...auditRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      'legacy and versioned audit history must return the same rows and redacted DTO shape',
    );
    const auditSingleScopeNoSelector = await fetch(`${baseUrl}/api/v1/audit-logs`, {
      headers: {Authorization: `Bearer ${tokenFor(singleScopeActorId, 'synthetic-single-scope-admin')}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(auditSingleScopeNoSelector.status, 200,
      'the existing server resolver may select the only authorized scope when headers are absent');
    const auditRowsSingleScope = await auditSingleScopeNoSelector.json();
    assert.deepEqual(
      [...auditRowsSingleScope].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...auditRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );

    const auditDeniedLegacy = await getScoped('/api/audit-logs', employeeTokenWithoutAdminPermissions, 'org-default', 'legal-default');
    assert.equal(auditDeniedLegacy.status, 403, 'an Employee without audit.view must be denied the legacy audit route');
    const auditDeniedV1 = await getScoped('/api/v1/audit-logs', employeeTokenWithoutAdminPermissions, 'org-default', 'legal-default');
    assert.equal(auditDeniedV1.status, 403, 'an Employee without audit.view must be denied the versioned audit route');
    assert.equal((await auditDeniedV1.json()).error.code, 'FORBIDDEN',
      'versioned permission denial must use the stable API error envelope');

    const auditReadB = await getScoped('/api/audit-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    assert.equal(auditReadB.status, 200);
    const auditRowsB = await auditReadB.json();
    assert(auditRowsB.some(row => row.entity_id === 'scope-b-audit'));
    assert(!auditRowsB.some(row => row.entity_id === 'scope-a-audit'));
    assert(!auditRowsB.some(row => row.entity_id === 'legacy-null-audit'));
    assert(auditRowsB.every(row => row.organization_id === 'org-scope-beta' && row.legal_entity_id === 'legal-scope-beta'));
    const ambiguousMultiScopeRead = await fetch(`${baseUrl}/api/audit-logs`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ambiguousMultiScopeRead.status, 403,
      'multi-scope Admin must select one authorized scope instead of receiving a global audit aggregation');
    const ambiguousMultiScopeReadV1 = await fetch(`${baseUrl}/api/v1/audit-logs`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ambiguousMultiScopeReadV1.status, 403,
      'the versioned audit route must require one explicitly selected scope for a multi-scope Admin');
    assert.equal((await ambiguousMultiScopeReadV1.json()).error.code, 'ORG_SCOPE_DENIED');

    const importReadA = await getScoped('/api/import-export-logs', token, 'org-default', 'legal-default');
    const importRowsA = await importReadA.json();
    assert(importRowsA.some(row => row.file_name === 'scope-a-history.csv'));
    const scopedImportErrorHistory = importRowsA.find(row => row.id === partialBody.log.id);
    assert(scopedImportErrorHistory,
      'the originating legal-entity reader must return the batch that contains its rejected-row source IDs');
    assert.deepEqual(scopedImportErrorHistory.errors, partialBody.errors,
      'scoped import history must preserve the exact rejected-row identifiers and original CSV row numbers');
    assert(!importRowsA.some(row => row.file_name === 'scope-b-history.csv'));
    assert(!importRowsA.some(row => row.file_name === 'legacy-null-scope.csv'));
    assert(importRowsA.every(row => row.organization_id === 'org-default' && row.legal_entity_id === 'legal-default'));
    const importReadAV1 = await getScoped('/api/v1/import-export-logs', token, 'org-default', 'legal-default');
    assert.equal(importReadAV1.status, 200);
    const importRowsAV1 = await importReadAV1.json();
    assert.deepEqual(
      [...importRowsAV1].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...importRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      'versioned import history must retain the legacy payload, exact scope and null-scope exclusion',
    );
    const importSingleScopeNoSelector = await fetch(`${baseUrl}/api/v1/import-export-logs`, {
      headers: {Authorization: `Bearer ${tokenFor(singleScopeActorId, 'synthetic-single-scope-admin')}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(importSingleScopeNoSelector.status, 200,
      'the existing server resolver may select the only authorized import-history scope when headers are absent');
    const importRowsSingleScope = await importSingleScopeNoSelector.json();
    assert.deepEqual(
      [...importRowsSingleScope].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...importRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );
    const importReadB = await getScoped('/api/import-export-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    const importRowsB = await importReadB.json();
    assert(importRowsB.some(row => row.file_name === 'scope-b-history.csv'));
    assert(!importRowsB.some(row => row.file_name === 'scope-a-history.csv'));
    assert(!importRowsB.some(row => row.id === partialBody.log.id),
      'another legal-entity history reader must not retrieve import errors or source identifiers from this batch');
    assert(!JSON.stringify(importRowsB).includes('EMP-IMPORT-PREFLIGHT-FAILED'),
      'source identifiers in import errors must stay inside the selected history scope');
    assert(!importRowsB.some(row => row.file_name === 'legacy-null-scope.csv'));
    const importReadBV1 = await getScoped('/api/v1/import-export-logs', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    assert.equal(importReadBV1.status, 200);
    const importRowsBV1 = await importReadBV1.json();
    assert.deepEqual(
      [...importRowsBV1].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...importRowsB].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      'versioned import history must preserve authorized multi-scope selection and its legacy payload',
    );
    const importHistoryOnlyToken = tokenFor(importHistoryOnlyActorId, 'synthetic-import-history-only', 'Employee');
    const importHistoryOnlySessionResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {Authorization: `Bearer ${importHistoryOnlyToken}`}, signal: AbortSignal.timeout(5000),
    });
    assert.equal(importHistoryOnlySessionResponse.status, 200);
    const importHistoryOnlySession = await importHistoryOnlySessionResponse.json();
    assert(importHistoryOnlySession.permissions.includes('imports.manage'));
    assert.equal(importHistoryOnlySession.permissions.includes('employees.manage'), false,
      'the history reader must have the existing import permission without Employee Master mutation permission');
    const importHistoryOnlyRead = await getScoped('/api/v1/import-export-logs', importHistoryOnlyToken,
      'org-default', 'legal-default');
    assert.equal(importHistoryOnlyRead.status, 200,
      'a user with imports.manage but without employees.manage may read selected-scope import history');
    const importHistoryOnlyRows = await importHistoryOnlyRead.json();
    assert(importHistoryOnlyRows.some(row => row.file_name === 'Employee Master import.csv'),
      'the authorized imports.manage reader can see the server-controlled Employee batch label within the exact selected scope');
    assert.equal(JSON.stringify(importHistoryOnlyRows).includes(firstEmployeePassword), false,
      'scoped history does not disclose imported credentials');

    const importDeniedLegacy = await getScoped('/api/import-export-logs', employeeTokenWithoutAdminPermissions,
      'org-default', 'legal-default');
    assert.equal(importDeniedLegacy.status, 403,
      'an Employee without imports.manage must be denied the legacy import-history route');
    const importDeniedV1 = await getScoped('/api/v1/import-export-logs', employeeTokenWithoutAdminPermissions,
      'org-default', 'legal-default');
    assert.equal(importDeniedV1.status, 403,
      'the versioned route must preserve imports.manage authorization');
    assert.equal((await importDeniedV1.json()).error.code, 'FORBIDDEN');
    const ambiguousImportHistoryV1 = await fetch(`${baseUrl}/api/v1/import-export-logs`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ambiguousImportHistoryV1.status, 403,
      'the versioned route must require an explicit scope for a multi-scope Admin');
    assert.equal((await ambiguousImportHistoryV1.json()).error.code, 'ORG_SCOPE_DENIED');

    await pool.query(`insert into integration_event_logs
        (id,provider,event_type,entity_type,entity_id,status,request_payload,response_payload,created_at,organization_id,legal_entity_id)
      values
        ('deployment-entra-login-rejected','entra','EntraLoginRejected','IdentityProviderLink','deployment-private-subject','Failed',
          '{"provider_subject":"deployment-private-subject","provider_upn":"deployment-private@example.test","reason":"No linked identity matched"}'::jsonb,
          '{"entra_object_id":"deployment-private-object","status":"Rejected"}'::jsonb,
          timestamptz '2026-10-12 12:00:00+00',null,null),
        ('deployment-teams-action-notification','teams','TeamsActionNotificationSent','PortalLink','deployment-portal','Success',
          '{"action":"open_portal"}'::jsonb,
          jsonb_build_object('actionUrl',$1::text),
          timestamptz '2026-10-12 11:00:00+00',null,null),
        ('deployment-teams-notification-delivered','teams','TeamsNotificationDelivered','NotificationEvent','deployment-notification','Success',
          null,
          jsonb_build_object('statusCode',202,'teamsUser',$2::text,'activityType','systemDefault'),
          timestamptz '2026-10-12 11:30:00+00',null,null)`, [actionA.action_url, 'deployment-teams-user@example.test']);

    const ungrantedIntegrationHistory = await fetch(`${baseUrl}/api/deployment-integration-events`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ungrantedIntegrationHistory.status, 403,
      'an authenticated Admin without an explicit deployment-audit grant must not read deployment integration events');
    const ungrantedIntegrationHistoryV1 = await fetch(`${baseUrl}/api/v1/deployment-integration-events`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ungrantedIntegrationHistoryV1.status, 403);
    assert.equal((await ungrantedIntegrationHistoryV1.json()).error.code, 'FORBIDDEN');

    const deploymentIntegrationHeaders = {Authorization: `Bearer ${scopeFreeAuditorToken}`};
    const deploymentIntegrationRead = await fetch(`${baseUrl}/api/deployment-integration-events`, {
      headers: deploymentIntegrationHeaders,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deploymentIntegrationRead.status, 200,
      'an explicitly designated non-Admin auditor must read deployment events without selecting organization scope');
    const deploymentIntegrationRows = await deploymentIntegrationRead.json();
    assert(deploymentIntegrationRows.some(row => row.id === 'deployment-entra-login-rejected'));
    assert(deploymentIntegrationRows.some(row => row.id === 'deployment-teams-action-notification'));
    assert(deploymentIntegrationRows.some(row => row.id === 'deployment-teams-notification-delivered'));
    assert(deploymentIntegrationRows.some(row => row.id === 'legacy-null-scope-event'),
      'the deployment reader may expose retained null-scope history only to the designated auditor');
    const rejectedDeploymentEvent = deploymentIntegrationRows.find(row => row.id === 'deployment-entra-login-rejected');
    assert.equal(rejectedDeploymentEvent.entity_id, null,
      'unmatched deployment-wide login attempts must not expose provider subjects through entity IDs');
    assert.deepEqual(rejectedDeploymentEvent.request_payload, {reason: 'No linked identity matched'});
    assert.deepEqual(rejectedDeploymentEvent.response_payload, {status: 'Rejected'});
    const deploymentTeamsEvent = deploymentIntegrationRows.find(row => row.id === 'deployment-teams-action-notification');
    assert.deepEqual(deploymentTeamsEvent.response_payload, {},
      'the deployment reader must redact bearer action URLs before returning events');
    const deploymentTeamsDeliveryEvent = deploymentIntegrationRows.find(row => row.id === 'deployment-teams-notification-delivered');
    assert.deepEqual(deploymentTeamsDeliveryEvent.response_payload, {statusCode: 202},
      'the deployment reader must retain allowlisted status while removing provider-specific activity metadata and identities');
    assert(!JSON.stringify(deploymentIntegrationRows).includes('deployment-private-subject'));
    assert(!JSON.stringify(deploymentIntegrationRows).includes('deployment-private@example.test'));
    assert(!JSON.stringify(deploymentIntegrationRows).includes('deployment-private-object'));
    assert(!JSON.stringify(deploymentIntegrationRows).includes('deployment-teams-user@example.test'));
    assert(!JSON.stringify(deploymentIntegrationRows).includes(actionA.action_url));
    const deploymentIntegrationReadV1 = await fetch(`${baseUrl}/api/v1/deployment-integration-events`, {
      headers: deploymentIntegrationHeaders,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deploymentIntegrationReadV1.status, 200);
    assert.deepEqual(await deploymentIntegrationReadV1.json(), deploymentIntegrationRows,
      'legacy and v1 deployment integration readers must return the same redacted exact-null/null history');

    const eventReadA = await getScoped('/api/integrations/events', token, 'org-default', 'legal-default');
    const eventRowsA = await eventReadA.json();
    assert(eventRowsA.some(row => row.id === `integration-event-${identityA.provenance_reference}` || row.entity_id === identityA.provenance_reference),
      'identity integration events must remain available in the selected scope');
    assert(eventRowsA.some(row => row.id === 'scope-a-failure'));
    assert(!eventRowsA.some(row => row.id === 'scope-b-failure'
      || row.id === 'legacy-null-scope-event' || row.id === 'same-org-other-legal-event'
      || row.id === 'deployment-entra-login-rejected' || row.id === 'deployment-teams-action-notification'
      || row.id === 'deployment-teams-notification-delivered'));
    assert(eventRowsA.every(row => row.organization_id === 'org-default' && row.legal_entity_id === 'legal-default'));
    assert(!JSON.stringify(eventRowsA).includes('scope-a-provider-subject'));
    assert(!JSON.stringify(eventRowsA).includes('scope-a-provider@example.test'));
    assert(!JSON.stringify(eventRowsA).includes('scope-a-provider-updated@example.test'));
    assert(!JSON.stringify(eventRowsA).includes(actionA.action_url),
      'integration history must not expose bearer action URLs recorded at token creation');
    const eventReadAV1 = await getScoped('/api/v1/integrations/events', token, 'org-default', 'legal-default');
    assert.equal(eventReadAV1.status, 200);
    const eventRowsAV1 = await eventReadAV1.json();
    assert.deepEqual(
      [...eventRowsAV1].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...eventRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      'the versioned integration reader must preserve the scoped legacy payload and redaction',
    );
    const eventReadOtherLegalV1 = await getScoped('/api/v1/integrations/events', token,
      'org-default', 'legal-client-outside-same-org');
    assert.equal(eventReadOtherLegalV1.status, 200);
    const eventRowsOtherLegalV1 = await eventReadOtherLegalV1.json();
    assert.deepEqual(eventRowsOtherLegalV1.map(row => row.id), ['same-org-other-legal-event'],
      'the exact legal-entity filter must exclude another legal entity in the same organization');
    const eventSingleScopeNoSelector = await fetch(`${baseUrl}/api/v1/integrations/events`, {
      headers: {Authorization: `Bearer ${tokenFor(singleScopeActorId, 'synthetic-single-scope-admin')}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(eventSingleScopeNoSelector.status, 200,
      'the versioned integration reader may use the server-resolved sole authorized scope');
    const eventRowsSingleScope = await eventSingleScopeNoSelector.json();
    assert.deepEqual(
      [...eventRowsSingleScope].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...eventRowsA].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    );
    const eventReadB = await getScoped('/api/integrations/events', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    const eventRowsB = await eventReadB.json();
    assert(eventRowsB.some(row => row.id === 'scope-b-failure'));
    assert(eventRowsB.some(row => row.entity_id === identityB.provenance_reference), 'scope B identity events must remain available within scope B');
    assert(!eventRowsB.some(row => row.id === 'scope-a-failure'
      || row.id === 'legacy-null-scope-event' || row.id === 'same-org-other-legal-event'
      || row.id === 'deployment-entra-login-rejected' || row.id === 'deployment-teams-action-notification'));
    assert(eventRowsB.every(row => row.organization_id === 'org-scope-beta' && row.legal_entity_id === 'legal-scope-beta'));
    assert(!JSON.stringify(eventRowsB).includes('scope-b-provider-subject'));
    assert(!JSON.stringify(eventRowsB).includes('scope-b-provider@example.test'));
    assert(!JSON.stringify(eventRowsB).includes('scope-b-provider-updated@example.test'));
    assert(!JSON.stringify(eventRowsB).includes(actionB.action_url),
      'integration history must not expose bearer action URLs for another action in this scope');
    const eventReadBV1 = await getScoped('/api/v1/integrations/events', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    assert.equal(eventReadBV1.status, 200);
    const eventRowsBV1 = await eventReadBV1.json();
    assert.deepEqual(
      [...eventRowsBV1].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [...eventRowsB].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      'the versioned integration reader must preserve explicit multi-scope selection',
    );
    const eventReadDeniedV1 = await getScoped('/api/v1/integrations/events', employeeTokenWithoutAdminPermissions,
      'org-default', 'legal-default');
    assert.equal(eventReadDeniedV1.status, 403,
      'an Employee without integrations.identity must be denied the versioned integration-history route');
    assert.equal((await eventReadDeniedV1.json()).error.code, 'FORBIDDEN');
    const ambiguousEventReadV1 = await fetch(`${baseUrl}/api/v1/integrations/events`, {
      headers: {Authorization: `Bearer ${multiScopeToken}`},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ambiguousEventReadV1.status, 403,
      'the versioned integration reader must require an explicit pair for a multi-scope Admin');
    assert.equal((await ambiguousEventReadV1.json()).error.code, 'ORG_SCOPE_DENIED');

    const teamsReadA = await getScoped('/api/integrations/teams-user-links', token, 'org-default', 'legal-default');
    const teamsRowsA = await teamsReadA.json();
    assert(teamsRowsA.some(row => row.teams_user_id === 'scope-a-teams-user'));
    assert(!teamsRowsA.some(row => row.teams_user_id === 'scope-b-teams-user'));
    const teamsReadB = await getScoped('/api/integrations/teams-user-links', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    const teamsRowsB = await teamsReadB.json();
    assert(teamsRowsB.some(row => row.teams_user_id === 'scope-b-teams-user'));
    assert(!teamsRowsB.some(row => row.teams_user_id === 'scope-a-teams-user'));

    for (const path of [
      '/api/audit-logs', '/api/v1/audit-logs', '/api/import-export-logs', '/api/v1/import-export-logs',
      '/api/integrations/events', '/api/v1/integrations/events',
      '/api/integrations/health', '/api/integrations/teams-user-links',
    ]) {
      const denied = await getScoped(path, token, 'org-scope-beta', 'legal-scope-beta');
      assert.equal(denied.status, 403, `Admin without an assigned pair must not bypass scope for ${path}`);
    }

    const expectedBetaMetrics = await pool.query(`select
        (select count(distinct ipl.employee_id)::int from identity_provider_links ipl join employees e on e.id=ipl.employee_id
          where ipl.status='Linked' and e.organization_id='org-scope-beta' and e.legal_entity_id='legal-scope-beta') as linked_identity_count,
        (select count(distinct tul.employee_id)::int from teams_user_links tul join employees e on e.id=tul.employee_id
          where tul.status='Linked' and e.organization_id='org-scope-beta' and e.legal_entity_id='legal-scope-beta') as linked_teams_count,
        (select count(*)::int from integration_event_logs where status='Failed' and organization_id='org-scope-beta' and legal_entity_id='legal-scope-beta') as recent_failures,
        (select count(*)::int from teams_action_tokens where used_at is null and expires_at>now()
          and organization_id='org-scope-beta' and legal_entity_id='legal-scope-beta') as open_action_tokens`);
    const healthBResponse = await getScoped('/api/integrations/health', multiScopeToken, 'org-scope-beta', 'legal-scope-beta');
    assert.equal(healthBResponse.status, 200);
    const healthB = await healthBResponse.json();
    assert.equal(healthB.linked_identity_count, expectedBetaMetrics.rows[0].linked_identity_count);
    assert.equal(healthB.linked_teams_count, expectedBetaMetrics.rows[0].linked_teams_count);
    assert.equal(healthB.recent_failures, expectedBetaMetrics.rows[0].recent_failures);
    assert.equal(healthB.open_action_tokens, expectedBetaMetrics.rows[0].open_action_tokens);
    assert.equal(healthB.linked_identity_count, 1);
    assert.equal(healthB.linked_teams_count, 1);
    assert.equal(healthB.open_action_tokens, 1, 'null-scope legacy tokens must not enter scoped aggregates');
    assert(healthB.events.every(row => row.organization_id === 'org-scope-beta' && row.legal_entity_id === 'legal-scope-beta'));
    assert(!JSON.stringify(healthB.events).includes('scope-b-provider-subject'));
    assert(!JSON.stringify(healthB.events).includes(actionB.action_url),
      'integration health events must not expose bearer action URLs');

    const healthAResponse = await getScoped('/api/integrations/health', token, 'org-default', 'legal-default');
    assert.equal(healthAResponse.status, 200);
    const healthA = await healthAResponse.json();
    assert.equal(healthA.recent_failures,
      (await pool.query(`select count(*)::int as count from integration_event_logs where status='Failed' and organization_id='org-default' and legal_entity_id='legal-default'`)).rows[0].count,
      'integration health failure counts must not include another authorized scope or unscoped legacy events');
    assert.equal(healthA.open_action_tokens, 1, 'open-action-token counts must be scope-owned');
    assert(healthA.events.every(row => row.organization_id === 'org-default' && row.legal_entity_id === 'legal-default'));
    assert(!JSON.stringify(healthA.events).includes(actionA.action_url),
      'integration health events must not expose bearer action URLs');
  });
}, {maxPoolSize: 1});

const preOrganizationAuditMigrationRoot = await mkdtemp(join(tmpdir(), 'workos-pr006-before-organization-audit-'));
await mkdir(join(preOrganizationAuditMigrationRoot, 'migrations'));
await writeFile(join(preOrganizationAuditMigrationRoot, 'schema.sql'), await readFile(join(serverDir, 'schema.sql'), 'utf8'));
for (const migration of manifest.slice(1).filter(item => item.id < '038_')) {
  await writeFile(join(preOrganizationAuditMigrationRoot, 'migrations', migration.file),
    await readFile(join(serverDir, 'migrations', migration.file), 'utf8'));
}

await withDisposableDatabase(async (pool) => {
  const concurrent = await Promise.all([
    runMigrations({pool, rootDir: serverDir, logger: quietLogger}),
    runMigrations({pool, rootDir: serverDir, logger: quietLogger}),
  ]);
  assert.equal(concurrent.reduce((count, result) => count + result.applied.length, 0), manifest.length,
    'concurrent first runs must apply every migration exactly once');

  const current = await getMigrationStatus(pool, {rootDir: serverDir});
  assert.equal(current.isCurrent, true);
  assert.deepEqual(current.pendingIds, []);
  const ledger = await pool.query('select id, checksum from schema_migrations order by id');
  assert.equal(ledger.rowCount, manifest.length);
  assert(ledger.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum)), 'fresh installs record SHA-256 checksums');

  const replay = await runMigrations({pool, rootDir: serverDir, logger: quietLogger});
  assert.deepEqual(replay.applied, [], 'replaying a current database must not apply migrations twice');
  assert.equal(replay.skipped.length, manifest.length);

  await pool.query('update schema_migrations set checksum = $2 where id = $1', [manifest[1].id, '0'.repeat(64)]);
  await assert.rejects(
    () => runMigrations({pool, rootDir: serverDir, logger: quietLogger}),
    error => error.code === 'MIGRATION_CHECKSUM_MISMATCH',
    'changed migration files must fail closed when a digest was recorded',
  );
  await pool.query('insert into schema_migrations (id, checksum) values ($1, $2)', ['999_future_release', 'b'.repeat(64)]);
  await assert.rejects(
    () => runMigrations({pool, rootDir: serverDir, logger: quietLogger}),
    error => error.code === 'UNKNOWN_MIGRATION_LEDGER_ENTRY',
    'an older application must fail closed when the database contains a newer migration ID',
  );
});

await withDisposableDatabase(async (pool) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Recreate the merged main level through migration 032, then add historical
    // rows before exercising the additive PR-006 migrations.
    await client.query(`
      create table schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const baselineSql = await readFile(join(serverDir, 'schema.sql'), 'utf8');
    await client.query(baselineSql);
    await client.query('insert into schema_migrations (id) values ($1)', [manifest[0].id]);
    for (const migration of manifest.slice(1).filter(item => item.id < '033_')) {
      const sql = await readFile(join(serverDir, 'migrations', migration.file), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
    }
    await client.query(`insert into audit_logs (user_id,user_name,user_role,module,action,details)
      values ('legacy-actor','Legacy actor','Admin','Test','Before request IDs','existing audit evidence')`);
    await client.query(`insert into import_export_logs (operation,channel,file_name,status,user_name)
      values ('Import','Legacy','legacy-scope.csv','Success','Legacy actor')`);
    await client.query(`insert into integration_event_logs (id,provider,event_type,entity_type,entity_id,status,response_payload)
      values ('legacy-scope-event','test','LegacyEvent','LegacyEntity','legacy-entity','Success','{"retained":"unchanged"}'::jsonb)`);
    await client.query(`insert into teams_action_tokens (token,entity_type,entity_id,action,expires_at)
      values ($1,'PortalLink','legacy-portal','open_portal',now()+interval '1 hour')`, [legacyScopeToken]);
    await client.query(`insert into country_directors (id,name,region)
      values ('legacy-link-director','Legacy link director','Legacy region')`);
    await client.query(`insert into employees (id,employee_id,name,email,designation,department,country,
        primary_country_director_id,status,organization_id,legal_entity_id)
      values ('legacy-link-employee','LEGACY-LINK-EMP','Legacy link employee','legacy-link@example.test',
        'Consultant','Legacy','US','legacy-link-director','Active','org-default','legal-default')`);
    await client.query(`insert into identity_provider_links (id,employee_id,provider,provider_subject,provider_upn,status)
      values ('legacy-link-id','legacy-link-employee','entra','legacy-provider-subject','legacy-provider@example.test','Linked')`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const preOrganizationAuditUpgrade = await runMigrations({
    pool,
    rootDir: preOrganizationAuditMigrationRoot,
    logger: quietLogger,
  });
  const preOrganizationAuditMigrations = manifest.filter(item => item.id >= '033_' && item.id < '038_');
  assert.deepEqual(preOrganizationAuditUpgrade.applied, preOrganizationAuditMigrations.map(item => item.id),
    'the upgrade through migration 037 must complete before exercising the organization-scope migration boundary');
  const preExistingAuditScopes = await pool.query(`insert into audit_logs
      (user_id,user_name,user_role,module,action,entity_type,entity_id,details,organization_id,legal_entity_id)
    values
      ('legacy-scoped-actor','Legacy scoped actor','Admin','Legacy','Before organization scope','LegacyAudit','scoped-before-038','preserve exact scope','org-default','legal-default'),
      ('legacy-deployment-actor','Legacy deployment actor','Admin','Legacy','Null scope before organization scope','LegacyAudit','null-before-038','preserve null scope',null,null)
    returning entity_id,organization_id,legal_entity_id`);
  assert.deepEqual(preExistingAuditScopes.rows, [
    {entity_id: 'scoped-before-038', organization_id: 'org-default', legal_entity_id: 'legal-default'},
    {entity_id: 'null-before-038', organization_id: null, legal_entity_id: null},
  ], 'pre-038 audit evidence is inserted with both existing ownership forms before migration 038');

  const before = await pool.query('select count(*)::int as count from schema_migrations');
  const upgrade = await runMigrations({pool, rootDir: serverDir, logger: quietLogger});
  const after = await pool.query('select count(*)::int as count from schema_migrations');
  const candidateMigrations = manifest.filter(item => item.id >= '033_');
  assert.deepEqual(candidateMigrations.map(item => item.id), [
    '033_wos03_audit_operation_context',
    '034_wos03_employee_import_provenance',
    '035_wos03_scoped_history',
    '036_wos03_identity_link_provenance_reference',
    '037_wos03_deployment_audit_permission',
    '038_wos03_organization_audit_access',
    '039_wos03_import_operation_contract',
    '040_wos04_commercial_drafting_foundation',
    '041_wos04_governed_lifecycle',
    '042_wos04_scoped_client_profiles',
    '043_wos04_governed_amendments',
    '044_wos04_work_submission_evidence',
    '045_wos04_work_capture_policy',
    '046_wos04_work_capture_modes',
    '047_wos04_work_entry_evidence',
    '048_wos04_work_entry_reference',
    '049_wos04_required_work_evidence',
    '050_wos04_identical_entry_check',
    '051_wos04_overtime_capture_policy',
    '052_wos04_submission_deadline',
    '053_wos04_work_source_identity',
    '054_wos04_workforce_capabilities',
    '055_wos04_resource_demand',
    '056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates',
  ], 'PR-006 and PR-007A–D add request/provenance/history/import contracts and additive commercial modules in order');
  assert.deepEqual([...preOrganizationAuditUpgrade.applied, ...upgrade.applied], candidateMigrations.map(item => item.id),
    'upgrade from merged main applies all additive PR-006/PR-007A–D migrations in order');
  assert.deepEqual(upgrade.applied, ['038_wos03_organization_audit_access', '039_wos03_import_operation_contract', '040_wos04_commercial_drafting_foundation', '041_wos04_governed_lifecycle', '042_wos04_scoped_client_profiles', '043_wos04_governed_amendments', '044_wos04_work_submission_evidence', '045_wos04_work_capture_policy','046_wos04_work_capture_modes','047_wos04_work_entry_evidence','048_wos04_work_entry_reference','049_wos04_required_work_evidence','050_wos04_identical_entry_check','051_wos04_overtime_capture_policy','052_wos04_submission_deadline','053_wos04_work_source_identity','054_wos04_workforce_capabilities','055_wos04_resource_demand','056_wos04_effective_worker_capacity','056a_wos04_capacity_exact_percentage','057_wos04_assignment_versions','057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates'],
    'organization-scope and import-operation migrations apply after historical and legal-entity audit rows already exist');
  assert.equal(upgrade.skipped.length, manifest.length - 34);
  assert.equal(after.rows[0].count, before.rows[0].count + 34, 'the final upgrade appends migrations 038 through 065a to its ledger');
  const status = await getMigrationStatus(pool, {rootDir: serverDir});
  assert.equal(status.isCurrent, true);
  assert.deepEqual(status.legacyUnverifiedIds, manifest.filter(item => item.id < '033_').map(item => item.id),
    'old migration rows without a recorded digest remain explicitly marked unverifiable');
  const ledger = await pool.query('select id, checksum from schema_migrations');
  const newMigrations = ledger.rows.filter(row => candidateMigrations.some(migration => migration.id === row.id));
  assert.equal(newMigrations.length, candidateMigrations.length, 'all PR-006/PR-007/PR-008 migrations are ledgered');
  assert(newMigrations.every(row => /^[0-9a-f]{64}$/.test(row.checksum)),
    'each new migration records its actual SHA-256 checksum');
  assert(ledger.rows.filter(row => !candidateMigrations.some(migration => migration.id === row.id)).every(row => row.checksum === null),
    'upgrade must not invent historical checksums');
  const preservedOrganizationAuditScopes = await pool.query(`select entity_id,organization_id,legal_entity_id from audit_logs
    where entity_id in ('scoped-before-038','null-before-038') order by entity_id`);
  assert.deepEqual(preservedOrganizationAuditScopes.rows, [
    {entity_id: 'null-before-038', organization_id: null, legal_entity_id: null},
    {entity_id: 'scoped-before-038', organization_id: 'org-default', legal_entity_id: 'legal-default'},
  ], 'migration 038 must preserve existing scoped and null-scope audit rows without rewriting their ownership');
  const upgradedIdentityLink = await pool.query(`select id,provider_subject,provider_upn,provenance_reference
    from identity_provider_links where id='legacy-link-id'`);
  assert.equal(upgradedIdentityLink.rowCount, 1, 'the identity-link upgrade fixture remains present');
  assert.equal(upgradedIdentityLink.rows[0].id, 'legacy-link-id');
  assert.equal(upgradedIdentityLink.rows[0].provider_subject, 'legacy-provider-subject',
    'the provenance migration must not rewrite existing external subjects');
  assert.equal(upgradedIdentityLink.rows[0].provider_upn, 'legacy-provider@example.test',
    'the provenance migration must not rewrite existing external account addresses');
  assert.match(upgradedIdentityLink.rows[0].provenance_reference,
    /^identity-link-ref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'the upgrade must backfill a random opaque reference independently of provider identity values');
  assert(!upgradedIdentityLink.rows[0].provenance_reference.includes('legacy-provider-subject')
    && !upgradedIdentityLink.rows[0].provenance_reference.includes('legacy-provider@example.test'));
  const legacyAudit = await pool.query(`select correlation_id,operation_id,import_batch_id,source_identifier,import_processing_result,organization_id,legal_entity_id from audit_logs
    where user_id='legacy-actor' and action='Before request IDs'`);
  assert.equal(legacyAudit.rowCount, 1);
  assert.equal(legacyAudit.rows[0].correlation_id, null, 'existing audit history must not receive invented correlation IDs');
  assert.equal(legacyAudit.rows[0].operation_id, null, 'existing audit history must not receive invented operation IDs');
  assert.equal(legacyAudit.rows[0].import_batch_id, null, 'existing audit history must not receive invented import batches');
  assert.equal(legacyAudit.rows[0].source_identifier, null, 'existing audit history must not receive invented source identifiers');
  assert.equal(legacyAudit.rows[0].import_processing_result, null, 'existing audit history must not receive invented import results');
  assert.equal(legacyAudit.rows[0].organization_id, null, 'existing append-only audit history must not receive guessed organization scope');
  assert.equal(legacyAudit.rows[0].legal_entity_id, null, 'existing append-only audit history must not receive guessed legal-entity scope');
  const legacyImportLog = await pool.query(`select file_name,status,organization_id,legal_entity_id,schema_version,dry_run
    from import_export_logs where file_name='legacy-scope.csv'`);
  assert.deepEqual(legacyImportLog.rows, [{
    file_name: 'legacy-scope.csv',
    status: 'Success',
    organization_id: null,
    legal_entity_id: null,
    schema_version: null,
    dry_run: false,
  }], 'historical import history must remain unchanged and explicitly unscoped after the operation-contract migration');
  const legacyIntegrationLog = await pool.query(`select entity_id,response_payload,organization_id,legal_entity_id from integration_event_logs where id='legacy-scope-event'`);
  assert.deepEqual(legacyIntegrationLog.rows, [{
    entity_id: 'legacy-entity', response_payload: {retained: 'unchanged'}, organization_id: null, legal_entity_id: null,
  }], 'historical integration events must remain unchanged and explicitly unscoped');
  const legacyActionToken = await pool.query(`select token,organization_id,legal_entity_id from teams_action_tokens where token=$1`, [legacyScopeToken]);
  assert.deepEqual(legacyActionToken.rows, [{token: legacyScopeToken, organization_id: null, legal_entity_id: null}],
    'historical action tokens must remain unchanged and explicitly unscoped');
});
await rm(preOrganizationAuditMigrationRoot, {recursive: true, force: true});

const failedMigrationRoot = await mkdtemp(join(tmpdir(), 'workos-failed-migration-'));
try {
  await mkdir(join(failedMigrationRoot, 'migrations'));
  await writeFile(join(failedMigrationRoot, 'schema.sql'), 'create table migration_rollback_probe (id integer primary key);\n');
  await writeFile(
    join(failedMigrationRoot, 'migrations', '001_forced_failure.sql'),
    'insert into migration_rollback_probe (id) values (1);\nselect * from migration_failure_probe_missing;\n',
  );

  await withDisposableDatabase(async (pool) => {
    await assert.rejects(
      () => runMigrations({pool, rootDir: failedMigrationRoot, logger: quietLogger}),
      error => error.code === 'MIGRATION_FAILED',
      'a failing migration must expose only its stable migration failure code',
    );
    const ledger = await pool.query("select to_regclass('public.schema_migrations') as name");
    const probe = await pool.query("select to_regclass('public.migration_rollback_probe') as name");
    assert.equal(ledger.rows[0].name, null, 'failed migration must roll back its ledger and baseline creation');
    assert.equal(probe.rows[0].name, null, 'failed migration must roll back baseline DDL');
  });
} finally {
  await rm(failedMigrationRoot, {recursive: true, force: true});
}

console.log(`Migration runner smoke tests passed (${manifest.length} entries, fresh/concurrent/replay/upgrade/rollback).`);
