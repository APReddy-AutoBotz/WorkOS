import { z } from 'zod';
import { api, ApiClientError } from './apiClient';
import { rateCandidateSchema, type RateKind } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const selection = z
  .object({
    kind: z.enum(['billing', 'cost']),
    sourceId: z.string().min(1).max(200),
    asOf: date,
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
  })
  .strict();
const adoption = z
  .object({
    id: uuid,
    candidateId: uuid,
    ownerEventId: uuid,
    approvalId: uuid,
    policyId: uuid,
    finalTransitionId: uuid,
    actorId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const review = z
  .object({
    approvalId: uuid,
    ownerEventId: uuid,
    policyId: uuid,
    finalTransitionId: uuid,
    current: z.boolean(),
    sequence: z.number().int().min(1).max(10),
    decision: z.literal('Approved'),
  })
  .strict();
const envelope = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  actorUserId: uuid,
  activeRole: z.string().min(1),
  organizationId: z.string().min(1),
  legalEntityId: z.string().min(1),
  serverDate: date,
  authority: z.literal('adopted_source'),
};
const cmd = z
  .object({
    requestId: uuid,
    candidateId: uuid,
    expectedOwnerEventId: uuid,
    approvalId: uuid,
    expectedPolicyId: uuid,
    expectedFinalTransitionId: uuid,
    reason,
  })
  .strict();
export type AdoptionCommand = z.infer<typeof cmd>;
export type AdoptedSelection = z.infer<typeof selection>;
const bad = (): never => {
  throw new ApiClientError(
    'Approved source response could not be confirmed; inspect the original receipt before replacement.',
    { status: 503 },
  );
};
const current = (c: RateContext | null, k: RateKind, write = false) => {
  if (
    !c ||
    !isRateContextCurrent(c) ||
    !hasRatePermission('commercial.contracts.view') ||
    !hasRatePermission(
      k === 'billing' ? 'commercial.rate_candidates.view' : 'commercial.cost_candidates.view',
    ) ||
    (k === 'cost' && !hasRatePermission('employees.view')) ||
    (write &&
      (!hasRatePermission(
        k === 'billing' ? 'commercial.rate_candidates.manage' : 'commercial.cost_candidates.manage',
      ) ||
        (k === 'billing' && !hasRatePermission('commercial.contracts.manage'))))
  )
    throw new ApiClientError('Current source scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  k: RateKind,
  write = false,
  body?: object,
) => {
  const ctx = current(c, k, write),
    ownerKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  current(ctx, k, write);
  const raw = await api.requestWithContext<unknown>(
    method,
    '/api/v1/approved-rate-sources' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, k, write);
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
export const approvedRateSources = {
  inspect: async (candidateId: string, k: RateKind, c: RateContext | null) => {
    if (!uuid.safeParse(candidateId).success) return bad();
    const raw = await call('GET', '/candidates/' + candidateId, c, k),
      p = z
        .object({
          ...envelope,
          candidateId: uuid,
          kind: z.enum(['billing', 'cost']),
          reviews: z.array(review).max(10),
          truncated: z.boolean(),
          adoption: adoption.nullable(),
        })
        .strict()
        .safeParse(raw);
    if (
      !p.success ||
      p.data.candidateId !== candidateId ||
      p.data.kind !== k ||
      (p.data.adoption && p.data.adoption.candidateId !== candidateId)
    )
      return bad();
    return p.data;
  },
  adopt: async (d: AdoptionCommand, k: RateKind, c: RateContext | null, receipt = false) => {
    if (!cmd.safeParse(d).success) return bad();
    const raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/receipts/' + d.requestId : '/adoptions',
        c,
        k,
        !receipt,
        receipt ? undefined : d,
      ),
      p = z
        .object({
          ...envelope,
          kind: z.enum(['billing', 'cost']),
          adoption,
          ...(receipt ? {} : { replayed: z.boolean() }),
        })
        .strict()
        .safeParse(raw);
    if (!p.success || p.data.kind !== k) return bad();
    const x = p.data.adoption;
    if (
      x.candidateId !== d.candidateId ||
      x.ownerEventId !== d.expectedOwnerEventId ||
      x.approvalId !== d.approvalId ||
      x.policyId !== d.expectedPolicyId ||
      x.finalTransitionId !== d.expectedFinalTransitionId ||
      x.reason !== d.reason ||
      x.requestId !== d.requestId ||
      x.actorId !== p.data.actorUserId ||
      x.activeRole !== p.data.activeRole
    )
      return bad();
    return x;
  },
  resolve: async (q: AdoptedSelection, c: RateContext | null) => {
    if (!selection.safeParse(q).success) return bad();
    const raw = await call('GET', '/resolve?' + new URLSearchParams(q), c, q.kind),
      source = rateCandidateSchema.extend({
        adoptionId: uuid,
        ownerEventId: uuid,
        approvalId: uuid,
        policyId: uuid,
        finalTransitionId: uuid,
        adoptedAt: instant,
      }),
      p = z
        .object({
          ...envelope,
          selection,
          result: z.enum(['missing', 'conflict', 'source']),
          source: source.nullable(),
        })
        .strict()
        .safeParse(raw);
    if (!p.success || JSON.stringify(p.data.selection) !== JSON.stringify(q)) return bad();
    const x = p.data.source;
    if (p.data.result === 'source') {
      if (
        !x ||
        x.kind !== q.kind ||
        x.currency !== q.currency ||
        x.unit !== q.unit ||
        x.effectiveFrom > q.asOf ||
        x.effectiveTo < q.asOf ||
        (q.kind === 'cost' && (x.bindingType !== 'worker' || x.bindingId !== q.sourceId)) ||
        (q.kind === 'billing' && x.bindingType === 'engagement' && x.bindingId !== q.sourceId)
      )
        return bad();
    } else if (x !== null) return bad();
    return p.data;
  },
};
