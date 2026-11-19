import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
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
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const events = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedWorkApproval(pool),
    ids = fx.identities;
  await grantAmendmentPermissions(pool);
  const permissions = [
    'commercial.contracts.view',
    'commercial.contracts.manage',
    'commercial.milestone_billing.view',
    'commercial.milestone_billing.manage',
    'commercial.milestone_billing.decide',
    'approvals.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'commercial.invoice_drafts.prepare',
    'commercial.invoice_drafts.own',
    'commercial.invoice_drafts.cancel',
    'commercial.invoice_approval.manage',
    'commercial.invoice_approval.decide',
    'reports.export',
    'commercial.invoice_export.view',
    'commercial.invoice_export.create',
    'commercial.invoice_export.configure',
    'integrations.invoice_alert_routes.manage',
    'commercial.invoice_batch.confirm',
    'employees.view',
    'notifications.view',
  ];
  for (const permission of permissions)
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [permission],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request, baseUrl: apiUrl, tokenFor }) => {
      const end = shiftCapacityDate(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-MILESTONE', {
          contract: {
            model: 'milestone',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
      const milestone = ok(
        await request('/milestones', {
          method: 'POST',
          body: {
            engagementId: roots.engagement.id,
            code: 'SYN-MILESTONE-1',
            name: 'Synthetic delivery',
            dueOn: fx.today,
            amount: '125.1500',
            currency: 'USD',
            reason: 'Synthetic milestone',
          },
        }),
        201,
      );
      const route = '/api/v1/milestone-billing',
        initial = ok(await request(route + '/policies?engagementId=' + roots.engagement.id)),
        definition = {
          entityType: 'MilestoneBillingEligibility',
          engagementId: roots.engagement.id,
          evidenceKinds: ['INTERNAL_ASSERTION', 'CLIENT_EVIDENCE_ASSERTION'],
          stages: [
            { userId: ids.manager.id, role: 'Admin' },
            { userId: ids.second.id, role: 'Admin' },
          ],
          locale: 'en-US',
          templates: events.map((key) => ({
            key,
            subject: 'Review {{sourceRef}}',
            body: 'Stage {{stageNumber}}',
          })),
          completionInApp: false,
        };
      const policy = ok(
        await request(route + '/policies', {
          method: 'POST',
          body: {
            expectedOwnerKey: initial.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            expectedLatestId: null,
            effectiveFrom: fx.today,
            definition,
            reason: 'Synthetic policy',
          },
        }),
        201,
      ).policy;
      const requesterKey = await readApprovalOwner(request, ids.requester),
        evidence = [
          {
            kind: 'INTERNAL_ASSERTION',
            reference: 'Synthetic internal acceptance',
            url: 'https://example.test/internal',
          },
          {
            kind: 'CLIENT_EVIDENCE_ASSERTION',
            reference: 'Synthetic client evidence',
            url: 'https://example.test/client',
          },
        ],
        requestBody = {
          expectedOwnerKey: requesterKey,
          requestId: randomUUID(),
          milestoneId: milestone.id,
          expectedPolicyId: policy.id,
          ownerUserId: ids.requester.id,
          ownerRole: 'Admin',
          evidence,
          reason: 'Synthetic review',
        };
      assert.equal(
        (
          await request(route + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, evidence: evidence.slice(0, 1) },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from billing_eligibility_events where source_type='MILESTONE_ACCEPTANCE'",
          )
        ).rows[0].n,
        0,
      );
      await pool.query(
        "create function synthetic_milestone_recipient_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic recipient refusal' using errcode='MBE03';end$$;create trigger synthetic_milestone_recipient_failure before insert on milestone_billing_recipients for each row execute function synthetic_milestone_recipient_failure()",
      );
      assert.equal(
        (await request(route + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }))
          .status,
        409,
      );
      assert.equal(
        (await pool.query('select count(*)::int n from milestone_billing_instances')).rows[0].n,
        0,
      );
      await pool.query(
        'drop trigger synthetic_milestone_recipient_failure on milestone_billing_recipients;drop function synthetic_milestone_recipient_failure()',
      );
      const requestRace = await Promise.all([
        request(route + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }),
        request(route + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }),
      ]);
      assert.deepEqual(requestRace.map((r) => r.status).sort(), [200, 201]);
      const created = ok(
        requestRace.find((r) => r.status === 201),
        201,
      ).approval;
      assert.equal(created.state.status, 'Pending');
      assert.equal(
        ok(await request(route + '/requests', { method: 'POST', identity: ids.requester, body: requestBody }))
          .replayed,
        true,
      );
      const legacy = ok(await request('/api/approvals'));
      assert(!legacy.some((x) => x.entity_type === 'MilestoneBillingEligibilityApproval'));
      const compatibility = (
        await pool.query(
          "select id from approval_records where entity_type='MilestoneBillingEligibilityApproval' and entity_id=$1",
          [created.id],
        )
      ).rows[0];
      assert.equal(
        (
          await request('/api/approvals/' + compatibility.id + '/status', {
            method: 'PATCH',
            body: { status: 'Approved' },
          })
        ).status,
        404,
      );
      const decision = async (identity, sequence, decision = 'Approved', requestId = randomUUID()) =>
        request(route + '/instances/' + created.id + '/decisions', {
          method: 'POST',
          identity,
          body: {
            expectedOwnerKey: await readApprovalOwner(request, identity),
            requestId,
            expectedSequence: sequence,
            decision,
            reason: 'Synthetic decision',
          },
        });
      assert.equal((await decision(ids.requester, 0)).status, 409);
      const firstKey = randomUUID(),
        first = ok(await decision(ids.manager, 0, 'Approved', firstKey), 201);
      assert.equal(first.approval.state.status, 'Pending');
      assert.equal(first.eventId, null);
      assert.equal(ok(await decision(ids.manager, 0, 'Approved', firstKey)).replayed, true);
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from approved_unbilled_items where source_type='MILESTONE_ACCEPTANCE'",
          )
        ).rows[0].n,
        0,
      );
      const finalKey = randomUUID(),
        final = ok(await decision(ids.second, 1, 'Approved', finalKey), 201);
      assert.equal(final.approval.state.status, 'Approved');
      assert(final.eventId && final.itemId);
      assert.equal(ok(await decision(ids.second, 1, 'Approved', finalKey)).itemId, final.itemId);
      const register = ok(await request(route + '/register'));
      assert.equal(register.batchSupport, true);
      assert.equal(register.items.length, 1);
      assert.equal(register.items[0].id, final.itemId);
      assert.equal(register.items[0].evidence.milestoneId, milestone.id);
      assert.equal(register.items[0].currency, 'USD');
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from billing_eligibility_events where source_type='MILESTONE_ACCEPTANCE'",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        pool.query("update approved_unbilled_items set source_type='TM_SNAPSHOT' where id=$1", [
          final.itemId,
        ]),
        (e) => e.code === '55000',
      );
      assert.equal((await request(route + '/register', { identity: ids.reader })).status, 403);
      console.log('Milestone review, event and register verified.');
      const drafts = '/api/v1/invoice-drafts',
        invoiceApproval = '/api/v1/invoice-batch-approvals';
      const reportPath =
        drafts + '/reconciliation?' + new URLSearchParams({ engagementId: roots.engagement.id });
      const available = ok(await request(reportPath, { identity: ids.manager }));
      assert.equal(available.version, 'workos.milestone-reconciliation/1');
      assert.equal(available.items[0].milestoneId, milestone.id);
      assert.equal(available.items[0].status, 'AVAILABLE');
      assert.equal(available.exceptionCount, 0);
      const portfolioPath = (start, end, source) =>
        drafts + '/reconciliation/portfolio?' + new URLSearchParams({ start, end, source });
      const eligibleDate = available.items[0].eligibleOn;
      const portfolio = ok(
        await request(portfolioPath(eligibleDate, eligibleDate, 'both'), { identity: ids.manager }),
      );
      assert.deepEqual(portfolio.controls, available.controls);
      assert.deepEqual(portfolio.totals, available.totals);
      assert.deepEqual(
        ok(
          await request(portfolioPath(eligibleDate, eligibleDate, 'time_and_materials'), {
            identity: ids.manager,
          }),
        ).controls,
        [],
      );
      assert.deepEqual(
        ok(await request(portfolioPath('2000-01-01', '2000-01-01', 'milestone'), { identity: ids.manager }))
          .controls,
        [],
      );
      assert.equal(
        (await request(portfolioPath(eligibleDate, '2000-01-01', 'both'), { identity: ids.manager })).status,
        400,
      );

      const create = {
        expectedOwnerKey: initial.ownerKey,
        requestId: randomUUID(),
        definition: {
          clientId: roots.contract.clientId,
          contractId: roots.contract.id,
          engagementId: roots.engagement.id,
          currency: 'USD',
          periodStart: fx.today,
          periodEnd: fx.today,
          periodBasis: 'ELIGIBLE_DATE',
          ownerUserId: ids.manager.id,
          ownerRole: 'Admin',
        },
        reason: 'Synthetic invoice draft',
      };
      const uiDraft = ok(await request(drafts + '/batches', { method: 'POST', body: create }), 201);
      const vite = await startFixtureServer({
        root: fileURLToPath(new URL('../', import.meta.url)),
        fixtures: ['milestone-invoice-draft', 'milestone-invoice-confirmation', 'invoice-csv'],
        apiUrl,
      });
      let browser, context;
      try {
        const origin = vite.url;
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, timezoneId: 'UTC' });
        await context.addInitScript(
          ({ user, scope, token }) => {
            sessionStorage.setItem('workos_session', JSON.stringify(user));
            sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
            sessionStorage.setItem('workos_api_token', token);
          },
          {
            user: {
              id: ids.manager.id,
              employeeId: ids.manager.id,
              userName: ids.manager.username,
              role: 'Admin',
              permissionRole: 'Admin',
              permissions,
            },
            scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
            token: tokenFor(ids.manager),
          },
        );
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        const query = new URLSearchParams({
          engagement: roots.engagement.id,
          client: roots.contract.clientId,
          contract: roots.contract.id,
        });
        await page.goto(origin + '/tests/fixtures/milestone-invoice-draft.html?' + query);
        const ui = page.getByRole('region', { name: 'Invoice-ready draft batches' });
        await ui.getByRole('button', { name: 'Load drafts and available items' }).click();
        await ui.getByLabel('Invoice draft', { exact: true }).selectOption(uiDraft.batch.id);
        await ui.getByRole('button', { name: 'Inspect invoice draft' }).click();
        await ui.getByLabel('Available invoice item').selectOption('milestone:' + final.itemId);
        await ui.getByLabel('Invoice item reason').fill('Synthetic browser reservation');
        await ui.getByRole('button', { name: 'Reserve selected whole item' }).click();
        await ui
          .getByText('Operation recorded. Reload the current draft and register before another action.')
          .waitFor();
        await ui.getByRole('button', { name: 'Load drafts and available items' }).click();
        await ui.getByLabel('Invoice draft', { exact: true }).selectOption(uiDraft.batch.id);
        await ui.getByRole('button', { name: 'Inspect invoice draft' }).click();
        await ui.getByText(/Retained lines 1/).waitFor();
        await ui.getByText('Supporting evidence', { exact: true }).click();
        for (const assertion of evidence) {
          const link = ui.getByRole('link', { name: assertion.reference, exact: true });
          assert.equal(await link.getAttribute('href'), assertion.url);
          assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        }
        await ui.getByLabel('Invoice cancellation reason').fill('Synthetic browser cancellation');
        await ui.getByRole('button', { name: 'Cancel invoice Draft' }).click();
        await ui
          .getByText('Operation recorded. Reload the current draft and register before another action.')
          .waitFor();
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where item_id=$1', [
              final.itemId,
            ])
          ).rows[0].n,
          0,
        );

        console.log('Real React/API/PostgreSQL milestone reservation and cancellation verified.');
        const competitors = await Promise.all([
          request(drafts + '/batches', { method: 'POST', body: { ...create, requestId: randomUUID() } }),
          request(drafts + '/batches', { method: 'POST', body: { ...create, requestId: randomUUID() } }),
        ]);
        const candidates = competitors.map((x) => ok(x, 201));
        assert(candidates.every((x) => x.batch.sourceType === 'MILESTONE_ACCEPTANCE'));
        const commands = candidates.map((x) => ({
          expectedOwnerKey: x.ownerKey,
          requestId: randomUUID(),
          itemId: final.itemId,
          itemVersion: 1,
          expectedLineCount: 0,
          reason: 'Synthetic competing milestone reservation',
        }));
        const contested = await Promise.all(
          candidates.map((x, i) =>
            request(drafts + '/batches/' + x.batch.id + '/lines', { method: 'POST', body: commands[i] }),
          ),
        );
        assert.deepEqual(contested.map((x) => x.status).sort(), [201, 409]);
        const winner = contested.findIndex((x) => x.status === 201),
          draft = candidates[winner],
          acquire = commands[winner];
        assert.equal(
          ok(
            await request(drafts + '/batches/' + draft.batch.id + '/lines', {
              method: 'POST',
              body: acquire,
            }),
          ).replayed,
          true,
        );
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where item_id=$1', [
              final.itemId,
            ])
          ).rows[0].n,
          1,
        );
        const retained = ok(await request(drafts + '/batches/' + draft.batch.id));
        assert.equal(retained.lines[0].sourceType, 'MILESTONE_ACCEPTANCE');
        assert.equal(retained.lines[0].snapshotId, null);
        assert.equal(retained.total.amount, '125.15');
        console.log('Milestone draft, unique occupancy and replay verified.');
        const invoicePolicyDefinition = {
          entityType: 'InvoiceBatch',
          engagementId: roots.engagement.id,
          stages: [
            { userId: ids.manager.id, role: 'Admin' },
            { userId: ids.second.id, role: 'Admin' },
          ],
          locale: 'en-US',
          templates: events.map((key) => ({
            key,
            subject: 'Review {{sourceRef}}',
            body: 'Stage {{stageNumber}}',
          })),
          completionInApp: true,
        };
        const requesterInvoiceKey = await readApprovalOwner(request, ids.requester),
          invoicePolicy = ok(
            await request(invoiceApproval + '/policies', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: requesterInvoiceKey,
                requestId: randomUUID(),
                engagementId: roots.engagement.id,
                expectedLatestId: null,
                effectiveFrom: fx.today,
                definition: invoicePolicyDefinition,
                reason: 'Synthetic invoice approval policy',
              },
            }),
            201,
          ).policy;
        const invoiceSource = ok(
          await request(invoiceApproval + '/sources/' + draft.batch.id, { identity: ids.requester }),
        ).batch;
        assert.equal(invoiceSource.sourceType, 'MILESTONE_ACCEPTANCE');
        const submit = {
          expectedOwnerKey: requesterInvoiceKey,
          requestId: randomUUID(),
          batchId: draft.batch.id,
          expectedPolicyId: invoicePolicy.id,
          expectedLineCount: invoiceSource.lineCount,
          expectedLineageHash: invoiceSource.lineageHash,
          reason: 'Synthetic invoice review',
        };
        const firstReview = ok(
          await request(invoiceApproval + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: submit,
          }),
          201,
        ).approval;
        assert.equal(firstReview.state.status, 'Pending');
        assert.equal(
          ok(
            await request(invoiceApproval + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: submit,
            }),
          ).replayed,
          true,
        );
        const withdrawn = ok(
          await request(invoiceApproval + '/instances/' + firstReview.id + '/withdrawals', {
            method: 'POST',
            identity: ids.requester,
            body: {
              expectedOwnerKey: requesterInvoiceKey,
              requestId: randomUUID(),
              reason: 'Synthetic review withdrawal',
            },
          }),
          201,
        );
        assert.equal(withdrawn.approval.state.status, 'Cancelled');
        assert.equal(ok(await request(drafts + '/batches/' + draft.batch.id)).batch.state, 'Draft');
        assert.equal(
          (
            await pool.query('select count(*)::int n from invoice_draft_occupancies where item_id=$1', [
              final.itemId,
            ])
          ).rows[0].n,
          1,
        );
        const currentSource = ok(
            await request(invoiceApproval + '/sources/' + draft.batch.id, { identity: ids.requester }),
          ).batch,
          submitAgain = {
            ...submit,
            requestId: randomUUID(),
            expectedLineCount: currentSource.lineCount,
            expectedLineageHash: currentSource.lineageHash,
          },
          review = ok(
            await request(invoiceApproval + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: submitAgain,
            }),
            201,
          ).approval;
        const inbox = ok(await request('/api/v1/work-approvals/inbox', { identity: ids.manager })),
          notice = inbox.notifications.find(
            (x) => x.kind === 'invoice-batch-approval' && x.instanceId === review.id,
          );
        assert(notice);
        assert(
          ok(
            await request('/api/v1/work-approvals/inbox/' + notice.id + '/read', {
              method: 'POST',
              identity: ids.manager,
              body: { expectedOwnerKey: inbox.ownerKey },
            }),
          ).notification.readAt,
        );
        const managerView = ok(
            await request(invoiceApproval + '/instances/' + review.id, { identity: ids.manager }),
          ),
          stageCommand = {
            expectedOwnerKey: managerView.ownerKey,
            requestId: randomUUID(),
            expectedSequence: 0,
            decision: 'Approved',
            reason: 'Synthetic invoice decision',
          };
        await pool.query(
          "create function synthetic_invoice_recipient_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic recipient refusal' using errcode='IBA03';end$$;create trigger synthetic_invoice_recipient_failure before insert on invoice_batch_approval_recipients for each row execute function synthetic_invoice_recipient_failure()",
        );
        assert.equal(
          (
            await request(invoiceApproval + '/instances/' + review.id + '/decisions', {
              method: 'POST',
              identity: ids.manager,
              body: stageCommand,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await pool.query(
              'select count(*)::int n from invoice_batch_approval_transitions where instance_id=$1',
              [review.id],
            )
          ).rows[0].n,
          0,
        );
        await pool.query(
          'drop trigger synthetic_invoice_recipient_failure on invoice_batch_approval_recipients;drop function synthetic_invoice_recipient_failure()',
        );
        const decisions = await Promise.all([
          request(invoiceApproval + '/instances/' + review.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: stageCommand,
          }),
          request(invoiceApproval + '/instances/' + review.id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: stageCommand,
          }),
        ]);
        assert.deepEqual(decisions.map((x) => x.status).sort(), [200, 201]);
        assert.equal(ok(await request(drafts + '/batches/' + draft.batch.id)).batch.state, 'Under Review');
        const secondView = ok(
          await request(invoiceApproval + '/instances/' + review.id, { identity: ids.second }),
        );
        assert.equal(
          ok(
            await request(invoiceApproval + '/instances/' + review.id + '/decisions', {
              method: 'POST',
              identity: ids.second,
              body: {
                expectedOwnerKey: secondView.ownerKey,
                requestId: randomUUID(),
                expectedSequence: 1,
                decision: 'Approved',
                reason: 'Synthetic final invoice decision',
              },
            }),
            201,
          ).approval.state.status,
          'Approved',
        );
        console.log('Milestone invoice staged approval verified.');
        const config = '/api/v1/invoice-export-notice-config',
          configOwner = await readApprovalOwner(request, ids.manager),
          alert = ok(
            await request(config + '/routes', {
              identity: ids.manager,
              method: 'POST',
              body: {
                expectedOwnerKey: configOwner,
                requestId: randomUUID(),
                routeKey: randomUUID(),
                expectedLatestId: null,
                label: 'Synthetic internal alert',
                active: true,
                reason: 'Synthetic route',
              },
            }),
            201,
          ).route;
        const noticeDefinition = {
          entityType: 'InvoiceExport',
          engagementId: roots.engagement.id,
          financeOwner: { userId: ids.manager.id, role: 'Admin' },
          integrationAdmin: { userId: ids.second.id, role: 'Admin' },
          alertRouteId: alert.id,
          locale: 'en-US',
          templates: INVOICE_EXPORT_EVENT_KEYS.map((key) => ({
            key,
            subject: 'Invoice {{sourceRef}}',
            body: 'Synthetic status {{sourceRef}}',
          })),
          completionInApp: true,
        };
        ok(
          await request(config + '/policies', {
            identity: ids.manager,
            method: 'POST',
            body: {
              expectedOwnerKey: configOwner,
              requestId: randomUUID(),
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition: noticeDefinition,
              reason: 'Synthetic notice policy',
            },
          }),
          201,
        );
        const csv = '/api/v1/invoice-csv',
          inspection = ok(await request(csv + '/batches/' + draft.batch.id)),
          csvSource = inspection.batch;
        assert.equal(csvSource.sourceType, 'MILESTONE_ACCEPTANCE');
        assert.equal(csvSource.sourceCurrent, true);
        const exportCommand = {
          expectedOwnerKey: inspection.ownerKey,
          requestId: randomUUID(),
          batchId: draft.batch.id,
          approvalId: csvSource.approvalId,
          finalTransitionId: csvSource.finalTransitionId,
          lineageHash: csvSource.lineageHash,
          schemaVersion: 'workos.invoice-milestone-csv/1',
          expectedLineCount: csvSource.control.lineCount,
          expectedTotal: csvSource.control.total,
          reason: 'Synthetic invoice export',
        };
        const exports = await Promise.all([
          request(csv + '/exports', { method: 'POST', body: exportCommand }),
          request(csv + '/exports', { method: 'POST', body: exportCommand }),
        ]);
        assert.deepEqual(exports.map((x) => x.status).sort(), [200, 201]);
        const artifact = ok(
          exports.find((x) => x.status === 201),
          201,
        ).artifact;
        assert.equal(artifact.schemaVersion, 'workos.invoice-milestone-csv/1');
        const bytes = (
          await pool.query(
            "select payload,encode(digest(payload,'sha256'),'hex') hash from invoice_csv_artifacts where id=$1",
            [artifact.id],
          )
        ).rows[0];
        assert.deepEqual(Buffer.from(artifact.payloadBase64, 'base64'), bytes.payload);
        assert.equal(bytes.hash, artifact.sha256);
        const sqlBytes = (
          await pool.query(
            'select milestone_invoice_csv_bytes(b) payload from invoice_draft_batches b where b.id=$1',
            [draft.batch.id],
          )
        ).rows[0];
        assert.deepEqual(sqlBytes.payload, bytes.payload);
        const confirmSource = ok(await request(csv + '/confirmation-sources/' + draft.batch.id)).source;
        assert.equal(confirmSource.sourceType, 'MILESTONE_ACCEPTANCE');
        await page.goto(origin + '/tests/fixtures/milestone-invoice-confirmation.html?' + query);
        const confirmationUi = page.getByRole('region', { name: 'Invoice billing confirmation' });
        await confirmationUi.getByLabel('Invoice confirmation engagement').selectOption(roots.engagement.id);
        await confirmationUi.getByRole('button', { name: 'Load invoice confirmation batches' }).click();
        await confirmationUi.getByLabel('Invoice confirmation batch').selectOption(draft.batch.id);
        const inspected = page.waitForResponse((r) =>
          r.url().endsWith(csv + '/confirmation-sources/' + draft.batch.id),
        );
        await confirmationUi.getByRole('button', { name: 'Inspect exported invoice artifact' }).click();
        assert.equal((await (await inspected).json()).source.artifactSha256, artifact.sha256);
        await confirmationUi.getByLabel('Invoice confirmation reference').waitFor();
        const confirm = {
          expectedOwnerKey: inspection.ownerKey,
          requestId: randomUUID(),
          batchId: draft.batch.id,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          artifactSha256: artifact.sha256,
          currency: artifact.currency,
          total: artifact.total,
          reference: 'SYNTHETIC-REFERENCE',
          reason: 'Synthetic manual attestation',
        };
        assert.equal(
          (
            await request(csv + '/confirmations', {
              method: 'POST',
              body: { ...confirm, artifactSha256: 'b'.repeat(64) },
            })
          ).status,
          409,
        );
        const confirmations = await Promise.all([
          request(csv + '/confirmations', { method: 'POST', body: confirm }),
          request(csv + '/confirmations', { method: 'POST', body: confirm }),
        ]);
        assert.deepEqual(confirmations.map((x) => x.status).sort(), [200, 201]);
        assert.equal(
          ok(
            confirmations.find((x) => x.status === 201),
            201,
          ).confirmation.method,
          'MANUAL_ATTESTATION',
        );
        assert.deepEqual(
          (await pool.query('select payload from invoice_csv_artifacts where id=$1', [artifact.id])).rows[0]
            .payload,
          bytes.payload,
        );
        const reportExportPath = drafts + '/reconciliation/exports';
        const reportExportCommand = {
          engagementId: roots.engagement.id,
          expectedOwnerKey: available.ownerKey,
          expectedReportToken: available.reportToken,
          requestId: randomUUID(),
          reason: 'Synthetic control reconciliation',
        };
        assert.equal(
          (
            await request(reportExportPath, {
              method: 'POST',
              identity: ids.manager,
              body: reportExportCommand,
            })
          ).status,
          409,
        );
        await page.goto(origin + '/tests/fixtures/invoice-csv.html?' + query);
        const reconciliationUi = page.getByRole('region', { name: 'Billing reconciliation' });
        await reconciliationUi.getByLabel('Reconciliation engagement').selectOption(roots.engagement.id);
        const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === drafts + '/reconciliation');
        await reconciliationUi.getByRole('button', { name: 'Load billing reconciliation' }).click();
        const reconciled = await (await loaded).json();
        assert.equal(reconciled.exceptionCount, 0);
        const [row] = reconciled.items;
        assert.equal(row.artifactId, artifact.id);
        assert.equal(row.snapshotId, null);
        assert.equal(row.eligibilityApprovalId, created.id);
        assert.equal(row.eligibilityDecisionId, row.evidence.decisionId);
        assert.equal(row.history.length, 1);
        assert.equal(row.history[0].batchState, 'Cancelled');
        assert(row.controlOk);
        for (const boundary of [
          'EVENT_BACKED_SOURCE',
          'ELIGIBILITY_EVENT',
          'REGISTER_ITEM',
          'CURRENT_OCCUPANCY',
          'CURRENT_LINE',
          'EXPORTED_LINE',
          'MANUALLY_CONFIRMED_LINE',
          'HISTORICAL_RELEASED_LINE',
        ]) {
          const control = reconciled.controls.find(
            (x) => x.currency === row.currency && x.boundary === boundary,
          );
          assert.equal(control.lineCount, 1);
          assert.equal(control.amount, '125.15');
        }
        await reconciliationUi.getByLabel('Report export reason').fill('Synthetic reconciled milestone');
        const download = page.waitForEvent('download');
        const exported = page.waitForResponse((r) => new URL(r.url()).pathname === reportExportPath);
        await reconciliationUi.getByRole('button', { name: 'Download audited reconciliation CSV' }).click();
        const exportedResponse = await exported;
        assert.equal(exportedResponse.status(), 201);
        const artifactReport = await exportedResponse.json(),
          saved = await download;
        assert(saved.suggestedFilename().startsWith('milestone-billing-reconciliation-'));
        assert.equal(await readFile(await saved.path(), 'utf8'), artifactReport.csv);
        assert(artifactReport.csv.split('\r\n')[0].includes('milestone_id'));
        assert(artifactReport.csv.includes(milestone.id));
        assert.equal(
          (
            await pool.query(
              "select count(*)::int n from audit_logs where action='Export Milestone Billing Reconciliation' and entity_id=$1",
              [artifactReport.requestId],
            )
          ).rows[0].n,
          1,
        );
        const inboxPath = '/api/v1/work-approvals/inbox';
        const exportInbox = ok(await request(inboxPath, { identity: ids.manager }));
        const exportNotice = exportInbox.notifications.find(
          (n) => n.kind === 'invoice-export' && n.batchId === draft.batch.id,
        );
        assert(exportNotice);
        const secondRoots = await createAmendmentHierarchy(request, 'SYN-PORTFOLIO-SECOND', {
          contract: {
            model: 'milestone',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
        const engagementId = secondRoots.engagement.id;
        const secondMilestone = ok(
          await request('/milestones', {
            method: 'POST',
            body: {
              engagementId,
              code: 'SYN-PORTFOLIO-M2',
              name: 'Second portfolio delivery',
              dueOn: fx.today,
              amount: '25.0000',
              currency: 'USD',
              reason: 'Verify cross-engagement totals',
            },
          }),
          201,
        );
        const secondPolicy = ok(
          await request(route + '/policies', {
            method: 'POST',
            body: {
              expectedOwnerKey: initial.ownerKey,
              requestId: randomUUID(),
              engagementId,
              expectedLatestId: null,
              effectiveFrom: fx.today,
              definition: { ...definition, engagementId },
              reason: 'Scoped second engagement policy',
            },
          }),
          201,
        ).policy;
        const secondReview = ok(
          await request(route + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: {
              ...requestBody,
              requestId: randomUUID(),
              milestoneId: secondMilestone.id,
              expectedPolicyId: secondPolicy.id,
            },
          }),
          201,
        ).approval;
        for (const [expectedSequence, identity] of [ids.manager, ids.second].entries()) {
          ok(
            await request(route + '/instances/' + secondReview.id + '/decisions', {
              method: 'POST',
              identity,
              body: {
                expectedOwnerKey: await readApprovalOwner(request, identity),
                requestId: randomUUID(),
                expectedSequence,
                decision: 'Approved',
                reason: 'Synthetic portfolio approval',
              },
            }),
            201,
          );
        }
        const combined = ok(
          await request(portfolioPath(eligibleDate, eligibleDate, 'both'), { identity: ids.manager }),
        );
        assert.equal(combined.exceptionCount, 0);
        assert.deepEqual(
          combined.controls.find((x) => x.boundary === 'REGISTER_ITEM'),
          { currency: 'USD', boundary: 'REGISTER_ITEM', lineCount: 2, amount: '150.15' },
        );
        assert.equal(
          combined.controls.find((x) => x.boundary === 'MANUALLY_CONFIRMED_LINE').amount,
          '125.15',
        );
        await pool.query(
          "update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.milestone_billing.view'",
        );
        for (const path of [
          drafts + '/batches/' + draft.batch.id,
          invoiceApproval + '/sources/' + draft.batch.id,
          invoiceApproval + '/receipts/policy/' + invoicePolicy.requestId,
          csv + '/artifacts/' + artifact.id,
        ]) {
          assert.equal((await request(path, { identity: ids.requester })).status, 403, path);
        }
        assert(
          !ok(await request(drafts + '/batches', { identity: ids.manager })).batches.some(
            (b) => b.id === draft.batch.id,
          ),
        );
        assert.equal((await request(reportPath, { identity: ids.manager })).status, 403);
        assert.equal(
          (
            await request(reportExportPath, {
              method: 'POST',
              identity: ids.manager,
              body: { ...reportExportCommand, expectedReportToken: reconciled.reportToken },
            })
          ).status,
          403,
        );
        const afterLoss = ok(await request(inboxPath, { identity: ids.manager }));
        for (const n of [notice, exportNotice]) {
          assert(!afterLoss.notifications.some((row) => row.id === n.id));
          assert.equal(
            (
              await request(inboxPath + '/' + n.id + '/read', {
                method: 'POST',
                identity: ids.manager,
                body: { expectedOwnerKey: afterLoss.ownerKey },
              })
            ).status,
            404,
          );
        }
        console.log('Milestone export, immutable bytes and manual attestation verified.');
      } finally {
        await context?.close();
        await browser?.close();
        await vite.close();
      }
    },
  );
});
console.log('Scoped milestone evidence, staged decision and register journey passed.');
