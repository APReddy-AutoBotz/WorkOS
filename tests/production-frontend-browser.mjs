import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {get} from 'node:http';
import {createInterface} from 'node:readline';
import {chromium} from 'playwright';
import express from 'express';

const brand = 'Synthetic & Co';
const deploymentIcon = '/workos-mark.svg?deployment';
execFileSync(process.execPath, ['scripts/build-frontend.mjs'], {
  env: {...process.env, VITE_PRODUCT_NAME: brand, VITE_PRODUCT_LOGO_URL: deploymentIcon, VITE_APP_MODE: 'production'},
  stdio: 'inherit',
});

const api = express();
api.use(express.text());
api.post('/api/preview-check', (req, res) => res.status(201).json({body: req.body, query: req.query}));
const server = api.listen(0, 'localhost');
await once(server, 'listening');
const preview = spawn(process.execPath, ['scripts/preview-frontend.mjs', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  env: {...process.env, API_PORT: String(server.address().port)}, stdio: ['ignore', 'pipe', 'inherit'],
});
const lines = createInterface({input: preview.stdout});
let browser;
try {
  const [line] = await once(lines, 'line', {signal: AbortSignal.timeout(10_000)});
  assert.ok(line.startsWith('Preview listening at '));
  const address = new URL(line.slice('Preview listening at '.length));
  assert.equal(address.protocol, 'http:');
  assert.equal(address.hostname, '127.0.0.1');
  assert.ok(Number(address.port) > 0);
  const origin = address.origin;
  const response = await fetch(origin + '/api/preview-check?q=one', {method: 'POST', body: 'preview body'});
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {body: 'preview body', query: {q: 'one'}});
  assert.equal((await fetch(origin + '/assets/missing.js')).status, 404);
  const hostCheck = get(origin, {headers: {Host: 'untrusted.example.test'}});
  const [denied] = await once(hostCheck, 'response');
  denied.resume();
  assert.equal(denied.statusCode, 403);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/assets/') && !response.ok()) errors.push(response.url());
  });
  await page.goto(origin + '/login');
  const signIn = page.getByText('Sign in', {exact: true}).first();
  await signIn.waitFor();
  assert.equal(await page.title(), brand);
  assert.equal(await page.locator('#workos-favicon').getAttribute('href'), deploymentIcon);
  assert.equal(await signIn.evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
  assert.deepEqual(errors, []);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await fetch(origin + '/api/preview-check', {signal: AbortSignal.timeout(5000)})).status, 502);
} finally {
  await browser?.close();
  lines.close();
  if (preview.exitCode === null && preview.signalCode === null) {
    const closed = once(preview, 'close');
    preview.kill();
    await closed;
  }
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('Compiled login route, configured title, generated styles and application chunks passed.');
