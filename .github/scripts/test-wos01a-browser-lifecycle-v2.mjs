import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { CdpClient, PipeCdpClient, removeProfile, terminateProcessTree } from './wos01a-browser-lifecycle-v2.mjs';

const child = { pid: 42, exitCode: null, signalCode: null };
const signals = [];
let alive = true;
await terminateProcessTree(child, { waitMs: 2, kill: (_pid, signal) => {
  if (signal === 0) { if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return; }
  signals.push(signal); if (signal === 'SIGKILL') alive = false;
}, delay: async () => {} });
assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

let attempts = 0;
await removeProfile('/synthetic/profile', { deadlineMs: 100, delay: async () => {}, remove: async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error('busy'), { code: attempts === 1 ? 'ENOTEMPTY' : 'EBUSY' }); } });
assert.equal(attempts, 3);
await removeProfile('/synthetic/profile', { remove: async () => {} });
await assert.rejects(removeProfile('/synthetic/profile', { deadlineMs: -1, remove: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }), /cleanup failed/);

class FakeSocket {
  static OPEN = 1; static CLOSED = 3;
  constructor() { this.readyState = 0; this.listeners = new Map(); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
  send() { queueMicrotask(() => this.emit('close', {})); }
  close() { this.readyState = 3; this.emit('close', {}); }
}
const client = new CdpClient('ws://synthetic', { WebSocketImpl: FakeSocket, commandTimeoutMs: 20 });
await client.connect();
await assert.rejects(client.send('Page.enable'), /socket closed/);
assert.equal(client.pending.size, 0);
await client.close();

for (const event of ['error', 'invalid']) {
  class LossSocket extends FakeSocket {
    send() { queueMicrotask(() => event === 'invalid' ? this.emit('message', { data: '{' }) : this.emit('error', {})); }
  }
  const lossClient = new CdpClient('ws://synthetic', { WebSocketImpl: LossSocket, commandTimeoutMs: 20 });
  await lossClient.connect();
  await assert.rejects(lossClient.send('Runtime.enable'), /socket (failed|returned an invalid response)/);
  assert.equal(lossClient.pending.size, 0);
  await lossClient.close();
}

const acceptance = await readFile(new URL('./wos01a-browser-acceptance-v2.mjs', import.meta.url), 'utf8');
assert.match(acceptance, /--remote-debugging-pipe/);
assert.doesNotMatch(acceptance, /remote-debugging-port|WOS_CHROME_DEBUG_PORT|\/json\/version|\/json\/new|webSocketDebuggerUrl/);
assert.ok(acceptance.indexOf("client.send('Browser.getVersion')") < acceptance.indexOf('await writeFile(driverReadyFile'));
assert.ok(acceptance.indexOf("client.send('Target.attachToTarget'") < acceptance.indexOf('await writeFile(driverReadyFile'));

// A target-controlled emulator on the former fixed endpoint must be irrelevant:
// the accepted transport has no TCP discovery or configured-port path.
const fakeFixedPortCdp = createServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}'));
await new Promise((resolve, reject) => fakeFixedPortCdp.once('error', reject).listen(9222, '127.0.0.1', resolve));
process.env.WOS_CHROME_DEBUG_PORT = '9222';

const controllerToChrome = new PassThrough();
const chromeToController = new PassThrough();
const pipeClient = new PipeCdpClient(chromeToController, controllerToChrome, { commandTimeoutMs: 30 });
let sent;
controllerToChrome.once('data', chunk => {
  sent = JSON.parse(chunk.toString().replace(/\0$/, ''));
  chromeToController.write(`${JSON.stringify({id: sent.id, result: {targetId: 'trusted-target'}})}\0`);
});
assert.deepEqual(await pipeClient.send('Target.createTarget', {url: 'about:blank'}), {targetId: 'trusted-target'});
assert.equal(sent.method, 'Target.createTarget');

controllerToChrome.once('data', chunk => {
  const command = JSON.parse(chunk.toString().replace(/\0$/, ''));
  assert.equal(command.sessionId, 'trusted-session');
  chromeToController.write(`${JSON.stringify({id: command.id, result: {ok: true}})}\0`);
});
assert.deepEqual(await pipeClient.send('Page.enable', {}, 'trusted-session'), {ok: true});
assert.equal(pipeClient.pending.size, 0);

const malformedPromise = pipeClient.send('Runtime.enable');
chromeToController.write('{not-json}\0');
await assert.rejects(malformedPromise, /malformed protocol data/);
assert.equal(pipeClient.pending.size, 0);
await assert.rejects(pipeClient.send('Page.navigate'), /not open/);
await pipeClient.close();
await new Promise(resolve => fakeFixedPortCdp.close(resolve));

for (const loss of ['end', 'destroy']) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lost = new PipeCdpClient(input, output, {commandTimeoutMs: 30});
  const pending = lost.send('Browser.getVersion');
  if (loss === 'end') input.end(); else input.destroy(new Error('synthetic transport loss'));
  await assert.rejects(pending, /CDP pipe (closed|failed)/);
  assert.equal(lost.pending.size, 0);
}
console.log('WOS-01A browser lifecycle regression assertions passed.');
