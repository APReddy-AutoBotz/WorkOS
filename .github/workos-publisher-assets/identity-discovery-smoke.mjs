import assert from 'node:assert/strict';
import {loadEntraOpenIdConfiguration} from '../server/identity-discovery.mjs';

const tenant = '00000000-0000-0000-0000-000000000001';
const discoveryUrl = `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
const valid = {
  issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
};
const env = {
  ENTRA_TENANT_ID: tenant,
  ENTRA_OPENID_CONFIGURATION_URL: discoveryUrl,
  IDENTITY_DISCOVERY_TIMEOUT_MS: '1000',
};

const response = (payload, {
  status = 200,
  url = discoveryUrl,
  headers = {},
} = {}) => {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: {
      get: (name) => headers[String(name).toLowerCase()]
        || (String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null),
    },
    arrayBuffer: async () => bytes,
  };
};

let requested = null;
const configured = await loadEntraOpenIdConfiguration({
  env,
  fetchImpl: async (url, options) => {
    requested = {url: url.toString(), options};
    return response(valid);
  },
});
assert.equal(requested.url, discoveryUrl);
assert.equal(requested.options.redirect, 'manual');
assert.equal(configured.issuer, valid.issuer);
assert.equal(configured.authorization_endpoint, valid.authorization_endpoint);

await assert.rejects(
  loadEntraOpenIdConfiguration({
    env,
    fetchImpl: async () => response({}, {status: 302}),
  }),
  /redirects are prohibited/,
);

await assert.rejects(
  loadEntraOpenIdConfiguration({
    env,
    fetchImpl: async () => response(valid, {url: 'http://identity.example.test/downgraded'}),
  }),
  /effective URL must use HTTPS/,
);

await assert.rejects(
  loadEntraOpenIdConfiguration({
    env,
    fetchImpl: async () => response({
      ...valid,
      issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
    }),
  }),
  /issuer is not bound to ENTRA_TENANT_ID/,
);

await assert.rejects(
  loadEntraOpenIdConfiguration({
    env,
    fetchImpl: async () => response({
      ...valid,
      token_endpoint: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token',
    }),
  }),
  /token_endpoint is not bound to ENTRA_TENANT_ID/,
);

await assert.rejects(
  loadEntraOpenIdConfiguration({
    env: {...env, IDENTITY_DISCOVERY_MAX_BYTES: '1024'},
    fetchImpl: async () => response({...valid, padding: 'x'.repeat(2048)}),
  }),
  /response exceeds the configured size limit/,
);

console.log(JSON.stringify({
  status: 'passed',
  exactDiscoveryUrl: true,
  redirectsRejected: true,
  effectiveDowngradeRejected: true,
  issuerTenantBound: true,
  endpointsTenantBound: true,
  responseBounded: true,
}, null, 2));
