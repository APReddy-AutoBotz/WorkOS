import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { applyPersistedTerminology } from './productConfig';
import { api } from '../services/apiClient';
import { authService } from '../services/authService';

type TerminologyResponse = { terms?: Record<string, unknown> };

export const RuntimeTerminology = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      if (!authService.isAuthenticated()) {
        applyPersistedTerminology({});
        if (active) setRevision(value => value + 1);
        return;
      }
      api.get<TerminologyResponse>('/api/organization-setup/terminology')
        .then(result => { if (active) { applyPersistedTerminology(result.terms || {}); setRevision(value => value + 1); } })
        .catch(() => { if (active) { applyPersistedTerminology({}); setRevision(value => value + 1); } });
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
