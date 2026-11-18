import { useEffect, useRef, useState } from 'react';
import {
  validMilestoneBillingPolicy,
  validMilestoneEvidence,
} from '../../shared/milestone-billing-eligibility.mjs';
import { authService } from '../services/authService';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  milestoneBilling,
  type MilestoneApproval,
  type MilestoneOperation,
  type MilestonePolicy,
  type MilestoneSource,
} from '../services/milestoneBilling';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Choice = { id: string; label: string };
type Template = { key: string; subject: string; body: string };
const events = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
const kinds = ['INTERNAL_ASSERTION', 'CLIENT_EVIDENCE_ASSERTION'] as const;
export const MilestoneBillingWorkspace = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [locked, setLocked] = useState(false);
  const canRead = [
    'commercial.contracts.view',
    'commercial.milestone_billing.view',
    'employees.view',
    'notifications.view',
  ].every(hasRatePermission);
  return (
    <section aria-label="Milestone billing eligibility" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Milestone billing eligibility</h2>
      <p>
        Record internal or client acceptance evidence for the named reviewers. You attest to the client evidence you supply.
      </p>
      {!canRead ? (
        <p role="status">Scoped milestone billing access is required.</p>
      ) : (
        <>
          <label>
            Milestone engagement{' '}
            <select
              aria-label="Milestone billing engagement"
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
            <MilestoneReview key={engagement} engagementId={engagement} onLockChange={setLocked} />
          )}
        </>
      )}
    </section>
  );
};
const MilestoneReview = ({
  engagementId,
  onLockChange,
}: {
  engagementId: string;
  onLockChange: (v: boolean) => void;
  key?: string;
}) => {
  const [policies, setPolicies] = useState<MilestonePolicy[]>([]),
    [sources, setSources] = useState<MilestoneSource[]>([]),
    [approvals, setApprovals] = useState<MilestoneApproval[]>([]),
    [loaded, setLoaded] = useState(false),
    [limited, setLimited] = useState(false),
    [selected, setSelected] = useState(''),
    [inspected, setInspected] = useState<{ approval: MilestoneApproval; source: MilestoneSource } | null>(
      null,
    );
  const [from, setFrom] = useState(''),
    [locale, setLocale] = useState(''),
    [completion, setCompletion] = useState(''),
    [required, setRequired] = useState<string[]>([]),
    [stages, setStages] = useState([{ userId: '', role: '' }]),
    [templates, setTemplates] = useState<Template[]>(events.map((key) => ({ key, subject: '', body: '' }))),
    [policyReason, setPolicyReason] = useState('');
  const [sourceId, setSourceId] = useState(''),
    [policyId, setPolicyId] = useState(''),
    [ownerId, setOwnerId] = useState(''),
    [ownerRole, setOwnerRole] = useState(''),
    [references, setReferences] = useState<Record<string, { reference: string; url: string }>>({}),
    [requestReason, setRequestReason] = useState(''),
    [decision, setDecision] = useState(''),
    [decisionReason, setDecisionReason] = useState(''),
    [cancelReason, setCancelReason] = useState('');
  const [pending, setPending] = useState<MilestoneOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [register, setRegister] = useState<Awaited<ReturnType<typeof milestoneBilling.register>>['items'] | null>(
      null,
    ),
    [registerLimited, setRegisterLimited] = useState(false);
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null);
  useEffect(() => {
    onLockChange(busy || !!pending);
    return () => onLockChange(false);
  }, [busy, pending, onLockChange]);
  const clear = (message: string) => {
    generation.current++;
    context.current = null;
    inFlight.current = false;
    setPolicies([]);
    setSources([]);
    setApprovals([]);
    setLoaded(false);
    setLimited(false);
    setSelected('');
    setInspected(null);
    setFrom('');
    setLocale('');
    setCompletion('');
    setRequired([]);
    setStages([{ userId: '', role: '' }]);
    setTemplates(events.map((key) => ({ key, subject: '', body: '' })));
    setPolicyReason('');
    setSourceId('');
    setPolicyId('');
    setOwnerId('');
    setOwnerRole('');
    setReferences({});
    setRequestReason('');
    setDecision('');
    setDecisionReason('');
    setCancelReason('');
    setPending(null);
    setBusy(false);
    setRegister(null);
    setRegisterLimited(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('Account, role or scope changed. Unsent milestone inputs were cleared.');
    const check = () => {
      if (context.current && !isRateContextCurrent(context.current)) block();
    };
    window.addEventListener('workos:organization-scope-switch-requested', block);
    window.addEventListener('workos:organization-scope-changed', block);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      generation.current++;
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
          'The operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
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
      const x = await milestoneBilling.load(engagementId, c);
      setPolicies(x.policies);
      setSources(x.sources);
      setApprovals(x.approvals);
      setLimited(x.truncated);
      setLoaded(true);
      setSelected('');
      setInspected(null);
    });
  const inspect = () => {
    if (!selected) return;
    void run(async (c) => {
      const x = await milestoneBilling.inspect(selected, c);
      if (x.approval.engagementId !== engagementId) throw Error('Scope changed');
      setInspected({ approval: x.approval, source: x.source });
    });
  };
  const perform = (op: MilestoneOperation) => {
    if (pending) return;
    void run(async (c) => {
      setPending(op);
      try {
        await milestoneBilling.run(op, c);
        setPending(null);
        setLoaded(false);
        setInspected(null);
        setNotice('Operation recorded. Reload before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 404, 409, 422].includes(e.status)) {
          setPending(null);
          setLoaded(false);
          setInspected(null);
          setNotice('Operation refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (!pending) return;
    void run(async (c) => {
      await milestoneBilling.run(pending, c, true);
      setPending(null);
      setLoaded(false);
      setInspected(null);
      setNotice('The original request was confirmed by a read-only receipt. Reload.');
    });
  };
  const canManage = ['commercial.contracts.manage', 'commercial.milestone_billing.manage'].every(
      hasRatePermission,
    ),
    hasDecisionPermission = ['approvals.view', 'commercial.milestone_billing.decide'].every(
      hasRatePermission,
    ),
    chosen = inspected?.approval,
    selectedPolicy = policies.find((p) => p.id === policyId);
  const reviewer = authService.getCurrentUser(),
    stage =
      chosen?.state.currentStage == null
        ? null
        : (chosen.policy.definition as { stages: { userId: string; role: string }[] }).stages[
            chosen.state.currentStage
          ];
  const canDecide =
    hasDecisionPermission &&
    !!reviewer &&
    stage?.userId === reviewer.id &&
    stage.role === context.current?.activeRole &&
    reviewer.id !== chosen?.ownerUserId &&
    reviewer.id !== chosen?.requesterUserId;
  const configure = () => {
    const definition = {
      entityType: 'MilestoneBillingEligibility',
      engagementId,
      evidenceKinds: required,
      stages,
      locale,
      templates,
      completionInApp: completion === 'yes',
    };
    if (
      !from ||
      !['yes', 'no'].includes(completion) ||
      policyReason.trim().length < 3 ||
      !validMilestoneBillingPolicy(definition)
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
  const request = () => {
    if (!selectedPolicy || !sourceId || !ownerId || !ownerRole || requestReason.trim().length < 3) return;
    const k = (selectedPolicy.definition as { evidenceKinds: string[] }).evidenceKinds,
      evidence = k.map((kind) => ({ kind, ...references[kind] }));
    if (!validMilestoneEvidence(evidence, k)) return;
    perform({
      type: 'request',
      data: {
        requestId: crypto.randomUUID(),
        milestoneId: sourceId,
        expectedPolicyId: selectedPolicy.id,
        ownerUserId: ownerId,
        ownerRole,
        evidence,
        reason: requestReason.trim(),
      },
    });
  };
  const decide = () => {
    if (
      !canDecide ||
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
  return (
    <div className="space-y-3">
      <button type="button" disabled={busy || !!pending} onClick={load}>
        Load milestone billing reviews
      </button>
      <button
        type="button"
        disabled={busy || !!pending}
        onClick={() =>
          void run(async (c) => {
            const result = await milestoneBilling.register(engagementId, c);
            setRegister(result.items);
            setRegisterLimited(!!result.nextAfter);
          })
        }
      >
        Load milestone register
      </button>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div>
          <p>
            Original {pending.type} request {pending.data.requestId} may still be in flight; no write is
            retried automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original milestone receipt
          </button>
        </div>
      )}
      {register && (
        <section aria-label="Milestone approved-unbilled register">
          <h3>Milestone approved-unbilled register</h3>
          {registerLimited && <p role="status">Only the first 50 visible items are shown.</p>}
          <p>Batch preparation for these items is not yet available.</p>
          <ul>
            {register.map((x) => (
              <li key={x.id}>
                {x.currency} {x.amount} · event {x.eventId} · decision {x.decisionId} · item {x.id}
              </li>
            ))}
          </ul>
        </section>
      )}
      {loaded && (
        <>
          {limited && (
            <p role="status">
              Only the first page is shown; additional records are not yet available in this workspace.
            </p>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending || limited}>
              <legend>Prospective milestone review policy</legend>
              <label>
                Effective from UTC{' '}
                <input
                  type="date"
                  aria-label="Milestone policy effective from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Locale{' '}
                <input
                  aria-label="Milestone policy locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                />
              </label>
              <label>
                Completion in-app{' '}
                <select
                  aria-label="Milestone completion in-app"
                  value={completion}
                  onChange={(e) => setCompletion(e.target.value)}
                >
                  <option value="">Choose</option>
                  <option value="yes">Enabled subject to preference</option>
                  <option value="no">Suppressed by policy</option>
                </select>
              </label>
              {kinds.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={required.includes(kind)}
                    onChange={(e) =>
                      setRequired((old) =>
                        e.target.checked ? [...old, kind] : old.filter((x) => x !== kind),
                      )
                    }
                  />
                  {kind}
                </label>
              ))}
              {stages.map((stage, i) => (
                <div key={i}>
                  <label>
                    Approver user ID{' '}
                    <input
                      aria-label={`Milestone stage ${i + 1} user ID`}
                      value={stage.userId}
                      onChange={(e) =>
                        setStages((x) => x.map((v, n) => (n === i ? { ...v, userId: e.target.value } : v)))
                      }
                    />
                  </label>
                  <label>
                    Approver role{' '}
                    <input
                      aria-label={`Milestone stage ${i + 1} role`}
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
                Add milestone stage
              </button>
              {templates.map((t, i) => (
                <div key={t.key}>
                  <p>{t.key}</p>
                  <label>
                    Subject{' '}
                    <input
                      aria-label={`${t.key} milestone subject`}
                      value={t.subject}
                      onChange={(e) =>
                        setTemplates((x) =>
                          x.map((v, n) => (n === i ? { ...v, subject: e.target.value } : v)),
                        )
                      }
                    />
                  </label>
                  <label>
                    Body{' '}
                    <input
                      aria-label={`${t.key} milestone body`}
                      value={t.body}
                      onChange={(e) =>
                        setTemplates((x) => x.map((v, n) => (n === i ? { ...v, body: e.target.value } : v)))
                      }
                    />
                  </label>
                </div>
              ))}
              <label>
                Policy reason{' '}
                <input
                  aria-label="Milestone policy reason"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={configure}>
                Record milestone review policy
              </button>
            </fieldset>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending}>
              <legend>Request milestone eligibility review</legend>
              <label>
                Milestone{' '}
                <select
                  aria-label="Billing milestone"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                >
                  <option value="">Choose a milestone</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.current}>
                      {s.name} · {s.currency} {s.amount} · {s.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Review policy{' '}
                <select
                  aria-label="Milestone review policy"
                  value={policyId}
                  onChange={(e) => {
                    setPolicyId(e.target.value);
                    setReferences({});
                  }}
                >
                  <option value="">Choose an explicit policy</option>
                  {policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.effectiveFrom} · version {p.sequence}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Change owner user ID{' '}
                <input
                  aria-label="Milestone change owner user ID"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                />
              </label>
              <label>
                Change owner role{' '}
                <input
                  aria-label="Milestone change owner role"
                  value={ownerRole}
                  onChange={(e) => setOwnerRole(e.target.value)}
                />
              </label>
              {selectedPolicy &&
                (selectedPolicy.definition as { evidenceKinds: string[] }).evidenceKinds.map((kind) => (
                  <div key={kind}>
                    <label>
                      {kind} reference{' '}
                      <input
                        aria-label={`${kind} reference`}
                        value={references[kind]?.reference ?? ''}
                        onChange={(e) =>
                          setReferences((v) => ({
                            ...v,
                            [kind]: { reference: e.target.value, url: v[kind]?.url ?? '' },
                          }))
                        }
                      />
                    </label>
                    <label>
                      {kind} HTTPS evidence URL{' '}
                      <input
                        aria-label={`${kind} URL`}
                        value={references[kind]?.url ?? ''}
                        onChange={(e) =>
                          setReferences((v) => ({
                            ...v,
                            [kind]: { reference: v[kind]?.reference ?? '', url: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>
                ))}
              <label>
                Request reason{' '}
                <input
                  aria-label="Milestone request reason"
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={request}>
                Request milestone billing review
              </button>
            </fieldset>
          )}
          <label>
            Retained review{' '}
            <select
              aria-label="Milestone billing review"
              disabled={busy || !!pending}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setInspected(null);
              }}
            >
              <option value="">Choose a review</option>
              {approvals.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.state.status} · {a.id}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !!pending || !selected} onClick={inspect}>
            Inspect milestone review
          </button>
          {inspected && (
            <section aria-label="Inspected milestone review">
              <p>
                Milestone {inspected.source.id} · {inspected.source.currency} {inspected.source.amount} ·
                review {chosen?.state.status} · current {String(chosen?.current)} · owner{' '}
                {chosen?.ownerUserId} ({chosen?.ownerRole}).
              </p>
              <ul>
                {chosen?.evidence.map((e) => (
                  <li key={e.kind}>
                    {e.kind}: {e.reference} · {e.url}
                  </li>
                ))}
              </ul>
              {canDecide && chosen?.current && chosen.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Decide the inspected stage</legend>
                  <label>
                    Decision{' '}
                    <select
                      aria-label="Milestone billing decision"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="">Choose</option>
                      <option>Approved</option>
                      <option>Rejected</option>
                    </select>
                  </label>
                  <label>
                    Decision reason{' '}
                    <input
                      aria-label="Milestone decision reason"
                      value={decisionReason}
                      onChange={(e) => setDecisionReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={decide}>
                    Record milestone decision
                  </button>
                </fieldset>
              )}
              {canManage && chosen?.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Invalidate pending review</legend>
                  <label>
                    Cancellation reason{' '}
                    <input
                      aria-label="Milestone cancellation reason"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (chosen && cancelReason.trim().length >= 3)
                        perform({
                          type: 'cancellation',
                          id: chosen.id,
                          data: { requestId: crypto.randomUUID(), reason: cancelReason.trim() },
                        });
                    }}
                  >
                    Cancel milestone review
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
