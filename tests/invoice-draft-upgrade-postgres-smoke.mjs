import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../server/migrate.mjs';
import { commercialServerDir, withCommercialDatabase } from './support/commercial-drafting-test.mjs';
import { seedWorkApproval } from './support/work-approval-test.mjs';
await withCommercialDatabase(async ({ pool }) => {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-upgrade-disabled-diagnostic-'));
  try {
    await mkdir(join(dir, 'migrations'));
    await copyFile(join(commercialServerDir, 'schema.sql'), join(dir, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations')))
      if (/^\d{3}[a-z]?_.*\.sql$/.test(n) && n < '065g_wos06_invoice_draft_occupancy.sql')
        await copyFile(join(commercialServerDir, 'migrations', n), join(dir, 'migrations', n));
    await runMigrations({ pool, rootDir: dir, logger: { log() {} } });
    await seedWorkApproval(pool);
    const tables = [
        'users',
        'user_roles',
        'user_organization_scopes',
        'role_permissions',
        'user_permission_grants',
        'employees',
        'timesheets',
        'timesheet_entries',
        'work_submission_evidence',
        'work_submission_decisions',
        'commercial_rate_adoptions',
        'billing_eligibility_events',
        'approved_unbilled_items',
        'audit_logs',
      ],
      snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            tables.map(async (t) => [
              t,
              (await pool.query('select to_jsonb(t)v from ' + t + ' t order by to_jsonb(t)::text')).rows,
            ]),
          ),
        ),
      before = await snapshot(),
      defs = (
        await pool.query('select to_jsonb(x)v from permission_definitions x order by to_jsonb(x)::text')
      ).rows;
    const keys = [
      'commercial.invoice_drafts.view',
      'commercial.invoice_drafts.prepare',
      'commercial.invoice_drafts.own',
      'commercial.invoice_drafts.cancel',
    ];
    assert(!defs.some((x) => keys.includes(x.v.permission_key)));
    await copyFile(
      join(commercialServerDir, 'migrations/065g_wos06_invoice_draft_occupancy.sql'),
      join(dir, 'migrations/065g_wos06_invoice_draft_occupancy.sql'),
    );
    assert.deepEqual((await runMigrations({ pool, rootDir: dir, logger: { log() {} } })).applied, [
      '065g_wos06_invoice_draft_occupancy',
    ]);
    assert.deepEqual(await snapshot(), before);
    const after = (
      await pool.query('select to_jsonb(x)v from permission_definitions x order by to_jsonb(x)::text')
    ).rows;
    assert.deepEqual(
      after.filter((x) => !keys.includes(x.v.permission_key)),
      defs,
    );
    assert.deepEqual(
      after
        .filter((x) => keys.includes(x.v.permission_key))
        .map((x) => x.v.permission_key)
        .sort(),
      [...keys].sort(),
    );
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
    for (const t of [
      'invoice_draft_batches',
      'invoice_draft_lines',
      'invoice_draft_occupancies',
      'invoice_draft_cancellations',
      'invoice_draft_owner_losses',
    ])
      assert.equal((await pool.query('select count(*)::int n from ' + t)).rows[0].n, 0);
    assert.deepEqual((await runMigrations({ pool, rootDir: dir, logger: { log() {} } })).applied, []);
    assert.deepEqual(await snapshot(), before);
    console.log('populated 081 upgrade and replay preserve existing data, permissions and grants.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
