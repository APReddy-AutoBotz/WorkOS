import assert from 'node:assert/strict';
import {validateRuntimeEnvironment} from '../server/environment.mjs';

const productionEnvironment = {
  NODE_ENV: 'production',
  APP_MODE: 'production',
  PORT: '4000',
  DATABASE_URL: 'postgresql://workos:synthetic-password@db:5432/workos',
  PGSSLMODE: 'require',
  API_SESSION_SECRET: 'synthetic-session-secret-that-is-at-least-32-characters',
  APP_URL: 'https://workos.example.test',
  IDENTITY_PROVIDER: 'entra',
  ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
  ENTRA_CLIENT_SECRET: 'synthetic-client-secret',
  ENTRA_REDIRECT_URI: 'https://workos.example.test/api/auth/entra/callback',
  AUTO_SEED_DEMO: 'false',
  RESET_DEMO_DATA: 'false',
  ALLOW_TEST_FALLBACK: 'false',
  VITE_ALLOW_TEST_FALLBACK: 'false',
  LOCAL_LOGIN_ENABLED: 'false',
};

const validated = validateRuntimeEnvironment(productionEnvironment);
assert.equal(validated.production, true);
assert.equal(validated.port, 4000);
assert.equal(validated.databaseUrl, productionEnvironment.DATABASE_URL);
assert.equal(validated.pgSslMode, 'require');

const testEnvironment = validateRuntimeEnvironment({NODE_ENV: 'test', APP_MODE: 'test'});
assert.equal(testEnvironment.production, false);
assert.equal(testEnvironment.port, 4000);
assert.equal(testEnvironment.databaseUrl, undefined);

const migrationEnvironment = validateRuntimeEnvironment({
  NODE_ENV: 'production',
  APP_MODE: 'production',
  DATABASE_URL: productionEnvironment.DATABASE_URL,
}, {purpose: 'migration'});
assert.equal(migrationEnvironment.databaseUrl, productionEnvironment.DATABASE_URL);

const rejects = (environment, expectedField, options) => {
  assert.throws(() => validateRuntimeEnvironment(environment, options), (error) => {
    assert.equal(error.code, 'INVALID_ENVIRONMENT');
    assert.match(error.message, new RegExp(expectedField));
    return true;
  });
};

rejects({
  NODE_ENV: 'production',
  APP_MODE: 'production',
  DATABASE_URL: 'postgresql://workos:replace_me@db:5432/workos',
}, 'DATABASE_URL', {purpose: 'migration'});
rejects({
  NODE_ENV: 'development',
  APP_MODE: 'development',
}, 'DATABASE_URL', {purpose: 'migration'});
rejects({
  NODE_ENV: 'production',
  APP_MODE: 'development',
  DATABASE_URL: productionEnvironment.DATABASE_URL,
}, 'NODE_ENV and APP_MODE', {purpose: 'migration'});

rejects({...productionEnvironment, NODE_ENV: 'development'}, 'NODE_ENV');
rejects({...productionEnvironment, DATABASE_URL: 'https://db.example.test/workos'}, 'DATABASE_URL');
rejects({...productionEnvironment, DATABASE_URL: undefined}, 'DATABASE_URL is required in production');
rejects({...productionEnvironment, API_SESSION_SECRET: 'short'}, 'API_SESSION_SECRET');
rejects({...productionEnvironment, API_SESSION_SECRET: 'replace_with_a_unique_random_secret_at_least_32_characters'}, 'API_SESSION_SECRET');
rejects({...productionEnvironment, IDENTITY_PROVIDER: 'local'}, 'IDENTITY_PROVIDER');
rejects({...productionEnvironment, APP_URL: 'http://workos.example.test'}, 'APP_URL');
rejects({...productionEnvironment, APP_URL: 'https://localhost'}, 'APP_URL');
rejects({...productionEnvironment, ENTRA_REDIRECT_URI: 'https://other.example.test/api/auth/entra/callback'}, 'ENTRA_REDIRECT_URI');
rejects({...productionEnvironment, DATABASE_URL: 'postgresql://workos:replace_me@db:5432/workos'}, 'DATABASE_URL');
rejects({...productionEnvironment, ENTRA_TENANT_ID: 'replace_me'}, 'ENTRA_TENANT_ID');
rejects({...productionEnvironment, ENTRA_CLIENT_ID: 'synthetic-client'}, 'ENTRA_CLIENT_ID');
rejects({...productionEnvironment, ENTRA_CLIENT_SECRET: 'replace_me'}, 'ENTRA_CLIENT_SECRET');
rejects({...productionEnvironment, ENTRA_CLIENT_SECRET: 'short'}, 'ENTRA_CLIENT_SECRET');
rejects({...productionEnvironment, AUTO_SEED_DEMO: 'true'}, 'Demo seed');
rejects({...productionEnvironment, RESET_DEMO_DATA: 'true'}, 'Demo seed');
rejects({...productionEnvironment, ALLOW_TEST_FALLBACK: 'true'}, 'Test fallback');
rejects({...productionEnvironment, VITE_ALLOW_TEST_FALLBACK: 'true'}, 'Test fallback');
rejects({...productionEnvironment, LOCAL_LOGIN_ENABLED: 'true'}, 'LOCAL_LOGIN_ENABLED');
rejects({...productionEnvironment, PORT: '4000abc'}, 'PORT');
rejects({...productionEnvironment, PGSSLMODE: 'verify-full'}, 'PGSSLMODE');

const secret = 'invalid-secret';
assert.throws(() => validateRuntimeEnvironment({...productionEnvironment, API_SESSION_SECRET: secret}), error => {
  assert.equal(error.code, 'INVALID_ENVIRONMENT');
  assert.equal(error.message.includes(secret), false, 'configuration errors must not echo secret values');
  return true;
});

console.log('Runtime environment smoke tests passed.');
