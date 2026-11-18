import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { NOTICE_BASE as api, noticeDefinition, seedPeriodNotices } from './support/work-period-notice-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
import { prepareStagedWork, adoptStagedPolicy, submitStagedWork } from './support/work-approval-test.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
    await migrateCommercialDatabase(pool);
    const fx = await seedPeriodNotices(pool, 'overdue'), { identities, today, workerId, periodId } = fx;
    await withCommercialApi({ databaseUrl, identities }, async ({ request, tokenFor, baseUrl: apiUrl }) => {
        await prepareStagedWork(request, identities, today);
        assert.equal((await request('/api/v1/work-capture-policy', { method: 'POST', body: { expectedLatestId: null, effectiveFrom: today, minimumIncrement: '0.25', dailyMaximum: '24', weeklyMaximum: '168', commentRequired: false, submissionDeadline: { anchor: 'weekly-end-date', timezone: 'UTC', daysAfterPeriodEnd: 0, time: '00:00', graceMinutes: 0, lateTreatment: 'warn' } } })).status, 201);
        const fixtureServer = await startFixtureServer({root, fixtures: ['work-approval'], apiUrl});
        let browser;
        try {
            const origin = fixtureServer.url;
            browser = await chromium.launch({ headless: true });
            const errors = [], external = [], admin = [...workPermissions, 'permissions.manage', 'notifications.manage', 'notifications.view'], employee = ['employees.view', 'projects.view', 'timesheets.submit', 'employee_workspace.view', 'notifications.view'];
            const contextFor = async (identity, permissions) => { const c = await browser.newContext({ viewport: { width: 1600, height: 1200 }, timezoneId: 'Pacific/Kiritimati' }); await c.addInitScript(({ session, scope, token }) => { sessionStorage.setItem('workos_session', JSON.stringify(session)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token); }, { session: { id: identity.employeeRecordId ?? identity.id, employeeId: identity.employeeId ?? identity.id, userName: identity.username, name: 'Synthetic deadline operator', role: identity.role, permissionRole: identity.role, permissions }, scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId }, token: tokenFor(identity) }); return c; };
            const ac = await contextFor(identities.manager, admin), bc = await contextFor(identities.second, admin), wc = await contextFor(identities.first, employee), a = await ac.newPage(), b = await bc.newPage(), w = await wc.newPage(), stale = await ac.newPage(), url = origin + '/tests/fixtures/work-approval.html';
            for (const p of [a, b, w, stale]) {
                p.setDefaultTimeout(20000);
                p.on('pageerror', e => errors.push(e.stack ?? e.message));
                p.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin)
                    external.push(r.url()); });
            }
            const panel = p => p.getByRole('region', { name: 'Work period deadline notice producer', exact: true }), load = async (p) => { await p.goto(url); const q = panel(p); await q.getByRole('button', { name: 'Load deadline notice configuration', exact: true }).click(); await q.getByLabel('Deadline notice workers', { exact: true }).locator('option').first().waitFor(); return q; }, inspect = async (p) => { const q = panel(p); await q.getByLabel('Deadline source worker', { exact: true }).selectOption(workerId); await q.getByLabel('Deadline source period', { exact: true }).selectOption(periodId); await q.getByRole('button', { name: 'Inspect current deadline notice source', exact: true }).click(); await q.getByRole('article', { name: 'Current deadline notice source', exact: true }).waitFor(); return q; }, evaluate = async (p, reason) => { const q = panel(p); await q.getByLabel('Deadline evaluation reason', { exact: true }).fill(reason); const r = p.waitForResponse(r => new URL(r.url()).pathname === api + '/evaluate' && r.request().method() === 'POST'); await q.getByRole('button', { name: 'Record current deadline evaluation', exact: true }).click(); return r; };
            const q = await load(a);
            assert.equal(await q.getByLabel('Reminder minutes before deadline', { exact: true }).inputValue(), '');
            assert.equal(await q.getByLabel('Overdue notice boundary', { exact: true }).inputValue(), '');
            assert.equal(await q.getByRole('button', { name: 'Record prospective deadline notice policy', exact: true }).isDisabled(), true);
            const d = noticeDefinition(identities, 'overdue');
            await q.getByLabel('Deadline notice workers', { exact: true }).selectOption([workerId]);
            await q.getByLabel('Deadline notice effective date', { exact: true }).fill(today);
            await q.getByLabel('Reminder minutes before deadline', { exact: true }).fill('0');
            await q.getByLabel('Overdue notice boundary', { exact: true }).selectOption('grace-end');
            await q.getByLabel('Deadline escalation account', { exact: true }).selectOption(identities.second.id);
            await q.getByLabel('Deadline escalation role', { exact: true }).selectOption('Admin');
            await q.getByLabel('Deadline template locale', { exact: true }).fill('en-GB');
            for (const [t, i] of d.templates.map((t, i) => [t, i])) {
                await q.getByLabel(`Deadline ${i === 0 ? 'due' : 'overdue'} title`, { exact: true }).fill(t.subject);
                await q.getByLabel(`Deadline ${i === 0 ? 'due' : 'overdue'} body`, { exact: true }).fill(t.body);
            }
            await q.getByLabel('Deadline policy reason', { exact: true }).fill('Synthetic browser explicit deadline notice policy');
            const adoption = a.waitForResponse(r => new URL(r.url()).pathname === api + '/policies' && r.request().method() === 'POST');
            await q.getByRole('button', { name: 'Record prospective deadline notice policy', exact: true }).click();
            assert.equal((await adoption).status(), 201);
            await q.getByRole('article', { name: 'Deadline notice policy 1', exact: true }).waitFor();
            await inspect(a);
            await q.getByText('Eligible event work_period.submission_overdue', { exact: false }).waitFor();
            await load(stale);
            await inspect(stale);
            assert.equal((await evaluate(a, 'Synthetic browser overdue evaluation')).status(), 201);
            await q.getByRole('article', { name: 'Deadline evaluation receipt 1', exact: true }).waitFor();
            assert.equal((await evaluate(stale, 'Synthetic stale evaluation draft')).status(), 409);
            await panel(stale).getByText('Write not confirmed. Read current history before another attempt.', { exact: true }).waitFor();
            assert.equal(await panel(stale).getByLabel('Deadline evaluation reason', { exact: true }).inputValue(), 'Synthetic stale evaluation draft');
            const readNotice = async (p, reason) => { await p.goto(url); await p.getByRole('button', { name: 'My notifications', exact: true }).click(); const box = p.getByRole('region', { name: 'Canonical work approval notifications', exact: true }); await box.getByRole('button', { name: 'Load my governed notifications', exact: true }).click(); const notice = box.getByRole('article').filter({ hasText: 'work_period.submission_overdue' }); await notice.waitFor(); await notice.getByText('Recipient reasons: ' + reason + ' · In-app Required · Unread', { exact: true }).waitFor(); await notice.getByRole('button', { name: /Mark governed notification read/ }).click(); await notice.getByText(/In-app Required · Read /).waitFor(); await box.getByRole('button', { name: 'Load my governed notifications', exact: true }).click(); await box.getByText(/In-app Required · Read /).waitFor(); };
            await readNotice(w, 'affected_worker');
            await readNotice(b, 'configured_escalation_owner');
            assert.equal((await pool.query('select count(*)::int n from work_period_notice_deliveries')).rows[0].n, 2);
            // Actual named Employee API submission; existing approval engine creates a pending stage.
            await adoptStagedPolicy(request, identities, today);
            const submitted = await submitStagedWork(request, identities.first, today);
            assert.equal(submitted.instance.state.status, 'Pending');
            await q.getByRole('button', { name: 'Inspect current deadline notice source', exact: true }).click();
            await q.getByRole('article', { name: 'Current deadline notice source', exact: true }).getByText(/ · accepted$/).waitFor();
            assert.equal((await evaluate(a, 'Synthetic accepted source suppression')).status(), 201);
            await q.getByRole('article', { name: 'Deadline evaluation receipt 2', exact: true }).getByText(/NoEvent/).waitFor();
            assert.equal((await pool.query('select count(*)::int n from work_period_notice_events')).rows[0].n, 1);
            await q.getByRole('button', { name: 'Load deadline evaluation history', exact: true }).click();
            await q.getByRole('region', { name: 'Immutable deadline evaluation history', exact: true }).getByRole('article', { name: 'Deadline evaluation receipt 2', exact: true }).waitFor();
            assert.equal(await q.getByRole('region', { name: 'Immutable deadline evaluation history', exact: true }).getByRole('article').count(), 2);
            // Late accepted old-owner evaluation is retained on the server and cannot repopulate cleared UI.
            await q.getByRole('button', { name: 'Inspect current deadline notice source', exact: true }).click();
            await q.getByRole('article', { name: 'Current deadline notice source', exact: true }).waitFor();
            const blocker = await pool.connect();
            let open = false;
            try {
                await blocker.query('begin');
                open = true;
                await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['commercial-lifecycle:' + f.organizationId + ':' + f.legalEntityId]);
                await q.getByLabel('Deadline evaluation reason', { exact: true }).fill('Synthetic late deadline evaluation');
                const sent = a.waitForRequest(r => new URL(r.url()).pathname === api + '/evaluate' && r.method() === 'POST'), reply = a.waitForResponse(r => new URL(r.url()).pathname === api + '/evaluate' && r.request().method() === 'POST');
                await q.getByRole('button', { name: 'Record current deadline evaluation', exact: true }).click();
                await sent;
                assert.equal(await q.getByLabel('Deadline evaluation reason', { exact: true }).isDisabled(), true);
                await a.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
                await q.getByText('Account, active role or scope changed. Reload explicitly.', { exact: true }).waitFor();
                await blocker.query('commit');
                open = false;
                assert.equal((await reply).status(), 201);
                assert.equal(await q.getByRole('article').count(), 0);
                assert.equal(await q.getByLabel('Deadline policy reason', { exact: true }).inputValue(), '');
            }
            finally {
                if (open)
                    await blocker.query('rollback');
                blocker.release();
            }
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            await ac.close();
            await bc.close();
            await wc.close();
        }
        finally {
            await browser?.close();
            await fixtureServer.close();
        }
    });
});
console.log('Deadline notice actual React policy/evaluation, real UTC overdue source, stale CAS, named worker/configured-owner canonical inbox/read/reload, real named Employee API/pending-stage suppression, immutable history and late accepted old-owner suppression passed; no external delivery, scheduler, clock override or UAT claim.');
