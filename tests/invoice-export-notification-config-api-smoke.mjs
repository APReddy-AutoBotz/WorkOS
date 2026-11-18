import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedWorkApproval, readApprovalOwner } from './support/work-approval-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate } from '../shared/worker-capacity.mjs';
import { INVOICE_EXPORT_EVENT_KEYS } from '../shared/invoice-export-notification.mjs';
const ok = (x, n = 200) => {
  assert.equal(x.status, n, JSON.stringify(x.body));
  return x.body;
};
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedWorkApproval(pool),
    ids = fx.identities;
  await grantAmendmentPermissions(pool);
  for (const k of [
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'commercial.invoice_export.view',
    'commercial.invoice_export.configure',
    'integrations.invoice_alert_routes.manage',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request }) => {
      const end = shiftCapacityDate(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-NOTICE', {
          contract: {
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        }),
        base = '/api/v1/invoice-export-notice-config',
        owner = await readApprovalOwner(request, ids.manager),
        cmd = {
          expectedOwnerKey: owner,
          requestId: randomUUID(),
          routeKey: randomUUID(),
          expectedLatestId: null,
          label: 'Synthetic internal alert route',
          active: true,
          reason: 'Synthetic route configuration',
        };
      const created = ok(
        await request(base + '/routes', { identity: ids.manager, method: 'POST', body: cmd }),
        201,
      );
      assert.equal(created.route.routeKind, 'INTERNAL_OUTBOX');
      assert.equal(
        ok(await request(base + '/routes', { identity: ids.manager, method: 'POST', body: cmd })).replayed,
        true,
      );
      assert.equal(
        (
          await request(base + '/routes', {
            identity: ids.manager,
            method: 'POST',
            body: { ...cmd, label: 'Changed route' },
          })
        ).status,
        409,
      );
      assert.equal(
        ok(await request(base + '/route-receipts/' + cmd.requestId, { identity: ids.manager })).route.id,
        created.route.id,
      );
      assert.equal(
        (await request(base + '/route-receipts/' + cmd.requestId, { identity: ids.reader })).status,
        403,
      );
      const definition = {
          entityType: 'InvoiceExport',
          engagementId: roots.engagement.id,
          financeOwner: { userId: ids.manager.id, role: 'Admin' },
          integrationAdmin: { userId: ids.second.id, role: 'Admin' },
          alertRouteId: created.route.id,
          locale: 'en-US',
          templates: INVOICE_EXPORT_EVENT_KEYS.map((key) => ({
            key,
            subject: 'Invoice {{sourceRef}}',
            body: 'Synthetic status {{sourceRef}}',
          })),
          completionInApp: true,
        },
        policyCmd = {
          expectedOwnerKey: owner,
          requestId: randomUUID(),
          expectedLatestId: null,
          effectiveFrom: fx.today,
          definition,
          reason: 'Synthetic prospective notification policy',
        },
        policy = ok(
          await request(base + '/policies', { identity: ids.manager, method: 'POST', body: policyCmd }),
          201,
        );
      assert.equal(policy.policy.definition.engagementId, roots.engagement.id);
      assert.equal(policy.policy.effectiveFrom, fx.today);
      assert.equal(
        ok(await request(base + '/policies', { identity: ids.manager, method: 'POST', body: policyCmd }))
          .replayed,
        true,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            identity: ids.manager,
            method: 'POST',
            body: { ...policyCmd, reason: 'Changed reason' },
          })
        ).status,
        409,
      );
      assert.equal(
        ok(await request(base + '/policy-receipts/' + policyCmd.requestId, { identity: ids.manager })).policy
          .id,
        policy.policy.id,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            identity: ids.manager,
            method: 'POST',
            body: {
              ...policyCmd,
              requestId: randomUUID(),
              expectedLatestId: policy.policy.id,
              definition: { ...definition, integrationAdmin: { userId: ids.reader.id, role: 'Admin' } },
            },
          })
        ).status,
        403,
      );
      assert.equal(
        (await pool.query('select count(*)::int n from invoice_export_notice_events')).rows[0].n,
        0,
      );
      console.log(
        'Invoice notice explicit configuration real API/PostgreSQL guard, audit and replay passed.',
      );
    },
  );
});
