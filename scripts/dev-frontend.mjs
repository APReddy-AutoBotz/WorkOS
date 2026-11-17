import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import express from 'express';
import {createProxyServer} from 'httpxy';
import {allowedFrontendHost, createFrontendApp} from './frontend-server.mjs';
import {loadFrontendEnvironment} from './frontend-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2).map((arg, i, all) =>
  arg === '--host' && (!all[i + 1] || all[i + 1].startsWith('-')) ? '--host=0.0.0.0' : arg);
const {values} = parseArgs({args, options: {
  host: {type: 'string', default: '0.0.0.0'}, port: {type: 'string', default: '3000'},
  strictPort: {type: 'boolean'}, mode: {type: 'string', short: 'm', default: 'development'},
}});
const env = await loadFrontendEnvironment(root, values.mode);
const apiPort = env.API_PORT || env.PORT || '4000';
for (const port of [apiPort, values.port]) {
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('Invalid frontend or API port');
}
if (!values.host.trim()) throw new Error('Expected a development hostname');
const require = createRequire(import.meta.url);
const bunPackage = require.resolve('bun/package.json');
const binary = path.resolve(path.dirname(bunPackage), require(bunPackage).bin.bun);
const compiler = spawn(binary, ['--no-env-file', 'scripts/dev-bundler.mjs'], {
  cwd: root, env: {...process.env, WORKOS_FRONTEND_MODE: values.mode, DISABLE_HMR: env.DISABLE_HMR || 'false'},
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
process.on('exit', () => compiler.kill());
compiler.once('exit', code => process.exit(code || 1));
const [ready] = await once(compiler, 'message', {signal: AbortSignal.timeout(30000)});
const target = 'http://127.0.0.1:' + ready.port;
const proxy = createProxyServer({target, changeOrigin: true});
const app = createFrontendApp(values.host, 'http://localhost:' + apiPort);
app.use(express.static(path.join(root, 'public')));
app.all(/^\/_bun\/(?:asset\/|client\/|unref$)/, (req, res) =>
  proxy.web(req, res).catch(() => res.headersSent ? res.destroy() : res.sendStatus(502)));
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
app.get('*', async (req, res, next) => {
  try {
    if (req.path.startsWith('/_bun/') || path.extname(req.path) || !req.accepts('html')) return res.sendStatus(404);
    const compiled = await fetch(target);
    const document = await compiled.text();
    if (!compiled.ok) return res.status(compiled.status).type('html').send(document);
    const assets = document.match(/<head>([\s\S]*?)<\/head>/i);
    if (!assets) throw new Error('Development compiler returned an invalid document');
    const template = await readFile(path.join(root, 'index.html'), 'utf8');
    res.set('Cache-Control', 'no-store').type('html').send(template
      .replace('<title>WorkOS</title>', () => '<title>' + escape(env.VITE_PRODUCT_NAME?.trim() || 'WorkOS') + '</title>')
      .replace('href="/workos-mark.svg"', () => 'href="' + escape(env.VITE_PRODUCT_LOGO_URL?.trim() || '/workos-mark.svg') + '"')
      .replace('<script type="module" src="/src/main.tsx"></script>', '')
      .replace('</head>', () => assets[1] + '</head>'));
  } catch (error) { next(error); }
});
for (let port = Number(values.port); ; port++) {
  const server = app.listen(port, values.host);
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    if (env.DISABLE_HMR === 'true' || req.url !== '/_bun/hmr' || !allowedFrontendHost(host, values.host) ||
        req.headers.origin !== 'http://' + host) return socket.destroy();
    proxy.ws(req, socket, {}, head).catch(() => socket.destroy());
  });
  try {
    await once(server, 'listening');
    console.log('Development listening on port ' + server.address().port);
    break;
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || values.strictPort || port === 65535) throw error;
  }
}
