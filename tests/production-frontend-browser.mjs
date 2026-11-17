import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {chromium} from 'playwright';
import express from 'express';

const brand = 'Synthetic & Co';
execFileSync(process.execPath, ['scripts/build-frontend.mjs'], {
  env: {...process.env, VITE_PRODUCT_NAME: brand, VITE_APP_MODE: 'production'},
  stdio: 'inherit',
});

const app = express();
app.use(express.static('dist'));
app.get('/login', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/assets/') && !response.ok()) errors.push(response.url());
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/login');
  const signIn = page.getByText('Sign in', {exact: true}).first();
  await signIn.waitFor();
  assert.equal(await page.title(), brand);
  assert.equal(await signIn.evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('Compiled login route, configured title, generated styles and application chunks passed.');
