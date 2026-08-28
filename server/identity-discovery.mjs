const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;

const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
};

const normalized = (value) => String(value || '').trim().replace(/\/+$/, '');

export const requireSecureUrl = (value, label) => {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must use HTTPS without embedded credentials.`);
  }
  return url;
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
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} response is too large.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} response is too large.`);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`${label} returned invalid JSON.`); }
};

export const getEntraDiscoveryUrl = () => {
  const configured = String(process.env.ENTRA_OPENID_CONFIGURATION_URL || '').trim();
  if (configured) return configured;
  const tenant = encodeURIComponent(String(process.env.ENTRA_TENANT_ID || '').trim());
  return `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
};

export const loadEntraOpenIdConfiguration = async () => {
  const tenant = String(process.env.ENTRA_TENANT_ID || '').trim();
  if (!tenant) throw new Error('ENTRA_TENANT_ID is required in production.');
  const payload = await fetchBoundedJson(getEntraDiscoveryUrl(), 'Identity provider discovery');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Identity provider discovery returned an invalid response.');
  const issuer = requireSecureUrl(payload.issuer, 'Identity provider discovery issuer');
  if (!issuer.pathname.split('/').includes(tenant) || !issuer.pathname.endsWith('/v2.0')) {
    throw new Error('Identity provider discovery issuer does not match ENTRA_TENANT_ID.');
  }
  const expectedOrigin = issuer.origin;
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!payload[key]) throw new Error(`Identity provider discovery is missing ${key}.`);
    const endpoint = requireSecureUrl(payload[key], `Identity provider discovery ${key}`);
    if (endpoint.origin !== expectedOrigin || !endpoint.pathname.includes(`/${tenant}/`)) {
      throw new Error(`Identity provider discovery ${key} is not bound to ENTRA_TENANT_ID.`);
    }
  }
  return payload;
};
