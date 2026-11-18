import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  candidateOwnerService,
  type OwnerCommand,
  type RateKind,
} from '../services/rateCandidates';
import { isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Current = Awaited<ReturnType<typeof candidateOwnerService.inspect>>['current'];
export const CandidateOwner = ({
  candidateId,
  kind,
  onClose,
}: {
  candidateId: string;
  kind: RateKind;
  onClose: () => void;
  key?: string;
}) => {
  const [current, setCurrent] = useState<Current | undefined>(),
    [ownerUserId, setOwnerUserId] = useState(''),
    [ownerRole, setOwnerRole] = useState(''),
    [reason, setReason] = useState(''),
    [pending, setPending] = useState<OwnerCommand | null>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    mounted = useRef(false),
    inFlight = useRef(false),
    owner = useRef<RateContext | null>(null);
  const clear = (message: string) => {
    ++generation.current;
    owner.current = null;
    inFlight.current = false;
    setCurrent(undefined);
    setOwnerUserId('');
    setOwnerRole('');
    setReason('');
    setPending(null);
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const reset = () => clear('Account, role or scope changed. Reload the owner.');
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
      clear('Account, role or scope changed. Reload the owner.');
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
          'Owner operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
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
      const value = await candidateOwnerService.inspect(candidateId, kind, c);
      setCurrent(value.current);
      setOwnerUserId('');
      setOwnerRole('');
    });
  const save = () => {
    if (!ownerUserId || !ownerRole || current === undefined || pending || reason.trim().length < 3) return;
    const d: OwnerCommand = {
      requestId: crypto.randomUUID(),
      candidateId,
      expectedOwnerEventId: current?.id ?? null,
      ownerUserId,
      ownerRole,
      reason: reason.trim(),
    };
    void run(async (c) => {
      setPending(d);
      try {
        const x = await candidateOwnerService.assign(d, kind, c);
        setPending(null);
        setCurrent(undefined);
        setOwnerUserId('');
        setOwnerRole('');
        setReason('');
        setNotice('Owner version ' + x.sequence + ' recorded. Reload before another change.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setCurrent(undefined);
          setOwnerUserId('');
          setOwnerRole('');
          setNotice('Owner change refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (!pending) return;
    void run(async (c) => {
      const x = await candidateOwnerService.assign(pending, kind, c, true);
      setPending(null);
      setCurrent(undefined);
      setOwnerUserId('');
      setOwnerRole('');
      setNotice('Original owner version ' + x.sequence + ' confirmed by read-only receipt.');
    });
  };
  return (
    <section aria-label="Candidate change owner" className="my-3 rounded border p-3">
      <h3>Change owner</h3>
      <button type="button" onClick={onClose} disabled={busy || !!pending}>
        Close owner editor
      </button>
      <p>Ownership identifies the accountable recipient; it grants no approval or financial authority.</p>
      <button type="button" onClick={inspect} disabled={busy || !!pending}>
        Inspect change owner
      </button>
      {current !== undefined && (
        <>
          <p>
            {current
              ? `Owner ${current.ownerUserId}, role ${current.ownerRole}, version ${current.sequence}. ${current.eligible ? 'Currently eligible.' : 'Currently unavailable; fresh review is required.'}`
              : 'No owner has been assigned.'}
          </p>
          <label>
            Existing owner account ID
            <input
              aria-label="Existing owner account ID"
              value={ownerUserId}
              disabled={busy || !!pending}
              onChange={(e) => setOwnerUserId(e.target.value)}
            />
          </label>
          <label>
            Existing owner role
            <input
              aria-label="Existing owner role"
              value={ownerRole}
              disabled={busy || !!pending}
              onChange={(e) => setOwnerRole(e.target.value)}
            />
          </label>
          <label>
            Owner change reason
            <input
              aria-label="Owner change reason"
              value={reason}
              disabled={busy || !!pending}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={save}
            disabled={busy || !!pending || !ownerUserId || !ownerRole || reason.trim().length < 3}
          >
            Record change owner
          </button>
        </>
      )}
      {pending && (
        <div>
          <p>
            Original owner request {pending.requestId} may still be in flight; it will not be retried
            automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original owner receipt
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
};
