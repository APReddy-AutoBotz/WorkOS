import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {assertSessionLifetime} from '../server/modules/identity-access/session-policy.mjs';
import {migrateCommercialDatabase, withCommercialDatabase} from './support/commercial-drafting-test.mjs';

await withCommercialDatabase(async ({pool}) => {
  await migrateCommercialDatabase(pool);
  await assert.rejects(assertSessionLifetime(pool, 3600000), /audited database policy/);
  const client = await pool.connect();
  const role = 'session_policy_test_' + randomBytes(8).toString('hex');
  try {
    await client.query('begin');
    await client.query(`create role ${role}`);
    await client.query(`set local role ${role}`);
    await client.query('savepoint denied');
    await assert.rejects(client.query('insert into deployment_session_policy(lifetime_ms) values(3600000)'), {code: '42501'});
    await client.query('rollback to denied');
    await client.query('reset role');
    await client.query(`grant select, insert(lifetime_ms), update(lifetime_ms) on deployment_session_policy to ${role}`);
    await client.query(`set local role ${role}`);
    await client.query('insert into deployment_session_policy(lifetime_ms) values(3600000)');
    await client.query('update deployment_session_policy set lifetime_ms=7200000');
    await client.query('update deployment_session_policy set lifetime_ms=7200000');
    await assertSessionLifetime(client, 7200000);
    await assert.rejects(assertSessionLifetime(client, 3600000), /audited database policy/);
    await client.query('reset role');
    const {rows} = await client.query(`select user_id=session_user actor_matches, active_role,
      old_value, new_value, organization_id, legal_entity_id, created_at from audit_logs
      where entity_type='DeploymentSessionPolicy' and action='SetSessionLifetime' order by old_value nulls first`);
    assert.deepEqual(rows.map(row => [row.old_value, row.new_value]), [
      [null, {lifetimeMs: 3600000}], [{lifetimeMs: 3600000}, {lifetimeMs: 7200000}],
    ]);
    assert.ok(rows.every(row => row.actor_matches && row.active_role === role && row.created_at instanceof Date
      && row.organization_id === null && row.legal_entity_id === null));
    for (const command of ['delete from deployment_session_policy', 'truncate deployment_session_policy']) {
      await client.query('savepoint retain');
      await assert.rejects(client.query(command), /must be retained/);
      await client.query('rollback to retain');
    }
    await client.query(`alter table audit_logs add constraint reject_policy_audit
      check (entity_type is distinct from 'DeploymentSessionPolicy') not valid`);
    await client.query('savepoint audit_failure');
    await assert.rejects(client.query('update deployment_session_policy set lifetime_ms=1'), {code: '23514'});
    await client.query('rollback to audit_failure');
    await assertSessionLifetime(client, 7200000);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
console.log('Verified authenticated session policy changes, access denial, retention and atomic audit failure.');
