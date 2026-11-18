import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  invoiceCsv,
  type InvoiceNoticeRecoveryTarget,
  type InvoiceNoticeRecoveryOperation,
} from '../services/invoiceCsv';
import { invoiceDrafts, type InvoiceDraft } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Choice = { id: string; label: string };
export const InvoiceNoticeRecovery = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [drafts, setDrafts] = useState<InvoiceDraft[]>([]),
    [nextDraft, setNextDraft] = useState<string | null>(null),
    [batch, setBatch] = useState(''),
    [targets, setTargets] = useState<InvoiceNoticeRecoveryTarget[]>([]),
    [nextTarget, setNextTarget] = useState<string | null>(null),
    [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [pending, setPending] = useState<InvoiceNoticeRecoveryOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null),
    allowed = [
      'commercial.contracts.view',
      'commercial.tm_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_export.view',
      'commercial.invoice_export.recover_notices',
      'employees.view',
      'notifications.view',
    ].every(hasRatePermission);
  const clear = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setEngagement('');
    setDrafts([]);
    setNextDraft(null);
    setBatch('');
    setTargets([]);
    setNextTarget(null);
    setSelected('');
    setReason('');
    setPending(null);
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('Account, role or scope changed. Unsent recovery inputs were cleared.');
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
  const run = async (fn: (c: RateContext) => Promise<void>) => {
    if (inFlight.current) return;
    if (context.current && !isRateContextCurrent(context.current)) {
      clear('Account, role or scope changed. Reload.');
      return;
    }
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      clear('An active session and selected scope are required.');
      return;
    }
    context.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c);
    } catch {
      if (mounted.current && generation.current === n)
        setNotice(
          'The operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && generation.current === n) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const loadDrafts = (after?: string) =>
    void run(async (c) => {
      const x = await invoiceDrafts.list(c, after);
      setDrafts((old) => (after ? [...old, ...x.batches] : x.batches));
      setNextDraft(x.nextAfter);
      if (!after) {
        setBatch('');
        setTargets([]);
        setSelected('');
      }
    });
  const loadTargets = (after?: string) => {
    if (batch)
      void run(async (c) => {
        const x = await invoiceCsv.recoveryTargets(batch, c, after);
        setTargets((old) => (after ? [...old, ...x.targets] : x.targets));
        setNextTarget(x.nextAfter);
        if (!after) setSelected('');
      });
  };
  const execute = (op: InvoiceNoticeRecoveryOperation, receipt = false) =>
    void run(async (c) => {
      if (!receipt) setPending(op);
      try {
        await invoiceCsv.recover(op, c, receipt);
        setPending(null);
        setTargets([]);
        setSelected('');
        setNotice(
          'Recovery attempt recorded. Reload targets to check remaining work; no external alert was sent.',
        );
      } catch (e) {
        if (!receipt && e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setNotice('Recovery was refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  const submit = () => {
    const t = targets.find((x) => x.id === selected);
    if (!t || !batch || reason.trim().length < 3) return;
    execute({
      requestId: crypto.randomUUID(),
      batchId: batch,
      policyId: t.policyId,
      eventId: t.kind === 'event' ? t.id : null,
      producerFailureId: t.kind === 'producer' ? t.id : null,
      reason: reason.trim(),
    });
  };
  return (
    <section aria-label="Invoice notification recovery" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Invoice notification recovery</h2>
      <p>
        Inspect a scoped batch and explicitly select an incomplete event. Recovery preserves the original
        export and creates no external delivery.
      </p>
      {!allowed ? (
        <p role="status">Scoped notice recovery authority is required.</p>
      ) : (
        <>
          <label>
            Engagement
            <select
              aria-label="Invoice recovery engagement"
              value={engagement}
              disabled={busy || !!pending}
              onChange={(e) => {
                setEngagement(e.target.value);
                setDrafts([]);
                setBatch('');
                setTargets([]);
                setSelected('');
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
          <button type="button" disabled={!engagement || busy || !!pending} onClick={() => loadDrafts()}>
            Load invoice recovery batches
          </button>
          {nextDraft && (
            <button type="button" disabled={busy || !!pending} onClick={() => loadDrafts(nextDraft)}>
              More invoice recovery batches
            </button>
          )}
          <label>
            Batch
            <select
              aria-label="Invoice recovery batch"
              value={batch}
              disabled={busy || !!pending}
              onChange={(e) => {
                setBatch(e.target.value);
                setTargets([]);
                setSelected('');
              }}
            >
              <option value="">Choose</option>
              {drafts
                .filter(
                  (x) =>
                    x.engagementId === engagement &&
                    ['Approved', 'Exported', 'Billed/Confirmed'].includes(x.state),
                )
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.state} · {x.id}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" disabled={!batch || busy || !!pending} onClick={() => loadTargets()}>
            Load invoice recovery targets
          </button>
          {nextTarget && (
            <button type="button" disabled={busy || !!pending} onClick={() => loadTargets(nextTarget)}>
              More invoice recovery targets
            </button>
          )}
          <label>
            Incomplete event
            <select
              aria-label="Invoice recovery target"
              value={selected}
              disabled={busy || !!pending}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose</option>
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.kind} · {x.id} · policy {x.policyId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Recovery reason
            <input
              aria-label="Invoice recovery reason"
              value={reason}
              disabled={busy || !!pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="button" disabled={!selected || busy || !!pending} onClick={submit}>
            Attempt invoice notice recovery
          </button>
          {pending && (
            <div>
              <p>
                Original recovery request {pending.requestId} may still be in flight. No write is retried
                automatically.
              </p>
              <button type="button" disabled={busy} onClick={() => execute(pending, true)}>
                Read original invoice recovery receipt
              </button>
            </div>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};
