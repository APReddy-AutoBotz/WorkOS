import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import {createPrivateKey, createPublicKey, createSign} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

const {Pool} = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
assert.ok(databaseUrl, 'DATABASE_URL is required for production identity acceptance');

const host = '127.0.0.1';
const positivePort = Number(process.env.WOS_PRODUCTION_IDENTITY_PORT || 4010);
const discoveryPort = Number(process.env.WOS_IDENTITY_DISCOVERY_PORT || 4011);
const certificateDirectory = mkdtempSync(join(tmpdir(), 'workos-identity-'));
const certificatePath = join(certificateDirectory, 'server.crt');
const privateKeyPath = join(certificateDirectory, 'server.key');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', privateKeyPath, '-out', certificatePath,
], {stdio: 'ignore', timeout: 10_000});
const serviceOrigin = `http://127.0.0.1:${positivePort}`;
const rootOrigin = 'https://app.example.test';
const entraAuthority = 'https://login.microsoftonline.com';
const testKeys = [
  'PORT',
  'NODE_ENV',
  'APP_MODE',
  'APP_URL',
  'AUTO_SEED_DEMO',
  'RESET_DEMO_DATA',
  'DATABASE_URL',
  'PGSSLMODE',
  'API_SESSION_SECRET',
  'IDENTITY_PROVIDER',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
  'ENTRA_REDIRECT_URI',
  'ENTRA_OPENID_CONFIGURATION_URL',
  'ENTRA_AUTHORITY',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_DISCOVERY_URL',
  'IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'WOS_ENTRA_FIXTURE_ORIGIN',
  'IDENTITY_DISCOVERY_TIMEOUT_MS',
  'IDENTITY_DISCOVERY_RECHECK_MS',
  'LOCAL_LOGIN_ENABLED',
  'EMAIL_PROVIDER',
  'TEAMS_PROVIDER',
];

const cleanEnvironment = (overrides = {}) => {
  const environment = {...process.env};
  for (const key of testKeys) delete environment[key];
  const values = {
    NODE_ENV: 'production',
    APP_MODE: 'production',
    AUTO_SEED_DEMO: 'false',
    RESET_DEMO_DATA: 'false',
    DATABASE_URL: databaseUrl,
    PGSSLMODE: 'disable',
    API_SESSION_SECRET: 'workos-test-only',
    IDENTITY_PROVIDER: 'entra',
    ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001',
    ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
    ENTRA_CLIENT_SECRET: 'workos-test-only',
    ENTRA_REDIRECT_URI: `${rootOrigin}/api/auth/entra/callback`,
    ENTRA_AUTHORITY: entraAuthority,
    ENTRA_OPENID_CONFIGURATION_URL: `${entraAuthority}/00000000-0000-0000-0000-000000000001/v2.0/.well-known/openid-configuration`,
    NODE_EXTRA_CA_CERTS: certificatePath,
    NODE_OPTIONS: '--import=./tests/support/entra-fetch-fixture.mjs',
    WOS_ENTRA_FIXTURE_ORIGIN: `https://localhost:${discoveryPort}`,
    IDENTITY_DISCOVERY_TIMEOUT_MS: '750',
    IDENTITY_DISCOVERY_RECHECK_MS: '5000',
    EMAIL_PROVIDER: 'mock',
    TEAMS_PROVIDER: 'mock',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) delete environment[key];
    else environment[key] = String(value);
  }
  return environment;
};

const collectOutput = (child) => {
  let output = '';
  const append = (chunk) => {
    output = `${output}${chunk}`;
    if (output.length > 80_000) output = output.slice(-80_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
};

const spawnProduction = (environment) => {
  const child = spawn(process.execPath, ['server/start-production.mjs'], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {child, output: collectOutput(child)};
};

const waitForExit = async (child, timeoutMs) => {
  if (child.exitCode !== null) return {code: child.exitCode, signal: child.signalCode};
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      child.off('exit', finish);
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
};

const terminate = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 2500);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 2500).catch(() => {});
  }
};

const fetchWithTimeout = (url, options = {}, timeoutMs = 1000) => fetch(url, {
  ...options,
  signal: AbortSignal.timeout(timeoutMs),
});

const assertNotServingReadiness = async (port) => {
  let response = null;
  try {
    response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`, {}, 500);
  } catch {
    return;
  }
  assert.fail(`negative production process unexpectedly served readiness with HTTP ${response.status}`);
};

const assertStartupFailure = async ({name, port, overrides, expected}) => {
  const environment = cleanEnvironment({
    PORT: port,
    APP_URL: rootOrigin,
    ENTRA_REDIRECT_URI: `${rootOrigin}/api/auth/entra/callback`,
    ...overrides,
  });
  const {child, output} = spawnProduction(environment);
  let exit;
  try {
    exit = await waitForExit(child, 12_000);
  } finally {
    await terminate(child);
  }
  assert.notEqual(exit.code, 0, `${name} must fail production startup`);
  assert.match(output(), expected, `${name} must expose the expected fail-closed reason`);
  await assertNotServingReadiness(port);
  return {name, exitCode: exit.code, readiness: 'closed'};
};

const discoveryPayload = {
  issuer: `${entraAuthority}/00000000-0000-0000-0000-000000000001/v2.0`,
  authorization_endpoint: `${entraAuthority}/00000000-0000-0000-0000-000000000001/oauth2/v2.0/authorize`,
  token_endpoint: `${entraAuthority}/00000000-0000-0000-0000-000000000001/oauth2/v2.0/token`,
  jwks_uri: `${entraAuthority}/00000000-0000-0000-0000-000000000001/discovery/v2.0/keys`,
};

const signingKey = createPrivateKey(readFileSync(privateKeyPath));
const publicJwk = createPublicKey(signingKey).export({format: 'jwk'});
publicJwk.kid = 'synthetic-key';
publicJwk.use = 'sig';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signIdToken = (nonce) => {
  const header = encode({alg: 'RS256', kid: publicJwk.kid});
  const claims = encode({
    aud: '00000000-0000-0000-0000-000000000002',
    iss: discoveryPayload.issuer,
    tid: '00000000-0000-0000-0000-000000000001',
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
    oid: 'synthetic-provider-subject',
    preferred_username: 'synthetic.user@example.test',
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(signingKey, 'base64url')}`;
};

let invalidDiscovery = false;
let discoveryRequests = 0;
let callbackNonce = '';
const discoveryServer = createServer({key: readFileSync(privateKeyPath), cert: readFileSync(certificatePath)}, async (request, response) => {
  discoveryRequests += 1;
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  if (request.url?.endsWith('/oauth2/v2.0/token')) {
    response.end(JSON.stringify({id_token: signIdToken(callbackNonce)}));
  } else if (request.url?.endsWith('/discovery/v2.0/keys')) {
    response.end(JSON.stringify({keys: [publicJwk]}));
  } else {
    response.end(JSON.stringify(invalidDiscovery ? {issuer: discoveryPayload.issuer} : discoveryPayload));
  }
});
await new Promise((resolve, reject) => {
  discoveryServer.once('error', reject);
  discoveryServer.listen(discoveryPort, host, resolve);
});

const closeDiscovery = async () => {
  if (!discoveryServer.listening) return;
  await new Promise((resolve) => discoveryServer.close(resolve));
};

const results = [];
let productionChild = null;
const pool = new Pool({connectionString: databaseUrl, ssl: undefined});

try {
  results.push(await assertStartupFailure({
    name: 'missing-app-url',
    port: positivePort + 7,
    overrides: {APP_URL: undefined},
    expected: /APP_URL is invalid/,
  }));
  results.push(await assertStartupFailure({
    name: 'http-app-url',
    port: positivePort + 8,
    overrides: {APP_URL: 'http://app.example.test'},
    expected: /APP_URL must use HTTPS/,
  }));
  results.push(await assertStartupFailure({
    name: 'loopback-callback',
    port: positivePort + 9,
    overrides: {ENTRA_REDIRECT_URI: 'https://localhost/api/auth/entra/callback'},
    expected: /ENTRA_REDIRECT_URI must not use a loopback host/,
  }));
  results.push(await assertStartupFailure({
    name: 'wrong-callback-route',
    port: positivePort + 10,
    overrides: {ENTRA_REDIRECT_URI: `${rootOrigin}/wrong`},
    expected: /ENTRA_REDIRECT_URI must use the APP_URL origin and exact \/api\/auth\/entra\/callback route/,
  }));
  results.push(await assertStartupFailure({
    name: 'missing-identity-setting',
    port: positivePort + 11,
    overrides: {ENTRA_CLIENT_SECRET: undefined},
    expected: /ENTRA_CLIENT_SECRET is required in production/,
  }));
  results.push(await assertStartupFailure({
    name: 'local-provider-prohibited',
    port: positivePort + 12,
    overrides: {IDENTITY_PROVIDER: 'local'},
    expected: /IDENTITY_PROVIDER must select the implemented governed Entra provider in production\./,
  }));
  results.push(await assertStartupFailure({
    name: 'unavailable-discovery',
    port: positivePort + 13,
    overrides: {
      WOS_ENTRA_FIXTURE_ORIGIN: 'https://localhost:9',
      IDENTITY_DISCOVERY_TIMEOUT_MS: '500',
    },
    expected: /Identity provider discovery is unavailable/,
  }));

  invalidDiscovery = true;
  results.push(await assertStartupFailure({
    name: 'invalid-discovery-document',
    port: positivePort + 14,
    overrides: {
      WOS_ENTRA_FIXTURE_ORIGIN: `https://localhost:${discoveryPort}`,
    },
    expected: /Identity provider discovery is missing authorization_endpoint/,
  }));
  invalidDiscovery = false;

  const beforeUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const beforeEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(beforeUsers, 0, 'production identity fixture must start with zero users');
  assert.equal(beforeEmployees, 0, 'production identity fixture must start with zero employees');

  const environment = cleanEnvironment({
    PORT: positivePort,
    APP_URL: rootOrigin,
    ENTRA_REDIRECT_URI: `${rootOrigin}/api/auth/entra/callback`,
  });
  const production = spawnProduction(environment);
  productionChild = production.child;

  let health = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (productionChild.exitCode !== null) {
      throw new Error(`production server exited before readiness: ${production.output()}`);
    }
    try {
      const response = await fetchWithTimeout(`${serviceOrigin}/api/health`, {}, 750);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Retry within the bounded startup window.
    }
    await delay(250);
  }
  assert.ok(health, `production server did not become ready: ${production.output()}`);
  assert.equal(health.status, 'ok');
  assert.equal(health.database, 'connected');

  const identityConfig = await fetchWithTimeout(`${serviceOrigin}/api/auth/entra/config`, {}, 1000);
  assert.equal(identityConfig.status, 200);
  const identityConfigBody = await identityConfig.json();
  assert.equal(identityConfigBody.enabled, true);
  assert.equal(identityConfigBody.provider, 'entra');

  const discoveryRequestsBeforeAuth = discoveryRequests;
  const authStart = await fetchWithTimeout(`${serviceOrigin}/api/auth/entra/start`, {redirect: 'manual'}, 1000);
  assert.equal(authStart.status, 302);
  assert.ok(discoveryRequests > discoveryRequestsBeforeAuth, 'authentication initiation must use configured discovery');
  const authorizationLocation = new URL(authStart.headers.get('location') || '');
  assert.equal(authorizationLocation.origin, entraAuthority);
  callbackNonce = authorizationLocation.searchParams.get('nonce') || '';
  const state = authorizationLocation.searchParams.get('state') || '';
  assert.ok(callbackNonce && state, 'authentication initiation must issue nonce and state');

  const localLogin = await fetchWithTimeout(`${serviceOrigin}/api/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'acceptance', password: 'workos-test-only'}),
  });
  assert.equal(localLogin.status, 404, 'local production login must remain disabled');

  const protectedApi = await fetchWithTimeout(`${serviceOrigin}/api/employees`);
  assert.equal(protectedApi.status, 401, 'anonymous protected API access must remain closed');

  const afterUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const afterEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(afterUsers, beforeUsers, 'production startup must not auto-seed users');
  assert.equal(afterEmployees, beforeEmployees, 'production startup must not auto-seed employees');

  const syntheticUser = await pool.query("insert into users (username, email, entra_object_id, status) values ('synthetic-user', 'synthetic.user@example.test', 'synthetic-provider-subject', 'Active') returning id");
  await pool.query('insert into user_roles (user_id, role_id) select $1, id from roles order by name limit 1', [syntheticUser.rows[0].id]);
  const callback = await fetchWithTimeout(`${serviceOrigin}/api/auth/entra/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, {redirect: 'manual'}, 2000);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), `${rootOrigin}/auth/entra/complete`);
  await pool.query("delete from users where username = 'synthetic-user'");

  await closeDiscovery();
  const outageExit = await waitForExit(productionChild, 15_000);
  assert.notEqual(outageExit.code, 0, 'identity-provider outage must terminate production readiness');
  assert.match(production.output(), /Identity provider discovery recheck failed: Identity provider discovery is unavailable/);
  productionChild = null;
  await assertNotServingReadiness(positivePort);

  results.push({
    name: 'configured-provider-ready-then-unavailable',
    startup: 'ready',
    database: health.database,
    localLogin: localLogin.status,
    protectedApi: protectedApi.status,
    usersBefore: beforeUsers,
    usersAfter: afterUsers,
    employeesBefore: beforeEmployees,
    employeesAfter: afterEmployees,
    outageReadiness: 'closed',
  });
} finally {
  await closeDiscovery();
  await terminate(productionChild);
  await pool.end();
  rmSync(certificateDirectory, {recursive: true, force: true});
}

const report = {
  status: 'passed',
  cases: results,
};
const evidencePath = String(process.env.WOS_PRODUCTION_IDENTITY_EVIDENCE || '').trim();
if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
