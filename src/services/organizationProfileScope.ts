import {authService} from './authService';
import {ApiClientError, getOrganizationScope, getToken, type OrganizationScope} from './apiClient';
import {getEffectivePermissions} from './permissions';

export type OrganizationProfileContext = Readonly<{
  scope: OrganizationScope;
  identityKey: string;
  token: string | null;
  isCurrent: () => boolean;
}>;

const identityKey = () => {
  const user = authService.getCurrentUser();
  return user && JSON.stringify([user.id, user.employeeId, user.role, user.permissionRole,
    [...getEffectivePermissions(user)].sort()]);
};

// Capture before the first await. Context is only a frontend ownership lease;
// the existing server permission and resolved scope remain authoritative.
export const captureOrganizationProfileContext = (isCurrent = () => true): OrganizationProfileContext | null => {
  const scope = getOrganizationScope();
  const user = authService.getCurrentUser();
  if (!scope?.organizationId || !scope.legalEntityId || !user
    || !getEffectivePermissions(user).includes('settings.manage')) return null;
  return {scope: {...scope}, identityKey: identityKey()!, token: getToken(), isCurrent};
};

export const isOrganizationProfileContextCurrent = (context: OrganizationProfileContext) => {
  const current = captureOrganizationProfileContext();
  return Boolean(context.isCurrent() && current && context.identityKey === current.identityKey
    && context.token === current.token && context.scope.organizationId === current.scope.organizationId
    && context.scope.legalEntityId === current.scope.legalEntityId);
};

export const assertOrganizationProfileContext = (context: OrganizationProfileContext | null) => {
  if (!context || !isOrganizationProfileContextCurrent(context)) {
    throw new ApiClientError('Organization profile access changed. Reload for the current scope.', {status: 403});
  }
  return context;
};
