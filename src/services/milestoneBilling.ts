import { z } from 'zod';
import {
  validMilestoneBillingPolicy,
  validMilestoneEvidence,
  milestoneBillingState,
} from '../../shared/milestone-billing-eligibility.mjs';
import { canonicalHours } from '../../shared/work-hours.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';

const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  date = z.string().date(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((v) => Number.isFinite(Date.parse(v))),
  money = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const envelope = {
  ownerKey: hash,
  actorUserId: uuid,
  activeRole: id,
  organizationId: id,
  legalEntityId: id,
  serverDate: date,
};
const evidence = z
  .array(
    z
      .object({
        kind: z.enum(['INTERNAL_ASSERTION', 'CLIENT_EVIDENCE_ASSERTION']),
        reference: z.string().trim().min(1).max(200),
        url: z.string().max(2048),
      })
      .strict(),
  )
  .min(1)
  .max(2);
const definition = z.unknown().refine(validMilestoneBillingPolicy);
const policy = z
  .object({
    id: uuid,
    engagementId: id,
    sequence: z.number().int().positive(),
    previousId: uuid.nullable(),
    effectiveFrom: date,
    definition,
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
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
    engagementId: id,
    milestoneId: id,
    ownerUserId: uuid,
    ownerRole: id,
    requesterUserId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    evidence,
    engagementLifecycleId: id,
    contractLifecycleId: id,
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
      const p = v.policy.definition as {
          evidenceKinds: string[];
          stages: { userId: string; role: string }[];
        },
        state = milestoneBillingState(p, v.transitions);
      return (
        v.policy.engagementId === v.engagementId &&
        validMilestoneEvidence(v.evidence, p.evidenceKinds) &&
        v.transitions.every(
          (t) =>
            p.stages[t.stage]?.userId === t.actorId &&
            p.stages[t.stage]?.role === t.activeRole &&
            t.actorId !== v.requesterUserId &&
            t.actorId !== v.ownerUserId,
        ) &&
        (v.cancellation
          ? v.state.status === 'Cancelled' &&
            v.state.currentStage === null &&
            v.state.sequence === v.transitions.length
          : v.state.status === state.status &&
            v.state.sequence === state.sequence &&
            v.state.currentStage === state.currentStage)
      );
    } catch {
      return false;
    }
  });
const source = z
  .object({
    id,
    engagementId: id,
    code: id,
    name: id,
    dueOn: date,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: money,
    clientId: id,
    contractId: id,
    contractVersionId: id,
    engagementLifecycleId: id.nullable(),
    contractLifecycleId: id.nullable(),
    current: z.boolean(),
  })
  .strict();
const outcome = { eventId: uuid.nullable(), itemId: uuid.nullable() };
const eventEvidence = z
  .object({
    milestoneId: id,
    sourceVersion: z.literal(1),
    engagementId: id,
    contractVersionId: id,
    engagementLifecycleId: id,
    contractLifecycleId: id,
    dueOn: date,
    evidence,
    ownerUserId: uuid,
    ownerRole: id,
    policyId: uuid,
    decisionId: uuid,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: money,
  })
  .strict();
export type MilestonePolicy = z.infer<typeof policy>;
export type MilestoneApproval = z.infer<typeof approval>;
export type MilestoneSource = z.infer<typeof source>;
export type MilestoneOperation =
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
        milestoneId: string;
        expectedPolicyId: string;
        ownerUserId: string;
        ownerRole: string;
        evidence: unknown;
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
          definition,
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
          milestoneId: id,
          expectedPolicyId: uuid,
          ownerUserId: uuid,
          ownerRole: id,
          evidence,
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
  throw new ApiClientError(
    'The milestone review response could not be confirmed. Read the original receipt.',
    { status: 503 },
  );
};
const current = (c: RateContext | null, mode: 'viewer' | 'manager' | 'decider') => {
  const keys = [
    'commercial.contracts.view',
    'commercial.milestone_billing.view',
    'employees.view',
    'notifications.view',
    ...(mode === 'manager'
      ? ['commercial.contracts.manage', 'commercial.milestone_billing.manage']
      : mode === 'decider'
        ? ['approvals.view', 'commercial.milestone_billing.decide']
        : []),
  ];
  if (!c || !isRateContextCurrent(c) || !keys.every(hasRatePermission))
    throw new ApiClientError('Current milestone scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  mode: 'viewer' | 'manager' | 'decider',
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
    '/api/v1/milestone-billing' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, mode);
  const parsed = z.object(envelope).passthrough().safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.ownerKey !== ownerKey ||
    parsed.data.organizationId !== ctx.scope.organizationId ||
    parsed.data.legalEntityId !== ctx.scope.legalEntityId ||
    parsed.data.activeRole !== ctx.activeRole ||
    (uuid.safeParse(ctx.ownerIdentity[1]).success && parsed.data.actorUserId !== ctx.ownerIdentity[1])
  )
    return bad();
  return parsed.data;
};
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export { captureRateContext };
const sourcesPage = async (engagementId: string, c: RateContext | null, after?: string) => {
  const query = new URLSearchParams({ engagementId });
  if (after) query.set('after', after);
  const raw = await call('GET', '/sources?' + query, c, 'viewer');
  const page = z
    .object({ ...envelope, sources: z.array(source).max(50), nextAfter: id.nullable() })
    .strict()
    .safeParse(raw);
  if (
    !page.success ||
    page.data.sources.some((s) => s.engagementId !== engagementId || s.id === after) ||
    (page.data.nextAfter !== null && page.data.nextAfter !== page.data.sources.at(-1)?.id)
  )
    return bad();
  return page.data;
};
const reviewsPage = async (engagementId: string, c: RateContext | null, after?: string) => {
  const query = new URLSearchParams({ engagementId });
  if (after) query.set('after', after);
  const raw = await call('GET', '/instances?' + query, c, 'viewer');
  const page = z
    .object({ ...envelope, approvals: z.array(approval).max(50), nextAfter: uuid.nullable() })
    .strict()
    .safeParse(raw);
  if (
    !page.success ||
    page.data.approvals.some((a) => a.engagementId !== engagementId || a.id === after) ||
    (page.data.nextAfter !== null && page.data.nextAfter !== page.data.approvals.at(-1)?.id)
  )
    return bad();
  return page.data;
};
export const milestoneBilling = {
  sourcesPage,
  reviewsPage,
  load: async (engagementId: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success) return bad();
    const query = new URLSearchParams({ engagementId, includeEffective: 'true' });
    const [raw, sources, approvals] = await Promise.all([
      call('GET', '/policies?' + query, c, 'viewer'),
      sourcesPage(engagementId, c),
      reviewsPage(engagementId, c),
    ]);
    const p = z
      .object({
        ...envelope,
        policies: z.array(policy).max(20),
        truncated: z.boolean(),
        effectivePolicy: policy.nullable(),
      })
      .strict()
      .safeParse(raw);
    if (
      !p.success ||
      p.data.policies.some((x) => x.engagementId !== engagementId) ||
      (p.data.effectivePolicy &&
        (p.data.effectivePolicy.engagementId !== engagementId ||
          p.data.effectivePolicy.effectiveFrom > p.data.serverDate))
    )
      return bad();
    return {
      policies: p.data.policies,
      effectivePolicy: p.data.effectivePolicy,
      sources: sources.sources,
      approvals: approvals.approvals,
      sourceNext: sources.nextAfter,
      reviewNext: approvals.nextAfter,
    };
  },
  inspect: async (approvalId: string, c: RateContext | null) => {
    if (!uuid.safeParse(approvalId).success) return bad();
    const raw = await call('GET', '/instances/' + approvalId, c, 'viewer'),
      out = z
        .object({ ...envelope, approval, source, ...outcome })
        .strict()
        .safeParse(raw);
    if (
      !out.success ||
      out.data.approval.id !== approvalId ||
      out.data.approval.milestoneId !== out.data.source.id ||
      out.data.approval.engagementId !== out.data.source.engagementId ||
      Boolean(out.data.eventId) !== Boolean(out.data.itemId) ||
      (out.data.approval.state.status === 'Approved') !== Boolean(out.data.eventId)
    )
      return bad();
    return out.data;
  },
  register: async (engagementId: string | null, c: RateContext | null, after?: string) => {
    if (after && !uuid.safeParse(after).success) return bad();
    const query = new URLSearchParams();
    if (engagementId) query.set('engagementId', engagementId);
    if (after) query.set('after', after);
    const raw = await call('GET', '/register' + (query.size ? '?' + query.toString() : ''), c, 'viewer'),
      item = z
        .object({
          id: uuid,
          version: z.literal(1),
          eventId: uuid,
          instanceId: uuid,
          decisionId: uuid,
          engagementId: id,
          clientId: id,
          contractId: id,
          eligibleOn: date,
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: money,
          evidence: eventEvidence,
        })
        .strict()
        .refine(
          (v) =>
            v.evidence.engagementId === v.engagementId &&
            v.evidence.decisionId === v.decisionId &&
            v.evidence.currency === v.currency &&
            canonicalHours(v.evidence.amount) === canonicalHours(v.amount),
        ),
      out = z
        .object({
          ...envelope,
          items: z.array(item).max(50),
          nextAfter: uuid.nullable(),
          batchSupport: z.boolean(),
        })
        .strict()
        .safeParse(raw);
    if (
      !out.success ||
      out.data.items.some(
        (x) => x.id === after || (engagementId !== null && x.engagementId !== engagementId),
      ) ||
      (out.data.nextAfter !== null && out.data.nextAfter !== out.data.items.at(-1)?.id)
    )
      return bad();
    return out.data;
  },
  run: async (op: MilestoneOperation, c: RateContext | null, receipt = false) => {
    if (!operation.safeParse(op).success) return bad();
    const mode = receipt ? 'viewer' : op.type === 'decision' ? 'decider' : 'manager',
      path = receipt
        ? '/receipts/' + op.type + '/' + op.data.requestId
        : op.type === 'policy'
          ? '/policies'
          : op.type === 'request'
            ? '/requests'
            : '/instances/' + op.id + '/' + (op.type === 'decision' ? 'decisions' : 'cancellations'),
      raw = await call(receipt ? 'GET' : 'POST', path, c, mode, receipt ? undefined : op.data);
    if (op.type === 'policy') {
      const out = z
        .object({
          ...envelope,
          policy,
          ...(receipt ? { type: z.literal('policy') } : { replayed: z.boolean() }),
        })
        .strict()
        .safeParse(raw);
      if (
        !out.success ||
        out.data.policy.requestId !== op.data.requestId ||
        out.data.policy.engagementId !== op.data.engagementId ||
        canonical(out.data.policy.definition) !== canonical(op.data.definition) ||
        out.data.policy.reason !== op.data.reason ||
        out.data.policy.actorId !== out.data.actorUserId ||
        out.data.policy.activeRole !== out.data.activeRole
      )
        return bad();
      return out.data;
    }
    const out = z
      .object({
        ...envelope,
        approval,
        ...(op.type === 'cancellation' ? {} : outcome),
        ...(receipt ? { type: z.literal(op.type) } : { replayed: z.boolean() }),
      })
      .strict()
      .safeParse(raw);
    if (!out.success) return bad();
    const a = out.data.approval;
    if (
      op.type !== 'cancellation' &&
      'eventId' in out.data &&
      ((a.state.status === 'Approved') !== Boolean(out.data.eventId) ||
        Boolean(out.data.eventId) !== Boolean(out.data.itemId))
    )
      return bad();
    if (
      op.type === 'request' &&
      (a.requestId !== op.data.requestId ||
        a.milestoneId !== op.data.milestoneId ||
        a.policy.id !== op.data.expectedPolicyId ||
        a.ownerUserId !== op.data.ownerUserId ||
        a.ownerRole !== op.data.ownerRole ||
        a.requesterUserId !== out.data.actorUserId ||
        a.activeRole !== out.data.activeRole ||
        a.reason !== op.data.reason ||
        canonical(a.evidence) !== canonical(op.data.evidence))
    )
      return bad();
    if (
      op.type === 'decision' &&
      (a.id !== op.id ||
        !a.transitions.some(
          (t) =>
            t.requestId === op.data.requestId &&
            t.sequence === op.data.expectedSequence + 1 &&
            t.decision === op.data.decision &&
            t.reason === op.data.reason &&
            t.actorId === out.data.actorUserId &&
            t.activeRole === out.data.activeRole,
        ))
    )
      return bad();
    if (
      op.type === 'cancellation' &&
      (a.id !== op.id ||
        a.cancellation?.requestId !== op.data.requestId ||
        a.cancellation?.reason !== op.data.reason ||
        a.cancellation?.actorId !== out.data.actorUserId ||
        a.cancellation?.activeRole !== out.data.activeRole)
    )
      return bad();
    return out.data;
  },
};
