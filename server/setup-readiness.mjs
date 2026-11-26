import {EnvironmentValidationError, validateRuntimeEnvironment} from './environment.mjs';

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
  if (environment.LOCAL_LOGIN_ENABLED !== 'false') return false;
  try {
    return validateRuntimeEnvironment(environment).production;
  } catch (error) {
    if (error instanceof EnvironmentValidationError) return false;
    throw error;
  }
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
