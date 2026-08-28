import assert from 'node:assert/strict';
import {fetchBoundedJson, loadEntraOpenIdConfiguration} from '../server/identity-discovery.mjs';

const tenant = '00000000-0000-0000-0000-000000000001';
const origin = 'https://login.microsoftonline.com';
const discoveryUrl = `${origin}/${tenant}/v2.0/.well-known/openid-configuration`;
const valid = {
  issuer: `${origin}/${tenant}/v2.0`,
  authorization_endpoint: `${origin}/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `${origin}/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `${origin}/${tenant}/discovery/v2.0/keys`,
};
const originalFetch = globalThis.fetch;
const originalEnvironment = {...process.env};
const response = (payload, options = {}) => new Response(JSON.stringify(payload), {
  status: options.status || 200,
  headers: {'content-type': 'application/json', ...(options.headers || {})},
});

try {
  process.env.ENTRA_TENANT_ID = tenant;
  process.env.ENTRA_OPENID_CONFIGURATION_URL = discoveryUrl;
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = {url: String(url), options};
    return response(valid);
  };
  assert.deepEqual(await loadEntraOpenIdConfiguration(), valid);
  assert.equal(requested.url, discoveryUrl);
  assert.equal(requested.options.redirect, 'manual');

  for (const obsolete of ['IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK', 'ALLOW_HTTP_IDENTITY_DISCOVERY']) {
    process.env[obsolete] = 'true';
    await assert.rejects(() => fetchBoundedJson('http://127.0.0.1/discovery', 'Identity provider discovery'), /must use HTTPS/);
  }
  globalThis.fetch = async () => response({}, {status: 302, headers: {location: 'http://127.0.0.1/discovery'}});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /redirects are prohibited/);

  globalThis.fetch = async () => response({...valid, issuer: `${origin}/wrong/v2.0`});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /issuer does not match/);
  globalThis.fetch = async () => response({...valid, token_endpoint: 'https://identity.example.test/token'});
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /not bound/);
  globalThis.fetch = async () => new Response('x'.repeat(300_000));
  await assert.rejects(() => loadEntraOpenIdConfiguration(), /too large/);
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
}

console.log('identity discovery security smoke passed');
