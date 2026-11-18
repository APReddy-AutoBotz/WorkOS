import { useEffect, useRef, useState } from 'react';
import { approvalUuid } from '../../shared/work-approval.mjs';
import { captureRateContext, invoiceBatchApprovals } from '../services/invoiceBatchApprovals';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
import {
  executeReviewedInvoices,
  reconcileReviewedInvoice,
  reviewInvoiceDecision,
  type InvoiceBatchResult,
  type ReviewedInvoice,
} from '../services/reviewedInvoiceBatch';

const queueOwner = (c: RateContext | null) => c && JSON.stringify([c.identityKey, c.ownerIdentity]);

type Choice = { id: string; label: string };
type Inspection = Awaited<ReturnType<typeof invoiceBatchApprovals.inspect>>;
export const ReviewedInvoiceBatch = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [reference, setReference] = useState(''),
    [inspectedPage, setPage] = useState<Inspection | null>(null),
    [decision, setDecision] = useState<'' | 'Approved' | 'Rejected'>(''),
    [reason, setReason] = useState(''),
    [checked, setChecked] = useState(false),
    [queued, setQueued] = useState<{ owner: string; item: ReviewedInvoice }[]>([]),
    [hidden, setHidden] = useState(false),
    [results, setResults] = useState<Record<string, InvoiceBatchResult>>({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    context = useRef<RateContext | null>(null),
    inFlight = useRef(false);
  const page = context.current && isRateContextCurrent(context.current) ? inspectedPage : null;
  const owner = queueOwner(captureRateContext());
  const items = hidden ? [] : queued.filter((entry) => entry.owner === owner).map((entry) => entry.item);
  const allowed = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'employees.view',
    'notifications.view',
    'approvals.view',
    'commercial.invoice_approval.decide',
  ].every(hasRatePermission);
  useEffect(() => {
    mounted.current = true;
    const block = () => {
      ++generation.current;
      context.current = null;
      setHidden(true);
      setEngagement('');
      setReference('');
      setPage(null);
      setChecked(false);
      setDecision('');
      setReason('');
      setNotice(
        'Account, role or scope changed. Unsent decisions are stopped; retained request receipts require the original context.',
      );
    };
    const check = () => {
      if (context.current && !isRateContextCurrent(context.current)) block();
    };
    window.addEventListener('workos:organization-scope-switch-requested', block);
    window.addEventListener('workos:organization-scope-changed', block);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', block);
      window.removeEventListener('workos:organization-scope-changed', block);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, []);
  const run = async (fn: (c: RateContext, live: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const n = ++generation.current,
      live = () => mounted.current && generation.current === n,
      c = captureRateContext(live);
    if (!c) {
      setNotice('An active session and selected scope are required.');
      return;
    }
    context.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c, live);
    } catch {
      if (live()) setNotice('The result could not be confirmed. Inspect the original request receipt.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const inspect = () => {
    if (!approvalUuid(reference) || !engagement) return;
    void run(async (c, live) => {
      const value = await invoiceBatchApprovals.inspect(reference, c);
      if (value.batch.engagementId !== engagement) throw Error('Engagement changed');
      if (live()) {
        setHidden(false);
        setPage(value);
        setChecked(false);
        setDecision('');
        setReason('');
      }
    });
  };
  const add = () => {
    if (
      !owner ||
      !context.current ||
      !isRateContextCurrent(context.current) ||
      !page ||
      !checked ||
      !decision ||
      items.length >= 20
    )
      return;
    try {
      const item = reviewInvoiceDecision(page, decision, reason);
      if (items.some((x) => x.approval.id === item.approval.id)) throw Error('Duplicate review');
      setQueued((old) => [...old, { owner, item }]);
      setPage(null);
      setReference('');
      setDecision('');
      setReason('');
      setChecked(false);
      setNotice('');
    } catch {
      setNotice('Inspect a current review and enter a distinct decision and reason.');
    }
  };
  const unattempted = items.filter(
    (x) =>
      !results[x.operation.data.requestId] || results[x.operation.data.requestId].status === 'NotAttempted',
  );
  const execute = () => {
    if (!unattempted.length || items.some((x) => results[x.operation.data.requestId]?.status === 'Uncertain'))
      return;
    void run(async (c, live) => {
      await executeReviewedInvoices(unattempted, c, live, (result) => {
        if (mounted.current) setResults((old) => ({ ...old, [result.requestId]: result }));
      });
    });
  };
  const receipt = (item: ReviewedInvoice) =>
    void run(async (c, live) => {
      const approval = await reconcileReviewedInvoice(item, c);
      if (live())
        setResults((old) => ({
          ...old,
          [item.operation.data.requestId]: {
            requestId: item.operation.data.requestId,
            status: 'Confirmed',
            approval,
          },
        }));
    });
  return (
    <section aria-label="Reviewed invoice bulk decisions" className="my-4 space-y-3 rounded border p-4">
      <h2>Reviewed invoice bulk decisions</h2>
      <p>
        Inspect each retained invoice and choose its decision and reason. Each decision uses its own current
        permission, source and transaction checks. Uncertain writes are never retried automatically.
      </p>
      {!allowed ? (
        <p role="status">Scoped invoice approval authority is required.</p>
      ) : (
        <>
          {hidden && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                context.current = captureRateContext();
                setHidden(false);
              }}
            >
              Show queue for current account and scope
            </button>
          )}
          <fieldset disabled={busy}>
            <label>
              Invoice bulk engagement
              <select
                aria-label="Invoice bulk engagement"
                value={engagement}
                onChange={(e) => {
                  setEngagement(e.target.value);
                  setPage(null);
                  setChecked(false);
                }}
              >
                <option value="">Choose</option>
                {choices.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Invoice review reference
              <input
                aria-label="Invoice bulk review reference"
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value);
                  setPage(null);
                  setChecked(false);
                }}
              />
            </label>
            <button type="button" disabled={!engagement || !approvalUuid(reference)} onClick={inspect}>
              Inspect invoice bulk source
            </button>
            {page && (
              <article aria-label="Invoice bulk retained source">
                <p>
                  Batch {page.batch.id} · {page.batch.lineCount} lines · {page.batch.currency}{' '}
                  {page.batch.total} · lineage {page.batch.lineageHash} · review {page.approval.id} ·{' '}
                  {page.approval.state.status} · current {String(page.approval.current)}
                </p>
                <p>
                  Client {page.batch.clientId} · contract {page.batch.contractId} · {page.batch.periodStart}–
                  {page.batch.periodEnd} by {page.batch.periodBasis} · policy {page.approval.policy.id} ·
                  stage{' '}
                  {page.approval.state.currentStage === null ? 'None' : page.approval.state.currentStage + 1}{' '}
                  · named approver{' '}
                  {(page.approval.policy.definition as { stages: { userId: string; role: string }[] }).stages[
                    page.approval.state.currentStage ?? -1
                  ]?.userId ?? 'None'}{' '}
                  · held role{' '}
                  {(page.approval.policy.definition as { stages: { userId: string; role: string }[] }).stages[
                    page.approval.state.currentStage ?? -1
                  ]?.role ?? 'None'}{' '}
                  · requester {page.approval.requesterUserId} · batch owner {page.approval.ownerUserId}.
                </p>
                <ul>
                  {page.batch.lines.map((x) => (
                    <li key={x.id}>
                      Item {x.itemId} · event {x.eventId} ·{' '}
                      {'sourceType' in x ? `milestone ${x.evidence.milestoneId}` : `snapshot ${x.snapshotId}`}{' '}
                      · {x.currency} {x.amount}
                    </li>
                  ))}
                </ul>
                <label>
                  Decision
                  <select
                    aria-label="Invoice bulk decision"
                    value={decision}
                    onChange={(e) => setDecision(e.target.value as '' | 'Approved' | 'Rejected')}
                  >
                    <option value="">Choose</option>
                    <option>Approved</option>
                    <option>Rejected</option>
                  </select>
                </label>
                <label>
                  Reason
                  <input
                    aria-label="Invoice bulk reason"
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <label>
                  <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I
                  inspected this retained source and stage
                </label>
                <button
                  type="button"
                  onClick={add}
                  disabled={
                    !checked ||
                    !decision ||
                    reason.trim().length < 3 ||
                    !page.approval.current ||
                    page.approval.state.status !== 'Pending' ||
                    items.length >= 20
                  }
                >
                  Add reviewed invoice
                </button>
              </article>
            )}
            <button
              type="button"
              disabled={
                !unattempted.length ||
                items.some((x) => results[x.operation.data.requestId]?.status === 'Uncertain')
              }
              onClick={execute}
            >
              Execute reviewed invoice decisions
            </button>
          </fieldset>
          {items.map((item) => {
            const id = item.operation.data.requestId,
              result = results[id];
            return (
              <article key={id} aria-label={`Reviewed invoice ${item.approval.id}`}>
                <p>
                  {item.approval.id} · {item.operation.data.decision} · {item.operation.data.reason} · request{' '}
                  {id} · {result?.status ?? 'Reviewed, not sent'}
                  {result?.httpStatus && ` · HTTP ${result.httpStatus}`}
                </p>
                {result?.status === 'Uncertain' && (
                  <>
                    <p>The original request may still commit. No automatic retry is performed.</p>
                    <button type="button" disabled={busy} onClick={() => receipt(item)}>
                      Read original invoice decision receipt
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy || result?.status === 'Uncertain'}
                  onClick={() => {
                    setQueued((old) => old.filter((x) => x.item.operation.data.requestId !== id));
                    setResults((old) => {
                      const next = { ...old };
                      delete next[id];
                      return next;
                    });
                  }}
                >
                  Remove reviewed invoice {item.approval.id}
                </button>
              </article>
            );
          })}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};
