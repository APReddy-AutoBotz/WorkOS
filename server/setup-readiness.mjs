export const REQUIRED_SETUP_CHECKS = [
  'organization',
  'legal_entity',
  'calendars',
  'roles',
  'identity',
  'initial_users',
  'imports',
  'commercial_defaults',
  'notifications',
  'production_readiness',
  'worker_type',
  'reporting_period',
];

const present = value => Boolean(String(value || '').trim());

export const identityReadinessFromEnvironment = (environment = process.env) =>
  String(environment.IDENTITY_PROVIDER || '').toLowerCase() === 'entra'
  && ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI'].every(key => present(environment[key]));

export const productionReadinessFromEnvironment = (environment = process.env) => {
  let applicationUrlIsSecure = false;
  try {
    applicationUrlIsSecure = new URL(String(environment.APP_URL || '')).protocol === 'https:';
  } catch {
    applicationUrlIsSecure = false;
  }

  const safeSessionSecret = present(environment.API_SESSION_SECRET)
    && environment.API_SESSION_SECRET !== 'dev-only-change-me';
  const productionMode = environment.NODE_ENV === 'production' && environment.APP_MODE === 'production';
  const noUnsafeFallback = environment.ALLOW_TEST_FALLBACK !== 'true'
    && environment.AUTO_SEED_DEMO !== 'true'
    && environment.LOCAL_LOGIN_ENABLED === 'false';
  const productionIdentity = identityReadinessFromEnvironment(environment);

  return productionMode && noUnsafeFallback && present(environment.DATABASE_URL) && safeSessionSecret
    && applicationUrlIsSecure && productionIdentity;
};

export const buildSetupReadiness = (facts, environment = process.env) => {
  const checks = Object.fromEntries(REQUIRED_SETUP_CHECKS.map(key => [key,
    key === 'production_readiness' ? productionReadinessFromEnvironment(environment)
      : key === 'identity' ? facts[key] === true && identityReadinessFromEnvironment(environment)
        : facts[key] === true]));
  const evidence = Object.fromEntries(REQUIRED_SETUP_CHECKS.map(key => [key,
    checks[key] ? 'Server-authoritative prerequisite is configured.' : 'Required server-authoritative prerequisite is missing or unsafe.']));
  return { checks, evidence, ready: REQUIRED_SETUP_CHECKS.every(key => checks[key]) };
};
