import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, removeProfile, terminateProcessTree } from './wos01a-browser-lifecycle-v2.mjs';

const origin = process.env.WOS_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const debugPort = Number(process.env.WOS_CHROME_DEBUG_PORT || 9222);
const commandTimeoutMs = Number(process.env.WOS_CDP_TIMEOUT_MS || 10_000);
const journeyTimeoutMs = Number(process.env.WOS_JOURNEY_TIMEOUT_MS || 25_000);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const chromeCandidates = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean);

const chromeBin = chromeCandidates.find(candidate =>
  spawnSync('bash', ['-lc', `command -v ${JSON.stringify(candidate)}`], { stdio: 'ignore' }).status === 0
);

if (!chromeBin) {
  throw new Error(`No supported Chrome/Chromium executable found (${chromeCandidates.join(', ')})`);
}
if (typeof WebSocket !== 'function') {
  throw new Error('Node runtime does not provide the WebSocket API required for bounded CDP acceptance');
}

const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'workos-chrome-'));
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
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

let chromeOutput = '';
chrome.stdout.on('data', chunk => { chromeOutput += chunk.toString(); });
chrome.stderr.on('data', chunk => { chromeOutput += chunk.toString(); });

let client;
let targetId;
let cleanupPromise;
const cleanup = () => cleanupPromise ||= (async () => {
  if (client) {
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

const waitForJson = async (url, timeoutMs, label) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'unknown error'}\n${chromeOutput.slice(-4_000)}`);
};

const evaluate = async (client, expression) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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
    })`);
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
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 15_000, 'Chrome DevTools');
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(3_000),
  }).then(response => {
    if (!response.ok) throw new Error(`Unable to create Chrome target: ${response.status}`);
    return response.json();
  });

  targetId = target.id;
  client = new CdpClient(target.webSocketDebuggerUrl, { commandTimeoutMs });
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  for (const [role, route] of journeys) {
    await withTimeout((async () => {
      await client.send('Page.navigate', { url: `${origin}/login` });
      await waitForPage(client, '/login');
      const session = JSON.stringify(sessionFor(role));
      await evaluate(client, `
        sessionStorage.clear();
        localStorage.removeItem('workos_auth');
        sessionStorage.setItem('workos_session', ${JSON.stringify(session)});
        true;
      `);
      await client.send('Page.navigate', { url: `${origin}${route}` });
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
    await client.send('Page.navigate', { url: `${origin}/login` });
    await waitForPage(client, '/login');
    const employeeSession = JSON.stringify(sessionFor('Employee'));
    await evaluate(client, `
      sessionStorage.clear();
      localStorage.removeItem('workos_auth');
      sessionStorage.setItem('workos_session', ${JSON.stringify(employeeSession)});
      true;
    `);
    await client.send('Page.navigate', { url: `${origin}/admin` });
    const started = Date.now();
    let snapshot;
    while (Date.now() - started < journeyTimeoutMs) {
      snapshot = await evaluate(client, `({ path: location.pathname, text: document.body?.innerText || '' })`);
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

  console.log('WOS-01A bounded browser acceptance passed.');
} finally {
  await cleanup();
}
