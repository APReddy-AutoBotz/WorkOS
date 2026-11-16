import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {request as httpRequest} from 'node:http';
import {parseTrustedProxies} from '../server/modules/identity-access/proxy-trust.mjs';
import {recordAuditEvent} from '../server/modules/audit/audit-record.mjs';
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

const withHttp = async (trusted, run) => {
  const app=express(), limiter=createLoginRateLimit({maxAttempts:1,maxIpAttempts:4});
  app.set('trust proxy',parseTrustedProxies(trusted));app.use(express.json());
  const reply=async(req,res)=>{let values;await recordAuditEvent({query:async(_sql,args)=>{values=args;}},req,{module:'Synthetic',action:'Probe',entityType:'Fixture',entityId:'synthetic'});res.json({ip:req.ip,auditIp:values[13]});};
  app.post('/api/auth/login',limiter,reply);
  app.get('/api/auth/entra/callback',limiter.callback,reply);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const request=(method,path,username,forwarded)=>new Promise((resolve,reject)=>{
    const url=new URL('http://127.0.0.1');url.port=String(server.address().port);url.pathname=path;
    const body=JSON.stringify({username});
    const req=httpRequest(url,{method,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...(forwarded?{'X-Forwarded-For':forwarded}:{})}},res=>{
      let text='';res.on('data',data=>{text+=data;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(body);
  });
  try{await run(request,limiter);}finally{await new Promise(resolve=>server.close(resolve));}
};

test('direct requests cannot rotate untrusted forwarded addresses or forge audit IP',async()=>{
  await withHttp(undefined,async request=>{
    const first=await request('POST','/api/auth/login','synthetic','203.0.113.1');
    assert.equal(first.status,200);assert.equal(first.body.ip,'127.0.0.1');assert.equal(first.body.auditIp,'127.0.0.1');
    for(const forwarded of ['203.0.113.2','203.0.113.3'])assert.equal((await request('POST','/api/auth/login','synthetic',forwarded)).status,429);
  });
});

test('trusted peer configuration preserves distinct clients and stops at the first untrusted hop',async()=>{
  await withHttp('127.0.0.1/32,10.0.0.0/8',async request=>{
    for(const ip of ['203.0.113.1','203.0.113.2']) {
      const result=await request('POST','/api/auth/login','synthetic',ip);
      assert.equal(result.status,200);assert.equal(result.body.ip,ip);assert.equal(result.body.auditIp,ip);
    }
    const chained=await request('POST','/api/auth/login','synthetic','203.0.113.9, 198.51.100.23');
    assert.equal(chained.status,200);assert.equal(chained.body.ip,'198.51.100.23');assert.equal(chained.body.auditIp,'198.51.100.23');
  });
});

test('callback JSON bodies and local path casing cannot select extra account budgets',async()=>{
  await withHttp(undefined,async request=>{
    assert.equal((await request('GET','/api/auth/entra/callback','one')).status,200);
    for(const value of ['two','three',{}]) {
      const result=await request('GET','/api/auth/entra/callback',value);
      assert.equal(result.status,429);assert.ok(Number(result.headers['retry-after'])>=1);
    }
  });
  await withHttp(undefined,async request=>{
    assert.equal((await request('POST','/API/AUTH/LOGIN','synthetic')).status,200);
    assert.equal((await request('POST','/api/auth/login',' SYNTHETIC ')).status,429);
  });
});

test('proxy trust accepts explicit IP/CIDR peers and rejects ambiguous or universal settings',()=>{
  assert.equal(parseTrustedProxies(),false);
  assert.deepEqual(parseTrustedProxies('127.0.0.1, ::1/128'),['127.0.0.1','::1/128']);
  for(const value of ['true','1','*','loopback','0.0.0.0/0','::/0','127.0.0.1/33','::1/129','127.0.0.1,','127.0.0.1//32','hostname.example.test','fe80::1%eth0']) {
    assert.throws(()=>parseTrustedProxies(value),/Invalid TRUSTED_PROXY_CIDRS/);
  }
});
