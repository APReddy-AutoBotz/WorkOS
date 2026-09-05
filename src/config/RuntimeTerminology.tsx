import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { applyPersistedTerminology } from './productConfig';
import { api } from '../services/apiClient';
import { authService } from '../services/authService';

type TerminologyResponse = { terms?: Record<string, unknown> };

export const loadRuntimeTerminology = async (
  authenticated = authService.isAuthenticated(),
  fetchTerms: () => Promise<TerminologyResponse> = () => api.get<TerminologyResponse>('/api/organization-setup/terminology'),
) => {
  if (!authenticated) {
    applyPersistedTerminology({});
    return;
  }
  try {
    const result = await fetchTerms();
    applyPersistedTerminology(result.terms || {});
  } catch {
    applyPersistedTerminology({});
  }
};

export const RuntimeTerminology = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      loadRuntimeTerminology().finally(() => {
        if (active) setRevision(value => value + 1);
      });
    };
    load();
    window.addEventListener('workos:organization-scope-changed',load);
    return () => {
      active = false;
      window.removeEventListener('workos:organization-scope-changed', load);
    };
  }, [location.pathname]);

  return <div key={revision} className="contents">{children}</div>;
};
