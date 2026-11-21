import { z } from 'zod';
import {
  validCommercialCandidatePolicy,
  commercialApprovalState,
} from '../../shared/commercial-candidate-approval.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext, type RateKind } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const definition = z.unknown().refine(validCommercialCandidatePolicy);
const policy = z
  .object({
    id: uuid,
    candidateId: uuid,
    sequence: z.number().int().positive(),
    previousId: uuid.nullable(),
    effectiveFrom: date,
    definition,
    actorId: uuid,
    activeRole: z.string().min(1),
    reason,
    requestId: uuid,
    createdAt: instant,
  })
  .strict()
  .refine((p) => (p.sequence === 1 ? p.previousId === null : p.previousId !== null));
const transition = z
  .object({
    id: uuid,
    sequence: z.number().int().min(1).max(10),
    stage: z.number().int().min(0).max(9),
    decision: z.enum(['Approved', 'Rejected']),
    actorId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const cancellation = z
  .object({
    id: uuid,
    actorId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const approval = z
  .object({
    id: uuid,
    candidateId: uuid,
    ownerEventId: uuid,
    policy,
    requesterUserId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
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
        candidateId: string;
        kind: string;
        stages: Array<{ userId: string; role: string }>;
      };
      const base = commercialApprovalState(d, v.transitions);
      return (
        v.transitions.every(
          (t) =>
            d.stages[t.stage]?.userId === t.actorId &&
            d.stages[t.stage]?.role === t.activeRole &&
            t.actorId !== v.requesterUserId,
        ) &&
        d.candidateId === v.candidateId &&
        v.policy.candidateId === v.candidateId &&
        v.state.sequence === base.sequence &&
        (v.cancellation
          ? v.state.status === 'Cancelled' && v.state.currentStage === null && !v.current
          : v.state.status === base.status && v.state.currentStage === base.currentStage)
      );
    } catch {
      return false;
    }
  });
export type CommercialPolicy = z.infer<typeof policy>;
export type CommercialApproval = z.infer<typeof approval>;
export type PolicyCommand = {
  requestId: string;
  expectedLatestId: string | null;
  effectiveFrom: string;
  definition: unknown;
  reason: string;
};
export type RequestCommand = {
  requestId: string;
  candidateId: string;
  expectedOwnerEventId: string;
  expectedPolicyId: string;
  reason: string;
};
export type DecisionCommand = {
  requestId: string;
  expectedCandidateId: string;
  expectedOwnerEventId: string;
  expectedPolicyId: string;
  expectedSequence: number;
  decision: 'Approved' | 'Rejected';
  reason: string;
};
export type CancellationCommand = { requestId: string; expectedSequence: number; reason: string };
export type ApprovalOperation =
  | { type: 'policy'; data: PolicyCommand }
  | { type: 'request'; data: RequestCommand }
  | { type: 'decision'; id: string; data: DecisionCommand }
  | { type: 'cancellation'; id: string; data: CancellationCommand };
const operation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('policy'),
      data: z
        .object({
          requestId: uuid,
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
          candidateId: uuid,
          expectedOwnerEventId: uuid,
          expectedPolicyId: uuid,
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
          expectedCandidateId: uuid,
          expectedOwnerEventId: uuid,
          expectedPolicyId: uuid,
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
      data: z.object({ requestId: uuid, expectedSequence: z.number().int().min(0).max(9), reason }).strict(),
    })
    .strict(),
]);
const envelope = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  actorUserId: uuid,
  activeRole: z.string().min(1),
  organizationId: z.string().min(1),
  legalEntityId: z.string().min(1),
  serverDate: date,
  previewOnly: z.literal(true),
};
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const bad = (): never => {
  throw new ApiClientError(
    'Commercial approval response could not be confirmed. Read the original receipt.',
    { status: 503 },
  );
};
const current = (c: RateContext | null, k: RateKind, mode: 'read' | 'manage' | 'decide') => {
  if (
    !c ||
    !isRateContextCurrent(c) ||
    !hasRatePermission('commercial.contracts.view') ||
    !hasRatePermission(
      k === 'billing' ? 'commercial.rate_candidates.view' : 'commercial.cost_candidates.view',
    ) ||
    (k === 'cost' && !hasRatePermission('employees.view')) ||
    (mode === 'manage' &&
      (!hasRatePermission(
        k === 'billing' ? 'commercial.rate_candidates.manage' : 'commercial.cost_candidates.manage',
      ) ||
        (k === 'billing' && !hasRatePermission('commercial.contracts.manage')))) ||
    (mode === 'decide' &&
      ![
        k === 'billing' ? 'commercial.rate_approvals.decide' : 'commercial.cost_approvals.decide',
        'employees.view',
        'notifications.view',
        'approvals.view',
      ].every(hasRatePermission))
  )
    throw new ApiClientError('Current commercial scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  k: RateKind,
  mode: 'read' | 'manage' | 'decide',
  body?: object,
) => {
  const ctx = current(c, k, mode),
    ownerKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  current(ctx, k, mode);
  const raw = await api.requestWithContext<unknown>(
    method,
    '/api/v1/commercial-candidate-approvals' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, k, mode);
  const v = z.object(envelope).passthrough().safeParse(raw);
  if (
    !v.success ||
    v.data.ownerKey !== ownerKey ||
    v.data.organizationId !== ctx.scope.organizationId ||
    v.data.legalEntityId !== ctx.scope.legalEntityId ||
    v.data.activeRole !== ctx.activeRole
  )
    return bad();
  return v.data;
};
const checked = (a: CommercialApproval, candidateId: string, k: RateKind) => {
  const d = a.policy.definition as { candidateId: string; kind: string };
  if (a.candidateId !== candidateId || d.candidateId !== candidateId || d.kind !== k) return bad();
  return a;
};
export { captureRateContext };
export const commercialCandidateApprovals = {
  load: async (candidateId: string, k: RateKind, c: RateContext | null) => {
    if (!uuid.safeParse(candidateId).success) return bad();
    const q = '?' + new URLSearchParams({ candidateId });
    const [a, b] = await Promise.all([
      call('GET', '/policies' + q + '&includeEffective=true', c, k, 'read'),
      call('GET', '/requests' + q, c, k, 'read'),
    ]);
    const p = z
        .object({
          ...envelope,
          candidateId: uuid,
          policies: z.array(policy).max(10),
          truncated: z.boolean(),
          effectivePolicy: policy.nullable(),
        })
        .strict()
        .safeParse(a),
      r = z
        .object({
          ...envelope,
          candidateId: uuid,
          approvals: z.array(approval).max(10),
          truncated: z.boolean(),
        })
        .strict()
        .safeParse(b);
    if (
      !p.success ||
      !r.success ||
      p.data.actorUserId !== r.data.actorUserId ||
      p.data.candidateId !== candidateId ||
      r.data.candidateId !== candidateId ||
      (p.data.effectivePolicy &&
        (p.data.effectivePolicy.candidateId !== candidateId ||
          (p.data.effectivePolicy.definition as { kind: string }).kind !== k ||
          p.data.effectivePolicy.effectiveFrom > p.data.serverDate)) ||
      p.data.policies.some(
        (x) => x.candidateId !== candidateId || (x.definition as { kind: string }).kind !== k,
      )
    )
      return bad();
    return {
      policies: p.data.policies,
      effectivePolicy: p.data.effectivePolicy,
      approvals: r.data.approvals.map((x) => checked(x, candidateId, k)),
      truncated: p.data.truncated || r.data.truncated,
    };
  },
  run: async (
    op: ApprovalOperation,
    candidateId: string,
    k: RateKind,
    c: RateContext | null,
    receipt = false,
  ) => {
    if (
      !operation.safeParse(op).success ||
      !uuid.safeParse(candidateId).success ||
      (op.type === 'policy' &&
        ((op.data.definition as { candidateId: string; kind: string }).candidateId !== candidateId ||
          (op.data.definition as { kind: string }).kind !== k)) ||
      (op.type === 'request' && op.data.candidateId !== candidateId) ||
      (op.type === 'decision' && op.data.expectedCandidateId !== candidateId)
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
      raw = await call(receipt ? 'GET' : 'POST', path, c, k, mode, receipt ? undefined : op.data);
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
        p.data.policy.candidateId !== candidateId ||
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
      })
      .strict()
      .safeParse(raw);
    if (!v.success) return bad();
    const a = checked(v.data.approval, candidateId, k);
    if (
      op.type === 'request' &&
      (a.requestId !== op.data.requestId ||
        a.ownerEventId !== op.data.expectedOwnerEventId ||
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
        a.candidateId !== op.data.expectedCandidateId ||
        a.ownerEventId !== op.data.expectedOwnerEventId ||
        a.policy.id !== op.data.expectedPolicyId ||
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
        a.state.status !== 'Cancelled' ||
        a.state.sequence !== op.data.expectedSequence ||
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
