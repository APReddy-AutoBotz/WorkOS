import assert from 'node:assert/strict';
import pg from 'pg';
import {readDisposablePostgresTarget} from './helpers/disposable-postgres-target.mjs';

const marker = 'synthetic-private-password-marker';
const valid = `postgresql://synthetic:${marker}@127.0.0.1:5432/postgres`;
assert.equal(readDisposablePostgresTarget(valid).hostname, '127.0.0.1');
assert.equal(readDisposablePostgresTarget('postgres://synthetic:synthetic@localhost/postgres').port, '5432');
assert.equal(readDisposablePostgresTarget('postgres://synthetic:synthetic@[::1]:5432/postgres').hostname, '[::1]');
const effective = new pg.Client({connectionString: `${valid}?host=remote.example.test`}).connectionParameters;
assert.equal(effective.host, 'remote.example.test', 'construction-only regression demonstrates the original URL authority bypass');
for (const raw of [undefined, '', `not a URL ${marker}`, `postgresql://synthetic:${marker}@[invalid/postgres`,
  `https://synthetic:${marker}@127.0.0.1/postgres`, `postgres://synthetic:${marker}@remote.example.test/postgres`,
  `${valid}?host=remote.example.test`, `${valid}?%68ost=remote.example.test`, `${valid}?hostaddr=192.0.2.1`,
  `${valid}?port=9999`, `${valid}?sslmode=disable`, `${valid}#${marker}`,
  'postgres://127.0.0.1/postgres', 'postgres://synthetic:synthetic@127.0.0.1/',
  'postgres://synthetic:%invalid@127.0.0.1/postgres']) {
  let caught;
  try { readDisposablePostgresTarget(raw); } catch (error) { caught = error; }
  assert(caught instanceof Error, 'unsafe fixture targets must fail before a connection exists');
  assert.equal(caught.message, 'A complete, query-free local PostgreSQL fixture URL is required.');
  assert.equal(caught.cause, undefined);
  assert.equal(caught.input, undefined);
  assert(!`${caught.stack}${JSON.stringify(caught)}`.includes(marker), 'sanitized errors must not retain the original URL/password');
}
console.log('Disposable PostgreSQL target guard passed: actual-driver host override rejected and malformed input sanitized; no connections opened.');
