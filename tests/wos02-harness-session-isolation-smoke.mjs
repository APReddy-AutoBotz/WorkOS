import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createContext, runInNewContext, SourceTextModule, SyntheticModule } from 'node:vm';

// Execute the actual harness up to its child-process boundary. Database and
// process creation are substitutes; no database, credentials or server is made.
const source = await readFile(new URL('../.github/scripts/wos02-final-review-live-acceptance-core.mjs', import.meta.url), 'utf8');
const inherited = crypto.randomBytes(32).toString('hex');
const databaseUrl = 'postgresql://not-used.invalid/synthetic';
const targetRoot = '/synthetic-only-target';

async function captureChildEnvironment() {
  const stop = new Error('synthetic child boundary reached');
  let captured;
  const logs = [];
  const processStub = { execPath: process.execPath, env: {
    TARGET_ROOT: targetRoot, DATABASE_URL: databaseUrl, API_SESSION_SECRET: inherited,
    APP_MODE: 'production', NODE_ENV: 'production', LOCAL_LOGIN_ENABLED: 'false',
  } };
  const context = createContext({ process: processStub, Buffer, setTimeout, console: {
    log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')),
  } });
  class Pool { async query() { return { rows: [{ id: 'synthetic-role' }] }; } }
  const createRequire = () => name => { assert.equal(name, 'pg'); return { Pool }; };
  const spawn = (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(Array.from(args), ['server/index.mjs']);
    assert.equal(options.cwd, targetRoot);
    captured = options.env;
    throw stop;
  };
  const modules = {
    'node:assert/strict': { default: assert }, 'node:crypto': { default: crypto },
    'node:child_process': { spawn }, 'node:module': { createRequire },
    'node:fs': { readFileSync: () => assert.fail('no file reads before spawn') },
    'node:path': { default: path },
  };
  const module = new SourceTextModule(source, { context, identifier: 'synthetic-harness' });
  await module.link(async name => {
    assert.ok(Object.hasOwn(modules, name), 'unexpected harness dependency');
    const entries = modules[name];
    return new SyntheticModule(Object.keys(entries), function () {
      for (const [key, value] of Object.entries(entries)) this.setExport(key, value);
    }, { context });
  });
  await assert.rejects(module.evaluate(), error => error === stop);
  assert.ok(captured, 'the actual harness must reach the child boundary');
  return { env: captured, logs };
}

const first = await captureChildEnvironment(), second = await captureChildEnvironment();
const a = first.env.API_SESSION_SECRET, b = second.env.API_SESSION_SECRET;
assert.ok(typeof a === 'string' && typeof b === 'string', 'child signing values must exist');
assert.ok(a !== b, 'independent invocations must not reuse a signing value');
assert.ok(a !== inherited && b !== inherited, 'inherited signing values must not be adopted');
assert.ok(/^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b), 'signing values must have 32 random bytes');
for (const { env, logs } of [first, second]) {
  assert.equal(env.DATABASE_URL, databaseUrl);
  assert.equal(env.APP_MODE, 'test'); assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.LOCAL_LOGIN_ENABLED, 'true'); assert.equal(env.ALLOW_TEST_FALLBACK, 'false');
  assert.equal(env.PORT, env.API_PORT);
  assert.ok(logs.every(line => !line.includes(env.API_SESSION_SECRET)), 'signing value must not be logged');
}

// Exercise the exact target product's signing and verification functions with
// the captured per-run values, without starting an API or opening a database.
// The acceptance workflow first verifies its separate product checkout. Local
// runs may instead use the exact product commit from this repository's history.
const target = process.env.WOS02_TARGET_SERVER
  ? await readFile(process.env.WOS02_TARGET_SERVER, 'utf8')
  : execFileSync('git', ['show', 'f269a1138760384a503e2e2673d3fb1701ead98e:server/index.mjs'], { encoding: 'utf8' });
assert.equal(
  execFileSync('git', ['hash-object', '--stdin'], { input: target, encoding: 'utf8' }).trim(),
  '03991749a0b6f32558d5219aa187ef3702f3207b',
  'target server must match the pinned product source',
);
const functions = target.match(/const signToken = \(payload\) => \{[\s\S]*?\n\};\n\nconst verifyToken = \(token\) => \{[\s\S]*?\n\};/);
assert.ok(functions, 'exact target signing functions must be identifiable');
const signer = key => runInNewContext(`(() => { ${functions[0]}\n return {signToken, verifyToken}; })()`, { crypto, Buffer, Date, sessionSecret: key });
const owner = signer(a), other = signer(b);
const token = owner.signToken({ id: 'synthetic-only', exp: Date.now() + 60_000 });
assert.equal(owner.verifyToken(token)?.id, 'synthetic-only', 'same-run session remains valid');
assert.equal(other.verifyToken(token), null, 'a different run must reject the session');
assert.equal(owner.verifyToken('malformed'), null, 'malformed sessions remain rejected');
console.log('WOS-02 harness uses independent per-invocation session signing and preserves target token behavior.');
