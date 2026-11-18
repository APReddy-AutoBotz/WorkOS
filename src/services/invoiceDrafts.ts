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
    state: z.enum(['Draft', 'Under Review', 'Approved', 'Cancelled']),
  })
  .strict()
  .refine((x) => x.periodStart <= x.periodEnd);
const line = z
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
      lines.every(
        (l, i) =>
          l.batchId === x.id &&
          l.sequence === i + 1 &&
          l.evidence.engagementId === x.engagementId &&
          l.evidence.references.find((r) => r.entityType === 'Contract')?.entityId === x.contractId &&
          l.currency === x.currency,
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
      data: { requestId: string; expectedLineCount: number; reason: string };
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
        .object({ requestId: uuid, expectedLineCount: z.number().int().min(0).max(1000000), reason })
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
export const invoiceDrafts = {
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
  inspect: async (batchId: string, c: RateContext | null) => {
    if (!uuid.safeParse(batchId).success) return bad();
    const raw = await call('GET', '/batches/' + batchId, c, 'view'),
      out = z.object(detail).strict().safeParse(raw);
    if (
      !out.success ||
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
