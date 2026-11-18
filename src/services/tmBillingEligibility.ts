import { z } from 'zod';
import { validTmEligibilityPolicy, tmEligibilityState } from '../../shared/tm-billing-eligibility.mjs';
import { canonicalHours } from '../../shared/work-hours.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const def = z.unknown().refine(validTmEligibilityPolicy),
  reference = z
    .object({
      entityType: z.enum(['Project', 'Engagement', 'Contract']),
      entityId: id,
      lifecycleEventId: id,
      contractVersionId: id,
    })
    .strict();
const evidence = z
  .object({
    snapshotId: uuid,
    engagementId: id,
    policyId: uuid,
    submissionId: id,
    decisionId: id,
    entryId: uuid,
    billingAdoptionId: uuid,
    projectId: id,
    bindingId: id,
    workDate: date,
    references: z.array(reference).length(3),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
  })
  .strict()
  .refine(
    (v) =>
      /[1-9]/.test(v.amount) &&
      new Set(v.references.map((x) => x.entityType)).size === 3 &&
      v.references.find((x) => x.entityType === 'Project')?.entityId === v.projectId &&
      v.references.find((x) => x.entityType === 'Engagement')?.entityId === v.engagementId &&
      new Set(v.references.map((x) => x.contractVersionId)).size === 1,
  );
const policy = z
  .object({
    id: uuid,
    engagementId: id,
    sequence: z.number().int().positive(),
    previousId: uuid.nullable(),
    effectiveFrom: date,
    definition: def,
    actorId: uuid,
    activeRole: id,
    reason,
    requestId: uuid,
    createdAt: instant,
  })
  .strict()
  .refine((v) => (v.sequence === 1 ? v.previousId === null : v.previousId !== null));
const transition = z
  .object({
    id: uuid,
    sequence: z.number().int().min(1).max(10),
    stage: z.number().int().min(0).max(9),
    decision: z.enum(['Approved', 'Rejected']),
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const cancellation = z
  .object({ id: uuid, actorId: uuid, activeRole: id, requestId: uuid, reason, createdAt: instant })
  .strict();
const approval = z
  .object({
    id: uuid,
    snapshotId: uuid,
    engagementId: id,
    ownerUserId: uuid,
    ownerRole: id,
    requesterUserId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    createdAt: instant,
    policy,
    state: z
      .object({
        status: z.enum(['Pending', 'Approved', 'Rejected', 'Cancelled']),
        sequence: z.number().int().min(0).max(10),
        currentStage: z.number().int().min(0).max(9).nullable(),
      })
      .strict(),
    current: z.boolean(),
    transitions: z.array(transition).max(10),
    cancellation: cancellation.nullable(),
  })
  .strict()
  .refine((v) => {
    try {
      const d = v.policy.definition as {
          engagementId: string;
          stages: Array<{ userId: string; role: string }>;
        },
        state = tmEligibilityState(d, v.transitions);
      return (
        d.engagementId === v.engagementId &&
        v.policy.engagementId === v.engagementId &&
        v.transitions.every(
          (t) =>
            d.stages[t.stage]?.userId === t.actorId &&
            d.stages[t.stage]?.role === t.activeRole &&
            t.actorId !== v.requesterUserId,
        ) &&
        v.state.sequence === state.sequence &&
        (v.cancellation
          ? v.state.status === 'Cancelled' && v.state.currentStage === null && !v.current
          : v.state.status === state.status && v.state.currentStage === state.currentStage)
      );
    } catch {
      return false;
    }
  });
const envelope = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  actorUserId: uuid,
  activeRole: id,
  organizationId: id,
  legalEntityId: id,
  serverDate: date,
};
export type TmBillingPolicy = z.infer<typeof policy>;
export type TmBillingApproval = z.infer<typeof approval>;
export type TmBillingEvidence = z.infer<typeof evidence>;
export type TmBillingOperation =
  | {
      type: 'policy';
      data: {
        requestId: string;
        engagementId: string;
        expectedLatestId: string | null;
        effectiveFrom: string;
        definition: unknown;
        reason: string;
      };
    }
  | {
      type: 'request';
      data: {
        requestId: string;
        snapshotId: string;
        expectedPolicyId: string;
        ownerUserId: string;
        ownerRole: string;
        reason: string;
      };
    }
  | {
      type: 'decision';
      id: string;
      data: {
        requestId: string;
        expectedSequence: number;
        decision: 'Approved' | 'Rejected';
        reason: string;
      };
    }
  | { type: 'cancellation'; id: string; data: { requestId: string; reason: string } };
const operation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('policy'),
      data: z
        .object({
          requestId: uuid,
          engagementId: id,
          expectedLatestId: uuid.nullable(),
          effectiveFrom: date,
          definition: def,
          reason,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      data: z
        .object({
          requestId: uuid,
          snapshotId: uuid,
          expectedPolicyId: uuid,
          ownerUserId: uuid,
          ownerRole: id,
          reason,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('decision'),
      id: uuid,
      data: z
        .object({
          requestId: uuid,
          expectedSequence: z.number().int().min(0).max(9),
          decision: z.enum(['Approved', 'Rejected']),
          reason,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cancellation'),
      id: uuid,
      data: z.object({ requestId: uuid, reason }).strict(),
    })
    .strict(),
]);
const bad = (): never => {
  throw new ApiClientError('Billing response could not be confirmed. Read the original receipt.', {
    status: 503,
  });
};
const current = (c: RateContext | null, mode: 'read' | 'manage' | 'decide') => {
  const keys = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'employees.view',
    'notifications.view',
    ...(mode === 'manage' ? ['commercial.contracts.manage', 'commercial.tm_billing.manage'] : []),
    ...(mode === 'decide' ? ['approvals.view', 'commercial.tm_billing.decide'] : []),
  ];
  if (!c || !isRateContextCurrent(c) || !keys.every(hasRatePermission))
    throw new ApiClientError('Current billing scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  mode: 'read' | 'manage' | 'decide',
  body?: object,
) => {
  const ctx = current(c, mode),
    ownerKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  current(ctx, mode);
  const raw = await api.requestWithContext<unknown>(
    method,
    '/api/v1/tm-billing-eligibility' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, mode);
  const v = z.object(envelope).passthrough().safeParse(raw);
  if (
    !v.success ||
    v.data.ownerKey !== ownerKey ||
    v.data.organizationId !== ctx.scope.organizationId ||
    v.data.legalEntityId !== ctx.scope.legalEntityId ||
    v.data.activeRole !== ctx.activeRole ||
    (uuid.safeParse(ctx.ownerIdentity[1]).success && v.data.actorUserId !== ctx.ownerIdentity[1])
  )
    return bad();
  return v.data;
};
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export { captureRateContext };
export const tmBillingEligibility = {
  load: async (engagementId: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success) return bad();
    const query = '?' + new URLSearchParams({ engagementId }),
      [a, b, d] = await Promise.all([
        call('GET', '/policies' + query, c, 'read'),
        call('GET', '/sources' + query, c, 'read'),
        call('GET', '/instances' + query, c, 'read'),
      ]);
    const p = z
        .object({ ...envelope, policies: z.array(policy).max(20), truncated: z.boolean() })
        .strict()
        .safeParse(a),
      s = z
        .object({ ...envelope, sources: z.array(evidence).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(b),
      i = z
        .object({ ...envelope, approvals: z.array(approval).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(d);
    if (
      !p.success ||
      !s.success ||
      !i.success ||
      p.data.actorUserId !== s.data.actorUserId ||
      p.data.actorUserId !== i.data.actorUserId ||
      p.data.policies.some((x) => x.engagementId !== engagementId) ||
      s.data.sources.some((x) => x.engagementId !== engagementId) ||
      i.data.approvals.some((x) => x.engagementId !== engagementId)
    )
      return bad();
    return {
      policies: p.data.policies,
      sources: s.data.sources,
      approvals: i.data.approvals,
      policiesTruncated: p.data.truncated,
      sourcesNext: s.data.nextAfter,
      approvalsNext: i.data.nextAfter,
    };
  },
  inspect: async (approvalId: string, c: RateContext | null) => {
    if (!uuid.safeParse(approvalId).success) return bad();
    const raw = await call('GET', '/instances/' + approvalId, c, 'read'),
      out = z
        .object({ ...envelope, approval, source: evidence })
        .strict()
        .safeParse(raw);
    if (
      !out.success ||
      out.data.approval.id !== approvalId ||
      out.data.approval.snapshotId !== out.data.source.snapshotId ||
      out.data.approval.engagementId !== out.data.source.engagementId
    )
      return bad();
    return out.data;
  },
  page: async (kind: 'sources' | 'instances', engagementId: string, after: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success || !uuid.safeParse(after).success) return bad();
    const raw = await call('GET', '/' + kind + '?' + new URLSearchParams({ engagementId, after }), c, 'read');
    if (kind === 'sources') {
      const out = z
        .object({ ...envelope, sources: z.array(evidence).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(raw);
      if (!out.success || out.data.sources.some((x) => x.engagementId !== engagementId)) return bad();
      return {
        sources: out.data.sources,
        approvals: [] as TmBillingApproval[],
        nextAfter: out.data.nextAfter,
      };
    }
    const out = z
      .object({ ...envelope, approvals: z.array(approval).max(50), nextAfter: uuid.nullable() })
      .strict()
      .safeParse(raw);
    if (!out.success || out.data.approvals.some((x) => x.engagementId !== engagementId)) return bad();
    return {
      sources: [] as TmBillingEvidence[],
      approvals: out.data.approvals,
      nextAfter: out.data.nextAfter,
    };
  },
  register: async (c: RateContext | null, after?: string) => {
    if (after && !uuid.safeParse(after).success) return bad();
    const raw = await call(
        'GET',
        '/register' + (after ? '?' + new URLSearchParams({ after }) : ''),
        c,
        'read',
      ),
      item = z
        .object({
          id: uuid,
          version: z.literal(1),
          eventId: uuid,
          snapshotId: uuid,
          clientId: id,
          contractId: id,
          engagementId: id,
          eligibleOn: date,
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
          evidence,
          createdAt: instant,
        })
        .strict()
        .refine(
          (x) =>
            x.snapshotId === x.evidence.snapshotId &&
            x.engagementId === x.evidence.engagementId &&
            x.contractId === x.evidence.references.find((r) => r.entityType === 'Contract')?.entityId &&
            x.currency === x.evidence.currency &&
            canonicalHours(x.amount) === canonicalHours(x.evidence.amount),
        ),
      out = z
        .object({ ...envelope, items: z.array(item).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(raw);
    if (!out.success) return bad();
    return out.data;
  },
  run: async (op: TmBillingOperation, engagementId: string, c: RateContext | null, receipt = false) => {
    if (
      !operation.safeParse(op).success ||
      !id.safeParse(engagementId).success ||
      (op.type === 'policy' &&
        (op.data.engagementId !== engagementId ||
          (op.data.definition as { engagementId: string }).engagementId !== engagementId))
    )
      return bad();
    const mode = receipt ? 'read' : op.type === 'decision' ? 'decide' : 'manage',
      path = receipt
        ? '/receipts/' + op.type + '/' + op.data.requestId
        : op.type === 'policy'
          ? '/policies'
          : op.type === 'request'
            ? '/requests'
            : '/instances/' + op.id + '/' + (op.type === 'decision' ? 'decisions' : 'cancellations'),
      raw = await call(receipt ? 'GET' : 'POST', path, c, mode, receipt ? undefined : op.data);
    if (op.type === 'policy') {
      const p = z
        .object({
          ...envelope,
          ...(receipt ? { type: z.literal('policy') } : { replayed: z.boolean() }),
          policy,
        })
        .strict()
        .safeParse(raw);
      if (
        !p.success ||
        p.data.policy.engagementId !== engagementId ||
        p.data.policy.previousId !== op.data.expectedLatestId ||
        p.data.policy.requestId !== op.data.requestId ||
        p.data.policy.reason !== op.data.reason ||
        canonical(p.data.policy.definition) !== canonical(op.data.definition) ||
        p.data.policy.effectiveFrom !== op.data.effectiveFrom ||
        p.data.policy.actorId !== p.data.actorUserId ||
        p.data.policy.activeRole !== p.data.activeRole
      )
        return bad();
      return p.data.policy;
    }
    const v = z
      .object({
        ...envelope,
        ...(receipt ? { type: z.literal(op.type) } : { replayed: z.boolean() }),
        approval,
        ...(receipt || op.type === 'decision' ? { eventId: uuid.nullable(), itemId: uuid.nullable() } : {}),
      })
      .strict()
      .safeParse(raw);
    if (!v.success || v.data.approval.engagementId !== engagementId) return bad();
    if (
      'eventId' in v.data &&
      'itemId' in v.data &&
      ((v.data.eventId === null) !== (v.data.itemId === null) ||
        (v.data.approval.state.status === 'Approved' && (!v.data.eventId || !v.data.itemId)) ||
        (v.data.approval.state.status !== 'Approved' && (v.data.eventId !== null || v.data.itemId !== null)))
    )
      return bad();
    const a = v.data.approval;
    if (
      op.type === 'request' &&
      (a.requestId !== op.data.requestId ||
        a.snapshotId !== op.data.snapshotId ||
        a.ownerUserId !== op.data.ownerUserId ||
        a.ownerRole !== op.data.ownerRole ||
        a.policy.id !== op.data.expectedPolicyId ||
        a.reason !== op.data.reason ||
        a.requesterUserId !== v.data.actorUserId ||
        a.activeRole !== v.data.activeRole)
    )
      return bad();
    if (op.type === 'decision') {
      const t = a.transitions.find((x) => x.requestId === op.data.requestId);
      if (
        a.id !== op.id ||
        !t ||
        t.actorId !== v.data.actorUserId ||
        t.activeRole !== v.data.activeRole ||
        t.reason !== op.data.reason ||
        t.decision !== op.data.decision ||
        t.sequence !== op.data.expectedSequence + 1
      )
        return bad();
    }
    if (
      op.type === 'cancellation' &&
      (a.id !== op.id ||
        !a.cancellation ||
        a.cancellation.requestId !== op.data.requestId ||
        a.cancellation.actorId !== v.data.actorUserId ||
        a.cancellation.activeRole !== v.data.activeRole ||
        a.cancellation.reason !== op.data.reason)
    )
      return bad();
    return a;
  },
};
