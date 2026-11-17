import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {chromium} from 'playwright';

// npm dependencies resolve from the parent worktree. Edit only this disposable
// application's source while testing real component refresh.
const root = await mkdtemp(path.join(process.cwd(), '.development-test-'));
const api = http.createServer((req, res) => {
  if (req.url === '/api/dev-check') return res.end('development proxy works');
  res.writeHead(503).end();
});
let child, browser;
try {
  for (const item of ['src', 'shared', 'scripts', 'public', 'bunfig.toml', 'index.html', 'tsconfig.json', 'package.json']) {
    await cp(item, path.join(root, item), {recursive: true});
  }
  api.listen(0, 'localhost');
  await once(api, 'listening');
  const brand = 'Synthetic & Co';
  const privateMarker = 'synthetic-private-development-canary';
  child = spawn(process.execPath, ['scripts/dev-frontend.mjs', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
    cwd: root, env: {...process.env, API_PORT: String(api.address().port), VITE_PRODUCT_NAME: brand,
      DISABLE_HMR: 'false', SERVER_ONLY_BUILD_FIXTURE: privateMarker}, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({input: child.stdout});
  const [line] = await once(lines, 'line', {signal: AbortSignal.timeout(30000)});
  assert.match(line, /^Development listening on port \d+$/);
  const origin = 'http://127.0.0.1:' + line.split(' ').at(-1);
  assert.equal(await (await fetch(origin + '/api/dev-check')).text(), 'development proxy works');
  const hostCheck = http.get(origin, {headers: {Host: 'untrusted.example.test'}});
  const [denied] = await once(hostCheck, 'response');
  denied.resume();
  assert.equal(denied.statusCode, 403);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/login');
  const username = page.getByLabel('Username', {exact: true});
  await username.fill('synthetic-unsaved-input');
  assert.equal(await page.title(), brand);
  assert.equal(await page.getByText('Sign in', {exact: true}).evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
  const assets = await page.locator('script[src]').evaluateAll(scripts => scripts.map(script => script.src));
  assert.ok(assets.length);
  for (const asset of assets) {
    const response = await fetch(asset);
    assert.ok(response.ok);
    assert.ok(!(await response.text()).includes(privateMarker));
  }
  const login = path.join(root, 'src/pages/Login.tsx');
  const before = await readFile(login, 'utf8');
  const after = before.replace('>Sign in</p>', '>Synthetic refresh check</p>');
  assert.notEqual(after, before);
  assert.equal(await username.inputValue(), 'synthetic-unsaved-input');
  await writeFile(login, after);
  await page.getByText('Synthetic refresh check', {exact: true}).waitFor();
  assert.equal(await username.inputValue(), 'synthetic-unsaved-input');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  if (api.listening) await new Promise(resolve => api.close(resolve));
  await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 150});
}
console.log('Development login, branding, CSS, proxy, environment isolation and state-preserving refresh passed.');
