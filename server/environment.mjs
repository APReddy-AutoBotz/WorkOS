import {z} from 'zod';
import {isLoopbackHostname} from './identity-discovery.mjs';

const optionalText = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return typeof value === 'string' ? value.trim() : value;
}, z.string().optional());

const booleanText = z.preprocess((value) => {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const portText = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return value;
  return Number(value);
}, z.number().int().min(1).max(65535).optional());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_MODE: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portText,
  API_PORT: portText,
  DATABASE_URL: optionalText,
  PGSSLMODE: z.preprocess((value) => value === '' || value === undefined ? 'disable' : value,
    z.enum(['disable', 'require', 'verify-full'])),
  PGSSLROOTCERT: optionalText,
  API_SESSION_SECRET: optionalText,
  APP_URL: optionalText,
  IDENTITY_PROVIDER: z.preprocess((value) => value === '' || value === undefined ? 'local' : value,
    z.enum(['local', 'entra'])),
  ENTRA_TENANT_ID: optionalText,
  ENTRA_CLIENT_ID: optionalText,
  ENTRA_CLIENT_SECRET: optionalText,
  ENTRA_REDIRECT_URI: optionalText,
  AUTO_SEED_DEMO: booleanText,
  RESET_DEMO_DATA: booleanText,
  ALLOW_TEST_FALLBACK: booleanText,
  VITE_ALLOW_TEST_FALLBACK: booleanText,
  LOCAL_LOGIN_ENABLED: z.preprocess((value) => value === '' || value === undefined ? undefined : value,
    z.enum(['true', 'false']).optional()),
});

const isPostgresUrl = (value) => {
  try {
    const parsed = new URL(value);
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && Boolean(parsed.pathname && parsed.pathname !== '/');
  } catch {
    return false;
  }
};

const isObviousPlaceholder = (value) => /^(?:replace(?:[_ -]?me)?|change(?:[_ -]?me)?|your[_ -].+|example(?:[_ -].*)?|placeholder.*|todo.*|<[^>]+>)$/i.test(String(value || '').trim());

const isGuid = (value) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(value || ''));

const hasSafeProductionDatabaseCredentials = (value) => {
  try {
    const databaseUrl = new URL(value);
    const username = decodeURIComponent(databaseUrl.username);
    const password = decodeURIComponent(databaseUrl.password);
    return Boolean(username && password && !isObviousPlaceholder(username) && !isObviousPlaceholder(password));
  } catch {
    return false;
  }
};

const collectProductionErrors = (environment) => {
  const errors = [];
  if (!environment.API_SESSION_SECRET || environment.API_SESSION_SECRET === 'dev-only-change-me'
      || environment.API_SESSION_SECRET.length < 32
      || /^(?:replace|change[-_ ]?me|your[-_ ]|example|placeholder)/i.test(environment.API_SESSION_SECRET)) {
    errors.push('API_SESSION_SECRET must be a non-default secret with at least 32 characters');
  }
  if (environment.IDENTITY_PROVIDER !== 'entra') {
    errors.push('IDENTITY_PROVIDER must select the configured Entra provider');
  }
  for (const key of ['APP_URL', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI']) {
    if (!environment[key]) errors.push(`${key} is required in production`);
  }
  if (environment.ENTRA_TENANT_ID && !isGuid(environment.ENTRA_TENANT_ID)) {
    errors.push('ENTRA_TENANT_ID must be a tenant GUID');
  }
  if (environment.ENTRA_CLIENT_ID && !isGuid(environment.ENTRA_CLIENT_ID)) {
    errors.push('ENTRA_CLIENT_ID must be an application GUID');
  }
  if (environment.ENTRA_CLIENT_SECRET
      && (environment.ENTRA_CLIENT_SECRET.length < 16 || isObviousPlaceholder(environment.ENTRA_CLIENT_SECRET))) {
    errors.push('ENTRA_CLIENT_SECRET must be a configured non-placeholder secret');
  }
  if (environment.AUTO_SEED_DEMO || environment.RESET_DEMO_DATA) {
    errors.push('Demo seed/reset flags must be false in production');
  }
  if (environment.ALLOW_TEST_FALLBACK || environment.VITE_ALLOW_TEST_FALLBACK) {
    errors.push('Test fallback flags must be false in production');
  }
  if (environment.LOCAL_LOGIN_ENABLED === 'true') {
    errors.push('LOCAL_LOGIN_ENABLED must not be true in production');
  }
  try {
    const appUrl = new URL(environment.APP_URL);
    if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password
        || appUrl.pathname !== '/' || appUrl.search || appUrl.hash || isLoopbackHostname(appUrl.hostname)) {
      errors.push('APP_URL must be a public HTTPS origin without credentials, path, query or fragment');
    }
    const redirectUrl = new URL(environment.ENTRA_REDIRECT_URI);
    if (redirectUrl.protocol !== 'https:' || redirectUrl.username || redirectUrl.password
        || redirectUrl.origin !== appUrl.origin || redirectUrl.pathname !== '/api/auth/entra/callback'
        || redirectUrl.search || redirectUrl.hash || isLoopbackHostname(redirectUrl.hostname)) {
      errors.push('ENTRA_REDIRECT_URI must match the HTTPS APP_URL origin and callback path');
    }
  } catch {
    errors.push('APP_URL and ENTRA_REDIRECT_URI must be valid HTTPS URLs');
  }
  return errors;
};

export class EnvironmentValidationError extends Error {
  constructor(errors) {
    super(`Environment validation failed: ${errors.join('; ')}`);
    this.name = 'EnvironmentValidationError';
    this.code = 'INVALID_ENVIRONMENT';
    this.errors = errors;
  }
}

export const validateRuntimeEnvironment = (source = process.env, {purpose = 'server'} = {}) => {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] || 'environment')))];
    throw new EnvironmentValidationError(fields.map(field => `Invalid ${field}`));
  }

  const environment = parsed.data;
  const errors = [];
  const production = environment.NODE_ENV === 'production' || environment.APP_MODE === 'production';
  if (production && (environment.NODE_ENV !== 'production' || environment.APP_MODE !== 'production')) {
    errors.push('NODE_ENV and APP_MODE must both be production');
  }
  if (!environment.DATABASE_URL && (production || purpose === 'migration')) {
    errors.push(purpose === 'migration'
      ? 'DATABASE_URL is required to run database migrations'
      : 'DATABASE_URL is required in production');
  }
  if (environment.DATABASE_URL && !isPostgresUrl(environment.DATABASE_URL)) {
    errors.push('DATABASE_URL must be a PostgreSQL connection URL');
  }
  if (production && environment.DATABASE_URL && isPostgresUrl(environment.DATABASE_URL)
      && !hasSafeProductionDatabaseCredentials(environment.DATABASE_URL)) {
    errors.push('DATABASE_URL must include non-placeholder database credentials');
  }
  if (production && purpose !== 'migration') errors.push(...collectProductionErrors(environment));
  if (environment.PORT && environment.API_PORT && environment.PORT !== environment.API_PORT) {
    errors.push('PORT and API_PORT must match when both are set');
  }
  if (errors.length > 0) throw new EnvironmentValidationError([...new Set(errors)]);

  return {
    nodeEnv: environment.NODE_ENV,
    appMode: environment.APP_MODE,
    port: environment.PORT ?? environment.API_PORT ?? 4000,
    databaseUrl: environment.DATABASE_URL,
    pgSslMode: environment.PGSSLMODE,
    pgSslRootCert: environment.PGSSLROOTCERT,
    production,
  };
};
