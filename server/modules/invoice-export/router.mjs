import {registerPoCommitments} from './po-commitments.mjs';
import {readInvoiceLinePricing} from './line-pricing.mjs';
import { CREDIT_CSV_SCHEMA } from '../../../shared/correction-invoice-csv.mjs';
import { correctionArtifact,correctionExportBatch } from './correction-batch.mjs';
import { registerCorrectionReviewEvidence } from './correction-review-evidence.mjs';
import { registerCorrectionDrafts } from './correction-drafts.mjs';
import { registerIssuedCredits } from './issued-credits.mjs';
import { registerLineReversalRequests } from './line-reversal-requests.mjs';
import { approvalBatchModel } from '../invoice-approval/milestone-batch.mjs';
import { loadMilestoneExportBatch } from './milestone-batch.mjs';
import { milestoneInvoiceCsvArtifact, MILESTONE_INVOICE_CSV_SCHEMA } from './milestone-csv.mjs';
import {
  validInvoiceConfirmationCommand,
  invoiceConfirmationAllowed,
} from '../../../shared/invoice-billing-confirmation.mjs';
import {
  currentInvoiceNoticePolicy,
  emitInvoiceExportNotice,
  recoverInvoiceExportRecipients,
} from './notice-producer.mjs';
import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { scopedCapacityWorker } from '../planning/worker-capacity-service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { invoiceCsvArtifact, INVOICE_CSV_SCHEMA } from './csv.mjs';
import {invoiceDraftTotal} from '../../../shared/invoice-batch-draft.mjs';
const FIXED_CSV_SCHEMA='workos.invoice-fixed-fee-csv/2';
const PERIOD_CSV_SCHEMA='workos.invoice-service-period-csv/1';
const SERVICE_CSV_SCHEMA='workos.invoice-service-unit-csv/1';
const RETAINER_CSV_SCHEMA='workos.invoice-retainer-csv/1';
const uuid = z.string().uuid(),
  key = z.string().regex(/^[a-f0-9]{64}$/),
  reason = z.string().trim().min(3).max(1000),
  money = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/),
  scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId],
  fingerprint = (x) => capacityHash(capacityCanonical(x)),
  fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const parse = (schema, value) => {
  const x = schema.safeParse(value);
  if (!x.success) throw fail(400, 'INVOICE_CSV_INVALID', 'Provide explicit valid export inputs.');
  return x.data;
};
// Export commands retain exact source and receipt identity within scope.
export const createInvoiceCsvRouter = (o) => {
  const router = Router();
  router.use(
    (_r, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    o.requireDatabase,
    o.requireAuth,
  );
  const handle = (write, fn) => async (r, res) => {
    let c,
      begun = false;
    try {
      c = await o.pool.connect();
      await c.query(write ? 'begin' : 'begin isolation level repeatable read');
      begun = true;
      const out = await fn(c, r);
      await c.query('commit');
      begun = false;
      res.status(write && !out.replayed ? 201 : 200).json(out);
    } catch (e) {
      if (begun) await c.query('rollback').catch(() => {});
      if (e.statusCode) res.status(e.statusCode).json({ code: e.code, error: e.message });
      else if (e.code === 'CTM04') res.status(409).json({code:'BILLING_ELIGIBILITY_PERIOD_CLOSED',error:'The UTC eligibility date is outside an open financial period.'});
      else if (
        [
          'ICV01',
          'ICV02',
          'ICV03',
          'INC01',
          'INC02',
          'INC03',
          'IBA01',
          'IBC01',
          'IBC02',
          'CCA02',
          'TBE02',
          '23505',
          '23514',
          '40001',
          '40P01',
        ].includes(e.code)
      )
        res.status(['ICV01', 'INC01', 'IBC01', 'IBA01'].includes(e.code) ? 403 : 409).json({
          code: ['ICV01', 'INC01', 'IBC01', 'IBA01'].includes(e.code)
            ? 'INVOICE_CSV_AUTHORITY'
            : 'INVOICE_CSV_CONFLICT',
          error: 'Current batch, approval, scope or artifact changed. Reload.',
        });
      else {
        o.logError?.(e);
        res.status(503).json({
          code: 'INVOICE_CSV_UNCONFIRMED',
          error: 'The operation could not be confirmed. Read the original receipt.',
        });
      }
    } finally {
      c?.release();
    }
  };
  const envelope = async (c, r) => ({
    ownerKey: workApprovalOwner(r),
    actorUserId: r.user.sub,
    activeRole: r.user.activeRole,
    organizationId: r.organizationScope.organizationId,
    legalEntityId: r.organizationScope.legalEntityId,
    serverDate: (await c.query("select to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD') d"))
      .rows[0].d,
  });
  const authorize = async (c, r, kind = 'view') => {
    const keys = [
        'commercial.contracts.view',
        'commercial.tm_billing.view',
        'commercial.invoice_drafts.view',
        'commercial.invoice_export.view',
        'employees.view',
        'notifications.view',
        ...(kind === 'issue-reversal' ? ['commercial.reversal_eligibility.create'] : []),
        ...(['reversal','issue-reversal'].includes(kind) ? ['commercial.invoice_drafts.prepare'] : []),
        ...(kind === 'create' ? ['commercial.invoice_export.create'] : []),
      ].sort(),
      held = await c.query(
        'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
        [r.user.sub, ...scope(r)],
      );
    if (!held.rowCount) throw fail(403, 'INVOICE_CSV_AUTHORITY', 'Current scope unavailable.');
    await c.query(
      'select permission_key from role_permissions where role_name=$1 and permission_key=any($2::text[]) order by permission_key for share',
      [r.user.activeRole, keys],
    );
    await c.query(
      'select permission_key from user_permission_grants where user_id=$1 and permission_key=any($2::text[]) order by permission_key for share',
      [r.user.sub, keys],
    );
    for (const k of keys) await assertCommercialAuthority(c, r, k);
  };
  const context = async (c, r, fields) =>
    c.query("select set_config('workos.invoice_csv_context',$1,true)", [
      JSON.stringify({
        organizationId: scope(r)[0],
        legalEntityId: scope(r)[1],
        actorId: r.user.sub,
        activeRole: r.user.activeRole,
        operationId: r.operationId,
        ...fields,
      }),
    ]);
  const batch = async (c, r, batchId, lock = false) => {
    const model=await approvalBatchModel(c,r,batchId,true,true,true,true);
    if (['milestone','retainer','managed_service','managed_service_period','fixed_fee'].includes(model)) return loadMilestoneExportBatch(c,r,batchId,lock,model);
    const b = (
      await c.query(
        `select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state from invoice_draft_batches b where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3${lock ? ' for update of b' : ''}`,
        [batchId, ...scope(r)],
      )
    ).rows[0];
    if (!b) throw fail(404, 'INVOICE_CSV_SOURCE', 'Scoped invoice batch unavailable.');
    if (b.source_type && b.source_type !== 'TM_SNAPSHOT')
      throw fail(409, 'INVOICE_CSV_SOURCE', 'Invoice source does not match its engagement.');
    const rows = (
      await c.query(
        `select l.id as "lineId",l.sequence,l.item_id as "itemId",l.item_version as "itemVersion",l.event_id as "eventId",l.snapshot_id as "snapshotId",l.currency,trim_scale(l.amount)::text amount,l.billing_evidence::text as "evidenceJson",l.billing_evidence->>'workDate' as "workDate",ev.eligible_on::text as "eligibleDate",h.employee_id as "workerId" from invoice_draft_lines l join billing_eligibility_events ev on ev.id=l.event_id join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where l.batch_id=$1 order by l.sequence`,
        [b.id],
      )
    ).rows;
    for (const row of rows) await scopedCapacityWorker(c, r, row.workerId, o.buildEmployeeScopeWhere, lock);
    const source = {
      batchId: b.id,
      clientId: b.client_id,
      contractId: b.contract_id,
      engagementId: b.engagement_id,
      currency: b.currency,
      periodStart: b.period_start,
      periodEnd: b.period_end,
      periodBasis: b.period_basis,
      lines: rows.map(({ workerId: _, ...line }) => line),
    };
    const review =
      (
        await c.query(
          `select i.*,invoice_batch_approval_pin_current(i) current,t.id as final_transition_id from invoice_batch_approval_instances i join invoice_batch_approval_policies p on p.id=i.policy_id join invoice_batch_approval_transitions t on t.instance_id=i.id and t.sequence=jsonb_array_length(p.definition->'stages') and t.decision='Approved' where i.batch_id=$1 order by i.sequence desc limit 1`,
          [b.id],
        )
      ).rows[0] ?? null;
    return { row: b, source, review };
  };
  const exportBatch=async(c,r,id,lock=false)=>(await correctionExportBatch(c,r,id,lock)) ?? batch(c,r,id,lock);
  const renderExport=async(c,source)=>{
    switch(source.lines[0]?.sourceType){
      case 'FIXED_FEE_INSTALLMENT':
      case 'MANAGED_SERVICE_PERIOD':
      case 'MANAGED_SERVICE_UNIT':
      case 'RETAINER_PERIOD': {
        const formats={
          FIXED_FEE_INSTALLMENT:['fixed_fee_invoice_csv_bytes',FIXED_CSV_SCHEMA],
          MANAGED_SERVICE_PERIOD:['service_period_invoice_csv_bytes',PERIOD_CSV_SCHEMA],
          MANAGED_SERVICE_UNIT:['service_unit_invoice_csv_bytes',SERVICE_CSV_SCHEMA],
          RETAINER_PERIOD:['retainer_invoice_csv_bytes',RETAINER_CSV_SCHEMA],
        };
        const [render,schemaVersion]=formats[source.lines[0].sourceType];
        const {rows:[{bytes}]}=await c.query(`select ${render}(b) bytes from invoice_draft_batches b where b.id=$1`,[source.batchId]);
        if (!Buffer.isBuffer(bytes) || !bytes.length) throw new TypeError('Retained invoice bytes unavailable.');
        const {lineCount,amount}=invoiceDraftTotal(source.lines.map(line=>line.amount));
        return {schemaVersion,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),
          currency:source.currency,lineCount,total:amount};
      }
      case 'FULL_LINE_REVERSAL': return correctionArtifact(source);
      case 'MILESTONE_ACCEPTANCE': return milestoneInvoiceCsvArtifact(source);
      default: return invoiceCsvArtifact(source);
    }
  };
  const artifactView = (a) => ({
    id: a.id,
    batchId: a.batch_id,
    approvalId: a.approval_id,
    finalTransitionId: a.final_transition_id,
    lineageHash: a.lineage_hash,
    schemaVersion: a.schema_version,
    version: a.version,
    sha256: a.sha256,
    lineCount: a.line_count,
    currency: a.currency,
    total: String(a.total),
    actorId: a.actor_id,
    activeRole: a.active_role,
    requestId: a.request_id,
    reason: a.reason,
    operationId: a.operation_id,
    generatedAt: a.generated_at,
    payloadBase64: a.payload.toString('base64'),
  });
  const failureView = (f) => ({
    id: f.id,
    batchId: f.batch_id,
    code: f.code,
    actorId: f.actor_id,
    activeRole: f.active_role,
    requestId: f.request_id,
    reason: f.reason,
    operationId: f.operation_id,
    createdAt: f.created_at,
  });
  const audit = async (c, r, action, id, newValue) =>
    o.audit(c, r, {
      module: 'Invoice CSV',
      action,
      entityType: 'InvoiceCsvOperation',
      entityId: id,
      newValue,
      reason: 'Scoped invoice-ready CSV operation.',
      details: 'Retained invoice export evidence.',
    });
  registerCorrectionReviewEvidence(router,{handle,authorize,batch,envelope});
  registerCorrectionDrafts(router,{handle,authorize,batch,envelope,audit:o.audit});
  registerIssuedCredits(router, { handle, authorize, envelope });
  registerLineReversalRequests(router, { handle, authorize, batch, envelope, audit: o.audit });
  router.get('/correction-batches',handle(false,async(c,r)=>{
    const q=parse(z.object({engagementId:z.string().min(1).max(200),after:uuid.optional(),purpose:z.literal('confirmation').optional()}).strict(),r.query);
    await authorize(c,r);
    const rows=(await c.query(`select b.id,b.currency,invoice_batch_governed_state(b.id) state from invoice_draft_batches b
      where b.organization_id=$1 and b.legal_entity_id=$2 and b.engagement_id=$3 and b.source_type='FULL_LINE_REVERSAL'
      and invoice_batch_governed_state(b.id) in ('Approved','Exported','Billed/Confirmed') and (not $7::boolean or invoice_batch_governed_state(b.id)<>'Approved') and correction_original_scope_current(b,$4,$5)
      and ($6::uuid is null or b.id>$6) order by b.id limit 51`,[...scope(r),q.engagementId,r.user.sub,r.user.activeRole,q.after??null,q.purpose==='confirmation'])).rows;
    return {...await envelope(c,r),engagementId:q.engagementId,batches:rows.slice(0,50),nextAfter:rows.length>50?rows[49].id:null};
  }));
  registerPoCommitments(router,{handle,parse,batch,authorize,envelope,audit,fail});
  router.get('/batches/:id/lines/:lineId/pricing',handle(false,async(c,r)=>{
    parse(z.object({}).strict(),r.query);
    const id=parse(uuid,r.params.id),lineId=parse(uuid,r.params.lineId);
    await authorize(c,r);
    await assertCommercialAuthority(c,r,'commercial.rate_candidates.view');
    const {row}=await batch(c,r,id);
    const pricing=(!row.source_type || row.source_type==='TM_SNAPSHOT') && await readInvoiceLinePricing(c,row,lineId);
    if(!pricing)throw fail(404,'INVOICE_LINE_PRICING_UNAVAILABLE','Billing evidence unavailable for this invoice line.');
    return {...await envelope(c,r),pricing};
  }));
  router.get('/batches/:id/exported-credits',handle(false,async(c,r)=>{
    const id=parse(uuid,r.params.id),q=parse(z.object({after:uuid.optional()}).strict(),r.query);
    await authorize(c,r);
    await batch(c,r,id);
    const rows=(await c.query(`select original_artifact_id as "originalArtifactId",original_line_id as "originalLineId",
      correction_artifact_id as "artifactId",correction_batch_id as "batchId",correction_line_id as "lineId",correction_sha256 as sha256,
      currency,trim_scale(amount)::text amount,
      exists(select 1 from invoice_batch_confirmations conf where conf.batch_id=correction_batch_id
        and conf.artifact_id=correction_artifact_id and conf.artifact_sha256=correction_sha256
        and conf.source_type='FULL_LINE_REVERSAL') as "applicationAttested"
      from invoice_export_line_corrections
      where organization_id=$1 and legal_entity_id=$2 and original_batch_id=$3 and ($4::uuid is null or correction_line_id>$4)
      and exists(select 1 from invoice_draft_batches cb where cb.id=correction_batch_id and correction_original_scope_current(cb,$5,$6))
      order by correction_line_id limit 51`,[...scope(r),id,q.after??null,r.user.sub,r.user.activeRole])).rows;
    return {...await envelope(c,r),originalBatchId:id,lines:rows.slice(0,50),nextAfter:rows.length>50?rows[49].lineId:null};
  }));
  router.get(
    '/batches/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const { row, source, review } = await exportBatch(c, r, parse(uuid, r.params.id)),
        stored =
          (await c.query('select id from invoice_csv_artifacts where batch_id=$1', [row.id])).rows[0] ?? null;
      let total = null;
      try {
        const x =
          await renderExport(c,source);
        total = { lineCount: x.lineCount, total: x.total, currency: x.currency };
      } catch {
        /* Historical source can remain inspectable without becoming exportable. */
      }
      return {
        ...(await envelope(c, r)),
        batch: {
          id: row.id,
          ...(['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(row.source_type) ? { sourceType: row.source_type } : {}),
          state: row.state,
          clientId: row.client_id,
          contractId: row.contract_id,
          engagementId: row.engagement_id,
          currency: row.currency,
          periodStart: row.period_start,
          periodEnd: row.period_end,
          periodBasis: row.period_basis,
          approvalId: review?.id ?? null,
          finalTransitionId: review?.final_transition_id ?? null,
          lineageHash: review?.lineage_hash ?? null,
          sourceCurrent: review?.current === true,
          artifactId: stored?.id ?? null,
          lines: source.lines.map((x) =>
            x.sourceType === 'FULL_LINE_REVERSAL' ? x : ['MILESTONE_ACCEPTANCE','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(x.sourceType)
              ? {
                  lineId: x.lineId,
                  sequence: x.sequence,
                  itemId: x.itemId,
                  itemVersion: x.itemVersion,
                  eventId: x.eventId,
                  sourceType: x.sourceType,
                   ...(x.sourceType==='FIXED_FEE_INSTALLMENT'?{installment:JSON.parse(x.evidenceJson).installment,dueOn:JSON.parse(x.evidenceJson).dueOn}:x.sourceType==='MANAGED_SERVICE_PERIOD'?{reviewId:JSON.parse(x.evidenceJson).reviewId}:x.sourceType==='MANAGED_SERVICE_UNIT'?{evidenceId:JSON.parse(x.evidenceJson).evidenceId,reviewId:JSON.parse(x.evidenceJson).reviewId}:x.sourceType==='RETAINER_PERIOD'?{statementId:JSON.parse(x.evidenceJson).statementId,reviewId:JSON.parse(x.evidenceJson).reviewId}:{milestoneId:JSON.parse(x.evidenceJson).milestoneId}),
                  eligibleDate: x.eligibleDate,
                  currency: x.currency,
                  amount: x.amount,
                }
              : {
                  lineId: x.lineId,
                  sequence: x.sequence,
                  itemId: x.itemId,
                  itemVersion: x.itemVersion,
                  eventId: x.eventId,
                  snapshotId: x.snapshotId,
                  workDate: x.workDate,
                  eligibleDate: x.eligibleDate,
                  currency: x.currency,
                  amount: x.amount,
                },
          ),
          control: total,
        },
      };
    }),
  );
  const providerAudit = (c, r, action, id, newValue) => o.audit(c, r, {
    module:'Invoice Export', entityType:'InvoiceProviderExport', entityId:id, action, newValue,
    reason:'Scoped delivery of an approved invoice batch.', details:action,
  });
  const acceptArtifact = async (c, r, { d, row, notificationPolicy, rendered, fp, artifactId }) => {
      await context(c, r, { batchId: d.batchId, artifactId });
      const a = (
        await c.query(
          'insert into invoice_csv_artifacts(id,batch_id,organization_id,legal_entity_id,approval_id,final_transition_id,lineage_hash,schema_version,version,payload,sha256,line_count,currency,total,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)returning *',
          [
            artifactId,
            d.batchId,
            ...scope(r),
            d.approvalId,
            d.finalTransitionId,
            d.lineageHash,
            d.schemaVersion,
            rendered.bytes,
            rendered.sha256,
            rendered.lineCount,
            rendered.currency,
            rendered.total,
            r.user.sub,
            r.user.activeRole,
            d.requestId,
            fp,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await audit(c, r, 'Accept CSV', artifactId, {
        batchId: d.batchId,
        artifactId,
        sha256: rendered.sha256,
      });
      await emitInvoiceExportNotice(c, r, {
        batch: row,
        policy: notificationPolicy,
        resultId: artifactId,
        kind: 'artifact',
      });
      return { ...(await envelope(c, r)), artifact: artifactView(a), failure: null, replayed: false };
  };
  const exportRequest = z
  .object({
    expectedOwnerKey: key,
    requestId: uuid,
    batchId: uuid,
    approvalId: uuid,
    finalTransitionId: uuid,
    lineageHash: key,
    schemaVersion: z.enum([INVOICE_CSV_SCHEMA, MILESTONE_INVOICE_CSV_SCHEMA,CREDIT_CSV_SCHEMA,RETAINER_CSV_SCHEMA,SERVICE_CSV_SCHEMA,PERIOD_CSV_SCHEMA,FIXED_CSV_SCHEMA]),
    expectedLineCount: z.number().int().min(1).max(1000000),
    expectedTotal: z.union([money,z.string().regex(/^-(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)]),
    reason,
  })
  .strict();

  router.post('/provider-exports', handle(true, async (c, r) => {
    const d = parse(exportRequest, r.body);
    if (workApprovalOwner(r) !== d.expectedOwnerKey)
      throw fail(409, 'INVOICE_CSV_CONTEXT', 'Account, role or scope changed. Reload.');
    await authorize(c, r, 'create');
    await assertCommercialAuthority(c, r, 'commercial.invoice_export.deliver');
    const { row, source, review } = await exportBatch(c, r, d.batchId, true);
    const fp = fingerprint(d);
    const prior = (await c.query(
      'select id, batch_id, active_role, request_fingerprint from invoice_provider_exports where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
      [...scope(r), r.user.sub, d.requestId],
    )).rows[0];
    if (prior) {
      if (prior.batch_id !== d.batchId || prior.request_fingerprint !== fp || prior.active_role !== r.user.activeRole)
        throw fail(409, 'INVOICE_PROVIDER_KEY', 'Original delivery request differs.');
      return { ...(await envelope(c, r)), exportId: prior.id, replayed: true };
    }
    if (!o.financeProvider?.destinationHash)
      throw fail(503, 'INVOICE_PROVIDER_UNAVAILABLE', 'Finance provider is unavailable.');
    if (row.state !== 'Approved' || !review?.current || review.id !== d.approvalId ||
        review.final_transition_id !== d.finalTransitionId || review.lineage_hash !== d.lineageHash)
      throw fail(409, 'INVOICE_CSV_SOURCE', 'Current approved source or final decision changed.');
    const rendered = await renderExport(c, source);
    if (rendered.schemaVersion !== d.schemaVersion || rendered.lineCount !== d.expectedLineCount ||
        rendered.total !== d.expectedTotal)
      throw fail(409, 'INVOICE_CSV_TOTAL', 'The approved control totals changed.');
    const exportId = randomUUID();
    await c.query(
      `insert into invoice_provider_exports(id,batch_id,organization_id,legal_entity_id,actor_id,active_role,
        request_id,request_fingerprint,destination_hash,approval_id,final_transition_id,lineage_hash,
        schema_version,payload,line_count,currency,total,reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [exportId,d.batchId,...scope(r),r.user.sub,r.user.activeRole,d.requestId,fp,
        o.financeProvider.destinationHash,d.approvalId,d.finalTransitionId,d.lineageHash,
        rendered.schemaVersion,rendered.bytes,rendered.lineCount,rendered.currency,rendered.total,d.reason],
    );
    await providerAudit(c, r, 'Reserve provider delivery', exportId, {batchId: d.batchId, sha256: rendered.sha256});
    return { ...(await envelope(c, r)), exportId, replayed: false };
  }));


  router.post('/provider-exports/:id/deliver', handle(true, async (c, r) => {
    const exportId = parse(uuid, r.params.id);
    const { expectedOwnerKey } = parse(z.object({expectedOwnerKey: key}).strict(), r.body);
    if (workApprovalOwner(r) !== expectedOwnerKey)
      throw fail(409, 'INVOICE_CSV_CONTEXT', 'Account, role or scope changed. Reload.');
    await authorize(c, r, 'create');
    await assertCommercialAuthority(c, r, 'commercial.invoice_export.deliver');
    const reservation = (await c.query(
      'select * from invoice_provider_exports where id=$1 and organization_id=$2 and legal_entity_id=$3',
      [exportId,...scope(r)],
    )).rows[0];
    if (!reservation) throw fail(404, 'INVOICE_PROVIDER_UNKNOWN', 'Delivery unavailable.');
    const { row, review } = await exportBatch(c, r, reservation.batch_id, true);
    const accepted = (await c.query(
      'select a.* from invoice_provider_attempts p join invoice_csv_artifacts a on a.id=p.artifact_id where p.export_id=$1',
      [exportId],
    )).rows[0];
    if (accepted) return { ...(await envelope(c,r)), artifact: artifactView(accepted), replayed: true };
    const rejected = await c.query("select 1 from invoice_provider_attempts where export_id=$1 and result='permanently_rejected'", [exportId]);
    if (rejected.rowCount) return { ...(await envelope(c,r)), exportId, deliveryStatus:'permanently_rejected', replayed:true };
    if (row.state !== 'Approved' || !review?.current || review.id !== reservation.approval_id ||
        review.final_transition_id !== reservation.final_transition_id || review.lineage_hash !== reservation.lineage_hash)
      throw fail(409, 'INVOICE_CSV_SOURCE', 'Current approved source or final decision changed.');
    if (o.financeProvider?.destinationHash !== reservation.destination_hash)
      throw fail(503, 'INVOICE_PROVIDER_UNAVAILABLE', 'Original finance provider is unavailable.');
    const notificationPolicy = await currentInvoiceNoticePolicy(c, row);
    const rendered = {schemaVersion: reservation.schema_version, bytes: reservation.payload,
      sha256: reservation.sha256, lineCount: reservation.line_count, currency: reservation.currency, total: String(reservation.total)};
    const attemptId = randomUUID();
    let deliveryStatus;
    try {
      const receipt = await o.financeProvider.deliver({operationId: exportId, batchId: row.id, artifact: rendered});
      deliveryStatus = receipt.status;
    } catch {
      deliveryStatus = 'unconfirmed';
    }
    const artifactId = deliveryStatus === 'accepted' ? randomUUID() : null;
    await c.query(
      'insert into invoice_provider_attempts(id,export_id,actor_id,active_role,result,artifact_id) values($1,$2,$3,$4,$5,$6)',
      [attemptId,exportId,r.user.sub,r.user.activeRole,deliveryStatus,artifactId],
    );
    await providerAudit(c,r,'Record provider delivery result',exportId,
      {batchId:row.id,attemptId,artifactId,deliveryStatus});
    if (!artifactId) {
      const code = deliveryStatus === 'permanently_rejected' ? 'PROVIDER_DELIVERY_REJECTED' : 'PROVIDER_DELIVERY_UNCONFIRMED';
      await context(c,r,{batchId:row.id,failureId:attemptId});
      await c.query(
        `insert into invoice_csv_failures(id,batch_id,organization_id,legal_entity_id,actor_id,active_role,
          request_id,request_fingerprint,reason,code,operation_id) values($1,$2,$3,$4,$5,$6,$1,$7,$8,$9,$10)`,
        [attemptId,row.id,...scope(r),r.user.sub,r.user.activeRole,reservation.request_fingerprint,
          reservation.reason,code,r.operationId],
      );
      await audit(c,r,'Record CSV Failure',attemptId,{batchId:row.id,failureId:attemptId,code});
      await emitInvoiceExportNotice(c,r,{batch:row,policy:notificationPolicy,resultId:attemptId,kind:'failure'});
      return {...await envelope(c,r), exportId, deliveryStatus, replayed:false};
    }
    const d = {batchId:row.id,approvalId:reservation.approval_id,finalTransitionId:reservation.final_transition_id,
      lineageHash:reservation.lineage_hash,schemaVersion:reservation.schema_version,reason:reservation.reason,requestId:exportId};
    return acceptArtifact(c,r,{d,row,notificationPolicy,rendered,fp:reservation.request_fingerprint,artifactId});
  }));
  router.post(
    '/exports',
    handle(true, async (c, r) => {
      const d = parse(exportRequest, r.body);
      if (workApprovalOwner(r) !== d.expectedOwnerKey)
        throw fail(409, 'INVOICE_CSV_CONTEXT', 'Account, role or scope changed. Reload.');
      await authorize(c, r, 'create');
      const { row, source, review } = await exportBatch(c, r, d.batchId, true);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-csv-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = fingerprint(d),
        old = (
          await c.query(
            'select * from invoice_csv_artifacts where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0],
        failed = (
          await c.query(
            'select * from invoice_csv_failures where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old || failed) {
        const x = old ?? failed;
        if (x.request_fingerprint !== fp || x.active_role !== r.user.activeRole || x.batch_id !== d.batchId)
          throw fail(409, 'INVOICE_CSV_KEY', 'Original export request differs.');
        return {
          ...(await envelope(c, r)),
          artifact: old ? artifactView(old) : null,
          failure: failed ? failureView(failed) : null,
          replayed: true,
        };
      }
      if (
        row.state !== 'Approved' ||
        !review ||
        !review.current ||
        review.id !== d.approvalId ||
        review.final_transition_id !== d.finalTransitionId ||
        review.lineage_hash !== d.lineageHash
      )
        throw fail(409, 'INVOICE_CSV_SOURCE', 'Current approved source or final decision changed.');
      const notificationPolicy = await currentInvoiceNoticePolicy(c, row);
      let rendered;
      try {
        rendered =
          await renderExport(c,source);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        const failureId = randomUUID();
        await context(c, r, { batchId: d.batchId, failureId });
        const f = (
          await c.query(
            "insert into invoice_csv_failures(id,batch_id,organization_id,legal_entity_id,actor_id,active_role,request_id,request_fingerprint,reason,code,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,'ARTIFACT_GENERATION_FAILED',$10)returning *",
            [
              failureId,
              d.batchId,
              ...scope(r),
              r.user.sub,
              r.user.activeRole,
              d.requestId,
              fp,
              d.reason,
              r.operationId,
            ],
          )
        ).rows[0];
        await audit(c, r, 'Record CSV Failure', failureId, { batchId: d.batchId, failureId, code: f.code });
        await emitInvoiceExportNotice(c, r, {
          batch: row,
          policy: notificationPolicy,
          resultId: failureId,
          kind: 'failure',
        });
        return { ...(await envelope(c, r)), artifact: null, failure: failureView(f), replayed: false };
      }
      if (
        rendered.schemaVersion !== d.schemaVersion ||
        rendered.lineCount !== d.expectedLineCount ||
        rendered.total !== d.expectedTotal
      )
        throw fail(409, 'INVOICE_CSV_TOTAL', 'The approved control totals changed.');
      return acceptArtifact(c, r, { d, row, notificationPolicy, rendered, fp, artifactId: randomUUID() });
    }),
  );
  const confirmationSchema = (sourceType = 'TM_SNAPSHOT') => ({
    TM_SNAPSHOT: INVOICE_CSV_SCHEMA,
    MILESTONE_ACCEPTANCE: MILESTONE_INVOICE_CSV_SCHEMA,
    RETAINER_PERIOD: RETAINER_CSV_SCHEMA,
    MANAGED_SERVICE_UNIT: SERVICE_CSV_SCHEMA,
    FIXED_FEE_INSTALLMENT: FIXED_CSV_SCHEMA,
    MANAGED_SERVICE_PERIOD: PERIOD_CSV_SCHEMA,
    FULL_LINE_REVERSAL: CREDIT_CSV_SCHEMA,
  })[sourceType];
  const confirmationView = (x) => ({
    id: x.id,
    ...(['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(x.source_type) ? { sourceType: x.source_type } : {}),
    batchId: x.batch_id,
    artifactId: x.artifact_id,
    artifactVersion: x.artifact_version,
    artifactSha256: x.artifact_sha256,
    currency: x.currency,
    total: String(x.total),
    method: x.confirmation_kind,
    reference: x.external_reference,
    actorId: x.actor_id,
    activeRole: x.active_role,
    requestId: x.request_id,
    reason: x.reason,
    operationId: x.operation_id,
    confirmedAt: x.confirmed_at,
  });
  router.get(
    '/confirmation-sources/:batchId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_batch.confirm');
      const { row } = await exportBatch(c, r, parse(uuid, r.params.batchId)),
        a =
          (
            await c.query(
              'select *,trim_scale(total)::text exact_total from invoice_csv_artifacts where batch_id=$1',
              [row.id],
            )
          ).rows[0] ?? null,
        x =
          (
            await c.query(
              'select *,trim_scale(total)::text total from invoice_batch_confirmations where batch_id=$1',
              [row.id],
            )
          ).rows[0] ?? null;
      if (
        !a ||
        a.schema_version !==
          confirmationSchema(row.source_type)
      )
        throw fail(
          409,
          'INVOICE_CONFIRMATION_SOURCE',
          'An accepted scoped CSV artifact of the batch source is required.',
        );
      return {
        ...(await envelope(c, r)),
        source: {
          batchId: row.id,
          ...(['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(row.source_type) ? { sourceType: row.source_type } : {}),
          state: row.state,
          artifactId: a.id,
          artifactVersion: a.version,
          artifactSha256: a.sha256,
          currency: a.currency,
          total: a.exact_total,
        },
        confirmation: x ? confirmationView(x) : null,
      };
    }),
  );
  router.get(
    '/confirmation-receipts/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_batch.confirm');
      const x = (
        await c.query(
          'select *,trim_scale(total)::text total from invoice_batch_confirmations where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
          [...scope(r), r.user.sub, r.user.activeRole, parse(uuid, r.params.requestId)],
        )
      ).rows[0];
      if (!x)
        throw fail(404, 'INVOICE_CONFIRMATION_UNCONFIRMED', 'Original confirmation receipt unavailable.');
      await exportBatch(c, r, x.batch_id);
      return { ...(await envelope(c, r)), confirmation: confirmationView(x) };
    }),
  );
  router.get(
    '/confirmation-notification-status/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_batch.confirm');
      const requestId = parse(uuid, r.params.requestId),
        x = (
          await c.query(
            'select * from invoice_batch_confirmations where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
      if (!x) throw fail(404, 'INVOICE_CONFIRMATION_UNCONFIRMED', 'Original confirmation is unavailable.');
      await exportBatch(c, r, x.batch_id);
      const event =
          (
            await c.query(
              `select e.*,exists(select 1 from invoice_export_notice_failures f where f.event_id=e.id) and (select count(*) from invoice_export_notice_recipients rec where rec.event_id=e.id)<(select count(distinct y.recipient) from invoice_export_expected_recipients(e)y) delivery_incomplete from invoice_export_notice_events e where e.confirmation_id=$1`,
              [x.id],
            )
          ).rows[0] ?? null,
        failure =
          (
            await c.query('select id from invoice_export_notice_producer_failures where confirmation_id=$1', [
              x.id,
            ])
          ).rows[0] ?? null;
      if (!event && !failure)
        throw fail(503, 'INVOICE_CONFIRMATION_UNCONFIRMED', 'Notification status is not confirmed.');
      return {
        ...(await envelope(c, r)),
        status: {
          requestId,
          batchId: x.batch_id,
          eventId: event?.id ?? null,
          eventKey: event?.event_key ?? null,
          state: !event ? 'EventUnavailable' : event.delivery_incomplete ? 'DeliveryIncomplete' : 'Recorded',
          alertOutbox: null,
        },
      };
    }),
  );
  router.post(
    '/confirmations',
    handle(true, async (c, r) => {
      const input = parse(
          z
            .object({
              expectedOwnerKey: key,
              requestId: uuid,
              batchId: uuid,
              artifactId: uuid,
              artifactVersion: z.literal(1),
              artifactSha256: key,
              currency: z.string().regex(/^[A-Z]{3}$/),
              total: z.string().max(128),
              reference: z.string().trim().min(1).max(200),
              reason,
            })
            .strict(),
          r.body,
        ),
        { expectedOwnerKey, ...cmd } = input;
      if (expectedOwnerKey !== workApprovalOwner(r))
        throw fail(409, 'INVOICE_CONFIRMATION_CONTEXT', 'Account, role or scope changed.');
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_batch.confirm');
      const { row } = await exportBatch(c, r, cmd.batchId, true);
      if (!validInvoiceConfirmationCommand(cmd, row.source_type))
        throw fail(400, 'INVOICE_CONFIRMATION_INPUT', 'Explicit valid attestation inputs are required.');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-confirmation:${scope(r).join(':')}:${r.user.sub}:${cmd.requestId}`,
      ]);
      const fp = fingerprint(input),
        old = (
          await c.query(
            'select *,trim_scale(total)::text total from invoice_batch_confirmations where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, cmd.requestId],
          )
        ).rows[0];
      if (old) {
        if (
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== fp ||
          old.batch_id !== cmd.batchId
        )
          throw fail(409, 'INVOICE_CONFIRMATION_KEY', 'Original confirmation request differs.');
        return { ...(await envelope(c, r)), confirmation: confirmationView(old), replayed: true };
      }
      const a = (
        await c.query(
          'select *,trim_scale(total)::text exact_total from invoice_csv_artifacts where id=$1 and batch_id=$2 for share',
          [cmd.artifactId, row.id],
        )
      ).rows[0];
      if (
        !a ||
        a.schema_version !==
          confirmationSchema(row.source_type) ||
        !invoiceConfirmationAllowed(
          cmd,
          {
            state: row.state,
            batchId: row.id,
            artifactId: a.id,
            artifactVersion: a.version,
            artifactSha256: a.sha256,
            currency: a.currency,
            total: a.exact_total,
          },
          { active: true, heldRole: true, scopedSourceAccess: true, confirmationPermission: true },
          row.source_type,
        )
      )
        throw fail(
          409,
          'INVOICE_CONFIRMATION_SOURCE',
          'Exact current exported artifact and totals are required.',
        );
      const notificationPolicy = await currentInvoiceNoticePolicy(c, row),
        confirmationId = randomUUID();
      await c.query("select set_config('workos.invoice_confirmation_context',$1,true)", [
        JSON.stringify({
          confirmationId,
          organizationId: scope(r)[0],
          legalEntityId: scope(r)[1],
          actorId: r.user.sub,
          activeRole: r.user.activeRole,
          operationId: r.operationId,
        }),
      ]);
      const confirmationArgs = [
          confirmationId,
          ...scope(r),
          row.id,
          a.id,
          a.version,
          a.sha256,
          a.currency,
          a.exact_total,
          cmd.reference,
          r.user.sub,
          r.user.activeRole,
          cmd.requestId,
          fp,
          cmd.reason,
          r.operationId,
        ],
        x = (
          await c.query(
            ['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(row.source_type)
              ? "insert into invoice_batch_confirmations(id,organization_id,legal_entity_id,batch_id,artifact_id,artifact_version,artifact_sha256,currency,total,confirmation_kind,external_reference,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,source_type)values($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL_ATTESTATION',$10,$11,$12,$13,$14,$15,$16,$17)returning *,trim_scale(total)::text total"
              : "insert into invoice_batch_confirmations(id,organization_id,legal_entity_id,batch_id,artifact_id,artifact_version,artifact_sha256,currency,total,confirmation_kind,external_reference,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL_ATTESTATION',$10,$11,$12,$13,$14,$15,$16)returning *,trim_scale(total)::text total",
            ['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(row.source_type) ? [...confirmationArgs,row.source_type] : confirmationArgs,
          )
        ).rows[0];
      await o.audit(c, r, {
        module: 'Invoice Billing Confirmation',
        action: 'Record Manual Attestation',
        entityType: 'InvoiceBatchConfirmation',
        entityId: confirmationId,
        newValue: { confirmationId, batchId: row.id, artifactId: a.id, sha256: a.sha256 },
        reason: 'Scoped user attestation.',
        details: 'User-entered reference; no provider verification, payment or ledger posting.',
      });
      await emitInvoiceExportNotice(c, r, {
        batch: row,
        policy: notificationPolicy,
        resultId: confirmationId,
        kind: 'confirmation',
      });
      return { ...(await envelope(c, r)), confirmation: confirmationView(x), replayed: false };
    }),
  );
  router.get(
    '/artifacts/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const a = (
        await c.query(
          'select * from invoice_csv_artifacts where id=$1 and organization_id=$2 and legal_entity_id=$3',
          [parse(uuid, r.params.id), ...scope(r)],
        )
      ).rows[0];
      if (!a) throw fail(404, 'INVOICE_CSV_SOURCE', 'Scoped artifact unavailable.');
      await exportBatch(c, r, a.batch_id);
      return { ...(await envelope(c, r)), artifact: artifactView(a) };
    }),
  );
  const recoveryView = (x) => ({
    id: x.id,
    batchId: x.batch_id,
    policyId: x.policy_id,
    eventId: x.event_id,
    producerFailureId: x.producer_failure_id,
    actorId: x.actor_id,
    activeRole: x.active_role,
    requestId: x.request_id,
    reason: x.reason,
    operationId: x.operation_id,
    createdAt: x.created_at,
  });
  router.get(
    '/notice-recovery-sources/:batchId',
    handle(false, async (c, r) => {
      const q = parse(z.object({ after: uuid.optional() }).strict(), r.query),
        id = parse(uuid, r.params.batchId);
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_export.recover_notices');
      await exportBatch(c, r, id);
      const rows = (
        await c.query(
          `select * from (select f.id,'producer'::text kind,f.policy_id,f.created_at from invoice_export_notice_producer_failures f where f.batch_id=$1 and not exists(select 1 from invoice_export_notice_events e where (f.artifact_id is not null and e.artifact_id=f.artifact_id) or (f.failure_id is not null and e.failure_id=f.failure_id) or (f.confirmation_id is not null and e.confirmation_id=f.confirmation_id)) union all select e.id,'event'::text kind,e.policy_id,e.created_at from invoice_export_notice_events e join invoice_export_notice_failures f on f.event_id=e.id where e.batch_id=$1 and not exists(select 1 from invoice_export_notice_recipients x where x.event_id=e.id)) x where ($2::uuid is null or x.id>$2) order by x.id limit 21`,
          [id, q.after ?? null],
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        targets: rows
          .slice(0, 20)
          .map((x) => ({ id: x.id, kind: x.kind, policyId: x.policy_id, createdAt: x.created_at })),
        nextAfter: rows.length > 20 ? rows[19].id : null,
      };
    }),
  );
  router.get(
    '/notice-recovery-receipts/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_export.recover_notices');
      const x = (
        await c.query(
          'select * from invoice_export_notice_recoveries where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
          [...scope(r), r.user.sub, r.user.activeRole, parse(uuid, r.params.requestId)],
        )
      ).rows[0];
      if (!x) throw fail(404, 'INVOICE_NOTICE_UNCONFIRMED', 'Original recovery receipt unavailable.');
      await exportBatch(c, r, x.batch_id);
      return { ...(await envelope(c, r)), recovery: recoveryView(x) };
    }),
  );
  router.post(
    '/notice-recoveries',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            expectedOwnerKey: key,
            requestId: uuid,
            batchId: uuid,
            eventId: uuid.nullable(),
            producerFailureId: uuid.nullable(),
            reason,
          })
          .strict()
          .refine((x) => Boolean(x.eventId) !== Boolean(x.producerFailureId)),
        r.body,
      );
      if (workApprovalOwner(r) !== d.expectedOwnerKey)
        throw fail(409, 'INVOICE_CSV_CONTEXT', 'Account, role or scope changed. Reload.');
      await authorize(c, r);
      await assertCommercialAuthority(c, r, 'commercial.invoice_export.recover_notices');
      const { row } = await exportBatch(c, r, d.batchId, true);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-notice-recovery:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = fingerprint(d),
        old = (
          await c.query(
            'select * from invoice_export_notice_recoveries where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== fp ||
          old.batch_id !== d.batchId
        )
          throw fail(409, 'INVOICE_NOTICE_KEY', 'Original recovery request differs.');
        return { ...(await envelope(c, r)), recovery: recoveryView(old), replayed: true };
      }
      const event = d.eventId
          ? (
              await c.query(
                'select e.* from invoice_export_notice_events e join invoice_export_notice_failures f on f.event_id=e.id where e.id=$1 and e.batch_id=$2',
                [d.eventId, row.id],
              )
            ).rows[0]
          : null,
        producerFailure = d.producerFailureId
          ? (
              await c.query(
                'select * from invoice_export_notice_producer_failures where id=$1 and batch_id=$2',
                [d.producerFailureId, row.id],
              )
            ).rows[0]
          : null;
      if (Boolean(event) === Boolean(producerFailure))
        throw fail(409, 'INVOICE_NOTICE_RECOVERY', 'An incomplete retained notice is required.');
      if (
        event &&
        (
          await c.query('select count(*)::int n from invoice_export_notice_recipients where event_id=$1', [
            event.id,
          ])
        ).rows[0].n !== 0
      )
        throw fail(
          409,
          'INVOICE_NOTICE_RECOVERY',
          'No missing in-app recipient set is available to recover.',
        );
      if (
        producerFailure &&
        (
          await c.query(
            'select 1 from invoice_export_notice_events where ($1::uuid is not null and artifact_id=$1) or ($2::uuid is not null and failure_id=$2) or ($3::uuid is not null and confirmation_id=$3)',
            [producerFailure.artifact_id, producerFailure.failure_id, producerFailure.confirmation_id],
          )
        ).rowCount
      )
        throw fail(409, 'INVOICE_NOTICE_RECOVERY', 'The retained event is already present.');
      const policy = (
        await c.query('select * from invoice_export_notice_policies where id=$1', [
          event?.policy_id ?? producerFailure.policy_id,
        ])
      ).rows[0];
      if (!policy) throw fail(409, 'INVOICE_NOTICE_RECOVERY', 'Pinned notice policy is unavailable.');
      const recoveryId = randomUUID();
      await c.query("select set_config('workos.invoice_notice_recovery_context',$1,true)", [
        JSON.stringify({
          recoveryId,
          organizationId: scope(r)[0],
          legalEntityId: scope(r)[1],
          actorId: r.user.sub,
          activeRole: r.user.activeRole,
          operationId: r.operationId,
        }),
      ]);
      const recovery = (
        await c.query(
          'insert into invoice_export_notice_recoveries(id,organization_id,legal_entity_id,batch_id,policy_id,event_id,producer_failure_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)returning *',
          [
            recoveryId,
            ...scope(r),
            row.id,
            policy.id,
            event?.id ?? null,
            producerFailure?.id ?? null,
            r.user.sub,
            r.user.activeRole,
            d.requestId,
            fp,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await o.audit(c, r, {
        module: 'Invoice Export Notifications',
        action: 'Attempt Notice Recovery',
        entityType: 'InvoiceExportNoticeRecovery',
        entityId: recoveryId,
        newValue: {
          recoveryId,
          batchId: row.id,
          eventId: event?.id ?? null,
          producerFailureId: producerFailure?.id ?? null,
        },
        reason: 'Scoped invoice notification recovery.',
        details: 'No external delivery; original export is unchanged.',
      });
      if (event) await recoverInvoiceExportRecipients(c, r, { batch: row, policy, event, recoveryId });
      else {
        const resultId =
            producerFailure.artifact_id ?? producerFailure.failure_id ?? producerFailure.confirmation_id,
          kind = producerFailure.artifact_id
            ? 'artifact'
            : producerFailure.failure_id
              ? 'failure'
              : 'confirmation';
        await emitInvoiceExportNotice(c, r, {
          batch: row,
          policy,
          resultId,
          kind,
          eventOperationId: producerFailure.operation_id,
          recoveryId,
        });
      }
      return { ...(await envelope(c, r)), recovery: recoveryView(recovery), replayed: false };
    }),
  );
  router.get(
    '/notification-status/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const requestId = parse(uuid, r.params.requestId),
        args = [...scope(r), r.user.sub, r.user.activeRole, requestId],
        a = (
          await c.query(
            'select * from invoice_csv_artifacts where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            args,
          )
        ).rows[0],
        f = (
          await c.query(
            'select * from invoice_csv_failures where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            args,
          )
        ).rows[0];
      if (Boolean(a) === Boolean(f))
        throw fail(404, 'INVOICE_CSV_UNCONFIRMED', 'Original notification status is unavailable.');
      const result = a ?? f;
      await exportBatch(c, r, result.batch_id);
      const event =
          (
            await c.query(
              `select e.*,exists(select 1 from invoice_export_notice_failures x where x.event_id=e.id) and ((select count(*) from invoice_export_notice_recipients r where r.event_id=e.id)<(select count(distinct y.recipient) from invoice_export_expected_recipients(e)y) or (e.event_key='invoice_batch.export_failed' and not invoice_alert_route_current(p.route_id,b.organization_id,b.legal_entity_id))) delivery_incomplete from invoice_export_notice_events e join invoice_export_notice_policies p on p.id=e.policy_id join invoice_draft_batches b on b.id=e.batch_id where ($1::uuid is not null and e.artifact_id=$1) or ($2::uuid is not null and e.failure_id=$2)`,
              [a?.id ?? null, f?.id ?? null],
            )
          ).rows[0] ?? null,
        producerFailure =
          (
            await c.query(
              'select id from invoice_export_notice_producer_failures where ($1::uuid is not null and artifact_id=$1) or ($2::uuid is not null and failure_id=$2)',
              [a?.id ?? null, f?.id ?? null],
            )
          ).rows[0] ?? null;
      if (!event && !producerFailure)
        throw fail(503, 'INVOICE_NOTICE_UNCONFIRMED', 'Notification status is not yet confirmed.');
      const outbox = event
        ? ((await c.query('select status from invoice_export_alert_outbox where event_id=$1', [event.id]))
            .rows[0] ?? null)
        : null;
      return {
        ...(await envelope(c, r)),
        status: {
          requestId,
          batchId: result.batch_id,
          eventId: event?.id ?? null,
          eventKey: event?.event_key ?? null,
          state: !event ? 'EventUnavailable' : event.delivery_incomplete ? 'DeliveryIncomplete' : 'Recorded',
          alertOutbox: outbox?.status ?? null,
        },
      };
    }),
  );
  router.get(
    '/receipts/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const requestId = parse(uuid, r.params.requestId),
        args = [...scope(r), r.user.sub, r.user.activeRole, requestId],
        a = (
          await c.query(
            'select * from invoice_csv_artifacts where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            args,
          )
        ).rows[0],
        f = (
          await c.query(
            'select * from invoice_csv_failures where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            args,
          )
        ).rows[0];
      if (Boolean(a) === Boolean(f))
        throw fail(404, 'INVOICE_CSV_UNCONFIRMED', 'Original receipt unavailable or ambiguous.');
      await exportBatch(c, r, (a ?? f).batch_id);
      return {
        ...(await envelope(c, r)),
        artifact: a ? artifactView(a) : null,
        failure: f ? failureView(f) : null,
      };
    }),
  );
  return router;
};
