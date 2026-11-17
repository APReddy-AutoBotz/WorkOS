import assert from 'node:assert/strict';
import {validateRuntimeEnvironment} from '../server/environment.mjs';
import {syntheticCredential, syntheticDatabaseUrl, rejectedConfigurationValues} from './support/synthetic-values.mjs';

const productionEnvironment = {
  NODE_ENV: 'production',
  APP_MODE: 'production',
  PORT: '4000',
  DATABASE_URL: syntheticDatabaseUrl('db:5432', 'workos'),
  PGSSLMODE: 'require',
  API_SESSION_SECRET: syntheticCredential(),
  APP_URL: 'https://workos.example.test',
  IDENTITY_PROVIDER: 'entra',
  ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
  ENTRA_CLIENT_SECRET: syntheticCredential(),
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
assert.equal(validated.sessionTtlMs, 8 * 3_600_000);
assert.equal(validateRuntimeEnvironment({...productionEnvironment, API_SESSION_TTL_HOURS: '0.25'}).sessionTtlMs, 900_000);
for (const invalid of ['mistyped', '-1', '0', '1e-30', '3e9', 'Infinity']) {
  assert.throws(() => validateRuntimeEnvironment({...productionEnvironment, API_SESSION_TTL_HOURS: invalid}),
    /Invalid API_SESSION_TTL_HOURS/);
}
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
  DATABASE_URL: syntheticDatabaseUrl('db:5432', 'workos', rejectedConfigurationValues.placeholder),
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
rejects({...productionEnvironment, API_SESSION_SECRET: rejectedConfigurationValues.short}, 'API_SESSION_SECRET');
rejects({...productionEnvironment, API_SESSION_SECRET: 'replace_with_a_unique_random_secret_at_least_32_characters'}, 'API_SESSION_SECRET');
rejects({...productionEnvironment, IDENTITY_PROVIDER: 'local'}, 'IDENTITY_PROVIDER');
rejects({...productionEnvironment, APP_URL: 'http://workos.example.test'}, 'APP_URL');
rejects({...productionEnvironment, APP_URL: 'https://localhost'}, 'APP_URL');
rejects({...productionEnvironment, ENTRA_REDIRECT_URI: 'https://other.example.test/api/auth/entra/callback'}, 'ENTRA_REDIRECT_URI');
rejects({...productionEnvironment, DATABASE_URL: syntheticDatabaseUrl('db:5432', 'workos', rejectedConfigurationValues.placeholder)}, 'DATABASE_URL');
rejects({...productionEnvironment, ENTRA_TENANT_ID: 'replace_me'}, 'ENTRA_TENANT_ID');
rejects({...productionEnvironment, ENTRA_CLIENT_ID: 'synthetic-client'}, 'ENTRA_CLIENT_ID');
rejects({...productionEnvironment, ENTRA_CLIENT_SECRET: rejectedConfigurationValues.placeholder}, 'ENTRA_CLIENT_SECRET');
rejects({...productionEnvironment, ENTRA_CLIENT_SECRET: rejectedConfigurationValues.short}, 'ENTRA_CLIENT_SECRET');
rejects({...productionEnvironment, AUTO_SEED_DEMO: 'true'}, 'Demo seed');
rejects({...productionEnvironment, RESET_DEMO_DATA: 'true'}, 'Demo seed');
rejects({...productionEnvironment, ALLOW_TEST_FALLBACK: 'true'}, 'Test fallback');
rejects({...productionEnvironment, VITE_ALLOW_TEST_FALLBACK: 'true'}, 'Test fallback');
rejects({...productionEnvironment, LOCAL_LOGIN_ENABLED: 'true'}, 'LOCAL_LOGIN_ENABLED');
rejects({...productionEnvironment, PORT: '4000abc'}, 'PORT');
rejects({...productionEnvironment, PGSSLMODE: 'no-verify'}, 'PGSSLMODE');
const verifiedDatabase = validateRuntimeEnvironment({...productionEnvironment, PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/synthetic/ca.pem'});
assert.equal(verifiedDatabase.pgSslMode, 'verify-full');
assert.equal(verifiedDatabase.pgSslRootCert, '/synthetic/ca.pem');

const secret = syntheticCredential().slice(0, 8);
assert.throws(() => validateRuntimeEnvironment({...productionEnvironment, API_SESSION_SECRET: secret}), error => {
  assert.equal(error.code, 'INVALID_ENVIRONMENT');
  assert.equal(error.message.includes(secret), false, 'configuration errors must not echo secret values');
  return true;
});


assert.equal(testEnvironment.loginRateLimit,8);
assert.equal(testEnvironment.loginIpRateLimit,64);
assert.equal(testEnvironment.trustedProxies,false);
for(const value of ['NaN','Infinity','0','-1','1.5','1000001','8x']) {
 rejects({...productionEnvironment,LOGIN_RATE_LIMIT:value},'LOGIN_RATE_LIMIT');
 rejects({...productionEnvironment,LOGIN_IP_RATE_LIMIT:value},'LOGIN_IP_RATE_LIMIT');
}
rejects({...productionEnvironment,TRUSTED_PROXY_CIDRS:'true'},'TRUSTED_PROXY_CIDRS');
assert.deepEqual(validateRuntimeEnvironment({...productionEnvironment,TRUSTED_PROXY_CIDRS:'127.0.0.1/32,::1/128'}).trustedProxies,['127.0.0.1/32','::1/128']);

console.log('Runtime environment smoke tests passed.');
