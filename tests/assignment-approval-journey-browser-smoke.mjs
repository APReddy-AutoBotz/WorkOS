import { compareCapabilityIds } from '../shared/workforce-capabilities.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { ASSIGNMENT_APPROVAL_BASE as base, seedAssignmentApproval, assignmentApprovalDefinition, createApprovalAssignment, getAssignmentApprovalSource, proposeAssignment } from './support/assignment-approval-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
    await migrateCommercialDatabase(pool);
    const fx = await seedAssignmentApproval(pool), { identities } = fx;
    const unicodeWorkers = ['synthetic-\ue000-worker', 'synthetic-😀-worker'];
    for (const [id, i] of unicodeWorkers.map((id, i) => [id, i]))
        await pool.query("insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values($1,$1,$2,$3,'Consultant','Delivery','US','director-commercial','Active',$4,$5)", [id, 'Synthetic Unicode worker ' + i, 'synthetic-unicode-' + i + '@example.test', f.organizationId, f.legalEntityId]);
    await withCommercialApi({ databaseUrl, identities }, async ({ request, tokenFor, baseUrl: apiUrl }) => {
        const assignment = await createApprovalAssignment(request, fx), vite = await createServer({ root, mode: 'production', clearScreen: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiUrl, changeOrigin: true } } }, define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false') } });
        let browser;
        try {
            await vite.listen();
            const origin = `http://127.0.0.1:${vite.httpServer.address().port}`, url = origin + '/tests/fixtures/work-approval.html';
            browser = await chromium.launch({ headless: true });
            const errors = [], external = [], admin = [...workPermissions, 'permissions.manage', 'notifications.manage', 'notifications.view'], employee = ['employees.view', 'projects.view', 'timesheets.submit', 'employee_workspace.view', 'notifications.view'];
            const contextFor = async (identity, permissions) => { const c = await browser.newContext({ viewport: { width: 1600, height: 1200 }, timezoneId: 'Pacific/Kiritimati' }); await c.addInitScript(({ session, scope, token }) => { sessionStorage.setItem('workos_session', JSON.stringify(session)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token); }, { session: { id: identity.employeeRecordId ?? identity.id, employeeId: identity.employeeId ?? identity.id, userName: identity.username, name: 'Synthetic material assignment actor', role: identity.role, permissionRole: identity.role, permissions }, scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId }, token: tokenFor(identity) }); return c; };
            const ac = await contextFor(identities.manager, admin), bc = await contextFor(identities.second, admin), rc = await contextFor(identities.requester, admin), wc = await contextFor(identities.reader, employee), a = await ac.newPage(), b = await bc.newPage(), r = await rc.newPage(), w = await wc.newPage(), stale = await rc.newPage();
            for (const p of [a, b, r, w, stale]) {
                p.setDefaultTimeout(20000);
                p.on('pageerror', e => errors.push(e.stack ?? e.message));
                p.on('request', q => {
                    if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin)
                        external.push(q.url());
                });
            }
            const policyPanel = p => p.getByRole('region', { name: 'Material assignment approval policy', exact: true }), proposalPanel = p => p.getByRole('region', { name: 'Material assignment proposals', exact: true }), readSource = async (p) => { const q = proposalPanel(p); await q.getByLabel('Assignment proposal source', { exact: true }).fill(assignment.id); await q.getByRole('button', { name: 'Load assignment proposal source', exact: true }).click(); await q.getByLabel('Proposed assignment percentage', { exact: true }).waitFor(); return q; }, readProposal = async (p, id) => { const q = proposalPanel(p); await q.getByRole('button', { name: 'Load material assignment proposals', exact: true }).click(); await q.getByRole('button', { name: 'Inspect material proposal ' + id, exact: true }).click(); await q.getByRole('article', { name: 'Current material assignment proposal', exact: true }).waitFor(); return q; };
            await a.goto(url);
            const q = policyPanel(a);
            await q.getByRole('button', { name: 'Load material assignment configuration', exact: true }).click();
            await q.getByLabel('Material policy workers', { exact: true }).locator('option').first().waitFor();
            assert.equal(await q.getByLabel('Fields requiring material approval', { exact: true }).evaluate(e => e.selectedOptions.length), 0);
            assert.equal(await q.getByLabel('Assignment informational completion', { exact: true }).inputValue(), '');
            assert(await q.getByRole('button', { name: 'Record material assignment policy', exact: true }).isDisabled());
            const definition = assignmentApprovalDefinition(identities);
            definition.workerIds = [f.ownerId, ...unicodeWorkers].sort(compareCapabilityIds);
            await q.getByLabel('Material policy effective date', { exact: true }).fill(fx.today);
            await q.getByLabel('Material policy workers', { exact: true }).selectOption(definition.workerIds);
            await q.getByLabel('Fields requiring material approval', { exact: true }).selectOption(definition.materialFields);
            await q.getByLabel('Assignment stage 1 account', { exact: true }).selectOption(identities.manager.id);
            await q.getByLabel('Assignment stage 1 role', { exact: true }).selectOption('Admin');
            await q.getByRole('button', { name: 'Add assignment approval stage', exact: true }).click();
            await q.getByLabel('Assignment stage 2 account', { exact: true }).selectOption(identities.second.id);
            await q.getByLabel('Assignment stage 2 role', { exact: true }).selectOption('Admin');
            await q.getByLabel('Assignment template locale', { exact: true }).fill('en-GB');
            for (const t of definition.templates) {
                await q.getByLabel(`Assignment ${t.key} title`, { exact: true }).fill(t.subject);
                await q.getByLabel(`Assignment ${t.key} body`, { exact: true }).fill(t.body);
            }
            await q.getByLabel('Assignment informational completion', { exact: true }).selectOption('enabled');
            await q.getByLabel('Material policy reason', { exact: true }).fill('Synthetic browser explicit material adoption');
            const adopting = a.waitForResponse(v => new URL(v.url()).pathname === base + '/policies' && v.request().method() === 'POST');
            await q.getByRole('button', { name: 'Record material assignment policy', exact: true }).click();
            const adopted = await adopting;
            assert.equal(adopted.status(), 201);
            assert.deepEqual((await adopted.json()).policy.definition.workerIds, definition.workerIds, 'Real UI adopts explicit Unicode workers in existing PostgreSQL C order');
            await q.getByRole('article', { name: 'Material assignment policy 1', exact: true }).waitFor();
            await r.goto(url);
            let rp = await readSource(r);
            await rp.getByLabel('Proposed assignment percentage', { exact: true }).fill('25');
            await rp.getByLabel('Assignment proposal reason', { exact: true }).fill('Synthetic browser exact material proposal');
            const proposing = r.waitForResponse(v => new URL(v.url()).pathname === base + '/sources/' + assignment.id + '/proposals' && v.request().method() === 'POST');
            await rp.getByRole('button', { name: 'Submit material assignment proposal', exact: true }).click();
            const response = await proposing;
            assert.equal(response.status(), 201);
            const i = (await response.json()).instance;
            await rp.getByRole('article', { name: 'Current material assignment proposal', exact: true }).waitFor();
            assert.equal(await rp.getByRole('button', { name: 'Approve material assignment stage', exact: true }).count(), 0);
            const amount = async () => (await pool.query('select trim_scale(percentage)::text n from project_allocations where id=$1', [assignment.id])).rows[0].n;
            assert.equal(await amount(), '20');
            await stale.goto(url);
            await readSource(stale);
            await proposalPanel(stale).getByLabel('Proposed assignment percentage', { exact: true }).fill('26');
            await proposalPanel(stale).getByLabel('Assignment proposal reason', { exact: true }).fill('Synthetic retained stale material draft');
            const approve = async (p, id, reason) => { await p.goto(url); const box = await readProposal(p, id); await box.getByLabel('Material assignment decision reason', { exact: true }).fill(reason); const response = p.waitForResponse(v => new URL(v.url()).pathname === base + '/instances/' + id + '/decisions' && v.request().method() === 'POST'); await box.getByRole('button', { name: 'Approve material assignment stage', exact: true }).click(); const r = await response; assert.equal(r.status(), 201); await box.getByRole('article', { name: 'Material assignment decision receipt', exact: true }).waitFor(); return r.json(); };
            assert.equal((await approve(a, i.id, 'Synthetic first named assignment stage')).receipt.outcome.status, 'Pending');
            assert.equal(await amount(), '20');
            assert.equal((await approve(b, i.id, 'Synthetic final named assignment stage')).receipt.outcome.status, 'Approved');
            assert.equal(await amount(), '25');
            const sr = stale.waitForResponse(v => new URL(v.url()).pathname === base + '/sources/' + assignment.id + '/proposals' && v.request().method() === 'POST');
            await proposalPanel(stale).getByRole('button', { name: 'Submit material assignment proposal', exact: true }).click();
            assert.equal((await sr).status(), 409);
            await proposalPanel(stale).getByText('Write not confirmed. Read current history before another attempt.', { exact: true }).waitFor();
            assert.equal(await proposalPanel(stale).getByLabel('Assignment proposal reason', { exact: true }).inputValue(), 'Synthetic retained stale material draft');
            assert.equal(await proposalPanel(stale).getByLabel('Proposed assignment percentage', { exact: true }).inputValue(), '26');
            await w.goto(url);
            await w.getByRole('button', { name: 'My notifications', exact: true }).click();
            const inbox = w.getByRole('region', { name: 'Canonical work approval notifications', exact: true });
            await inbox.getByRole('button', { name: 'Load my governed notifications', exact: true }).click();
            const notice = inbox.getByRole('article').filter({ hasText: 'approval.completed' });
            await notice.waitFor();
            await notice.getByText(/Recipient reasons: affected_worker/).waitFor();
            await notice.getByRole('button', { name: /Mark governed notification read/ }).click();
            await notice.getByText(/In-app Enabled · Read /).waitFor();
            await inbox.getByRole('button', { name: 'Load my governed notifications', exact: true }).click();
            await inbox.getByText(/In-app Enabled · Read /).waitFor();
            await r.goto(url);
            rp = await readSource(r);
            assert.equal(await rp.getByLabel('Proposed assignment percentage', { exact: true }).inputValue(), '25');
            await readProposal(r, i.id);
            await rp.getByRole('region', { name: 'Immutable material assignment stage history', exact: true }).getByText(/Synthetic final named assignment stage/).waitFor();
            // Accepted late proposal is retained by the server but cannot repopulate old-owner UI.
            rp = await readSource(r);
            await rp.getByLabel('Proposed assignment percentage', { exact: true }).fill('27');
            await rp.getByLabel('Assignment proposal reason', { exact: true }).fill('Synthetic late accepted material proposal');
            const blocker = await pool.connect();
            let open = false;
            try {
                await blocker.query('begin');
                open = true;
                await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['commercial-lifecycle:' + f.organizationId + ':' + f.legalEntityId]);
                const sent = r.waitForRequest(v => new URL(v.url()).pathname === base + '/sources/' + assignment.id + '/proposals' && v.method() === 'POST'), reply = r.waitForResponse(v => new URL(v.url()).pathname === base + '/sources/' + assignment.id + '/proposals' && v.request().method() === 'POST');
                await rp.getByRole('button', { name: 'Submit material assignment proposal', exact: true }).click();
                await sent;
                await r.evaluate(() => window.dispatchEvent(new Event('workos:organization-scope-switch-requested')));
                await rp.getByText('Account, active role or scope changed. Reload explicitly.', { exact: true }).waitFor();
                await blocker.query('commit');
                open = false;
                assert.equal((await reply).status(), 201);
                assert.equal(await rp.getByRole('article', { name: 'Current material assignment proposal', exact: true }).count(), 0);
                assert.equal(await rp.getByLabel('Assignment proposal reason', { exact: true }).count(), 0);
            }
            finally {
                if (open)
                    await blocker.query('rollback');
                blocker.release();
            }
            assert.equal((await pool.query("select count(*)::int n from assignment_approval_instances where reason='Synthetic late accepted material proposal'")).rows[0].n, 1);
            assert.equal(await amount(), '25');
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
        }
        finally {
            if (browser)
                await browser.close();
            await vite.close();
        }
    });
});
console.log('Material assignment actual React policy/proposal -> two named stages -> effective source/version reload/history -> named worker canonical inbox/read/reload, stale draft and accepted late old-owner suppression passed without external delivery.');

// Connected source/state/history proof is part of this required gate.
await import('./e2-version-state-journey-browser-smoke.mjs');

// Configured creation approval is part of the required assignment gate.
await import('./assignment-creation-journey-browser-smoke.mjs');

await import('./reviewed-approval-batch-journey-browser-smoke.mjs');

// Configured prospective due handoff is part of this required gate.
await import('./approval-due-journey-browser-smoke.mjs');

// Independent staged-work/calendar-leave composite proof.
await import('./staged-leave-journey-browser-smoke.mjs');

// Configured canonical leave end-to-end proof is part of this required gate.
await import('./leave-approval-journey-browser-smoke.mjs');

// Prospective configured canonical delegation is part of this required gate.
await import('./canonical-delegation-journey-browser-smoke.mjs');

// Existing import-to-approved-actual/export composite proof.
await import('./import-approval-export-journey-browser-smoke.mjs');

// Connected imported source -> delegated stage/revocation -> immutable actual export.
await import('./import-delegation-journey-browser-smoke.mjs');

// Configured prospective reminder authority is part of this required gate.
await import('./approval-reminder-journey-browser-smoke.mjs');

// Scoped operational-control workflow retains the original per-item approval gates.
await import('./operational-control-journey-browser-smoke.mjs');

// Canonical own workspace retains the original per-item source gates.
await import('./own-workspace-journey-browser-smoke.mjs');

// Scoped directory relationship/handoff workflow is part of this required gate.
await import('./workforce-directory-journey-browser-smoke.mjs');

// Explicit prospective legal-entity calendar authoring and connected capacity workflow.
await import('./calendar-authoring-journey-browser-smoke.mjs');

// Explicit country/group authoring and original native capacity precedence.
await import('./calendar-scope-journey-browser-smoke.mjs');

// Six-family business structure, retained sources and unused-node retirement.
await import('./business-structure-journey-browser-smoke.mjs');

// Explicit catalog-to-workforce classification and historical source preservation.
await import('./workforce-classification-journey-browser-smoke.mjs');

// Reviewed canonical exit impact and retained lifecycle receipts.
await import('./reviewed-worker-exit-journey-browser-smoke.mjs');

// Explicit configured worker types and retained scoped adoption.
await import('./worker-type-journey-browser-smoke.mjs');

// Protected rate/cost candidates and non-authoritative resolution preview.
await import('./rate-candidate-journey-browser-smoke.mjs');
await import('./commercial-owner-journey-browser-smoke.mjs');
await import('./commercial-approval-journey-browser-smoke.mjs');

// Real approved source adoption and native resolution across billing and cost.
await import('./rate-adoption-journey-browser-smoke.mjs');

// Protected T&M workspace: approved work and adopted native rate sources.
await import('./governed-tm-journey-browser-smoke.mjs');
