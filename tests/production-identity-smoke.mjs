import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createPrivateKey, createPublicKey, createSign} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {syntheticCredential, rejectedConfigurationValues} from './support/synthetic-values.mjs';

const {Pool} = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
assert.ok(databaseUrl, 'DATABASE_URL is required for production identity acceptance');

const hasSetCookie = (headers, expectedName) => {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  return values.some((value) => value
    .split(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
    .some((entry) => entry.slice(0, entry.indexOf('=')).trim().toLowerCase() === expectedName.toLowerCase()));
};

assert.equal(
  hasSetCookie({get: () => 'workos_entra_state=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/, workos_session=signed; HttpOnly'}, 'workos_session'),
  true,
  'combined Set-Cookie headers must recognize a session entry after an expiring state cookie',
);
assert.equal(
  hasSetCookie({get: () => 'notice=prefix-workos_session=signed; Path=/'}, 'workos_session'),
  false,
  'cookie-value substrings must not satisfy the session-cookie contract',
);

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
  'PGSSLROOTCERT',
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
  'LOGIN_RATE_LIMIT',
  'LOGIN_IP_RATE_LIMIT',
  'TRUSTED_PROXY_CIDRS',
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
    API_SESSION_SECRET: syntheticCredential(),
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
    // Allow the bounded set of positive and negative callbacks from the test provider.
    LOGIN_RATE_LIMIT: '14',
    API_SESSION_TTL_HOURS: '8',
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

const spawnProduction = (environment, image) => {
  let executable = process.execPath;
  let args = ['server/start-production.mjs'];
  if (image) {
    executable = 'docker';
    // The CI runner hosts the disposable database and synthetic identity provider on loopback.
    // Exercise the image's own command, dependencies, frontend assets and non-root user.
    environment = {...environment, NODE_EXTRA_CA_CERTS:'/tmp/workos-fixture.crt',
      NODE_OPTIONS:'--import=/tmp/workos-entra-fixture.mjs'};
    const fixture = join(process.cwd(),'tests/support/entra-fetch-fixture.mjs');
    const keys = [...testKeys, 'API_SESSION_TTL_HOURS'].filter(key => environment[key] !== undefined);
    args = ['run','--rm','--init','--network','host',
      '--mount',`type=bind,source=${certificatePath},target=/tmp/workos-fixture.crt,readonly`,
      '--mount',`type=bind,source=${fixture},target=/tmp/workos-entra-fixture.mjs,readonly`,
      ...keys.flatMap(key => ['--env',key]),image];
  }
  const child = spawn(executable, args, {
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
const signIdToken = (nonce, overrides = {}) => {
  const header = encode({alg: 'RS256', kid: publicJwk.kid});
  const claims = encode({
    aud: '00000000-0000-0000-0000-000000000002',
    iss: discoveryPayload.issuer,
    tid: '00000000-0000-0000-0000-000000000001',
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
    oid: 'synthetic-provider-subject',
    preferred_username: 'synthetic.user@example.test',
    groups: ['mock-entra-group-employee'],
    ...overrides,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(signingKey, 'base64url')}`;
};

let invalidDiscovery = false;
let discoveryUnavailable = false;
let discoveryRequests = 0;
let callbackNonce = '';
let nextTokenClaimOverrides = {};
const discoveryServer = createServer({key: readFileSync(privateKeyPath), cert: readFileSync(certificatePath)}, async (request, response) => {
  discoveryRequests += 1;
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  if (discoveryUnavailable) {
    response.statusCode = 503;
    response.end(JSON.stringify({error: 'synthetic provider outage'}));
  } else if (request.url?.endsWith('/oauth2/v2.0/token')) {
    const claimOverrides = nextTokenClaimOverrides;
    nextTokenClaimOverrides = {};
    response.end(JSON.stringify({id_token: signIdToken(callbackNonce, claimOverrides)}));
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

const beginAuthorization = async () => {
  const discoveryRequestsBeforeAuth = discoveryRequests;
  const response = await fetchWithTimeout(`${serviceOrigin}/api/auth/entra/start`, {redirect: 'manual'}, 1000);
  assert.equal(response.status, 302);
  assert.ok(discoveryRequests > discoveryRequestsBeforeAuth, 'authentication initiation must use configured discovery');
  const authorizationLocation = new URL(response.headers.get('location') || '');
  assert.equal(authorizationLocation.origin, entraAuthority);
  callbackNonce = authorizationLocation.searchParams.get('nonce') || '';
  const state = authorizationLocation.searchParams.get('state') || '';
  const stateCookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.ok(callbackNonce && state, 'authentication initiation must issue nonce and state');
  assert.match(stateCookie, /^workos_entra_state=/, 'authentication initiation must bind state to an HttpOnly cookie');
  return {nonce: callbackNonce, state, stateCookie};
};

const callbackRejections = [];
let productionOutputForCallback = () => '';
const assertCallbackRejected = async ({name, claimOverrides, expectedLocation = '/login?error=entra_callback_failed'}) => {
  const {nonce, state, stateCookie} = await beginAuthorization();
  nextTokenClaimOverrides = typeof claimOverrides === 'function'
    ? claimOverrides({nonce})
    : {...claimOverrides};
  const callback = await fetchWithTimeout(
    `${serviceOrigin}/api/auth/entra/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    {redirect: 'manual', headers: {cookie: stateCookie}},
    2000,
  );
  const location = callback.headers.get('location');
  assert.equal(callback.status, 302, `${name} must terminate through a redirect`);
  assert.equal(location, expectedLocation,
    `${name} must fail closed at the governed error route. Production server output: ${productionOutputForCallback()}`);
  assert.equal(hasSetCookie(callback.headers, 'workos_session'), false, `${name} must not create a WorkOS session`);
  callbackRejections.push({
    name,
    status: callback.status,
    location,
    sessionCookie: false,
  });
};

const results = [];
let productionChild = null;
const pool = new Pool({connectionString: databaseUrl, ssl: undefined});

try {
  results.push(await assertStartupFailure({
    name: 'unreadable-database-ca',
    port: positivePort + 20,
    overrides: {PGSSLMODE: 'require', PGSSLROOTCERT: join(certificateDirectory, 'missing-database-ca.pem')},
    expected: /Production startup blocked: database or migration failure/,
  }));
  results.push(await assertStartupFailure({
    name: 'missing-app-url',
    port: positivePort + 7,
    overrides: {APP_URL: undefined},
    expected: /APP_URL is required in production/,
  }));
  results.push(await assertStartupFailure({
    name: 'http-app-url',
    port: positivePort + 8,
    overrides: {APP_URL: 'http://app.example.test'},
    expected: /APP_URL must be a public HTTPS origin/,
  }));
  results.push(await assertStartupFailure({
    name: 'loopback-callback',
    port: positivePort + 9,
    overrides: {ENTRA_REDIRECT_URI: 'https://localhost/api/auth/entra/callback'},
    expected: /ENTRA_REDIRECT_URI must match the HTTPS APP_URL origin and callback path/,
  }));
  results.push(await assertStartupFailure({
    name: 'wrong-callback-route',
    port: positivePort + 10,
    overrides: {ENTRA_REDIRECT_URI: `${rootOrigin}/wrong`},
    expected: /ENTRA_REDIRECT_URI must match the HTTPS APP_URL origin and callback path/,
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
    expected: /IDENTITY_PROVIDER must select the configured Entra provider/,
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

  results.push(await assertStartupFailure({
    name: 'placeholder-client-secret',
    port: positivePort + 15,
    overrides: {ENTRA_CLIENT_SECRET: rejectedConfigurationValues.placeholder},
    expected: /ENTRA_CLIENT_SECRET must be a configured non-placeholder secret/,
  }));

  await pool.query('insert into deployment_session_policy(lifetime_ms) values (28800000) on conflict (singleton) do update set lifetime_ms=excluded.lifetime_ms');
  results.push(await assertStartupFailure({
    name: 'session-lifetime-mismatch', port: positivePort + 16,
    overrides: {API_SESSION_TTL_HOURS: '4'}, expected: /must match the audited database policy/,
  }));

  const beforeUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const beforeEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(beforeUsers, 0, 'production identity fixture must start with zero users');
  assert.equal(beforeEmployees, 0, 'production identity fixture must start with zero employees');

  const environment = cleanEnvironment({
    PORT: positivePort,
    APP_URL: rootOrigin,
    ENTRA_REDIRECT_URI: `${rootOrigin}/api/auth/entra/callback`,
  });
  const production = spawnProduction(environment, process.env.WORKOS_TEST_PRODUCTION_IMAGE);
  productionChild = production.child;
  productionOutputForCallback = production.output;

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

  const initialReadiness = await fetchWithTimeout(`${serviceOrigin}/api/health/ready`, {}, 1000);
  assert.equal(initialReadiness.status, 200);
  assert.equal((await initialReadiness.json()).identityProvider, 'available');
  if (process.env.WORKOS_TEST_PRODUCTION_IMAGE) {
    const build = await fetchWithTimeout(`${serviceOrigin}/api/health/build`, {}, 1000);
    assert.equal(build.status,200);
    const {commit,migrationLevel} = await build.json();
    assert.equal(commit,process.env.GITHUB_SHA,'running image must report the packaged revision');
    assert.ok(migrationLevel,'running image must report an installed migration');
    const page = await fetchWithTimeout(serviceOrigin, {}, 1000);
    assert.equal(page.status,200);
    const asset = (await page.text()).match(/<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset,'packaged HTML must point to its compiled application');
    const script = await fetchWithTimeout(serviceOrigin+asset, {}, 1000);
    assert.equal(script.status,200);
    assert.match(script.headers.get('content-type') || '',/javascript/);
    results.push({name:'packaged-production-readiness',commit,migrationLevel,asset});
  }

  const identityConfig = await fetchWithTimeout(`${serviceOrigin}/api/auth/entra/config`, {}, 1000);
  assert.equal(identityConfig.status, 200);
  const identityConfigBody = await identityConfig.json();
  assert.equal(identityConfigBody.enabled, true);
  assert.equal(identityConfigBody.provider, 'entra');

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

  await assertCallbackRejected({
    name: 'wrong-issuer',
    claimOverrides: {iss: `${entraAuthority}/wrong-tenant/v2.0`},
  });
  await assertCallbackRejected({
    name: 'wrong-tenant',
    claimOverrides: {tid: '00000000-0000-0000-0000-000000000099'},
  });
  await assertCallbackRejected({
    name: 'wrong-audience',
    claimOverrides: {aud: '00000000-0000-0000-0000-000000000099'},
  });
  await assertCallbackRejected({
    name: 'mismatched-nonce',
    claimOverrides: ({nonce}) => ({nonce: `${nonce}-mismatch`}),
  });
  await assertCallbackRejected({
    name: 'expired-token',
    claimOverrides: {exp: Math.floor(Date.now() / 1000) - 60},
  });
  await assertCallbackRejected({
    name: 'unlinked-identity',
    claimOverrides: {
      oid: 'unlinked-provider-subject',
      preferred_username: 'unlinked.user@example.test',
    },
    expectedLocation: '/login?error=entra_unlinked_user',
  });

  const emailOnlyAddress = 'email-only.user@example.test';
  const emailOnlySubject = 'email-only-provider-subject';
  const emailOnlyUser = await pool.query(`
    insert into users (username, email, status)
    values ('email-only-user', $1, 'Active')
    returning id
  `, [emailOnlyAddress]);
  await pool.query(
    'insert into user_roles (user_id, role_id) select $1, id from roles order by name limit 1',
    [emailOnlyUser.rows[0].id],
  );

  await assertCallbackRejected({
    name: 'email-only-unlinked-identity',
    claimOverrides: {
      oid: emailOnlySubject,
      preferred_username: emailOnlyAddress,
    },
    expectedLocation: '/login?error=entra_unlinked_user',
  });

  const emailOnlyUserState = await pool.query(
    'select entra_object_id from users where id = $1',
    [emailOnlyUser.rows[0].id],
  );
  const emailOnlyLinks = await pool.query(`
    select count(*)::int as count
    from identity_provider_links
    where provider = 'entra'
      and (provider_subject = $1 or lower(provider_upn) = lower($2))
  `, [emailOnlySubject, emailOnlyAddress]);
  assert.equal(emailOnlyUserState.rows[0]?.entra_object_id, null, 'email-only rejection must not link the user');
  assert.equal(Number(emailOnlyLinks.rows[0]?.count || 0), 0, 'email-only rejection must not create an identity-provider link');
  await pool.query('delete from users where id = $1', [emailOnlyUser.rows[0].id]);

  const afterRejectedUsers = Number((await pool.query('select count(*)::int as count from users')).rows[0].count);
  const afterRejectedEmployees = Number((await pool.query('select count(*)::int as count from employees')).rows[0].count);
  assert.equal(afterRejectedUsers, beforeUsers, 'rejected callbacks must not create users');
  assert.equal(afterRejectedEmployees, beforeEmployees, 'rejected callbacks must not create employees');

  await pool.query(`insert into country_directors (id,name,region)
    values ('synthetic-login-director','Synthetic login director','Synthetic region')`);
  const syntheticEmployee = await pool.query(`insert into employees
      (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,
        entra_object_id,organization_id,legal_entity_id)
    values ('synthetic-login-employee','SYNTHETIC-LOGIN-EMP','Synthetic login employee',
      'synthetic.employee@example.test','Consultant','Synthetic','US','synthetic-login-director','Active',
      'synthetic-provider-subject','org-default','legal-default') returning id`);
  const syntheticUser = await pool.query(`insert into users
      (username,employee_id,employee_record_id,email,entra_object_id,status)
    values ('synthetic-user','SYNTHETIC-LOGIN-EMP',$1,'synthetic.user@example.test','synthetic-provider-subject','Active')
    returning id`, [syntheticEmployee.rows[0].id]);
  await pool.query(`insert into user_organization_scopes (user_id,organization_id,legal_entity_id)
    values ($1,'org-default','legal-default')`, [syntheticUser.rows[0].id]);
  await pool.query(`insert into entra_group_role_mappings(id,group_id,group_name,role_name,active)
    values ('synthetic-production-role-map','mock-entra-group-employee','Synthetic mapped administrator','Admin',true)
    on conflict(group_id) do update set role_name='Admin',active=true`);
  await pool.query(`insert into entra_group_role_mappings(id,group_id,group_name,role_name,active)
    values ('synthetic-production-role-alternative','mock-entra-group-secondary','Synthetic alternative administrator','Admin',true)`);
  await pool.query('update deployment_session_policy set lifetime_ms=14400000');
  const staleReadiness = await fetchWithTimeout(`${serviceOrigin}/api/health/ready`, {}, 1000);
  assert.equal(staleReadiness.status, 503);
  assert.equal((await staleReadiness.json()).sessionPolicy, 'unavailable');
  await assertCallbackRejected({name: 'stale-session-policy', claimOverrides: {groups: ['mock-entra-group-employee']}});
  await pool.query('update deployment_session_policy set lifetime_ms=28800000');

  await pool.query("select public.revoke_account_sessions($1,0,'synthetic-provider-test')", [syntheticUser.rows[0].id]);
  const {state, stateCookie} = await beginAuthorization();
  nextTokenClaimOverrides = {groups:['mock-entra-group-employee','mock-entra-group-secondary']};
  const callbackUrl = `${serviceOrigin}/api/auth/entra/callback?code=synthetic-code&state=${encodeURIComponent(state)}`;
  const callback = await fetchWithTimeout(callbackUrl, {redirect: 'manual', headers: {
    cookie: stateCookie,
    'x-operation-id': 'caller-selected-callback-operation',
  }}, 2000);
  assert.equal(callback.status, 302);
  assert.equal(
    callback.headers.get('location'),
    `${rootOrigin}/auth/entra/complete`,
    `signed callback must complete through the governed application origin; production output:\n${production.output()}`,
  );
  assert.equal(hasSetCookie(callback.headers, 'workos_session'), true, 'valid linked callback must create a WorkOS session');
  const issuedSession = callback.headers.getSetCookie().find(value=>value.startsWith('workos_session=')).split(';',1)[0];
  const issuedToken = issuedSession.slice('workos_session='.length);
  const issuedClaims = JSON.parse(Buffer.from(issuedToken.split('.')[0], 'base64url').toString());
  assert.equal(issuedClaims.identityProvider, 'entra');
  assert.equal(issuedClaims.sessionGeneration, 1);
  assert.deepEqual(issuedClaims.entraGroups, ['mock-entra-group-employee','mock-entra-group-secondary']);
  const mappedIdentity = await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers:{cookie:issuedSession}}, 2000);
  assert.equal(mappedIdentity.status, 200, 'A callback-issued mapped-only account remains authorized');
  assert.equal((await mappedIdentity.json()).activeRole, 'Admin');
  await pool.query("update entra_group_role_mappings set active=false where group_id='mock-entra-group-employee'");
  const alternativeMapping = await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers:{cookie:issuedSession}}, 2000);
  assert.equal(alternativeMapping.status, 200, 'Another verified mapped group preserves the same assigned role');
  await pool.query("update entra_group_role_mappings set active=false where group_id='mock-entra-group-secondary'");
  const revokedMapping = await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers:{cookie:issuedSession}}, 2000);
  assert.equal(revokedMapping.status, 403, 'A callback-issued cookie loses a removed mapping immediately');
  assert.equal((await revokedMapping.json()).code, 'SESSION_ROLE_REVOKED');
  // The preceding test intentionally removes both mapped roles. Restore one
  // verified mapping while testing the independent session-revocation boundary.
  await pool.query("update entra_group_role_mappings set active=true where group_id='mock-entra-group-secondary'");
  const productionSessionCookie = (callback.headers.getSetCookie?.() || [callback.headers.get('set-cookie') || ''])
    .flatMap(value => value.split(/,\s*(?=workos_session=)/))
    .find(value => value.startsWith('workos_session='))?.split(';')[0];
  assert.ok(productionSessionCookie, 'signed provider callback must expose the exact session cookie');
  const providerSession = await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers: {cookie: productionSessionCookie}});
  assert.equal(providerSession.status, 200);
  const providerSessionBody = await providerSession.json();
  const providerClaims = JSON.parse(Buffer.from(productionSessionCookie.slice('workos_session='.length).split('.')[0], 'base64url').toString());
  const refreshedClaims = JSON.parse(Buffer.from(providerSessionBody.token.split('.')[0], 'base64url').toString());
  assert.match(providerClaims.sid, /^[a-f0-9-]{36}$/);
  assert.equal(refreshedClaims.sid, providerClaims.sid);
  assert.equal(refreshedClaims.exp, providerClaims.exp, 'production refresh retains the original absolute expiry');
  await pool.query("update entra_group_role_mappings set active=false where group_id='mock-entra-group-secondary'");
  const callbackOperationId = callback.headers.get('x-operation-id');
  assert.match(callbackOperationId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'the side-effecting Entra callback must expose its server-generated operation ID');
  assert.notEqual(callbackOperationId, 'caller-selected-callback-operation',
    'the callback must ignore a caller-supplied operation ID');
  const syncedIdentityLink = await pool.query(`select id,provider_subject,provenance_reference
    from identity_provider_links where employee_id=$1 and provider='entra'`, [syntheticEmployee.rows[0].id]);
  assert.equal(syncedIdentityLink.rowCount, 1, 'a legacy identity match must retain its Entra link upsert');
  assert.equal(syncedIdentityLink.rows[0].provider_subject, 'synthetic-provider-subject');
  assert.match(syncedIdentityLink.rows[0].provenance_reference,
    /^identity-link-ref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'the Entra callback must use the server-owned identity-link provenance reference');
  const loginEvent = await pool.query(`select response_payload
    from integration_event_logs where event_type='EntraLoginSucceeded' and entity_id=$1 order by created_at desc limit 1`,
  [syntheticUser.rows[0].id]);
  assert.equal(loginEvent.rows[0]?.response_payload.identityLinkProvenanceReference,
    syncedIdentityLink.rows[0].provenance_reference,
  'the successful Entra login result must reference the identity-link record without using its business ID');
  assert.equal(loginEvent.rows[0]?.response_payload.operationId, callbackOperationId,
    'the Entra login event must carry the same server-generated operation ID as the callback response');
  const loginAudit = await pool.query(`select new_value,operation_id,correlation_id from audit_logs
    where action='Entra Login' and user_id=$1 order by created_at desc limit 1`,
    [syntheticUser.rows[0].id]);
  assert.equal(loginAudit.rows[0]?.new_value.identityLinkProvenanceReference,
    syncedIdentityLink.rows[0].provenance_reference,
  'the Entra login audit must retain the safe identity-link provenance reference');
  assert.equal(loginAudit.rows[0]?.operation_id, callbackOperationId,
    'the Entra login audit must persist the callback operation ID');
  assert.ok(loginAudit.rows[0]?.correlation_id,
    'the Entra login audit must retain the callback correlation ID');
  const replay = await fetchWithTimeout(callbackUrl, {redirect: 'manual', headers: {cookie: stateCookie}}, 2000);
  assert.equal(replay.status, 302, 'consumed callback replay must reach the OAuth state handler');
  assert.equal(replay.headers.get('location'), '/login?error=entra_invalid_state', 'consumed callback state must not replay');
  await pool.query("update entra_group_role_mappings set active=true where group_id='mock-entra-group-employee'");
  for (const linkStatus of ['Disabled', 'Pending']) {
    await pool.query("update identity_provider_links set status=$1 where employee_id=$2 and provider='entra'", [linkStatus, syntheticEmployee.rows[0].id]);
    await assertCallbackRejected({name: `binding-${linkStatus.toLowerCase()}`, expectedLocation: '/login?error=entra_unlinked_user'});
    assert.equal((await pool.query("select status from identity_provider_links where employee_id=$1 and provider='entra'", [syntheticEmployee.rows[0].id])).rows[0].status, linkStatus,
      'Rejected login must not reactivate a disabled or pending binding through legacy subject columns');
  }
  await pool.query('delete from identity_provider_links where employee_id=$1', [syntheticEmployee.rows[0].id]);
  await pool.query("update users set entra_object_id='synthetic-provider-subject' where id=$1", [syntheticUser.rows[0].id]);
  await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
    values ($1,'org-default','legal-default',true) on conflict do nothing`, [syntheticUser.rows[0].id]);
  for (const key of ['employees.manage','permissions.manage','integrations.identity']) {
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values ('Admin',$1,true)
      on conflict(role_name,permission_key) do update set enabled=true`, [key]);
  }
  const clearProfile=(await pool.query(`select employee_id,name,email,designation,department,country,primary_country_director_id
    from employees where id=$1`,[syntheticEmployee.rows[0].id])).rows[0];
  const clearBinding=await fetchWithTimeout(`${serviceOrigin}/api/employees`,{method:'POST',headers:{cookie:issuedSession,'content-type':'application/json'},
    body:JSON.stringify({...clearProfile,entra_object_id:''})},2000);
  assert.equal(clearBinding.status,200,'Authorized profile clear must revoke a legacy binding');
  const clearState=(await pool.query(`select e.entra_object_id as employee_subject,u.entra_object_id as user_subject,l.status
    from employees e join users u on u.employee_record_id=e.id left join identity_provider_links l on l.employee_id=e.id and l.provider='entra'
    where e.id=$1`,[syntheticEmployee.rows[0].id])).rows[0];
  assert.deepEqual(clearState,{employee_subject:null,user_subject:null,status:'Disabled'});
  await assertCallbackRejected({name:'legacy-profile-unlinked',expectedLocation:'/login?error=entra_unlinked_user'});

  // Exercise a callback that observed legacy identity before waiting for a
  // concurrent unlink transaction: it must re-read authority after the lock.
  await pool.query('delete from identity_provider_links where employee_id=$1',[syntheticEmployee.rows[0].id]);
  await pool.query("update employees set entra_object_id='synthetic-provider-subject' where id=$1",[syntheticEmployee.rows[0].id]);
  await pool.query("update users set entra_object_id='synthetic-provider-subject' where id=$1",[syntheticUser.rows[0].id]);
  const unlinkClient=await pool.connect();
  try {
    await unlinkClient.query('begin');
    await unlinkClient.query('update employees set entra_object_id=null where id=$1',[syntheticEmployee.rows[0].id]);
    await unlinkClient.query('update users set entra_object_id=null where id=$1',[syntheticUser.rows[0].id]);
    const overlapping=await beginAuthorization();
    const pendingCallback=fetchWithTimeout(`${serviceOrigin}/api/auth/entra/callback?code=synthetic-code&state=${encodeURIComponent(overlapping.state)}`,
      {redirect:'manual',headers:{cookie:overlapping.stateCookie}},10000).then(response=>({response}),error=>({error}));
    let waiting=false;
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {
      waiting=(await pool.query(`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
        and query like 'select id from employees where id=%for update'`)).rowCount>0;
      if(waiting) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(waiting,true,'The callback must actually overlap the held worker lock');
    await unlinkClient.query('commit');
    const completed=await pendingCallback;
    if(completed.error) throw completed.error;
    assert.equal(completed.response.status,302);
    assert.equal(completed.response.headers.get('location'),'/login?error=entra_unlinked_user');
    assert.equal(hasSetCookie(completed.response.headers,'workos_session'),false);
    assert.equal((await pool.query('select 1 from identity_provider_links where employee_id=$1',[syntheticEmployee.rows[0].id])).rowCount,0,
      'A stale callback must not recreate a cleared legacy link');
  } finally { await unlinkClient.query('rollback'); unlinkClient.release(); }
  // Complete all retained binding-administration checks before revoking their actor.
  assert.equal((await fetchWithTimeout(`${serviceOrigin}/api/auth/logout`, {method: 'POST', headers: {cookie: productionSessionCookie}})).status, 200);
  assert.equal((await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers: {cookie: productionSessionCookie}})).status, 401,
    'the copied signed-provider cookie must be rejected after logout');
  assert.equal((await fetchWithTimeout(`${serviceOrigin}/api/auth/me`, {headers: {authorization: `Bearer ${providerSessionBody.token}`}})).status, 401,
    'the refreshed signed-provider token must be rejected after logout');

  await pool.query('delete from identity_provider_links where employee_id=$1', [syntheticEmployee.rows[0].id]);
  await pool.query("delete from users where username = 'synthetic-user'");
  await pool.query('delete from employees where id=$1', [syntheticEmployee.rows[0].id]);
  await pool.query("delete from country_directors where id='synthetic-login-director'");

  const discoveryRequestsBeforeOutage = discoveryRequests;
  discoveryUnavailable = true;
  let outageReadiness = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    assert.equal(productionChild.exitCode, null, 'the process should remain available to serve an unready health response');
    const response = await fetchWithTimeout(`${serviceOrigin}/api/health/ready`, {}, 1000);
    const body = await response.json();
    if (response.status === 503 && body.identityProvider === 'unavailable') {
      outageReadiness = {status: response.status, body};
      break;
    }
    await delay(100);
  }
  assert.ok(discoveryRequests > discoveryRequestsBeforeOutage,
    'the periodic identity-provider probe must observe the outage before readiness changes');
  assert.ok(outageReadiness, `readiness must return 503 after an identity-provider probe fails: ${production.output()}`);
  const liveWhileProviderUnavailable = await fetchWithTimeout(`${serviceOrigin}/api/health/live`, {}, 1000);
  assert.equal(liveWhileProviderUnavailable.status, 200, 'identity outage should not make liveness fail');
  assert.match(production.output(), /Identity provider discovery recheck failed: Identity provider discovery returned HTTP 503/);

  const discoveryRequestsBeforeRecovery = discoveryRequests;
  discoveryUnavailable = false;
  let recoveredReadiness = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    assert.equal(productionChild.exitCode, null, 'the process should remain available for the next identity-provider probe');
    const response = await fetchWithTimeout(`${serviceOrigin}/api/health/ready`, {}, 1000);
    const body = await response.json();
    if (response.status === 200 && body.identityProvider === 'available') {
      recoveredReadiness = {status: response.status, body};
      break;
    }
    await delay(100);
  }
  assert.ok(discoveryRequests > discoveryRequestsBeforeRecovery,
    'a later successful identity-provider probe must run after the outage');
  assert.ok(recoveredReadiness, `readiness should recover after the provider responds again: ${production.output()}`);
  // Observe the production timer on the same process that served the failure and recovery journeys.
  const metricsDeadline = Date.now() + 75_000;
  let sawSuccess = false, sawDenial = false, sawFailure = false;
  while (Date.now() < metricsDeadline) {
    assert.equal(productionChild.exitCode, null);
    for (const line of production.output().split(/\r?\n/).slice(0, -1)) {
      if (!line.includes('"operation":"http.traffic"')) continue;
      const metric = JSON.parse(line);
      assert.equal(metric.service, 'api');
      assert.equal(Object.values(metric.responses).reduce((a,b)=>a+b,0),
        metric.latencyCounts.reduce((a,b)=>a+b,0));
      sawSuccess ||= metric.responses['2xx'] > 0;
      sawDenial ||= metric.responses['4xx'] > 0;
      sawFailure ||= metric.responses['5xx'] > 0;
    }
    if (sawSuccess && sawDenial && sawFailure) break;
    await delay(250);
  }
  assert.ok(sawSuccess && sawDenial && sawFailure, 'Production logs must include successful, denied and unavailable responses');
  await terminate(productionChild);
  productionChild = null;

  results.push({
    name: 'configured-provider-ready-then-unavailable',
    startup: 'ready',
    database: health.database,
    localLogin: localLogin.status,
    protectedApi: protectedApi.status,
    usersBefore: beforeUsers,
    usersAfter: afterRejectedUsers,
    employeesBefore: beforeEmployees,
    employeesAfter: afterRejectedEmployees,
    outageReadiness: outageReadiness.status,
    recoveryReadiness: recoveredReadiness.status,
  });
} finally {
  productionOutputForCallback = () => '';
  await closeDiscovery();
  await terminate(productionChild);
  await pool.end();
  rmSync(certificateDirectory, {recursive: true, force: true});
}

const report = {
  status: 'passed',
  cases: results,
  callbackRejections,
};
const evidencePath = String(process.env.WOS_PRODUCTION_IDENTITY_EVIDENCE || '').trim();
if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
