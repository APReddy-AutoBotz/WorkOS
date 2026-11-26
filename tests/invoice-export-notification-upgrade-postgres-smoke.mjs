import {expectedMigrationsFrom, includeReleaseGrant} from './support/expected-migrations.mjs';
import {expectedMilestoneUpgradeSnapshot} from './support/milestone-upgrade-expectations.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../server/migrate.mjs';
import {
  commercialServerDir,
  withCommercialDatabase,
  migrateCommercialDatabase,
} from './support/commercial-drafting-test.mjs';
import { seedWorkApproval } from './support/work-approval-test.mjs';

await withCommercialDatabase(async ({ pool }) => {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-notice-084-upgrade-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(n) && n < '065j_wos06_invoice_export_notifications.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    await seedWorkApproval(pool);
    const tables = [
      'users',
      'user_roles',
      'user_organization_scopes',
      'role_permissions',
      'user_permission_grants',
      'invoice_draft_batches',
      'invoice_draft_lines',
      'invoice_draft_occupancies',
      'invoice_batch_approval_instances',
      'invoice_batch_approval_transitions',
      'audit_logs',
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            (await pool.query('select to_jsonb(t) v from ' + t + ' t order by to_jsonb(t)::text')).rows,
          ]),
        ),
      );
    const before = await snapshot(),
      keys = [
        'commercial.invoice_export.configure',
        'commercial.invoice_export.recover_notices',
        'integrations.invoice_alert_routes.manage', 'commercial.invoice_batch.confirm',
      ];
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
          [keys],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, expectedMigrationsFrom('065j_wos06_invoice_export_notifications'));
    await includeReleaseGrant(pool, before.role_permissions);
    assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from permission_definitions where permission_key=any($1::text[])',
          [keys],
        )
      ).rows[0].n,
      keys.length,
    );
    for (const t of [
      'invoice_alert_route_versions',
      'invoice_export_notice_policies',
      'invoice_export_notice_events',
      'invoice_export_notice_recipients',
      'invoice_export_notice_deliveries',
      'invoice_export_notice_reads',
      'invoice_export_alert_outbox',
      'invoice_export_notice_failures',
      'invoice_export_notice_producer_failures',
      'invoice_export_notice_recoveries',
    ])
      assert.equal((await pool.query('select count(*)::int n from ' + t)).rows[0].n, 0);
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from role_permissions where permission_key=any($1::text[])',
          [keys],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from user_permission_grants where permission_key=any($1::text[])',
          [keys],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied, []);
    assert.deepEqual(await snapshot(), expectedMilestoneUpgradeSnapshot(before));
    console.log('Invoice notification 084 upgrade and replay preserve prior records and grants.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
