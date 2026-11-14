import assert from 'node:assert/strict';
import {once} from 'node:events';
import {syntheticDatabaseUrl} from './support/synthetic-values.mjs';
import express from 'express';
import {registerHealthRoutes} from '../server/health.mjs';
import {createIdentityProviderReadinessMonitor} from '../server/identity-readiness.mjs';

let providerAvailable = false;
let releaseEarlierProbe;
const earlierProbeResult = new Promise(resolve => { releaseEarlierProbe = resolve; });
const orderedProbeResults = [
  async () => {},
  () => earlierProbeResult,
  async () => { throw new Error('synthetic provider outage'); },
  async () => {},
];
const refreshProviderReadiness = createIdentityProviderReadinessMonitor({
  probe: () => orderedProbeResults.shift()(),
  onAvailabilityChange: available => { providerAvailable = available; },
});
await refreshProviderReadiness();
assert.equal(providerAvailable, true, 'a successful discovery probe marks production identity ready');
const earlierSuccess = refreshProviderReadiness();
await assert.rejects(refreshProviderReadiness(), /synthetic provider outage/);
assert.equal(providerAvailable, false, 'the newest failed discovery probe marks identity unavailable');
releaseEarlierProbe();
await earlierSuccess;
assert.equal(providerAvailable, false, 'an older successful probe cannot undo a newer outage');
await refreshProviderReadiness();
assert.equal(providerAvailable, true, 'a later successful discovery probe restores identity readiness');

let databaseAvailable = true;
let migrationState = 'current';
let identityProviderAvailable = true;
const privateDiagnostic = 'connection-string-must-not-be-returned';
const pool = {
  query: async () => {
    if (!databaseAvailable) throw new Error(privateDiagnostic);
    return {rows: [{ok: 1}], rowCount: 1};
  },
};
const migrationStatus = async () => {
  if (migrationState === 'unavailable') throw new Error(privateDiagnostic);
  if (migrationState === 'unsupported') {
    return {isCurrent: false, currentVersion: '032_wos02_legal_identifier_effective_ranges', pendingIds: [], unknownIds: ['999_future']};
  }
  return migrationState === 'pending'
    ? {isCurrent: false, currentVersion: '032_wos02_legal_identifier_effective_ranges', pendingIds: ['033_future'], unknownIds: []}
    : {isCurrent: true, currentVersion: '032_wos02_legal_identifier_effective_ranges', pendingIds: [], unknownIds: []};
};
const app = express();
const healthEnvironment = {
  APP_MODE: 'production',
  NODE_ENV: 'production',
  APP_VERSION: '1.2.3',
  BUILD_SHA: 'abcdef0123456789',
  DATABASE_URL: syntheticDatabaseUrl('localhost', 'workos_test'),
};
registerHealthRoutes({
  app,
  pool,
  migrationStatus,
  environment: healthEnvironment,
  identityProviderReady: () => identityProviderAvailable,
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const readJson = async (path) => {
  const response = await fetch(`${origin}${path}`);
  return {response, body: await response.json()};
};

try {
  const live = await readJson('/api/health/live');
  assert.equal(live.response.status, 200);
  assert.equal(live.body.status, 'live');
  assert.equal(live.response.headers.get('cache-control'), 'no-store');

  const ready = await readJson('/api/health/ready');
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.database, 'connected');
  assert.equal(ready.body.migrations, 'current');
  assert.equal(ready.body.identityProvider, 'available');
  assert.equal(ready.body.migrationLevel, '032_wos02_legal_identifier_effective_ranges');
  assert.equal(ready.body.version, '1.2.3');
  assert.equal(ready.body.commit, 'abcdef0123456789');

  const build = await readJson('/api/health/build');
  assert.equal(build.response.status, 200);
  assert.deepEqual(Object.keys(build.body).sort(), ['commit', 'migrationLevel', 'version'], 'build metadata exposes only approved fields');
  assert.equal(build.body.migrationLevel, '032_wos02_legal_identifier_effective_ranges');

  migrationState = 'pending';
  const pending = await readJson('/api/health/ready');
  assert.equal(pending.response.status, 503);
  assert.equal(pending.body.migrations, 'pending');
  assert.equal(pending.body.pendingMigrationCount, 1);

  migrationState = 'unsupported';
  const unsupported = await readJson('/api/health/ready');
  assert.equal(unsupported.response.status, 503);
  assert.equal(unsupported.body.migrations, 'unsupported');
  assert.equal(unsupported.body.unsupportedMigrationCount, 1);

  migrationState = 'current';
  identityProviderAvailable = false;
  const identityUnavailable = await readJson('/api/health/ready');
  assert.equal(identityUnavailable.response.status, 503);
  assert.equal(identityUnavailable.body.database, 'connected');
  assert.equal(identityUnavailable.body.migrations, 'current');
  assert.equal(identityUnavailable.body.identityProvider, 'unavailable');
  identityProviderAvailable = true;

  databaseAvailable = false;
  const liveWhileDatabaseDown = await readJson('/api/health/live');
  assert.equal(liveWhileDatabaseDown.response.status, 200);
  assert.equal(liveWhileDatabaseDown.body.status, 'live');
  const unavailable = await readJson('/api/health/ready');
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.database, 'unavailable');
  assert.equal(JSON.stringify(unavailable.body).includes(privateDiagnostic), false);

  const legacy = await readJson('/api/health');
  assert.equal(legacy.response.status, 503);
  assert.deepEqual(legacy.body, {status: 'degraded', database: 'unreachable'});

  delete healthEnvironment.DATABASE_URL;
  const notConfigured = await readJson('/api/health');
  assert.equal(notConfigured.response.status, 200);
  assert.deepEqual(notConfigured.body, {status: 'ok', database: 'not_configured'});
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log('Health endpoint smoke tests passed.');
