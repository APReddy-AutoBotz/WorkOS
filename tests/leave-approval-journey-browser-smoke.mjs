import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import { chromium } from 'playwright';
import { commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi } from './support/commercial-drafting-test.mjs';
import { seedWorkApproval } from './support/work-approval-test.mjs';
import { workPermissions } from './support/work-assignment-test.mjs';
import { configureStagedLeave, proveStagedLeave, stagedLeavePaths, stagedLeaveDigest } from './support/staged-leave-test.mjs';
import {currentLeaveReview,readLeaveReview,leaveCommand,leaveCapacity,proveConfiguredLeaveStages} from './support/leave-approval-test.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({ pool, databaseUrl }) => {
  await migrateCommercialDatabase(pool); const fx = await seedWorkApproval(pool), { today, identities: ids } = fx, paths = stagedLeavePaths(today);
  // Same existing synthetic self-service capability as calendar-leave acceptance.
  await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Employee','leave.self_service',true)on conflict(role_name,permission_key)do update set enabled=true");
  await withCommercialApi({enableLeave:true,  databaseUrl, identities: ids, timeZone: 'Pacific/Kiritimati' }, async ({ request, tokenFor, baseUrl: apiUrl }) => {
    await configureStagedLeave(request, fx);
    const fixtureServer = await startFixtureServer({root, fixtures:['configured-leave'], apiUrl});
    let browser;
    try {
      const origin = fixtureServer.url, errors = [], external = [];
      browser = await chromium.launch({ headless: true });
      const make = async identity => {
        const c = await browser.newContext({ viewport: { width: 1800, height: 1400 }, timezoneId: 'Pacific/Kiritimati', acceptDownloads: true });
        const permissions = identity === ids.reader ? ['employees.view', 'projects.view', 'timesheets.submit', 'employee_workspace.view', 'notifications.view', 'leave.self_service'] : [...workPermissions, 'reports.view_utilization', 'employees.manage', 'permissions.manage', 'notifications.manage', 'notifications.view', 'leave.self_service', 'leave.approve', 'leave.admin'];
        await c.addInitScript(({ user, scope, token }) => { sessionStorage.setItem('workos_session', JSON.stringify(user)); sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope)); sessionStorage.setItem('workos_api_token', token); }, { user: { id: identity.employeeRecordId ?? identity.id, employeeId: identity.employeeId ?? identity.id, userName: identity.username, name: 'Synthetic staged leave actor', role: identity.role, permissionRole: identity.role, permissions }, scope: { organizationId: f.organizationId, legalEntityId: f.legalEntityId }, token: tokenFor(identity) });
        const p = await c.newPage(); p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push(e.stack ?? e.message)); p.on('request', q => { if (/^https?:/.test(q.url()) && new URL(q.url()).origin !== origin) external.push(q.url()); }); await p.goto(origin + '/tests/fixtures/configured-leave.html'); return p;
      };
      const first = await make(ids.manager), second = await make(ids.second), reportPage = await make(ids.manager), leaveManager = await make(ids.manager), leaveSecond = await make(ids.second), worker = await make(ids.reader), leaveWorker = await make(ids.reader);
      const region = (p, name) => p.getByRole('region', { name, exact: true }), nav = (p, name) => p.getByRole('button', { name, exact: true }).click();
      const reply = (p, path, method = 'GET') => p.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method);
      const result = async (pending, expected = 200) => { const r = await pending; assert.equal(r.status(), expected, await r.text()); return r.json(); };
      await nav(reportPage, 'Actual report and exports'); await reportPage.getByRole('button', { name: 'Use governed period', exact: true }).click();
      const report = region(reportPage, 'Governed actual work report'); await report.getByRole('button', { name: 'Load governed workers', exact: true }).click(); await report.getByLabel('Governed actual worker', { exact: true }).selectOption(f.ownerId); await report.getByLabel('Actual period starts', { exact: true }).fill(today); await report.getByLabel('Actual period ends', { exact: true }).fill(today);
      // Adopt the new policy using the real configuration editor, not a fixture
      // route, seeded policy or API shortcut.
      await nav(leaveManager,'Staged work approvals');
      const config=region(leaveManager,'Configured leave approval policy');
      await config.getByRole('button',{name:'Load leave approval configuration',exact:true}).click();
      await config.getByLabel('Leave policy workers',{exact:true}).selectOption(f.ownerId);
      await config.getByLabel('Leave policy effective date',{exact:true}).fill(today);
      await config.getByLabel('Leave stage 1 account',{exact:true}).selectOption(ids.manager.id);
      await config.getByLabel('Leave stage 1 role',{exact:true}).selectOption('Admin');
      await config.getByRole('button',{name:'Add leave approval stage',exact:true}).click();
      await config.getByLabel('Leave stage 2 account',{exact:true}).selectOption(ids.second.id);
      await config.getByLabel('Leave stage 2 role',{exact:true}).selectOption('Admin');
      await config.getByLabel('Time allowed per stage (minutes, optional)',{exact:true}).fill('15');
      await config.getByLabel('Remind approvers before the deadline (minutes, optional)',{exact:true}).fill('5');
      await config.getByLabel('Leave template locale',{exact:true}).fill('en-GB');
      for(const label of ['Action request','Correction','Completion']){await config.getByLabel('Leave '+label+' title',{exact:true}).fill('Leave {{sourceRef}}');await config.getByLabel('Leave '+label+' body',{exact:true}).fill('Worker {{workerCode}} stage {{stageNumber}}.');}
      await config.getByLabel('Leave informational completion in-app',{exact:true}).selectOption('enabled');
      await config.getByLabel('Leave policy adoption reason',{exact:true}).fill('Synthetic explicit configured leave flow');
      const policyReply=reply(leaveManager,paths.work+'/leave/policies','POST');
      await config.getByRole('button',{name:'Record prospective leave approval policy',exact:true}).click();await result(policyReply,201);
      const decideLeaveOnUI=async(identity,current,reason,decision='Approved')=>{
const p=identity===ids.manager?leaveManager:leaveSecond;await nav(p,'Staged work approvals');const q=region(p,'Configured leave approval inbox');await q.getByRole('button',{name:'Show overdue configured leave approvals',exact:true}).click();
await q.getByText('No overdue stages in your current scope.',{exact:true}).waitFor();
await q.getByLabel('Leave approval instance',{exact:true}).fill(current.id);let pending=reply(p,paths.work+'/leave/instances/'+current.id);await q.getByRole('button',{name:'Inspect current leave approval',exact:true}).click();const inspected = await result(pending); await q.getByText(inspected.instance.stageDeadline.dueAt,{exact:true}).first().waitFor();await q.getByRole('region',{name:'Retained leave source',exact:true}).getByText('1 day(s)',{exact:false}).waitFor();await q.getByLabel('Leave stage decision reason',{exact:true}).fill(reason);pending=reply(p,paths.work+'/leave/instances/'+current.id+'/decisions','POST');await q.getByRole('button',{name:decision==='Approved'?'Approve current leave stage':'Reject current leave stage',exact:true}).click();const out=await result(pending,201);await q.getByRole('article',{name:'Configured leave stage receipt',exact:true}).waitFor();return out;
      };
      await proveStagedLeave({ pool, request, fx, hooks: {
        actual: async () => { const pending = reply(reportPage, paths.actual + '/period'); await report.getByRole('button', { name: 'Calculate governed actual', exact: true }).click(); const body = await result(pending); await report.getByRole('article', { name: 'Current governed actual calculation', exact: true }).waitFor(); return body; },
        own: async () => {
          await nav(worker, 'Own capacity and actual'); const own = region(worker, 'My authoritative period'); await own.getByLabel('My period starts', { exact: true }).fill(today); await own.getByLabel('My period ends', { exact: true }).fill(today); let pending = reply(worker, '/api/v1/my-work-planning'); await own.getByRole('button', { name: 'Load my period', exact: true }).click(); const planning = await result(pending);
          const actual = region(worker, 'My governed actual work'); pending = reply(worker, '/api/v1/my-actual-work/period'); await actual.getByRole('button', { name: 'Calculate my governed actual', exact: true }).click(); const body = await result(pending); await actual.getByText(body.result.status === 'not_applicable' ? 'Not applicable' : body.result.percentage.displayPercent + '%', { exact: false }).first().waitFor(); return { planning, actual: body };
        },
        workDecision: async (identity, instance, reason) => {
          const p = identity === ids.manager ? first : second; await nav(p, 'Staged work approvals'); const q = region(p, 'Governed work approval inbox'); await q.getByLabel('Approval instance reference', { exact: true }).fill(instance.id); let pending = reply(p, paths.work + '/instances/' + instance.id); await q.getByRole('button', { name: 'Load current work approval', exact: true }).click(); await result(pending);
          await q.getByRole('region', { name: 'Retained work for this approval', exact: true }).getByText('Synthetic staged leave four approved project hours', { exact: false }).waitFor(); await q.getByLabel('Work approval decision reason', { exact: true }).fill(reason); pending = reply(p, paths.work + '/instances/' + instance.id + '/decisions', 'POST'); await q.getByRole('button', { name: 'Approve current work stage', exact: true }).click(); const body = await result(pending, 201); await q.getByRole('article', { name: 'Recorded work stage receipt', exact: true }).waitFor(); return body;
        },
        retain: async () => { const live = report.getByRole('article', { name: 'Current governed actual calculation', exact: true }); await live.getByLabel('Actual calculation/export reason', { exact: true }).fill('Synthetic staged leave retained actual'); const pending = reply(reportPage, paths.actual + '/evidence', 'POST'), download = reportPage.waitForEvent('download'); await live.getByRole('button', { name: 'Retain calculation and download CSV', exact: true }).click(); const body = await result(pending, 201), bytes = await readFile(await (await download).path()); assert.equal(bytes.toString('utf8'), body.csv); assert.equal(stagedLeaveDigest(bytes), body.evidence.artifact.sha256); return body; },
        artifact: async saved => { await report.getByRole('button', { name: 'Load retained actual calculations', exact: true }).click(); await report.getByRole('article', { name: 'Retained actual calculation ' + saved.evidence.sequence, exact: true }).waitFor(); const pending = reply(reportPage, paths.actual + '/evidence/' + saved.evidence.id + '/artifact'), download = reportPage.waitForEvent('download'); await report.getByRole('button', { name: 'Download retained actual CSV ' + saved.evidence.sequence, exact: true }).click(); const body = await result(pending), bytes = await readFile(await (await download).path()); assert.equal(bytes.toString('utf8'), body.csv); assert.equal(stagedLeaveDigest(bytes), saved.evidence.artifact.sha256); return body; },
        createLeave: async () => { await nav(leaveWorker, 'My calendar leave'); const q = region(leaveWorker, 'Request calendar authority'); await leaveWorker.getByLabel('Start', { exact: true }).fill(today); await leaveWorker.getByLabel('End', { exact: true }).fill(today); await leaveWorker.getByLabel('Reason', { exact: true }).fill('Synthetic staged leave current full-day request'); let pending = reply(leaveWorker, paths.quote); await q.getByRole('button', { name: 'Calculate leave dates', exact: true }).click(); const { quote } = await result(pending); assert.equal(quote.totalDaysExact, '1'); pending = reply(leaveWorker, '/api/leave/requests', 'POST'); await leaveWorker.getByRole('button', { name: 'Submit Request', exact: true }).click(); const leave = await result(pending); await leaveWorker.getByText('Leave request submitted for approval.', { exact: true }).waitFor(); return { quote, leave }; },
        approveLeave: async id => {
          await proveConfiguredLeaveStages({pool,request,fx,id,hooks:{
            decide:decideLeaveOnUI,
            read:async note=>{
              await nav(leaveWorker,'My canonical notices');const q=region(leaveWorker,'Canonical work approval notifications');let inboxReply=reply(leaveWorker,paths.work+'/inbox');await q.getByRole('button',{name:'Load my governed notifications',exact:true}).click();let inbox=await result(inboxReply);while(!inbox.notifications.some(n=>n.id===note.id)){assert(inbox.nextAfter,'Expected retained leave notice in the bounded owned inbox');inboxReply=reply(leaveWorker,paths.work+'/inbox');await q.getByRole('button',{name:'More governed notifications',exact:true}).click();inbox=await result(inboxReply);}const article=q.getByRole('article',{name:'Governed notification '+note.id,exact:true});await article.waitFor();const pending=reply(leaveWorker,paths.work+'/inbox/'+note.id+'/read','POST');await article.getByRole('button',{name:'Mark governed notification read '+note.id,exact:true}).click();await result(pending);await article.getByText(/Read /).waitFor();await nav(leaveWorker,'My canonical notices');await q.getByRole('button',{name:'Load my governed notifications',exact:true}).click();
            }
          }});
        },
        cancelLeave: async id => { await nav(leaveWorker, 'My calendar leave'); const pending = reply(leaveWorker, '/api/leave/requests/' + id + '/cancel', 'PATCH'); await leaveWorker.getByRole('button', { name: 'Cancel', exact: true }).click(); await result(pending); await leaveWorker.getByText('Leave request cancelled.', { exact: true }).waitFor(); },
        history: async ({ workId }) => { await nav(leaveWorker, 'My calendar leave'); await leaveWorker.getByRole('button', { name: 'Calendar history', exact: true }).click(); await leaveWorker.getByRole('article', { name: 'Leave calendar revision 1', exact: true }).waitFor(); await nav(first, 'Staged work approvals'); const q = region(first, 'Governed work approval inbox'); await q.getByLabel('Approval instance reference', { exact: true }).fill(workId); const pending = reply(first, paths.work + '/instances/' + workId); await q.getByRole('button', { name: 'Load current work approval', exact: true }).click(); const body = await result(pending); assert.equal(body.instance.state.status, 'Approved'); assert.equal(body.instance.transitions.length, 2); await q.getByText(/Synthetic staged leave four approved project hours/).waitFor(); },
      } });
      // A separate real UI source-edit/rejection journey preserves the unchanged
      // composite's retained calendar/CSV assertions instead of relaxing them.
      await nav(leaveWorker,'My calendar leave');await leaveWorker.getByLabel('Start',{exact:true}).fill(today);await leaveWorker.getByLabel('End',{exact:true}).fill(today);await leaveWorker.getByLabel('Reason',{exact:true}).fill('Synthetic separate editable leave source');let response=reply(leaveWorker,paths.quote);await region(leaveWorker,'Request calendar authority').getByRole('button',{name:'Calculate leave dates',exact:true}).click();await result(response);response=reply(leaveWorker,'/api/leave/requests','POST');await leaveWorker.getByRole('button',{name:'Submit Request',exact:true}).click();const editable=await result(response);await leaveWorker.getByText('Leave request submitted for approval.',{exact:true}).waitFor();
      const oldReview=await currentLeaveReview(request,editable.id);await decideLeaveOnUI(ids.manager,oldReview,'Synthetic leave stage before source edit');const oldPending=await readLeaveReview(request,oldReview.id);assert.equal(oldPending.state.sequence,1);assert.equal(await leaveCapacity(request,today,ids.reader),'8');
      await leaveWorker.getByRole('button',{name:'Edit',exact:true}).click();await leaveWorker.getByLabel('Reason',{exact:true}).fill('Synthetic revised leave source after intermediate approval');response=reply(leaveWorker,paths.quote);await region(leaveWorker,'Request calendar authority').getByRole('button',{name:'Calculate leave dates',exact:true}).click();await result(response);response=reply(leaveWorker,'/api/leave/requests/'+editable.id,'PATCH');await leaveWorker.getByRole('button',{name:'Save Changes',exact:true}).click();await result(response);await leaveWorker.getByText('Leave request updated.',{exact:true}).waitFor();
      const fresh=await currentLeaveReview(request,editable.id);assert.equal(fresh.revision,2);assert.equal(fresh.state.sequence,0);assert.equal(fresh.policy.id,oldReview.policy.id);assert.notEqual(fresh.sourceToken,oldReview.sourceToken);assert.deepEqual((await readLeaveReview(request,oldReview.id)).transitions,oldPending.transitions);
      const stale=await request(paths.work+'/leave/instances/'+oldReview.id+'/decisions',{method:'POST',identity:ids.second,body:await leaveCommand(request,ids.second,oldPending)});assert.equal(stale.status,409);
      await nav(leaveSecond,'Staged work approvals');const staleUi=region(leaveSecond,'Configured leave approval inbox');await staleUi.getByLabel('Leave approval instance',{exact:true}).fill(oldReview.id);response=reply(leaveSecond,paths.work+'/leave/instances/'+oldReview.id);await staleUi.getByRole('button',{name:'Inspect current leave approval',exact:true}).click();await result(response);await staleUi.getByText('Retained review; decisions are unavailable.',{exact:false}).waitFor();assert.equal(await staleUi.getByRole('button',{name:'Approve current leave stage',exact:true}).count(),0);
      await decideLeaveOnUI(ids.manager,fresh,'Synthetic fresh retained leave review');const pending=await readLeaveReview(request,fresh.id);await decideLeaveOnUI(ids.second,pending,'Synthetic named leave rejection','Rejected');assert.equal((await readLeaveReview(request,fresh.id)).state.status,'Rejected');assert.equal(await leaveCapacity(request,today,ids.reader),'8');
      console.log('Real UI Submitted edit after an intermediate leave stage retained old history, created fresh pinned review, hid stale decision controls, rejected old API token and completed named rejection with unchanged capacity.');
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      console.log('Configured named leave stages -> staged work/current full-day leave approval/cancellation -> own/report exact ratio and immutable downloaded CSV/history passed through actual React/API/PostgreSQL. Real UTC date; API submission distinguished from UI approval/request/export. No UAT, conversion or full milestone claim.');
    } finally { await browser?.close(); await fixtureServer.close(); }
  });
});
