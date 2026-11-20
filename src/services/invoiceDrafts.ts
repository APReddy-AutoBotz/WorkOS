import {fixedFeeInvoiceEvidence} from './fixedFeeInvoiceContracts';
import { milestoneInvoiceEvidence, milestoneEvidenceMatches } from './milestoneInvoiceContracts';
import { z } from 'zod';
import { validInvoiceDraft, invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
import { canonicalHours } from '../../shared/work-hours.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x))),
  amount = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/),
  definition = z.unknown().refine(validInvoiceDraft);
const refs = z
    .object({
      entityType: z.enum(['Project', 'Engagement', 'Contract']),
      entityId: id,
      lifecycleEventId: id,
      contractVersionId: id,
    })
    .strict(),
  evidence = z
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
      references: z.array(refs).length(3),
      currency: z.string().regex(/^[A-Z]{3}$/),
      amount,
    })
    .strict()
    .refine(
      (x) =>
        /[1-9]/.test(x.amount) &&
        new Set(x.references.map((r) => r.entityType)).size === 3 &&
        x.references.find((r) => r.entityType === 'Project')?.entityId === x.projectId &&
        x.references.find((r) => r.entityType === 'Engagement')?.entityId === x.engagementId &&
        new Set(x.references.map((r) => r.contractVersionId)).size === 1,
    );
const batch = z
  .object({
    id: uuid,
    clientId: id,
    contractId: id,
    engagementId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    periodStart: date,
    periodEnd: date,
    periodBasis: z.enum(['WORK_DATE', 'ELIGIBLE_DATE']),
    ownerUserId: uuid,
    ownerRole: id,
    preparerUserId: uuid,
    preparerRole: id,
    requestId: uuid,
    reason,
    createdAt: instant,
    ownerCurrent: z.boolean(),
    sourceType: z.enum(['MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT']).optional(),
    state: z.enum(['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed', 'Cancelled']),
  })
  .strict()
  .refine(
    (x) =>
      x.periodStart <= x.periodEnd &&
      (!x.sourceType ||
        (x.periodBasis === 'ELIGIBLE_DATE' && hasRatePermission(x.sourceType==='FIXED_FEE_INSTALLMENT'?'commercial.fixed_fee_eligibility.issue':'commercial.milestone_billing.view'))),
  );
const tmLine = z
  .object({
    id: uuid,
    batchId: uuid,
    sequence: z.number().int().positive(),
    itemId: uuid,
    itemVersion: z.literal(1),
    eventId: uuid,
    snapshotId: uuid,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount,
    evidence,
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict()
  .refine(
    (x) =>
      x.snapshotId === x.evidence.snapshotId &&
      x.currency === x.evidence.currency &&
      canonicalHours(x.amount) === canonicalHours(x.evidence.amount),
  );
const milestoneLine = z
  .object({
    id: uuid,
    batchId: uuid,
    sequence: z.number().int().positive(),
    itemId: uuid,
    itemVersion: z.literal(1),
    eventId: uuid,
    snapshotId: z.null(),
    sourceType: z.literal('MILESTONE_ACCEPTANCE'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount,
    evidence: milestoneInvoiceEvidence,
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    createdAt: instant,
  })
  .strict();
const fixedFeeLine = milestoneLine.extend({
  sourceType:z.literal('FIXED_FEE_INSTALLMENT'),
  evidence:fixedFeeInvoiceEvidence,
});
const line = z.union([tmLine, milestoneLine, fixedFeeLine]);
const cancellation = z
    .object({
      id: uuid,
      batchId: uuid,
      expectedLineCount: z.number().int().nonnegative(),
      actorId: uuid,
      activeRole: id,
      requestId: uuid,
      reason,
      createdAt: instant,
    })
    .strict(),
  envelope = {
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
    actorUserId: uuid,
    activeRole: id,
    organizationId: id,
    legalEntityId: id,
    serverDate: date,
  },
  total = z
    .object({
      lineCount: z.number().int().nonnegative(),
      amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
    })
    .strict();
const detail = { ...envelope, batch, lines: z.array(line), total, cancellation: cancellation.nullable() };
const checkDetail = (
  x: z.infer<typeof batch>,
  lines: z.infer<typeof line>[],
  sum: z.infer<typeof total>,
  cancel: z.infer<typeof cancellation> | null,
) => {
  try {
    const computed = invoiceDraftTotal(lines.map((l) => l.amount));
    return (
      lines.every((l) => ('sourceType' in l ? l.sourceType : undefined) === x.sourceType) &&
      lines.every(
        (l, i) =>
          l.batchId === x.id &&
          l.sequence === i + 1 &&
          l.currency === x.currency &&
          ('sourceType' in l && l.sourceType==='FIXED_FEE_INSTALLMENT'
            ? l.evidence.engagementId===x.engagementId && l.evidence.currency===x.currency &&
              canonicalHours(l.evidence.amount)===canonicalHours(l.amount)
            : 'sourceType' in l ? hasRatePermission('commercial.milestone_billing.view') &&
              x.periodBasis === 'ELIGIBLE_DATE' &&
              milestoneEvidenceMatches(l.evidence, x.engagementId, x.currency, l.amount)
            : l.evidence.engagementId === x.engagementId &&
              l.evidence.references.find((r) => r.entityType === 'Contract')?.entityId === x.contractId),
      ) &&
      computed.lineCount === sum.lineCount &&
      canonicalHours(computed.amount) === canonicalHours(sum.amount) &&
      (x.state === 'Cancelled'
        ? !!cancel && cancel.batchId === x.id && cancel.expectedLineCount === lines.length
        : cancel === null)
    );
  } catch {
    return false;
  }
};
export type InvoiceDraft = z.infer<typeof batch>;
export type InvoiceDraftLine = z.infer<typeof line>;
export type InvoiceDraftDetail = {
  cancellationToken?: string;
  batch: InvoiceDraft;
  lines: InvoiceDraftLine[];
  total: z.infer<typeof total>;
  cancellation: z.infer<typeof cancellation> | null;
};
export type InvoiceDraftOperation =
  | { type: 'batch'; data: { requestId: string; definition: unknown; reason: string } }
  | {
      type: 'line';
      batchId: string;
      data: { requestId: string; itemId: string; itemVersion: 1; expectedLineCount: number; reason: string };
    }
  | {
      type: 'cancellation';
      batchId: string;
      data: {
        requestId: string;
        expectedLineCount: number;
        expectedCancellationToken?: string;
        reason: string;
      };
    };
const operation = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('batch'), data: z.object({ requestId: uuid, definition, reason }).strict() })
    .strict(),
  z
    .object({
      type: z.literal('line'),
      batchId: uuid,
      data: z
        .object({
          requestId: uuid,
          itemId: uuid,
          itemVersion: z.literal(1),
          expectedLineCount: z.number().int().min(0).max(1000000),
          reason,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cancellation'),
      batchId: uuid,
      data: z
        .object({
          requestId: uuid,
          expectedLineCount: z.number().int().min(0).max(1000000),
          expectedCancellationToken: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          reason,
        })
        .strict(),
    })
    .strict(),
]);
const bad = (): never => {
  throw new ApiClientError('Invoice draft response could not be confirmed. Read the original receipt.', {
    status: 503,
  });
};
const current = (c: RateContext | null, mode: 'view' | 'prepare' | 'cancel') => {
  const keys = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'employees.view',
    'notifications.view',
    ...(mode === 'view' ? [] : ['commercial.invoice_drafts.' + mode]),
  ];
  if (!c || !isRateContextCurrent(c) || !keys.every(hasRatePermission))
    throw new ApiClientError('Current invoice scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  mode: 'view' | 'prepare' | 'cancel',
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
    '/api/v1/invoice-drafts' + path,
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
const reconciliationTotals = {
  controls: z.array(
    z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        boundary: z.enum([
          'EVENT_BACKED_SOURCE',
          'ELIGIBILITY_EVENT',
          'REGISTER_ITEM',
          'CURRENT_OCCUPANCY',
          'CURRENT_LINE',
          'EXPORTED_LINE',
          'MANUALLY_CONFIRMED_LINE',
          'HISTORICAL_RELEASED_LINE',
        ]),
        lineCount: z.number().int().nonnegative(),
        amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
      })
      .strict(),
  ),
  totals: z.array(
    z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        status: z.enum(['OCCUPIED', 'AVAILABLE', 'SOURCE_UNAVAILABLE']),
        lineCount: z.number().int().nonnegative(),
        amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
      })
      .strict(),
  ),
};
const balanceAmount = z.string().max(40).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/);
const balanceUnits = (value: string) => {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer + fraction.padEnd(4, '0'));
};
const fixedFeeBalance = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(['Available', 'Reserved', 'Exported', 'Confirmed']),
  installments: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
  gross: balanceAmount, adjustments: balanceAmount, net: balanceAmount,
}).strict().refine(row => {
  if (![row.gross,row.adjustments,row.net].every(value => balanceAmount.safeParse(value).success)) return false;
  const gross = balanceUnits(row.gross), credits = balanceUnits(row.adjustments);
  return row.installments + row.credits > 0 && gross >= 0n && credits <= 0n &&
    (row.installments === 0) === (gross === 0n) && (row.credits === 0) === (credits === 0n) &&
    gross + credits === balanceUnits(row.net);
});
export type FixedFeeBalance=z.infer<typeof fixedFeeBalance>;
export const invoiceDrafts = {
  fixedFeeBalances: async(engagementId:string,c:RateContext|null):Promise<FixedFeeBalance[]>=>{
    const allowed=()=>hasRatePermission('commercial.fixed_fee_eligibility.issue') && hasRatePermission('commercial.invoice_export.view');
    if (!allowed() || !id.safeParse(engagementId).success) return bad();
    const raw=await call('GET','/reconciliation/fixed-fee?'+new URLSearchParams({engagementId}),c,'view');
    const report=z.object({...envelope,engagementId:id,balances:z.array(fixedFeeBalance)}).strict().safeParse(raw);
    if (!allowed() || !report.success || report.data.engagementId!==engagementId) return bad();
    const keys=report.data.balances.map(row=>row.currency+row.status);
    if (new Set(keys).size!==keys.length) return bad();
    return report.data.balances;
  },
  availableInstallments: async(batchId:string,c:RateContext|null,after?:string)=>{
    if (!uuid.safeParse(batchId).success || !hasRatePermission('commercial.fixed_fee_eligibility.issue')) return bad();
    const data=await call('GET','/batches/'+batchId+'/available-installments'+(after?'?after='+encodeURIComponent(after):''),c,'view');
    const result=z.object({...envelope,batchId:z.literal(batchId),nextAfter:uuid.nullable(),
      items:z.array(z.object({id:uuid,installment:z.number().int().positive(),dueOn:date,currency:z.string(),amount}).strict()).max(50)
    }).strict().safeParse(data);
    if (!result.success) return bad();
    return result.data;
  },
  portfolio: async (
    start: string,
    end: string,
    source: 'both' | 'time_and_materials' | 'milestone',
    c: RateContext | null,
  ) => {
    const allowed = () =>
      hasRatePermission('commercial.invoice_export.view') &&
      (source === 'time_and_materials' || hasRatePermission('commercial.milestone_billing.view'));
    if (!date.safeParse(start).success || !date.safeParse(end).success || start > end || !allowed())
      return bad();
    const raw = await call(
      'GET',
      '/reconciliation/portfolio?' + new URLSearchParams({ start, end, source, forExport: 'true' }),
      c,
      'view',
    );
    const parsed = z
      .object({
        ...envelope,
        version: z.literal('workos.portfolio-reconciliation/1'),
        reportToken: z.string().regex(/^[a-f0-9]{64}$/),
        start: date,
        end: date,
        source: z.enum(['both', 'time_and_materials', 'milestone']),
        asOf: instant,
        ...reconciliationTotals,
        exceptionCount: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(raw);
    if (
      !parsed.success ||
      !allowed() ||
      parsed.data.start !== start ||
      parsed.data.end !== end ||
      parsed.data.source !== source
    )
      return bad();
    return parsed.data;
  },

  reconciliation: async (engagementId: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success || !hasRatePermission('commercial.invoice_export.view'))
      return bad();
    const raw = await call('GET', '/reconciliation?' + new URLSearchParams({ engagementId }), c, 'view');
    if (!hasRatePermission('commercial.invoice_export.view')) return bad();
    const commonRow = z
      .object({
        itemId: uuid,
        itemVersion: z.literal(1),
        eventId: uuid,
        eventVersion: z.literal(1),
        eligibilityApprovalId: uuid,
        eligibilityDecisionId: uuid,
        clientId: id,
        contractId: id,
        engagementId: id,
        eligibleOn: date,
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount,
        sourceAmount: amount,
        sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
        sourceMatches: z.boolean(),
        sourceCurrent: z.boolean(),
        batchId: uuid.nullable(),
        lineId: uuid.nullable(),
        acquisitionRequestId: uuid.nullable(),
        acquisitionOperationId: id.nullable(),
        lineAmount: amount.nullable(),
        lineCurrency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable(),
        batchState: z
          .enum(['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed', 'Cancelled'])
          .nullable(),
        artifactId: uuid.nullable(),
        artifactHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        confirmationId: uuid.nullable(),
        lineMatches: z.boolean(),
        artifactMatches: z.boolean(),
        historicalLineCount: z.number().int().nonnegative(),
        history: z.array(
          z
            .object({
              lineId: uuid,
              batchId: uuid,
              batchState: z.enum([
                'Draft',
                'Under Review',
                'Approved',
                'Exported',
                'Billed/Confirmed',
                'Cancelled',
              ]),
              amount,
              currency: z.string().regex(/^[A-Z]{3}$/),
              matches: z.boolean(),
            })
            .strict(),
        ),
        status: z.enum(['OCCUPIED', 'AVAILABLE', 'SOURCE_UNAVAILABLE']),
        controlOk: z.boolean(),
      })
      .strict();
    const row = z.discriminatedUnion('sourceType', [
      commonRow.extend({ sourceType: z.literal('TM_SNAPSHOT'), snapshotId: uuid, evidence }),
      commonRow.extend({
        sourceType: z.literal('MILESTONE_ACCEPTANCE'),
        snapshotId: z.null(),
        milestoneId: id,
        evidence: milestoneInvoiceEvidence,
        acceptanceMatches: z.boolean(),
      }),
    ]);
    const report = z
      .object({
        ...envelope,
        asOf: instant,
        engagementId: id,
        version: z.enum(['workos.tm-reconciliation/1', 'workos.milestone-reconciliation/1']),
        reportToken: z.string().regex(/^[a-f0-9]{64}$/),
        items: z.array(row).max(500),
        missingEvents: z
          .array(
            z
              .object({
                eventId: uuid,
                snapshotId: uuid.nullable(),
                milestoneId: id.optional(),
                currency: z.string().regex(/^[A-Z]{3}$/),
                amount,
                sourceAmount: amount,
                sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
              })
              .strict(),
          )
          .max(500),
        ...reconciliationTotals,
        exceptionCount: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(raw);
    if (!report.success || report.data.engagementId !== engagementId) return bad();
    const value = report.data,
      keys = new Set<string>();
    const milestone = value.version === 'workos.milestone-reconciliation/1';
    if (
      (milestone && !hasRatePermission('commercial.milestone_billing.view')) ||
      value.missingEvents.some((e) =>
        milestone ? !e.milestoneId || e.snapshotId !== null : !e.snapshotId || e.milestoneId !== undefined,
      ) ||
      value.exceptionCount !== value.items.filter((x) => !x.controlOk).length + value.missingEvents.length ||
      value.items.some(
        (x) =>
          x.historicalLineCount !== x.history.length ||
          x.engagementId !== engagementId ||
          x.sourceMatches !==
            (x.sourceCurrency === x.currency &&
              canonicalHours(x.sourceAmount) === canonicalHours(x.amount)) ||
          milestone !== (x.sourceType === 'MILESTONE_ACCEPTANCE') ||
          (x.sourceType === 'MILESTONE_ACCEPTANCE'
            ? x.milestoneId !== x.evidence.milestoneId ||
              x.engagementId !== x.evidence.engagementId ||
              x.eligibilityDecisionId !== x.evidence.decisionId
            : x.snapshotId !== x.evidence.snapshotId) ||
          x.currency !== x.evidence.currency ||
          canonicalHours(x.amount) !== canonicalHours(x.evidence.amount) ||
          x.status !== (x.batchId ? 'OCCUPIED' : x.sourceCurrent ? 'AVAILABLE' : 'SOURCE_UNAVAILABLE') ||
          Boolean(x.batchId) !== Boolean(x.lineId) ||
          Boolean(x.batchId) !== Boolean(x.acquisitionRequestId) ||
          Boolean(x.batchId) !== Boolean(x.acquisitionOperationId) ||
          x.controlOk !==
            (x.sourceMatches &&
              (x.sourceType !== 'MILESTONE_ACCEPTANCE' || x.acceptanceMatches) &&
              x.lineMatches &&
              x.artifactMatches &&
              x.history.every((h) => h.batchState === 'Cancelled' && h.matches) &&
              (!x.batchId ||
                ['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed'].includes(
                  x.batchState ?? '',
                )) &&
              (!['Exported', 'Billed/Confirmed'].includes(x.batchState ?? '') || !!x.artifactId) &&
              (x.batchState !== 'Billed/Confirmed' || !!x.confirmationId)),
      )
    )
      return bad();
    for (const t of value.totals) {
      const k = t.currency + ':' + t.status;
      if (keys.has(k)) return bad();
      keys.add(k);
      const selected = value.items.filter((x) => x.currency === t.currency && x.status === t.status),
        sum = invoiceDraftTotal(selected.map((x) => x.amount));
      if (
        !selected.length ||
        sum.lineCount !== t.lineCount ||
        canonicalHours(sum.amount) !== canonicalHours(t.amount)
      )
        return bad();
    }
    if (value.items.some((x) => !keys.has(x.currency + ':' + x.status))) return bad();
    const grouped = new Map<string, string[]>(),
      add = (currency: string, boundary: string, v: string) => {
        const k = currency + ':' + boundary;
        grouped.set(k, [...(grouped.get(k) ?? []), v]);
      };
    for (const x of value.items) {
      add(x.sourceCurrency, 'EVENT_BACKED_SOURCE', x.sourceAmount);
      add(x.currency, 'ELIGIBILITY_EVENT', x.amount);
      add(x.currency, 'REGISTER_ITEM', x.amount);
      if (x.batchId) {
        add(x.currency, 'CURRENT_OCCUPANCY', x.amount);
        if (x.lineCurrency && x.lineAmount) {
          add(x.lineCurrency, 'CURRENT_LINE', x.lineAmount);
          if (['Exported', 'Billed/Confirmed'].includes(x.batchState ?? ''))
            add(x.lineCurrency, 'EXPORTED_LINE', x.lineAmount);
          if (x.batchState === 'Billed/Confirmed')
            add(x.lineCurrency, 'MANUALLY_CONFIRMED_LINE', x.lineAmount);
        }
      }
      for (const h of x.history)
        if (h.batchState === 'Cancelled') add(h.currency, 'HISTORICAL_RELEASED_LINE', h.amount);
    }
    for (const x of value.missingEvents) {
      add(x.sourceCurrency, 'EVENT_BACKED_SOURCE', x.sourceAmount);
      add(x.currency, 'ELIGIBILITY_EVENT', x.amount);
    }
    const seen = new Set<string>();
    for (const t of value.controls) {
      const k = t.currency + ':' + t.boundary,
        amounts = grouped.get(k);
      if (!amounts || seen.has(k)) return bad();
      seen.add(k);
      const total = invoiceDraftTotal(amounts);
      if (total.lineCount !== t.lineCount || canonicalHours(total.amount) !== canonicalHours(t.amount))
        return bad();
    }
    if (seen.size !== grouped.size) return bad();
    return value;
  },
  exportReconciliation: async (
    report:
      | { engagementId: string; reportToken: string; version?: string }
      | {
          start: string;
          end: string;
          source: 'both' | 'time_and_materials' | 'milestone';
          reportToken: string;
          version: 'workos.portfolio-reconciliation/1';
        },
    requestId: string,
    why: string,
    c: RateContext | null,
  ) => {
    if (
      !uuid.safeParse(requestId).success ||
      !reason.safeParse(why).success ||
      !hasRatePermission('commercial.invoice_export.view') ||
      !hasRatePermission('reports.export')
    )
      return bad();
    const portfolio = 'source' in report;
    const filters = portfolio
      ? { start: report.start, end: report.end, source: report.source }
      : { engagementId: report.engagementId };
    const milestone = portfolio
      ? report.source !== 'time_and_materials'
      : report.version === 'workos.milestone-reconciliation/1';
    if (milestone && !hasRatePermission('commercial.milestone_billing.view')) return bad();
    const raw = await call(
      'POST',
      portfolio ? '/reconciliation/portfolio/exports' : '/reconciliation/exports',
      c,
      'view',
      { ...filters, expectedReportToken: report.reportToken, requestId, reason: why },
    );
    if (
      !hasRatePermission('commercial.invoice_export.view') ||
      !hasRatePermission('reports.export') ||
      (milestone && !hasRatePermission('commercial.milestone_billing.view'))
    )
      return bad();
    const receipt = {
      ...envelope,
      requestId: uuid,
      asOf: instant,
      reportToken: z.string().regex(/^[a-f0-9]{64}$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      csv: z.string(),
    };
    const out = z
      .discriminatedUnion('version', [
        z
          .object({
            ...receipt,
            engagementId: id,
            version: z.enum(['workos.tm-reconciliation/1', 'workos.milestone-reconciliation/1']),
          })
          .strict(),
        z
          .object({
            ...receipt,
            start: date,
            end: date,
            source: z.enum(['both', 'time_and_materials', 'milestone']),
            version: z.literal('workos.portfolio-reconciliation/1'),
          })
          .strict(),
      ])
      .safeParse(raw);
    if (
      !out.success ||
      out.data.requestId !== requestId ||
      out.data.reportToken !== report.reportToken ||
      out.data.version !== (report.version ?? 'workos.tm-reconciliation/1')
    )
      return bad();
    if ('source' in out.data) {
      if (
        !portfolio ||
        out.data.start !== report.start ||
        out.data.end !== report.end ||
        out.data.source !== report.source
      )
        return bad();
    } else if (portfolio || out.data.engagementId !== report.engagementId) return bad();
    const data = new TextEncoder().encode(out.data.csv),
      hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    if (data.length !== out.data.bytes || hash !== out.data.sha256 || !c || !isRateContextCurrent(c))
      return bad();
    return out.data;
  },
  list: async (c: RateContext | null, after?: string) => {
    if (after && !uuid.safeParse(after).success) return bad();
    const raw = await call(
        'GET',
        '/batches' + (after ? '?' + new URLSearchParams({ after }) : ''),
        c,
        'view',
      ),
      out = z
        .object({ ...envelope, batches: z.array(batch).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(raw);
    if (!out.success) return bad();
    return out.data;
  },
  inspect: async (batchId: string, c: RateContext | null, forCancellation = false) => {
    if (!uuid.safeParse(batchId).success) return bad();
    const raw = await call(
        'GET',
        '/batches/' + batchId + (forCancellation ? '?forCancellation=true' : ''),
        c,
        forCancellation ? 'cancel' : 'view',
      ),
      out = z
        .object({
          ...detail,
          cancellationToken: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .safeParse(raw);
    if (
      !out.success ||
      (forCancellation && !out.data.cancellationToken) ||
      out.data.batch.id !== batchId ||
      !checkDetail(out.data.batch, out.data.lines, out.data.total, out.data.cancellation)
    )
      return bad();
    return out.data;
  },
  run: async (op: InvoiceDraftOperation, c: RateContext | null, receipt = false) => {
    if (!operation.safeParse(op).success) return bad();
    const mode = receipt ? 'view' : op.type === 'cancellation' ? 'cancel' : 'prepare',
      path = receipt
        ? '/receipts/' + op.type + '/' + op.data.requestId
        : op.type === 'batch'
          ? '/batches'
          : '/batches/' + op.batchId + '/' + (op.type === 'line' ? 'lines' : 'cancellations'),
      raw = await call(receipt ? 'GET' : 'POST', path, c, mode, receipt ? undefined : op.data),
      out = z
        .object({
          ...detail,
          ...(receipt ? { type: z.literal(op.type) } : { replayed: z.boolean() }),
          ...(op.type === 'line' ? { line } : {}),
        })
        .strict()
        .safeParse(raw);
    if (!out.success || !checkDetail(out.data.batch, out.data.lines, out.data.total, out.data.cancellation))
      return bad();
    const result = out.data;
    if (op.type === 'batch') {
      const b = result.batch,
        def = op.data.definition as Record<string, unknown>,
        observed = {
          clientId: b.clientId,
          contractId: b.contractId,
          engagementId: b.engagementId,
          currency: b.currency,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          periodBasis: b.periodBasis,
          ownerUserId: b.ownerUserId,
          ownerRole: b.ownerRole,
        };
      if (
        canonical(observed) !== canonical(def) ||
        b.requestId !== op.data.requestId ||
        b.reason !== op.data.reason ||
        b.preparerUserId !== result.actorUserId ||
        b.preparerRole !== result.activeRole
      )
        return bad();
    } else if (op.type === 'line') {
      if (result.batch.id !== op.batchId || !('line' in result)) return bad();
      const l = result.line;
      if (
        l.batchId !== op.batchId ||
        l.itemId !== op.data.itemId ||
        l.itemVersion !== op.data.itemVersion ||
        l.sequence !== op.data.expectedLineCount + 1 ||
        l.requestId !== op.data.requestId ||
        l.reason !== op.data.reason ||
        l.actorId !== result.actorUserId ||
        l.activeRole !== result.activeRole ||
        !result.lines.some((x) => x.id === l.id)
      )
        return bad();
    } else {
      const q = result.cancellation;
      if (
        result.batch.id !== op.batchId ||
        !q ||
        q.batchId !== op.batchId ||
        q.requestId !== op.data.requestId ||
        q.expectedLineCount !== op.data.expectedLineCount ||
        q.reason !== op.data.reason ||
        q.actorId !== result.actorUserId ||
        q.activeRole !== result.activeRole
      )
        return bad();
    }
    return result;
  },
};
