const frontendEnv = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env || {});

const valueOr = (key: string, fallback: string) => {
  const value = String(frontendEnv[key] || '').trim();
  return value || fallback;
};

const defaultTerminology = {
  employee: valueOr('VITE_TERM_EMPLOYEE', 'resource'),
  manager: valueOr('VITE_TERM_MANAGER', 'manager'),
  teamLead: valueOr('VITE_TERM_TEAM_LEAD', 'team lead'),
  businessUnit: valueOr('VITE_TERM_BUSINESS_UNIT', 'business unit'),
  region: valueOr('VITE_TERM_REGION', 'region'),
  regionalOwner: valueOr('VITE_TERM_REGIONAL_OWNER', 'regional owner'),
  engagement: valueOr('VITE_TERM_ENGAGEMENT', 'engagement'),
  project: valueOr('VITE_TERM_PROJECT', 'project'),
  worklog: valueOr('VITE_TERM_WORKLOG', 'worklog'),
};
export type Terminology = typeof defaultTerminology;
let persistedTerminology: Partial<Terminology> = {};
export const applyPersistedTerminology = (terms: Record<string, unknown>) => {
  persistedTerminology = Object.fromEntries(Object.entries(terms).filter(([key,value]) => key in defaultTerminology && typeof value === 'string' && value.trim())) as Partial<Terminology>;
};
const terminology = new Proxy(defaultTerminology, { get: (defaults,key: keyof Terminology) => persistedTerminology[key] || defaults[key] });

export const productConfig = Object.freeze({
  productName: valueOr('VITE_PRODUCT_NAME', 'WorkOS'),
  organizationName: valueOr('VITE_ORGANIZATION_NAME', 'Your organization'),
  logoUrl: valueOr('VITE_PRODUCT_LOGO_URL', '/workos-mark.svg'),
  supportName: valueOr('VITE_SUPPORT_NAME', valueOr('VITE_PRODUCT_NAME', 'WorkOS') + ' Support'),
  supportEmail: valueOr('VITE_SUPPORT_EMAIL', 'support@example.test'),
  terminology,
});
