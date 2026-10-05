import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PipeCdpClient,
  readChromeProcessDiagnostics,
  removeProfile,
  resolveChromeExecutable,
  terminateProcessTree,
} from '../../../retained-wos01-controller/.github/scripts/wos01a-browser-lifecycle-v2.mjs';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
const origin = process.env.WOS_BROWSER_ORIGIN || 'http://127.0.0.1:4339';
const evidenceFile = process.env.WOS_CHROME_HANDSHAKE_EVIDENCE
  || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'wos02-multiscope-browser-evidence.json');
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const { Pool } = requireFromTarget('pg');
const pool = new Pool({ connectionString: databaseUrl });
const pg = await pool.query(`
  select u.id, count(*)::int as scopes
  from users u join user_organization_scopes s on s.user_id=u.id and s.active
  where u.username='final-admin' and u.status='Active'
    and s.organization_id='org-final' and s.legal_entity_id in ('legal-a','legal-b')
  group by u.id
`);
assert.equal(pg.rows.length, 1, 'the synthetic multi-scope Admin fixture must exist');
assert.equal(pg.rows[0].scopes, 2, 'the synthetic Admin must have exactly two active legal-entity scopes');

const port = Number(new URL(origin).port || 4339);
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-multiscope-browser-acceptance-secret',
    API_PORT: String(port),
    PORT: String(port),
    APP_MODE: 'test',
    ALLOW_TEST_FALLBACK: 'false',
    LOCAL_LOGIN_ENABLED: 'true',
    SERVE_STATIC: 'true',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
const appendServerLog = chunk => { serverLog = `${serverLog}${chunk.toString()}`.slice(-32_768); };
server.stdout.on('data', appendServerLog);
server.stderr.on('data', appendServerLog);

let chrome;
let client;
let targetId;
let sessionId;
let profileDir;
let cleanupPromise;
let evidence = { status: 'starting', startedAt: new Date().toISOString(), origin };
const writeEvidence = async patch => {
  Object.assign(evidence, patch, { updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
};
const cleanup = () => cleanupPromise ||= (async () => {
  if (client) {
    if (sessionId) await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
    await client.send('Browser.close').catch(() => {});
    await client.close();
  }
  if (chrome?.pid) await terminateProcessTree(chrome);
  if (profileDir) await removeProfile(profileDir);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  await pool.end();
})();
const cleanupForSignal = code => cleanup().then(() => process.exit(code), error => { console.error(error); process.exit(1); });
process.on('SIGINT', () => { void cleanupForSignal(130); });
process.on('SIGTERM', () => { void cleanupForSignal(143); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${label} timed out. Last value: ${JSON.stringify(last)}\nServer log: ${serverLog}`);
};
const evaluate = async expression => {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text || 'unknown exception'}`);
  return result.result?.value;
};

try {
  await waitFor(async () => {
    try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) }); return response.status < 500; }
    catch { return false; }
  }, 'local API/static server readiness');

  const chromeResolution = await resolveChromeExecutable([
    process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  ].filter(Boolean));
  profileDir = await mkdtemp(path.join(os.tmpdir(), 'workos-multiscope-chrome-'));
  chrome = spawn(chromeResolution.executable, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--no-first-run',
    '--remote-debugging-pipe', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  let chromeOutput = '';
  const appendChromeOutput = chunk => { chromeOutput = `${chromeOutput}${chunk.toString()}`.slice(-32_768); };
  chrome.stdout.on('data', appendChromeOutput);
  chrome.stderr.on('data', appendChromeOutput);
  await new Promise((resolve, reject) => { chrome.once('spawn', resolve); chrome.once('error', reject); });
  await sleep(100);
  const processDiagnostics = await readChromeProcessDiagnostics(chrome.pid);
  const actualExecutable = processDiagnostics.executable.replace(/ \(deleted\)$/, '');
  const versionResult = actualExecutable.startsWith('<unavailable:') ? null : spawnSync(actualExecutable, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const chromeVersion = `${versionResult?.stdout || ''}\n${versionResult?.stderr || ''}`.trim();
  if (!versionResult || versionResult.error || versionResult.status !== 0 || !/\b(?:Google Chrome|Chrome for Testing|Chromium)\b/i.test(chromeVersion)) {
    throw new Error(`Spawned process is not a trusted Chrome/Chromium executable: ${JSON.stringify({ processDiagnostics, chromeVersion })}`);
  }
  if (!/^(?:pipe|socket):\[\d+\]$/.test(processDiagnostics.fd3)
      || !/^(?:pipe|socket):\[\d+\]$/.test(processDiagnostics.fd4)
      || processDiagnostics.fd3 === processDiagnostics.fd4) {
    throw new Error(`Chrome DevTools pipes are not distinct open kernel channels: ${JSON.stringify(processDiagnostics)}`);
  }
  client = new PipeCdpClient(chrome.stdio[4], chrome.stdio[3]);
  const browserVersion = await client.send('Browser.getVersion');
  if (!browserVersion?.protocolVersion || !/\b(?:Chrome|Chromium)\//i.test(String(browserVersion.product || ''))) {
    throw new Error(`Chrome returned invalid Browser.getVersion identity: ${JSON.stringify(browserVersion)}`);
  }
  ({ targetId } = await client.send('Target.createTarget', { url: 'about:blank' }));
  ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }));
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__workosScopeTrace = [];
    window.fetch = async (input, init = {}) => {
      const rawUrl = typeof input === 'string' ? input : input.url;
      const requestHeaders = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      const entry = {
        path: new URL(rawUrl, location.href).pathname,
        method: init.method || (input instanceof Request ? input.method : 'GET'),
        authorizationPresent: Boolean(requestHeaders.get('authorization')),
        organizationId: requestHeaders.get('x-organization-id'),
        legalEntityId: requestHeaders.get('x-legal-entity-id'),
      };
      window.__workosScopeTrace.push(entry);
      try { const response = await originalFetch(input, init); entry.status = response.status; return response; }
      catch (error) { entry.error = String(error); throw error; }
    };
  })();` }, sessionId);

  await writeEvidence({ status: 'chrome-ready', chromeResolution, chromeVersion, processDiagnostics, browserVersion, targetId, sessionId });
  const navigate = async url => {
    const response = await client.send('Page.navigate', { url }, sessionId);
    if (response.errorText) throw new Error(`Browser navigation failed for ${url}: ${response.errorText}`);
  };

  await navigate(`${origin}/login`);
  await waitFor(async () => (await evaluate(`({path:location.pathname,ready:document.readyState,text:document.body?.innerText||''})`)).path === '/login', 'login route');
  const login = await evaluate(`(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({username:'final-admin',password:'WOS-Final-Closure-42!',requestedRole:'Admin'})
    });
    const payload = await response.json().catch(() => ({}));
    return {status:response.status,tokenPresent:Boolean(payload.token)};
  })()`);
  assert.deepEqual(login, { status: 200, tokenPresent: true }, 'synthetic API login must establish a cookie session for the browser callback journey');
  await evaluate(`(() => {
    sessionStorage.setItem('workos_api_token', 'stale-token-that-must-not-be-used');
    sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId:'org-other',legalEntityId:'legal-other'}));
    sessionStorage.setItem('workos_session', JSON.stringify({id:'stale-user',userName:'stale-user',role:'Admin',availableRoles:['Admin']}));
    localStorage.setItem('workos_auth', JSON.stringify({id:'stale-user',userName:'stale-user',role:'Admin',availableRoles:['Admin']}));
    return true;
  })()`);
  await writeEvidence({ status: 'synthetic-session-established', loginStatus: login.status, tokenValueRecorded: false, stalePriorTabStateInjected: true });

  await navigate(`${origin}/auth/entra/complete`);
  const gate = await waitFor(async () => {
    const page = await evaluate(`({path:location.pathname,text:document.body?.innerText||'',gate:Boolean(document.querySelector('[data-testid="organization-scope-gate"]'))})`);
    return page.gate ? page : false;
  }, 'multi-scope selection gate after session callback', 45_000);
  assert.match(gate.text, /Select organization and legal entity/);
  const beforeSelection = await evaluate(`({
    currentScope:sessionStorage.getItem('workos_organization_scope'),
    session:JSON.parse(sessionStorage.getItem('workos_session')||'null'),
    staleAuth:localStorage.getItem('workos_auth'),
    buttons:Array.from(document.querySelectorAll('[data-testid^="organization-scope-option-"]')).map(button=>button.innerText),
    requests:window.__workosScopeTrace||[]
  })`);
  assert.equal(beforeSelection.currentScope, null, 'a multi-scope login must not silently choose a data scope');
  assert.equal(beforeSelection.session?.userName, 'final-admin', 'callback completion must replace a stale tab identity');
  assert.equal(beforeSelection.staleAuth, null, 'callback completion must clear a stale fallback identity');
  assert.equal(beforeSelection.buttons.length, 2, 'the page must offer exactly the two current synthetic scopes');
  assert.ok(beforeSelection.buttons.some(text => /Final Org[\s\S]*Legal A/.test(text)));
  assert.ok(beforeSelection.buttons.some(text => /Final Org[\s\S]*Legal B/.test(text)));
  const protectedBeforeSelection = beforeSelection.requests.filter(request =>
    request.path.startsWith('/api/')
    && !['/api/health', '/api/auth/login', '/api/auth/entra/config', '/api/auth/me', '/api/auth/organization-scopes'].includes(request.path));
  assert.equal(protectedBeforeSelection.length, 0, 'no protected organization data request may run before scope selection');
  const identityRefresh = beforeSelection.requests.find(request => request.path === '/api/auth/me');
  assert.ok(identityRefresh, 'the Entra-completion route must perform identity-only session refresh');
  assert.equal(identityRefresh.authorizationPresent, false, 'Entra completion must authenticate using the new session cookie, not a stale bearer token');
  assert.equal(identityRefresh.organizationId, null);
  assert.equal(identityRefresh.legalEntityId, null);
  await writeEvidence({ status: 'scope-choice-present', scopeOptions: beforeSelection.buttons, protectedRequestsBeforeSelection: protectedBeforeSelection.length });

  const clicked = await evaluate(`(() => {
    const option = document.querySelector('[data-testid="organization-scope-option-org-final-legal-a"]');
    if (!option) return false;
    option.click();
    return true;
  })()`);
  assert.equal(clicked, true, 'the Legal A option must be actionable');
  const selected = await waitFor(async () => {
    const current = await evaluate(`(() => {
      const selected = document.querySelector('[data-testid="organization-scope-selected"]');
      return selected ? {org:selected.getAttribute('data-organization-id'),legal:selected.getAttribute('data-legal-entity-id')} : null;
    })()`);
    return current?.org === 'org-final' && current?.legal === 'legal-a' ? current : false;
  }, 'selected scope commit');
  assert.deepEqual(selected, { org: 'org-final', legal: 'legal-a' });
  await waitFor(async () => {
    const traces = await evaluate(`window.__workosScopeTrace||[]`);
    return traces.some(request => request.path.startsWith('/api/') && !['/api/health', '/api/auth/login', '/api/auth/entra/config', '/api/auth/me', '/api/auth/organization-scopes'].includes(request.path))
      ? traces : false;
  }, 'protected data requests after scope selection');
  const afterSelection = await evaluate(`window.__workosScopeTrace||[]`);
  const protectedRequests = afterSelection.filter(request =>
    request.path.startsWith('/api/')
    && !['/api/health', '/api/auth/login', '/api/auth/entra/config', '/api/auth/me', '/api/auth/organization-scopes'].includes(request.path));
  assert.ok(protectedRequests.length > 0, 'the selected workspace must proceed to protected application data');
  assert.ok(protectedRequests.every(request => request.organizationId === 'org-final' && request.legalEntityId === 'legal-a'),
    `every protected request must carry the selected scope: ${JSON.stringify(protectedRequests)}`);
  await writeEvidence({ status: 'passed', selectedScope: selected, protectedRequestCount: protectedRequests.length, protectedRequests });
  console.log('WOS-02 multi-scope callback and browser scope-selection acceptance passed.');
} catch (error) {
  await writeEvidence({ status: 'failed', error: { name: error?.name, message: error?.message, stack: error?.stack }, serverLog }).catch(() => {});
  throw error;
} finally {
  await cleanup();
}
