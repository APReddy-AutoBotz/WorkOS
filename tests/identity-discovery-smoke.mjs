import assert from 'node:assert/strict';
import {
  fetchBoundedJson,
  getApprovedEntraAuthority,
  getGovernedAppUrls,
  loadEntraOpenIdConfiguration,
} from '../server/identity-discovery.mjs';

const tenant = '00000000-0000-0000-0000-000000000001';
const publicAuthority = 'https://login.microsoftonline.com';
const sovereignAuthority = 'https://login.microsoftonline.us';
const discoveryUrl = (authority) => `${authority}/${tenant}/v2.0/.well-known/openid-configuration`;
const discoveryPayload = (authority) => ({
  issuer: `${authority}/${tenant}/v2.0`,
  authorization_endpoint: `${authority}/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `${authority}/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `${authority}/${tenant}/discovery/v2.0/keys`,
});
const originalFetch = globalThis.fetch;
const originalEnvironment = {...process.env};
const jsonResponse = (payload, options = {}) => new Response(JSON.stringify(payload), {
  status: options.status || 200,
  headers: {'content-type': 'application/json', ...(options.headers || {})},
});

const useAuthority = (authority) => {
  process.env.ENTRA_TENANT_ID = tenant;
  process.env.ENTRA_AUTHORITY = authority;
  process.env.ENTRA_OPENID_CONFIGURATION_URL = discoveryUrl(authority);
};

const assertEarlyCancellation = async (label) => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(600));
      if (pulls > 10) controller.close();
    },
    cancel() { cancelled = true; },
  });
  globalThis.fetch = async () => new Response(body, {status: 200});
  await assert.rejects(
    () => fetchBoundedJson('https://login.microsoftonline.com/bounded', label, {maxBytes: 1024}),
    /response is too large/,
  );
  assert.equal(cancelled, true, `${label} stream must be cancelled`);
  assert.ok(pulls <= 3, `${label} must reject before consuming the whole stream`);
};

try {
  useAuthority(publicAuthority);
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = {url: String(url), options};
    return jsonResponse(discoveryPayload(publicAuthority));
  };
  assert.deepEqual(await loadEntraOpenIdConfiguration(), discoveryPayload(publicAuthority));
  assert.equal(requested.url, discoveryUrl(publicAuthority));
  assert.equal(requested.options.redirect, 'manual');

  useAuthority(sovereignAuthority);
  globalThis.fetch = async () => jsonResponse(discoveryPayload(sovereignAuthority));
  assert.equal(getApprovedEntraAuthority(), sovereignAuthority);
  assert.deepEqual(await loadEntraOpenIdConfiguration(), discoveryPayload(sovereignAuthority));

  process.env.ENTRA_AUTHORITY = 'https://identity.example.test';
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /not an approved Microsoft Entra authority/);
  process.env.ENTRA_AUTHORITY = publicAuthority;
  process.env.ENTRA_OPENID_CONFIGURATION_URL = 'https://identity.example.test/discovery';
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /does not match the approved Entra authority/);

  useAuthority(publicAuthority);
  globalThis.fetch = async () => jsonResponse(discoveryPayload(publicAuthority), {status: 302, headers: {location: 'http://127.0.0.1/discovery'}});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /redirects are prohibited/);
  globalThis.fetch = async () => jsonResponse({...discoveryPayload(publicAuthority), issuer: `${publicAuthority}/wrong/v2.0`});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /issuer does not match/);
  globalThis.fetch = async () => jsonResponse({...discoveryPayload(publicAuthority), token_endpoint: `${publicAuthority}/${tenant}/oauth2/v2.0/other`});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /token_endpoint does not match/);
  globalThis.fetch = async () => jsonResponse({...discoveryPayload(publicAuthority), jwks_uri: 'https://identity.example.test/keys'});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /jwks_uri does not match/);

  for (const obsolete of ['IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK', 'ALLOW_HTTP_IDENTITY_DISCOVERY']) {
    process.env[obsolete] = 'true';
    await assert.rejects(() => fetchBoundedJson('http://127.0.0.1/discovery', 'Identity provider discovery'), /must use HTTPS/);
  }
  for (const label of ['Identity provider discovery', 'Microsoft token endpoint', 'Microsoft JWKS endpoint']) {
    await assertEarlyCancellation(label);
  }

  process.env.APP_URL = 'https://app.example.test';
  process.env.ENTRA_REDIRECT_URI = 'https://app.example.test/api/auth/entra/callback';
  assert.deepEqual(getGovernedAppUrls(), {
    appUrl: 'https://app.example.test/',
    redirectUri: 'https://app.example.test/api/auth/entra/callback',
  });
  const credentialAppUrl = new URL('https://app.example.test');
  credentialAppUrl.username = 'user';
  for (const [appUrl, redirectUri] of [
    [undefined, 'https://app.example.test/api/auth/entra/callback'],
    ['http://app.example.test', 'http://app.example.test/api/auth/entra/callback'],
    ['https://localhost', 'https://localhost/api/auth/entra/callback'],
    [credentialAppUrl.href, 'https://app.example.test/api/auth/entra/callback'],
    ['https://app.example.test', 'http://app.example.test/api/auth/entra/callback'],
    ['https://app.example.test', 'https://other.example.test/api/auth/entra/callback'],
    ['https://app.example.test', 'https://app.example.test/wrong'],
    ['https://app.example.test/subpath', 'https://app.example.test/api/auth/entra/callback'],
  ]) {
    if (appUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = appUrl;
    process.env.ENTRA_REDIRECT_URI = redirectUri;
    assert.throws(() => getGovernedAppUrls(), /APP_URL|ENTRA_REDIRECT_URI/);
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}

console.log('identity discovery security smoke passed');
