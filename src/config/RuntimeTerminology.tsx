import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { applyPersistedTerminology, applyRuntimeBrand } from './productConfig';
import {applyTeamsRelease} from './featureFlags';
import { api, getOrganizationScope, getToken } from '../services/apiClient';
import { authService } from '../services/authService';
import { getEffectivePermissions } from '../services/permissions';

type TerminologyResponse = { releases?: {teams: boolean}; terms?: Record<string, unknown>; brand?: Parameters<typeof applyRuntimeBrand>[0] };
const runtimeContext = () => {
  const user = authService.getCurrentUser();
  return JSON.stringify([user?.id, user?.employeeId, user?.role, user?.permissionRole,
    user ? [...getEffectivePermissions(user)].sort() : [], getToken(), getOrganizationScope()]);
};

export const loadRuntimeTerminology = async (
  authenticated = authService.isAuthenticated(),
  fetchTerms?: () => Promise<TerminologyResponse>,
  isCurrent = () => true,
) => {
  const owner = runtimeContext();
  const scope = getOrganizationScope();
  const owned = () => isCurrent() && owner === runtimeContext();
  if (!authenticated) {
    if (owned()) { applyPersistedTerminology({}); applyRuntimeBrand(); applyTeamsRelease(undefined,false); }
    return owned();
  }
  if (!getOrganizationScope()) {
    if (owned()) { applyPersistedTerminology({}); applyRuntimeBrand(); applyTeamsRelease(undefined,false); }
    return owned();
  }
  try {
    const result = await (fetchTerms ? fetchTerms() : api.getWithScope<TerminologyResponse>('/api/organization-setup/terminology?includeBrand=1&includeReleases=1', scope));
    if (!owned()) return false;
    applyPersistedTerminology(result.terms || {});
    applyRuntimeBrand(result.brand);
    applyTeamsRelease(scope?.organizationId,result.releases?.teams === true);
  } catch {
    if (!owned()) return false;
    applyPersistedTerminology({});
    applyRuntimeBrand();
    applyTeamsRelease(scope?.organizationId,false);
  }
  return true;
};

export const RuntimeTerminology = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void loadRuntimeTerminology(undefined, undefined, () => active && request === generation).then(applied => {
        if (applied && active && request === generation) setRevision(value => value + 1);
      });
    };
    load();
    window.addEventListener('workos:organization-scope-changed', load);
    return () => {
      active = false;
      ++generation;
      window.removeEventListener('workos:organization-scope-changed', load);
    };
  }, [location.pathname]);

  return <div key={revision} className="contents">{children}</div>;
};
