import {getOrganizationScope, isDemoFallbackAllowed} from '../services/apiClient';
import {frontendEnv} from './frontendEnvironment';

export type EnterpriseFeatureFlag = 'leave' | 'notifications' | 'teams' | 'entra' | 'planning';

const readFlag = (viteKey: string, serverKey: string) => {
  const value = frontendEnv[viteKey] ?? frontendEnv[serverKey] ?? 'false';
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

let teamsDecision: {organizationId: string; enabled: boolean} | undefined;

export function applyTeamsRelease(organizationId: string | undefined, enabled: boolean) {
  teamsDecision = organizationId ? {organizationId, enabled} : undefined;
}

export function teamsReleasePending() {
  const org = getOrganizationScope()?.organizationId;
  return !isDemoFallbackAllowed() && Boolean(org) && teamsDecision?.organizationId !== org;
}

export const enterpriseFeatureFlags: Record<EnterpriseFeatureFlag, boolean> = {
  leave: readFlag('VITE_FEATURE_LEAVE', 'FEATURE_LEAVE'),
  notifications: readFlag('VITE_FEATURE_NOTIFICATIONS', 'FEATURE_NOTIFICATIONS'),
  get teams() {
    if (isDemoFallbackAllowed()) return readFlag('VITE_FEATURE_TEAMS', 'FEATURE_TEAMS');
    return teamsDecision?.organizationId === getOrganizationScope()?.organizationId && teamsDecision?.enabled === true;
  },
  entra: readFlag('VITE_FEATURE_ENTRA', 'FEATURE_ENTRA'),
  planning: readFlag('VITE_FEATURE_PLANNING', 'FEATURE_PLANNING'),
};

export const isEnterpriseFeatureEnabled = (flag: EnterpriseFeatureFlag) => enterpriseFeatureFlags[flag];
