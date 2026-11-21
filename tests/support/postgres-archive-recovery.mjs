import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  migrateCommercialDatabase, withCommercialDatabase,
} from './commercial-drafting-test.mjs';

const execute = promisify(execFile);

async function postgresTool(command, databaseUrl, args) {
  const url = new URL(databaseUrl);
  await execute(command, args, {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGCONNECT_TIMEOUT: '10', PGCLIENTENCODING: 'UTF8',
    },
    windowsHide: true,
  });
}

async function contents(pool) {
  const tables = await pool.query("select tablename,quote_ident(tablename) name from pg_tables where schemaname='public' order by tablename");
  const result = {};
  for (const table of tables.rows) {
    // The rehearsal uses a small synthetic database. Capture only counts and fingerprints.
    const {rows} = await pool.query(`select count(*)::int count,
      encode(digest(coalesce(string_agg(to_jsonb(t)::text, E'\\n' order by to_jsonb(t)::text collate "C"),''),'sha256'),'hex') checksum
      from public.${table.name} t`);
    result[table.tablename] = rows[0];
  }
  return result;
}

export async function verifyRestoredArchive(source, label, verify) {
  const expected = await contents(source.pool);
  assert.ok(expected.schema_migrations.count && expected.audit_logs.count && expected.users.count);
  const directory = await mkdtemp(join(tmpdir(),'workos-restore-'));
  const archive = join(directory,'rehearsal.dump');
  try {
    const snapshotStarted = performance.now();
    await postgresTool('pg_dump',source.databaseUrl,['--format=custom','--file',archive,'--no-password']);
    const incident = performance.now();
    await withCommercialDatabase(async target => {
      await postgresTool('pg_restore',target.databaseUrl,['--dbname',new URL(target.databaseUrl).pathname.slice(1),
        '--single-transaction','--exit-on-error','--no-password',archive]);
      assert.deepEqual(await contents(target.pool),expected,'Restored public table contents must match the source');
      const migration = await migrateCommercialDatabase(target.pool);
      assert.deepEqual(migration.applied,[]);
      await verify(target, expected);
      const recoveryPointAgeMs = Math.ceil(incident - snapshotStarted);
      const recoveryTimeMs = Math.ceil(performance.now() - incident);
      assert.ok(recoveryPointAgeMs <= 24 * 60 * 60 * 1000,'Synthetic recovery point exceeded 24 hours');
      assert.ok(recoveryTimeMs <= 8 * 60 * 60 * 1000,'Synthetic recovery took more than 8 hours');
      const result = `${label}: ${Object.keys(expected).length} public tables, ${expected.schema_migrations.count} migrations, archive snapshot age ${recoveryPointAgeMs} ms, isolated recovery and verification ${recoveryTimeMs} ms.`;
      console.log(result);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result + '\n\n');
    });
  } finally {
    await rm(archive,{force:true});
    await rmdir(directory);
  }
}
