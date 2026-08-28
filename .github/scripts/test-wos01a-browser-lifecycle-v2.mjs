import assert from 'node:assert/strict';
import { CdpClient, removeProfile, terminateProcessTree } from './wos01a-browser-lifecycle-v2.mjs';

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
console.log('WOS-01A browser lifecycle regression assertions passed.');
