import { useEffect, useState, type ReactNode } from 'react';
import { api, checkBackend, clearOrganizationScope, getOrganizationScope, selectOrganizationScope, type OrganizationScope } from '../../services/apiClient';
import { authService } from '../../services/authService';

type GateStatus = 'checking' | 'choosing' | 'ready' | 'empty' | 'error';

const sameScope = (left: OrganizationScope | null, right: OrganizationScope) =>
  Boolean(left && left.organizationId === right.organizationId && left.legalEntityId === right.legalEntityId);

export const OrganizationScopeGate = ({
  children,
  allowAuditWithoutScope = false,
}: {
  children: ReactNode;
  allowAuditWithoutScope?: boolean;
}) => {
  const [status, setStatus] = useState<GateStatus>('checking');
  const [scopes, setScopes] = useState<OrganizationScope[]>([]);
  const [selectedScope, setSelectedScope] = useState<OrganizationScope | null>(getOrganizationScope());
  const [selectingKey, setSelectingKey] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const resolveScope = async () => {
      setStatus('checking');
      setError('');
      try {
        const backendConnected = await checkBackend();
        if (!backendConnected) {
          if (allowAuditWithoutScope) {
            clearOrganizationScope();
            if (active) {
              setSelectedScope(null);
              setStatus('empty');
            }
          } else if (active) {
            setStatus('ready');
          }
          return;
        }

        const available = await api.get<OrganizationScope[]>('/api/auth/organization-scopes');
        if (!active) return;
        setScopes(available);
        const current = getOrganizationScope();
        const authorizedCurrent = current && available.find(item => sameScope(current, item));
        if (authorizedCurrent) {
          setSelectedScope(authorizedCurrent);
          setStatus('ready');
          return;
        }

        clearOrganizationScope();
        setSelectedScope(null);
        if (available.length === 0) {
          setStatus('empty');
        } else if (available.length === 1) {
          await selectOrganizationScope(available[0]);
          if (active) {
            setSelectedScope(available[0]);
            setStatus('ready');
          }
        } else {
          setStatus('choosing');
        }
      } catch (cause) {
        if (!active) return;
        if (allowAuditWithoutScope) {
          clearOrganizationScope();
          setSelectedScope(null);
        }
        setError(cause instanceof Error ? cause.message : 'Unable to load available organization scopes.');
        setStatus('error');
      }
    };
    void resolveScope();
    return () => { active = false; };
  }, [retry, allowAuditWithoutScope]);

  const chooseScope = async (scope: OrganizationScope) => {
    const key = `${scope.organizationId}:${scope.legalEntityId}`;
    setSelectingKey(key);
    setError('');
    try {
      await selectOrganizationScope(scope);
      setSelectedScope(scope);
      setStatus('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That organization scope could not be selected.');
    } finally {
      setSelectingKey('');
    }
  };

  if (status === 'ready') {
    return (
      <div
        className="contents"
        data-testid="organization-scope-selected"
        data-organization-id={selectedScope?.organizationId || ''}
        data-legal-entity-id={selectedScope?.legalEntityId || ''}
      >
        {children}
      </div>
    );
  }

  if (allowAuditWithoutScope && status !== 'checking') {
    return (
      <div className="contents" data-testid="audit-without-organization-scope">
        {children}
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <main className="min-h-screen bg-bg-secondary px-6 py-16" data-testid="organization-scope-empty">
        <section className="mx-auto max-w-xl rounded-2xl border border-border-light bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-black text-heading">No active organization access</h1>
          <p className="mt-3 text-sm text-body/70">Your account does not have an active organization and legal-entity scope. Contact your administrator to request access.</p>
          <button type="button" className="btn-primary mt-6 px-5 py-2.5" onClick={() => { void authService.logout().finally(() => { window.location.href = '/login'; }); }}>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg-secondary px-6 py-16" data-testid="organization-scope-gate">
      <section className="mx-auto max-w-xl rounded-2xl border border-border-light bg-white p-8 shadow-sm" aria-labelledby="organization-scope-title">
        <p className="text-xs font-bold uppercase tracking-widest text-primary">Secure workspace access</p>
        <h1 id="organization-scope-title" className="mt-2 text-2xl font-black text-heading">Select organization and legal entity</h1>
        <p className="mt-3 text-sm text-body/70">Choose the workspace you are authorized to use. No organization data is loaded until you select a scope.</p>

        {status === 'checking' && <p className="mt-6 text-sm font-medium text-body/70" role="status">Checking your organization access…</p>}

        {status === 'choosing' && (
          <div className="mt-6 grid gap-3" role="group" aria-label="Available organization scopes">
            {scopes.map(scope => {
              const key = `${scope.organizationId}:${scope.legalEntityId}`;
              const testKey = `${scope.organizationId}-${scope.legalEntityId}`.replace(/[^A-Za-z0-9_-]/g, '-');
              return (
                <button
                  key={key}
                  type="button"
                  data-testid={`organization-scope-option-${testKey}`}
                  className="rounded-xl border border-border-light bg-white px-4 py-4 text-left transition hover:border-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary"
                  disabled={Boolean(selectingKey)}
                  onClick={() => void chooseScope(scope)}
                >
                  <span className="block font-bold text-heading">{scope.organizationName || scope.organizationId}</span>
                  <span className="mt-1 block text-sm text-body/70">{scope.legalEntityName || scope.legalEntityId}</span>
                  {selectingKey === key && <span className="mt-2 block text-xs text-body/60" role="status">Verifying scope…</span>}
                </button>
              );
            })}
          </div>
        )}

        {status === 'error' && (
          <div className="mt-6" role="alert">
            <p className="text-sm text-danger">{error || 'Unable to load your organization access.'}</p>
            <button type="button" className="btn-primary mt-4 px-5 py-2.5" onClick={() => setRetry(value => value + 1)}>Try again</button>
          </div>
        )}
      </section>
      {selectedScope && status !== 'ready' && <span className="sr-only">Previously selected scope is no longer authorized.</span>}
    </main>
  );
};
