import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PipeCdpClient,
  readChromeProcessDiagnostics,
  removeProfile,
  resolveChromeExecutable,
  terminateProcessTree,
} from './wos01a-browser-lifecycle-v2.mjs';

const origin = process.env.WOS_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const commandTimeoutMs = Number(process.env.WOS_CDP_TIMEOUT_MS || 10_000);
const journeyTimeoutMs = Number(process.env.WOS_JOURNEY_TIMEOUT_MS || 25_000);
const appReadyTimeoutMs = Number(process.env.WOS_APP_READY_TIMEOUT_MS || 20 * 60 * 1000);
const driverReadyFile = String(process.env.WOS_BROWSER_DRIVER_READY_FILE || '').trim();
const handshakeEvidenceFile = String(
  process.env.WOS_CHROME_HANDSHAKE_EVIDENCE
  || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'wos01a-browser-evidence', 'chrome-handshake.json'),
).trim();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitForApplication = async () => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < appReadyTimeoutMs) {
    try {
      const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`application returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Application did not become ready within ${appReadyTimeoutMs}ms: ${lastError?.message || 'unknown error'}`);
};

const chromeCandidates = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean);
const chromeResolution = await resolveChromeExecutable(chromeCandidates);
const chromeBin = chromeResolution.executable;
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'workos-chrome-'));

const handshakeEvidence = {
  status: 'launching',
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  origin,
  chromeResolution,
};
const writeHandshakeEvidence = async (patch = {}) => {
  Object.assign(handshakeEvidence, patch, {updatedAt: new Date().toISOString()});
  await mkdir(path.dirname(handshakeEvidenceFile), {recursive: true});
  await writeFile(handshakeEvidenceFile, `${JSON.stringify(handshakeEvidence, null, 2)}\n`, {mode: 0o600});
};

const chrome = spawn(chromeBin, [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-first-run',
  '--remote-debugging-pipe',
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });

let chromeOutput = '';
const appendChromeOutput = (chunk) => {
  chromeOutput = `${chromeOutput}${chunk.toString()}`.slice(-65_536);
};
chrome.stdout.on('data', appendChromeOutput);
chrome.stderr.on('data', appendChromeOutput);

let client;
let targetId;
let sessionId;
let cleanupPromise;
const cleanup = () => cleanupPromise ||= (async () => {
  if (client) {
    if (sessionId) await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
    await client.send('Browser.close').catch(() => {});
    await client.close();
  }
  await terminateProcessTree(chrome);
  await removeProfile(userDataDir);
})();

const cleanupForSignal = (code) => cleanup().then(
  () => process.exit(code),
  error => { console.error(error); process.exit(1); },
);
process.on('SIGINT', () => { void cleanupForSignal(130); });
process.on('SIGTERM', () => { void cleanupForSignal(143); });

const withTimeout = async (promise, timeoutMs, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const evaluate = async (client, expression, sessionId) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text || 'unknown exception'}`);
  }
  return result.result?.value;
};

const waitForPage = async (client, expectedPath, timeoutMs = journeyTimeoutMs) => {
  const started = Date.now();
  let snapshot;
  while (Date.now() - started < timeoutMs) {
    snapshot = await evaluate(client, `({
      ready: document.readyState,
      path: location.pathname,
      text: document.body?.innerText || '',
      title: document.title,
    })`, sessionId);
    if (snapshot?.ready === 'complete' && snapshot.text.length > 20) {
      if (!expectedPath || snapshot.path === expectedPath || snapshot.path.startsWith(`${expectedPath}/`)) return snapshot;
    }
    await sleep(250);
  }
  throw new Error(`Route ${expectedPath || '(any)'} did not settle. Last snapshot: ${JSON.stringify(snapshot)}`);
};

const sessionFor = (role) => ({
  id: `browser-${role.toLowerCase()}`,
  userName: `browser-${role.toLowerCase()}`,
  employeeId: `BROWSER-${role.toUpperCase()}`,
  name: `${role} Browser User`,
  email: `${role.toLowerCase()}@example.test`,
  role,
  availableRoles: [role],
  lastLogin: new Date(0).toISOString(),
});

const journeys = [
  ['Admin', '/admin'],
  ['HR', '/employees'],
  ['CountryDirector', '/'],
  ['ProjectManager', '/pm-workspace'],
  ['TeamLead', '/timesheets/approval'],
  ['Employee', '/ess'],
];

try {
  await new Promise((resolve, reject) => {
    chrome.once('spawn', resolve);
    chrome.once('error', reject);
  });
  await sleep(100);
  const processDiagnostics = await readChromeProcessDiagnostics(chrome.pid);
  const actualExecutable = processDiagnostics.executable.replace(/ \(deleted\)$/, '');
  const actualVersionResult = !actualExecutable.startsWith('<unavailable:')
    ? spawnSync(actualExecutable, ['--version'], {encoding: 'utf8', timeout: 5_000})
    : null;
  const actualVersion = `${actualVersionResult?.stdout || ''}\n${actualVersionResult?.stderr || ''}`.trim();
  if (!actualVersionResult || actualVersionResult.error || actualVersionResult.status !== 0
      || !/\b(?:Google Chrome|Chrome for Testing|Chromium)\b/i.test(actualVersion)) {
    throw new Error(`Spawned process is not a trusted Chrome/Chromium executable: ${JSON.stringify({processDiagnostics, actualVersion})}`);
  }
  if (!/^(?:pipe|socket):\[\d+\]$/.test(processDiagnostics.fd3)
      || !/^(?:pipe|socket):\[\d+\]$/.test(processDiagnostics.fd4)
      || processDiagnostics.fd3 === processDiagnostics.fd4) {
    throw new Error(`Chrome DevTools pipe descriptors are not distinct open kernel channels: ${JSON.stringify(processDiagnostics)}`);
  }
  await writeHandshakeEvidence({
    status: 'spawned',
    controllerPid: process.pid,
    chromePid: chrome.pid,
    processDiagnostics,
    actualVersion,
  });

  // Chromium reads controller commands on fd 3 and writes responses on fd 4.
  client = new PipeCdpClient(chrome.stdio[4], chrome.stdio[3], { commandTimeoutMs });
  chrome.once('exit', (code, signal) => {
    handshakeEvidence.chromeExit = {code, signal, at: new Date().toISOString()};
    void client?.close().catch(() => {});
    console.error(`Chrome exited code=${code} signal=${signal}`);
  });
  const browserVersion = await withTimeout(client.send('Browser.getVersion'), 15_000, 'trusted Chrome pipe handshake');
  if (!browserVersion?.protocolVersion || !/\b(?:Chrome|Chromium)\//i.test(String(browserVersion.product || ''))) {
    throw new Error(`Chrome returned an invalid Browser.getVersion identity: ${JSON.stringify(browserVersion)}`);
  }
  ({ targetId } = await client.send('Target.createTarget', { url: 'about:blank' }));
  ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }));
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  if (!targetId || !sessionId || chrome.exitCode !== null) throw new Error('Trusted Chrome target/session establishment failed');
  await writeHandshakeEvidence({
    status: 'control-ready',
    browserVersion,
    targetId,
    sessionId,
    chromeOutputTail: chromeOutput,
  });
  if (driverReadyFile) {
    await writeFile(driverReadyFile, `${JSON.stringify({status: 'control-ready', pid: process.pid, chromePid: chrome.pid, transport: 'pipe', targetId, sessionId})}\n`, {mode: 0o600});
  }
  await waitForApplication();

  for (const [role, route] of journeys) {
    await withTimeout((async () => {
      await client.send('Page.navigate', { url: `${origin}/login` }, sessionId);
      await waitForPage(client, '/login');
      const session = JSON.stringify(sessionFor(role));
      await evaluate(client, `
        sessionStorage.clear();
        localStorage.removeItem('workos_auth');
        sessionStorage.setItem('workos_session', ${JSON.stringify(session)});
        true;
      `, sessionId);
      await client.send('Page.navigate', { url: `${origin}${route}` }, sessionId);
      const snapshot = await waitForPage(client, route);
      if (snapshot.path === '/login') throw new Error(`${role} was redirected to login for ${route}`);
      if (/Page not found/i.test(snapshot.text)) throw new Error(`${role} rendered NotFound for ${route}`);
      if (/Something went wrong|Unhandled|Application error/i.test(snapshot.text)) {
        throw new Error(`${role} rendered an application error for ${route}: ${snapshot.text.slice(0, 500)}`);
      }
      console.log(`PASS ${role} ${route} -> ${snapshot.path}`);
    })(), journeyTimeoutMs, `${role} journey`);
  }

  await withTimeout((async () => {
    await client.send('Page.navigate', { url: `${origin}/login` }, sessionId);
    await waitForPage(client, '/login');
    const employeeSession = JSON.stringify(sessionFor('Employee'));
    await evaluate(client, `
      sessionStorage.clear();
      localStorage.removeItem('workos_auth');
      sessionStorage.setItem('workos_session', ${JSON.stringify(employeeSession)});
      true;
    `, sessionId);
    await client.send('Page.navigate', { url: `${origin}/admin` }, sessionId);
    const started = Date.now();
    let snapshot;
    while (Date.now() - started < journeyTimeoutMs) {
      snapshot = await evaluate(client, `({ path: location.pathname, text: document.body?.innerText || '' })`, sessionId);
      if (snapshot.path !== '/admin' && snapshot.text.length > 20) break;
      await sleep(250);
    }
    if (!snapshot || snapshot.path === '/admin') {
      throw new Error(`Employee was not denied /admin: ${JSON.stringify(snapshot)}`);
    }
    if (snapshot.path !== '/ess') {
      throw new Error(`Employee denial did not use the authorized /ess fallback: ${JSON.stringify(snapshot)}`);
    }
    if (/Page not found/i.test(snapshot.text)) throw new Error('Employee denial rendered NotFound');
    if (/Something went wrong|Unhandled|Application error/i.test(snapshot.text)) {
      throw new Error(`Employee denial rendered an application error: ${snapshot.text.slice(0, 500)}`);
    }
    console.log(`PASS Employee denied /admin -> ${snapshot.path}`);
  })(), journeyTimeoutMs, 'Employee denial journey');

  await writeHandshakeEvidence({status: 'passed', completedAt: new Date().toISOString(), chromeOutputTail: chromeOutput});
  console.log('WOS-01A bounded browser acceptance passed.');
} catch (error) {
  const processDiagnostics = chrome.pid ? await readChromeProcessDiagnostics(chrome.pid) : null;
  await writeHandshakeEvidence({
    status: 'failed',
    error: {name: error?.name, message: error?.message, stack: error?.stack},
    processDiagnostics,
    chromeOutputTail: chromeOutput,
  }).catch(recordError => console.error('Unable to retain Chrome handshake evidence', recordError));
  console.error('WOS-01A Chrome handshake diagnostics:', JSON.stringify({chromeResolution, processDiagnostics, chromeOutputTail: chromeOutput}, null, 2));
  throw error;
} finally {
  await cleanup();
}
