import 'dotenv/config';
import {loadEntraOpenIdConfiguration} from './identity-discovery.mjs';

process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';

const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};

if (String(process.env.AUTO_SEED_DEMO || '').toLowerCase() === 'true') {
  throw new Error('AUTO_SEED_DEMO is prohibited in production.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
if (!process.env.API_SESSION_SECRET || process.env.API_SESSION_SECRET === 'dev-only-change-me') {
  throw new Error('A non-default API_SESSION_SECRET is required in production.');
}
const identityProvider = String(process.env.IDENTITY_PROVIDER || '').trim().toLowerCase();
if (identityProvider !== 'entra') {
  throw new Error('IDENTITY_PROVIDER must select the implemented governed Entra provider in production.');
}
const requiredIdentitySettings = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI'];
for (const setting of requiredIdentitySettings) {
  if (!String(process.env[setting] || '').trim()) throw new Error(setting + ' is required in production.');
}
process.env.LOCAL_LOGIN_ENABLED = 'false';

const probeIdentityProvider = loadEntraOpenIdConfiguration;

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
