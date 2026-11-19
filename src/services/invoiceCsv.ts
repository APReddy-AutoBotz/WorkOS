import { verifyMilestoneInvoiceCsv } from './milestoneInvoiceCsv';
import { validInvoiceConfirmationCommand } from '../../shared/invoice-billing-confirmation.mjs';
import { z } from 'zod';
import { invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
import { canonicalHours, compareHours } from '../../shared/work-hours.mjs';
import { api, ApiClientError } from './apiClient';
import { captureRateContext } from './rateCandidates';
import { hasRatePermission, isRateContextCurrent, type RateContext } from './rateCandidates';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  money = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
  instant = z.string().refine((x) => Number.isFinite(Date.parse(x))),
  schema = z.enum(['workos.invoice-tm-csv/1', 'workos.invoice-milestone-csv/1']),
  envelope = {
    ownerKey: hash,
    actorUserId: uuid,
    activeRole: id,
    organizationId: id,
    legalEntityId: id,
    serverDate: date,
  };
const reference = z
    .object({
      entityType: z.enum(['Project', 'Engagement', 'Contract']),
      entityId: id,
      lifecycleEventId: id,
      contractVersionId: id,
    })
    .strict(),
  billingEvidence = z
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
    .strict();
const tmLine = z
    .object({
      lineId: uuid,
      sequence: z.number().int().positive(),
      itemId: uuid,
      itemVersion: z.literal(1),
      eventId: uuid,
      snapshotId: uuid,
      workDate: date,
      eligibleDate: date,
      currency: z.string().regex(/^[A-Z]{3}$/),
      amount: money,
    })
    .strict(),
  control = z
    .object({
      lineCount: z.number().int().positive(),
      total: money,
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict();
const milestoneLine = z
  .object({
    lineId: uuid,
    sequence: z.number().int().positive(),
    itemId: uuid,
    itemVersion: z.literal(1),
    eventId: uuid,
    sourceType: z.literal('MILESTONE_ACCEPTANCE'),
    milestoneId: id,
    eligibleDate: date,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: money,
  })
  .strict();
const line = z.union([tmLine, milestoneLine]);
const source = z
  .object({
    id: uuid,
    sourceType: z.literal('MILESTONE_ACCEPTANCE').optional(),
    state: z.enum(['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed', 'Cancelled']),
    clientId: id,
    contractId: id,
    engagementId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    periodStart: date,
    periodEnd: date,
    periodBasis: z.enum(['WORK_DATE', 'ELIGIBLE_DATE']),
    approvalId: uuid.nullable(),
    finalTransitionId: uuid.nullable(),
    lineageHash: hash.nullable(),
    sourceCurrent: z.boolean(),
    artifactId: uuid.nullable(),
    lines: z.array(line),
    control: control.nullable(),
  })
  .strict()
  .refine((v) => {
    if (
      v.periodStart > v.periodEnd ||
      (v.sourceType &&
        (!hasRatePermission('commercial.milestone_billing.view') || v.periodBasis !== 'ELIGIBLE_DATE')) ||
      v.lines.some((x) => 'sourceType' in x !== (v.sourceType === 'MILESTONE_ACCEPTANCE'))
    )
      return false;
    if (['Exported', 'Billed/Confirmed'].includes(v.state) !== Boolean(v.artifactId)) return false;
    if (v.control === null) return !v.sourceCurrent;
    try {
      const total = invoiceDraftTotal(v.lines.map((x) => x.amount));
      return (
        total.lineCount === v.control.lineCount &&
        canonicalHours(total.amount) === canonicalHours(v.control.total) &&
        v.control.currency === v.currency &&
        v.lines.every(
          (x, n) =>
            x.sequence === n + 1 &&
            x.currency === v.currency &&
            ('sourceType' in x
              ? v.sourceType === 'MILESTONE_ACCEPTANCE' &&
                hasRatePermission('commercial.milestone_billing.view') &&
                v.periodBasis === 'ELIGIBLE_DATE' &&
                x.eligibleDate >= v.periodStart &&
                x.eligibleDate <= v.periodEnd
              : !v.sourceType &&
                (v.periodBasis === 'WORK_DATE' ? x.workDate : x.eligibleDate) >= v.periodStart &&
                (v.periodBasis === 'WORK_DATE' ? x.workDate : x.eligibleDate) <= v.periodEnd),
        )
      );
    } catch {
      return false;
    }
  });
const artifact = z
    .object({
      id: uuid,
      batchId: uuid,
      approvalId: uuid,
      finalTransitionId: uuid,
      lineageHash: hash,
      schemaVersion: schema,
      version: z.literal(1),
      sha256: hash,
      lineCount: z.number().int().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      total: money,
      actorId: uuid,
      activeRole: id,
      requestId: uuid,
      reason,
      operationId: id,
      generatedAt: instant,
      payloadBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
  failure = z
    .object({
      id: uuid,
      batchId: uuid,
      code: z.literal('ARTIFACT_GENERATION_FAILED'),
      actorId: uuid,
      activeRole: id,
      requestId: uuid,
      reason,
      operationId: id,
      createdAt: instant,
    })
    .strict();
export type InvoiceCsvSource = z.infer<typeof source>;
export type InvoiceCsvArtifact = z.infer<typeof artifact>;
export type InvoiceCsvOperation = {
  requestId: string;
  batchId: string;
  approvalId: string;
  finalTransitionId: string;
  lineageHash: string;
  schemaVersion: 'workos.invoice-tm-csv/1' | 'workos.invoice-milestone-csv/1';
  expectedLineCount: number;
  expectedTotal: string;
  reason: string;
};
const operation = z
    .object({
      requestId: uuid,
      batchId: uuid,
      approvalId: uuid,
      finalTransitionId: uuid,
      lineageHash: hash,
      schemaVersion: schema,
      expectedLineCount: z.number().int().min(1).max(1000000),
      expectedTotal: money,
      reason,
    })
    .strict(),
  bad = (): never => {
    throw new ApiClientError('Invoice CSV response could not be confirmed. Read the original receipt.', {
      status: 503,
    });
  };
const current = (c: RateContext | null, kind: 'view' | 'create' | 'recover' | 'confirm') => {
  const keys = [
    'commercial.contracts.view',
    'commercial.tm_billing.view',
    'commercial.invoice_drafts.view',
    'commercial.invoice_export.view',
    'employees.view',
    'notifications.view',
    ...(kind === 'create'
      ? ['commercial.invoice_export.create']
      : kind === 'recover'
        ? ['commercial.invoice_export.recover_notices']
        : kind === 'confirm'
          ? ['commercial.invoice_batch.confirm']
          : []),
  ];
  if (!c || !isRateContextCurrent(c) || !keys.every(hasRatePermission))
    throw new ApiClientError('Current invoice export scope or permission changed.', { status: 403 });
  return c;
};
const call = async (
  method: 'GET' | 'POST',
  path: string,
  c: RateContext | null,
  kind: 'view' | 'create' | 'recover' | 'confirm',
  body?: object,
) => {
  const ctx = current(c, kind),
    ownerKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))),
      ),
    )
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  current(ctx, kind);
  const raw = await api.requestWithContext<unknown>(
    method,
    '/api/v1/invoice-csv' + path,
    body ? { ...body, expectedOwnerKey: ownerKey } : undefined,
    ctx,
  );
  current(ctx, kind);
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
const decodeBase64 = (v: string) => {
  try {
    const text = atob(v),
      bytes = Uint8Array.from(text, (x) => x.charCodeAt(0));
    if (btoa(text) !== v) return bad();
    return bytes;
  } catch {
    return bad();
  }
};
const checkArtifact = async (a: InvoiceCsvArtifact) => {
  if (a.schemaVersion === 'workos.invoice-milestone-csv/1') {
    if (!hasRatePermission('commercial.milestone_billing.view')) return bad();
    try {
      return await verifyMilestoneInvoiceCsv(a);
    } catch {
      return bad();
    }
  }
  try {
    const bytes = decodeBase64(a.payloadBase64),
      digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    if (digest !== a.sha256) return bad();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      rows = text.split('\r\n'),
      head =
        'schema_version,batch_id,line_id,line_sequence,item_id,item_version,event_id,snapshot_id,billing_evidence_b64,client_id_b64,contract_id_b64,engagement_id_b64,work_date,eligible_date,currency,amount,period_start,period_end,period_basis';
    if (rows[0] !== head || rows.at(-1) !== '' || rows.length !== a.lineCount + 2) return bad();
    const amounts: string[] = [],
      seen = new Set<string>();
    let sourceIdentity: string | null = null;
    for (const [n, row] of rows.slice(1, -1).entries()) {
      const c = row.split(',');
      if (
        c.length !== 19 ||
        c[0] !== a.schemaVersion ||
        c[1] !== a.batchId ||
        !uuid.safeParse(c[2]).success ||
        c[3] !== String(n + 1) ||
        !uuid.safeParse(c[4]).success ||
        c[5] !== '1' ||
        !uuid.safeParse(c[6]).success ||
        !uuid.safeParse(c[7]).success ||
        seen.has(c[4]) ||
        !date.safeParse(c[12]).success ||
        !date.safeParse(c[13]).success ||
        c[14] !== a.currency ||
        !money.safeParse(c[15]).success ||
        !date.safeParse(c[16]).success ||
        !date.safeParse(c[17]).success ||
        c[16] > c[17] ||
        !['WORK_DATE', 'ELIGIBLE_DATE'].includes(c[18]) ||
        (c[18] === 'WORK_DATE' ? c[12] : c[13]) < c[16] ||
        (c[18] === 'WORK_DATE' ? c[12] : c[13]) > c[17]
      )
        return bad();
      seen.add(c[4]);
      const decoded = c.slice(8, 12).map((value) => {
        if (!value.startsWith('b64:') || !value.slice(4)) return bad();
        return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value.slice(4)));
      });
      const identity = JSON.stringify([...decoded.slice(1), ...c.slice(16, 19)]);
      if (sourceIdentity !== null && sourceIdentity !== identity) return bad();
      sourceIdentity = identity;
      const e = billingEvidence.safeParse(JSON.parse(decoded[0]));
      if (
        !e.success ||
        e.data.snapshotId !== c[7] ||
        e.data.engagementId !== decoded[3] ||
        e.data.workDate !== c[12] ||
        e.data.currency !== c[14] ||
        canonicalHours(e.data.amount) !== canonicalHours(c[15]) ||
        e.data.references.find((x) => x.entityType === 'Project')?.entityId !== e.data.projectId ||
        e.data.references.find((x) => x.entityType === 'Engagement')?.entityId !== decoded[3] ||
        e.data.references.find((x) => x.entityType === 'Contract')?.entityId !== decoded[2] ||
        new Set(e.data.references.map((x) => x.entityType)).size !== 3 ||
        new Set(e.data.references.map((x) => x.contractVersionId)).size !== 1 ||
        !id.safeParse(decoded[1]).success
      )
        return bad();
      amounts.push(c[15]);
    }
    const sum = invoiceDraftTotal(amounts);
    if (sum.lineCount !== a.lineCount || canonicalHours(sum.amount) !== canonicalHours(a.total)) return bad();
    return bytes;
  } catch {
    return bad();
  }
};
const recoveryTarget = z
  .object({ id: uuid, kind: z.enum(['event', 'producer']), policyId: uuid, createdAt: instant })
  .strict();
const recovery = z
  .object({
    id: uuid,
    batchId: uuid,
    policyId: uuid,
    eventId: uuid.nullable(),
    producerFailureId: uuid.nullable(),
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    operationId: id,
    createdAt: instant,
  })
  .strict()
  .refine((v) => Boolean(v.eventId) !== Boolean(v.producerFailureId));
export type InvoiceNoticeRecoveryTarget = z.infer<typeof recoveryTarget>;
export type InvoiceNoticeRecoveryOperation = {
  requestId: string;
  batchId: string;
  policyId: string;
  eventId: string | null;
  producerFailureId: string | null;
  reason: string;
};
const confirmation = z
  .object({
    id: uuid,
    sourceType: z.literal('MILESTONE_ACCEPTANCE').optional(),
    batchId: uuid,
    artifactId: uuid,
    artifactVersion: z.literal(1),
    artifactSha256: hash,
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: money,
    method: z.literal('MANUAL_ATTESTATION'),
    reference: id,
    actorId: uuid,
    activeRole: id,
    requestId: uuid,
    reason,
    operationId: id,
    confirmedAt: instant,
  })
  .strict()
  .refine((v) => {
    try {
      return (
        (!v.sourceType || hasRatePermission('commercial.milestone_billing.view')) &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(v.reference) &&
        canonicalHours(v.total) === v.total &&
        compareHours(v.total, '0') > 0
      );
    } catch {
      return false;
    }
  });
const confirmationSource = z
  .object({
    sourceType: z.literal('MILESTONE_ACCEPTANCE').optional(),
    batchId: uuid,
    state: z.enum(['Exported', 'Billed/Confirmed']),
    artifactId: uuid,
    artifactVersion: z.literal(1),
    artifactSha256: hash,
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: money,
  })
  .strict()
  .refine((v) => {
    try {
      return (
        (!v.sourceType || hasRatePermission('commercial.milestone_billing.view')) &&
        canonicalHours(v.total) === v.total &&
        compareHours(v.total, '0') > 0
      );
    } catch {
      return false;
    }
  });
export type InvoiceConfirmationSource = z.infer<typeof confirmationSource>;
export type InvoiceConfirmation = z.infer<typeof confirmation>;
export type InvoiceConfirmationOperation = {
  sourceType?: 'MILESTONE_ACCEPTANCE';
  requestId: string;
  batchId: string;
  artifactId: string;
  artifactVersion: 1;
  artifactSha256: string;
  currency: string;
  total: string;
  reference: string;
  reason: string;
};
export { captureRateContext };
const reversalRequest = z.object({
  id: uuid, lineId: uuid, artifactId: uuid, confirmationId: uuid.nullable(),
  reason: z.string().min(3).max(1000), actorId: uuid, activeRole: z.string().min(1), createdAt: z.string().datetime(),
}).strict();
export type InvoiceLineReversalRequest = z.infer<typeof reversalRequest>;
const reviewRoute = z.discriminatedUnion('status', [
  z.object({ status: z.literal('NO_REVERSAL_POLICY') }).strict(),
  z.object({ status: z.literal('REVIEWERS_UNAVAILABLE') }).strict(),
  z.object({
    status: z.literal('AVAILABLE'), policyId: uuid, effectiveFrom: date,
    stages: z.array(z.object({ userId: uuid, role: z.string().min(1) }).strict()).min(1).max(10),
  }).strict(),
]);
const submittedReview = z.object({
  id: uuid, requestId: uuid, policyId: uuid, confirmationId: uuid.nullable(), reviewerId: uuid,
  reviewerRole: id, createdAt: instant, state: z.enum(['Pending','Approved','Rejected']).optional(),
}).strict();
export type SubmittedReversalReview = z.infer<typeof submittedReview>;
export type InvoiceReversalRoute = z.infer<typeof reviewRoute>;
const creditAmount = z.string().regex(/^-(?:0|[1-9]\d*)(?:\.\d{1,4})?$/).refine(v => /[1-9]/.test(v));
const creditSource = z.object({ reviewId:uuid, decisionId:uuid, originalEventId:uuid, confirmationId:uuid.nullable(),
  currency:z.string().regex(/^[A-Z]{3}$/), amount:creditAmount }).strict();
const creditReceipt = z.object({eventId:uuid,itemId:uuid,eligibleOn:date,currency:z.string().regex(/^[A-Z]{3}$/),amount:creditAmount,
  decisionId:uuid,originalEventId:uuid,confirmationId:uuid.nullable(),actorId:uuid,activeRole:id,reason:z.string().min(3).max(1000)}).strict();
export type ReversalCredit = {source:z.infer<typeof creditSource>;receipt:z.infer<typeof creditReceipt>|null;eligibleOn:string};
export const invoiceCsv = {
  reversalCredit: async (batch:InvoiceCsvSource, lineId:string, requestId:string, reviewId:string, c:RateContext, write?:{credit:ReversalCredit;reason:string}):Promise<ReversalCredit> => {
    const line=batch.lines.find(l=>l.lineId===lineId);
    if (!line || !hasRatePermission('commercial.invoice_drafts.prepare') || (write && !hasRatePermission('commercial.reversal_eligibility.create'))) return bad();
    const path='/batches/'+batch.id+'/lines/'+lineId+'/reversal-request/eligibility';
    const data=write?{reviewId,decisionId:write.credit.source.decisionId,confirmationId:write.credit.source.confirmationId,eligibleOn:write.credit.eligibleOn,reason:write.reason}:undefined;
    const raw=await call(write?'POST':'GET',path,c,'view',data);
    const result=z.object({...envelope,requestId:uuid,source:creditSource.nullable(),receipt:creditReceipt.nullable(),...(write?{replayed:z.boolean()}:{})}).strict().safeParse(raw);
    if(!result.success || result.data.requestId!==requestId || !result.data.source) return bad();
    const {source,receipt,serverDate}=result.data;
    if(source.reviewId!==reviewId || source.originalEventId!==line.eventId || source.currency!==line.currency || source.amount!=='-'+line.amount ||
      (receipt && (receipt.decisionId!==source.decisionId || receipt.originalEventId!==source.originalEventId || receipt.currency!==source.currency || receipt.amount!==source.amount))) return bad();
    if(write && (!receipt || receipt.actorId!==result.data.actorUserId || receipt.activeRole!==result.data.activeRole ||
      receipt.eligibleOn!==data?.eligibleOn || receipt.reason!==write.reason || receipt.confirmationId!==data.confirmationId || receipt.decisionId!==data.decisionId)) return bad();
    return {source,receipt,eligibleOn:serverDate};
  },
  submittedReversal: async (batchId: string, request: InvoiceLineReversalRequest, c: RateContext, submission?: {
    policyId: string; inspectedState: 'Exported' | 'Billed/Confirmed'; firstReviewer: {userId: string; role: string};
  }) => {
    if (!hasRatePermission('commercial.invoice_drafts.prepare') || !uuid.safeParse(batchId).success) return bad();
    const path = '/batches/' + batchId + '/lines/' + request.lineId + '/reversal-request/review';
    if (submission) {
      const raw = await call('POST', path, c, 'view', {
        requestId: request.id, policyId: submission.policyId, inspectedState: submission.inspectedState,
      });
      const record = z.object({ ...envelope, requestId: uuid, review: submittedReview, replayed: z.boolean() }).strict().safeParse(raw);
      if (!record.success || record.data.requestId !== request.id || record.data.review.requestId !== request.id ||
        record.data.review.policyId !== submission.policyId || record.data.review.reviewerId !== submission.firstReviewer.userId ||
        record.data.review.reviewerRole !== submission.firstReviewer.role ||
        Boolean(record.data.review.confirmationId) !== (submission.inspectedState === 'Billed/Confirmed')) return bad();
      return { review: record.data.review, canSubmit: false };
    }
    const raw = await call('GET', path, c, 'view');
    const result = z.object({ ...envelope, requestId: uuid, review: submittedReview.nullable(), canSubmit: z.boolean() }).strict().safeParse(raw);
    if (!result.success || result.data.requestId !== request.id || (result.data.review && result.data.review.requestId !== request.id)) return bad();
    return { review: result.data.review, canSubmit: result.data.canSubmit };
  },
  reversalReviewRoute: async (batchId: string, request: InvoiceLineReversalRequest, c: RateContext) => {
    if (!hasRatePermission('commercial.invoice_drafts.prepare') || !uuid.safeParse(batchId).success) return bad();
    const raw = await call('GET', '/batches/' + batchId + '/lines/' + request.lineId + '/reversal-request/review-route', c, 'view');
    const out = z.object({ ...envelope, requestId: uuid, lineId: uuid, route: reviewRoute }).strict().safeParse(raw);
    if (!out.success || out.data.requestId !== request.id || out.data.lineId !== request.lineId) return bad();
    return out.data.route;
  },
  lineReversal: async (batchId: string, lineId: string, artifactId: string, c: RateContext, write?: {
    sha256: string; inspectedState: 'Exported' | 'Billed/Confirmed'; reason: string;
  }) => {
    if (!hasRatePermission('commercial.invoice_drafts.prepare') || ![batchId, lineId, artifactId].every(v => uuid.safeParse(v).success)) return bad();
    const raw = await call(write ? 'POST' : 'GET', '/batches/' + batchId + '/lines/' + lineId + '/reversal-request',
      c, 'view', write ? { ...write, artifactId } : undefined);
    const out = z.object({ ...envelope, request: reversalRequest.nullable(), ...(write ? { replayed: z.boolean() } : {}) }).strict().safeParse(raw);
    if (!out.success || (out.data.request && (out.data.request.lineId !== lineId || out.data.request.artifactId !== artifactId))) return bad();
    if (write && (!out.data.request || out.data.request.reason !== write.reason || out.data.request.actorId !== out.data.actorUserId ||
      out.data.request.activeRole !== out.data.activeRole || Boolean(out.data.request.confirmationId) !== (write.inspectedState === 'Billed/Confirmed'))) return bad();
    return out.data.request;
  },
  source: async (batchId: string, c: RateContext | null) => {
    if (!uuid.safeParse(batchId).success) return bad();
    const out = z
      .object({ ...envelope, batch: source })
      .strict()
      .safeParse(await call('GET', '/batches/' + batchId, c, 'view'));
    if (!out.success || out.data.batch.id !== batchId) return bad();
    return out.data.batch;
  },
  run: async (op: InvoiceCsvOperation, c: RateContext | null, receipt = false) => {
    if (!operation.safeParse(op).success) return bad();
    const raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/receipts/' + op.requestId : '/exports',
        c,
        receipt ? 'view' : 'create',
        receipt ? undefined : op,
      ),
      out = z
        .object({
          ...envelope,
          artifact: artifact.nullable(),
          failure: failure.nullable(),
          ...(receipt ? {} : { replayed: z.boolean() }),
        })
        .strict()
        .safeParse(raw);
    if (!out.success || Boolean(out.data.artifact) === Boolean(out.data.failure)) return bad();
    const v = out.data.artifact ?? out.data.failure;
    if (
      !v ||
      v.batchId !== op.batchId ||
      v.requestId !== op.requestId ||
      v.reason !== op.reason ||
      v.actorId !== out.data.actorUserId ||
      v.activeRole !== out.data.activeRole
    )
      return bad();
    if (out.data.artifact) {
      const a = out.data.artifact;
      if (
        a.approvalId !== op.approvalId ||
        a.finalTransitionId !== op.finalTransitionId ||
        a.lineageHash !== op.lineageHash ||
        a.schemaVersion !== op.schemaVersion ||
        a.lineCount !== op.expectedLineCount ||
        canonicalHours(a.total) !== canonicalHours(op.expectedTotal)
      )
        return bad();
      return { artifact: a, bytes: await checkArtifact(a), failure: null };
    }
    return { artifact: null, bytes: null, failure: out.data.failure };
  },
  artifact: async (artifactId: string, c: RateContext | null) => {
    if (!uuid.safeParse(artifactId).success) return bad();
    const out = z
      .object({ ...envelope, artifact })
      .strict()
      .safeParse(await call('GET', '/artifacts/' + artifactId, c, 'view'));
    if (!out.success || out.data.artifact.id !== artifactId) return bad();
    return { artifact: out.data.artifact, bytes: await checkArtifact(out.data.artifact) };
  },
  confirmationSource: async (batchId: string, c: RateContext | null) => {
    if (!uuid.safeParse(batchId).success) return bad();
    const out = z
      .object({ ...envelope, source: confirmationSource, confirmation: confirmation.nullable() })
      .strict()
      .safeParse(await call('GET', '/confirmation-sources/' + batchId, c, 'confirm'));
    if (
      !out.success ||
      out.data.source.batchId !== batchId ||
      (out.data.source.state === 'Billed/Confirmed') !== Boolean(out.data.confirmation)
    )
      return bad();
    if (
      out.data.confirmation &&
      (out.data.confirmation.sourceType !== out.data.source.sourceType ||
        out.data.confirmation.batchId !== batchId ||
        out.data.confirmation.artifactId !== out.data.source.artifactId ||
        out.data.confirmation.artifactVersion !== out.data.source.artifactVersion ||
        out.data.confirmation.artifactSha256 !== out.data.source.artifactSha256 ||
        out.data.confirmation.currency !== out.data.source.currency ||
        canonicalHours(out.data.confirmation.total) !== canonicalHours(out.data.source.total))
    )
      return bad();
    return out.data;
  },
  confirm: async (op: InvoiceConfirmationOperation, c: RateContext | null, receipt = false) => {
    const { sourceType, ...command } = op;
    if (
      (sourceType !== undefined && sourceType !== 'MILESTONE_ACCEPTANCE') ||
      (sourceType && !hasRatePermission('commercial.milestone_billing.view')) ||
      !validInvoiceConfirmationCommand(command)
    )
      return bad();
    const raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/confirmation-receipts/' + op.requestId : '/confirmations',
        c,
        'confirm',
        receipt ? undefined : command,
      ),
      out = z
        .object({ ...envelope, confirmation, ...(receipt ? {} : { replayed: z.boolean() }) })
        .strict()
        .safeParse(raw);
    if (!out.success) return bad();
    const x = out.data.confirmation;
    if (
      x.sourceType !== sourceType ||
      x.requestId !== op.requestId ||
      x.batchId !== op.batchId ||
      x.artifactId !== op.artifactId ||
      x.artifactVersion !== op.artifactVersion ||
      x.artifactSha256 !== op.artifactSha256 ||
      x.currency !== op.currency ||
      canonicalHours(x.total) !== canonicalHours(op.total) ||
      x.reference !== op.reference ||
      x.reason !== op.reason ||
      x.actorId !== out.data.actorUserId ||
      x.activeRole !== out.data.activeRole
    )
      return bad();
    return x;
  },
  confirmationNotificationStatus: async (requestId: string, c: RateContext | null) => {
    if (!uuid.safeParse(requestId).success) return bad();
    const status = z
      .object({
        requestId: uuid,
        batchId: uuid,
        eventId: uuid.nullable(),
        eventKey: z.literal('invoice_batch.exported_or_billed_confirmed').nullable(),
        state: z.enum(['EventUnavailable', 'DeliveryIncomplete', 'Recorded']),
        alertOutbox: z.null(),
      })
      .strict()
      .refine((v) => (v.state === 'EventUnavailable') === (v.eventId === null && v.eventKey === null));
    const out = z
      .object({ ...envelope, status })
      .strict()
      .safeParse(await call('GET', '/confirmation-notification-status/' + requestId, c, 'confirm'));
    if (!out.success || out.data.status.requestId !== requestId) return bad();
    return out.data.status;
  },
  recoveryTargets: async (batchId: string, c: RateContext | null, after?: string) => {
    if (!uuid.safeParse(batchId).success || (after && !uuid.safeParse(after).success)) return bad();
    const out = z
      .object({ ...envelope, targets: z.array(recoveryTarget), nextAfter: uuid.nullable() })
      .strict()
      .safeParse(
        await call(
          'GET',
          '/notice-recovery-sources/' + batchId + (after ? '?after=' + after : ''),
          c,
          'recover',
        ),
      );
    if (!out.success || new Set(out.data.targets.map((x) => x.id)).size !== out.data.targets.length)
      return bad();
    return { targets: out.data.targets, nextAfter: out.data.nextAfter };
  },
  recover: async (op: InvoiceNoticeRecoveryOperation, c: RateContext | null, receipt = false) => {
    if (
      !uuid.safeParse(op.requestId).success ||
      !uuid.safeParse(op.batchId).success ||
      !uuid.safeParse(op.policyId).success ||
      Boolean(op.eventId) === Boolean(op.producerFailureId) ||
      (op.eventId !== null && !uuid.safeParse(op.eventId).success) ||
      (op.producerFailureId !== null && !uuid.safeParse(op.producerFailureId).success) ||
      !reason.safeParse(op.reason).success
    )
      return bad();
    const { policyId, ...command } = op,
      raw = await call(
        receipt ? 'GET' : 'POST',
        receipt ? '/notice-recovery-receipts/' + op.requestId : '/notice-recoveries',
        c,
        'recover',
        receipt ? undefined : command,
      ),
      out = z
        .object({ ...envelope, recovery, ...(receipt ? {} : { replayed: z.boolean() }) })
        .strict()
        .safeParse(raw);
    if (
      !out.success ||
      out.data.recovery.requestId !== op.requestId ||
      out.data.recovery.batchId !== op.batchId ||
      out.data.recovery.policyId !== policyId ||
      out.data.recovery.eventId !== op.eventId ||
      out.data.recovery.producerFailureId !== op.producerFailureId ||
      out.data.recovery.reason !== op.reason ||
      out.data.recovery.actorId !== out.data.actorUserId ||
      out.data.recovery.activeRole !== out.data.activeRole
    )
      return bad();
    return out.data.recovery;
  },
  notificationStatus: async (requestId: string, c: RateContext | null) => {
    if (!uuid.safeParse(requestId).success) return bad();
    const status = z
      .object({
        requestId: uuid,
        batchId: uuid,
        eventId: uuid.nullable(),
        eventKey: z
          .enum(['invoice_batch.export_failed', 'invoice_batch.exported_or_billed_confirmed'])
          .nullable(),
        state: z.enum(['EventUnavailable', 'DeliveryIncomplete', 'Recorded']),
        alertOutbox: z.literal('Pending').nullable(),
      })
      .strict()
      .refine((v) => (v.state === 'EventUnavailable') === (v.eventId === null && v.eventKey === null));
    const out = z
      .object({ ...envelope, status })
      .strict()
      .safeParse(await call('GET', '/notification-status/' + requestId, c, 'view'));
    if (!out.success || out.data.status.requestId !== requestId) return bad();
    return out.data.status;
  },
};
