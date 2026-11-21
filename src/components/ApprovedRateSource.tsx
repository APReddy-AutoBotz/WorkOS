import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../services/apiClient';
import { approvedRateSources, type AdoptionCommand } from '../services/approvedRateSources';
import { captureRateContext, type RateKind } from '../services/rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Inspection = Awaited<ReturnType<typeof approvedRateSources.inspect>>;
export const ApprovedRateSource = ({
  candidateId,
  kind,
  effectiveFrom,
  onClose,
}: {
  candidateId: string;
  kind: RateKind;
  effectiveFrom: string;
  onClose: () => void;
  key?: string;
}) => {
  const [view, setView] = useState<Inspection | null>(null),
    [choice, setChoice] = useState(''),
    [reason, setReason] = useState(''),
    [pending, setPending] = useState<AdoptionCommand | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    owner = useRef<RateContext | null>(null);
  const clear = (m: string) => {
    ++generation.current;
    owner.current = null;
    inFlight.current = false;
    setView(null);
    setChoice('');
    setReason('');
    setPending(null);
    setBusy(false);
    setNotice(m);
  };
  useEffect(() => {
    mounted.current = true;
    const reset = () => clear('Account, role or scope changed. Unsent adoption inputs cleared.');
    const check = () => {
      if (owner.current && !isRateContextCurrent(owner.current)) reset();
    };
    window.addEventListener('workos:organization-scope-switch-requested', reset);
    window.addEventListener('workos:organization-scope-changed', reset);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', reset);
      window.removeEventListener('workos:organization-scope-changed', reset);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, [candidateId, kind]);
  const run = async (fn: (c: RateContext) => Promise<void>) => {
    if (inFlight.current) return;
    if (owner.current && !isRateContextCurrent(owner.current)) {
      clear('Account, role or scope changed. Reload.');
      return;
    }
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      clear('An active session and selected scope are required.');
      return;
    }
    owner.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c);
    } catch {
      if (mounted.current && n === generation.current)
        setNotice(
          'The operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && n === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const inspect = () =>
    void run(async (c) => {
      const v = await approvedRateSources.inspect(candidateId, kind, c);
      setView(v);
      setChoice('');
      setReason('');
    });
  const adopt = () => {
    const r = view?.reviews.find((x) => x.approvalId === choice && x.current);
    if (
      !r ||
      !view ||
      view.adoption ||
      effectiveFrom < view.serverDate ||
      pending ||
      reason.trim().length < 3
    )
      return;
    const d: AdoptionCommand = {
      requestId: crypto.randomUUID(),
      candidateId,
      expectedOwnerEventId: r.ownerEventId,
      approvalId: r.approvalId,
      expectedPolicyId: r.policyId,
      expectedFinalTransitionId: r.finalTransitionId,
      reason: reason.trim(),
    };
    void run(async (c) => {
      setPending(d);
      try {
        const x = await approvedRateSources.adopt(d, kind, c);
        setPending(null);
        setView(null);
        setChoice('');
        setReason('');
        setNotice('Approved source ' + x.id + ' adopted. Reload before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setView(null);
          setChoice('');
          setReason('');
          setNotice('Adoption refused. Reload the current review before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (!pending) return;
    void run(async (c) => {
      const x = await approvedRateSources.adopt(pending, kind, c, true);
      setPending(null);
      setView(null);
      setChoice('');
      setReason('');
      setNotice('Original adopted source ' + x.id + ' confirmed by read-only receipt.');
    });
  };
  const canAdopt =
    hasRatePermission(
      kind === 'billing' ? 'commercial.rate_candidates.manage' : 'commercial.cost_candidates.manage',
    ) &&
    (kind !== 'billing' || hasRatePermission('commercial.contracts.manage'));
  return (
    <section aria-label="Adopt approved source" className="my-3 rounded border p-3">
      <h3>Adopt approved source</h3>
      <p>
        A completed review does not activate a source. Explicit adoption preserves its exact approval and
        owner versions; it does not calculate values or make invoices. Adoption requires a current or future
        start date and exactly one uncancelled review for the current owner and policy. Repeated or rejected
        reviews need a new policy version.
      </p>
      <button type="button" onClick={onClose} disabled={busy || !!pending}>
        Close source adoption
      </button>
      <button type="button" onClick={inspect} disabled={busy || !!pending}>
        Inspect approved reviews
      </button>
      {view && (
        <>
          <p>
            {view.adoption
              ? `Adopted source ${view.adoption.id} retains approval ${view.adoption.approvalId}.`
              : 'No adoption has been recorded.'}
          </p>
          {view.adoption && (
            <details>
              <summary>Adoption receipt</summary>
              <dl>
                <dt>Adopted at</dt><dd>{view.adoption.createdAt}</dd>
                <dt>Adopted by</dt><dd>{view.adoption.actorId} ({view.adoption.activeRole})</dd>
                <dt>Reason</dt><dd>{view.adoption.reason}</dd>
                <dt>Candidate version ID</dt><dd>{view.adoption.candidateId}</dd>
                <dt>Owner event ID</dt><dd>{view.adoption.ownerEventId}</dd>
                <dt>Approval policy version ID</dt><dd>{view.adoption.policyId}</dd>
                <dt>Final approval transition ID</dt><dd>{view.adoption.finalTransitionId}</dd>
                <dt>Adoption request ID</dt><dd>{view.adoption.requestId}</dd>
              </dl>
            </details>
          )}
          {view.truncated && <p>Only the latest ten completed reviews are shown.</p>}
          {canAdopt && !view.adoption && (
            <>
              <label>
                Completed review
                <select
                  aria-label="Completed review"
                  value={choice}
                  disabled={busy || !!pending}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  {view.reviews.map((r) => (
                    <option key={r.approvalId} value={r.approvalId} disabled={!r.current}>
                      {r.approvalId} · {r.current ? 'current' : 'stale'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Adoption reason
                <input
                  aria-label="Adoption reason"
                  value={reason}
                  disabled={busy || !!pending}
                  maxLength={1000}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={adopt}
                disabled={
                  busy || !!pending || !choice || effectiveFrom < view.serverDate || reason.trim().length < 3
                }
              >
                Adopt approved rate source
              </button>
            </>
          )}
        </>
      )}
      {pending && (
        <div>
          <p>
            Original adoption request {pending.requestId} may still be in flight; no write is retried
            automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original adoption receipt
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};

export const AdoptedRateResolution = ({
  kind,
  sourceId,
}: {
  kind: RateKind;
  sourceId?: string;
  key?: string;
}) => {
  const [asOf, setAsOf] = useState(''),
    [currency, setCurrency] = useState(''),
    [unit, setUnit] = useState(''),
    [result, setResult] = useState<Awaited<ReturnType<typeof approvedRateSources.resolve>> | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    owner = useRef<RateContext | null>(null);
  useEffect(() => {
    mounted.current = true;
    const reset = () => {
      ++generation.current;
      owner.current = null;
      setAsOf('');
      setCurrency('');
      setUnit('');
      setResult(null);
      setBusy(false);
      setNotice('Account, role or scope changed. Reload the source.');
    };
    const check = () => {
      if (owner.current && !isRateContextCurrent(owner.current)) reset();
    };
    window.addEventListener('workos:organization-scope-switch-requested', reset);
    window.addEventListener('workos:organization-scope-changed', reset);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', reset);
      window.removeEventListener('workos:organization-scope-changed', reset);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, [kind, sourceId]);
  const resolve = async () => {
    if (!sourceId || busy) return;
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      setNotice('An active session and selected scope are required.');
      return;
    }
    owner.current = c;
    setBusy(true);
    setResult(null);
    setNotice('');
    try {
      const x = await approvedRateSources.resolve({ kind, sourceId, asOf, currency, unit }, c);
      if (mounted.current && n === generation.current) setResult(x);
    } catch {
      if (mounted.current && n === generation.current)
        setNotice('The adopted source could not be confirmed. Reload the selected scope.');
    } finally {
      if (mounted.current && n === generation.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Resolve adopted rate source" className="my-3 rounded border p-3">
      <h3>Resolve adopted rate source</h3>
      <p>
        Only approved, explicitly adopted sources are considered. Missing or equally ranked sources require
        resolution; no arithmetic or conversion occurs.
      </p>
      <label>
        Adopted source as-of UTC
        <input
          aria-label="Adopted source as-of UTC"
          type="date"
          value={asOf}
          disabled={busy}
          onChange={(e) => {
            setAsOf(e.target.value);
            setResult(null);
          }}
        />
      </label>
      <label>
        Adopted source currency
        <input
          aria-label="Adopted source currency"
          value={currency}
          maxLength={3}
          disabled={busy}
          onChange={(e) => {
            setCurrency(e.target.value);
            setResult(null);
          }}
        />
      </label>
      <label>
        Adopted source unit
        <input
          aria-label="Adopted source unit"
          value={unit}
          maxLength={40}
          disabled={busy}
          onChange={(e) => {
            setUnit(e.target.value);
            setResult(null);
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => void resolve()}
        disabled={busy || !sourceId || !asOf || !currency || !unit}
      >
        Resolve adopted source
      </button>
      {result && (
        <p role="status">
          Adopted resolution: {result.result}
          {result.source
            ? ` · ${result.source.currency} ${result.source.amount}/${result.source.unit} · ${result.source.bindingType} ${result.source.bindingId} · version ${result.source.sequence} effective ${result.source.effectiveFrom} through ${result.source.effectiveTo} UTC · priority ${result.source.priority} · candidate ${result.source.id} · adoption ${result.source.adoptionId} · approval ${result.source.approvalId} · adopted ${result.source.adoptedAt}`
            : ''}
          .
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};
