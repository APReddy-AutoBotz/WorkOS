import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  invoiceCsv,
  type InvoiceConfirmationSource,
  type InvoiceConfirmation,
  type InvoiceConfirmationOperation,
} from '../services/invoiceCsv';
import { invoiceDrafts, type InvoiceDraft } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Choice = { id: string; label: string };
export const InvoiceBillingConfirmation = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [drafts, setDrafts] = useState<InvoiceDraft[]>([]),
    [next, setNext] = useState<string | null>(null),
    [credits,setCredits] = useState<{id:string;state:string}[]>([]),
    [creditNext,setCreditNext] = useState<string|null>(null),
    [batch, setBatch] = useState(''),
    [source, setSource] = useState<InvoiceConfirmationSource | null>(null),
    [existing, setExisting] = useState<InvoiceConfirmation | null>(null),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [attested, setAttested] = useState(false),
    [pending, setPending] = useState<InvoiceConfirmationOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [lastRequest, setLastRequest] = useState(''),
    [notification, setNotification] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null),
    allowed = [
      'commercial.contracts.view',
      'commercial.tm_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_export.view',
      'commercial.invoice_batch.confirm',
      'employees.view',
      'notifications.view',
    ].every(hasRatePermission);
  const clear = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setEngagement('');
    setDrafts([]);
    setCredits([]);
    setCreditNext(null);
    setNext(null);
    setBatch('');
    setSource(null);
    setExisting(null);
    setReference('');
    setReason('');
    setAttested(false);
    setPending(null);
    setBusy(false);
    setNotice(message);
    setLastRequest('');
    setNotification('');
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('Account, role or scope changed. Unsent confirmation inputs were cleared.');
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
  const load = (after?: string) =>
    void run(async (c) => {
      const x = await invoiceDrafts.list(c, after);
      setDrafts((old) => (after ? [...old, ...x.batches] : x.batches));
      setNext(x.nextAfter);
      if (!after) {
        setBatch('');
        setSource(null);
        setExisting(null);
      }
    });
  const inspect = () => {
    if (batch)
      void run(async (c) => {
        const x = await invoiceCsv.confirmationSource(batch, c);
        setSource(x.source);
        setExisting(x.confirmation);
        setAttested(false);
      });
  };
  const execute = (op: InvoiceConfirmationOperation, receipt = false) =>
    void run(async (c) => {
      if (!receipt) {
        setPending(op);
        setLastRequest(op.requestId);
        setNotification('');
      }
      try {
        const x = await invoiceCsv.confirm(op, c, receipt);
        setPending(null);
        setSource(null);
        setExisting(x);
        setNotice('Manual downstream attestation recorded. No provider verification or payment is implied.');
      } catch (e) {
        if (!receipt && e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setSource(null);
          setNotice('Attestation was refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  const loadCredits = (after: string | null = null) => run(async c => {
    const result = await invoiceCsv.correctionBatches(engagement, after, c, 'confirmation');
    setCredits(old => after ? [...old, ...result.batches] : result.batches);
    setCreditNext(result.nextAfter);
  });
  const submit = () => {
    if (!source || source.state !== 'Exported' || !attested || !reference.trim() || reason.trim().length < 3)
      return;
    execute({
      ...(source.sourceType ? { sourceType: source.sourceType } : {}),
      requestId: crypto.randomUUID(),
      batchId: source.batchId,
      artifactId: source.artifactId,
      artifactVersion: source.artifactVersion,
      artifactSha256: source.artifactSha256,
      currency: source.currency,
      total: source.total,
      reference: reference.trim(),
      reason: reason.trim(),
    });
  };
  const checkNotification = () => {
    if (lastRequest)
      void run(async (c) => {
        const x = await invoiceCsv.confirmationNotificationStatus(lastRequest, c);
        setNotification(
          x.state === 'Recorded'
            ? 'Confirmation notification event recorded.'
            : x.state === 'DeliveryIncomplete'
              ? 'Confirmation notification delivery needs recovery.'
              : 'Confirmation notification event needs recovery.',
        );
      });
  };
  return (
    <section aria-label="Invoice billing confirmation" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Invoice billing confirmation</h2>
      <p>
        Confirm that a downstream system billed this invoice or applied this credit. Enter the external reference and check the
        exported total before submitting. The receipt records your attestation.
      </p>
      {!allowed ? (
        <p role="status">Scoped billing confirmation authority is required.</p>
      ) : (
        <>
          <label>
            Engagement
            <select
              aria-label="Invoice confirmation engagement"
              value={engagement}
              disabled={busy || !!pending}
              onChange={(e) => {
                setEngagement(e.target.value);
                setDrafts([]);
                setCredits([]);
                setCreditNext(null);
                setNext(null);
                setBatch('');
                setSource(null);
                setExisting(null);
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
          <button type="button" disabled={!engagement || busy || !!pending} onClick={() => load()}>
            Load invoice confirmation batches
          </button>
          <button type="button" disabled={!engagement || busy || !!pending} onClick={() => loadCredits()}>Find exported credits</button>
          {creditNext && <button type="button" disabled={busy || !!pending} onClick={() => loadCredits(creditNext)}>More credit batches</button>}
          {next && (
            <button type="button" disabled={busy || !!pending} onClick={() => load(next)}>
              More invoice confirmation batches
            </button>
          )}
          <label>
            Batch
            <select
              aria-label="Invoice confirmation batch"
              value={batch}
              disabled={busy || !!pending}
              onChange={(e) => {
                setBatch(e.target.value);
                setSource(null);
                setExisting(null);
              }}
            >
              <option value="">Choose</option>
              {credits.map(x => <option key={x.id} value={x.id}>Credit · {x.state} · {x.id}</option>)}
              {drafts
                .filter(
                  (x) => x.engagementId === engagement && ['Exported', 'Billed/Confirmed'].includes(x.state),
                )
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.state} · {x.id}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" disabled={!batch || busy || !!pending} onClick={inspect}>
            Inspect exported invoice artifact
          </button>
          {source && (
            <section aria-label="Inspected confirmation source">
              <p>
                {source.state} · {source.sourceType === 'MILESTONE_ACCEPTANCE' ? 'milestone source · ' : source.sourceType === 'RETAINER_PERIOD' ? 'retainer source · ' : source.sourceType === 'FULL_LINE_REVERSAL' ? 'credit · ' : ''}
                artifact {source.artifactId} v{source.artifactVersion} · SHA-256 {source.artifactSha256} ·{' '}
                {source.currency} {source.total}.
              </p>
              {source.state === 'Exported' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Manual downstream attestation</legend>
                  <label>
                    Downstream reference
                    <input
                      aria-label="Invoice confirmation reference"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </label>
                  <label>
                    Attestation reason
                    <input
                      aria-label="Invoice confirmation reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={attested}
                      onChange={(e) => setAttested(e.target.checked)}
                    />
                    I attest the referenced downstream confirmation matches this exact artifact and total
                  </label>
                  <button type="button" onClick={submit}>
                    Record manual billing attestation
                  </button>
                </fieldset>
              )}
            </section>
          )}
          {existing && (
            <p>
              Retained manual attestation {existing.id} · reference {existing.reference} ·{' '}
              {existing.confirmedAt} · actor {existing.actorId}.
            </p>
          )}
          {pending && (
            <div>
              <p>
                Original attestation request {pending.requestId} may still be in flight. No write is retried
                automatically.
              </p>
              <button type="button" disabled={busy} onClick={() => execute(pending, true)}>
                Read original billing attestation receipt
              </button>
            </div>
          )}
          {lastRequest && !pending && (
            <button type="button" disabled={busy} onClick={checkNotification}>
              Check billing confirmation notification status
            </button>
          )}
          {notification && <p role="status">{notification}</p>}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};
