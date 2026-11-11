import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAdminMutation } from '../server/modules/identity-access/admin-mutation-authority.mjs';

// Contract doubles only. These tests do not establish PostgreSQL lock behavior.
const request = () => ({
  user: { sub: 'synthetic-user', activeRole: 'Admin', exp: 2000 },
  organizationScope: { organizationId: 'synthetic-org', legalEntityId: 'synthetic-entity' },
  headers: {},
});
const dbError = code => Object.assign(new Error('Synthetic database failure'), { code });

function harness(overrides = {}) {
  const state = {
    heldRole: true, role: [{ permission_key: 'settings.manage', enabled: true }], grants: [],
    scopes: [{ organization_id: 'synthetic-org', legal_entity_id: 'synthetic-entity', authority_expires_at: null,
      authority_date: '2026-11-11' }],
    now: 1000, currentDate: '2026-11-11', pending: [], persisted: [], ...overrides,
  };
  const calls = [];
  let released = false;
  let discarded;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('begin')) { if (state.beginError) throw state.beginError; return { rows: [] }; }
      if (sql.includes('pg_advisory_xact_lock')) {
        if (state.businessLockError) throw state.businessLockError;
        state.afterBusinessLock?.(state); return { rows: [] };
      }
      if (sql.startsWith('lock table')) {
        if (state.lockError) throw state.lockError;
        return { rows: [] };
      }
      if (sql.startsWith('select 1 from users')) {
        if (state.readError) throw state.readError;
        return { rows: state.heldRole ? [{}] : [] };
      }
      if (sql.startsWith('select permission_key, enabled')) return { rows: state.role };
      if (sql.startsWith('select permission_key from user_permission_grants')) return { rows: state.grants };
      if (sql.startsWith('with authority_clock')) return { rows: state.scopes };
      if (sql.includes('clock_timestamp')) return { rows: [{ authorized: state.now < values[0] && state.currentDate === values[1] }] };
      if (sql === 'synthetic write' || sql === 'synthetic audit') {
        state.pending.push(sql);
        if (sql === 'synthetic audit' && state.auditError) throw state.auditError;
        return { rows: [] };
      }
      if (sql === 'commit') {
        if (state.commitAppliedBeforeError) { state.persisted = [...state.pending]; state.pending = []; }
        if (state.commitError) throw state.commitError;
        state.persisted = [...state.pending]; state.pending = []; return { rows: [] };
      }
      if (sql === 'rollback') {
        state.pending = [];
        if (state.rollbackError) throw state.rollbackError;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in contract double: ${sql}`);
    },
    release(error) { assert.equal(released, false); released = true; discarded = error; },
  };
  const pool = { async connect() { return client; }, query() { throw new Error('Pool queries are forbidden'); } };
  const options = {
    pool, request: request(), businessLockKey: 'reporting-period:synthetic-org:synthetic-entity:Monthly',
    getDefaultPermissionsForRole: role => role === 'Admin' ? ['settings.manage'] : [],
    async mutate(db, actor) {
      assert.equal(db, client); assert(Object.isFrozen(actor));
      await db.query('synthetic write'); await db.query('synthetic audit');
      state.afterMutation?.(state);
      return 'saved';
    },
  };
  return { state, calls, options, client, run: () => runAdminMutation(options),
    get released() { return released; }, get discarded() { return discarded; } };
}

async function rejectsWithoutWrite(h, code = 'ADMIN_AUTHORITY_REVOKED') {
  await assert.rejects(h.run(), error => error.code === code);
  assert.equal(h.calls.some(c => c.sql === 'synthetic write'), false);
  assert.deepEqual(h.state.persisted, []);
  assert.equal(h.calls.at(-1).sql, 'rollback');
  assert.equal(h.released, true);
}

test('authority is rechecked after the business lock and kept through mutation/audit/commit', async () => {
  const h = harness(); assert.equal(await h.run(), 'saved');
  assert.equal(h.calls[0].sql, 'begin isolation level read committed');
  assert.match(h.calls[1].sql, /pg_advisory_xact_lock/);
  assert.match(h.calls[2].sql, /share row exclusive mode nowait$/);
  assert.equal(h.calls.at(-1).sql, 'commit');
  assert.deepEqual(h.state.persisted, ['synthetic write', 'synthetic audit']);
  assert.equal(h.released, true);
});

for (const [label, afterBusinessLock] of [
  ['role removal or disabled account', s => { s.heldRole = false; }],
  ['role permission removal', s => { s.role = [{ permission_key: 'settings.manage', enabled: false }]; }],
  ['scope removal or effective-date expiry', s => { s.scopes = []; }],
  ['new ambiguous default scope', s => { s.scopes.push({ organization_id: 'other', legal_entity_id: 'other' }); }],
  ['silent default-scope replacement', s => { s.scopes = [{ organization_id: 'other', legal_entity_id: 'other' }]; }],
  ['session expiry during business lock wait', s => { s.now = 2000; }],
]) test(`no write after simulated ${label} during business lock wait`, async () => {
  await rejectsWithoutWrite(harness({ afterBusinessLock }));
});

test('role defaults apply only when the entire configuration is absent', async () => {
  const allowed = harness({ role: [] }); assert.equal(await allowed.run(), 'saved');
  const denied = harness({ role: [{ permission_key: 'dashboard.view', enabled: true }] });
  await rejectsWithoutWrite(denied);
});
test('disabled settings row does not restore Admin default', async () => {
  await rejectsWithoutWrite(harness({ role: [{ permission_key: 'settings.manage', enabled: false }] }));
});
test('a direct grant still adds to a disabled role permission', async () => {
  const h = harness({ role: [{ permission_key: 'settings.manage', enabled: false }],
    grants: [{ permission_key: 'settings.manage' }] });
  assert.equal(await h.run(), 'saved');
});
test('removed direct grant cannot survive a business lock wait', async () => {
  const h = harness({ role: [{ permission_key: 'settings.manage', enabled: false }],
    grants: [{ permission_key: 'settings.manage' }], afterBusinessLock: s => { s.grants = []; } });
  await rejectsWithoutWrite(h);
});
test('direct grant does not substitute for a currently held active role', async () => {
  await rejectsWithoutWrite(harness({ heldRole: false, grants: [{ permission_key: 'settings.manage' }] }));
});
test('authority locks include the empty-set and self-mutation tables in a stable order', async () => {
  const h = harness(); await h.run();
  const tables = h.calls[2].sql.replace(/^lock table /, '').replace(/ in share row exclusive mode nowait$/, '').split(', ');
  assert.deepEqual(tables, [...tables].sort());
  assert.deepEqual(tables, ['legal_entities', 'legal_entity_profile_versions', 'organization_profile_versions',
    'organizations', 'role_permissions', 'roles', 'user_organization_scopes', 'user_permission_grants', 'user_roles', 'users']);
});
test('busy authority acquisition rolls back without waiting or retrying', async () => {
  const h = harness({ lockError: dbError('55P03') }); await rejectsWithoutWrite(h, 'ADMIN_AUTHORITY_BUSY');
  assert.equal(h.calls.filter(c => c.sql.startsWith('lock table')).length, 1);
});
test('missing authority schema fails closed instead of restoring defaults', async () => {
  await rejectsWithoutWrite(harness({ lockError: dbError('42P01') }), '42P01');
});
test('original requested headers and chosen scope are captured before any asynchronous wait', async () => {
  const h = harness();
  h.options.request.headers = { 'x-organization-id': ' synthetic-org ', 'x-legal-entity-id': ' synthetic-entity ' };
  h.state.afterBusinessLock = () => {
    h.options.request.user.activeRole = 'Employee';
    h.options.request.organizationScope.legalEntityId = 'attacker-entity';
    h.options.request.headers['x-legal-entity-id'] = 'attacker-entity';
  };
  await h.run();
  const scope = h.calls.find(c => c.sql.startsWith('with authority_clock'));
  assert.deepEqual(scope.values, ['synthetic-user', 'synthetic-org', 'synthetic-entity']);
  assert.deepEqual(h.calls.find(c => c.sql.startsWith('select 1 from users')).values, ['synthetic-user', 'Admin']);
});
test('scope query uses post-lock statement time, not transaction-start current_date', async () => {
  const h = harness(); await h.run();
  const sql = h.calls.find(c => c.sql.startsWith('with authority_clock')).sql;
  assert.match(sql, /statement_timestamp\(\)::date/); assert.doesNotMatch(sql, /current_date/);
  assert.match(sql, /least\(o.effective_to,lp.effective_to,lp.authority_effective_to\)/);
  assert.match(sql, /case when \$2::text='' or \$3::text='' then/);
  assert.match(sql, /\(t.today\+1\)::timestamp at time zone current_setting\('TimeZone'\)/);
});
test('implicit scope must be reloaded if a future scope can become active at midnight', async () => {
  const h = harness();
  // The double supplies SQL's conservative next-midnight bound. This does not
  // execute PostgreSQL date arithmetic or establish a real midnight race.
  h.state.scopes[0].authority_expires_at = 1500;
  h.state.afterMutation = s => { s.now = 1500; };
  await assert.rejects(h.run(), error => error.code === 'ADMIN_AUTHORITY_REVOKED');
  assert.deepEqual(h.state.persisted, []); assert.deepEqual(h.state.pending, []);
});
test('inclusive date authority expiry is checked before and after mutation', async () => {
  const h = harness(); h.state.scopes[0].authority_expires_at = '1500';
  h.state.afterMutation = s => { s.now = 1500; };
  await assert.rejects(h.run(), error => error.code === 'ADMIN_AUTHORITY_REVOKED');
  assert.deepEqual(h.state.persisted, []); assert.deepEqual(h.state.pending, []);
  assert.deepEqual(h.calls.filter(c => c.sql.includes('clock_timestamp')).map(c => c.values),
    [[1500, '2026-11-11'], [1500, '2026-11-11']]);
});
test('date transition fails closed even before an ambiguous converted-midnight deadline', async () => {
  const h = harness(); h.state.scopes[0].authority_expires_at = 1800;
  h.state.afterMutation = s => { s.now = 1500; s.currentDate = '2026-11-12'; };
  await assert.rejects(h.run(), error => error.code === 'ADMIN_AUTHORITY_REVOKED');
  assert.deepEqual(h.state.persisted, []);
  assert.match(h.calls.find(c => c.sql.includes('clock_timestamp')).sql, /checked_at::date = \$2::date/);
});
test('session expiry during mutation rolls back the pending write and audit', async () => {
  const h = harness({ afterMutation: s => { s.now = 2000; } });
  await assert.rejects(h.run(), error => error.code === 'ADMIN_AUTHORITY_REVOKED');
  assert.deepEqual(h.state.persisted, []); assert.deepEqual(h.state.pending, []);
});
test('invalid authority expiry fails closed', async () => {
  const h = harness(); h.state.scopes[0].authority_expires_at = 'invalid'; await rejectsWithoutWrite(h);
});
test('audit failure rolls back the write and propagates failure', async () => {
  const failure = new Error('Synthetic audit failure'); const h = harness({ auditError: failure });
  await assert.rejects(h.run(), error => error === failure);
  assert.deepEqual(h.state.persisted, []); assert.deepEqual(h.state.pending, []); assert.equal(h.released, true);
});
test('rollback failure discards the connection while preserving original failure', async () => {
  const auditError = new Error('Synthetic audit failure'); const rollbackError = new Error('Synthetic rollback failure');
  const h = harness({ auditError, rollbackError });
  await assert.rejects(h.run(), error => error === auditError); assert.equal(h.discarded, rollbackError);
});
test('lost commit acknowledgement is uncertain and never retried', async () => {
  const h = harness({ commitError: new Error('Synthetic lost acknowledgement') });
  await assert.rejects(h.run(), error => error.code === 'ADMIN_MUTATION_OUTCOME_UNKNOWN');
  assert.equal(h.calls.filter(c => c.sql === 'commit').length, 1);
  assert.equal(h.calls.some(c => c.sql === 'rollback'), false);
  assert(h.discarded); assert.equal(h.released, true);
});
test('a successful commit with a lost acknowledgement is not rolled back or retried', async () => {
  const h = harness({ commitAppliedBeforeError: true, commitError: new Error('Synthetic lost acknowledgement') });
  await assert.rejects(h.run(), error => error.code === 'ADMIN_MUTATION_OUTCOME_UNKNOWN');
  assert.deepEqual(h.state.persisted, ['synthetic write', 'synthetic audit']);
  assert.equal(h.calls.filter(c => c.sql === 'commit').length, 1);
  assert.equal(h.calls.some(c => c.sql === 'rollback'), false); assert(h.discarded);
});
test('failed BEGIN acknowledgement discards a potentially open transaction', async () => {
  const failure = new Error('Synthetic lost BEGIN acknowledgement'); const h = harness({ beginError: failure });
  await assert.rejects(h.run(), error => error === failure);
  assert.equal(h.discarded, failure); assert.equal(h.calls.length, 1); assert.equal(h.released, true);
});
for (const fault of ['businessLockError', 'readError']) test(`${fault} rolls back without writing`, async () => {
  const failure = new Error('Synthetic failure'); const h = harness({ [fault]: failure });
  await assert.rejects(h.run(), error => error === failure);
  assert.deepEqual(h.state.persisted, []); assert.equal(h.calls.at(-1).sql, 'rollback');
  assert.equal(h.calls.some(c => c.sql === 'synthetic write'), false); assert.equal(h.released, true);
});
test('missing captured scope date refuses before mutation', async () => {
  const h = harness(); delete h.state.scopes[0].authority_date; await rejectsWithoutWrite(h);
});
test('malformed identity is rejected before opening a connection', async () => {
  for (const field of ['sub', 'activeRole', 'exp']) {
    const h = harness(); delete h.options.request.user[field];
    await assert.rejects(h.run(), error => error.code === 'ADMIN_AUTHORITY_REVOKED');
    assert.deepEqual(h.calls, []);
  }
});
