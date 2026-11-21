import { useEffect, useRef, useState } from 'react';
import { validCommercialCandidatePolicy } from '../../shared/commercial-candidate-approval.mjs';
import { ApiClientError } from '../services/apiClient';
import { candidateOwnerService, type RateKind } from '../services/rateCandidates';
import {
  captureRateContext,
  commercialCandidateApprovals,
  type ApprovalOperation,
  type CommercialApproval,
  type CommercialPolicy,
} from '../services/commercialCandidateApprovals';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';

type Owner = Awaited<ReturnType<typeof candidateOwnerService.inspect>>['current'];
type Template = { key: string; subject: string; body: string };
const events = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
export const CommercialCandidateApproval = ({
  candidateId,
  kind,
  onClose,
}: {
  candidateId: string;
  kind: RateKind;
  onClose: () => void;
  key?: string;
}) => {
  const [owner, setOwner] = useState<Owner | undefined>(),
    [policies, setPolicies] = useState<CommercialPolicy[]>([]),
    [effectivePolicy, setEffectivePolicy] = useState<CommercialPolicy | null>(null),
    [approvals, setApprovals] = useState<CommercialApproval[]>([]),
    [truncated, setTruncated] = useState(false),
    [selected, setSelected] = useState(''),
    [policyId, setPolicyId] = useState(''),
    [from, setFrom] = useState(''),
    [locale, setLocale] = useState(''),
    [completion, setCompletion] = useState(''),
    [stages, setStages] = useState([{ userId: '', role: '' }]),
    [templates, setTemplates] = useState<Template[]>(events.map((key) => ({ key, subject: '', body: '' }))),
    [policyReason, setPolicyReason] = useState(''),
    [requestReason, setRequestReason] = useState(''),
    [decision, setDecision] = useState(''),
    [decisionReason, setDecisionReason] = useState(''),
    [cancelReason, setCancelReason] = useState(''),
    [pending, setPending] = useState<ApprovalOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null);
  const reset = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setOwner(undefined);
    setPolicies([]);
    setEffectivePolicy(null);
    setApprovals([]);
    setSelected('');
    setPolicyId('');
    setFrom('');
    setLocale('');
    setCompletion('');
    setStages([{ userId: '', role: '' }]);
    setTemplates(events.map((key) => ({ key, subject: '', body: '' })));
    setPolicyReason('');
    setRequestReason('');
    setDecision('');
    setDecisionReason('');
    setCancelReason('');
    setPending(null);
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => reset('Account, role or scope changed. Unsent approval inputs were cleared.');
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
  }, [candidateId, kind]);
  const run = async (fn: (c: RateContext) => Promise<void>) => {
    if (inFlight.current) return;
    if (context.current && !isRateContextCurrent(context.current)) {
      reset('Account, role or scope changed. Reload.');
      return;
    }
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      reset('An active session and selected scope are required.');
      return;
    }
    context.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c);
    } catch {
      if (mounted.current && n === generation.current)
        setNotice(
          'The operation could not be confirmed. Read its original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && n === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const selectReview = (id: string) => {
    setSelected(id);
    setDecision('');
    setDecisionReason('');
    setCancelReason('');
  };
  const load = () =>
    void run(async (c) => {
      selectReview('');
      setOwner(undefined);
      const [o, v] = await Promise.all([
        candidateOwnerService.inspect(candidateId, kind, c),
        commercialCandidateApprovals.load(candidateId, kind, c),
      ]);
      setOwner(o.current);
      setPolicies(v.policies);
      setEffectivePolicy(v.effectivePolicy);
      setApprovals(v.approvals);
      setTruncated(v.truncated);
      setPolicyId('');
    });
  const perform = (op: ApprovalOperation) => {
    if (pending) return;
    void run(async (c) => {
      setPending(op);
      try {
        await commercialCandidateApprovals.run(op, candidateId, kind, c);
        setPending(null);
        setOwner(undefined);
        setPolicies([]);
        setEffectivePolicy(null);
        setApprovals([]);
        setSelected('');
        setPolicyId('');
        setNotice('Operation recorded. Reload the current source before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setOwner(undefined);
          setPolicies([]);
          setEffectivePolicy(null);
          setApprovals([]);
          setSelected('');
          setNotice(e.code === 'COMMERCIAL_APPROVAL_STAGE_CHANGED'
            ? 'The review stage changed. Reload and select the current review before cancelling.'
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
      await commercialCandidateApprovals.run(pending, candidateId, kind, c, true);
      setPending(null);
      setOwner(undefined);
      setPolicies([]);
      setEffectivePolicy(null);
      setApprovals([]);
      setSelected('');
      setNotice('The original request was confirmed by read-only receipt. Reload.');
    });
  };
  const canManage =
    hasRatePermission(
      kind === 'billing' ? 'commercial.rate_candidates.manage' : 'commercial.cost_candidates.manage',
    ) &&
    (kind !== 'billing' || hasRatePermission('commercial.contracts.manage'));
  const canDecide = [
    kind === 'billing' ? 'commercial.rate_approvals.decide' : 'commercial.cost_approvals.decide',
    'employees.view',
    'notifications.view',
    'approvals.view',
  ].every(hasRatePermission);
  const chosen = approvals.find((x) => x.id === selected),
    makePolicy = () => {
      const definition = {
        entityType: 'CommercialCandidate',
        kind,
        candidateId,
        stages,
        locale,
        templates,
        completionInApp: completion === 'yes',
      };
      if (
        !from ||
        !['yes', 'no'].includes(completion) ||
        policyReason.trim().length < 3 ||
        !validCommercialCandidatePolicy(definition)
      )
        return;
      perform({
        type: 'policy',
        data: {
          requestId: crypto.randomUUID(),
          expectedLatestId: policies[0]?.id ?? null,
          effectiveFrom: from,
          definition,
          reason: policyReason.trim(),
        },
      });
    };
  const makeRequest = () => {
    if (!owner?.eligible || !policyId || effectivePolicy?.id !== policyId || requestReason.trim().length < 3)
      return;
    perform({
      type: 'request',
      data: {
        requestId: crypto.randomUUID(),
        candidateId,
        expectedOwnerEventId: owner.id,
        expectedPolicyId: policyId,
        reason: requestReason.trim(),
      },
    });
  };
  const makeDecision = () => {
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
        expectedCandidateId: candidateId,
        expectedOwnerEventId: chosen.ownerEventId,
        expectedPolicyId: chosen.policy.id,
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
    <section aria-label="Commercial candidate approval" className="my-3 space-y-3 rounded border p-3">
      <h3>Commercial candidate approval</h3>
      <p>
        Explicit named stages review this candidate. Approval evidence does not activate a rate or create
        invoice authority. Owner and approver access are checked separately.
      </p>
      <button type="button" onClick={onClose} disabled={busy || !!pending}>
        Close commercial approval
      </button>
      <button type="button" onClick={load} disabled={busy || !!pending}>
        Load approval and owner
      </button>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div>
          <p>
            Original {pending.type} request {pending.data.requestId} may still be in flight. No write is
            retried automatically.
          </p>
          <button type="button" onClick={reconcile} disabled={busy}>
            Read original approval receipt
          </button>
        </div>
      )}
      {owner !== undefined && (
        <>
          <p>
            {owner
              ? `Owner ${owner.ownerUserId} · ${owner.ownerRole} · version ${owner.sequence} · ${owner.eligible ? 'source eligible' : 'unavailable'}.`
              : 'No explicit owner is assigned.'}{' '}
            The approval path also requires the existing inbox access.
          </p>
          {truncated && <p>Recent history shows up to ten policies and ten requests.</p>}
          {policies.length > 0 && (
            <details>
              <summary>Recent approval policies</summary>
              <ul>
                {policies.map((p) => (
                  <li key={p.id}>
                    Version {p.sequence} · effective {p.effectiveFrom} UTC
                  </li>
                ))}
              </ul>
            </details>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending}>
              <legend>Configure named stages</legend>
              <label>
                Policy effective date UTC
                <input
                  aria-label="Policy effective date UTC"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Template locale
                <input
                  aria-label="Template locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                />
              </label>
              <label>
                Completion in-app preference
                <select
                  aria-label="Completion in-app preference"
                  value={completion}
                  onChange={(e) => setCompletion(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  <option value="yes">Enabled subject to preference</option>
                  <option value="no">Suppressed</option>
                </select>
              </label>
              {stages.map((stage, index) => (
                <div key={index}>
                  <label>
                    Approver account {index + 1}
                    <input
                      aria-label={`Approver account ${index + 1}`}
                      value={stage.userId}
                      onChange={(e) =>
                        setStages((v) =>
                          v.map((x, i) => (i === index ? { ...x, userId: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label>
                    Approver role {index + 1}
                    <input
                      aria-label={`Approver role ${index + 1}`}
                      value={stage.role}
                      onChange={(e) =>
                        setStages((v) => v.map((x, i) => (i === index ? { ...x, role: e.target.value } : x)))
                      }
                    />
                  </label>
                  {stages.length > 1 && (
                    <button type="button" onClick={() => setStages((v) => v.filter((_, i) => i !== index))}>
                      Remove stage {index + 1}
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                disabled={stages.length >= 10}
                onClick={() => setStages((v) => [...v, { userId: '', role: '' }])}
              >
                Add approval stage
              </button>
              {templates.map((t, index) => (
                <div key={t.key}>
                  <h4>{t.key}</h4>
                  <label>
                    Subject {t.key}
                    <input
                      aria-label={`Subject ${t.key}`}
                      value={t.subject}
                      onChange={(e) =>
                        setTemplates((v) =>
                          v.map((x, i) => (i === index ? { ...x, subject: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label>
                    Body {t.key}
                    <textarea
                      aria-label={`Body ${t.key}`}
                      value={t.body}
                      onChange={(e) =>
                        setTemplates((v) =>
                          v.map((x, i) => (i === index ? { ...x, body: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              <p>
                Templates may use {'{{sourceRef}}'} and {'{{stageNumber}}'}; never include confidential values
                or decision reasons.
              </p>
              <label>
                Policy reason
                <input
                  aria-label="Policy reason"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={makePolicy}>
                Record approval policy
              </button>
            </fieldset>
          )}
          {canManage && (
            <fieldset disabled={busy || !!pending}>
              <legend>Request review</legend>
              <label>
                Approval policy
                <select
                  aria-label="Approval policy"
                  value={policyId}
                  onChange={(e) => setPolicyId(e.target.value)}
                >
                  <option value="">
                    {effectivePolicy
                      ? 'Select the effective policy'
                      : 'No approval policy is effective today'}
                  </option>
                  {effectivePolicy && (
                    <option value={effectivePolicy.id}>
                      Version {effectivePolicy.sequence} · effective {effectivePolicy.effectiveFrom}
                    </option>
                  )}
                </select>
              </label>
              <label>
                Request reason
                <input
                  aria-label="Approval request reason"
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={makeRequest}
                disabled={
                  !owner?.eligible ||
                  !policyId ||
                  effectivePolicy?.id !== policyId ||
                  requestReason.trim().length < 3
                }
              >
                Request candidate approval
              </button>
            </fieldset>
          )}
          <label>
            Approval request
            <select
              aria-label="Approval request"
              value={selected}
              disabled={busy || !!pending}
              onChange={(e) => selectReview(e.target.value)}
            >
              <option value="">Choose a retained request</option>
              {approvals.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {a.state.status} · {a.current ? 'current' : 'stale or closed'}
                </option>
              ))}
            </select>
          </label>
          {chosen && (
            <>
              <p>
                Request {chosen.id} · {chosen.state.status} · stage sequence {chosen.state.sequence} · owner
                version {chosen.ownerEventId} · {chosen.current ? 'current' : 'stale or closed'}
              </p>
              <ul>
                {chosen.transitions.map((t) => (
                  <li key={t.id}>
                    {t.sequence}: {t.decision} by {t.actorId} as {t.activeRole} · {t.reason}
                  </li>
                ))}
              </ul>
              {canDecide && chosen.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending || !chosen.current}>
                  <legend>Current named-stage decision</legend>
                  <label>
                    Decision
                    <select
                      aria-label="Commercial decision"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="">Choose a decision</option>
                      <option value="Approved">Approve</option>
                      <option value="Rejected">Reject</option>
                    </select>
                  </label>
                  <label>
                    Decision reason
                    <input
                      aria-label="Commercial decision reason"
                      value={decisionReason}
                      onChange={(e) => setDecisionReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={makeDecision}
                    disabled={!decision || decisionReason.trim().length < 3}
                  >
                    Record commercial decision
                  </button>
                </fieldset>
              )}
              {canManage && chosen.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Cancel pending review</legend>
                  <label>
                    Cancellation reason
                    <input
                      aria-label="Commercial cancellation reason"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={cancel} disabled={cancelReason.trim().length < 3}>
                    Cancel commercial review
                  </button>
                </fieldset>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
};
