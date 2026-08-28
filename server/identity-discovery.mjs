const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const ENTRA_PUBLIC_AUTHORITY = 'https://login.microsoftonline.com';
const APPROVED_ENTRA_AUTHORITIES = new Set([
  ENTRA_PUBLIC_AUTHORITY,
  'https://login.microsoftonline.us',
  'https://login.partner.microsoftonline.cn',
]);
const ENTRA_CALLBACK_PATH = '/api/auth/entra/callback';

const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
};

const exactOrigin = (value, label) => {
  const url = requireSecureUrl(value, label);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${label} must be an origin without a path, query or fragment.`);
  return url.origin.toLowerCase();
};

export const requireSecureUrl = (value, label) => {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must use HTTPS without embedded credentials.`);
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error(`${label} must not use a loopback host.`);
  }
  return url;
};

export const getGovernedAppUrls = () => {
  const app = requireSecureUrl(process.env.APP_URL, 'APP_URL');
  if (app.pathname !== '/' || app.search || app.hash) throw new Error('APP_URL must be an origin without a path, query or fragment.');
  const redirect = requireSecureUrl(process.env.ENTRA_REDIRECT_URI, 'ENTRA_REDIRECT_URI');
  if (redirect.origin !== app.origin || redirect.pathname !== ENTRA_CALLBACK_PATH || redirect.search || redirect.hash) {
    throw new Error(`ENTRA_REDIRECT_URI must use the APP_URL origin and exact ${ENTRA_CALLBACK_PATH} route.`);
  }
  return {appUrl: new URL('/', app).href, redirectUri: redirect.href};
};

export const getApprovedEntraAuthority = () => {
  const configured = String(process.env.ENTRA_AUTHORITY || ENTRA_PUBLIC_AUTHORITY).trim();
  const authority = exactOrigin(configured, 'ENTRA_AUTHORITY');
  if (!APPROVED_ENTRA_AUTHORITIES.has(authority)) throw new Error('ENTRA_AUTHORITY is not an approved Microsoft Entra authority.');
  return authority;
};

const cancelBody = async (body) => {
  try { await body?.cancel(); } catch { /* The limit error remains authoritative. */ }
};

const readBoundedBody = async (response, label, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response.body);
    throw new Error(`${label} response is too large.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response is too large.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const fetchBoundedJson = async (value, label, options = {}) => {
  const url = requireSecureUrl(value, label);
  const timeoutMs = boundedNumber(options.timeoutMs ?? process.env.IDENTITY_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 15000);
  const maxBytes = boundedNumber(options.maxBytes, DEFAULT_MAX_BYTES, 1024, 1024 * 1024);
  let response;
  try {
    response = await fetch(url, {...options.fetchOptions, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)});
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (response.status >= 300 && response.status < 400) throw new Error(`${label} redirects are prohibited.`);
  if (response.url && new URL(response.url).href !== url.href) throw new Error(`${label} effective URL changed.`);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const bytes = await readBoundedBody(response, label, maxBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`${label} returned invalid JSON.`); }
};

export const getEntraDiscoveryUrl = () => {
  const tenant = encodeURIComponent(String(process.env.ENTRA_TENANT_ID || '').trim());
  return `${getApprovedEntraAuthority()}/${tenant}/v2.0/.well-known/openid-configuration`;
};

const requireExactEndpoint = (value, label, authority, expectedPath) => {
  const endpoint = requireSecureUrl(value, label);
  if (endpoint.origin.toLowerCase() !== authority || endpoint.pathname !== expectedPath || endpoint.search || endpoint.hash) {
    throw new Error(`${label} does not match the approved Entra authority and tenant path.`);
  }
  return endpoint.href;
};

export const loadEntraOpenIdConfiguration = async () => {
  const tenant = String(process.env.ENTRA_TENANT_ID || '').trim();
  if (!tenant) throw new Error('ENTRA_TENANT_ID is required in production.');
  const authority = getApprovedEntraAuthority();
  const expectedDiscovery = `${authority}/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`;
  const configuredDiscovery = requireSecureUrl(process.env.ENTRA_OPENID_CONFIGURATION_URL || expectedDiscovery, 'ENTRA_OPENID_CONFIGURATION_URL');
  if (configuredDiscovery.href !== expectedDiscovery) throw new Error('ENTRA_OPENID_CONFIGURATION_URL does not match the approved Entra authority and tenant path.');
  const payload = await fetchBoundedJson(expectedDiscovery, 'Identity provider discovery');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Identity provider discovery returned an invalid response.');
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!payload[key]) throw new Error(`Identity provider discovery is missing ${key}.`);
  }
  const prefix = `/${tenant}`;
  const validated = {
    ...payload,
    issuer: requireExactEndpoint(payload.issuer, 'Identity provider discovery issuer', authority, `${prefix}/v2.0`),
    authorization_endpoint: requireExactEndpoint(payload.authorization_endpoint, 'Identity provider discovery authorization_endpoint', authority, `${prefix}/oauth2/v2.0/authorize`),
    token_endpoint: requireExactEndpoint(payload.token_endpoint, 'Identity provider discovery token_endpoint', authority, `${prefix}/oauth2/v2.0/token`),
    jwks_uri: requireExactEndpoint(payload.jwks_uri, 'Identity provider discovery jwks_uri', authority, `${prefix}/discovery/v2.0/keys`),
  };
  return validated;
};
