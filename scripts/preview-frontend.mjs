import path from 'node:path';
import {access} from 'node:fs/promises';
import {once} from 'node:events';
import {isIP} from 'node:net';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {createFrontendApp} from './frontend-server.mjs';
import {loadFrontendEnvironment} from './frontend-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2).map((arg, i, all) =>
  arg === '--host' && (!all[i + 1] || all[i + 1].startsWith('-')) ? '--host=0.0.0.0' : arg);
const {values} = parseArgs({args, options: {
  host: {type: 'string', default: 'localhost'}, port: {type: 'string', default: '4173'},
  strictPort: {type: 'boolean'}, mode: {type: 'string', short: 'm', default: 'production'},
  help: {type: 'boolean', short: 'h'},
}});
if (values.help) {
  console.log('npm run preview -- [--host [hostname]] [--port number] [--strictPort] [--mode name]');
  process.exit(0);
}
if (!values.host.trim()) throw new Error('Expected a preview hostname');
function portNumber(value) {
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Expected a valid TCP port');
  return Number(value);
}
const environment = await loadFrontendEnvironment(root, values.mode);
const apiPort = portNumber(environment.API_PORT || environment.PORT || '4000');
const output = path.join(root, 'dist');
const index = path.join(output, 'index.html');
await access(index);
const app = createFrontendApp(values.host, 'http://localhost:' + apiPort);
app.use(express.static(output));
app.get('*', (req, res) => {
  if (req.path.startsWith('/assets/') || path.extname(req.path) || !req.accepts('html')) return res.sendStatus(404);
  res.sendFile(index);
});

for (let port = portNumber(values.port); ; port++) {
  const server = app.listen(port, values.host);
  try {
    await once(server, 'listening');
    const address = server.address();
    const host = isIP(values.host) === 6 ? '[' + values.host + ']' : values.host;
    console.log('Preview listening at http://' + host + ':' + address.port);
    break;
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || values.strictPort || port === 65535) throw error;
  }
}
