import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {createLoginRateLimit, requireLocalLoginEnabled} from '../server/modules/identity-access/login-rate-limit.mjs';

const call = (limiter, username = 'synthetic', ip = '127.0.0.1') => {
  const result = {status: 200, headers: {}};
  const response = {setHeader: (key, value) => {result.headers[key] = value;},
    status: (status) => {result.status = status; return response;}, json: (body) => {result.body = body;}};
  limiter({ip, body: {username}}, response, () => {result.next = true;});
  return result;
};

test('account normalization, default budget, Retry-After and fixed-window expiry', () => {
  let time = 1000;
  const limiter = createLoginRateLimit({now: () => time});
  for (let n = 0; n < 8; n++) assert.equal(call(limiter, n % 2 ? ' SYNTHETIC ' : 'synthetic').status, 200);
  assert.equal(call(limiter).status, 429);
  assert.equal(call(limiter).headers['Retry-After'], '900');
  time += 900000;
  assert.equal(call(limiter).status, 200);
  assert.equal(limiter.entryCount, 2);
});

test('rotating usernames and malformed bodies cannot bypass the IP budget', () => {
  const limiter = createLoginRateLimit({maxIpAttempts: 4});
  for (const name of ['one', 'two', {}, 'x'.repeat(1000000)]) assert.equal(call(limiter, name).status, 200);
  assert.equal(call(limiter, 'five').status, 429);
  assert.equal(call(limiter, 'five', '127.0.0.2').status, 200);
  assert.ok(limiter.entryCount <= 7);
});

test('capacity fails closed without evicting live budgets and expired keys are reclaimed', () => {
  let time = 1000;
  const limiter = createLoginRateLimit({maxEntries: 10, windowMs: 1000, now: () => time});
  for (let n = 0; n < 5; n++) assert.equal(call(limiter, 'user', `192.0.2.${n}`).status, 200);
  for (let n = 5; n < 100; n++) assert.equal(call(limiter, 'user', `192.0.2.${n}`).status, 429);
  assert.equal(limiter.entryCount, 10);
  assert.equal(call(limiter, 'user', '192.0.2.0').status, 200);
  time += 1000;
  assert.equal(call(limiter, 'new', '192.0.2.99').status, 200);
  assert.equal(limiter.entryCount, 2);
});

test('invalid configuration cannot silently disable throttling', () => {
  for (const value of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => createLoginRateLimit({maxAttempts: value}));
    assert.throws(() => createLoginRateLimit({maxIpAttempts: value}));
  }
});

test('disabled local HTTP login returns 404 before limiter or database work', async () => {
  const previous = process.env.LOCAL_LOGIN_ENABLED;
  process.env.LOCAL_LOGIN_ENABLED = 'false';
  const app = express();
  const limiter = createLoginRateLimit();
  let databaseCalls = 0;
  app.use(express.json());
  app.post('/api/auth/login', requireLocalLoginEnabled, limiter, (req, res) => {databaseCalls++; res.sendStatus(200);});
  const server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
  try {
    for (let n = 0; n < 12; n++) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: `synthetic-${n}`}),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {error: 'Not found'});
    }
    assert.equal(limiter.entryCount, 0);
    assert.equal(databaseCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.LOCAL_LOGIN_ENABLED; else process.env.LOCAL_LOGIN_ENABLED = previous;
  }
});
