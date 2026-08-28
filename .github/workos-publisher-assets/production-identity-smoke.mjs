import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

const {Pool} = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
assert.ok(databaseUrl, 'DATABASE_URL is required for production identity acceptance');

const host = '127.0.0.1';
const positivePort = Number(process.env.WOS_PRODUCTION_IDENTITY_PORT || 4010);
const discoveryPort = Number(process.env.WOS_IDENTITY_DISCOVERY_PORT || 4011);
const rootOrigin = `http://127.0.0.1:${positivePort}`;
const tenant = '00000000-0000-0000-0000-000000000001';
const discoveryPath = '/v2.0/.well-known/openid-configuration';
const metadata = {
  issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
};
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
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_DISCOVERY_URL',
  'IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK',
  'IDENTITY_DISCOVERY_TIMEOUT_MS',
  'IDENTITY_DISCOVERY_RECHECK_MS',
  'IDENTITY_DISCOVERY_MAX_BYTES',
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
    ENTRA_TENANT_ID: tenant,
    ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
    ENTRA_CLIENT_SECRET: 'workos-test-only',
    ENTRA_REDIRECT_URI: `${rootOrigin}/api/auth/entra/callback`,
    ENTRA_OPENID_CONFIGURATION_URL: `http://127.0.0.1:${discoveryPort}${discoveryPath}`,
    IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK: 'true',
    IDENTITY_DISCOVERY_TIMEOUT_MS: '750',
    IDENTITY_DISCOVERY_RECHECK_MS: '5000',
    IDENTITY_DISCOVERY_MAX_BYTES: '65536',
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
    if (output.length > 80000) output = output.slice(-80000);
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
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`, {}, 500);
    assert.fail(`negative production process unexpectedly served readiness with HTTP ${response.status}`);
  } catch (error) {
    if (error?.name === 'AssertionError') throw error;
  }
};

const assertStartupFailure = async ({name, port, overrides, expected}) => {
  const environment = cleanEnvironment({
    PORT: port,
    APP_URL: `http://127.0.0.1:${port}`,
    ENTRA_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/entra/callback`,
    ...overrides,
  });
  const {child, output} = spawnProduction(environment);
  let exit;
  try {
    exit = await waitForExit(child, 12000);
  } finally {
    await terminate(child);
  }
  assert.notEqual(exit.code, 0, `${name} must fail production startup`);
  assert.match(output(), expected, `${name} must expose the expected fail-closed reason`);
  await assertNotServingReadiness(port);
  return {name, exitCode: exit.code, readiness: 'closed'};
};

let invalidDiscovery = false;
let discoveryRequests = 0;
const discoveryServer = createServer((_request, response) => {
  discoveryRequests += 1;
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(invalidDiscovery ? {issuer: metadata.issuer} : metadata));
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
    name: 'missing-identity-setting',
    port: positivePort + 11,
    overrides: {ENTRA_CLIENT_SECRET: undefined},
    expected: /ENTRA_CLIENT_SECRET is required in production/,
  }));
  results.push(await assertStartupFailure({
    name: 'unsupported-provider',
    port: positivePort + 12,
    overrides: {IDENTITY_PROVIDER: 'oidc'},
    expected: /implemented governed provider \(entra\)/,
  }));
  results.push(await assertStartupFailure({
    name: 'unavailable-discovery',
    port: positivePort + 13,
    overrides: {ENTRA_OPENID_CONFIGURATION_URL: 'http://127.0.0.1:9/unavailable'},
    expected: /Identity provider discovery is unavailable/,
  }));

  invalidDiscovery = true;
  results.push(await assertStartupFailure({
    name: 'invalid-discovery-document',
    port: positivePort + 14,
    expected: /authorization_endpoint is invalid/,
  }));
  invalidDiscovery = false;

  const beforeUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const beforeEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(beforeUsers, 0, 'identity fixture must begin with zero users');
  assert.equal(beforeEmployees, 0, 'identity fixture must begin with zero employees');

  const production = spawnProduction(cleanEnvironment({PORT: positivePort, APP_URL: rootOrigin}));
  productionChild = production.child;
  let health = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (productionChild.exitCode !== null) {
      throw new Error(`production server exited before readiness: ${production.output()}`);
    }
    try {
      const response = await fetchWithTimeout(`${rootOrigin}/api/health`, {}, 750);
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

  const hitsBeforeAuthStart = discoveryRequests;
  const authStart = await fetchWithTimeout(
    `${rootOrigin}/api/auth/entra/start`,
    {redirect: 'manual'},
    2000,
  );
  assert.equal(authStart.status, 302);
  const location = new URL(authStart.headers.get('location'));
  assert.equal(location.origin, 'https://login.microsoftonline.com');
  assert.equal(location.pathname, `/${tenant}/oauth2/v2.0/authorize`);
  assert.ok(location.searchParams.get('state'));
  assert.ok(location.searchParams.get('nonce'));
  assert.ok(discoveryRequests > hitsBeforeAuthStart, 'authentication must use the configured discovery loader');

  const identityConfig = await fetchWithTimeout(`${rootOrigin}/api/auth/entra/config`);
  assert.equal(identityConfig.status, 200);
  assert.equal((await identityConfig.json()).enabled, true);

  const localLogin = await fetchWithTimeout(`${rootOrigin}/api/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({username: 'acceptance', password: 'workos-test-only'}),
  });
  assert.equal(localLogin.status, 404);

  const protectedApi = await fetchWithTimeout(`${rootOrigin}/api/employees`);
  assert.equal(protectedApi.status, 401);

  const afterUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const afterEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(afterUsers, beforeUsers);
  assert.equal(afterEmployees, beforeEmployees);

  await closeDiscovery();
  const outageExit = await waitForExit(productionChild, 15000);
  assert.notEqual(outageExit.code, 0);
  assert.match(
    production.output(),
    /Identity provider discovery recheck failed: Identity provider discovery is unavailable/,
  );
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
    discoveryRequests,
    authStart: authStart.status,
    outageReadiness: 'closed',
  });
} finally {
  await closeDiscovery();
  await terminate(productionChild);
  await pool.end();
}

const report = {status: 'passed', cases: results};
const evidencePath = String(process.env.WOS_PRODUCTION_IDENTITY_EVIDENCE || '').trim();
if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
