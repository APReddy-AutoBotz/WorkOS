import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const {Pool} = pg;
const serverDir = dirname(fileURLToPath(import.meta.url));
export const BASELINE_MIGRATION_ID = '005_auth_lifecycle';

// A stable transaction-scoped lock serializes fresh installs, upgrades and
// concurrent release jobs that target the same database.
const MIGRATION_LOCK_NAMESPACE = 20261005;
const MIGRATION_LOCK_ID = 320032;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const SAFE_MIGRATION_ERROR_CODES = new Set([
  'INVALID_ENVIRONMENT',
  'MIGRATION_CHECKSUM_MISMATCH',
  'UNKNOWN_MIGRATION_LEDGER_ENTRY',
  'MIGRATION_FAILED',
]);

export const formatSafeMigrationFailure = (error) => {
  if (SAFE_MIGRATION_ERROR_CODES.has(error?.code)) return String(error.message || 'Migration failed.');
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? ` (${error.code})`
    : '';
  return `database or migration failure${code}`;
};

const readMigrationFiles = async (migrationsDir) => {
  const entries = await readdir(migrationsDir, {withFileTypes: true});
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort();

  const invalid = files.filter(file => !/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(file));
  if (invalid.length > 0) throw new Error(`Invalid migration filename(s): ${invalid.join(', ')}`);

  const ids = files.map(file => file.slice(0, -4));
  if (new Set(ids).size !== ids.length) throw new Error('Migration filenames must have unique IDs.');
  return files;
};

export const getMigrationManifest = async ({rootDir = serverDir} = {}) => {
  const migrationsDir = join(rootDir, 'migrations');
  const files = await readMigrationFiles(migrationsDir);
  return [
    {id: BASELINE_MIGRATION_ID, file: 'schema.sql', baseline: true},
    ...files.map(file => ({id: file.slice(0, -4), file, baseline: false})),
  ];
};

export const getMigrationStatus = async (pool, {rootDir = serverDir} = {}) => {
  const expected = await getMigrationManifest({rootDir});
  const result = await pool.query('select id, checksum from schema_migrations');
  const byId = new Map(result.rows.map(row => [row.id, row.checksum || null]));
  const expectedIds = expected.map(item => item.id);
  const unknownIds = [...byId.keys()].filter(id => !expectedIds.includes(id));
  const appliedIds = expectedIds.filter(id => byId.has(id));
  const pendingIds = expectedIds.filter(id => !byId.has(id));
  const legacyUnverifiedIds = appliedIds.filter(id => byId.get(id) === null);
  let currentVersion = null;
  for (const id of expectedIds) {
    if (!byId.has(id)) break;
    currentVersion = id;
  }
  return {
    expectedIds,
    appliedIds,
    pendingIds,
    unknownIds,
    legacyUnverifiedIds,
    currentVersion,
    isCurrent: pendingIds.length === 0 && unknownIds.length === 0,
  };
};

export const runMigrations = async ({
  databaseUrl = process.env.DATABASE_URL,
  sslMode = process.env.PGSSLMODE,
  pool: suppliedPool,
  rootDir = serverDir,
  logger = console,
} = {}) => {
  if (!suppliedPool && !databaseUrl) throw new Error('DATABASE_URL is required to run database migrations.');

  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    ssl: sslMode === 'require' ? {rejectUnauthorized: false} : undefined,
  });
  const ownsPool = !suppliedPool;
  let client;
  let transactionOpen = false;
  const applied = [];
  const skipped = [];

  try {
    client = await pool.connect();
    await client.query('begin');
    transactionOpen = true;
    await client.query('select pg_advisory_xact_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now(),
        checksum text
      )
    `);
    await client.query('alter table schema_migrations add column if not exists checksum text');

    const manifest = await getMigrationManifest({rootDir});
    const expectedIds = new Set(manifest.map(item => item.id));
    const ledgerEntries = await client.query('select id from schema_migrations');
    const unknownIds = ledgerEntries.rows.map(row => row.id).filter(id => !expectedIds.has(id));
    if (unknownIds.length > 0) {
      const error = new Error('Migration ledger contains unsupported migration entries.');
      error.code = 'UNKNOWN_MIGRATION_LEDGER_ENTRY';
      error.entryCount = unknownIds.length;
      throw error;
    }

    const baselineSql = await readFile(join(rootDir, 'schema.sql'), 'utf8');
    const baselineChecksum = sha256(baselineSql);
    const baseline = await client.query('select checksum from schema_migrations where id = $1', [BASELINE_MIGRATION_ID]);
    if (baseline.rowCount === 0) {
      try {
        await client.query(baselineSql);
        await client.query(
          'insert into schema_migrations (id, checksum) values ($1, $2)',
          [BASELINE_MIGRATION_ID, baselineChecksum],
        );
      } catch (cause) {
        const error = new Error(`Migration ${BASELINE_MIGRATION_ID} failed.`);
        error.code = 'MIGRATION_FAILED';
        error.cause = cause;
        throw error;
      }
      applied.push(BASELINE_MIGRATION_ID);
      logger.log?.(`Applied migration ${BASELINE_MIGRATION_ID}`);
    } else {
      const recordedChecksum = baseline.rows[0].checksum;
      if (recordedChecksum && recordedChecksum !== baselineChecksum) {
        const error = new Error(`Migration checksum mismatch for ${BASELINE_MIGRATION_ID}.`);
        error.code = 'MIGRATION_CHECKSUM_MISMATCH';
        throw error;
      }
      skipped.push(BASELINE_MIGRATION_ID);
      logger.log?.(`Migration ${BASELINE_MIGRATION_ID} already applied`);
    }

    const migrationsDir = join(rootDir, 'migrations');
    for (const migration of manifest.slice(1)) {
      const {id, file} = migration;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = sha256(sql);
      const existing = await client.query('select checksum from schema_migrations where id = $1', [id]);
      if (existing.rowCount > 0) {
        const recordedChecksum = existing.rows[0].checksum;
        if (recordedChecksum && recordedChecksum !== checksum) {
          const error = new Error(`Migration checksum mismatch for ${id}.`);
          error.code = 'MIGRATION_CHECKSUM_MISMATCH';
          throw error;
        }
        skipped.push(id);
        logger.log?.(`Migration ${id} already applied`);
        continue;
      }

      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (id, checksum) values ($1, $2)', [id, checksum]);
      } catch (cause) {
        const error = new Error(`Migration ${id} failed.`);
        error.code = 'MIGRATION_FAILED';
        error.cause = cause;
        throw error;
      }
      applied.push(id);
      logger.log?.(`Applied migration ${id}`);
    }

    await client.query('commit');
    transactionOpen = false;
    return {applied, skipped, status: await getMigrationStatus(pool, {rootDir})};
  } catch (error) {
    if (transactionOpen) await client?.query('rollback').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (ownsPool) await pool.end();
  }
};
