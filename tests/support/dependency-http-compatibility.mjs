// Isolated, bounded loopback regression for GHSA-27r3-jxmh-p828.
// The late-byte sequencing follows the upstream regression design:
// Upstream reference: expressjs/body-parser commit1260c38.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync, deflateSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import express from 'express';

const body = {ok:true};
const raw = Buffer.from(JSON.stringify(body));
const trailing = Buffer.alloc(1024, 0x58);
let lateClient;
let lateReached = false;
const app = express();
app.set('trust proxy', 1); // Preserve the application's existing setting.
app.use(express.json({limit:'1mb'}));
app.post('/echo', (req, res) => res.json(req.body));
app.post('/late', (req, res) => {
  lateReached = true;
  // Send the rest only after the decoder has delivered the valid frame.
  req.once('end', () => res.json(req.body));
  lateClient.end(trailing);
});
app.get('/health', (_req, res) => res.json({alive:true}));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({error:'invalid request'}));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const request = (path, bytes, encoding, late = false) => new Promise((resolve, reject) => {
  const req = http.request({host:'127.0.0.1', port, path, method:bytes ? 'POST' : 'GET', agent:false,
    headers:bytes ? {'content-type':'application/json', 'content-encoding':encoding, 'content-length':bytes.length + (late ? trailing.length : 0)} : {},
  }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('error', reject);
    res.on('end', () => resolve({status:res.statusCode, body:JSON.parse(text)}));
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('Loopback request timed out')));
  if (late) { lateClient = req; req.write(bytes); } else req.end(bytes);
});

try {
  assert.deepEqual(await request('/echo', gzipSync(raw), 'gzip'), {status:200, body});
  const earlyFrame = Buffer.concat([deflateSync(raw), Buffer.from([0])]);
  assert.deepEqual(await request('/late', earlyFrame, 'deflate', true), {status:200, body});
  assert.equal(lateReached, true, 'The test must reach the post-decompression route');
  const malformed = Buffer.concat([gzipSync(raw), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  const response = await request('/echo', malformed, 'gzip');
  assert.ok([200,400].includes(response.status), 'Malformed compressed request must be bounded');
  if (response.status === 200) assert.deepEqual(response.body, body);
  await delay(200); // Allow a delayed decoder error to surface in this child.
  assert.deepEqual(await request('/health'), {status:200, body:{alive:true}});
  assert.deepEqual(await request('/echo', gzipSync(raw), 'gzip'), {status:200, body});
  console.log('compressed-body compatibility passed');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
