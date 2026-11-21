import { useEffect, useRef, useState } from 'react';
import { validTmEligibilityPolicy } from '../../shared/tm-billing-eligibility.mjs';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  tmBillingEligibility,
  type TmBillingPolicy,
  type TmBillingApproval,
  type TmBillingEvidence,
  type TmBillingOperation,
} from '../services/tmBillingEligibility';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Choice = { id: string; label: string };
type Template = { key: string; subject: string; body: string };
const events = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
export const TmBillingEligibilityWorkspace = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [locked, setLocked] = useState(false);
  const canRead = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'employees.view',
    'notifications.view',
  ].every(hasRatePermission);
  return (
    <section aria-label="T&M billing eligibility" className="my-4 rounded-xl border p-4 space-y-3">
      <h2>T&M billing eligibility</h2>
      <p>
        Only a separate named approval can establish billing eligibility. A retained calculation alone is not
        invoice authority.
      </p>
      {!canRead ? (
        <p role="status">Scoped billing review and worker access are required.</p>
      ) : (
        <>
          <label>
            Billing engagement
            <select
              aria-label="Billing engagement"
              value={engagement}
              disabled={locked}
              onChange={(e) => setEngagement(e.target.value)}
            >
              <option value="">Choose an engagement</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {engagement && (
            <TmBillingEngagement key={engagement} engagementId={engagement} onLockChange={setLocked} />
          )}
        </>
      )}
    </section>
  );
};
const TmBillingEngagement = ({
  engagementId,
  onLockChange,
}: {
  engagementId: string;
  onLockChange: (v: boolean) => void;
  key?: string;
}) => {
  const [policies, setPolicies] = useState<TmBillingPolicy[]>([]),
    [morePolicies, setMorePolicies] = useState(false),
    [sources, setSources] = useState<TmBillingEvidence[]>([]),
    [approvals, setApprovals] = useState<TmBillingApproval[]>([]),
    [sourceNext, setSourceNext] = useState<string | null>(null),
    [approvalNext, setApprovalNext] = useState<string | null>(null),
    [effectivePolicy, setEffectivePolicy] = useState<TmBillingPolicy | null>(null),
    [loaded, setLoaded] = useState(false),
    [snapshotId, setSnapshotId] = useState(''),
    [policyId, setPolicyId] = useState(''),
    [ownerId, setOwnerId] = useState(''),
    [ownerRole, setOwnerRole] = useState(''),
    [requestReason, setRequestReason] = useState(''),
    [selected, setSelected] = useState(''),
    [inspected, setInspected] = useState<{ approval: TmBillingApproval; source: TmBillingEvidence } | null>(
      null,
    ),
    [decision, setDecision] = useState(''),
    [decisionReason, setDecisionReason] = useState(''),
    [cancelReason, setCancelReason] = useState('');
  const [from, setFrom] = useState(''),
    [locale, setLocale] = useState(''),
    [completion, setCompletion] = useState(''),
    [stages, setStages] = useState([{ userId: '', role: '' }]),
    [templates, setTemplates] = useState<Template[]>(events.map((key) => ({ key, subject: '', body: '' }))),
    [policyReason, setPolicyReason] = useState(''),
    [pending, setPending] = useState<TmBillingOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [register, setRegister] = useState<
      Array<Awaited<ReturnType<typeof tmBillingEligibility.register>>['items'][number]>
    >([]),
    [registerNext, setRegisterNext] = useState<string | null>(null),
    [registerLoaded, setRegisterLoaded] = useState(false);
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null);
  useEffect(() => {
    onLockChange(busy || !!pending);
    return () => onLockChange(false);
  }, [busy, pending, onLockChange]);
  const clearStage = () => {
    setInspected(null);
    setDecision('');
    setDecisionReason('');
    setCancelReason('');
  };
  const clear = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setPolicies([]);
    setMorePolicies(false);
    setSources([]);
    setApprovals([]);
    setSourceNext(null);
    setApprovalNext(null);
    setEffectivePolicy(null);
    setLoaded(false);
    setSnapshotId('');
    setPolicyId('');
    setOwnerId('');
    setOwnerRole('');
    setRequestReason('');
    setSelected('');
    clearStage();
    setFrom('');
    setLocale('');
    setCompletion('');
    setStages([{ userId: '', role: '' }]);
    setTemplates(events.map((key) => ({ key, subject: '', body: '' })));
    setPolicyReason('');
    setPending(null);
    setBusy(false);
    setRegister([]);
    setRegisterNext(null);
    setRegisterLoaded(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('Account, role or scope changed. Unsent billing inputs were cleared.');
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
  }, [engagementId]);
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
          'The operation could not be confirmed. Read its original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && generation.current === n) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const load = () =>
    void run(async (c) => {
      clearStage();
      setLoaded(false);
      setSelected('');
      setSnapshotId('');
      setPolicyId('');
      const x = await tmBillingEligibility.load(engagementId, c);
      setPolicies(x.policies);
      setMorePolicies(x.morePolicies);
      setSources(x.sources);
      setApprovals(x.approvals);
      setSourceNext(x.sourcesNext);
      setApprovalNext(x.approvalsNext);
      setEffectivePolicy(x.effectivePolicy);
      setLoaded(true);
    });
  const more = (kind: 'sources' | 'instances', after: string) =>
    void run(async (c) => {
      const x = await tmBillingEligibility.page(kind, engagementId, after, c);
      if (kind === 'sources') {
        setSources((old) => [...old, ...x.sources]);
        setSourceNext(x.nextAfter);
      } else {
        setApprovals((old) => [...old, ...x.approvals]);
        setApprovalNext(x.nextAfter);
      }
    });
  const loadOlderPolicies = () => {
    const last = policies[policies.length - 1];
    if (!morePolicies || !last) return;
    void run(async c => {
      const page = await tmBillingEligibility.olderPolicies(engagementId, last, c);
      setPolicies(old => [...old, ...page.policies]);
      setMorePolicies(page.truncated);
    });
  };
  const inspect = () => {
    if (!selected) return;
    void run(async (c) => {
      clearStage();
      const x = await tmBillingEligibility.inspect(selected, c);
      if (x.approval.engagementId !== engagementId) throw Error('Scope changed');
      setInspected({ approval: x.approval, source: x.source });
    });
  };
  const loadRegister = (after?: string) =>
    void run(async (c) => {
      const x = await tmBillingEligibility.register(c, after);
      setRegister((old) => (after ? [...old, ...x.items] : x.items));
      setRegisterNext(x.nextAfter);
      setRegisterLoaded(true);
    });
  const perform = (op: TmBillingOperation) => {
    if (pending) return;
    void run(async (c) => {
      setPending(op);
      try {
        await tmBillingEligibility.run(op, engagementId, c);
        setPending(null);
        setLoaded(false);
        setPolicies([]);
        setSources([]);
        setApprovals([]);
        setInspected(null);
        setSelected('');
        setNotice('Operation recorded. Reload the current evidence before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setLoaded(false);
          setPolicies([]);
          setSources([]);
          setApprovals([]);
          setInspected(null);
          setNotice(e.code === 'BILLING_ELIGIBILITY_PERIOD_CLOSED'
            ? 'The eligibility date is outside an open financial period. Review the reporting calendar before approving.'
            : e.code === 'TM_BILLING_STAGE_CHANGED'
            ? 'The review stage changed. Reload and inspect the current stage before cancelling.'
            : 'The operation was refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (!pending) return;
    void run(async (c) => {
      await tmBillingEligibility.run(pending, engagementId, c, true);
      setPending(null);
      setLoaded(false);
      setInspected(null);
      setNotice('The original request was confirmed by a read-only receipt. Reload.');
    });
  };
  const canManage = ['commercial.contracts.manage', 'commercial.tm_billing.manage'].every(hasRatePermission),
    canDecide = ['approvals.view', 'commercial.tm_billing.decide'].every(hasRatePermission),
    chosen = inspected?.approval;
  const configure = () => {
    const definition = {
      entityType: 'TmBillingEligibility',
      engagementId,
      stages,
      locale,
      templates,
      completionInApp: completion === 'yes',
    };
    if (
      !from ||
      !['yes', 'no'].includes(completion) ||
      policyReason.trim().length < 3 ||
      !validTmEligibilityPolicy(definition)
    )
      return;
    perform({
      type: 'policy',
      data: {
        requestId: crypto.randomUUID(),
        engagementId,
        expectedLatestId: policies[0]?.id ?? null,
        effectiveFrom: from,
        definition,
        reason: policyReason.trim(),
      },
    });
  };
  const requestReady = Boolean(
    snapshotId &&
      policyId &&
      effectivePolicy?.id === policyId &&
      ownerId &&
      ownerRole &&
      requestReason.trim().length >= 3,
  );
  const request = () => {
    if (!requestReady) return;
    perform({
      type: 'request',
      data: {
        requestId: crypto.randomUUID(),
        snapshotId,
        expectedPolicyId: policyId,
        ownerUserId: ownerId,
        ownerRole,
        reason: requestReason.trim(),
      },
    });
  };
  const decide = () => {
    if (
      !chosen ||
      !chosen.current ||
      chosen.state.status !== 'Pending' ||
      !['Approved', 'Rejected'].includes(decision) ||
      decisionReason.trim().length < 3
    )
      return;
    perform({
      type: 'decision',
      id: chosen.id,
      data: {
        requestId: crypto.randomUUID(),
        expectedSequence: chosen.state.sequence,
        decision: decision as 'Approved' | 'Rejected',
        reason: decisionReason.trim(),
      },
    });
  };
  const cancel = () => {
    if (!chosen || chosen.state.status !== 'Pending' || cancelReason.trim().length < 3) return;
    perform({
      type: 'cancellation',
      id: chosen.id,
      data: { requestId: crypto.randomUUID(), expectedSequence: chosen.state.sequence, reason: cancelReason.trim() },
    });
  };
  return (
    <div className="space-y-3">
      <button type="button" disabled={busy || !!pending} onClick={load}>
        Load billing evidence and reviews
      </button>
      <button type="button" disabled={busy || !!pending} onClick={() => loadRegister()}>
        Load approved-unbilled register
      </button>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div>
          <p>
            Original {pending.type} request {pending.data.requestId} may still be in flight; no write is
            retried automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original billing receipt
          </button>
        </div>
      )}
      {registerLoaded && (
        <section aria-label="Approved-unbilled register">
          <h3>Approved-unbilled register</h3>
          {register.length === 0 ? (
            <p>No visible available items.</p>
          ) : (
            <ul>
              {register.map((x) => (
                <li key={x.id}>
                  {x.currency} {x.amount} · eligible {x.eligibleOn} · event {x.eventId} · snapshot{' '}
                  {x.snapshotId} · client {x.clientId} · contract {x.contractId} · engagement {x.engagementId}
                </li>
              ))}
            </ul>
          )}
          {registerNext && (
            <button type="button" disabled={busy || !!pending} onClick={() => loadRegister(registerNext)}>
              More approved-unbilled items
            </button>
          )}
        </section>
      )}
      {loaded && (
        <>
          <p>Billing evidence excludes confidential cost and margin.</p>
          {policies.length > 0 && (
            <details>
              <summary>Billing review policy history</summary>
              <ul>
                {policies.map((x) => (
                  <li key={x.id}>
                    Version {x.sequence} · effective {x.effectiveFrom} UTC · {x.reason}
                    <ol>{x.definition.stages.map((stage, i) =>
                      <li key={i}>{stage.role} · {stage.userId}</li>)}</ol>
                  </li>
                ))}
              </ul>
              {morePolicies && <button type="button" disabled={busy || !!pending} onClick={loadOlderPolicies}>Load older billing policies</button>}
            </details>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending}>
              <legend>Prospective named review policy</legend>
              <label>
                Effective from UTC
                <input
                  type="date"
                  aria-label="Billing policy effective from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Locale
                <input
                  aria-label="Billing policy locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                />
              </label>
              <label>
                Completion in-app
                <select
                  aria-label="Billing completion in-app"
                  value={completion}
                  onChange={(e) => setCompletion(e.target.value)}
                >
                  <option value="">Choose</option>
                  <option value="yes">Enabled subject to preference</option>
                  <option value="no">Suppressed by policy</option>
                </select>
              </label>
              {stages.map((stage, i) => (
                <div key={i}>
                  <label>
                    Approver user ID
                    <input
                      aria-label={`Billing stage ${i + 1} user ID`}
                      value={stage.userId}
                      onChange={(e) =>
                        setStages((x) => x.map((v, n) => (n === i ? { ...v, userId: e.target.value } : v)))
                      }
                    />
                  </label>
                  <label>
                    Approver held role
                    <input
                      aria-label={`Billing stage ${i + 1} role`}
                      value={stage.role}
                      onChange={(e) =>
                        setStages((x) => x.map((v, n) => (n === i ? { ...v, role: e.target.value } : v)))
                      }
                    />
                  </label>
                </div>
              ))}
              <button
                type="button"
                disabled={stages.length >= 10}
                onClick={() => setStages((x) => [...x, { userId: '', role: '' }])}
              >
                Add billing stage
              </button>
              {stages.length > 1 && (
                <button type="button" onClick={() => setStages((x) => x.slice(0, -1))}>
                  Remove last billing stage
                </button>
              )}
              {templates.map((t, i) => (
                <div key={t.key}>
                  <p>{t.key}</p>
                  <label>
                    Subject
                    <input
                      aria-label={`${t.key} billing subject`}
                      value={t.subject}
                      onChange={(e) =>
                        setTemplates((x) =>
                          x.map((v, n) => (n === i ? { ...v, subject: e.target.value } : v)),
                        )
                      }
                    />
                  </label>
                  <label>
                    Body
                    <input
                      aria-label={`${t.key} billing body`}
                      value={t.body}
                      onChange={(e) =>
                        setTemplates((x) => x.map((v, n) => (n === i ? { ...v, body: e.target.value } : v)))
                      }
                    />
                  </label>
                </div>
              ))}
              <p>
                Templates may use {'{{sourceRef}}'} and {'{{stageNumber}}'} only.
              </p>
              <label>
                Policy reason
                <input
                  aria-label="Billing policy reason"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={configure}>
                Record billing review policy
              </button>
            </fieldset>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending}>
              <legend>Request explicit eligibility review</legend>
              <label>
                Retained snapshot
                <select
                  aria-label="Billing snapshot"
                  value={snapshotId}
                  onChange={(e) => setSnapshotId(e.target.value)}
                >
                  <option value="">Choose a retained snapshot</option>
                  {sources.map((x) => (
                    <option key={x.snapshotId} value={x.snapshotId}>
                      {x.workDate} · {x.currency} {x.amount} · {x.snapshotId}
                    </option>
                  ))}
                </select>
              </label>
              {sourceNext && (
                <button type="button" onClick={() => more('sources', sourceNext)}>
                  More billing snapshots
                </button>
              )}
              <label>
                Review policy
                <select
                  aria-label="Billing review policy"
                  value={policyId}
                  onChange={(e) => setPolicyId(e.target.value)}
                >
                  <option value="">
                    {effectivePolicy
                      ? 'Choose the effective policy'
                      : 'No billing review policy is effective today'}
                  </option>
                  {effectivePolicy && (
                    <option value={effectivePolicy.id}>
                      {effectivePolicy.effectiveFrom} · version {effectivePolicy.sequence}
                    </option>
                  )}
                </select>
              </label>
              <label>
                Change owner user ID
                <input
                  aria-label="Billing change owner user ID"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                />
              </label>
              <label>
                Change owner held role
                <input
                  aria-label="Billing change owner role"
                  value={ownerRole}
                  onChange={(e) => setOwnerRole(e.target.value)}
                />
              </label>
              <label>
                Request reason
                <input
                  aria-label="Billing request reason"
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                />
              </label>
              <button type="button" disabled={!requestReady} onClick={request}>
                Request billing review
              </button>
            </fieldset>
          )}
          <label>
            Retained review
            <select
              aria-label="Billing review"
              disabled={busy || !!pending}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                clearStage();
              }}
            >
              <option value="">Choose a review</option>
              {approvals.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.state.status} · {x.id}
                </option>
              ))}
            </select>
          </label>
          {approvalNext && (
            <button
              type="button"
              disabled={busy || !!pending}
              onClick={() => more('instances', approvalNext)}
            >
              More billing reviews
            </button>
          )}
          <button type="button" disabled={busy || !!pending || !selected} onClick={inspect}>
            Inspect retained billing evidence
          </button>
          {inspected && (
            <section aria-label="Inspected billing review">
              <p>
                Snapshot {inspected.source.snapshotId} · {inspected.source.currency} {inspected.source.amount}{' '}
                · work {inspected.source.submissionId} · decision {inspected.source.decisionId} · policy{' '}
                {inspected.source.policyId} · billing source {inspected.source.billingAdoptionId}.
              </p>
              <p>
                Review {chosen?.id} · {chosen?.state.status} · current {String(chosen?.current)} · owner{' '}
                {chosen?.ownerUserId} ({chosen?.ownerRole}). Completed decisions: {chosen?.state.sequence}.
              </p>
              {canDecide && chosen?.current && chosen.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Decide the inspected stage</legend>
                  <label>
                    Decision
                    <select
                      aria-label="Billing decision"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="">Choose</option>
                      <option>Approved</option>
                      <option>Rejected</option>
                    </select>
                  </label>
                  <label>
                    Decision reason
                    <input
                      aria-label="Billing decision reason"
                      value={decisionReason}
                      onChange={(e) => setDecisionReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={decide}>
                    Record billing decision
                  </button>
                </fieldset>
              )}
              {canManage && chosen?.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Invalidate pending review</legend>
                  <label>
                    Cancellation reason
                    <input
                      aria-label="Billing cancellation reason"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={cancel}>
                    Cancel billing review
                  </button>
                </fieldset>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
};
