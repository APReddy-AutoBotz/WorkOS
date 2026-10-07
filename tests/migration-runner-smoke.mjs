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

const withEmployeeImportApi = async (databaseUrl, actorId, test) => {
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
        throw new Error(`Employee-import API exited before listening: ${output}`);
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
    assert.equal(ready, true, `employee-import API must start for its PostgreSQL contract test: ${output}`);
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

  // Exercise the real route as a signed user with an explicit organization scope and imports.manage grant.
  await withEmployeeImportApi(databaseUrl, actorId, async ({baseUrl, token}) => {
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
