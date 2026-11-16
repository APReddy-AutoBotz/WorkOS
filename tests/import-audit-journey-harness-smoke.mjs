import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {localDatabaseUrl, signJourneySession} from './support/import-audit-journey.mjs';

for (const host of ['localhost', '127.0.0.1', 'postgres', '[::1]']) {
  assert.equal(localDatabaseUrl(`postgresql://${host}:5432/postgres`).hostname, host);
}
for (const value of [undefined, '', 'https://localhost/db', 'postgresql://database.example.test/db',
  'postgresql://127.0.0.1.example.test/db', 'postgresql://localhost/db?host=database.example.test',
  'postgresql://localhost/db?dbname=another', 'postgresql://localhost/db#fragment']) {
  assert.throws(() => localDatabaseUrl(value));
}
const payload = {sub: 'synthetic-account', username: 'synthetic-named-producer', activeRole: 'Admin', exp: 123};
const [body, signature] = signJourneySession(payload, 'synthetic-unit-test-secret').split('.');
const {sid, ...claims} = JSON.parse(Buffer.from(body, 'base64url'));
assert.match(sid, /^[a-f0-9-]{36}$/);
assert.deepEqual(claims, payload);
const legacy = signJourneySession({...payload, sid: undefined}, 'synthetic-unit-test-secret');
assert.equal(JSON.parse(Buffer.from(legacy.split('.')[0], 'base64url')).sid, undefined, 'legacy negatives must explicitly omit session identity');
assert.equal(signature, createHmac('sha256', 'synthetic-unit-test-secret').update(body).digest('base64url'));
console.log('Import/audit harness local-database guards and synthetic session format passed (no database/browser started).');
