import assert from 'node:assert/strict';
import {runMigrations} from '../server/migrate.mjs';
import {withCommercialDatabase,withCommercialMigrationsThrough,migrateCommercialDatabase,seedCommercialReferences,seedCommercialLegacyWork} from './support/commercial-drafting-test.mjs';

const migration = '136_wos05_named_stage_delegation';
const sources = ['approval_delegations','role_permissions','work_approval_instances','assignment_approval_instances','leave_approval_instances','timesheets','timesheet_entries'];
async function snapshot(pool) {
  const rows = [];
  for (const table of sources) {
    rows.push((await pool.query('select to_jsonb(t) as row from '+table+' t order by to_jsonb(t)')).rows);
  }
  return rows;
}

await withCommercialDatabase(async ({pool}) => {
  await withCommercialMigrationsThrough(135,rootDir => runMigrations({pool,rootDir,logger:{log(){}}}));
  await seedCommercialReferences(pool);
  await seedCommercialLegacyWork(pool);
  const before = await snapshot(pool);
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[migration]);
  assert.deepEqual(await snapshot(pool),before);
  for (const table of ['canonical_delegations','canonical_delegation_bindings','canonical_delegation_decisions','canonical_delegation_revocations']) {
    assert.equal((await pool.query('select count(*)::int as n from '+table)).rows[0].n,0);
  }
  assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
});
console.log('Named-stage delegation populated upgrade and replay preserved work, permissions and earlier approval records.');
