import {useCallback, useRef, useState} from 'react';
import {authService} from '../../services/authService';
import {hasPermission} from '../../services/permissions';
import type {AuditLog, OrganizationAuditScope} from '../../types';
import {useAuditRead, type AuditReadStatus} from './useAuditRead';

const actorKey = () => {
  const user = authService.getCurrentUser();
  return JSON.stringify([user?.id ?? null, user?.employeeId ?? null, user?.role ?? null,
    user?.permissionRole ?? null, hasPermission(user, 'audit.organization.view')]);
};

export const useOrganizationAuditHistory = (enabled: boolean,
  loadScopes: () => Promise<OrganizationAuditScope[]>, loadLogs: (id: string) => Promise<AuditLog[]>) => {
  const actor = actorKey();
  const [, setSelectionVersion] = useState(0);
  const preference = useRef({actor, id: ''});
  const scopes = useAuditRead(enabled, actor, loadScopes, actorKey);
  const options = scopes.status === 'ready' && scopes.isCurrent() ? scopes.data ?? [] : [];
  const preferred = preference.current.actor === actor ? preference.current.id : '';
  const selectedId = options.some(option => option.organizationId === preferred) ? preferred : options[0]?.organizationId || '';
  if (scopes.status === 'ready' && scopes.isCurrent()) preference.current = {actor, id: selectedId};
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const historyKey = JSON.stringify([actor, scopes.dataVersion, selectedId]);
  const currentHistoryKey = () => JSON.stringify([actorKey(), scopes.currentVersion(), selectedRef.current]);
  const loadSelected = useCallback(() => loadLogs(selectedId), [loadLogs, selectedId]);
  const history = useAuditRead(enabled && scopes.isCurrent() && Boolean(selectedId), historyKey, loadSelected, currentHistoryKey);
  const refreshScopes = () => { history.invalidate(); scopes.refresh(); };
  const select = (id: string) => {
    if (id === selectedId || !options.some(option => option.organizationId === id) || history.status === 'access') return;
    history.invalidate();
    selectedRef.current = id;
    preference.current = {actor, id};
    setSelectionVersion(value => value + 1);
  };
  const retryHistory = () => history.status === 'access' ? refreshScopes() : history.refresh();
  const ready = history.status === 'ready' && history.isCurrent();
  return {scopesStatus: scopes.status, historyStatus: history.status, options, selectedId, select,
    rows: ready ? history.data ?? [] : [], ready, refreshScopes, retryHistory,
    detailKey: JSON.stringify([actor, scopes.dataVersion, selectedId, history.dataVersion, history.status])};
};

const Retry = ({onClick, children}: {onClick: () => void; children: string}) =>
  <button type="button" className="mt-3 font-bold underline focus-visible:outline focus-visible:outline-2" onClick={onClick}>{children}</button>;

export const OrganizationAuditDiscoveryStatus = ({status, count, refresh}: {
  status: AuditReadStatus; count: number; refresh: () => void;
}) => {
  if (status === 'blocked') return <p role="status">You do not have access to organization audit designations. Check your account access.</p>;
  if (status === 'loading') return <p role="status">Loading organization audit designations…</p>;
  if (status === 'access' || status === 'error') return <div role="alert">
    <p>{status === 'access'
      ? 'Organization audit access could not be confirmed. Check your account access, then refresh your designations.'
      : 'Organization audit designations could not be loaded. Check your connection and account access, then try again.'}</p>
    <Retry onClick={refresh}>Retry audit designations</Retry>
  </div>;
  return <div>
    {count === 0 && <p role="status">No organization audit designations are currently active for this account.</p>}
    <Retry onClick={refresh}>Refresh audit designations</Retry>
  </div>;
};

export const OrganizationAuditHistoryStatus = ({status, rowCount, unfilteredCount, retry}: {
  status: AuditReadStatus; rowCount: number; unfilteredCount: number; retry: () => void;
}) => {
  if (status === 'blocked') return null;
  if (status === 'loading') return <p role="status">Loading designated-organization audit history…</p>;
  if (status === 'access' || status === 'error') return <div role="alert">
    <p>{status === 'access'
      ? 'Organization audit access is unavailable. Refresh your audit designations and check your account access before retrying.'
      : 'Organization audit history could not be loaded. Check your connection and account access, then try again.'}</p>
    <Retry onClick={retry}>{status === 'access' ? 'Refresh audit designations' : 'Retry organization history'}</Retry>
  </div>;
  if (rowCount === 0) return <p role="status">{unfilteredCount === 0
    ? 'No audit records were returned for this designated organization.' : 'No organization audit records match the current filters.'}</p>;
  return null;
};
