import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  commercialFixture, migrateCommercialDatabase, seedCommercialIdentities, seedCommercialReferences,
  withCommercialApi, withCommercialDatabase,
} from './support/commercial-drafting-test.mjs';

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

await withCommercialDatabase(async source => {
  await migrateCommercialDatabase(source.pool);
  await seedCommercialReferences(source.pool);
  const identities = await seedCommercialIdentities(source.pool);
  const input = {
    number: 'SYN-RESTORE', name: 'Restore rehearsal', clientId: commercialFixture.clientId,
    model: 'time_and_materials', currency: 'GBP', value: '23456.7891',
    startsOn: '2020-01-01', effectiveFrom: '2020-01-01', endsOn: '2099-12-31',
    billingTerms: 'Synthetic terms', documents: [], reason: 'Exercise commercial backup recovery',
  };
  let contractId;
  await withCommercialApi({...source, identities}, async ({request}) => {
    const saved = await request('/contracts', {method:'POST', body:input});
    assert.equal(saved.status,201);
    contractId = saved.body.id;
  });
  const expected = await contents(source.pool);
  assert.ok(expected.schema_migrations.count && expected.audit_logs.count && expected.users.count);
  const directory = await mkdtemp(join(tmpdir(),'workos-restore-'));
  const archive = join(directory,'rehearsal.dump');
  try {
    await postgresTool('pg_dump',source.databaseUrl,['--format=custom','--file',archive,'--no-password']);
    await withCommercialDatabase(async target => {
      await postgresTool('pg_restore',target.databaseUrl,['--dbname',new URL(target.databaseUrl).pathname.slice(1),
        '--single-transaction','--exit-on-error','--no-password',archive]);
      assert.deepEqual(await contents(target.pool),expected,'Restored public table contents must match the source');
      const migration = await migrateCommercialDatabase(target.pool);
      assert.deepEqual(migration.applied,[]);
      await withCommercialApi({...target, identities}, async ({request}) => {
        const read = await request('/contracts/'+contractId,{identity:identities.reader});
        assert.equal(read.status,200);
        assert.equal(read.body.versions[0].value,input.value);
        assert.equal((await request('/workspace',{identity:identities.denied})).status,403);
        assert.equal((await request('/workspace',{identity:identities.reader,scope:{
          organizationId:commercialFixture.organizationId,legalEntityId:commercialFixture.otherLegalEntityId,
        }})).status,403);
        const created = await request('/contracts', {
          method: 'POST', body: {...input, number: 'SYN-RECOVERED', name: 'After recovery'},
        });
        assert.equal(created.status, 201);
        assert.notEqual(created.body.id, contractId);
        const audit = await target.pool.query('select count(*)::int count from public.audit_logs');
        assert.ok(audit.rows[0].count > expected.audit_logs.count);
      });
      console.log(`Restored ${Object.keys(expected).length} public tables and ${expected.schema_migrations.count} migrations. Commercial value, audit data, scoped API checks and audited writes passed.`);
    });
  } finally {
    await rm(archive,{force:true});
    await rmdir(directory);
  }
});
