import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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
  for (const permission of [
    'commercial.milestone_billing.view',
    'commercial.milestone_billing.manage',
    'commercial.milestone_billing.decide',
    'approvals.view',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [permission],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request, baseUrl, tokenFor }) => {
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
      assert.equal(
        (
          await request(route + '/requests', {
            method: 'POST',
            identity: ids.requester,
            body: { ...requestBody, ownerUserId: ids.manager.id },
          })
        ).status,
        409,
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
      await pool.query(
        "insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency) values('synthetic-eligibility-fiscal',$1,$2,'FIN','Synthetic fiscal period',$3,$3,'Planned','Fiscal')",
        [f.organizationId, f.legalEntityId, fx.today],
      );
      const blockedDecision = await decision(ids.second, 1);
      assert.equal(blockedDecision.status, 409);
      assert.equal(blockedDecision.body.error.code, 'BILLING_ELIGIBILITY_PERIOD_CLOSED');
      assert.equal((await pool.query('select count(*)::int n from billing_eligibility_events')).rows[0].n, 0);
      await pool.query("update reporting_periods set status='Open' where id='synthetic-eligibility-fiscal'");
      const fixture = await startFixtureServer({
        root: fileURLToPath(new URL('../', import.meta.url)),
        fixtures: ['milestone-review'],
        apiUrl: baseUrl,
      });
      let browser, finalKey, final;
      try {
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.addInitScript(
          ({ user, scope, token }) => {
            sessionStorage.setItem('workos_session', JSON.stringify(user));
            sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
            sessionStorage.setItem('workos_api_token', token);
          },
          {
            user: {
              id: ids.second.id,
              employeeId: ids.second.id,
              role: 'Admin',
              permissionRole: 'Admin',
              userName: ids.second.username,
              name: 'Synthetic reviewer',
              permissions: [
                'commercial.contracts.view',
                'commercial.contracts.manage',
                'commercial.milestone_billing.manage',
                'employees.view',
                'notifications.view',
                'approvals.view',
                'approvals.decide',
                'commercial.milestone_billing.view',
                'commercial.milestone_billing.decide',
              ],
            },
            scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
            token: tokenFor(ids.second),
          },
        );
        await page.goto(
          fixture.url +
            '/tests/fixtures/milestone-review.html?' +
            new URLSearchParams({ engagement: roots.engagement.id }),
        );
        await page.getByLabel('Milestone billing engagement').selectOption(roots.engagement.id);
        await page.getByRole('button', { name: 'Load milestone billing reviews' }).click();
        await page.getByLabel('Milestone billing review', { exact: true }).selectOption(created.id);
        await page.getByRole('button', { name: 'Inspect milestone review' }).click();
        await page.getByLabel('Milestone billing decision').selectOption('Approved');
        await page.getByLabel('Milestone decision reason').fill('Synthetic decision');
        const decided = page.waitForResponse(
          (r) => r.url().endsWith('/decisions') && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Record milestone decision' }).click();
        const response = await decided;
        assert.equal(response.status(), 201);
        finalKey = response.request().postDataJSON().requestId;
        final = await response.json();
        await page.getByRole('button', { name: /Load milestone.*register/i }).click();
        await page
          .getByRole('region', { name: 'Milestone approved-unbilled register' })
          .getByText(new RegExp(final.eventId))
          .waitFor();
        assert.equal(final.approval.state.status, 'Approved');
        assert(final.eventId && final.itemId);
        await pool.query("update reporting_periods set status='Closed' where id='synthetic-eligibility-fiscal'");
        assert.equal(ok(await decision(ids.second, 1, 'Approved', finalKey)).itemId, final.itemId);
        await pool.query("delete from reporting_periods where id='synthetic-eligibility-fiscal'");
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
        assert.deepEqual(ok(await request(route + '/register?engagementId=another-engagement')).items, []);
        assert.equal(
          (
            await request(route + '/instances/' + created.id, {
              identity: ids.requester,
              scope: { organizationId: f.organizationId, legalEntityId: f.foreignLegalEntityId },
            })
          ).status,
          403,
        );
        const inbox = '/api/v1/work-approvals/inbox';
        const another = async (code, expectedPolicyId = policy.id) => {
          const m = ok(
            await request('/milestones', {
              method: 'POST',
              body: {
                engagementId: roots.engagement.id,
                code,
                name: 'Synthetic delivery',
                dueOn: fx.today,
                amount: '42.0000',
                currency: 'USD',
                reason: 'Synthetic milestone',
              },
            }),
            201,
          );
          return ok(
            await request(route + '/requests', {
              method: 'POST',
              identity: ids.requester,
              body: { ...requestBody, milestoneId: m.id, expectedPolicyId, requestId: randomUUID() },
            }),
            201,
          ).approval;
        };
        const firstDecision = (id, decision) =>
          request(route + '/instances/' + id + '/decisions', {
            method: 'POST',
            identity: ids.manager,
            body: {
              expectedOwnerKey: managerKey,
              requestId: randomUUID(),
              expectedSequence: 0,
              decision,
              reason: 'Synthetic independent decision',
            },
          });
        const managerKey = await readApprovalOwner(request, ids.manager);
        const declined = await another('SYN-MILESTONE-2');
        assert.equal(ok(await firstDecision(declined.id, 'Rejected'), 201).approval.state.status, 'Rejected');
        const cancellable = await another('SYN-CANCEL-STAGE');
        const inspectCancellation = async () => {
          await page.getByRole('button', { name: 'Load milestone billing reviews' }).click();
          await page.getByLabel('Milestone billing review', { exact: true }).selectOption(cancellable.id);
          await page.getByRole('button', { name: 'Inspect milestone review' }).click();
        };
        await inspectCancellation();
        const reason = page.getByLabel('Milestone cancellation reason');
        await reason.fill('Synthetic initial-stage draft');
        ok(await firstDecision(cancellable.id, 'Approved'), 201);
        const cancelPath = route + '/instances/' + cancellable.id + '/cancellations';
        const unpinned = await request(cancelPath, { method: 'POST', identity: ids.manager,
          body: { expectedOwnerKey: managerKey, requestId: randomUUID(), reason: 'Synthetic earlier client' } });
        assert.equal(unpinned.status, 409);
        assert.equal(unpinned.body.error.code, 'MILESTONE_BILLING_STAGE_CHANGED');
        const refused = page.waitForResponse(r => r.url().endsWith(cancelPath));
        await page.getByRole('button', { name: 'Cancel milestone review' }).click();
        assert.equal((await refused).status(), 409);
        await page.getByText(/The milestone review stage changed/).waitFor();
        await inspectCancellation();
        await page.getByText(/Completed decisions: 1/).waitFor();
        assert.equal(await reason.inputValue(), '');
        await reason.fill('Synthetic current-stage cancellation');
        let command;
        await page.route('**' + cancelPath, async interceptor => {
          command = interceptor.request().postDataJSON();
          const response = await interceptor.fetch();
          assert.equal(response.status(), 201);
          await interceptor.abort('failed');
        }, { times: 1 });
        await page.getByRole('button', { name: 'Cancel milestone review' }).click();
        await page.getByText(/The operation could not be confirmed/).waitFor();
        assert.equal(command.expectedSequence, 1);
        await page.getByRole('button', { name: 'Read original milestone receipt' }).click();
        await page.getByText(/confirmed by a read-only receipt/).waitFor();
        const replay = ok(await request(cancelPath, { method: 'POST', identity: ids.second, body: command }));
        assert.equal(replay.replayed, true);
        assert.equal(replay.approval.state.status, 'Cancelled');
        assert.equal((await request(cancelPath, { method: 'POST', identity: ids.second,
          body: { ...command, expectedSequence: 0 } })).status, 409);
        const stale = await another('SYN-MILESTONE-3');
        ok(
          await request(route + '/policies', {
            method: 'POST',
            body: {
              expectedOwnerKey: initial.ownerKey,
              requestId: randomUUID(),
              engagementId: roots.engagement.id,
              expectedLatestId: policy.id,
              effectiveFrom: fx.today,
              definition,
              reason: 'Synthetic policy revision',
            },
          }),
          201,
        );
        assert.equal((await firstDecision(stale.id, 'Approved')).status, 409);
        assert.equal(
          (
            await pool.query(
              "select count(*)::int n from approved_unbilled_items where source_type='MILESTONE_ACCEPTANCE'",
            )
          ).rows[0].n,
          1,
        );
        const original = ok(await request(inbox, { identity: ids.manager }));
        const notice = original.notifications.find(
          (n) => n.kind === 'milestone-billing-eligibility' && n.instanceId === created.id,
        );
        assert(notice);
        const query = '?engagementId=' + encodeURIComponent(roots.engagement.id);
        const current = ok(
          await request(route + '/policies' + query + '&includeEffective=true'),
        ).effectivePolicy;
        let latest = current.id;
        for (let day = 1; day <= 21; day++) {
          latest = ok(
            await request(route + '/policies', {
              method: 'POST',
              body: {
                expectedOwnerKey: initial.ownerKey,
                requestId: randomUUID(),
                engagementId: roots.engagement.id,
                expectedLatestId: latest,
                effectiveFrom: shiftCapacityDate(fx.today, day),
                definition,
                reason: 'Synthetic future policy',
              },
            }),
            201,
          ).policy.id;
        }
        const selection = ok(await request(route + '/policies' + query + '&includeEffective=true'));
        assert.equal(selection.effectivePolicy.id, current.id);
        assert.ok(selection.truncated && !selection.policies.some((p) => p.id === current.id));
        const itemIds = new Set([final.itemId]);
        const secondOwner = await readApprovalOwner(request, ids.second);
        for (let n = 0; n < 50; n++) {
          const review = await another('SYN-PAGED-' + n, current.id);
          ok(await firstDecision(review.id, 'Approved'), 201);
          const completed = ok(
            await request(route + '/instances/' + review.id + '/decisions', {
              method: 'POST',
              identity: ids.second,
              body: {
                expectedOwnerKey: secondOwner,
                requestId: randomUUID(),
                expectedSequence: 1,
                decision: 'Approved',
                reason: 'Synthetic second decision',
              },
            }),
            201,
          );
          itemIds.add(completed.itemId);
        }
        await page.getByRole('button', { name: 'Load milestone billing reviews' }).click();
        await page.getByRole('button', { name: 'More milestones', exact: true }).click();
        await page.getByRole('button', { name: 'More milestone reviews', exact: true }).click();
        const assertOptions = async (label, count) => {
          const options = page.getByLabel(label, { exact: true }).locator('option');
          await options.nth(count).waitFor({ state: 'attached' });
          const ids = await options.evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean));
          assert.equal(ids.length, count);
          assert.equal(new Set(ids).size, count);
        };
        await assertOptions('Milestone billing review', 54);
        await assertOptions('Billing milestone', 54);
        await page.getByLabel('Milestone review policy', { exact: true }).selectOption(current.id);
        assert.equal(await page.getByLabel('Milestone policy effective from').isEnabled(), true);
        await page.getByRole('button', { name: 'Load milestone register', exact: true }).click();
        await page.getByRole('button', { name: 'More approved milestone items', exact: true }).click();
        const items = page
          .getByRole('region', { name: 'Milestone approved-unbilled register' })
          .locator('li');
        await items.nth(50).waitFor();
        assert.deepEqual(
          new Set((await items.allTextContents()).map((text) => text.split('item ').at(-1))),
          itemIds,
        );
        assert.equal(
          (await request(route + '/policies' + query + '&includeEffective=true', { identity: ids.reader }))
            .status,
          403,
        );
        for (const [path, cursor] of [
          ['/sources', milestone.id],
          ['/instances', created.id],
          ['/register', final.itemId],
        ]) {
          const continuation = route + path + query + '&after=' + encodeURIComponent(cursor);
          assert.equal((await request(continuation, { identity: ids.reader })).status, 403);
        }
        await pool.query(
          "update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.milestone_billing.view'",
        );
        assert(
          !ok(await request(inbox, { identity: ids.manager })).notifications.some((n) => n.id === notice.id),
        );
        assert.equal(
          (
            await request(inbox + '/' + notice.id + '/read', {
              method: 'POST',
              identity: ids.manager,
              body: { expectedOwnerKey: original.ownerKey },
            })
          ).status,
          404,
        );
      } finally {
        await browser?.close();
        await fixture.close();
      }
    },
  );
});
console.log('Scoped milestone evidence, staged decision and register journey passed.');
