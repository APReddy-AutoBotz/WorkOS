import { useEffect, useRef, useState } from 'react';
import { captureRateContext, invoiceDrafts, reconciliationGrants, type ChargeReportSource } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Report = Awaited<ReturnType<typeof invoiceDrafts.reconciliation>>;
type Choice = { id: string; label: string; source?: ChargeReportSource; selectionId?: string };

export const BillingReconciliation = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState('');
  const selected=choices.find(choice=>(choice.selectionId ?? choice.id)===engagement);
  const chargeLabel=selected?.source==='fixed-fee'?'Fixed-fee':selected?.source==='retainer'?'Retainer':selected?.source==='service-units'?'Managed-service unit':'Managed-service period';
  const [report, setReport] = useState<Report | null>(null);
  const [balances,setBalances]=useState<Awaited<ReturnType<typeof invoiceDrafts.chargeReport>> | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [portfolioReason, setPortfolioReason] = useState('');
  const [busy, setBusy] = useState(false);
  type Portfolio = Awaited<ReturnType<typeof invoiceDrafts.portfolio>>;
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [source, setSource] = useState<Portfolio['source']>('time_and_materials');
  const generation = useRef(0);
  const current = useRef<RateContext | null>(null);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      current.current = null;
      setPortfolio(null);
      setReport(null); setBalances(null);
      setReason('');
      setPortfolioReason('');
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
  const loadPortfolio = async () => {
    const run = ++generation.current,
      context = captureRateContext(() => generation.current === run);
    setPortfolio(null);
    setMessage('');
    if (!context) {
      setMessage('An active scope is required.');
      return;
    }
    current.current = context;
    setBusy(true);
    try {
      const value = await invoiceDrafts.portfolio(start, end, source, context);
      if (generation.current === run) setPortfolio(value);
    } catch {
      if (generation.current === run)
        setMessage('Portfolio reconciliation could not be confirmed. Check access and reload.');
    } finally {
      if (generation.current === run) setBusy(false);
    }
  };
  const load = async () => {
    const run = ++generation.current,
      context = captureRateContext(() => generation.current === run);
    if (!context || !engagement) {
      setReport(null); setBalances(null);
      setMessage('Choose an engagement and an active scope.');
      return;
    }
    current.current = context;
    setBusy(true);
    setReport(null); setBalances(null);
    setMessage('');
    try {
      if (selected?.source) {
        const rows=await invoiceDrafts.chargeReport(selected.id,context,selected.source);
        if (generation.current===run) setBalances(rows);
        return;
      }
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
  const exportReport = async (selected: Report | Portfolio, exportReason: string) => {
    const context = current.current,
      run = generation.current;
    if (!context || !selected || !isRateContextCurrent(context) || exportReason.trim().length < 3) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await invoiceDrafts.exportReconciliation(
        selected,
        crypto.randomUUID(),
        exportReason.trim(),
        context,
      );
      if (generation.current !== run) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${result.version === 'workos.portfolio-reconciliation/1' ? 'portfolio' : result.version === 'workos.milestone-reconciliation/1' ? 'milestone' : 'tm'}-billing-reconciliation-${result.requestId}.csv`;
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
        Select a billing source and date range for the portfolio, or choose an engagement below. Amounts stay in their original currency.
      </p>
      {!allowed ? (
        <p role="status">Scoped invoice and export view access are required.</p>
      ) : (
        <>
          <fieldset disabled={busy} className="space-y-2">
            <legend>Portfolio reconciliation</legend>
            <label>
              Eligible from{' '}
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setPortfolio(null);
                  setStart(e.target.value);
                }}
              />
            </label>
            <label>
              Eligible through{' '}
              <input
                type="date"
                value={end}
                onChange={(e) => {
                  setPortfolio(null);
                  setEnd(e.target.value);
                }}
              />
            </label>
            <label>
              Portfolio sources{' '}
              <select
                value={source}
                onChange={(e) => {
                  setPortfolio(null);
                  setSource(e.target.value as Portfolio['source']);
                }}
              >
                {Object.entries(reconciliationGrants).filter(([,permission])=>hasRatePermission(permission)).map(([key])=>
                  <option key={key} value={key}>{{'fixed-fee':'Fixed-fee installments',retainer:'Retainer periods','service-units':'Managed-service units','service-periods':'Managed-service periods'}[key]}</option>)}
                <option value="time_and_materials">Time and materials</option>
                {hasRatePermission('commercial.milestone_billing.view') && (
                  <>
                    <option value="milestone">Accepted milestones</option>
                    <option value="both">Time and materials and accepted milestones</option>
                  </>
                )}
              </select>
            </label>
            <button
              type="button"
              disabled={!start || !end || start > end}
              onClick={() => void loadPortfolio()}
            >
              Load portfolio reconciliation
            </button>
          </fieldset>
          {portfolio && (
            <section aria-label="Portfolio reconciliation results">
              <h3>
                Portfolio reconciliation · {portfolio.start} through {portfolio.end}
              </h3>
              <p>
                As of {portfolio.asOf}. Control exceptions: {portfolio.exceptionCount}.
              </p>
              {portfolio.controls.length === 0 ? (
                <p>No visible eligibility events in this period.</p>
              ) : (
                <>
                  <table className="w-full text-left tabular-nums">
                    <caption>Portfolio billing control totals</caption>
                    <thead>
                      <tr>
                        <th>Currency</th>
                        <th>Boundary</th>
                        {portfolio.source in reconciliationGrants && <th>Expected records</th>}
                        <th>Observed records</th>
                        <th>Amount</th>
                        {portfolio.source in reconciliationGrants && <th>Exceptions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {portfolio.controls.map((x) => (
                        <tr key={x.currency + x.boundary}>
                          <td>{x.currency}</td>
                          <th scope="row">{x.boundary.replaceAll('_', ' ').toLowerCase()}</th>
                          {'expected' in x && <td>{x.expected}</td>}
                          <td>{x.lineCount}</td>
                          <td>{x.amount}</td>
                          {'exceptions' in x && <td>{x.exceptions}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {portfolio.totals.length > 0 && (
                    <ul aria-label="Portfolio register states">
                      {portfolio.totals.map((x) => (
                        <li key={x.currency + x.status}>
                          {x.currency} {x.status}: {x.lineCount} items, {x.amount}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {hasRatePermission('reports.export') && (
                <>
                  <label>
                    Portfolio export reason{' '}
                    <input
                      maxLength={1000}
                      disabled={busy}
                      value={portfolioReason}
                      onChange={(e) => setPortfolioReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || portfolioReason.trim().length < 3 || portfolio.exceptionCount > 0}
                    onClick={() => void exportReport(portfolio, portfolioReason)}
                  >
                    Download audited portfolio CSV
                  </button>
                </>
              )}
            </section>
          )}
          <label>
            Reconciliation engagement{' '}
            <select
              aria-label="Reconciliation engagement"
              value={engagement}
              disabled={busy}
              onChange={(e) => {
                generation.current++;
                setEngagement(e.target.value);
                setReport(null); setBalances(null);
                setMessage('');
              }}
            >
              <option value="">Choose an engagement</option>
              {choices.map((c) => (
                <option key={c.selectionId ?? c.id} value={c.selectionId ?? c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !engagement} onClick={() => void load()}>
            Load billing reconciliation
          </button>
          {message && <p role="status">{message}</p>}
          {balances && selected?.source && hasRatePermission(reconciliationGrants[selected.source]) && <section aria-label={chargeLabel+' billing balances'}>
            <h3>Registered {selected.source==='fixed-fee'?'installments':'charges'} and credits</h3>
            {balances.balances.length ? <table>
              <caption>Current register balances by currency and billing state</caption>
              <thead><tr>{['Currency','State',selected.source==='fixed-fee'?'Installments':'Charges','Credits','Gross charges','Credit amount','Net amount'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{balances.balances.map(row=><tr key={row.currency+row.status}>
                <td>{row.currency}</td><td>{row.status}</td><td>{row.charges}</td><td>{row.credits}</td>
                <td>{row.gross}</td><td>{row.adjustments}</td><td>{row.net}</td>
              </tr>)}</tbody>
            </table> : <p>No registered charges or credits for this engagement.</p>}
            {balances.controls.length>0 && <table>
              <caption>{chargeLabel} reconciliation controls by currency</caption>
              <thead><tr>{['Currency','Boundary','Expected records','Observed records','Net amount','Exceptions'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{balances.controls.map(row=><tr key={row.currency+row.boundary}>
                <td>{row.currency}</td><td>{row.boundary}</td><td>{row.expected}</td><td>{row.observed}</td>
                <td>{row.amount}</td><td>{row.exceptions}</td>
              </tr>)}</tbody>
            </table>}
          </section>}
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
                    onClick={() => void exportReport(report, reason)}
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
                      event {item.eventId} v{item.eventVersion} · source{' '}
                      {'milestoneId' in item ? item.milestoneId ?? item.snapshotId : item.snapshotId} ·
                      eligibility approval {item.eligibilityApprovalId} · decision{' '}
                      {item.eligibilityDecisionId}
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
