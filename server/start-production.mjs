import 'dotenv/config';
import {getGovernedAppUrls, loadEntraOpenIdConfiguration} from './identity-discovery.mjs';
import {createIdentityProviderReadinessMonitor, setIdentityProviderAvailability} from './identity-readiness.mjs';
import {validateRuntimeEnvironment} from './environment.mjs';
import {formatSafeMigrationFailure, runMigrations} from './migration-runner.mjs';

process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';

if (String(process.env.LOCAL_LOGIN_ENABLED || '').toLowerCase() === 'true') {
  throw new Error('LOCAL_LOGIN_ENABLED is prohibited in production.');
}
process.env.LOCAL_LOGIN_ENABLED = 'false';
const runtimeEnvironment = validateRuntimeEnvironment(process.env, {purpose: 'production'});

const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};

if (String(process.env.AUTO_SEED_DEMO || '').toLowerCase() === 'true') {
  throw new Error('AUTO_SEED_DEMO is prohibited in production.');
}
const identityProvider = String(process.env.IDENTITY_PROVIDER || '').trim().toLowerCase();
if (identityProvider !== 'entra') {
  throw new Error('IDENTITY_PROVIDER must select the implemented governed Entra provider in production.');
}
const requiredIdentitySettings = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI'];
for (const setting of requiredIdentitySettings) {
  if (!String(process.env[setting] || '').trim()) throw new Error(setting + ' is required in production.');
}
getGovernedAppUrls();

const probeIdentityProvider = loadEntraOpenIdConfiguration;
const refreshIdentityProviderReadiness = createIdentityProviderReadinessMonitor({
  probe: probeIdentityProvider,
  onAvailabilityChange: setIdentityProviderAvailability,
});

await refreshIdentityProviderReadiness();

const discoveryRecheckMs = boundedNumber(
  process.env.IDENTITY_DISCOVERY_RECHECK_MS,
  60000,
  5000,
  300000,
);
const identityReadinessTimer = setInterval(() => {
  void refreshIdentityProviderReadiness().catch((error) => {
    console.error(`Identity provider discovery recheck failed: ${error.message}`);
  });
}, discoveryRecheckMs);
identityReadinessTimer.unref();

let migrationsReady = false;
try {
  await runMigrations({databaseUrl: runtimeEnvironment.databaseUrl, sslMode: runtimeEnvironment.pgSslMode, sslRootCert: runtimeEnvironment.pgSslRootCert});
  migrationsReady = true;
} catch (error) {
  console.error(`Production startup blocked: ${formatSafeMigrationFailure(error)}`);
}

if (migrationsReady) await import('./index.mjs');
else process.exitCode = 1;
