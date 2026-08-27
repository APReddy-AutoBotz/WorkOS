import 'dotenv/config';

process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';

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

await import('./migrate.mjs');
await import('./index.mjs');
