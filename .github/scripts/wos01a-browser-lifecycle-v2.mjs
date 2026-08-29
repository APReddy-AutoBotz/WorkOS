import { rm } from 'node:fs/promises';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function terminateProcessTree(child, {
  waitMs = 3_000,
  kill = process.kill,
  delay = sleep,
} = {}) {
  if (!child?.pid) return;
  const signalTree = (signal) => {
    try { kill(-child.pid, signal); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const treeAlive = () => {
    try { kill(-child.pid, 0); return true; } catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  };
  signalTree('SIGTERM');
  const deadline = Date.now() + waitMs;
  while (treeAlive() && Date.now() < deadline) await delay(Math.min(50, waitMs));
  if (treeAlive()) {
    signalTree('SIGKILL');
    const killDeadline = Date.now() + waitMs;
    while (treeAlive() && Date.now() < killDeadline) await delay(Math.min(50, waitMs));
  }
  if (treeAlive()) throw new Error(`Chrome process tree ${child.pid} did not exit after TERM/KILL escalation`);
}

export async function removeProfile(profile, {
  deadlineMs = 5_000,
  remove = rm,
  delay = sleep,
} = {}) {
  const deadline = Date.now() + deadlineMs;
  let pause = 25;
  for (;;) {
    try {
      await remove(profile, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code) || Date.now() >= deadline) {
        throw new Error(`Chrome profile cleanup failed for ${profile}: ${error?.code || error}`, { cause: error });
      }
      await delay(pause);
      pause = Math.min(pause * 2, 400);
    }
  }
}

export class CdpClient {
  constructor(url, { WebSocketImpl = WebSocket, commandTimeoutMs = 10_000 } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new this.WebSocketImpl(this.url);
    const rejectPending = (reason) => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`CDP socket ${reason} while awaiting ${waiter.method}`));
      }
      this.pending.clear();
    };
    this.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { rejectPending('returned an invalid response'); return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result || {});
    });
    this.socket.addEventListener('close', () => rejectPending('closed'));
    this.socket.addEventListener('error', () => rejectPending('failed'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connection timed out after ${this.commandTimeoutMs}ms`)), this.commandTimeoutMs);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed to open')); }, { once: true });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error(`CDP socket is not open for ${method}`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${this.commandTimeoutMs}ms`)); }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async close() {
    if (!this.socket || this.socket.readyState === this.WebSocketImpl.CLOSED) return;
    const socket = this.socket;
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    socket.close();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, this.commandTimeoutMs))]);
  }
}

export class PipeCdpClient {
  constructor(readable, writable, { commandTimeoutMs = 10_000, maxBufferBytes = 1_048_576 } = {}) {
    this.readable = readable;
    this.writable = writable;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxBufferBytes = maxBufferBytes;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    readable.on('data', chunk => this.#receive(chunk));
    readable.on('error', error => this.#fail(`failed: ${error.message}`));
    readable.on('close', () => this.#fail('closed'));
    writable.on('error', error => this.#fail(`failed: ${error.message}`));
    writable.on('close', () => this.#fail('closed'));
  }

  #fail(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`CDP pipe ${reason} while awaiting ${waiter.method}`));
    }
    this.pending.clear();
  }

  #receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > this.maxBufferBytes) {
      this.#fail(`exceeded ${this.maxBufferBytes} buffered bytes`);
      return;
    }
    for (;;) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) return;
      const frame = this.buffer.subarray(0, boundary).toString('utf8');
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!frame) continue;
      let message;
      try { message = JSON.parse(frame); } catch { this.#fail('returned malformed protocol data'); return; }
      if (!Number.isSafeInteger(message.id)) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message || 'protocol error'}`));
      else waiter.resolve(message.result || {});
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed || this.writable.destroyed || !this.writable.writable) {
      return Promise.reject(new Error(`CDP pipe is not open for ${method}`));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      this.writable.write(`${message}\0`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.#fail('closed by controller');
    this.writable.end();
    this.readable.destroy();
  }
}
