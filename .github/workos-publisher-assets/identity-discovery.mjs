const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MICROSOFT_HOST = 'login.microsoftonline.com';

const isTrue = (value) => ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};
const isLoopbackHostname = (hostname) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
const normalizeUrl = (value) => new URL(String(value || '').trim()).toString();
const normalizeWithoutTrailingSlash = (value) => normalizeUrl(value).replace(/\/$/, '');

const loopbackTransportAllowed = (env, parsed) => {
  if (!isTrue(env.IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK)) return false;
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) return false;
  try {
    const appUrl = new URL(String(env.APP_URL || ''));
    return ['http:', 'https:'].includes(appUrl.protocol) && isLoopbackHostname(appUrl.hostname);
  } catch {
    return false;
  }
};

const validateTransportUrl = (value, {env, allowLoopback, label}) => {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} URL is invalid.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} URL must not contain credentials.`);
  if (parsed.protocol !== 'https:') {
    if (!(allowLoopback && loopbackTransportAllowed(env, parsed))) {
      throw new Error(`${label} URL must use HTTPS.`);
    }
  }
  return parsed;
};

const readBoundedJson = async (response, maxBytes, label) => {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} response exceeds the configured size limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`${label} response exceeds the configured size limit.`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
};

export const fetchGovernedIdentityJson = async (value, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  allowLoopback = false,
  label = 'Identity provider endpoint',
  method = 'GET',
  headers,
  body,
} = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error('Identity provider fetch implementation is unavailable.');
  const requested = validateTransportUrl(value, {env, allowLoopback, label});
  const timeoutMs = boundedNumber(env.IDENTITY_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 15000);
  const maxBytes = boundedNumber(env.IDENTITY_DISCOVERY_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, 1024 * 1024);
  let response;
  try {
    response = await fetchImpl(requested, {
      method,
      headers: {accept: 'application/json', ...(headers || {})},
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${label} redirects are prohibited.`);
  }
  const effective = validateTransportUrl(response.url || requested, {
    env,
    allowLoopback,
    label: `${label} effective`,
  });
  if (effective.toString() !== requested.toString()) {
    throw new Error(`${label} effective URL does not match the requested URL.`);
  }
  const payload = await readBoundedJson(response, maxBytes, label);
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `${label} returned HTTP ${response.status}.`);
  }
  return {response, payload, requestedUrl: requested.toString()};
};

const expectedTenantRoot = (tenantId) => `https://${MICROSOFT_HOST}/${encodeURIComponent(tenantId)}`;
const expectedMetadata = (tenantId) => ({
  issuer: `${expectedTenantRoot(tenantId)}/v2.0`,
  authorization_endpoint: `${expectedTenantRoot(tenantId)}/oauth2/v2.0/authorize`,
  token_endpoint: `${expectedTenantRoot(tenantId)}/oauth2/v2.0/token`,
  jwks_uri: `${expectedTenantRoot(tenantId)}/discovery/v2.0/keys`,
});

const validateTenantEndpoint = (value, expected, key) => {
  let actual;
  try {
    actual = normalizeWithoutTrailingSlash(value);
  } catch {
    throw new Error(`Identity provider discovery ${key} is invalid.`);
  }
  if (actual.toLowerCase() !== normalizeWithoutTrailingSlash(expected).toLowerCase()) {
    throw new Error(`Identity provider discovery ${key} is not bound to ENTRA_TENANT_ID.`);
  }
  return actual;
};

export const getEntraDiscoveryUrl = (env = process.env) => {
  const tenantId = String(env.ENTRA_TENANT_ID || '').trim();
  if (!tenantId) throw new Error('ENTRA_TENANT_ID is required in production.');
  return String(
    env.ENTRA_OPENID_CONFIGURATION_URL
    || `${expectedTenantRoot(tenantId)}/v2.0/.well-known/openid-configuration`,
  ).trim();
};

export const loadEntraOpenIdConfiguration = async ({env = process.env, fetchImpl = globalThis.fetch} = {}) => {
  const tenantId = String(env.ENTRA_TENANT_ID || '').trim();
  if (!tenantId) throw new Error('ENTRA_TENANT_ID is required in production.');
  const discoveryUrl = getEntraDiscoveryUrl(env);
  const {payload} = await fetchGovernedIdentityJson(discoveryUrl, {
    env,
    fetchImpl,
    allowLoopback: true,
    label: 'Identity provider discovery',
  });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Identity provider discovery returned an invalid document.');
  }
  const expected = expectedMetadata(tenantId);
  return {
    ...payload,
    issuer: validateTenantEndpoint(payload.issuer, expected.issuer, 'issuer'),
    authorization_endpoint: validateTenantEndpoint(
      payload.authorization_endpoint,
      expected.authorization_endpoint,
      'authorization_endpoint',
    ),
    token_endpoint: validateTenantEndpoint(payload.token_endpoint, expected.token_endpoint, 'token_endpoint'),
    jwks_uri: validateTenantEndpoint(payload.jwks_uri, expected.jwks_uri, 'jwks_uri'),
  };
};
