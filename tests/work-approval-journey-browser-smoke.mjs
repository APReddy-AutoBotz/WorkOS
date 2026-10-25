import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { WORK_APPROVAL_BASE as api, workApprovalWorkers as workers, seedWorkApproval, prepareStagedWork, stagedDefinition, submitStagedWork } from './support/work-approval-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
import { shiftCapacityDate } from '../shared/worker-capacity.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
    await migrateCommercialDatabase(pool);
    const { identities, today } = await seedWorkApproval(pool), weekday = new Date(today + 'T00:00:00Z').getUTCDay(), monday = shiftCapacityDate(today, weekday === 6 ? 2 : weekday === 0 ? 1 : 1 - weekday), pastMonday = shiftCapacityDate(monday, -7);
    await withCommercialApi({ databaseUrl, identities }, async ({ baseUrl: apiUrl, request, tokenFor }) => {
        await prepareStagedWork(request, identities, today);
        assert.equal((await request('/api/v1/work-capture-modes/settings', { method: 'POST', body: { expectedLatestId: null, enabledModes: ['daily', 'weekly'] } })).status, 201);
        assert.equal((await request('/api/allocations', { method: 'POST', body: { employee_id: workers.first, project_id: f.projectId, percentage: 20, start_date: pastMonday, end_date: shiftCapacityDate(today, 7), billable: false, status: 'Active' } })).status, 200);
        const vite = await createServer({ root, mode: 'production', clearScreen: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiUrl, changeOrigin: true } } }, define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false') } });
        let browser;
        try {
            await vite.listen();
            const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
            browser = await chromium.launch({ headless: true });
            const errors = [], external = [], adminPermissions = [...workPermissions, 'permissions.manage', 'notifications.manage', 'notifications.view'], employeePermissions = ['employees.view', 'projects.view', 'timesheets.submit', 'employee_workspace.view', 'notifications.view'];
            const contextFor = async (identity, permissions) => { const c = await browser.newContext({ viewport: { width: 1600, height: 1200 }, timezoneId: 'Pacific/Kiritimati' }); await c.addInitScript(({ session, scope, token }) => { sessionStorage.setItem('workos_session', JSON.stringify(session)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token); }, { session: { id: identity.employeeRecordId ?? identity.id, employeeId: identity.employeeId ?? identity.id, userName: identity.username, name: 'Synthetic staged operator', role: identity.role, permissionRole: identity.role, permissions }, scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId }, token: tokenFor(identity) }); return c; };
            const ac = await contextFor(identities.manager, adminPermissions), bc = await contextFor(identities.second, adminPermissions), wc = await contextFor(identities.first, employeePermissions), a = await ac.newPage(), b = await bc.newPage(), w = await wc.newPage(), stale = await ac.newPage(), url = origin + '/tests/fixtures/work-approval.html';
            for (const p of [a, b, w, stale]) {
                p.setDefaultTimeout(20000);
                p.on('pageerror', e => errors.push(e.stack ?? e.message));
                p.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin)
                    external.push(r.url()); });
            }
            await a.goto(url);
            const config = a.getByRole('region', { name: 'Staged work approval policy', exact: true });
            await config.getByRole('button', { name: 'Load approval policy configuration', exact: true }).click();
            await config.getByLabel('Policy workers', { exact: true }).locator('option').first().waitFor();
            assert.equal(await config.getByLabel('Template locale', { exact: true }).inputValue(), '');
            assert.equal(await config.getByLabel('Informational completion in-app', { exact: true }).inputValue(), '');
            assert.equal(await config.getByRole('button', { name: 'Record prospective work approval policy', exact: true }).isDisabled(), true);
            const definition = stagedDefinition(identities);
            await config.getByLabel('Policy workers', { exact: true }).selectOption(definition.workerIds);
            await config.getByLabel('Policy effective date', { exact: true }).fill(today);
            await config.getByLabel('Stage 1 account', { exact: true }).selectOption(identities.manager.id);
            await config.getByLabel('Stage 1 role', { exact: true }).selectOption('Admin');
            await config.getByRole('button', { name: 'Add approval stage', exact: true }).click();
            await config.getByLabel('Stage 2 account', { exact: true }).selectOption(identities.second.id);
            await config.getByLabel('Stage 2 role', { exact: true }).selectOption('Admin');
            await config.getByLabel('Template locale', { exact: true }).fill('en-GB');
            for (const [t, label] of definition.templates.map((t, i) => [t, ['Action request', 'Correction', 'Completion'][i]])) {
                await config.getByLabel(label + ' title', { exact: true }).fill(t.subject);
                await config.getByLabel(label + ' body', { exact: true }).fill(t.body);
            }
            await config.getByLabel('Informational completion in-app', { exact: true }).selectOption('enabled');
            await config.getByLabel('Policy adoption reason', { exact: true }).fill('Synthetic browser explicit staged policy');
            const adoption = a.waitForResponse(r => new URL(r.url()).pathname === api + '/policies' && r.request().method() === 'POST');
            await config.getByRole('button', { name: 'Record prospective work approval policy', exact: true }).click();
            assert.equal((await adoption).status(), 201);
            await config.getByRole('article', { name: 'Work approval policy 1', exact: true }).waitFor();
            // Named Employee enters past work in daily capture, submits the same header from weekly capture.
            await w.goto(url);
            await w.getByRole('button', { name: 'Enter submitted work', exact: true }).click();
            const ready = () => w.waitForFunction(() => { const e = document.querySelector('select[aria-label="Capture mode"]'); return e && !e.disabled; });
            await ready();
            await w.getByRole('button', { name: 'Previous week', exact: true }).click();
            await ready();
            await w.getByLabel('Capture mode', { exact: true }).selectOption('daily');
            await w.getByLabel('Work date', { exact: true }).selectOption('2');
            const row = w.locator('tbody tr').first();
            await row.locator('select').nth(1).selectOption(f.projectId);
            await row.getByPlaceholder('0.0', { exact: true }).fill('1.25');
            await w.getByRole('button', { name: 'Edit Monday remark', exact: true }).click();
            await w.getByPlaceholder('Describe your work for this day in detail...', { exact: true }).fill('Synthetic staged daily work for inspection');
            await w.getByRole('button', { name: 'Save Daily Remark', exact: true }).click();
            await w.getByLabel('Capture mode', { exact: true }).selectOption('weekly');
            const submitted = w.waitForResponse(r => new URL(r.url()).pathname === '/api/timesheets' && r.request().method() === 'POST');
            await w.getByRole('button', { name: 'Submit for Approval', exact: true }).click();
            const reply = await submitted;
            assert.equal(reply.status(), 200, await reply.text());
            const timesheetId = (await reply.json()).id, instance = (await pool.query('select * from work_approval_instances where timesheet_id=$1', [timesheetId])).rows[0];
            assert(instance);
            assert.equal(instance.requester_user_id, identities.first.id);
            const panel = p => p.getByRole('region', { name: 'Governed work approval inbox', exact: true }), load = async (p) => { const q = panel(p); await q.getByLabel('Approval instance reference', { exact: true }).fill(instance.id); await q.getByRole('button', { name: 'Load current work approval', exact: true }).click(); await q.getByRole('article', { name: 'Current governed work approval', exact: true }).waitFor(); return q; }, decide = async (p, reason, decision = 'Approve') => { const q = panel(p); await q.getByLabel('Work approval decision reason', { exact: true }).fill(reason); const r = p.waitForResponse(r => new URL(r.url()).pathname === api + '/instances/' + instance.id + '/decisions' && r.request().method() === 'POST'); await q.getByRole('button', { name: decision + ' current work stage', exact: true }).click(); return r; };
            const ap = await load(a);
            await ap.getByRole('region', { name: 'Retained work for this approval', exact: true }).getByText('Synthetic staged daily work for inspection', { exact: true }).waitFor();
            await stale.goto(url);
            await load(stale);
            assert.equal((await decide(a, 'Synthetic stage one approval')).status(), 201);
            await ap.getByRole('article', { name: 'Recorded work stage receipt', exact: true }).waitFor();
            assert.equal((await pool.query('select status from timesheets where id=$1', [timesheetId])).rows[0].status, 'Submitted');
            assert.equal((await decide(stale, 'Synthetic stale first-stage attempt')).status(), 409);
            await panel(stale).getByText('Write not confirmed. Read current history before another attempt.', { exact: true }).waitFor();
            await b.goto(url);
            await load(b);
            assert.equal((await decide(b, 'Synthetic final work approval')).status(), 201);
            await panel(b).getByRole('article', { name: 'Recorded work stage receipt', exact: true }).waitFor();
            assert.equal((await pool.query('select status from timesheets where id=$1', [timesheetId])).rows[0].status, 'Approved');
            await load(a);
            assert.equal(await ap.getByRole('button', { name: 'Approve current work stage', exact: true }).count(), 0);
            assert.equal(await ap.getByRole('region', { name: 'Immutable work stage history', exact: true }).getByRole('article').count(), 2);
            await w.getByRole('button', { name: 'My notifications', exact: true }).click();
            const inbox = w.getByRole('region', { name: 'Canonical work approval notifications', exact: true });
            await inbox.getByRole('button', { name: 'Load my governed notifications', exact: true }).click();
            const note = inbox.getByRole('article').filter({ hasText: 'approval.completed' });
            await note.waitFor();
            await note.getByText('Recipient reasons: affected_worker, requester · In-app Enabled · Unread', { exact: true }).waitFor();
            await note.getByRole('button', { name: /Mark governed notification read/ }).click();
            await note.getByText(/In-app Enabled · Read /).waitFor();
            await inbox.getByRole('button', { name: 'Load my governed notifications', exact: true }).click();
            await inbox.getByText(/In-app Enabled · Read /).waitFor();
            // A late accepted old-owner policy request may not repopulate cleared account data.
            await config.getByRole('button', { name: 'Use policy 1 as draft', exact: true }).click();
            await config.getByLabel('Policy effective date', { exact: true }).fill(shiftCapacityDate(today, 1));
            await config.getByLabel('Policy adoption reason', { exact: true }).fill('Synthetic late old-owner prospective version');
            const blocker = await pool.connect();
            let open = false;
            try {
                await blocker.query('begin');
                open = true;
                await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['work-approval-scope:' + f.organizationId + ':' + f.legalEntityId]);
                const sent = a.waitForRequest(r => new URL(r.url()).pathname === api + '/policies' && r.method() === 'POST'), late = a.waitForResponse(r => new URL(r.url()).pathname === api + '/policies' && r.request().method() === 'POST');
                await config.getByRole('button', { name: 'Record prospective work approval policy', exact: true }).click();
                await sent;
                assert.equal(await config.getByLabel('Policy adoption reason', { exact: true }).isDisabled(), true);
                await a.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
                await config.getByText('Account, active role or scope changed. Reload explicitly.', { exact: true }).waitFor();
                await blocker.query('commit');
                open = false;
                assert.equal((await late).status(), 201);
                assert.equal(await config.getByRole('article').count(), 0);
                assert.equal(await config.getByLabel('Policy adoption reason', { exact: true }).inputValue(), '');
            }
            finally {
                if (open)
                    await blocker.query('rollback');
                blocker.release();
            }
            assert.equal((await pool.query('select count(*)::int n from work_approval_transitions where instance_id=$1', [instance.id])).rows[0].n, 2);
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            await ac.close();
            await bc.close();
            await wc.close();
        }
        finally {
            await browser?.close();
            await vite.close();
        }
    });
});
console.log('Staged approval real React/API/PostgreSQL explicit policy, named Employee daily-to-weekly submit, retained work inspection, ordered two-actor decisions, stale rejection, terminal work/history, own canonical read/reload and late accepted old-owner suppression passed; no external delivery or UAT claim.');
