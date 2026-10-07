import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {getMigrationManifest, getMigrationStatus, runMigrations} from '../server/migrate.mjs';

const {Client, Pool} = pg;
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
    const pool = new Pool({connectionString: databaseUrl.toString(), max: maxPoolSize});
    try {
      return await test(pool, databaseUrl.toString());
    } finally {
      await pool.end();
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
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
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
  const secret = 'synthetic-employee-import-session-secret-only';
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
  const token = signTestSession({
    sub: actorId,
    username: 'synthetic-import-admin',
    activeRole: 'Admin',
    exp: Date.now() + 60_000,
  }, secret);

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
    await test({baseUrl, token});
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
      and column_name in ('correlation_id','operation_id','import_batch_id','source_identifier','import_processing_result')`);
  assert.deepEqual(auditColumns.rows.map(row => row.column_name).sort(), [
    'correlation_id', 'import_batch_id', 'import_processing_result', 'operation_id', 'source_identifier',
  ], 'fresh installs must include request trace and employee-import provenance fields');
  const batchIndex = await pool.query(`select indexdef from pg_indexes
    where schemaname='public' and tablename='audit_logs' and indexname='audit_logs_import_batch_id_idx'`);
  assert.equal(batchIndex.rowCount, 1, 'fresh installs must index import-batch audit lookups');
  assert.match(batchIndex.rows[0].indexdef, /where\s+\(import_batch_id is not null\)/i,
    'the batch index must omit audit rows with no import provenance');

  const actorId = randomUUID();
  await pool.query(`insert into roles(name) values ('Admin'),('Employee') on conflict (name) do nothing`);
  await pool.query(`insert into users (id,username,email,status)
    values ($1,'synthetic-import-admin','synthetic-import-admin@example.test','Active')`, [actorId]);
  await pool.query(`insert into user_roles (user_id,role_id)
    select $1,id from roles where name='Admin'`, [actorId]);
  await pool.query(`insert into user_permission_grants (user_id,permission_key,granted_by,active_role)
    values ($1,'imports.manage',$1,'Admin')`, [actorId]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true) on conflict do nothing`, [actorId]);
  await pool.query(`insert into country_directors (id,name,region)
    values ('cd-import-provenance-test','Synthetic Director','Synthetic') on conflict (id) do nothing`);
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
  await withImportApi(databaseUrl, actorId, async ({baseUrl, token}) => {
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

    const partialResponse = await apply({
      fileName: 'synthetic-partial.csv',
      totalRows: 2,
      rows: [
        {
          employeeId: 'EMP-IMPORT-SUCCESS',
          name: 'Synthetic Success Row',
          email: 'employee-import-success@example.test',
          primaryCountryDirectorId: 'cd-import-provenance-test',
          initialPassword: 'Synthetic-import-test-password-1',
        },
        {
          employeeId: 'EMP-IMPORT-FAILED',
          name: 'Synthetic Failed Row',
          email: 'employee-import-failed@example.test',
        },
      ],
    });
    assert.equal(partialResponse.status, 200);
    const partialBody = await partialResponse.json();
    assert.deepEqual({status: partialBody.status, totalRows: partialBody.totalRows,
      validRows: partialBody.validRows, errorRows: partialBody.errorRows},
    {status: 'Partial', totalRows: 2, validRows: 1, errorRows: 1},
    'the real employee apply route must preserve its partial result counts');
    assert.deepEqual(partialBody.errors, [{
      rowNumber: 3,
      field: 'primaryCountryDirectorId',
      message: 'Primary country director is required.',
    }], 'the real employee apply route must preserve its existing row-error shape');
    const partialLog = (await pool.query(`select * from import_export_logs where id=$1`, [partialBody.log.id])).rows[0];
    const partialAudit = await pool.query(`select source,source_identifier,import_batch_id,import_processing_result,details
      from audit_logs where import_batch_id=$1`, [partialBody.log.id]);
    assert.equal(partialLog.status, 'Partial');
    assert.equal(partialLog.total_rows, 2);
    assert.equal(partialLog.valid_rows, 1);
    assert.equal(partialLog.error_rows, 1);
    assert.equal(partialAudit.rowCount, 1, 'a partial batch must audit only the successful row');
    assert.deepEqual(partialAudit.rows[0], {
      source: 'Employee Master CSV',
      source_identifier: 'EMP-IMPORT-SUCCESS',
      import_batch_id: partialBody.log.id,
      import_processing_result: 'Success',
      details: 'Created employee master record from CSV import',
    }, 'the persisted success audit must link source, identifier, result and batch');
    assert.doesNotMatch(partialAudit.rows[0].details, /EMP-IMPORT-SUCCESS|synthetic-partial\.csv/,
      'audit details must not duplicate row identifiers or expose uploaded file contents');

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
        initialPassword: 'Synthetic-import-test-password-2',
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
    assert.deepEqual({status: clientPartialBody.status, totalRows: clientPartialBody.totalRows,
      validRows: clientPartialBody.validRows, errorRows: clientPartialBody.errorRows},
    {status: 'Partial', totalRows: 3, validRows: 2, errorRows: 1},
    'the real client apply route must preserve its partial batch counts');
    assert.deepEqual(clientPartialBody.errors, [{
      rowNumber: 4,
      field: 'accountOwnerId',
      message: 'Account owner employee record does not exist or is exited.',
    }], 'the real client apply route must preserve its row-error shape');
    const clientPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [clientPartialBody.log.id])).rows[0];
    assert.equal(clientPartialLog.id, clientPartialBody.log.id, 'client batch history must return its persisted server batch ID');
    assert.equal(clientPartialLog.status, 'Partial');
    assert.equal(clientPartialLog.total_rows, 3);
    assert.equal(clientPartialLog.valid_rows, 2);
    assert.equal(clientPartialLog.error_rows, 1);
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

    const clientFailedResponse = await applyClients({
      fileName: 'synthetic-client-failed.csv',
      rows: [{name: 'Synthetic Client Failed Batch', accountOwnerId: 'missing-owner'}],
    });
    assert.equal(clientFailedResponse.status, 200);
    const clientFailedBody = await clientFailedResponse.json();
    assert.equal(clientFailedBody.status, 'Failed');
    assert.equal(clientFailedBody.validRows, 0);
    assert.equal(clientFailedBody.errorRows, 1);
    const clientFailedBatch = await pool.query(`select l.status,count(a.id)::int as audit_rows
      from import_export_logs l left join audit_logs a on a.import_batch_id=l.id
      where l.id=$1 group by l.id`, [clientFailedBody.log.id]);
    assert.deepEqual(clientFailedBatch.rows, [{status: 'Failed', audit_rows: 0}],
      'a client batch with no saved rows must retain its failed result without success audit events');

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
    }], 'the real project apply route must preserve its row-error shape');
    const projectPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [projectPartialBody.log.id])).rows[0];
    assert.equal(projectPartialLog.id, projectPartialBody.log.id, 'project batch history must return its persisted server batch ID');
    assert.equal(projectPartialLog.status, 'Partial');
    assert.equal(projectPartialLog.total_rows, 2);
    assert.equal(projectPartialLog.valid_rows, 1);
    assert.equal(projectPartialLog.error_rows, 1);
    const projectPartialAudit = await pool.query(`select source,source_identifier,import_batch_id,import_processing_result,details
      from audit_logs where import_batch_id=$1`, [projectPartialBody.log.id]);
    assert.deepEqual(projectPartialAudit.rows, [{
      source: 'Project Master CSV',
      source_identifier: 'PROJECT-IMPORT-SOURCE-1',
      import_batch_id: projectPartialBody.log.id,
      import_processing_result: 'Success',
      details: 'Created project PROJECT-IMPORT-SOURCE-1 from synthetic-project-partial.csv',
    }], 'project row audits must retain required source code, result and shared batch linkage');

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

    await pool.query(`create sequence synthetic_project_import_race_barrier start with 1`);
    await pool.query(`create or replace function synchronize_synthetic_project_import_race()
      returns trigger language plpgsql as $$
      declare
        attempt integer := 0;
        arrivals_seen bigint;
      begin
        if new.project_code = 'PROJECT-IMPORT-CROSS-LEGAL-RACE' then
          perform nextval('synthetic_project_import_race_barrier');
          loop
            select last_value into arrivals_seen from synthetic_project_import_race_barrier;
            exit when arrivals_seen >= 2;
            attempt := attempt + 1;
            if attempt > 200 then raise exception 'second project import did not reach the overlap barrier'; end if;
            perform pg_sleep(0.01);
          end loop;
        end if;
        return new;
      end; $$`);
    await pool.query(`create trigger synchronize_synthetic_project_import_race
      before insert on projects for each row execute function synchronize_synthetic_project_import_race()`);
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
      'concurrent project-code imports across legal entities must commit one winner and reject one row');
    const projectRaceFailure = projectRaceBodies.find(body => body.status === 'Failed');
    assert.deepEqual(projectRaceFailure.errors, [{
      rowNumber: 2,
      field: 'projectCode',
      message: 'Project code belongs to another legal entity in this organization.',
      code: 'PROJECT_SCOPE_CONFLICT',
    }], 'a project-code loser at the database conflict boundary must receive the existing row-local scope error');
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
    }], 'the real allocation apply route must preserve its existing non-disclosing cross-legal error');
    const allocationPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [allocationPartialBody.log.id])).rows[0];
    assert.equal(allocationPartialLog.id, allocationPartialBody.log.id,
      'allocation batch history must return its persisted server batch ID');
    assert.equal(allocationPartialLog.status, 'Partial');
    assert.equal(allocationPartialLog.total_rows, 3);
    assert.equal(allocationPartialLog.valid_rows, 2);
    assert.equal(allocationPartialLog.error_rows, 1);
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
          status: 'Submitted',
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
          status: 'Submitted',
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
    }], 'a foreign legal-entity employee must remain a row-local timesheet import denial');
    const timesheetPartialLog = (await pool.query(`select * from import_export_logs where id=$1`, [timesheetPartialBody.log.id])).rows[0];
    assert.equal(timesheetPartialLog.id, timesheetPartialBody.log.id,
      'timesheet batch history must return its persisted server batch ID');
    assert.equal(timesheetPartialLog.status, 'Partial');
    assert.equal(timesheetPartialLog.total_rows, 4);
    assert.equal(timesheetPartialLog.valid_rows, 3,
      'the aggregate timesheet log must continue counting accepted input entries, not groups');
    assert.equal(timesheetPartialLog.error_rows, 1);
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
        details: 'Created Submitted timesheet for EMP-IMPORT-SUCCESS, week ending 2026-02-06 from synthetic-timesheet-partial.csv',
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
      {employee_id:'EMP-IMPORT-SUCCESS',week_ending:'2026-02-06',status:'Submitted',total_hours:'12',billable_hours:'8',entries:2},
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
    assert.equal(timesheetUpdateBody.status, 'Success', 'same-scope timesheet imports must retain their group upsert behavior');
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
    }], 'same-scope timesheet upserts must preserve the group ID while replacing its entries');
    const timesheetUpdateAudit = await pool.query(`select action,source,source_identifier,import_batch_id,import_processing_result
      from audit_logs where import_batch_id=$1`, [timesheetUpdateBody.log.id]);
    assert.deepEqual(timesheetUpdateAudit.rows, [{
      action: 'Import Update Timesheet',
      source: 'Timesheet Import CSV',
      source_identifier: null,
      import_batch_id: timesheetUpdateBody.log.id,
      import_processing_result: 'Success',
    }], 'same-scope timesheet group updates must preserve provenance and update audit behavior');

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
      message: 'Future week timesheets and future-dated entries cannot be imported.',
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
  });
}, {maxPoolSize: 1});

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
    // Recreate the merged main level through migration 032, then add an existing
    // audit row before exercising both additive PR-006 migrations.
    await client.query(`
      create table schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const baselineSql = await readFile(join(serverDir, 'schema.sql'), 'utf8');
    await client.query(baselineSql);
    await client.query('insert into schema_migrations (id) values ($1)', [manifest[0].id]);
    for (const migration of manifest.slice(1, -2)) {
      const sql = await readFile(join(serverDir, 'migrations', migration.file), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
    }
    await client.query(`insert into audit_logs (user_id,user_name,user_role,module,action,details)
      values ('legacy-actor','Legacy actor','Admin','Test','Before request IDs','existing audit evidence')`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const before = await pool.query('select count(*)::int as count from schema_migrations');
  const upgrade = await runMigrations({pool, rootDir: serverDir, logger: quietLogger});
  const after = await pool.query('select count(*)::int as count from schema_migrations');
  const candidateMigrations = manifest.slice(-2);
  assert.deepEqual(candidateMigrations.map(item => item.id), [
    '033_wos03_audit_operation_context',
    '034_wos03_employee_import_provenance',
  ], 'PR-006 adds only its two ordered audit migrations');
  assert.deepEqual(upgrade.applied, candidateMigrations.map(item => item.id),
    'upgrade from merged main applies both additive PR-006 audit migrations');
  assert.equal(upgrade.skipped.length, manifest.length - 2);
  assert.equal(after.rows[0].count, before.rows[0].count + 2, 'upgrade appends both migration ledger rows');
  const status = await getMigrationStatus(pool, {rootDir: serverDir});
  assert.equal(status.isCurrent, true);
  assert.deepEqual(status.legacyUnverifiedIds, manifest.slice(0, -2).map(item => item.id),
    'old migration rows without a recorded digest remain explicitly marked unverifiable');
  const ledger = await pool.query('select id, checksum from schema_migrations');
  const newMigrations = ledger.rows.filter(row => candidateMigrations.some(migration => migration.id === row.id));
  assert.equal(newMigrations.length, 2, 'both PR-006 migrations are ledgered');
  assert(newMigrations.every(row => /^[0-9a-f]{64}$/.test(row.checksum)),
    'each new migration records its actual SHA-256 checksum');
  assert(ledger.rows.filter(row => !candidateMigrations.some(migration => migration.id === row.id)).every(row => row.checksum === null),
    'upgrade must not invent historical checksums');
  const legacyAudit = await pool.query(`select correlation_id,operation_id,import_batch_id,source_identifier,import_processing_result from audit_logs
    where user_id='legacy-actor' and action='Before request IDs'`);
  assert.equal(legacyAudit.rowCount, 1);
  assert.equal(legacyAudit.rows[0].correlation_id, null, 'existing audit history must not receive invented correlation IDs');
  assert.equal(legacyAudit.rows[0].operation_id, null, 'existing audit history must not receive invented operation IDs');
  assert.equal(legacyAudit.rows[0].import_batch_id, null, 'existing audit history must not receive invented import batches');
  assert.equal(legacyAudit.rows[0].source_identifier, null, 'existing audit history must not receive invented source identifiers');
  assert.equal(legacyAudit.rows[0].import_processing_result, null, 'existing audit history must not receive invented import results');
});

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
