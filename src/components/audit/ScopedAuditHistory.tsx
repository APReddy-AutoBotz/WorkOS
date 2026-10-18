import {useEffect, useRef, useState} from 'react';
import {ApiClientError, getOrganizationScope} from '../../services/apiClient';
import type {AuditLog} from '../../types';

const scopeKey = () => {
  const scope = getOrganizationScope();
  return JSON.stringify([scope?.organizationId ?? null, scope?.legalEntityId ?? null]);
};
type AuditHistoryStatus = 'blocked' | 'loading' | 'ready' | 'denied' | 'error';

export const useScopedAuditHistory = (enabled: boolean, loadHistory: () => Promise<AuditLog[]>) => {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{key: string; status: AuditHistoryStatus; rows: AuditLog[]; request: number}>(
    () => ({key: scopeKey(), status: enabled ? 'loading' : 'blocked', rows: [], request: 0}),
  );
  const requestVersion = useRef(0);
  const key = scopeKey();
  const reload = () => {
    requestVersion.current += 1;
    setResult({key: scopeKey(), status: enabled ? 'loading' : 'blocked', rows: [], request: requestVersion.current});
    setRevision(value => value + 1);
  };

  useEffect(() => {
    const changed = () => {
      requestVersion.current += 1;
      setResult({key: scopeKey(), status: 'loading', rows: [], request: requestVersion.current});
      setRevision(value => value + 1);
    };
    window.addEventListener('workos:organization-scope-changed', changed);
    return () => window.removeEventListener('workos:organization-scope-changed', changed);
  }, []);

  useEffect(() => {
    let active = true;
    const request = ++requestVersion.current;
    setResult({key, status: enabled ? 'loading' : 'blocked', rows: [], request: requestVersion.current});
    if (enabled) {
      void Promise.resolve().then(loadHistory).then(rows => {
        if (active && request === requestVersion.current && key === scopeKey()) {
          setResult({key, status: 'ready', rows, request});
        }
      }).catch(error => {
        if (active && request === requestVersion.current && key === scopeKey()) {
          const denied = error instanceof ApiClientError && [401, 403].includes(error.status);
          setResult({key, status: denied ? 'denied' : 'error', rows: [], request});
        }
      });
    }
    return () => { active = false; };
  }, [enabled, loadHistory, revision, key]);

  const status = !enabled ? 'blocked' : result.key !== key ? 'loading' : result.status;
  const isCurrent = () => enabled && result.status === 'ready'
    && result.key === scopeKey() && result.request === requestVersion.current;
  return {status, rows: status === 'ready' ? result.rows : [], key, revision, reload, isCurrent};
};

export const ScopedAuditHistoryStatus = ({status, hasPermission, rowCount, unfilteredCount, retry}: {
  status: AuditHistoryStatus;
  hasPermission: boolean;
  rowCount: number;
  unfilteredCount: number;
  retry: () => void;
}) => {
  if (status === 'loading') return <p role="status">Loading selected-scope audit history…</p>;
  if (status === 'blocked') return <p role="status">{hasPermission
    ? 'Select an organization and legal entity to access its selected-scope audit records.'
    : 'You do not have access to selected-scope audit history. Contact your administrator if access is needed.'}</p>;
  if (status === 'denied' || status === 'error') return <div role="alert">
    <p>{status === 'denied'
      ? 'Selected-scope audit access was denied. Check your account and workspace access, then try again.'
      : 'Selected-scope audit history could not be loaded. Check your connection and workspace access, then try again.'}</p>
    <button type="button" className="mt-3 font-bold underline focus-visible:outline focus-visible:outline-2" onClick={retry}>Retry audit history</button>
  </div>;
  if (rowCount === 0) return <p role="status">{unfilteredCount === 0
    ? 'No audit records were returned for the selected organization and legal entity.'
    : 'No audit records match the current filters.'}</p>;
  return null;
};
