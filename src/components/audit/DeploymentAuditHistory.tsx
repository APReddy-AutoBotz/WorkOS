import {authService} from '../../services/authService';
import {hasPermission} from '../../services/permissions';
import type {AuditLog, IntegrationEventLog} from '../../types';
import {useAuditRead, type AuditReadStatus} from './useAuditRead';

const actorKey = () => {
  const user = authService.getCurrentUser();
  return JSON.stringify([user?.id ?? null, user?.employeeId ?? null, user?.role ?? null,
    user?.permissionRole ?? null, hasPermission(user, 'audit.deployment.view')]);
};
const readKey = (kind: string) => JSON.stringify([actorKey(), kind]);

export const useDeploymentAuditHistory = (enabled: boolean,
  loadAudit: () => Promise<AuditLog[]>, loadIntegration: () => Promise<IntegrationEventLog[]>) => {
  const auditKey = readKey('deployment-audit');
  const integrationKey = readKey('deployment-integration');
  const audit = useAuditRead(enabled, auditKey, loadAudit, () => readKey('deployment-audit'));
  const integration = useAuditRead(enabled, integrationKey, loadIntegration, () => readKey('deployment-integration'));
  return {
    audit: {...audit, rows: audit.data ?? [], ready: audit.isCurrent(),
      detailKey: JSON.stringify([auditKey, audit.dataVersion, audit.status])},
    integration: {...integration, rows: integration.data ?? [], ready: integration.isCurrent(),
      detailKey: JSON.stringify([integrationKey, integration.dataVersion, integration.status])},
  };
};

export const DeploymentAuditStatus = ({kind, status, rowCount, unfilteredCount, refresh}: {
  kind: 'audit' | 'integration'; status: AuditReadStatus; rowCount: number; unfilteredCount: number; refresh: () => void;
}) => {
  const label = kind === 'audit' ? 'deployment audit' : 'deployment integration';
  if (status === 'blocked') return <p role="status">You do not have access to {label} history. Check your account access.</p>;
  if (status === 'loading') return <p role="status">Loading {label} history…</p>;
  const failed = status === 'access' || status === 'error';
  return <div role={failed ? 'alert' : undefined}>
    {failed ? <p>{status === 'access'
      ? `Access to ${label} history could not be confirmed. Check your account access, then try again.`
      : `The ${label} history could not be loaded. Check your connection and account access, then try again.`}</p>
      : rowCount === 0 && <p role="status">{unfilteredCount === 0
        ? `No ${label} records were returned.` : `No ${label} records match the current filters.`}</p>}
    <button type="button" onClick={refresh} className="mt-3 font-bold underline focus-visible:outline focus-visible:outline-2">
      {failed ? 'Retry' : 'Refresh'} {label}
    </button>
  </div>;
};
