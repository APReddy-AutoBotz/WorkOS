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
        makeRate = async (kind, amount, priority = 1) => {
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
                  currency: 'USD',
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
          return ok(
            await request(adoptions + '/adoptions', {
              method: 'POST',
              body: {
                expectedOwnerKey: inspected.ownerKey,
                requestId: randomUUID(),
                candidateId: candidate.id,
                expectedOwnerEventId: r.ownerEventId,
                approvalId: r.approvalId,
                expectedPolicyId: r.policyId,
                expectedFinalTransitionId: r.finalTransitionId,
                reason: 'Synthetic source adoption',
              },
            }),
            201,
          ).adoption;
        };
      const billing = await makeRate('billing', '100.1234'),
        cost = await makeRate('cost', '40.0020');
      const fixture = await startFixtureServer({
        root: fileURLToPath(new URL('../', import.meta.url)),
        fixtures: ['rate-candidates'],
        apiUrl,
      });
      let browser;
      try {
        const origin = fixture.url;
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1800, height: 1400 }, timezoneId: 'UTC' });
        await ctx.addInitScript(
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
              name: 'Synthetic valuation actor',
              role: 'Admin',
              permissionRole: 'Admin',
              permissions: [
                ...workPermissions,
                'commercial.contracts.view',
                'commercial.contracts.manage',
                'commercial.rate_candidates.view',
                'commercial.rate_candidates.manage',
                'commercial.cost_candidates.view',
                'commercial.cost_candidates.manage',
                'commercial.rate_approvals.decide',
                'commercial.cost_approvals.decide',
                'commercial.tm_valuation.view',
                'commercial.tm_valuation.create',
              ],
            },
            scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
            token: tokenFor(ids.manager),
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
        const reply = (path, method = 'GET') =>
            p.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method),
          body = async (w, status = 200) => {
            const r = await w;
            assert.equal(r.status(), status, await r.text());
            return r.json();
          };
        await p.goto(origin + '/tests/fixtures/rate-candidates.html');
        const tm = p.getByRole('region', { name: 'Governed T&M valuation', exact: true });
        await tm.getByLabel('T&M engagement', { exact: true }).selectOption(roots.engagement.id);
        let pw = reply(base + '/policies'),
          sw = reply(base + '/sources');
        await tm.getByRole('button', { name: 'Load T&M policy and approved work', exact: true }).click();
        await body(pw);
        assert.equal((await body(sw)).sources.length, 0);
        await tm.getByLabel('T&M policy effective date UTC', { exact: true }).fill(fx.today);
        await tm.getByLabel('T&M policy currency', { exact: true }).fill('USD');
        await tm.getByLabel('T&M currency precision', { exact: true }).selectOption('2');
        await tm.getByLabel('T&M rounding mode', { exact: true }).selectOption('HALF_UP');
        await tm.getByLabel('T&M aggregation', { exact: true }).selectOption('PER_ENTRY');
        await tm.getByLabel('T&M cap treatment', { exact: true }).selectOption('NONE');
        await tm.getByLabel('T&M exclusions', { exact: true }).selectOption('NONE');
        await tm.getByLabel('T&M policy approval treatment', { exact: true }).selectOption('NONE');
        await tm.getByLabel('T&M work unit', { exact: true }).selectOption('HOUR');
        await tm.getByLabel('T&M policy reason', { exact: true }).fill('Synthetic explicit T&M policy');
        pw = reply(base + '/policies', 'POST');
        await tm.getByRole('button', { name: 'Record explicit T&M policy', exact: true }).click();
        const policy = (await body(pw, 201)).policy;
        await tm.getByText(/Policy .* recorded/).waitFor();
        // Put today's policy beyond the default history page using ordinary, prospective writes.
        let latest = policy.id;
        const policyOwnerKey = await readApprovalOwner(request, ids.manager);
        for (let day = 1; day <= 20; day++) {
          latest = ok(
            await request(base + '/policies', {
              method: 'POST',
              identity: ids.manager,
              body: {
                expectedOwnerKey: policyOwnerKey,
                expectedLatestId: latest,
                requestId: randomUUID(),
                engagementId: roots.engagement.id,
                effectiveFrom: shift(fx.today, day),
                definition: { ...policy.definition, rounding: 'DOWN', precision: 0 },
                reason: 'Synthetic future valuation policy',
              },
            }),
            201,
          ).policy.id;
        }
        // Use one real database row per page to exercise a same-date boundary.
        await p.route('**/api/v1/governed-tm-valuations/sources?*', async (route) => {
          const url = new URL(route.request().url());
          url.searchParams.set('limit', '1');
          await route.continue({ url: url.href });
        });
        const loadHistory = async () => {
          let next = reply(base + '/sources');
          await tm.getByRole('button', { name: 'Load more approved work' }).click();
          const last = await body(next);
          assert.equal(last.sources.length, 1);
          assert.equal(last.truncated, false);
          next = reply(base + '/policies');
          await tm.getByRole('button', { name: 'Load older T&M policies' }).click();
          assert.deepEqual(
            (await body(next)).policies.map((x) => x.id),
            [policy.id],
          );
          assert.equal(await tm.getByRole('button', { name: 'Load more approved work' }).count(), 0);
          return last.sources[0];
        };
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
              {
                project_id: roots.project.id,
                work_type: 'Project Work',
                category_code: 'BILL',
                work_date: fx.today,
                hours: '2.5',
                billable: true,
                remark: 'Synthetic second approved work',
              },
            ],
          }),
          evidence = (
            await pool.query('select * from work_submission_evidence where id=$1', [
              submitted.instance.submissionId,
            ])
          ).rows[0],
          entry = evidence.entries.find((x) => x.hours === '1.25'),
          second = evidence.entries.find((x) => x.hours === '2.5');
        assert(entry && second);
        const decide = async (identity) => {
          const v = ok(await request(work + '/instances/' + submitted.instance.id)).instance;
          return ok(
            await request(work + '/instances/' + submitted.instance.id + '/decisions', {
              method: 'POST',
              identity,
              body: {
                expectedOwnerKey: await readApprovalOwner(request, identity),
                expectedSourceToken: v.sourceToken,
                expectedSequence: v.state.sequence,
                requestId: randomUUID(),
                decision: 'Approved',
                reason: 'Synthetic approved work stage',
              },
            }),
            201,
          ).receipt;
        };
        assert.equal((await decide(ids.manager)).outcome.status, 'Pending');
        assert.equal((await decide(ids.second)).outcome.status, 'Approved');
        pw = reply(base + '/policies');
        sw = reply(base + '/sources');
        await tm.getByRole('button', { name: 'Load T&M policy and approved work', exact: true }).click();
        await body(pw);
        const first = await body(sw);
        assert.equal(first.truncated, true);
        const last = await loadHistory();
        assert.deepEqual([first.sources[0].entryId, last.entryId], [entry.entryId, second.entryId].sort());
        const query = '?engagementId=' + encodeURIComponent(roots.engagement.id);
        assert.equal((await request(base + '/sources' + query + '&afterDate=' + fx.today)).status, 400);
        assert.equal((await request(base + '/policies' + query + '&beforeSequence=0')).status, 400);
        const continuation = new URLSearchParams({
          engagementId: roots.engagement.id,
          afterDate: first.sources[0].workDate,
          afterEntryId: first.sources[0].entryId,
        });
        assert.equal(
          (await request(base + '/sources?' + continuation, { identity: ids.reader })).status,
          403,
        );
        assert.equal(
          (await request(base + '/policies' + query + '&beforeSequence=2', { identity: ids.reader })).status,
          403,
        );
        await tm.getByLabel('T&M approved work', { exact: true }).selectOption(entry.entryId);
        await tm.getByLabel('Retained T&M policy', { exact: true }).selectOption(policy.id);
        const rateWait = (kind) =>
            p.waitForResponse(
              (r) =>
                new URL(r.url()).pathname === '/api/v1/approved-rate-sources/resolve' &&
                new URL(r.url()).searchParams.get('kind') === kind,
            ),
          bw = rateWait('billing'),
          cw = rateWait('cost');
        await tm
          .getByRole('button', { name: 'Inspect adopted billing and cost sources', exact: true })
          .click();
        assert.equal((await body(bw)).source.adoptionId, billing.id);
        assert.equal((await body(cw)).source.adoptionId, cost.id);
        await tm.getByText(/100.1234\/HOUR; cost adoption .*40.0020\/HOUR/).waitFor();
        await tm.getByLabel('T&M calculation reason', { exact: true }).fill('Synthetic explicit calculation');
        let sent, accepted, ready;
        const submittedOnce = new Promise((resolve) => {
          ready = resolve;
        });
        await p.route(
          '**/api/v1/governed-tm-valuations/valuations',
          async (route) => {
            sent = route.request().postDataJSON();
            const response = await route.fetch();
            assert.equal(response.status(), 201, await response.text());
            accepted = await response.json();
            ready();
            await route.abort('failed');
          },
          { times: 1 },
        );
        await tm.getByRole('button', { name: 'Retain T&M snapshot', exact: true }).click();
        await submittedOnce;
        await tm.getByText(/may still be in flight/).waitFor();
        let vw = reply(base + '/receipts/valuation/' + sent.requestId);
        await tm.getByRole('button', { name: 'Read original T&M receipt', exact: true }).click();
        assert.equal((await body(vw)).valuation.id, accepted.valuation.id);
        const result = tm.getByRole('region', { name: 'Retained T&M snapshot', exact: true });
        await result.getByText(/billable 125.15, cost 50.00, margin 75.15/).waitFor();
        const verifyCalculation = async () => {
          const audit = result.getByRole('region', { name: 'Calculation evidence' });
          await audit
            .getByText(
              'Policy version 1, effective ' +
                fx.today +
                ' UTC. Amounts rounded per entry using half up at 2 decimal places.',
            )
            .waitFor();
          const table = audit.getByRole('table', { name: 'Amounts in USD for 1.25 approved hours' });
          assert.deepEqual(
            await table
              .getByRole('row', { name: /Billable value/ })
              .getByRole('cell')
              .allTextContents(),
            ['100.1234', '125.15425', '125.15'],
          );
          assert.deepEqual(
            await table.getByRole('row', { name: /Cost/ }).getByRole('cell').allTextContents(),
            ['40.0020', '50.0025', '50.00'],
          );
          await audit.getByText('USD gross margin · 125.15 − 50.00 = 75.15.').waitFor();
          assert.equal(await audit.locator('time').getAttribute('datetime'), accepted.valuation.createdAt);
        };
        await verifyCalculation();
        assert.equal(
          (
            await pool.query('select count(*)::int n from commercial_tm_valuations where entry_id=$1', [
              entry.entryId,
            ])
          ).rows[0].n,
          1,
        );
        pw = reply(base + '/policies');
        sw = reply(base + '/sources');
        await tm.getByRole('button', { name: 'Load T&M policy and approved work', exact: true }).click();
        await body(pw);
        await body(sw);
        await loadHistory();
        await tm.getByLabel('T&M approved work', { exact: true }).selectOption(entry.entryId);
        const newerRate = await makeRate('billing', '200.0000', 2);
        vw = reply(base + '/valuations/' + accepted.valuation.id);
        await tm.getByRole('button', { name: 'Inspect retained T&M snapshot', exact: true }).click();
        const historical = await body(vw);
        assert.equal(historical.valuation.id, accepted.valuation.id);
        assert.equal(historical.billingRate.adoptionId, billing.id);
        assert.equal(historical.costRate.adoptionId, cost.id);
        const history = result.getByRole('region', { name: 'Historical rate selection' });
        for (const rate of [historical.billingRate, historical.costRate]) {
          await history
            .getByText('Effective ' + fx.today + ' through ' + end + ' · candidate ' + rate.candidateId)
            .waitFor();
          await history
            .getByText(
              'USD ' +
                rate.amount +
                ' per HOUR · ' +
                rate.bindingType +
                ' ' +
                rate.bindingId +
                ' · priority 1',
            )
            .waitFor();
        }
        const denied = await request(
          base + '/valuations/' + accepted.valuation.id + '?includeRateEvidence=true',
          { identity: ids.reader },
        );
        assert.equal(denied.status, 403);
        assert.ok(!JSON.stringify(denied.body).includes(cost.id));
        await result.getByText(/billable 125.15, cost 50.00, margin 75.15/).waitFor();
        await verifyCalculation();
        const periodPath = (start, end) =>
          base + '/period-summary?' + new URLSearchParams({ engagementId: roots.engagement.id, start, end });
        const range = periodPath(fx.today, fx.today);
        await tm.getByLabel('Work date from').fill(fx.today);
        await tm.getByLabel('Work date through').fill(fx.today);
        const report = reply(base + '/period-summary');
        await tm.getByRole('button', { name: 'Load period margin' }).click();
        assert.deepEqual((await body(report)).totals, [
          {
            currency: 'USD',
            entryCount: '1',
            hours: '1.25',
            billable: '125.15',
            cost: '50.00',
            margin: '75.15',
            marginPercent: '60.05',
          },
        ]);
        await tm.getByRole('cell', { name: '60.05%' }).waitFor();
        const versionPath = range.replace('/period-summary', '/period-versions');
        const snapshotCommand = async (key) => ({
          engagementId: roots.engagement.id,
          start: fx.today,
          end: fx.today,
          membershipKey: key,
          expectedOwnerKey: await readApprovalOwner(request, ids.manager),
        });
        const firstWrite = reply(base + '/period-versions', 'POST');
        await tm.getByRole('button', { name: 'Retain this period' }).click();
        const frozen = await body(firstWrite, 201);
        assert.equal(frozen.sequence, 1);
        await tm.getByRole('heading', { name: /Retained version 1/ }).waitFor();
        const firstCommand = await snapshotCommand(frozen.membershipKey);
        assert.equal(
          ok(await request(base + '/period-versions', { method: 'POST', body: firstCommand })).id,
          frozen.id,
        );
        await tm.getByLabel('Retained period version').fill('1');
        const opening = reply(base + '/period-versions');
        await tm.getByRole('button', { name: 'Open retained period' }).click();
        assert.equal((await body(opening)).id, frozen.id);
        await tm.getByRole('cell', { name: '60.05%' }).waitFor();
        await tm.getByLabel('Work date through').fill(end);
        assert.equal(await tm.getByRole('region', { name: 'Period margin results' }).count(), 0);
        assert.deepEqual(ok(await request(periodPath(end, end))).totals, []);
        assert.equal((await request(periodPath(end, fx.today))).status, 400);
        assert.equal((await request(range, { identity: ids.reader })).status, 403);
        await tm.getByLabel('T&M approved work', { exact: true }).selectOption(second.entryId);
        await tm.getByLabel('Retained T&M policy', { exact: true }).selectOption(policy.id);
        const bw2 = rateWait('billing'),
          cw2 = rateWait('cost');
        await tm
          .getByRole('button', { name: 'Inspect adopted billing and cost sources', exact: true })
          .click();
        assert.equal((await body(bw2)).source.adoptionId, newerRate.id);
        await body(cw2);
        await tm
          .getByLabel('T&M calculation reason', { exact: true })
          .fill('Synthetic accepted-late calculation');
        let release, late;
        const held = new Promise((r) => {
            release = r;
          }),
          received = new Promise((r) => {
            late = r;
          });
        await p.route(
          '**/api/v1/governed-tm-valuations/valuations',
          async (route) => {
            const response = await route.fetch();
            assert.equal(response.status(), 201, await response.text());
            late();
            await held;
            await route.fulfill({ response });
          },
          { times: 1 },
        );
        await tm.getByRole('button', { name: 'Retain T&M snapshot', exact: true }).click();
        await received;
        assert.equal(await tm.getByLabel('T&M engagement', { exact: true }).isDisabled(), true);
        await p.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
        release();
        await p
          .getByRole('alert')
          .getByText(/Scope or access changed. Content and draft cleared/)
          .waitFor();
        assert.equal(await tm.count(), 0);
        assert.equal(await p.getByRole('region', { name: 'Retained T&M snapshot', exact: true }).count(), 0);
        assert.equal(
          (
            await pool.query('select count(*)::int n from commercial_tm_valuations where entry_id=$1', [
              second.entryId,
            ])
          ).rows[0].n,
          1,
        );
        const retained = await pool.query(
          "select entry_id, billing_adoption_id, result->>'billableValue' as amount from commercial_tm_valuations where entry_id=any($1::uuid[])",
          [[entry.entryId, second.entryId]],
        );
        assert.equal(retained.rows.length, 2);
        for (const [entryId, adoptionId, amount] of [
          [entry.entryId, billing.id, '125.15'],
          [second.entryId, newerRate.id, '500.00'],
        ]) {
          assert.deepEqual(
            retained.rows.find((row) => row.entry_id === entryId),
            { entry_id: entryId, billing_adoption_id: adoptionId, amount },
          );
        }
        assert.deepEqual(ok(await request(range)).totals, [
          {
            currency: 'USD',
            entryCount: '2',
            hours: '3.75',
            billable: '625.15',
            cost: '150.01',
            margin: '475.14',
            marginPercent: '76.00',
          },
        ]);
        const original = ok(await request(versionPath + '&sequence=1'));
        assert.deepEqual(original.totals, frozen.totals);
        assert.equal(
          (
            await request(base + '/period-versions', {
              method: 'POST',
              body: { ...firstCommand, membershipKey: 'f'.repeat(64) },
            })
          ).status,
          409,
        );
        const updated = ok(await request(range + '&includeMembershipKey=true'));
        const nextCommand = await snapshotCommand(updated.membershipKey);
        await pool.query(
          "create function synthetic_period_audit_failure() returns trigger language plpgsql as $$begin if new.action='Retain Period' then raise exception 'synthetic period audit failure' using errcode='CTM03'; end if; return new; end$$; create trigger synthetic_period_audit_failure before insert on audit_logs for each row execute function synthetic_period_audit_failure()",
        );
        assert.equal(
          (await request(base + '/period-versions', { method: 'POST', body: nextCommand })).status,
          409,
        );
        assert.equal(ok(await request(versionPath)).sequence, 1);
        await pool.query('drop trigger synthetic_period_audit_failure on audit_logs');
        const writes = await Promise.all(
          [1, 2].map(() => request(base + '/period-versions', { method: 'POST', body: nextCommand })),
        );
        assert.deepEqual(writes.map((x) => x.status).sort(), [200, 201]);
        assert.equal(writes[0].body.id, writes[1].body.id);
        const latestPeriod = ok(await request(versionPath));
        assert.equal(latestPeriod.sequence, 2);
        assert.equal(
          ok(await request(base + '/period-versions', { method: 'POST', body: firstCommand })).id,
          frozen.id,
        );
        assert.deepEqual(latestPeriod.totals, updated.totals);
        assert.deepEqual(ok(await request(versionPath + '&sequence=1')).totals, frozen.totals);
        assert.equal((await request(versionPath, { identity: ids.first })).status, 403);
        await assert.rejects(
          pool.query('update commercial_tm_period_versions set sequence=99 where id=$1', [frozen.id]),
        );
        assert.equal(
          (
            await pool.query(
              "select count(*)::int n from audit_logs where action='Retain Period' and entity_id=any($1::text[])",
              [[frozen.id, latestPeriod.id]],
            )
          ).rows[0].n,
          2,
        );
        // A finance reader with employee-only scope can see their own totals alone.
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled) select 'Employee',k,true from unnest($1::text[]) k on conflict(role_name,permission_key) do update set enabled=true",
          [
            [
              'commercial.contracts.view',
              'commercial.rate_candidates.view',
              'commercial.cost_candidates.view',
              'employees.view',
              'commercial.tm_valuation.view',
            ],
          ],
        );
        assert.deepEqual(ok(await request(range, { identity: ids.first })).totals, []);
        assert.equal(ok(await request(range, { identity: ids.reader })).totals[0].entryCount, '2');
        assert.equal((await request(versionPath, { identity: ids.first })).status, 404);
        assert.deepEqual(
          ok(await request(versionPath, { identity: ids.reader })).totals,
          latestPeriod.totals,
        );
        await pool.query(
          "insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.tm_valuation.create',true) on conflict(role_name,permission_key) do update set enabled=true",
        );
        const limitedWrite = await request(base + '/period-versions', {
          method: 'POST',
          identity: ids.first,
          body: {
            ...firstCommand,
            expectedOwnerKey: ok(await request(range, { identity: ids.first })).ownerKey,
          },
        });
        assert.equal(limitedWrite.status, 409);
        assert.ok(!JSON.stringify(limitedWrite.body).includes(frozen.id));
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await ctx.close();
        console.log(
          'Real React/API/PostgreSQL T&M policy, staged work, adopted rates, exact snapshot, lost receipt and scope fence passed.',
        );
      } finally {
        await browser?.close();
        await fixture.close();
      }
    },
  );
});
