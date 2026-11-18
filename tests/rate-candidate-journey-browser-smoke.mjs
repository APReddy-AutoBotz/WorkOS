import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';
import {
  commercialFixture as f,
  withCommercialDatabase,
  migrateCommercialDatabase,
  withCommercialApi,
} from './support/commercial-drafting-test.mjs';
import { seedCapacity } from './support/worker-capacity-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
import { shiftCapacityDate as shift } from '../shared/worker-capacity.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  base = '/api/v1/rate-candidates';
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedCapacity(pool),
    ids = fx.identities,
    keys = [
      'commercial.rate_candidates.view',
      'commercial.rate_candidates.manage',
      'commercial.cost_candidates.view',
      'commercial.cost_candidates.manage',
    ];
  for (const k of keys)
    await pool.query(
      "insert into role_permissions(role_name,permission_key,enabled)values('Admin',$1,true)on conflict(role_name,permission_key)do update set enabled=true",
      [k],
    );
  await withCommercialApi(
    {
      databaseUrl,
      identities: ids,
      timeZone: 'Pacific/Kiritimati',
      onServerError: (s) => process.stderr.write(s),
    },
    async ({ tokenFor, baseUrl: apiUrl, request }) => {
      const ok = (r, status = 201) => {
          assert.equal(r.status, status, JSON.stringify(r.body));
          return r.body;
        },
        last = shift(fx.today, 90);
      const contract = ok(
        await request('/contracts', {
          method: 'POST',
          body: {
            number: 'SYN-UI-RATE',
            clientId: f.clientId,
            name: 'Synthetic UI contract',
            model: 'time_and_materials',
            startsOn: fx.today,
            endsOn: last,
            effectiveFrom: fx.today,
            currency: 'USD',
            value: '1000.0000',
            billingTerms: 'Synthetic terms',
            documents: [],
            reason: 'Synthetic UI contract',
          },
        }),
      );
      const engagement = ok(
        await request('/engagements', {
          method: 'POST',
          body: {
            code: 'SYN-UI-ENG',
            name: 'Synthetic UI engagement',
            model: 'time_and_materials',
            ownerId: f.ownerId,
            startsOn: fx.today,
            endsOn: last,
            currency: 'USD',
            budget: '1000.0000',
            clientId: f.clientId,
            contractId: contract.id,
            contractVersionId: contract.versions[0].id,
            attributionId: null,
            reason: 'Synthetic UI engagement',
          },
        }),
      );
      const fixture = await startFixtureServer({ root, fixtures: ['rate-candidates'], apiUrl });
      let browser;
      try {
        const origin = fixture.url;
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext({
          viewport: { width: 1800, height: 1400 },
          timezoneId: 'Pacific/Kiritimati',
        });
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
              name: 'Synthetic rate actor',
              role: 'Admin',
              permissionRole: 'Admin',
              permissions: [
                ...workPermissions,
                'commercial.contracts.view',
                'commercial.contracts.manage',
                'employees.manage',
                ...keys,
              ],
            },
            scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId },
            token: tokenFor(ids.manager),
          },
        );
        const p = await ctx.newPage(),
          writes = [],
          errors = [],
          external = [];
        p.setDefaultTimeout(25000);
        p.on('pageerror', (e) => errors.push(e.stack ?? e.message));
        p.on('request', (q) => {
          if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin) external.push(q.url());
          if (q.method() === 'POST' && new URL(q.url()).pathname === base + '/candidates')
            writes.push(q.postDataJSON());
        });
        const reply = (path, method = 'GET') =>
            p.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method),
          body = async (w, status = 200) => {
            const r = await w;
            assert.equal(r.status(), status, await r.text());
            return r.json();
          };
        await p.goto(origin + '/tests/fixtures/rate-candidates.html');
        const billing = p.getByRole('region', { name: 'Billing rate candidates', exact: true });
        await billing.getByLabel('Candidate source', { exact: true }).selectOption('contract:' + contract.id);
        let w = reply(base + '/candidates');
        await billing.getByRole('button', { name: 'Load candidates', exact: true }).click();
        await body(w);
        const fill = async (area, value) => {
          await area.getByLabel('Effective from UTC', { exact: true }).fill(fx.today);
          await area.getByLabel('Effective to UTC', { exact: true }).fill(last);
          await area.getByLabel('Currency', { exact: true }).fill('USD');
          await area.getByLabel('Unit code', { exact: true }).fill('HOUR');
          await area.getByLabel('Exact rate amount', { exact: true }).fill(value);
          await area.getByLabel('Explicit priority', { exact: true }).fill('10');
          await area.getByLabel('Candidate reason', { exact: true }).fill('Synthetic unapproved candidate');
          await area.getByLabel('Confirm this unapproved candidate', { exact: true }).check();
        };
        await fill(billing, '12345678901234.1234');
        await p.route(
          '**/api/v1/rate-candidates/candidates',
          async (route) => {
            const accepted = await route.fetch();
            assert.equal(accepted.status(), 201, await accepted.text());
            await route.abort('failed');
          },
          { times: 1 },
        );
        await billing.getByRole('button', { name: 'Record candidate', exact: true }).click();
        await billing.getByText(/may still be in flight/).waitFor();
        const original = writes.at(-1);
        w = reply(base + '/receipts/' + original.requestId);
        await billing.getByRole('button', { name: 'Read original candidate receipt', exact: true }).click();
        const receipt = await body(w);
        assert.equal(receipt.candidate.amount, '12345678901234.1234');
        assert.equal(writes.length, 1);
        await billing.getByLabel('Engagement for preview', { exact: true }).selectOption(engagement.id);
        await billing.getByLabel('Preview as-of UTC', { exact: true }).fill(fx.today);
        w = reply(base + '/preview');
        await billing.getByRole('button', { name: 'Preview resolution', exact: true }).click();
        assert.equal((await body(w)).result, 'candidate');
        await billing.getByText(/Preview: candidate.*12345678901234.1234/).waitFor();
        await p.getByRole('link', { name: 'Directory', exact: true }).click();
        await p.getByLabel('Directory search', { exact: true }).fill('SYNTHETIC-COMMERCIAL-LOCAL');
        w = reply('/api/v1/workforce-directory');
        await p.getByRole('button', { name: 'Load scoped directory', exact: true }).click();
        await body(w);
        w = reply('/api/v1/workforce-directory');
        await p
          .getByRole('button', { name: 'Open reporting context SYNTHETIC-COMMERCIAL-LOCAL', exact: true })
          .click();
        await body(w);
        await p.getByRole('button', { name: 'Inspect selected worker cost candidates', exact: true }).click();
        const cost = p.getByRole('region', { name: 'Worker cost candidates', exact: true });
        w = reply(base + '/candidates');
        await cost.getByRole('button', { name: 'Load candidates', exact: true }).click();
        await body(w);
        await fill(cost, '73.0123');
        w = reply(base + '/candidates', 'POST');
        await cost.getByRole('button', { name: 'Record candidate', exact: true }).click();
        const costReceipt = await body(w, 201);
        assert.equal(costReceipt.candidate.amount, '73.0123');
        await cost.getByLabel('Preview as-of UTC', { exact: true }).fill(fx.today);
        w = reply(base + '/preview');
        await cost.getByRole('button', { name: 'Preview resolution', exact: true }).click();
        assert.equal((await body(w)).candidate.amount, '73.0123');
        await cost.getByText(/Preview: candidate.*73.0123/).waitFor();
        const prior = (
          await pool.query('select amount::text,request_id from commercial_rate_candidates where id=$1', [
            costReceipt.candidate.id,
          ])
        ).rows[0];
        w = reply(base + '/candidates');
        await cost.getByRole('button', { name: 'Load candidates', exact: true }).click();
        await body(w);
        await fill(cost, '74.0000');
        await cost.getByLabel('Effective from UTC', { exact: true }).fill(shift(fx.today, 1));
        await cost.getByLabel('Confirm this unapproved candidate', { exact: true }).check();
        let release, accepted;
        const held = new Promise((r) => {
            release = r;
          }),
          received = new Promise((r) => {
            accepted = r;
          });
        await p.route(
          '**/api/v1/rate-candidates/candidates',
          async (route) => {
            const response = await route.fetch();
            assert.equal(response.status(), 201, await response.text());
            accepted();
            await held;
            await route.fulfill({ response });
          },
          { times: 1 },
        );
        await cost.getByRole('button', { name: 'Record candidate', exact: true }).click();
        await received;
        await p.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
        release();
        await p
          .getByText(
            'Account, role or scope changed. Directory and unsent handoffs cleared. Reload explicitly.',
            { exact: true },
          )
          .waitFor();
        assert.equal(await cost.count(), 0);
        assert.deepEqual(
          (
            await pool.query('select amount::text,request_id from commercial_rate_candidates where id=$1', [
              costReceipt.candidate.id,
            ])
          ).rows[0],
          prior,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await ctx.close();
        console.log(
          'Rate candidate React/API/PostgreSQL receipt:',
          JSON.stringify({
            commercialBindingChoice: true,
            workerScopeHandoff: true,
            decimalExact: true,
            previewOnly: true,
            lostAckReadOnly: true,
            scopeChangeClears: true,
            acceptedLateOwnerSuppressed: true,
            priorEvidenceRetained: true,
            noExternalRequests: true,
          }),
        );
      } finally {
        await browser?.close();
        await fixture.close();
      }
    },
  );
});
