import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';
import { workPermissions } from './support/work-assignment-test.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import {
  seedWorkApproval,
  adoptStagedPolicy,
  submitStagedWork,
  readApprovalOwner,
  WORK_APPROVAL_BASE as work,
} from './support/work-approval-test.mjs';
import { actualCatalog } from './support/actual-work-test.mjs';
import {
  grantAmendmentPermissions,
  createAmendmentHierarchy,
} from './support/commercial-amendments-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const base = '/api/v1/governed-tm-valuations',
  candidates = '/api/v1/rate-candidates',
  approvals = '/api/v1/commercial-candidate-approvals',
  adoptions = '/api/v1/approved-rate-sources',
  ok = (v, n = 200) => {
    assert.equal(v.status, n, JSON.stringify(v.body));
    return v.body;
  };
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedWorkApproval(pool),
    ids = fx.identities;
  await grantAmendmentPermissions(pool);
  for (const k of [
    'commercial.rate_candidates.view',
    'commercial.rate_candidates.manage',
    'commercial.cost_candidates.view',
    'commercial.cost_candidates.manage',
    'commercial.rate_approvals.decide',
    'commercial.cost_approvals.decide',
    'commercial.tm_valuation.view',
    'commercial.tm_valuation.create',
    'commercial.tm_billing.view',
    'commercial.tm_billing.manage',
    'commercial.tm_billing.decide',
  ])
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    { databaseUrl, identities: ids, onServerError: (s) => process.stderr.write(s) },
    async ({ request, tokenFor, baseUrl: apiUrl }) => {
      const end = shift(fx.today, 30),
        roots = await createAmendmentHierarchy(request, 'SYN-TM-VAL', {
          contract: {
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: end,
            effectiveFrom: fx.today,
            currency: 'USD',
          },
          engagement: { startsOn: fx.today, endsOn: end, currency: 'USD' },
          project: { startsOn: fx.today, endsOn: end },
        });
      ok(
        await request('/api/v1/work-categories/catalogs', {
          method: 'POST',
          body: {
            expectedLatestId: null,
            effectiveFrom: fx.today,
            definition: actualCatalog,
            reason: 'Synthetic category',
          },
        }),
        201,
      );
      await adoptStagedPolicy(request, ids, fx.today);
      ok(
        await request('/api/allocations', {
          method: 'POST',
          body: {
            employee_id: f.ownerId,
            project_id: roots.project.id,
            percentage: 20,
            start_date: fx.today,
            end_date: fx.today,
            billable: true,
            status: 'Active',
          },
        }),
      );
      const keys = [
          'approval.action_required',
          'approval.rejected_or_correction_required',
          'approval.completed',
        ],
        makeRate = async (kind, amount, priority = 1, adoptNow = true, currency = 'USD') => {
          const bindingType = kind === 'billing' ? 'contract' : 'worker',
            bindingId = kind === 'billing' ? roots.contract.id : f.ownerId,
            candidate = ok(
              await request(candidates + '/candidates', {
                method: 'POST',
                body: {
                  requestId: randomUUID(),
                  streamId: randomUUID(),
                  expectedLatestId: null,
                  kind,
                  bindingType,
                  bindingId,
                  effectiveFrom: fx.today,
                  effectiveTo: end,
                  currency,
                  unit: 'HOUR',
                  amount,
                  priority,
                  reason: 'Synthetic governed source',
                },
              }),
              201,
            ).candidate,
            owner = ok(
              await request(candidates + '/owners', {
                method: 'POST',
                body: {
                  requestId: randomUUID(),
                  candidateId: candidate.id,
                  expectedOwnerEventId: null,
                  ownerUserId: ids.manager.id,
                  ownerRole: 'Admin',
                  reason: 'Synthetic rate owner',
                },
              }),
              201,
            ),
            definition = {
              entityType: 'CommercialCandidate',
              kind,
              candidateId: candidate.id,
              stages: [{ userId: ids.second.id, role: 'Admin' }],
              locale: 'en-US',
              templates: keys.map((key) => ({
                key,
                subject: 'Review {{stageNumber}}',
                body: 'Source {{sourceRef}}',
              })),
              completionInApp: false,
            },
            policy = ok(
              await request(approvals + '/policies', {
                method: 'POST',
                body: {
                  expectedOwnerKey: owner.ownerKey,
                  requestId: randomUUID(),
                  expectedLatestId: null,
                  effectiveFrom: fx.today,
                  definition,
                  reason: 'Synthetic rate policy',
                },
              }),
              201,
            ).policy,
            approval = ok(
              await request(approvals + '/requests', {
                method: 'POST',
                body: {
                  expectedOwnerKey: owner.ownerKey,
                  requestId: randomUUID(),
                  candidateId: candidate.id,
                  expectedOwnerEventId: owner.owner.id,
                  expectedPolicyId: policy.id,
                  reason: 'Synthetic review',
                },
              }),
              201,
            ).approval,
            actor = ok(await request(approvals + '/instances/' + approval.id, { identity: ids.second }));
          ok(
            await request(approvals + '/instances/' + approval.id + '/decisions', {
              method: 'POST',
              identity: ids.second,
              body: {
                expectedOwnerKey: actor.ownerKey,
                requestId: randomUUID(),
                expectedCandidateId: candidate.id,
                expectedOwnerEventId: owner.owner.id,
                expectedPolicyId: policy.id,
                expectedSequence: 0,
                decision: 'Approved',
                reason: 'Synthetic source review',
              },
            }),
            201,
          );
          const inspected = ok(await request(adoptions + '/candidates/' + candidate.id)),
            r = inspected.reviews[0];
          const adoptionCommand = {
            expectedOwnerKey: inspected.ownerKey,
            requestId: randomUUID(),
            candidateId: candidate.id,
            expectedOwnerEventId: r.ownerEventId,
            approvalId: r.approvalId,
            expectedPolicyId: r.policyId,
            expectedFinalTransitionId: r.finalTransitionId,
            reason: 'Synthetic source adoption',
          };
          return adoptNow
            ? ok(await request(adoptions + '/adoptions', { method: 'POST', body: adoptionCommand }), 201)
                .adoption
            : adoptionCommand;
        };
      const billing = await makeRate('billing', '100.1234'),
        cost = await makeRate('cost', '40.0020'),
        policies = ok(await request(base + '/policies?engagementId=' + roots.engagement.id)),
        definition = {
          version: 'governed-tm/1',
          currency: 'USD',
          precision: 2,
          rounding: 'HALF_UP',
          aggregation: 'PER_ENTRY',
          capTreatment: 'NONE',
          exclusions: 'NONE',
          unit: 'HOUR',
          approvalTreatment: 'NONE',
        },
        policyCmd = {
          expectedOwnerKey: policies.ownerKey,
          requestId: randomUUID(),
          engagementId: roots.engagement.id,
          expectedLatestId: null,
          effectiveFrom: fx.today,
          definition,
          reason: 'Synthetic selected T&M policy',
        },
        policy = ok(await request(base + '/policies', { method: 'POST', body: policyCmd }), 201).policy;
      assert.equal(ok(await request(base + '/policies', { method: 'POST', body: policyCmd })).replayed, true);
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: { ...policyCmd, reason: 'Synthetic changed reason' },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: { ...policyCmd, requestId: randomUUID() },
          })
        ).status,
        409,
      );
      const invalidPolicy = { ...definition };
      delete invalidPolicy.approvalTreatment;
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: {
              ...policyCmd,
              requestId: randomUUID(),
              expectedLatestId: policy.id,
              definition: invalidPolicy,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(base + '/policies', {
            method: 'POST',
            body: {
              ...policyCmd,
              requestId: randomUUID(),
              expectedLatestId: policy.id,
              definition: { ...definition, approvalTreatment: 'REQUIRED' },
            },
          })
        ).status,
        400,
      );
      const submitted = await submitStagedWork(request, ids.reader, fx.today, {
          entries: [
            {
              project_id: roots.project.id,
              work_type: 'Project Work',
              category_code: 'BILL',
              work_date: fx.today,
              hours: '1.25',
              billable: true,
              remark: 'Synthetic approved work',
            },
          ],
        }),
        evidence = (
          await pool.query('select * from work_submission_evidence where id=$1', [
            submitted.instance.submissionId,
          ])
        ).rows[0],
        entry = evidence.entries[0];
      const decideWork = async (identity) => {
        const current = ok(await request(work + '/instances/' + submitted.instance.id)).instance;
        return ok(
          await request(work + '/instances/' + submitted.instance.id + '/decisions', {
            method: 'POST',
            identity,
            body: {
              expectedOwnerKey: await readApprovalOwner(request, identity),
              expectedSourceToken: current.sourceToken,
              expectedSequence: current.state.sequence,
              requestId: randomUUID(),
              decision: 'Approved',
              reason: 'Synthetic approved work stage',
            },
          }),
          201,
        ).receipt;
      };
      await decideWork(ids.manager);
      await decideWork(ids.second);
      const calc = ok(
        await request(base + '/valuations', {
          method: 'POST',
          body: {
            expectedOwnerKey: policies.ownerKey,
            requestId: randomUUID(),
            engagementId: roots.engagement.id,
            policyId: policy.id,
            submissionId: evidence.id,
            entryId: entry.entryId,
            billingAdoptionId: billing.id,
            costAdoptionId: cost.id,
            reason: 'Synthetic calculation',
          },
        }),
        201,
      ).valuation;
      const b = '/api/v1/tm-billing-eligibility';
      const fixture = await startFixtureServer({
        root: fileURLToPath(new URL('../', import.meta.url)),
        fixtures: ['rate-candidates'],
        apiUrl,
      });
      let browser;
      const contexts = [];
      try {
        const origin = fixture.url;
        browser = await chromium.launch({ headless: true });
        const open = async (identity) => {
          const ctx = await browser.newContext({
            viewport: { width: 1800, height: 1400 },
            timezoneId: 'UTC',
          });
          contexts.push(ctx);
          await ctx.addInitScript(
            ({ user, scope, token }) => {
              sessionStorage.setItem('workos_session', JSON.stringify(user));
              sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
              sessionStorage.setItem('workos_api_token', token);
            },
            {
              user: {
                id: identity.id,
                employeeId: identity.id,
                userName: identity.username,
                name: 'Synthetic billing actor',
                role: 'Admin',
                permissionRole: 'Admin',
                permissions: [
                  ...workPermissions,
                  'notifications.view',
                  'commercial.contracts.view',
                  'commercial.contracts.manage',
                  'commercial.tm_billing.view',
                  'commercial.tm_billing.manage',
                  'commercial.tm_billing.decide',
                ],
              },
              scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
              token: tokenFor(identity),
            },
          );
          const p = await ctx.newPage(),
            errors = [],
            external = [];
          p.setDefaultTimeout(25000);
          p.on('pageerror', (e) => errors.push(e.stack ?? e.message));
          p.on('request', (q) => {
            if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin) external.push(q.url());
          });
          await p.goto(origin + '/tests/fixtures/rate-candidates.html');
          const ui = p.getByRole('region', { name: 'T&M billing eligibility', exact: true });
          await ui.getByLabel('Billing engagement', { exact: true }).selectOption(roots.engagement.id);
          return { p, ui, errors, external };
        };
        const wait = (p, path, method = 'GET') =>
            p.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method),
          body = async (w, status = 200) => {
            const response = await w;
            assert.equal(response.status(), status, await response.text());
            return response.json();
          };
        const requester = await open(ids.requester),
          ui = requester.ui,
          p = requester.p;
        let pw = wait(p, b + '/policies'),
          sw = wait(p, b + '/sources'),
          iw = wait(p, b + '/instances');
        await ui.getByRole('button', { name: 'Load billing evidence and reviews', exact: true }).click();
        assert.equal((await body(pw)).effectivePolicy, null);
        assert.equal((await body(sw)).sources.length, 1);
        await body(iw);
        assert.equal(
          await ui.getByRole('button', { name: 'Request billing review', exact: true }).isDisabled(),
          true,
        );
        await ui.getByLabel('Billing policy effective from', { exact: true }).fill(fx.today);
        await ui.getByLabel('Billing policy locale', { exact: true }).fill('en-US');
        await ui.getByLabel('Billing completion in-app', { exact: true }).selectOption('yes');
        await ui.getByLabel('Billing stage 1 user ID', { exact: true }).fill(ids.manager.id);
        await ui.getByLabel('Billing stage 1 role', { exact: true }).fill('Admin');
        await ui.getByRole('button', { name: 'Add billing stage', exact: true }).click();
        await ui.getByLabel('Billing stage 2 user ID', { exact: true }).fill(ids.second.id);
        await ui.getByLabel('Billing stage 2 role', { exact: true }).fill('Admin');
        for (const k of keys) {
          await ui.getByLabel(k + ' billing subject', { exact: true }).fill('Review {{sourceRef}}');
          await ui.getByLabel(k + ' billing body', { exact: true }).fill('Stage {{stageNumber}}');
        }
        await ui
          .getByLabel('Billing policy reason', { exact: true })
          .fill('Synthetic explicit billing policy');
        pw = wait(p, b + '/policies', 'POST');
        await ui.getByRole('button', { name: 'Record billing review policy', exact: true }).click();
        const pOut = await body(pw, 201);
        await ui
          .getByText('Operation recorded. Reload the current evidence before another action.')
          .waitFor();
        let latest = pOut.policy.id;
        for (let day = 1; day <= 21; day++) {
          latest = ok(
            await request(b + '/policies', {
              method: 'POST',
              identity: ids.requester,
              body: {
                expectedOwnerKey: pOut.ownerKey,
                requestId: randomUUID(),
                engagementId: roots.engagement.id,
                expectedLatestId: latest,
                effectiveFrom: shift(fx.today, day),
                definition: pOut.policy.definition,
                reason: 'Synthetic future billing review policy',
              },
            }),
            201,
          ).policy.id;
        }
        const loadPolicySelection = async () => {
          const responses = ['/policies', '/sources', '/instances'].map((path) => wait(p, b + path));
          await ui.getByRole('button', { name: 'Load billing evidence and reviews', exact: true }).click();
          const [selection] = await Promise.all(responses.map((response) => body(response)));
          assert.equal(selection.effectivePolicy.id, pOut.policy.id);
          assert.ok(selection.truncated && !selection.policies.some((x) => x.id === pOut.policy.id));
          return selection.policies[0].id;
        };
        assert.equal(await loadPolicySelection(), latest);
        await ui.getByLabel('Billing policy effective from', { exact: true }).fill(shift(fx.today, 22));
        pw = wait(p, b + '/policies', 'POST');
        await ui.getByRole('button', { name: 'Record billing review policy', exact: true }).click();
        const scheduled = (await body(pw, 201)).policy;
        assert.equal(scheduled.previousId, latest);
        await ui
          .getByText('Operation recorded. Reload the current evidence before another action.')
          .waitFor();
        assert.equal(await loadPolicySelection(), scheduled.id);
        const scopedQuery =
          '?engagementId=' + encodeURIComponent(roots.engagement.id) + '&includeEffective=true';
        assert.equal((await request(b + '/policies' + scopedQuery, { identity: ids.reader })).status, 403);
        const available = ui.getByLabel('Billing review policy', { exact: true });
        assert.deepEqual(
          await available.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value)),
          ['', pOut.policy.id],
        );
        await ui.getByLabel('Billing snapshot', { exact: true }).selectOption(calc.id);
        await ui.getByLabel('Billing review policy', { exact: true }).selectOption(pOut.policy.id);
        await ui.getByLabel('Billing change owner user ID', { exact: true }).fill(ids.manager.id);
        await ui.getByLabel('Billing change owner role', { exact: true }).fill('Admin');
        await ui.getByLabel('Billing request reason', { exact: true }).fill('Synthetic billing request');
        let accepted, notify;
        const acceptedOnce = new Promise((resolve) => {
          notify = resolve;
        });
        await p.route(
          '**/api/v1/tm-billing-eligibility/requests',
          async (route) => {
            const response = await route.fetch();
            assert.equal(response.status(), 201, await response.text());
            accepted = await response.json();
            notify();
            await route.abort('failed');
          },
          { times: 1 },
        );
        await ui.getByRole('button', { name: 'Request billing review', exact: true }).click();
        await acceptedOnce;
        const review = accepted.approval;
        await ui.getByText(/may still be in flight/).waitFor();
        const receipt = wait(p, b + '/receipts/request/' + review.requestId);
        await ui.getByRole('button', { name: 'Read original billing receipt', exact: true }).click();
        assert.equal((await body(receipt)).approval.id, review.id);
        await ui.getByText('The original request was confirmed by a read-only receipt. Reload.').waitFor();
        assert.equal((await pool.query('select count(*)::int n from approved_unbilled_items')).rows[0].n, 0);
        const decideUI = async (identity) => {
          const actor = await open(identity),
            u = actor.ui,
            page = actor.p;
          let a = wait(page, b + '/policies'),
            s = wait(page, b + '/sources'),
            r = wait(page, b + '/instances');
          await u.getByRole('button', { name: 'Load billing evidence and reviews', exact: true }).click();
          await body(a);
          await body(s);
          await body(r);
          await u.getByLabel('Billing review', { exact: true }).selectOption(review.id);
          const observed = wait(page, b + '/instances/' + review.id);
          await u.getByRole('button', { name: 'Inspect retained billing evidence', exact: true }).click();
          const source = await body(observed);
          assert(!JSON.stringify(source).includes('costValue'));
          await u.getByLabel('Billing decision', { exact: true }).selectOption('Approved');
          await u.getByLabel('Billing decision reason', { exact: true }).fill('Synthetic stage decision');
          const d = wait(page, b + '/instances/' + review.id + '/decisions', 'POST');
          await u.getByRole('button', { name: 'Record billing decision', exact: true }).click();
          const out = await body(d, 201);
          await u
            .getByText('Operation recorded. Reload the current evidence before another action.')
            .waitFor();
          return { actor, out };
        };
        const first = await decideUI(ids.manager);
        assert.equal(first.out.approval.state.status, 'Pending');
        assert.equal((await pool.query('select count(*)::int n from approved_unbilled_items')).rows[0].n, 0);
        const last = await decideUI(ids.second);
        assert.equal(last.out.approval.state.status, 'Approved');
        const reg = wait(last.actor.p, b + '/register');
        await last.actor.ui
          .getByRole('button', { name: 'Load approved-unbilled register', exact: true })
          .click();
        const rr = await body(reg);
        assert.equal(rr.items.length, 1);
        await last.actor.ui
          .getByRole('region', { name: 'Approved-unbilled register', exact: true })
          .getByText(/USD 125.1500/)
          .waitFor();
        await last.actor.p.evaluate(() =>
          window.dispatchEvent(new Event('workos:organization-scope-switch-requested')),
        );
        await last.actor.p
          .getByRole('alert')
          .getByText(/Scope or access changed. Content and draft cleared/)
          .waitFor();
        assert.equal(
          await last.actor.p.getByRole('region', { name: 'Approved-unbilled register', exact: true }).count(),
          0,
        );
        for (const x of [requester, first.actor, last.actor]) {
          assert.deepEqual(x.errors, []);
          assert.deepEqual(x.external, []);
        }
        console.log('real React/API/PostgreSQL staged billing review and register passed.');
      } finally {
        for (const c of contexts) await c.close();
        await browser?.close();
        await fixture.close();
      }
    },
  );
});
