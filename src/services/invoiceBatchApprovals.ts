import { z } from 'zod';
import {
  validInvoiceBatchApprovalPolicy,
  invoiceBatchApprovalState,
} from '../../shared/invoice-batch-approval.mjs';
import { invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
import { canonicalHours } from '../../shared/work-hours.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x))),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  money = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
  def = z.unknown().refine(validInvoiceBatchApprovalPolicy),
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
    amount: money,
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
const line = z
  .object({
    id: uuid,
    sequence: z.number().int().positive(),
    itemId: uuid,
    itemVersion: z.literal(1),
    eventId: uuid,
    snapshotId: uuid,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: money,
    evidence,
  })
  .strict();
const source = z
  .object({
    id: uuid,
    state: z.enum(['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed', 'Cancelled']),
    current: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    clientId: id,
    contractId: id,
    engagementId: id,
    periodStart: date,
    periodEnd: date,
    periodBasis: z.enum(['WORK_DATE', 'ELIGIBLE_DATE']),
    lineageHash: hash,
    lines: z.array(line),
    total: money,
    lineCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => {
    try {
      const sum = invoiceDraftTotal(v.lines.map((x) => x.amount));
      return (
        v.periodStart <= v.periodEnd &&
        sum.lineCount === v.lineCount &&
        canonicalHours(sum.amount) === canonicalHours(v.total) &&
        v.lines.every(
          (x, n) =>
            x.sequence === n + 1 &&
            x.snapshotId === x.evidence.snapshotId &&
            x.currency === v.currency &&
            x.currency === x.evidence.currency &&
            canonicalHours(x.amount) === canonicalHours(x.evidence.amount) &&
            x.evidence.engagementId === v.engagementId &&
            x.evidence.references.find((r) => r.entityType === 'Contract')?.entityId === v.contractId,
        )
      );
    } catch {
      return false;
    }
  });
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
    .refine((v) => (v.sequence === 1 ? v.previousId === null : v.previousId !== null)),
  transition = z
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
    .strict(),
  cancellation = z
    .object({ id: uuid, actorId: uuid, activeRole: id, requestId: uuid, reason, createdAt: instant })
    .strict();
const approval = z
  .object({
    id: uuid,
    batchId: uuid,
    sequence: z.number().int().positive(),
    ownerUserId: uuid,
    ownerRole: id,
    preparerUserId: uuid,
    preparerRole: id,
    requesterUserId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    lineCount: z.number().int().positive(),
    lineageHash: hash,
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: money,
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
        state = invoiceBatchApprovalState(d, v.transitions);
      return (
        d.engagementId === v.policy.engagementId &&
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
  ownerKey: hash,
  actorUserId: uuid,
  activeRole: id,
  organizationId: id,
  legalEntityId: id,
  serverDate: date,
};
export type InvoiceBatchPolicy = z.infer<typeof policy>;
export type InvoiceBatchApproval = z.infer<typeof approval>;
export type InvoiceApprovalSource = z.infer<typeof source>;
export type InvoiceApprovalOperation =
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
        batchId: string;
        expectedPolicyId: string;
        expectedLineCount: number;
        expectedLineageHash: string;
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
  | { type: 'withdrawal'; id: string; data: { requestId: string; reason: string } };
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
          batchId: uuid,
          expectedPolicyId: uuid,
          expectedLineCount: z.number().int().min(1).max(1000000),
          expectedLineageHash: hash,
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
    .object({ type: z.literal('withdrawal'), id: uuid, data: z.object({ requestId: uuid, reason }).strict() })
    .strict(),
]);
const bad = (): never => {
  throw new ApiClientError('Invoice approval response could not be confirmed. Read the original receipt.', {
    status: 503,
  });
};
const current = (c: RateContext | null, mode: 'read' | 'manager' | 'submitter' | 'decider') => {
  const keys = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'employees.view',
    'notifications.view',
    ...(mode === 'manager' ? ['commercial.contracts.manage', 'commercial.invoice_approval.manage'] : []),
    ...(mode === 'submitter'
      ? ['commercial.invoice_drafts.prepare', 'commercial.invoice_approval.manage']
      : []),
    ...(mode === 'decider' ? ['approvals.view', 'commercial.invoice_approval.decide'] : []),
  ];
  if (!c || !isRateContextCurrent(c) || !keys.every(hasRatePermission))
    throw new ApiClientError('Current invoice approval scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  mode: 'read' | 'manager' | 'submitter' | 'decider',
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
    '/api/v1/invoice-batch-approvals' + path,
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
export const invoiceBatchApprovals = {
  load: async (engagementId: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success) return bad();
    const query = '?' + new URLSearchParams({ engagementId }),
      [a, b] = await Promise.all([
        call('GET', '/policies' + query, c, 'read'),
        call('GET', '/instances' + query, c, 'read'),
      ]),
      p = z
        .object({ ...envelope, policies: z.array(policy).max(20), truncated: z.boolean() })
        .strict()
        .safeParse(a),
      i = z
        .object({ ...envelope, approvals: z.array(approval).max(50), nextAfter: uuid.nullable() })
        .strict()
        .safeParse(b);
    if (
      !p.success ||
      !i.success ||
      p.data.actorUserId !== i.data.actorUserId ||
      p.data.policies.some((x) => x.engagementId !== engagementId) ||
      i.data.approvals.some((x) => x.policy.engagementId !== engagementId)
    )
      return bad();
    return {
      policies: p.data.policies,
      approvals: i.data.approvals,
      policiesTruncated: p.data.truncated,
      approvalsNext: i.data.nextAfter,
    };
  },
  page: async (engagementId: string, after: string, c: RateContext | null) => {
    if (!id.safeParse(engagementId).success || !uuid.safeParse(after).success) return bad();
    const out = z
      .object({ ...envelope, approvals: z.array(approval).max(50), nextAfter: uuid.nullable() })
      .strict()
      .safeParse(await call('GET', '/instances?' + new URLSearchParams({ engagementId, after }), c, 'read'));
    if (!out.success || out.data.approvals.some((x) => x.policy.engagementId !== engagementId)) return bad();
    return out.data;
  },
  source: async (batchId: string, c: RateContext | null) => {
    if (!uuid.safeParse(batchId).success) return bad();
    const out = z
      .object({ ...envelope, batch: source })
      .strict()
      .safeParse(await call('GET', '/sources/' + batchId, c, 'read'));
    if (!out.success || out.data.batch.id !== batchId) return bad();
    return out.data.batch;
  },
  inspect: async (approvalId: string, c: RateContext | null) => {
    if (!uuid.safeParse(approvalId).success) return bad();
    const out = z
      .object({ ...envelope, approval, batch: source })
      .strict()
      .safeParse(await call('GET', '/instances/' + approvalId, c, 'read'));
    if (
      !out.success ||
      out.data.approval.id !== approvalId ||
      out.data.approval.batchId !== out.data.batch.id ||
      out.data.approval.policy.engagementId !== out.data.batch.engagementId
    )
      return bad();
    return out.data;
  },
  run: async (op: InvoiceApprovalOperation, engagementId: string, c: RateContext | null, receipt = false) => {
    if (
      !operation.safeParse(op).success ||
      !id.safeParse(engagementId).success ||
      (op.type === 'policy' &&
        (op.data.engagementId !== engagementId ||
          (op.data.definition as { engagementId: string }).engagementId !== engagementId))
    )
      return bad();
    const mode = receipt
        ? 'read'
        : op.type === 'policy'
          ? 'manager'
          : op.type === 'decision'
            ? 'decider'
            : 'submitter',
      path = receipt
        ? '/receipts/' + op.type + '/' + op.data.requestId
        : op.type === 'policy'
          ? '/policies'
          : op.type === 'request'
            ? '/requests'
            : '/instances/' + op.id + '/' + (op.type === 'decision' ? 'decisions' : 'withdrawals'),
      raw = await call(receipt ? 'GET' : 'POST', path, c, mode, receipt ? undefined : op.data);
    if (op.type === 'policy') {
      const out = z
        .object({
          ...envelope,
          ...(receipt ? { type: z.literal('policy') } : { replayed: z.boolean() }),
          policy,
        })
        .strict()
        .safeParse(raw);
      if (
        !out.success ||
        out.data.policy.engagementId !== engagementId ||
        out.data.policy.previousId !== op.data.expectedLatestId ||
        out.data.policy.requestId !== op.data.requestId ||
        out.data.policy.reason !== op.data.reason ||
        canonical(out.data.policy.definition) !== canonical(op.data.definition) ||
        out.data.policy.effectiveFrom !== op.data.effectiveFrom ||
        out.data.policy.actorId !== out.data.actorUserId ||
        out.data.policy.activeRole !== out.data.activeRole
      )
        return bad();
      return out.data.policy;
    }
    const out = z
      .object({
        ...envelope,
        ...(receipt ? { type: z.literal(op.type) } : { replayed: z.boolean() }),
        approval,
      })
      .strict()
      .safeParse(raw);
    if (!out.success || out.data.approval.policy.engagementId !== engagementId) return bad();
    const a = out.data.approval;
    if (
      op.type === 'request' &&
      (a.requestId !== op.data.requestId ||
        a.batchId !== op.data.batchId ||
        a.policy.id !== op.data.expectedPolicyId ||
        a.lineCount !== op.data.expectedLineCount ||
        a.lineageHash !== op.data.expectedLineageHash ||
        a.reason !== op.data.reason ||
        a.requesterUserId !== out.data.actorUserId ||
        a.activeRole !== out.data.activeRole)
    )
      return bad();
    if (op.type === 'decision') {
      const t = a.transitions.find((x) => x.requestId === op.data.requestId);
      if (
        a.id !== op.id ||
        !t ||
        t.actorId !== out.data.actorUserId ||
        t.activeRole !== out.data.activeRole ||
        t.reason !== op.data.reason ||
        t.decision !== op.data.decision ||
        t.sequence !== op.data.expectedSequence + 1
      )
        return bad();
    }
    if (
      op.type === 'withdrawal' &&
      (a.id !== op.id ||
        !a.cancellation ||
        a.cancellation.requestId !== op.data.requestId ||
        a.cancellation.actorId !== out.data.actorUserId ||
        a.cancellation.activeRole !== out.data.activeRole ||
        a.cancellation.reason !== op.data.reason)
    )
      return bad();
    return a;
  },
};
