import {getOrganizationScope, isDemoFallbackAllowed} from '../services/apiClient';
import {frontendEnv} from './frontendEnvironment';

export type EnterpriseFeatureFlag = 'leave' | 'notifications' | 'teams' | 'entra' | 'planning';

const readFlag = (viteKey: string, serverKey: string) => {
  const value = frontendEnv[viteKey] ?? frontendEnv[serverKey] ?? 'false';
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

export type ReleasedModule = 'teams' | 'entra' | 'planning';
type ReleaseState = Partial<Record<ReleasedModule,boolean>>;
let releaseDecision: {organizationId:string; states:ReleaseState} | undefined;

export function applyModuleReleases(organizationId:string | undefined, states:ReleaseState) {
  releaseDecision = organizationId ? {organizationId, states} : undefined;
}

export function moduleReleasePending() {
  const org = getOrganizationScope()?.organizationId;
  return !isDemoFallbackAllowed() && Boolean(org) && releaseDecision?.organizationId !== org;
}

function enabled(module:ReleasedModule) {
  if (isDemoFallbackAllowed()) return readFlag('VITE_FEATURE_'+module.toUpperCase(),'FEATURE_'+module.toUpperCase());
  return releaseDecision?.organizationId === getOrganizationScope()?.organizationId && releaseDecision?.states[module] === true;
}

export const enterpriseFeatureFlags: Record<EnterpriseFeatureFlag, boolean> = {
  leave: readFlag('VITE_FEATURE_LEAVE', 'FEATURE_LEAVE'),
  notifications: readFlag('VITE_FEATURE_NOTIFICATIONS', 'FEATURE_NOTIFICATIONS'),
  get teams() { return enabled('teams'); },
  get entra() { return enabled('entra'); },
  get planning() { return enabled('planning'); },
};

export const isEnterpriseFeatureEnabled = (flag: EnterpriseFeatureFlag) => enterpriseFeatureFlags[flag];
