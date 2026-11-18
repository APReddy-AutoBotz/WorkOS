import { useEffect, useRef, useState } from 'react';
import { captureRateContext, invoiceDrafts } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Report = Awaited<ReturnType<typeof invoiceDrafts.reconciliation>>;
type Choice = { id: string; label: string };

export const BillingReconciliation = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const current = useRef<RateContext | null>(null);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      current.current = null;
      setReport(null);
      setReason('');
      setBusy(false);
      setMessage('Account, role or scope changed. Reload the report.');
    };
    const check = () => {
      if (current.current && !isRateContextCurrent(current.current)) clear();
    };
    window.addEventListener('workos:organization-scope-switch-requested', clear);
    window.addEventListener('workos:organization-scope-changed', clear);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      generation.current++;
      window.removeEventListener('workos:organization-scope-switch-requested', clear);
      window.removeEventListener('workos:organization-scope-changed', clear);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, []);
  const allowed = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'commercial.invoice_export.view',
    'employees.view',
    'notifications.view',
  ].every(hasRatePermission);
  const load = async () => {
    const run = ++generation.current,
      context = captureRateContext(() => generation.current === run);
    if (!context || !engagement) {
      setReport(null);
      setMessage('Choose an engagement and an active scope.');
      return;
    }
    current.current = context;
    setBusy(true);
    setReport(null);
    setMessage('');
    try {
      const result = await invoiceDrafts.reconciliation(engagement, context);
      if (generation.current === run) setReport(result);
    } catch {
      if (generation.current === run)
        setMessage(
          'The scoped reconciliation could not be confirmed. Check access or report size and reload.',
        );
    } finally {
      if (generation.current === run) setBusy(false);
    }
  };
  const exportReport = async () => {
    const context = current.current,
      selected = report,
      run = generation.current;
    if (!context || !selected || !isRateContextCurrent(context) || reason.trim().length < 3) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await invoiceDrafts.exportReconciliation(
        selected,
        crypto.randomUUID(),
        reason.trim(),
        context,
      );
      if (generation.current !== run) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `tm-billing-reconciliation-${result.requestId}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Report export recorded. Reference ${result.requestId}; SHA-256 ${result.sha256}.`);
    } catch {
      if (generation.current === run)
        setMessage(
          'Export could not be confirmed. Check audit history and reload before another explicit request.',
        );
    } finally {
      if (generation.current === run) setBusy(false);
    }
  };
  return (
    <section aria-label="Billing reconciliation" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Billing reconciliation</h2>
      <p>
        Shows visible T&amp;M items and retained invoice evidence for one engagement. Totals include only
        records visible in your current scope. Milestone, fixed-fee, retainer, managed-service and adjustment
        sources are not supported here. Manual confirmation is an attestation, not provider verification.
      </p>
      {!allowed ? (
        <p role="status">Scoped invoice and export view access are required.</p>
      ) : (
        <>
          <label>
            Reconciliation engagement{' '}
            <select
              aria-label="Reconciliation engagement"
              value={engagement}
              disabled={busy}
              onChange={(e) => {
                generation.current++;
                setEngagement(e.target.value);
                setReport(null);
                setMessage('');
              }}
            >
              <option value="">Choose an engagement</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !engagement} onClick={() => void load()}>
            Load billing reconciliation
          </button>
          {message && <p role="status">{message}</p>}
          {report && (
            <div>
              <p>
                As of {report.asOf}. Control exceptions: {report.exceptionCount}.
              </p>
              <h3>Visible control totals</h3>
              <ul>
                {report.totals.map((t) => (
                  <li key={t.currency + ':' + t.status}>
                    {t.currency} {t.status}: {t.lineCount} items, {t.amount}
                  </li>
                ))}
              </ul>
              <h3>Reconciliation boundaries</h3>
              <p>Historical released lines are separate from current occupancy.</p>
              <ul>
                {report.controls.map((t) => (
                  <li key={t.currency + ':' + t.boundary}>
                    {t.currency} {t.boundary}: {t.lineCount} lines, {t.amount}
                  </li>
                ))}
              </ul>
              {report.missingEvents.map((event) => (
                <p key={event.eventId}>Eligibility event {event.eventId} has no register item.</p>
              ))}
              {hasRatePermission('reports.export') && (
                <>
                  <label>
                    Report export reason{' '}
                    <input
                      aria-label="Report export reason"
                      value={reason}
                      disabled={busy}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || reason.trim().length < 3 || report.exceptionCount > 0}
                    onClick={() => void exportReport()}
                  >
                    Download audited reconciliation CSV
                  </button>
                </>
              )}
              <h3>Item lineage</h3>
              <ul>
                {report.items.map((item) => (
                  <li key={item.itemId}>
                    <span>
                      {item.currency} {item.amount} · {item.status} · item {item.itemId} v{item.itemVersion} ·
                      event {item.eventId} v{item.eventVersion} · source {item.snapshotId} · eligibility
                      approval {item.eligibilityApprovalId} · decision {item.eligibilityDecisionId}
                    </span>
                    {item.batchId && (
                      <span>
                        {' '}
                        · batch {item.batchId} ({item.batchState}) · line {item.lineId} · acquisition request{' '}
                        {item.acquisitionRequestId} · operation {item.acquisitionOperationId}
                      </span>
                    )}
                    {item.artifactId && (
                      <span>
                        {' '}
                        · retained export {item.artifactId} · SHA-256 {item.artifactHash}
                      </span>
                    )}
                    {item.confirmationId && <span> · manual confirmation {item.confirmationId}</span>}
                    {item.history.map((line) => (
                      <span key={line.lineId}>
                        {' '}
                        · historical line {line.lineId} in batch {line.batchId} ({line.batchState})
                      </span>
                    ))}
                    {!item.controlOk && <strong> · Control exception</strong>}
                  </li>
                ))}
              </ul>
              {report.items.length === 0 && <p>No visible items.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
};
