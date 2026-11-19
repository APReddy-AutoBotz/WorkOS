import { z } from 'zod';
import { validTmValuationPolicy, calculateTmEntry } from '../../shared/governed-tm-valuation.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  id = z.string().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x))),
  definition = z.unknown().refine(validTmValuationPolicy);
const policy = z
  .object({
    id: uuid,
    engagementId: id,
    sequence: z.number().int().positive(),
    previousId: uuid.nullable(),
    effectiveFrom: date,
    definition: z.custom<{
      version: 'governed-tm/1';
      currency: string;
      precision: number;
      rounding: 'HALF_UP' | 'HALF_EVEN' | 'DOWN';
      aggregation: 'PER_ENTRY';
      capTreatment: 'NONE';
      exclusions: 'NONE';
      unit: 'HOUR';
      approvalTreatment: 'NONE';
    }>(validTmValuationPolicy),
    actorId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict()
  .refine((x) => (x.sequence === 1 ? x.previousId === null : x.previousId !== null));
const source = z
  .object({
    submissionId: id,
    decisionId: id,
    entryId: uuid,
    workDate: date,
    hoursExact: z.string(),
    projectId: id,
    workerId: id,
    workerName: z.string().min(1),
    workerStatus: z.enum(['Active', 'On Leave', 'Exited']),
    bindingId: id,
    valuationId: uuid.nullable(),
  })
  .strict();
const evidence = z
  .object({
    submissionId: id,
    decisionId: id,
    entryId: uuid,
    projectId: id,
    bindingId: id,
    workDate: date,
    hours: z.string(),
    references: z.array(z.unknown()).length(3),
    assignmentSnapshots: z.array(z.unknown()).min(1),
    billingAdoptionId: uuid,
    costAdoptionId: uuid,
    policyId: uuid,
  })
  .strict();
const result = z
  .object({
    version: z.literal('governed-tm/1'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.literal('HOUR'),
    hoursExact: z.string(),
    billingRateExact: z.string(),
    costRateExact: z.string(),
    unroundedBillableExact: z.string(),
    unroundedCostExact: z.string(),
    billableValue: z.string(),
    costValue: z.string(),
    marginValue: z.string(),
  })
  .strict();
const valuation = z
  .object({
    id: uuid,
    engagementId: id,
    policyId: uuid,
    submissionId: id,
    decisionId: id,
    entryId: uuid,
    billingAdoptionId: uuid,
    costAdoptionId: uuid,
    sourceEvidence: evidence,
    result,
    actorId: uuid,
    activeRole: z.string().min(1),
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const envelope = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  actorUserId: uuid,
  activeRole: z.string().min(1),
  organizationId: id,
  legalEntityId: id,
  serverDate: date,
  calculationVersion: z.literal('governed-tm/1'),
};
const pc = z
    .object({
      requestId: uuid,
      engagementId: id,
      expectedLatestId: uuid.nullable(),
      effectiveFrom: date,
      definition,
      reason,
    })
    .strict(),
  vc = z
    .object({
      requestId: uuid,
      engagementId: id,
      policyId: uuid,
      submissionId: id,
      entryId: uuid,
      billingAdoptionId: uuid,
      costAdoptionId: uuid,
      reason,
    })
    .strict();
const retainedRate = z
  .object({
    adoptionId: uuid,
    candidateId: uuid,
    kind: z.enum(['billing', 'cost']),
    amount: z.string(),
    currency: z.string(),
    unit: z.string(),
    effectiveFrom: date,
    effectiveTo: date,
    bindingType: z.enum(['worker', 'contract', 'engagement']),
    bindingId: id,
    priority: z.number().int().min(0).max(1000000),
  })
  .strict();
export type TmRates = {
  billingId: string;
  billingAmount: string;
  costId: string;
  costAmount: string;
  currency: string;
  unit: string;
};
export type TmPolicy = z.infer<typeof policy>;
export type TmSource = z.infer<typeof source>;
export type TmValuation = z.infer<typeof valuation>;
export type TmPolicyCommand = z.infer<typeof pc>;
export type TmValuationCommand = z.infer<typeof vc>;
const canonical = (value: unknown) =>
    JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    ),
  bad = (): never => {
    throw new ApiClientError(
      'Valuation could not be confirmed. Read its original receipt before replacement.',
      { status: 503 },
    );
  };
const current = (c: RateContext | null, write = false, manage = false) => {
  if (
    !c ||
    !isRateContextCurrent(c) ||
    ![
      'commercial.contracts.view',
      'commercial.rate_candidates.view',
      'commercial.cost_candidates.view',
      'employees.view',
      'commercial.tm_valuation.view',
      ...(write ? ['commercial.tm_valuation.create'] : []),
      ...(manage ? ['commercial.contracts.manage'] : []),
    ].every(hasRatePermission)
  )
    throw new ApiClientError('Current protected valuation or source access changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  write = false,
  manage = false,
  body?: object,
) => {
  const ctx = current(c, write, manage),
    ownerKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  current(ctx, write, manage);
  const raw = await api.requestWithContext<unknown>(
    method,
    '/api/v1/governed-tm-valuations' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, write, manage);
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
export { captureRateContext };
const policyPage = async (engagementId: string, c: RateContext | null, beforeSequence?: number) => {
  const q = new URLSearchParams({ engagementId });
  if (beforeSequence !== undefined) q.set('beforeSequence', String(beforeSequence));
  const raw = await call('GET', '/policies?' + q, c);
  const p = z
    .object({ ...envelope, engagementId: id, policies: z.array(policy).max(20), truncated: z.boolean() })
    .strict()
    .safeParse(raw);
  if (
    !p.success ||
    p.data.engagementId !== engagementId ||
    p.data.policies.some(
      (x, i, a) =>
        x.engagementId !== engagementId || x.sequence >= (a[i - 1]?.sequence ?? beforeSequence ?? Infinity),
    ) ||
    (p.data.truncated && !p.data.policies.length)
  )
    return bad();
  return p.data;
};
const sourcePage = async (engagementId: string, c: RateContext | null, after?: TmSource) => {
  const q = new URLSearchParams({ engagementId });
  if (after) {
    q.set('afterDate', after.workDate);
    q.set('afterEntryId', after.entryId);
  }
  const raw = await call('GET', '/sources?' + q, c);
  const p = z
    .object({ ...envelope, engagementId: id, sources: z.array(source).max(100), truncated: z.boolean() })
    .strict()
    .safeParse(raw);
  if (
    !p.success ||
    p.data.engagementId !== engagementId ||
    (p.data.truncated && !p.data.sources.length) ||
    p.data.sources.some((x, i, a) => {
      const prev = a[i - 1] ?? after;
      return (
        prev && (x.workDate > prev.workDate || (x.workDate === prev.workDate && x.entryId <= prev.entryId))
      );
    })
  )
    return bad();
  return p.data;
};
export const governedTmValuations = {
  periodMembers: async (
    periodId: string,
    engagementId: string,
    start: string,
    end: string,
    sequence: number,
    offset: number,
    c: RateContext | null,
  ) => {
    if (
      !uuid.safeParse(periodId).success ||
      !id.safeParse(engagementId).success ||
      !date.safeParse(start).success ||
      !date.safeParse(end).success ||
      start > end ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return bad();
    const query = new URLSearchParams({
      engagementId,
      start,
      end,
      sequence: String(sequence),
      offset: String(offset),
    });
    const raw = await call('GET', '/period-versions/' + periodId + '/members?' + query, c);
    const amount = z.string().regex(/^\d+(?:\.\d+)?$/);
    const member = source.extend({
      valuationId: uuid,
      hoursExact: amount,
      currency: z.string().regex(/^[A-Z]{3}$/),
      billable: amount,
      cost: amount,
      margin: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    });
    const parsed = z
      .object({
        ...envelope,
        periodId: uuid,
        engagementId: id,
        sequence: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        count: z.number().int().positive(),
        members: z.array(member).max(25),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) return bad();
    const page = parsed.data;
    if (
      page.periodId !== periodId ||
      page.engagementId !== engagementId ||
      page.sequence !== sequence ||
      page.offset !== offset ||
      page.members.length !== Math.min(25, Math.max(0, page.count - offset)) ||
      page.members.some((x) => x.workDate < start || x.workDate > end) ||
      new Set(page.members.map((x) => x.valuationId)).size !== page.members.length
    )
      return bad();
    return page;
  },
  periodSummary: async (
    engagementId: string,
    start: string,
    end: string,
    c: RateContext | null,
    options?: { sequence?: number; retainKey?: string },
  ) => {
    if (
      !id.safeParse(engagementId).success ||
      !date.safeParse(start).success ||
      !date.safeParse(end).success ||
      start > end
    )
      return bad();
    const range = { engagementId, start, end };
    const query = new URLSearchParams(range);
    let raw;
    if (options?.retainKey) {
      raw = await call('POST', '/period-versions', c, true, false, {
        ...range,
        membershipKey: options.retainKey,
      });
    } else if (options) {
      if (options.sequence !== undefined) query.set('sequence', String(options.sequence));
      raw = await call('GET', '/period-versions?' + query, c);
    } else {
      query.set('includeMembershipKey', 'true');
      raw = await call('GET', '/period-summary?' + query, c);
    }
    const unsigned = z.string().regex(/^\d+(?:\.\d+)?$/);
    const row = z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        entryCount: z.string().regex(/^[1-9]\d*$/),
        hours: unsigned,
        billable: unsigned,
        cost: unsigned,
        margin: z.string().regex(/^-?\d+(?:\.\d+)?$/),
        marginPercent: z
          .string()
          .regex(/^-?\d+\.\d{2}$/)
          .nullable(),
      })
      .strict();
    const schema = z
      .object({
        ...envelope,
        version: z.literal('tm-period-margin/1'),
        engagementId: id,
        start: date,
        end: date,
        totals: z.array(row),
        membershipKey: z.string().regex(/^[0-9a-f]{64}$/),
        id: uuid.optional(),
        sequence: z.number().int().positive().optional(),
        createdAt: instant.optional(),
        replayed: z.boolean().optional(),
      })
      .strict();
    const parsed = schema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.engagementId !== engagementId ||
      parsed.data.start !== start ||
      parsed.data.end !== end ||
      Boolean(options) !== Boolean(parsed.data.id && parsed.data.sequence && parsed.data.createdAt) ||
      (options?.sequence !== undefined && parsed.data.sequence !== options.sequence) ||
      (options?.retainKey !== undefined && parsed.data.membershipKey !== options.retainKey) ||
      new Set(parsed.data.totals.map((x) => x.currency)).size !== parsed.data.totals.length ||
      parsed.data.totals.some((x) => (x.marginPercent === null) !== !/[1-9]/.test(x.billable))
    )
      return bad();
    return parsed.data;
  },
  sourcePage,
  policyPage,
  load: async (engagementId: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success) return bad();
    const [p, s] = await Promise.all([policyPage(engagementId, c), sourcePage(engagementId, c)]);
    if (p.actorUserId !== s.actorUserId) return bad();
    return {
      policies: p.policies,
      sources: s.sources,
      morePolicies: p.truncated,
      moreSources: s.truncated,
      serverDate: p.serverDate,
    };
  },
  policy: async (d: TmPolicyCommand, c: RateContext | null, receipt = false) => {
    if (!pc.safeParse(d).success) return bad();
    const raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/receipts/policy/' + d.requestId : '/policies',
        c,
        !receipt,
        !receipt,
        receipt ? undefined : d,
      ),
      p = z
        .object({ ...envelope, policy, ...(receipt ? {} : { replayed: z.boolean() }) })
        .strict()
        .safeParse(raw);
    if (!p.success) return bad();
    const x = p.data.policy;
    if (
      x.engagementId !== d.engagementId ||
      x.previousId !== d.expectedLatestId ||
      x.effectiveFrom !== d.effectiveFrom ||
      canonical(x.definition) !== canonical(d.definition) ||
      x.reason !== d.reason ||
      x.requestId !== d.requestId ||
      x.actorId !== p.data.actorUserId ||
      x.activeRole !== p.data.activeRole
    )
      return bad();
    return x;
  },
  inspect: async (
    valuationId: string,
    engagementId: string,
    expectedSource: TmSource,
    c: RateContext | null,
  ) => {
    if (!uuid.safeParse(valuationId).success || !id.safeParse(engagementId).success) return bad();
    const raw = await call('GET', '/valuations/' + valuationId + '?includeRateEvidence=true', c),
      p = z
        .object({
          ...envelope,
          valuation,
          policy,
          resolutionRule: z.literal('UNIQUE_HIGHEST_PRIORITY'),
          billingRate: retainedRate,
          costRate: retainedRate,
        })
        .strict()
        .safeParse(raw);
    if (!p.success) return bad();
    const x = p.data.valuation,
      e = x.sourceEvidence,
      pol = p.data.policy;
    if (
      x.id !== valuationId ||
      x.id !== expectedSource.valuationId ||
      x.policyId !== pol.id ||
      x.engagementId !== engagementId ||
      pol.engagementId !== engagementId ||
      x.submissionId !== expectedSource.submissionId ||
      x.entryId !== expectedSource.entryId ||
      e.submissionId !== x.submissionId ||
      e.entryId !== x.entryId ||
      e.decisionId !== expectedSource.decisionId ||
      e.projectId !== expectedSource.projectId ||
      e.bindingId !== expectedSource.bindingId ||
      e.workDate !== expectedSource.workDate ||
      e.hours !== expectedSource.hoursExact ||
      e.policyId !== x.policyId ||
      e.billingAdoptionId !== x.billingAdoptionId ||
      e.costAdoptionId !== x.costAdoptionId ||
      p.data.billingRate.adoptionId !== x.billingAdoptionId ||
      p.data.billingRate.kind !== 'billing' ||
      p.data.costRate.adoptionId !== x.costAdoptionId ||
      p.data.costRate.kind !== 'cost' ||
      p.data.costRate.bindingType !== 'worker' ||
      p.data.costRate.bindingId !== expectedSource.workerId ||
      p.data.billingRate.bindingType === 'worker' ||
      (p.data.billingRate.bindingType === 'contract' &&
        !e.references.some(
          (ref) =>
            typeof ref === 'object' &&
            ref !== null &&
            'entityType' in ref &&
            ref.entityType === 'Contract' &&
            'entityId' in ref &&
            ref.entityId === p.data.billingRate.bindingId,
        )) ||
      (p.data.billingRate.bindingType === 'engagement' && p.data.billingRate.bindingId !== engagementId) ||
      [p.data.billingRate, p.data.costRate].some(
        (rate) => rate.effectiveFrom > e.workDate || rate.effectiveTo < e.workDate,
      ) ||
      p.data.billingRate.amount !== x.result.billingRateExact ||
      p.data.costRate.amount !== x.result.costRateExact ||
      p.data.billingRate.currency !== x.result.currency ||
      p.data.costRate.currency !== x.result.currency ||
      p.data.billingRate.unit !== x.result.unit ||
      p.data.costRate.unit !== x.result.unit
    )
      return bad();
    try {
      const expected = calculateTmEntry({
        hours: expectedSource.hoursExact,
        billingRate: x.result.billingRateExact,
        costRate: x.result.costRateExact,
        currency: x.result.currency,
        unit: x.result.unit,
        policy: pol.definition,
      });
      if (canonical(expected) !== canonical(x.result)) return bad();
    } catch {
      return bad();
    }
    return { valuation: x, policy: pol, billingRate: p.data.billingRate, costRate: p.data.costRate };
  },
  calculate: async (
    d: TmValuationCommand,
    expectedPolicy: TmPolicy,
    expectedSource: TmSource,
    rates: TmRates,
    c: RateContext | null,
    receipt = false,
  ) => {
    if (
      !vc.safeParse(d).success ||
      d.engagementId !== expectedPolicy.engagementId ||
      d.policyId !== expectedPolicy.id ||
      d.submissionId !== expectedSource.submissionId ||
      d.entryId !== expectedSource.entryId ||
      d.billingAdoptionId !== rates.billingId ||
      d.costAdoptionId !== rates.costId
    )
      return bad();
    const raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/receipts/valuation/' + d.requestId : '/valuations',
        c,
        !receipt,
        false,
        receipt ? undefined : d,
      ),
      p = z
        .object({ ...envelope, valuation, ...(receipt ? {} : { replayed: z.boolean() }) })
        .strict()
        .safeParse(raw);
    if (!p.success) return bad();
    const x = p.data.valuation,
      e = x.sourceEvidence;
    if (
      x.engagementId !== d.engagementId ||
      x.policyId !== d.policyId ||
      x.submissionId !== d.submissionId ||
      x.entryId !== d.entryId ||
      x.billingAdoptionId !== d.billingAdoptionId ||
      x.costAdoptionId !== d.costAdoptionId ||
      x.reason !== d.reason ||
      x.requestId !== d.requestId ||
      x.actorId !== p.data.actorUserId ||
      x.activeRole !== p.data.activeRole ||
      e.submissionId !== d.submissionId ||
      e.decisionId !== expectedSource.decisionId ||
      e.entryId !== d.entryId ||
      e.projectId !== expectedSource.projectId ||
      e.bindingId !== expectedSource.bindingId ||
      e.workDate !== expectedSource.workDate ||
      e.hours !== expectedSource.hoursExact ||
      e.billingAdoptionId !== d.billingAdoptionId ||
      e.costAdoptionId !== d.costAdoptionId ||
      e.policyId !== d.policyId ||
      x.result.billingRateExact !== rates.billingAmount ||
      x.result.costRateExact !== rates.costAmount ||
      x.result.currency !== rates.currency ||
      x.result.unit !== rates.unit
    )
      return bad();
    try {
      const expected = calculateTmEntry({
        hours: expectedSource.hoursExact,
        billingRate: x.result.billingRateExact,
        costRate: x.result.costRateExact,
        currency: x.result.currency,
        unit: x.result.unit,
        policy: expectedPolicy.definition,
      });
      if (canonical(expected) !== canonical(x.result)) return bad();
    } catch {
      return bad();
    }
    return x;
  },
};
