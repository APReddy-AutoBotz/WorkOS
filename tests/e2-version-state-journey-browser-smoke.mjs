import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { seedAssignmentApproval, ASSIGNMENT_APPROVAL_BASE as assignments } from './support/assignment-approval-test.mjs';
import { WORK_APPROVAL_BASE as work } from './support/work-approval-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
import { configureE2, proveE2, e2Paths, digest } from './support/e2-version-state-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool);
  const fx = await seedAssignmentApproval(pool), { identities: ids, today } = fx, paths = e2Paths(today);
  await withCommercialApi({ databaseUrl, identities: ids, timeZone: 'Pacific/Kiritimati' }, async ({ request, tokenFor, baseUrl: apiUrl }) => {
    const assignment = await configureE2(request, fx);
    const vite = await createServer({ root, mode: 'production', clearScreen: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiUrl, changeOrigin: true } } }, define: { 'import.meta.env.VITE_APP_MODE': JSON.stringify('production'), 'import.meta.env.VITE_ALLOW_TEST_FALLBACK': JSON.stringify('false') } });
    let browser;
    try {
      await vite.listen();
      const origin = 'http://127.0.0.1:' + vite.httpServer.address().port, url = origin + '/tests/fixtures/e2-version-state.html';
      browser = await chromium.launch({ headless: true });
      const errors = [], external = [], pages = new Map();
      const make = async (identity, extra = '') => {
        const context = await browser.newContext({ viewport: { width: 1800, height: 1300 }, timezoneId: 'Pacific/Kiritimati', acceptDownloads: true });
        const permissions = identity === ids.reader ? ['employees.view', 'projects.view', 'timesheets.submit', 'employee_workspace.view', 'notifications.view'] : [...workPermissions, 'reports.view_utilization', 'employees.manage', 'permissions.manage', 'notifications.manage', 'notifications.view'];
        await context.addInitScript(({ session, scope, token }) => { sessionStorage.setItem('workos_session', JSON.stringify(session)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token); }, { session: { id: identity.employeeRecordId ?? identity.id, employeeId: identity.employeeId ?? identity.id, userName: identity.username, name: 'Synthetic E2 actor', role: identity.role, permissionRole: identity.role, permissions }, scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId }, token: tokenFor(identity) });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        page.on('pageerror', e => errors.push(e.stack ?? e.message));
        page.on('request', q => { if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin) external.push(q.url()); });
        pages.set(identity.id + extra, page); await page.goto(url); return page;
      };
      const manager = await make(ids.manager), second = await make(ids.second), requester = await make(ids.requester), worker = await make(ids.reader), forecast = await make(ids.manager, '-forecast'), stale = await make(ids.manager, '-stale');
      const region = (page, name) => page.getByRole('region', { name, exact: true });
      const response = (page, path, method = 'GET') => page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method);
      const result = async (pending, status = 200) => { const r = await pending; assert.equal(r.status(), status, await r.text()); return r.json(); };
      const navigate = async (page, name) => { await page.getByRole('button', { name, exact: true }).click(); };
      const setupNative = async page => {
        await navigate(page, 'E2 native forecast'); await page.getByRole('button', { name: 'Use native percentage forecast', exact: true }).click();
        const q = region(page, 'Native percentage forecast');
        await q.getByRole('button', { name: 'Load forecast workers', exact: true }).click();
        await q.getByLabel('Forecast worker', { exact: true }).selectOption(f.ownerId);
        await q.getByLabel('Forecast as-of date', { exact: true }).fill(today);
        await q.getByLabel('Native forecast horizon', { exact: true }).selectOption('3');
      };
      const calculateNative = async page => { const pending = response(page, paths.native + '/period'); await region(page, 'Native percentage forecast').getByRole('button', { name: 'Calculate native forecast', exact: true }).click(); return result(pending); };
      await setupNative(forecast); await setupNative(stale); await calculateNative(stale);
      await navigate(manager, 'E2 actual report'); await manager.getByRole('button', { name: 'Use governed period', exact: true }).click();
      const report = region(manager, 'Governed actual work report');
      await report.getByRole('button', { name: 'Load governed workers', exact: true }).click();
      await report.getByLabel('Governed actual worker', { exact: true }).selectOption(f.ownerId);
      await report.getByLabel('Actual period starts', { exact: true }).fill(today); await report.getByLabel('Actual period ends', { exact: true }).fill(today);
      // Separate report page keeps its current actual result while approver pages
      // navigate stages. No mocked response, source edit or approval is involved.
      const approver = await make(ids.manager, '-approver');
      const loadWork = async (page, id) => {
        await navigate(page, 'E2 approvals'); const q = region(page, 'Governed work approval inbox');
        await q.getByLabel('Approval instance reference', { exact: true }).fill(id);
        const pending = response(page, work + '/instances/' + id);
        await q.getByRole('button', { name: 'Load current work approval', exact: true }).click();
        await result(pending);
        await q.getByRole('article', { name: 'Current governed work approval', exact: true }).waitFor(); return q;
      };
      const loadProposal = async (page, id) => {
        await navigate(page, 'E2 approvals'); const q = region(page, 'Material assignment proposals');
        await q.getByRole('button', { name: 'Load material assignment proposals', exact: true }).click();
        const pending = response(page, assignments + '/instances/' + id);
        await q.getByRole('button', { name: 'Inspect material proposal ' + id, exact: true }).click();
        await result(pending);
        await q.getByRole('article', { name: 'Current material assignment proposal', exact: true }).waitFor(); return q;
      };
      const retainUi = async (kind, page, status = 201) => {
        const q = region(page, kind === 'native' ? 'Native percentage forecast' : 'Governed actual work report'), live = q.getByRole('article', { name: kind === 'native' ? 'Current native forecast' : 'Current governed actual calculation', exact: true });
        await live.getByLabel(kind === 'native' ? 'Forecast export reason' : 'Actual calculation/export reason', { exact: true }).fill('Synthetic connected E2 ' + kind);
        const pending = response(page, paths[kind] + '/evidence', 'POST'), download = status === 201 ? page.waitForEvent('download') : null;
        await live.getByRole('button', { name: kind === 'native' ? 'Retain forecast and download CSV' : 'Retain calculation and download CSV', exact: true }).click();
        const body = await result(pending, status);
        if (download) { const bytes = await readFile(await (await download).path()); assert.equal(digest(bytes), body.evidence.artifact.sha256); assert.equal(bytes.toString('utf8'), body.csv); }
        return { status, body };
      };
      const ownPlanning = async () => {
        await navigate(worker, 'E2 own period'); const q = region(worker, 'My authoritative period');
        await q.getByLabel('My period starts', { exact: true }).fill(today); await q.getByLabel('My period ends', { exact: true }).fill(today);
        const pending = response(worker, '/api/v1/my-work-planning'); await q.getByRole('button', { name: 'Load my period', exact: true }).click(); return result(pending);
      };
      await proveE2({ pool, request, fx, assignment, hooks: {
        native: () => calculateNative(forecast),
        actual: async () => { const pending = response(manager, paths.actual + '/period'); await report.getByRole('button', { name: 'Calculate governed actual', exact: true }).click(); return result(pending); },
        retain: async kind => (await retainUi(kind, kind === 'native' ? forecast : manager)).body,
        workDecision: async (identity, instance) => {
          const page = identity === ids.manager ? approver : second, q = await loadWork(page, instance.id);
          await q.getByRole('region', { name: 'Retained work for this approval', exact: true }).getByText('Synthetic E2 four approved project hours', { exact: false }).waitFor();
          await q.getByLabel('Work approval decision reason', { exact: true }).fill('Synthetic E2 named work stage');
          const pending = response(page, work + '/instances/' + instance.id + '/decisions', 'POST'); await q.getByRole('button', { name: 'Approve current work stage', exact: true }).click();
          const body = await result(pending, 201); await q.getByRole('article', { name: 'Recorded work stage receipt', exact: true }).waitFor(); return body;
        },
        ownActual: async () => { await ownPlanning(); const q = region(worker, 'My governed actual work'), pending = response(worker, '/api/v1/my-actual-work/period'); await q.getByRole('button', { name: 'Calculate my governed actual', exact: true }).click(); const body = await result(pending); await q.getByRole('article', { name: 'Current governed actual calculation', exact: true }).getByText(/50%/).waitFor(); return body; },
        ownPlanning,
        propose: async () => {
          await navigate(requester, 'E2 approvals'); const q = region(requester, 'Material assignment proposals');
          await q.getByLabel('Assignment proposal source', { exact: true }).fill(assignment.id); await q.getByRole('button', { name: 'Load assignment proposal source', exact: true }).click();
          await q.getByLabel('Proposed assignment percentage', { exact: true }).fill('25'); await q.getByLabel('Assignment proposal reason', { exact: true }).fill('Synthetic E2 material proposal');
          const pending = response(requester, assignments + '/sources/' + assignment.id + '/proposals', 'POST'); await q.getByRole('button', { name: 'Submit material assignment proposal', exact: true }).click(); return result(pending, 201);
        },
        assignmentDecision: async (identity, instance, decision) => {
          const page = identity === ids.manager ? approver : second, q = await loadProposal(page, instance.id);
          await q.getByLabel('Material assignment decision reason', { exact: true }).fill('Synthetic E2 named assignment ' + decision);
          const pending = response(page, assignments + '/instances/' + instance.id + '/decisions', 'POST'); await q.getByRole('button', { name: (decision === 'Rejected' ? 'Reject' : 'Approve') + ' material assignment stage', exact: true }).click();
          const body = await result(pending, 201); await q.getByRole('article', { name: 'Material assignment decision receipt', exact: true }).waitFor(); return body;
        },
        staleNative: () => retainUi('native', stale, 409),
        artifact: async (kind, retained) => {
          const page = kind === 'native' ? forecast : manager, q = region(page, kind === 'native' ? 'Native percentage forecast' : 'Governed actual work report');
          await q.getByRole('button', { name: kind === 'native' ? 'Load retained forecasts' : 'Load retained actual calculations', exact: true }).click();
          await q.getByRole('article', { name: kind === 'native' ? 'Retained forecast 1' : 'Retained actual calculation 1', exact: true }).waitFor();
          const download = page.waitForEvent('download'); await q.getByRole('button', { name: kind === 'native' ? 'Download retained forecast CSV 1' : 'Download retained actual CSV 1', exact: true }).click();
          const bytes = await readFile(await (await download).path()); assert.equal(bytes.toString('utf8'), retained.csv); assert.equal(digest(bytes), retained.evidence.artifact.sha256);
        },
        history: async ({ workId, approvedId, rejectedId }) => {
          const q = await loadWork(approver, workId);
          assert.equal(await q.getByRole('region', { name: 'Immutable work stage history', exact: true }).getByRole('article').count(), 2);
          await q.getByRole('region', { name: 'Retained work for this approval', exact: true }).getByText('Synthetic E2 four approved project hours', { exact: false }).waitFor();
          for (const [id, count] of [[approvedId, 2], [rejectedId, 1]]) { const p = await loadProposal(requester, id), rows = p.getByRole('region', { name: 'Immutable material assignment stage history', exact: true }).locator('p'); await rows.first().waitFor(); assert.equal(await rows.count(), count); }
          await navigate(worker, 'E2 notifications'); const inbox = region(worker, 'Canonical work approval notifications'); await inbox.getByRole('button', { name: 'Load my governed notifications', exact: true }).click();
          const notes = inbox.getByRole('article').filter({ hasText: 'approval.completed' }); await notes.first().waitFor(); assert.equal(await notes.count(), 2, 'Both work and effective assignment completion are visible to the named worker');
          await notes.first().getByRole('button', { name: /Mark governed notification read/ }).click(); await notes.first().getByText(/In-app Enabled · Read /).waitFor();
        },
      } });
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await browser?.close(); await vite.close(); }
  });
});
console.log('Connected E2 real React decisions/own/report/native/inbox/history/server CSV downloads -> authenticated API -> PostgreSQL passed; real current-day named API submission is explicitly distinguished from UI submission. No mocks, fake clock, conversion, UAT/review or full milestone acceptance claim.');
