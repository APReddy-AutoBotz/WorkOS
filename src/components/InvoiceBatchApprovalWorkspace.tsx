import { useEffect, useRef, useState } from 'react';
import { validInvoiceBatchApprovalPolicy } from '../../shared/invoice-batch-approval.mjs';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  invoiceBatchApprovals,
  type InvoiceBatchPolicy,
  type InvoiceBatchApproval,
  type InvoiceApprovalSource,
  type InvoiceApprovalOperation,
} from '../services/invoiceBatchApprovals';
import { invoiceDrafts, type InvoiceDraft } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Choice = { id: string; label: string };
type Template = { key: string; subject: string; body: string };
const events = ['approval.action_required', 'approval.rejected_or_correction_required', 'approval.completed'];
export const InvoiceBatchApprovalWorkspace = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [locked, setLocked] = useState(false);
  const canRead = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'employees.view',
    'notifications.view',
  ].every(hasRatePermission);
  return (
    <section aria-label="Invoice batch approvals" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Invoice batch approvals</h2>
      <p>
        Inspect the retained whole-item lineage and control total before submitting a Draft or deciding its
        current stage.
      </p>
      {!canRead ? (
        <p role="status">Scoped invoice draft and billing access are required.</p>
      ) : (
        <>
          <label>
            Invoice approval engagement
            <select
              aria-label="Invoice approval engagement"
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
            <InvoiceApprovalEngagement key={engagement} engagementId={engagement} onLockChange={setLocked} />
          )}
        </>
      )}
    </section>
  );
};
const InvoiceApprovalEngagement = ({
  engagementId,
  onLockChange,
}: {
  engagementId: string;
  onLockChange: (v: boolean) => void;
  key?: string;
}) => {
  const [policies, setPolicies] = useState<InvoiceBatchPolicy[]>([]),
    [drafts, setDrafts] = useState<InvoiceDraft[]>([]),
    [approvals, setApprovals] = useState<InvoiceBatchApproval[]>([]),
    [draftNext, setDraftNext] = useState<string | null>(null),
    [approvalNext, setApprovalNext] = useState<string | null>(null),
    [policyTruncated, setPolicyTruncated] = useState(false),
    [loaded, setLoaded] = useState(false),
    [batchId, setBatchId] = useState(''),
    [source, setSource] = useState<InvoiceApprovalSource | null>(null),
    [policyId, setPolicyId] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [requestReason, setRequestReason] = useState(''),
    [selected, setSelected] = useState(''),
    [inspected, setInspected] = useState<{
      approval: InvoiceBatchApproval;
      batch: InvoiceApprovalSource;
    } | null>(null),
    [decision, setDecision] = useState(''),
    [decisionReason, setDecisionReason] = useState(''),
    [withdrawReason, setWithdrawReason] = useState('');
  const [from, setFrom] = useState(''),
    [locale, setLocale] = useState(''),
    [completion, setCompletion] = useState(''),
    [stages, setStages] = useState([{ userId: '', role: '' }]),
    [templates, setTemplates] = useState<Template[]>(events.map((key) => ({ key, subject: '', body: '' }))),
    [policyReason, setPolicyReason] = useState(''),
    [pending, setPending] = useState<InvoiceApprovalOperation | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null);
  useEffect(() => {
    onLockChange(busy || !!pending);
    return () => onLockChange(false);
  }, [busy, pending, onLockChange]);
  const clear = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setPolicies([]);
    setDrafts([]);
    setApprovals([]);
    setDraftNext(null);
    setApprovalNext(null);
    setPolicyTruncated(false);
    setLoaded(false);
    setBatchId('');
    setSource(null);
    setPolicyId('');
    setConfirmed(false);
    setRequestReason('');
    setSelected('');
    setInspected(null);
    setDecision('');
    setDecisionReason('');
    setWithdrawReason('');
    setFrom('');
    setLocale('');
    setCompletion('');
    setStages([{ userId: '', role: '' }]);
    setTemplates(events.map((key) => ({ key, subject: '', body: '' })));
    setPolicyReason('');
    setPending(null);
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () => clear('Account, role or scope changed. Unsent invoice approval inputs were cleared.');
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
      const [a, b] = await Promise.all([invoiceBatchApprovals.load(engagementId, c), invoiceDrafts.list(c)]);
      setPolicies(a.policies);
      setApprovals(a.approvals);
      setPolicyTruncated(a.policiesTruncated);
      setApprovalNext(a.approvalsNext);
      setDrafts(b.batches);
      setDraftNext(b.nextAfter);
      setLoaded(true);
      setBatchId('');
      setSource(null);
      setSelected('');
      setInspected(null);
      setConfirmed(false);
    });
  const moreDrafts = () => {
    if (draftNext)
      void run(async (c) => {
        const x = await invoiceDrafts.list(c, draftNext);
        setDrafts((old) => [...old, ...x.batches]);
        setDraftNext(x.nextAfter);
      });
  };
  const moreApprovals = () => {
    if (approvalNext)
      void run(async (c) => {
        const x = await invoiceBatchApprovals.page(engagementId, approvalNext, c);
        setApprovals((old) => [...old, ...x.approvals]);
        setApprovalNext(x.nextAfter);
      });
  };
  const inspectSource = () => {
    if (batchId)
      void run(async (c) => {
        const x = await invoiceBatchApprovals.source(batchId, c);
        if (x.engagementId !== engagementId) throw Error('Engagement changed');
        setSource(x);
        setConfirmed(false);
      });
  };
  const inspect = () => {
    if (selected)
      void run(async (c) => {
        const x = await invoiceBatchApprovals.inspect(selected, c);
        if (x.batch.engagementId !== engagementId) throw Error('Engagement changed');
        setInspected({ approval: x.approval, batch: x.batch });
      });
  };
  const perform = (op: InvoiceApprovalOperation) => {
    if (pending) return;
    void run(async (c) => {
      setPending(op);
      try {
        await invoiceBatchApprovals.run(op, engagementId, c);
        setPending(null);
        setLoaded(false);
        setPolicies([]);
        setDrafts([]);
        setApprovals([]);
        setSource(null);
        setInspected(null);
        setNotice('Operation recorded. Reload the current batch and reviews before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setLoaded(false);
          setSource(null);
          setInspected(null);
          setNotice('The operation was refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (pending)
      void run(async (c) => {
        await invoiceBatchApprovals.run(pending, engagementId, c, true);
        setPending(null);
        setLoaded(false);
        setSource(null);
        setInspected(null);
        setNotice('The original request was confirmed by a read-only receipt. Reload.');
      });
  };
  const canConfigure = ['commercial.contracts.manage', 'commercial.invoice_approval.manage'].every(
      hasRatePermission,
    ),
    canSubmit = ['commercial.invoice_drafts.prepare', 'commercial.invoice_approval.manage'].every(
      hasRatePermission,
    ),
    canDecide = ['approvals.view', 'commercial.invoice_approval.decide'].every(hasRatePermission),
    chosen = inspected?.approval;
  const configure = () => {
    const definition = {
      entityType: 'InvoiceBatch',
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
      !validInvoiceBatchApprovalPolicy(definition)
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
    if (
      !source ||
      source.id !== batchId ||
      source.state !== 'Draft' ||
      !source.current ||
      !source.lineCount ||
      !confirmed ||
      !policyId ||
      requestReason.trim().length < 3
    )
      return;
    perform({
      type: 'request',
      data: {
        requestId: crypto.randomUUID(),
        batchId,
        expectedPolicyId: policyId,
        expectedLineCount: source.lineCount,
        expectedLineageHash: source.lineageHash,
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
  const withdraw = () => {
    if (chosen && chosen.state.status === 'Pending' && withdrawReason.trim().length >= 3)
      perform({
        type: 'withdrawal',
        id: chosen.id,
        data: { requestId: crypto.randomUUID(), reason: withdrawReason.trim() },
      });
  };
  return (
    <div className="space-y-3">
      <button type="button" disabled={busy || !!pending} onClick={load}>
        Load invoice batches and reviews
      </button>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div>
          <p>
            Original {pending.type} request {pending.data.requestId} may still be in flight; no write is
            retried automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original invoice approval receipt
          </button>
        </div>
      )}
      {loaded && (
        <>
          {policyTruncated && <p>Only the latest 20 policies are displayed.</p>}
          {canConfigure && (
            <fieldset disabled={busy || !!pending || policyTruncated}>
              <legend>Prospective invoice approval policy</legend>
              <label>
                Effective from UTC
                <input
                  type="date"
                  aria-label="Invoice approval policy effective from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Locale
                <input
                  aria-label="Invoice approval policy locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                />
              </label>
              <label>
                Completion in-app
                <select
                  aria-label="Invoice approval completion in-app"
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
                      aria-label={`Invoice approval stage ${i + 1} user ID`}
                      value={stage.userId}
                      onChange={(e) =>
                        setStages((x) => x.map((v, n) => (n === i ? { ...v, userId: e.target.value } : v)))
                      }
                    />
                  </label>
                  <label>
                    Approver held role
                    <input
                      aria-label={`Invoice approval stage ${i + 1} role`}
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
                Add invoice approval stage
              </button>
              {stages.length > 1 && (
                <button type="button" onClick={() => setStages((x) => x.slice(0, -1))}>
                  Remove last invoice approval stage
                </button>
              )}
              {templates.map((t, i) => (
                <div key={t.key}>
                  <p>{t.key}</p>
                  <label>
                    Subject
                    <input
                      aria-label={`${t.key} invoice approval subject`}
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
                      aria-label={`${t.key} invoice approval body`}
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
                  aria-label="Invoice approval policy reason"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={configure}>
                Record invoice approval policy
              </button>
            </fieldset>
          )}
          {canSubmit && (
            <fieldset disabled={busy || !!pending}>
              <legend>Submit an inspected invoice Draft</legend>
              <label>
                Draft
                <select
                  aria-label="Invoice approval Draft"
                  value={batchId}
                  onChange={(e) => {
                    setBatchId(e.target.value);
                    setSource(null);
                    setConfirmed(false);
                  }}
                >
                  <option value="">Choose a Draft</option>
                  {drafts
                    .filter((x) => x.engagementId === engagementId && x.state === 'Draft')
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.id} · {x.currency}
                      </option>
                    ))}
                </select>
              </label>
              {draftNext && (
                <button type="button" onClick={moreDrafts}>
                  More invoice Drafts
                </button>
              )}
              <button type="button" disabled={!batchId} onClick={inspectSource}>
                Inspect invoice Draft source
              </button>
              {source && (
                <section aria-label="Inspected invoice Draft source">
                  <p>
                    {source.lineCount} retained lines · {source.currency} {source.total} · current{' '}
                    {String(source.current)} · client {source.clientId} · contract {source.contractId} ·{' '}
                    {source.periodStart}–{source.periodEnd} by {source.periodBasis}.
                  </p>
                  <ul>
                    {source.lines.map((x) => (
                      <li key={x.id}>
                        Item {x.itemId} version {x.itemVersion} · event {x.eventId} ·{' '}
                        {'sourceType' in x
                          ? `milestone ${x.evidence.milestoneId}`
                          : `snapshot ${x.snapshotId}`}{' '}
                        · {x.currency} {x.amount}
                      </li>
                    ))}
                  </ul>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I inspected the retained lineage and control total
                  </label>
                </section>
              )}
              <label>
                Review policy
                <select
                  aria-label="Invoice batch review policy"
                  value={policyId}
                  onChange={(e) => setPolicyId(e.target.value)}
                >
                  <option value="">Choose a policy</option>
                  {policies.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.effectiveFrom} · version {x.sequence}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Request reason
                <input
                  aria-label="Invoice approval request reason"
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={request}>
                Submit invoice Draft for review
              </button>
            </fieldset>
          )}
          <label>
            Retained review
            <select
              aria-label="Invoice batch review"
              disabled={busy || !!pending}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setInspected(null);
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
            <button type="button" disabled={busy || !!pending} onClick={moreApprovals}>
              More invoice reviews
            </button>
          )}
          <button type="button" disabled={busy || !!pending || !selected} onClick={inspect}>
            Inspect invoice review
          </button>
          {inspected && (
            <section aria-label="Inspected invoice review">
              <p>
                Batch {inspected.batch.id} · {inspected.batch.lineCount} lines · {inspected.batch.currency}{' '}
                {inspected.batch.total} · {inspected.batch.lineageHash}.
              </p>
              <ul>
                {inspected.batch.lines.map((x) => (
                  <li key={x.id}>
                    Item {x.itemId} · event {x.eventId} ·{' '}
                    {'sourceType' in x ? `milestone ${x.evidence.milestoneId}` : `snapshot ${x.snapshotId}`} ·{' '}
                    {x.currency} {x.amount}
                  </li>
                ))}
              </ul>
              <p>
                Review {chosen?.id} · {chosen?.state.status} · current {String(chosen?.current)} · owner{' '}
                {chosen?.ownerUserId} · preparer {chosen?.preparerUserId}.
              </p>
              {canDecide && chosen?.current && chosen.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Decide the inspected stage</legend>
                  <label>
                    Decision
                    <select
                      aria-label="Invoice approval decision"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="">Choose</option>
                      <option>Approved</option>
                      <option>Rejected</option>
                    </select>
                  </label>
                  <label>
                    Reason
                    <input
                      aria-label="Invoice approval decision reason"
                      value={decisionReason}
                      onChange={(e) => setDecisionReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={decide}>
                    Record invoice approval decision
                  </button>
                </fieldset>
              )}
              {canSubmit && chosen?.state.status === 'Pending' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Withdraw pending review</legend>
                  <label>
                    Reason
                    <input
                      aria-label="Invoice approval withdrawal reason"
                      value={withdrawReason}
                      onChange={(e) => setWithdrawReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={withdraw}>
                    Withdraw invoice review
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
