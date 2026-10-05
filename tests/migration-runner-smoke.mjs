import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
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
const withDisposableDatabase = async (test) => {
  const name = `workos_migration_smoke_${randomBytes(8).toString('hex')}`;
  const admin = new Client({connectionString: adminUrl.toString()});
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create database ${quoteIdentifier(name)}`);
    created = true;
    const databaseUrl = new URL(testDatabaseUrl);
    databaseUrl.pathname = `/${name}`;
    const pool = new Pool({connectionString: databaseUrl.toString(), max: 4});
    try {
      return await test(pool);
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
    // Recreate the ledger/schema shape written by the supported pre-PR-005
    // migration runner, then apply the exact published migration set.
    await client.query(`
      create table schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const baselineSql = await readFile(join(serverDir, 'schema.sql'), 'utf8');
    await client.query(baselineSql);
    await client.query('insert into schema_migrations (id) values ($1)', [manifest[0].id]);
    for (const migration of manifest.slice(1)) {
      const sql = await readFile(join(serverDir, 'migrations', migration.file), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
    }
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
  assert.deepEqual(upgrade.applied, [], 'upgrade from the current supported migration level is non-destructive');
  assert.equal(upgrade.skipped.length, manifest.length);
  assert.deepEqual(after.rows[0], before.rows[0], 'upgrade preserves the prior migration ledger');
  const status = await getMigrationStatus(pool, {rootDir: serverDir});
  assert.equal(status.isCurrent, true);
  assert.deepEqual(status.legacyUnverifiedIds, manifest.map(item => item.id),
    'old rows without a recorded digest remain explicitly marked unverifiable');
  const ledger = await pool.query('select id, checksum from schema_migrations');
  assert(ledger.rows.every(row => row.checksum === null), 'upgrade must not invent historical checksums');
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
