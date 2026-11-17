import {frontendEnv} from './frontendEnvironment';

const valueOr = (key: string, fallback: string) => {
  const value = String(frontendEnv[key] || '').trim();
  return value || fallback;
};

/** The plural rule used by the original scalar terminology implementation. */
export const legacyPluralize = (value: string) => {
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
};

export type TerminologyValue = Readonly<{ singular: string; plural: string; helpText: string }>;

export const resolveTerminologyValue = (environment: Record<string, string | undefined>, envKey: string, fallback: string, fallbackPlural = legacyPluralize(fallback)): TerminologyValue => {
  const envValue = String(environment[envKey] || '').trim();
  const singular = envValue || fallback;
  const explicitPlural = String(environment[`${envKey}_PLURAL`] || '').trim();
  const helpText = String(environment[`${envKey}_HELP_TEXT`] || '').trim();
  return Object.freeze({
    singular,
    plural: explicitPlural || (envValue ? legacyPluralize(singular) : fallbackPlural),
    helpText,
  });
};
const configuredTerm = (envKey: string, fallback: string, fallbackPlural = legacyPluralize(fallback)) =>
  resolveTerminologyValue(frontendEnv, envKey, fallback, fallbackPlural);

const defaultTerminology = {
  employee: configuredTerm('VITE_TERM_EMPLOYEE', 'resource'),
  manager: configuredTerm('VITE_TERM_MANAGER', 'manager'),
  teamLead: configuredTerm('VITE_TERM_TEAM_LEAD', 'team lead'),
  businessUnit: configuredTerm('VITE_TERM_BUSINESS_UNIT', 'business unit'),
  region: configuredTerm('VITE_TERM_REGION', 'region'),
  regionalOwner: configuredTerm('VITE_TERM_REGIONAL_OWNER', 'regional owner'),
  engagement: configuredTerm('VITE_TERM_ENGAGEMENT', 'engagement'),
  project: configuredTerm('VITE_TERM_PROJECT', 'project'),
  worklog: configuredTerm('VITE_TERM_WORKLOG', 'worklog'),
};
export type TerminologyKey = keyof typeof defaultTerminology;
export type Terminology = Record<TerminologyKey, string>;
let persistedTerminology: Partial<Record<TerminologyKey, TerminologyValue>> = {};

const normalizeRuntimeValue = (value: unknown): TerminologyValue | undefined => {
  if (typeof value === 'string' && value.trim()) {
    const singular = value.trim();
    return { singular, plural: legacyPluralize(singular), helpText: '' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.singular !== 'string' || typeof candidate.plural !== 'string' || typeof candidate.helpText !== 'string') return undefined;
  if (!candidate.singular.trim() || !candidate.plural.trim()) return undefined;
  return { singular: candidate.singular.trim(), plural: candidate.plural.trim(), helpText: candidate.helpText.trim() };
};

export const applyPersistedTerminology = (terms: Record<string, unknown>) => {
  persistedTerminology = Object.fromEntries(Object.entries(terms).flatMap(([key, value]) => {
    const normalized = key in defaultTerminology ? normalizeRuntimeValue(value) : undefined;
    return normalized ? [[key, normalized]] : [];
  })) as Partial<Record<TerminologyKey, TerminologyValue>>;
};

export const getConfiguredTerminologyValue = (key: TerminologyKey): TerminologyValue => defaultTerminology[key];
export const getTerminologyValue = (key: TerminologyKey): TerminologyValue => persistedTerminology[key] || defaultTerminology[key];
const terminology = new Proxy(defaultTerminology, { get: (_defaults, key: TerminologyKey) => getTerminologyValue(key).singular }) as unknown as Terminology;

export const productConfig = Object.freeze({
  productName: valueOr('VITE_PRODUCT_NAME', 'WorkOS'),
  organizationName: valueOr('VITE_ORGANIZATION_NAME', 'Your organization'),
  logoUrl: valueOr('VITE_PRODUCT_LOGO_URL', '/workos-mark.svg'),
  supportName: valueOr('VITE_SUPPORT_NAME', valueOr('VITE_PRODUCT_NAME', 'WorkOS') + ' Support'),
  supportEmail: valueOr('VITE_SUPPORT_EMAIL', 'support@example.test'),
  terminology,
});
