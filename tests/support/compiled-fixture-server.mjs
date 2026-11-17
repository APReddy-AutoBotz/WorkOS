import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {build} from 'esbuild';
import {createFrontendApp} from '../../scripts/frontend-server.mjs';
import {frontendStyles} from '../../scripts/frontend-styles.mjs';

// Compile the named React fixtures in memory. Serve only emitted assets and
// the selected fixture documents, forwarding business requests to the real API.
export async function startFixtureServer({root, fixtures = [], apiUrl, application = false, modules = {},
  mode = 'production', publicEnv = {}, port = 0}) {
  const app = createFrontendApp('127.0.0.1', apiUrl);
  const dir = 'tests/fixtures/';
  const output = path.join(root, dir);
  const documents = await Promise.all(fixtures.map(async name => {
    const html = await readFile(path.join(output, name + '.html'), 'utf8');
    const script = html.match(/<script type="module" src="([^"]+)"/)?.[1];
    if (!script || ![name + '.tsx', name + '.mjs'].includes(path.basename(script))) {
      throw new Error('Unexpected module entry in fixture ' + name);
    }
    return {name, html, script};
  }));
  const result = await build({
    absWorkingDir: root, entryPoints: {
      ...Object.fromEntries(documents.map(({name, script}) => [name, dir + path.basename(script)])),
      ...(application ? {main: 'src/main.tsx'} : {}), ...modules,
    },
    outdir: output, bundle: true, format: 'esm', splitting: true, write: false,
    // Keep React's development lifecycle checks for fixtures in every app mode.
    // The compiled production login journey independently exercises the release build.
    define: {'import.meta.env': JSON.stringify({MODE: mode, PROD: false, DEV: true,
      BASE_URL: '/', SSR: false, VITE_APP_MODE: mode, VITE_ALLOW_TEST_FALLBACK: 'false', ...publicEnv}),
      'process.env.NODE_ENV': '"development"'},
    plugins: [frontendStyles(root)],
  });
  for (const file of result.outputFiles) {
    const name = path.basename(file.path);
    const body = Buffer.from(file.contents);
    app.get('/' + dir + name, (_req, res) => res.type(path.extname(name)).send(body));
  }
  for (const {name, html, script} of documents) {
    const hasStyles = result.outputFiles.some(file => path.basename(file.path) === name + '.css');
    const page = html.replace('src="' + script + '"', 'src="./' + name + '.js"')
      .replace('</head>', (hasStyles ? '<link rel="stylesheet" href="./' + name + '.css">' : '') + '</head>');
    app.get('/' + dir + name + '.html', (_req, res) => res.type('html').send(page));
  }
  app.use(express.static(path.join(root, 'public')));
  if (application) {
    const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
      .replace('/src/main.tsx', '/' + dir + 'main.js')
      .replace('</head>', '<link rel="stylesheet" href="/' + dir + 'main.css"></head>');
    app.get('*', (req, res) => path.extname(req.path) ? res.sendStatus(404) : res.type('html').send(html));
  }
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}
