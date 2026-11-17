import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {build} from 'esbuild';
import {createFrontendApp} from '../../scripts/frontend-server.mjs';
import {frontendStyles} from '../../scripts/frontend-styles.mjs';

// Compile the named React fixtures in memory. Serve only emitted assets and
// the selected fixture documents, forwarding business requests to the real API.
export async function startFixtureServer({root, fixtures, apiUrl}) {
  const app = createFrontendApp('127.0.0.1', apiUrl);
  const dir = 'tests/fixtures/';
  const output = path.join(root, dir);
  const result = await build({
    absWorkingDir: root, entryPoints: fixtures.map(name => dir + name + '.tsx'),
    outdir: output, bundle: true, format: 'esm', splitting: true, write: false,
    define: {'import.meta.env': JSON.stringify({MODE: 'production', PROD: true, DEV: false,
      BASE_URL: '/', SSR: false, VITE_APP_MODE: 'production', VITE_ALLOW_TEST_FALLBACK: 'false'}),
      'process.env.NODE_ENV': '"production"'},
    plugins: [frontendStyles(root)],
  });
  for (const file of result.outputFiles) {
    const name = path.basename(file.path);
    const body = Buffer.from(file.contents);
    app.get('/' + dir + name, (_req, res) => res.type(path.extname(name)).send(body));
  }
  for (const name of fixtures) {
    const document = await readFile(path.join(output, name + '.html'), 'utf8');
    const html = document.replace(/(<script type="module" src="[^"]+)\.tsx"/, '$1.js"')
      .replace('</head>', '<link rel="stylesheet" href="./' + name + '.css"></head>');
    app.get('/' + dir + name + '.html', (_req, res) => res.type('html').send(html));
  }
  app.use(express.static(path.join(root, 'public')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}
