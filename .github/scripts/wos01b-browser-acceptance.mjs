import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [targetArg, outputArg] = process.argv.slice(2);
if (!targetArg || !outputArg) {
  throw new Error('Usage: node wos01b-browser-acceptance.mjs <workos-root> <output-dir>');
}

const targetRoot = path.resolve(targetArg);
const outputRoot = path.resolve(outputArg);
const baseUrl = 'http://127.0.0.1:3000';
const cdpBase = 'http://127.0.0.1:9222';
const profile = '/tmp/wos01b-browser-profile';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HTTP_ATTEMPT_TIMEOUT_MS = 1500;
const CDP_COMMAND_TIMEOUT_MS = 4000;
const PROCESS_EXIT_TIMEOUT_MS = 4000;
const TOTAL_TIMEOUT_MS = Number(process.env.WOS01B_BROWSER_TIMEOUT_MS || 180000);

if (!Number.isFinite(TOTAL_TIMEOUT_MS) || TOTAL_TIMEOUT_MS < 1000 || TOTAL_TIMEOUT_MS > 240000) {
  throw new Error(`Invalid WOS01B_BROWSER_TIMEOUT_MS: ${process.env.WOS01B_BROWSER_TIMEOUT_MS}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await rm(profile, { recursive: true, force: true });

const wrapperPath = path.join(targetRoot, 'public/__wos01b_acceptance.html');
const viteLog = path.join(outputRoot, 'vite.log');
const chromeLog = path.join(outputRoot, 'chrome.log');
const lifecycleLog = path.join(outputRoot, 'lifecycle.log');
const lifecycle = [];
const recordLifecycle = message => {
  lifecycle.push(`${new Date().toISOString()} ${message}`);
};

const wrapper = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>WOS-01B browser acceptance</title></head>
  <body>
    <pre id="result">pending</pre>
    <script>
      const params = new URLSearchParams(location.search);
      const role = params.get('role');
      const targetPath = params.get('path');
      const expectedPath = params.get('expected');
      const permission = params.get('permission');
      const session = {
        id: \`acceptance-\${role}\`,
        userName: \`acceptance-\${role.toLowerCase()}\`,
        employeeId: \`ACCEPT-\${role}\`,
        name: \`\${role} Acceptance\`,
        email: \`\${role.toLowerCase()}@example.test\`,
        role,
        availableRoles: [role],
        permissions: permission ? [permission] : [],
        permissionRole: role,
        lastLogin: new Date().toISOString(),
      };
      localStorage.setItem('workos_demo_data_version', JSON.stringify('demo-your-organization-anonymized-v10'));
      localStorage.setItem('workos_auth', JSON.stringify(session));

      const frame = document.createElement('iframe');
      frame.src = targetPath;
      frame.style.width = '1280px';
      frame.style.height = '900px';
      document.body.appendChild(frame);

      const finish = () => {
        try {
          const finalPath = frame.contentWindow.location.pathname;
          const body = frame.contentDocument.body.innerText || '';
          const invalid = /Page not found|Sign in to|Authentication required/i.test(body);
          const pass = finalPath === expectedPath && body.trim().length > 80 && !invalid;
          document.documentElement.dataset.acceptance = pass ? 'pass' : 'fail';
          document.getElementById('result').textContent = JSON.stringify({
            role,
            targetPath,
            expectedPath,
            finalPath,
            bodyLength: body.length,
            invalid,
            pass,
            excerpt: body.slice(0, 1200),
          });
        } catch (error) {
          document.documentElement.dataset.acceptance = 'fail';
          document.getElementById('result').textContent = JSON.stringify({ role, error: String(error), pass: false });
        }
      };

      const timer = setInterval(() => {
        try {
          if (frame.contentDocument?.body?.innerText?.trim().length > 80) {
            clearInterval(timer);
            setTimeout(finish, 300);
          }
        } catch {}
      }, 150);
      setTimeout(() => {
        clearInterval(timer);
        finish();
      }, 8000);
    </script>
  </body>
</html>
`;
await writeFile(wrapperPath, wrapper);

const findChrome = () => {
  for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('No Chrome/Chromium executable found');
};

const waitForHttp = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_ATTEMPT_TIMEOUT_MS) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError || 'unknown error'}`);
};

const waitForExit = (child, timeoutMs) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
};

const signalProcessTree = (child, signal) => {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    recordLifecycle(`signalled pid=${child.pid} signal=${signal}`);
  } catch (error) {
    recordLifecycle(`signal failed pid=${child.pid} signal=${signal} error=${String(error)}`);
    try { child.kill(signal); } catch {}
  }
};

const terminateProcessTree = async (name, child) => {
  if (!child) return;
  signalProcessTree(child, 'SIGTERM');
  if (!(await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS))) {
    recordLifecycle(`${name} ignored SIGTERM; escalating`);
    signalProcessTree(child, 'SIGKILL');
    await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
};

const chromePath = findChrome();
recordLifecycle(`chrome=${chromePath}`);

let viteOutput = '';
let chromeOutput = '';
let vite = null;
let chrome = null;
let cleanupPromise = null;
const activeSockets = new Set();
const activePages = new Set();

const closePage = async id => {
  if (!id) return;
  activePages.delete(id);
  try {
    await fetch(`${cdpBase}/json/close/${id}`, { signal: AbortSignal.timeout(CDP_COMMAND_TIMEOUT_MS) });
  } catch (error) {
    recordLifecycle(`page close failed id=${id} error=${String(error)}`);
  }
};

const closeSocket = async socket => {
  if (!socket) return;
  activeSockets.delete(socket);
  if (socket.readyState === WebSocket.CLOSED) return;
  await Promise.race([
    new Promise(resolve => {
      const timer = setTimeout(resolve, CDP_COMMAND_TIMEOUT_MS);
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      try { socket.close(); } catch { resolve(); }
    }),
    sleep(CDP_COMMAND_TIMEOUT_MS),
  ]);
};

const cleanup = async reason => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    recordLifecycle(`cleanup start reason=${reason}`);
    await Promise.allSettled([...activePages].map(closePage));
    await Promise.allSettled([...activeSockets].map(closeSocket));
    await Promise.all([
      terminateProcessTree('vite', vite),
      terminateProcessTree('chrome', chrome),
    ]);
    await writeFile(viteLog, viteOutput);
    await writeFile(chromeLog, chromeOutput);
    await rm(wrapperPath, { force: true });
    await rm(profile, { recursive: true, force: true });
    recordLifecycle('cleanup complete');
    await writeFile(lifecycleLog, `${lifecycle.join('\n')}\n`);
  })();
  return cleanupPromise;
};

const connectCdp = async websocketUrl => {
  const socket = new WebSocket(websocketUrl);
  activeSockets.add(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), 5000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', event => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${String(event)}`));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const rejectPending = error => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => rejectPending(new Error('CDP WebSocket closed with pending commands')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP WebSocket failed with pending commands')));

  const send = (method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`CDP WebSocket is not open for ${method}`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return { socket, send };
};

const createPage = async url => {
  const response = await fetch(`${cdpBase}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(CDP_COMMAND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Unable to create CDP page: HTTP ${response.status}`);
  const page = await response.json();
  activePages.add(page.id);
  return page;
};

const cases = [
  ['admin-home', 'Admin', '/', '/', 'dashboard.view'],
  ['hr-home', 'HR', '/', '/', 'dashboard.view'],
  ['regional-home', 'CountryDirector', '/', '/', 'dashboard.view'],
  ['pm-home', 'ProjectManager', '/pm-workspace', '/pm-workspace', 'pm_workspace.view'],
  ['teamlead-home', 'TeamLead', '/timesheets/approval', '/timesheets/approval', 'timesheets.approve'],
  ['employee-home', 'Employee', '/ess', '/ess', 'employee_workspace.view'],
  ['pm-admin-denied', 'ProjectManager', '/admin', '/pm-workspace', 'pm_workspace.view'],
  ['teamlead-admin-denied', 'TeamLead', '/admin', '/timesheets/approval', 'timesheets.approve'],
  ['employee-admin-denied', 'Employee', '/admin', '/ess', 'employee_workspace.view'],
];

const execute = async () => {
  vite = spawn('npm', ['run', 'dev'], {
    cwd: targetRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      VITE_APP_MODE: 'test',
      VITE_ALLOW_TEST_FALLBACK: 'true',
      VITE_PRODUCT_NAME: 'WorkOS',
      VITE_ORGANIZATION_NAME: 'Your organization',
      VITE_PRODUCT_LOGO_URL: '/workos-mark.svg',
      VITE_SUPPORT_NAME: 'WorkOS Support',
      VITE_SUPPORT_EMAIL: 'support@example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stdout.on('data', chunk => { viteOutput += chunk; });
  vite.stderr.on('data', chunk => { viteOutput += chunk; });
  recordLifecycle(`vite started pid=${vite.pid}`);

  chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  chrome.stdout.on('data', chunk => { chromeOutput += chunk; });
  chrome.stderr.on('data', chunk => { chromeOutput += chunk; });
  recordLifecycle(`chrome started pid=${chrome.pid}`);

  await waitForHttp(`${baseUrl}/login`, 45000);
  await waitForHttp(`${cdpBase}/json/version`, 15000);

  const results = [];
  for (const [name, role, targetPath, expectedPath, permission] of cases) {
    const query = new URLSearchParams({ role, path: targetPath, expected: expectedPath, permission });
    const page = await createPage(`${baseUrl}/__wos01b_acceptance.html?${query}`);
    const { socket, send } = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await send('Runtime.enable');
      await send('Page.enable');
      const deadline = Date.now() + 15000;
      let observed = null;
      while (Date.now() < deadline) {
        const evaluation = await send('Runtime.evaluate', {
          expression: `({ state: document.documentElement.dataset.acceptance || '', text: document.getElementById('result')?.textContent || '' })`,
          returnByValue: true,
        });
        observed = evaluation.result?.value || null;
        if (observed?.state === 'pass' || observed?.state === 'fail') break;
        await sleep(200);
      }
      if (!observed || !['pass', 'fail'].includes(observed.state)) {
        throw new Error(`Journey ${name} timed out: ${JSON.stringify(observed)}`);
      }
      const parsed = JSON.parse(observed.text);
      const result = { name, state: observed.state, ...parsed };
      results.push(result);
      await writeFile(path.join(outputRoot, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
      if (observed.state !== 'pass' || !parsed.pass) {
        throw new Error(`Journey ${name} failed: ${JSON.stringify(result)}`);
      }
    } finally {
      await closeSocket(socket);
      await closePage(page.id);
    }
  }

  await writeFile(path.join(outputRoot, 'summary.json'), `${JSON.stringify({ status: 'passed', cases: results }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', journeys: results.map(({ name, role, finalPath }) => ({ name, role, finalPath })) }, null, 2));
};

let watchdog;
const watchdogPromise = new Promise((_, reject) => {
  watchdog = setTimeout(() => reject(new Error(`Browser acceptance exceeded ${TOTAL_TIMEOUT_MS}ms`)), TOTAL_TIMEOUT_MS);
});

let failure = null;
try {
  await Promise.race([execute(), watchdogPromise]);
} catch (error) {
  failure = error;
  recordLifecycle(`failure=${error?.stack || error}`);
  await writeFile(path.join(outputRoot, 'failure.json'), `${JSON.stringify({ status: 'failed', error: String(error?.stack || error) }, null, 2)}\n`);
} finally {
  clearTimeout(watchdog);
  await cleanup(failure ? 'failure' : 'success');
}

if (failure) throw failure;
