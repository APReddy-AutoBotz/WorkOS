import { z } from 'zod';
import { api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext } from './apiClient';
import { authService } from './authService';
import { getEffectivePermissions } from './permissions';
export type RateContext = ApiRequestContext & {
  identityKey: string;
  activeRole: string;
  ownerIdentity: unknown[];
  isCurrent: () => boolean;
};
const identity = () => {
  const u = authService.getCurrentUser();
  return u
    ? JSON.stringify([
        u.id,
        u.employeeId,
        u.userName,
        u.role,
        u.permissionRole,
        [...getEffectivePermissions(u)].sort(),
      ])
    : null;
};
const captureScopedRateContext = (isCurrent = () => true): RateContext | null => {
  const u = authService.getCurrentUser(),
    scope = getOrganizationScope();
  if (!u?.userName || !scope?.organizationId || !scope.legalEntityId) return null;
  return {
    scope: { ...scope },
    token: getToken(),
    identityKey: identity()!,
    activeRole: u.role,
    ownerIdentity: [u.userName, u.id, u.role, scope.organizationId, scope.legalEntityId],
    isCurrent,
  };
};
export const isRateContextCurrent = (c: RateContext) => {
  const n = captureScopedRateContext();
  return Boolean(
    c.isCurrent() &&
      n &&
      n.identityKey === c.identityKey &&
      n.token === c.token &&
      n.scope.organizationId === c.scope.organizationId &&
      n.scope.legalEntityId === c.scope.legalEntityId,
  );
};
export const hasRatePermission = (key: string) => {
  const u = authService.getCurrentUser();
  return Boolean(u && getEffectivePermissions(u).includes(key));
};

const date = z.string().date(),
  uuid = z.string().uuid(),
  kind = z.enum(['billing', 'cost']),
  binding = z.enum(['contract', 'engagement', 'worker']);
const money = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/),
  currency = z.string().regex(/^[A-Z]{3}$/),
  unit = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);
export const rateCandidateInput = z
  .object({
    requestId: uuid,
    streamId: uuid,
    expectedLatestId: uuid.nullable(),
    kind,
    bindingType: binding,
    bindingId: z.string().min(1).max(200),
    effectiveFrom: date,
    effectiveTo: date,
    currency,
    unit,
    amount: money,
    priority: z.number().int().min(0).max(1000000),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict()
  .refine(
    (x) =>
      x.effectiveFrom <= x.effectiveTo &&
      (x.kind === 'cost' ? x.bindingType === 'worker' : x.bindingType !== 'worker'),
  );
export type RateInput = z.infer<typeof rateCandidateInput>;
export type RateKind = z.infer<typeof kind>;
export type Binding = z.infer<typeof binding>;
const candidate = z
  .object({
    id: uuid,
    streamId: uuid,
    sequence: z.number().int().positive(),
    previousId: uuid.nullable(),
    kind,
    bindingType: binding,
    bindingId: z.string().min(1),
    effectiveFrom: date,
    effectiveTo: date,
    currency,
    unit,
    amount: money,
    priority: z.number().int().nonnegative(),
    requestId: uuid,
    actorId: uuid,
    activeRole: z.string().min(1),
    reason: z.string().min(3),
    createdAt: z.string().refine((x) => Number.isFinite(Date.parse(x))),
  })
  .strict()
  .refine(
    (x) =>
      x.effectiveFrom <= x.effectiveTo &&
      (x.sequence === 1 ? x.previousId === null : x.previousId !== null) &&
      (x.kind === 'cost' ? x.bindingType === 'worker' : x.bindingType !== 'worker'),
  );
export type RateCandidate = z.infer<typeof candidate>;
const envelope = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  actorUserId: uuid,
  activeRole: z.string().min(1),
  organizationId: z.string().min(1),
  legalEntityId: z.string().min(1),
  serverDate: date,
  previewOnly: z.literal(true),
};
const bad = (): never => {
  throw new ApiClientError(
    'Candidate response could not be confirmed. Read the original receipt before replacing a write.',
    { status: 503 },
  );
};
export const captureRateContext = (isCurrent = () => true): RateContext | null => {
  try {
    if (!sessionStorage.getItem('workos_session')) return null;
  } catch {
    return null;
  }
  return captureScopedRateContext(isCurrent);
};
const current = (c: RateContext | null, k: RateKind, write = false) => {
  if (
    !c ||
    !isRateContextCurrent(c) ||
    !hasRatePermission('commercial.contracts.view') ||
    !hasRatePermission(
      k === 'billing' ? 'commercial.rate_candidates.view' : 'commercial.cost_candidates.view',
    ) ||
    (write &&
      !hasRatePermission(
        k === 'billing' ? 'commercial.rate_candidates.manage' : 'commercial.cost_candidates.manage',
      )) ||
    (k === 'cost' && !hasRatePermission('employees.view'))
  )
    throw new ApiClientError('Account, role, scope or rate permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  c: RateContext | null,
  k: RateKind,
  write = false,
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
  const raw = await api.requestWithContext<unknown>(method, '/api/v1/rate-candidates' + path, body, ctx);
  current(ctx, k, write);
  const parsed = z.object(envelope).passthrough().safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.organizationId !== ctx.scope.organizationId ||
    parsed.data.legalEntityId !== ctx.scope.legalEntityId ||
    parsed.data.ownerKey !== ownerKey ||
    parsed.data.activeRole !== ctx.activeRole
  )
    return bad();
  return parsed.data;
};
const exactAmount = (x: string) =>
  BigInt(x.split('.')[0]) * 10000n + BigInt((x.split('.')[1] ?? '').padEnd(4, '0'));
export const rateCandidateService = {
  list: async (k: RateKind, t: Binding, id: string, c: RateContext | null) => {
    const raw = await call(
      'GET',
      '/candidates?' + new URLSearchParams({ kind: k, bindingType: t, bindingId: id }),
      undefined,
      c,
      k,
    );
    const parsed = z
      .object({ ...envelope, candidates: z.array(candidate).max(100), truncated: z.boolean() })
      .strict()
      .safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.candidates.some((x) => x.kind !== k || x.bindingType !== t || x.bindingId !== id)
    )
      return bad();
    return parsed.data;
  },
  preview: async (k: RateKind, id: string, asOf: string, cur: string, u: string, c: RateContext | null) => {
    const selection = { kind: k, sourceId: id, asOf, currency: cur, unit: u };
    const schema = z.object({ kind, sourceId: z.string().min(1), asOf: date, currency, unit }).strict();
    if (!schema.safeParse(selection).success) return bad();
    const raw = await call('GET', '/preview?' + new URLSearchParams(selection), undefined, c, k);
    const parsed = z
      .object({
        ...envelope,
        selection: schema,
        result: z.enum(['missing', 'conflict', 'candidate']),
        candidate: candidate.nullable(),
        matchingBasis: binding.nullable(),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data.selection) !== JSON.stringify(selection)) return bad();
    const x = parsed.data.candidate;
    if (parsed.data.result === 'candidate') {
      if (
        !x ||
        x.kind !== k ||
        x.currency !== cur ||
        x.unit !== u ||
        x.effectiveFrom > asOf ||
        x.effectiveTo < asOf ||
        x.bindingType !== parsed.data.matchingBasis ||
        (k === 'cost' && (x.bindingType !== 'worker' || x.bindingId !== id)) ||
        (k === 'billing' && x.bindingType === 'engagement' && x.bindingId !== id)
      )
        return bad();
    } else if (x !== null || parsed.data.matchingBasis !== null) return bad();
    return parsed.data;
  },
  submit: async (input: RateInput, c: RateContext | null, read = false) => {
    const validated = rateCandidateInput.safeParse(input);
    if (!validated.success) return bad();
    const d = validated.data,
      raw = await call(
        read ? 'GET' : 'POST',
        read ? '/receipts/' + d.requestId : '/candidates',
        read ? undefined : d,
        c,
        d.kind,
        !read,
      );
    const parsed = z
      .object({ ...envelope, candidate, ...(read ? {} : { replayed: z.boolean() }) })
      .strict()
      .safeParse(raw);
    if (!parsed.success) return bad();
    const x = parsed.data.candidate;
    if (
      x.actorId !== parsed.data.actorUserId ||
      x.activeRole !== parsed.data.activeRole ||
      x.requestId !== d.requestId ||
      x.streamId !== d.streamId ||
      x.previousId !== d.expectedLatestId ||
      x.kind !== d.kind ||
      x.bindingType !== d.bindingType ||
      x.bindingId !== d.bindingId ||
      x.effectiveFrom !== d.effectiveFrom ||
      x.effectiveTo !== d.effectiveTo ||
      x.currency !== d.currency ||
      x.unit !== d.unit ||
      exactAmount(x.amount) !== exactAmount(d.amount) ||
      x.priority !== d.priority ||
      x.reason !== d.reason
    )
      return bad();
    return x;
  },
};
