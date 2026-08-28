import 'dotenv/config';

process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';

const isTrue = (value) => ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};
const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/, '');
const isLoopbackHostname = (hostname) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);

if (String(process.env.AUTO_SEED_DEMO || '').toLowerCase() === 'true') {
  throw new Error('AUTO_SEED_DEMO is prohibited in production.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
if (!process.env.API_SESSION_SECRET || process.env.API_SESSION_SECRET === 'dev-only-change-me') {
  throw new Error('A non-default API_SESSION_SECRET is required in production.');
}
const identityProvider = String(process.env.IDENTITY_PROVIDER || '').trim().toLowerCase();
if (!['entra', 'oidc'].includes(identityProvider)) {
  throw new Error('IDENTITY_PROVIDER must select a governed non-local provider (entra or oidc) in production.');
}
const requiredIdentitySettings = identityProvider === 'entra'
  ? ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI']
  : ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'];
for (const setting of requiredIdentitySettings) {
  if (!String(process.env[setting] || '').trim()) throw new Error(setting + ' is required in production.');
}
process.env.LOCAL_LOGIN_ENABLED = 'false';

const discoveryUrl = (() => {
  if (identityProvider === 'entra') {
    const tenantId = encodeURIComponent(String(process.env.ENTRA_TENANT_ID).trim());
    return String(
      process.env.ENTRA_OPENID_CONFIGURATION_URL
      || `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
    ).trim();
  }
  const issuer = normalizeUrl(process.env.OIDC_ISSUER_URL);
  return String(
    process.env.OIDC_DISCOVERY_URL
    || `${issuer}/.well-known/openid-configuration`,
  ).trim();
})();

const validateDiscoveryUrl = () => {
  let parsed;
  try {
    parsed = new URL(discoveryUrl);
  } catch {
    throw new Error('Identity provider discovery URL is invalid.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Identity provider discovery URL must not contain credentials.');
  }
  if (parsed.protocol !== 'https:') {
    const loopbackAllowed = isTrue(process.env.IDENTITY_DISCOVERY_ALLOW_HTTP_LOOPBACK)
      && parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname);
    if (!loopbackAllowed) {
      throw new Error('Identity provider discovery URL must use HTTPS in production.');
    }
  }
  return parsed;
};

const validateEndpoint = (payload, key) => {
  const value = String(payload?.[key] || '').trim();
  if (!value) throw new Error(`Identity provider discovery is missing ${key}.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Identity provider discovery ${key} is invalid.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Identity provider discovery ${key} must use HTTPS.`);
  }
  return value;
};

const probeIdentityProvider = async () => {
  const url = validateDiscoveryUrl();
  const timeoutMs = boundedNumber(process.env.IDENTITY_DISCOVERY_TIMEOUT_MS, 5000, 500, 15000);
  let response;
  try {
    response = await fetch(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Identity provider discovery is unavailable.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error('Identity provider discovery returned an invalid response.');
  }
  validateEndpoint(payload, 'authorization_endpoint');
  validateEndpoint(payload, 'token_endpoint');
  validateEndpoint(payload, 'jwks_uri');
  const issuer = validateEndpoint(payload, 'issuer');
  if (identityProvider === 'oidc') {
    const configuredIssuer = normalizeUrl(process.env.OIDC_ISSUER_URL);
    if (normalizeUrl(issuer) !== configuredIssuer) {
      throw new Error('Identity provider discovery issuer does not match OIDC_ISSUER_URL.');
    }
  }
  return true;
};

await probeIdentityProvider();

const discoveryRecheckMs = boundedNumber(
  process.env.IDENTITY_DISCOVERY_RECHECK_MS,
  60000,
  5000,
  300000,
);
const identityReadinessTimer = setInterval(() => {
  void probeIdentityProvider().catch((error) => {
    console.error(`Identity provider discovery recheck failed: ${error.message}`);
    process.exit(1);
  });
}, discoveryRecheckMs);
identityReadinessTimer.unref();

await import('./migrate.mjs');
await import('./index.mjs');
