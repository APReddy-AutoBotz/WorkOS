import {
  MILESTONE_RECONCILIATION_VERSION,
  RECONCILIATION_VERSION,
  reconciliationToken,
  reconciliationCsv,
} from './reconciliation-csv.mjs';
import { readBillingReconciliation } from './reconciliation.mjs';
import { milestoneBatchModel } from '../invoice-approval/milestone-batch.mjs';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadMilestoneInvoiceItem, milestoneInvoiceAcquisitionAllowed } from './milestone-source.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { scopedCapacityWorker } from '../planning/worker-capacity-service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { validInvoiceDraft, invoiceItemMatches } from '../../../shared/invoice-batch-draft.mjs';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  reason = z.string().trim().min(3).max(1000),
  key = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.number().int().min(0).max(1000000),
  fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
  scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId],
  fingerprint = (x) => capacityHash(capacityCanonical(x));
const parse = (schema, value) => {
  const x = schema.safeParse(value);
  if (!x.success) throw fail(400, 'INVOICE_DRAFT_INVALID', 'Provide explicit valid draft inputs.');
  return x.data;
};
const fence = (r, k) => {
  if (workApprovalOwner(r) !== k)
    throw fail(409, 'INVOICE_DRAFT_CONTEXT', 'Account, role or scope changed. Reload.');
};
const batchFields = `coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT') as "sourceType",b.id,b.client_id as "clientId",b.contract_id as "contractId",b.engagement_id as "engagementId",b.currency,b.period_start::text as "periodStart",b.period_end::text as "periodEnd",b.period_basis as "periodBasis",b.owner_user_id as "ownerUserId",b.owner_role as "ownerRole",b.preparer_user_id as "preparerUserId",b.preparer_role as "preparerRole",b.request_id as "requestId",b.reason,b.created_at as "createdAt"`;
const lineFields = `l.id,l.batch_id as "batchId",l.sequence,l.item_id as "itemId",l.item_version as "itemVersion",l.event_id as "eventId",l.snapshot_id as "snapshotId",coalesce(to_jsonb(l)->>'source_type','TM_SNAPSHOT') as "sourceType",l.currency,l.amount::text,l.billing_evidence as evidence,l.actor_id as "actorId",l.active_role as "activeRole",l.request_id as "requestId",l.reason,l.created_at as "createdAt"`;
const batchView = (x) => {
  if (x.sourceType === 'MILESTONE_ACCEPTANCE') return x;
  if (x.sourceType === 'TM_SNAPSHOT') {
    const { sourceType: _, ...legacy } = x;
    return legacy;
  }
  throw fail(503, 'INVOICE_DRAFT_UNCONFIRMED', 'Invoice batch source could not be confirmed.');
};
const lineView = (x) => {
  if (x.sourceType === 'MILESTONE_ACCEPTANCE' && x.snapshotId === null) return x;
  if (x.sourceType === 'TM_SNAPSHOT' && typeof x.snapshotId === 'string') {
    const { sourceType: _, ...legacy } = x;
    return legacy;
  }
  throw fail(503, 'INVOICE_DRAFT_UNCONFIRMED', 'Invoice line source could not be confirmed.');
};
const cancellationFields = `c.id,c.batch_id as "batchId",c.expected_line_count as "expectedLineCount",c.actor_id as "actorId",c.active_role as "activeRole",c.request_id as "requestId",c.reason,c.created_at as "createdAt"`;
export const createInvoiceDraftRouter = (o) => {
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
      begun = false,
      sessionLock = null,
      discard = false;
    try {
      c = await o.pool.connect();
      if (write === 'snapshot') {
        const requestId = parse(uuid, r.body?.requestId);
        sessionLock = `tm-reconciliation-export:${scope(r).join(':')}:${r.user.sub}:${requestId}`;
        await c.query('select pg_advisory_lock(hashtextextended($1,0))', [sessionLock]);
      }
      await c.query(write === true ? 'begin' : 'begin isolation level repeatable read');
      begun = true;
      const result = await fn(c, r);
      await c.query('commit');
      begun = false;
      res.status(write && !result.replayed ? 201 : 200).json(result);
    } catch (e) {
      if (begun) await c.query('rollback').catch(() => {});
      if (e.statusCode) res.status(e.statusCode).json({ code: e.code, error: e.message });
      else if (['IDR01', 'IDR02', 'IDR03', 'IBA02', '23505', '23514', '40001', '40P01'].includes(e.code))
        res.status(e.code === 'IDR01' ? 403 : 409).json({
          code: e.code === 'IDR01' ? 'INVOICE_DRAFT_AUTHORITY' : 'INVOICE_DRAFT_CONFLICT',
          error: 'Current draft, owner, item or scope changed. Reload.',
        });
      else {
        o.logError?.(e);
        res.status(503).json({
          code: 'INVOICE_DRAFT_UNCONFIRMED',
          error: 'The operation could not be confirmed. Read the original receipt.',
        });
      }
    } finally {
      if (c && sessionLock)
        try {
          await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [sessionLock]);
        } catch {
          discard = true;
        }
      c?.release(discard);
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
  const authorize = async (c, r, kind = 'view', extras = []) => {
    const keys = [
        'commercial.contracts.view',
        'commercial.tm_billing.view',
        'commercial.invoice_drafts.view',
        'employees.view',
        'notifications.view',
        ...(kind === 'view' ? [] : ['commercial.invoice_drafts.' + kind]),
        ...extras,
      ].sort(),
      held = await c.query(
        'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
        [r.user.sub, ...scope(r)],
      );
    if (!held.rowCount) throw fail(403, 'INVOICE_DRAFT_AUTHORITY', 'Current scope unavailable.');
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
  const context = async (c, r, batchId, lineId = null, cancellationId = null, expectedLineCount = null) =>
    c.query("select set_config('workos.invoice_draft_context',$1,true)", [
      JSON.stringify({
        organizationId: scope(r)[0],
        legalEntityId: scope(r)[1],
        actorId: r.user.sub,
        activeRole: r.user.activeRole,
        operationId: r.operationId,
        batchId,
        lineId,
        cancellationId,
        expectedLineCount,
      }),
    ]);
  const worker = async (c, r, snapshotId, lock = false) => {
    const row = (
      await c.query(
        'select h.employee_id from commercial_tm_valuations v join work_submission_evidence s on s.id=v.submission_id join timesheets h on h.id=s.timesheet_id where v.id=$1 and v.organization_id=$2 and v.legal_entity_id=$3',
        [snapshotId, ...scope(r)],
      )
    ).rows[0];
    if (!row) throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped source unavailable.');
    await scopedCapacityWorker(c, r, row.employee_id, o.buildEmployeeScopeWhere, lock);
    return row.employee_id;
  };
  const batch = async (c, r, batchId, lock = false) => {
    const row = (
      await c.query(
        `select ${batchFields},invoice_draft_owner_current(b) as "ownerCurrent",invoice_batch_governed_state(b.id) as state from invoice_draft_batches b where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3${lock ? ' for update of b' : ''}`,
        [batchId, ...scope(r)],
      )
    ).rows[0];
    if (!row) throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped draft unavailable.');
    const isMilestone = await milestoneBatchModel(c, r, batchId);
    if (isMilestone !== (row.sourceType === 'MILESTONE_ACCEPTANCE'))
      throw fail(409, 'INVOICE_DRAFT_SOURCE', 'Invoice batch source does not match its engagement.');
    if (isMilestone) await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
    const ids = (
      await c.query('select snapshot_id from invoice_draft_lines where batch_id=$1 order by sequence', [
        batchId,
      ])
    ).rows;
    for (const x of ids) {
      if (x.snapshot_id === null) await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
      else await worker(c, r, x.snapshot_id, lock);
    }
    return batchView(row);
  };
  const lines = async (c, batchId) =>
    (
      await c.query(
        `select ${lineFields} from invoice_draft_lines l where l.batch_id=$1 order by l.sequence`,
        [batchId],
      )
    ).rows.map(lineView);
  // Called in the inspection's repeatable-read snapshot, or after locking the batch for cancellation.
  const cancellationObservation = async (c, r, batchId) => {
    const row = (
      await c.query(
        `
      select invoice_batch_governed_state(b.id) as state, invoice_draft_owner_current(b) as owner_current,
        invoice_batch_lineage_hash(b.id) as lineage, review.id as review_id,
        (select t.id from invoice_batch_approval_transitions t where t.instance_id=review.id
          order by t.sequence desc limit 1) as decision_id,
        (select x.id from invoice_batch_approval_invalidations x where x.instance_id=review.id) as invalidation_id
      from invoice_draft_batches b left join lateral (
        select i.id from invoice_batch_approval_instances i where i.batch_id=b.id order by i.sequence desc limit 1
      ) review on true where b.id=$1`,
        [batchId],
      )
    ).rows[0];
    return { ...row, token: fingerprint({ batchId, owner: workApprovalOwner(r), ...row }) };
  };
  const detail = async (c, r, b) => {
    const records = await lines(c, b.id),
      total = (
        await c.query(
          'select count(*)::int as "lineCount",trim_scale(coalesce(sum(amount),0))::text as amount from invoice_draft_lines where batch_id=$1',
          [b.id],
        )
      ).rows[0],
      cancel =
        (
          await c.query(
            `select ${cancellationFields} from invoice_draft_cancellations c where c.batch_id=$1`,
            [b.id],
          )
        ).rows[0] ?? null;
    return { ...(await envelope(c, r)), batch: b, lines: records, total, cancellation: cancel };
  };
  const item = async (c, r, itemId, lock = false, batchId) => {
    const kind = (
      await c.query(
        "select coalesce(to_jsonb(item)->>'source_type','TM_SNAPSHOT') source_type from approved_unbilled_items item where item.id=$1 and item.organization_id=$2 and item.legal_entity_id=$3",
        [itemId, ...scope(r)],
      )
    ).rows[0];
    if (kind?.source_type === 'MILESTONE_ACCEPTANCE')
      return loadMilestoneInvoiceItem(c, r, batchId, itemId, lock);
    if (kind?.source_type !== 'TM_SNAPSHOT')
      throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped approved-unbilled item unavailable.');
    const x = (
      await c.query(
        `select item.id as "itemId",item.version as "itemVersion",ev.id as "eventId",ev.client_id as "clientId",ev.contract_id as "contractId",ev.engagement_id as "engagementId",ev.currency,ev.eligible_on::text as "eligibleOn",ev.amount::text,ev.snapshot_id as "snapshotId",ev.billing_evidence as evidence,ev.billing_evidence->>'workDate' as "workDate",tm_billing_source_valid(ev.organization_id,ev.legal_entity_id,ev.engagement_id,ev.snapshot_id) as current from approved_unbilled_items item join billing_eligibility_events ev on ev.id=item.event_id where item.id=$1 and item.organization_id=$2 and item.legal_entity_id=$3${lock ? ' for share of item,ev' : ''}`,
        [itemId, ...scope(r)],
      )
    ).rows[0];
    if (!x) throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped approved-unbilled item unavailable.');
    await worker(c, r, x.snapshotId, lock);
    return x;
  };
  const audit = async (c, r, action, entityId, value) =>
    o.audit(c, r, {
      module: 'Invoice Draft',
      action,
      entityType: 'InvoiceDraft',
      entityId,
      newValue: value,
      reason: 'Scoped invoice draft operation retained.',
      details: 'No cost, invoice issuance, provider delivery or ledger posting.',
    });
  const bodyBase = { expectedOwnerKey: key, requestId: uuid, reason };
  router.post(
    '/batches',
    handle(true, async (c, r) => {
      const d = parse(
        z.object({ ...bodyBase, definition: z.unknown().refine(validInvoiceDraft) }).strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'prepare');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-draft-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const digest = fingerprint(d),
        old = (
          await c.query(
            'select id,request_fingerprint,preparer_role from invoice_draft_batches where organization_id=$1 and legal_entity_id=$2 and preparer_user_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (old.request_fingerprint !== digest || old.preparer_role !== r.user.activeRole)
          throw fail(409, 'INVOICE_DRAFT_KEY', 'Original draft request differs.');
        return { ...(await detail(c, r, await batch(c, r, old.id))), replayed: true };
      }
      const v = d.definition,
        id = randomUUID(),
        engagement = (
          await c.query(
            'select model from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3 for share',
            [...scope(r), v.engagementId],
          )
        ).rows[0];
      if (!engagement || !['time_and_materials', 'milestone'].includes(engagement.model))
        throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped billing engagement unavailable.');
      if (engagement.model === 'milestone') {
        await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
        if (v.periodBasis !== 'ELIGIBLE_DATE')
          throw fail(409, 'INVOICE_DRAFT_SOURCE', 'Milestone batches use their explicit eligibility date.');
      }
      await context(c, r, id);
      const args = [
        id,
        ...scope(r),
        v.clientId,
        v.contractId,
        v.engagementId,
        v.currency,
        v.periodStart,
        v.periodEnd,
        v.periodBasis,
        v.ownerUserId,
        v.ownerRole,
        r.user.sub,
        r.user.activeRole,
        d.requestId,
        digest,
        d.reason,
        r.operationId,
      ];
      if (engagement.model === 'milestone')
        await c.query(
          "insert into invoice_draft_batches(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,currency,period_start,period_end,period_basis,owner_user_id,owner_role,preparer_user_id,preparer_role,request_id,request_fingerprint,reason,operation_id,source_type)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'MILESTONE_ACCEPTANCE')",
          args,
        );
      else
        await c.query(
          `insert into invoice_draft_batches(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,currency,period_start,period_end,period_basis,owner_user_id,owner_role,preparer_user_id,preparer_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          args,
        );
      await audit(c, r, 'Create Draft', id, { batchId: id });
      return { ...(await detail(c, r, await batch(c, r, id))), replayed: false };
    }),
  );
  router.get(
    '/batches',
    handle(false, async (c, r) => {
      const q = parse(z.object({ after: uuid.optional() }).strict(), r.query);
      await authorize(c, r);
      let milestoneAccess = false;
      try {
        await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
        milestoneAccess = true;
      } catch (e) {
        if (e.code !== 'COMMERCIAL_PERMISSION_DENIED') throw e;
      }
      const args = [...scope(r)],
        workerWhere = o.buildEmployeeScopeWhere(r, args, 'worker');
      args.push(q.after ?? null);
      const afterParam = args.length;
      args.push(milestoneAccess);
      const rows = (
        await c.query(
          `select ${batchFields},invoice_draft_owner_current(b) as "ownerCurrent",invoice_batch_governed_state(b.id) as state from invoice_draft_batches b where b.organization_id=$1 and b.legal_entity_id=$2 and ($${afterParam}::uuid is null or b.id>$${afterParam}::uuid) and (coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT')='TM_SNAPSHOT' or (coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT')='MILESTONE_ACCEPTANCE' and $${args.length}::boolean)) and not exists(select 1 from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence s on s.id=v.submission_id join timesheets h on h.id=s.timesheet_id left join employees worker on worker.id=h.employee_id where l.batch_id=b.id and not coalesce((${workerWhere}),false)) order by b.id limit 51`,
          args,
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        batches: rows.slice(0, 50).map(batchView),
        nextAfter: rows.length > 50 ? rows[49].id : null,
      };
    }),
  );
  const reportScope = (r) => ({ organizationId: scope(r)[0], legalEntityId: scope(r)[1] });
  const report = async (c, r, engagementId) => {
    const source = (
      await c.query(
        'select model from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3',
        [...scope(r), engagementId],
      )
    ).rows[0];
    if (!source || !['milestone', 'time_and_materials'].includes(source.model))
      throw fail(404, 'BILLING_REPORT_SOURCE', 'Scoped billing engagement unavailable.');
    const milestone = source.model === 'milestone';
    if (milestone) await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
    const value = {
      ...(await readBillingReconciliation(c, r, engagementId, o, source.model)),
      version: milestone ? MILESTONE_RECONCILIATION_VERSION : RECONCILIATION_VERSION,
    };
    return { ...value, reportToken: reconciliationToken(reportScope(r), value) };
  };
  router.get(
    '/reconciliation',
    handle(false, async (c, r) => {
      const q = parse(z.object({ engagementId: id }).strict(), r.query);
      await authorize(c, r, 'view', ['commercial.invoice_export.view']);
      return { ...(await envelope(c, r)), ...(await report(c, r, q.engagementId)) };
    }),
  );
  router.post(
    '/reconciliation/exports',
    handle('snapshot', async (c, r) => {
      const d = parse(
        z
          .object({
            expectedOwnerKey: key,
            engagementId: id,
            expectedReportToken: key,
            requestId: uuid,
            reason,
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'view', ['commercial.invoice_export.view', 'reports.export']);
      const value = await report(c, r, d.engagementId);
      const prior = (
        await c.query(
          "select 1 from audit_logs where organization_id=$1 and legal_entity_id=$2 and user_id=$3 and module='Reports' and action in ('Export T&M Billing Reconciliation','Export Milestone Billing Reconciliation') and entity_id=$4",
          [...scope(r), r.user.sub, d.requestId],
        )
      ).rowCount;
      if (prior)
        throw fail(
          409,
          'BILLING_REPORT_ALREADY_RECORDED',
          'This report request was already recorded. Check audit history before creating another.',
        );
      if (value.reportToken !== d.expectedReportToken)
        throw fail(409, 'BILLING_REPORT_STALE', 'The report changed. Reload before exporting.');
      if (value.exceptionCount)
        throw fail(409, 'BILLING_REPORT_EXCEPTION', 'Resolve reconciliation exceptions before exporting.');
      const csv = reconciliationCsv(reportScope(r), value, value.reportToken),
        sha256 = capacityHash(csv),
        bytes = Buffer.byteLength(csv, 'utf8');
      await o.audit(c, r, {
        module: 'Reports',
        action:
          value.version === MILESTONE_RECONCILIATION_VERSION
            ? 'Export Milestone Billing Reconciliation'
            : 'Export T&M Billing Reconciliation',
        entityType:
          value.version === MILESTONE_RECONCILIATION_VERSION
            ? 'MilestoneBillingReconciliationExport'
            : 'TmBillingReconciliationExport',
        entityId: d.requestId,
        newValue: {
          requestId: d.requestId,
          engagementId: d.engagementId,
          version: value.version,
          asOf: new Date(value.asOf).toISOString(),
          reportToken: value.reportToken,
          artifactSha256: sha256,
          artifactBytes: bytes,
          itemCount: value.items.length,
        },
        reason: d.reason,
        details: 'Scoped report download; no financial delivery or invoice state change.',
      });
      return {
        ...(await envelope(c, r)),
        requestId: d.requestId,
        engagementId: d.engagementId,
        version: value.version,
        asOf: value.asOf,
        reportToken: value.reportToken,
        sha256,
        bytes,
        csv,
      };
    }),
  );
  router.get(
    '/batches/:id',
    handle(false, async (c, r) => {
      const query = parse(z.object({ forCancellation: z.literal('true').optional() }).strict(), r.query);
      await authorize(c, r, query.forCancellation ? 'cancel' : 'view');
      const b = await batch(c, r, parse(uuid, r.params.id));
      const result = await detail(c, r, b);
      if (query.forCancellation) result.cancellationToken = (await cancellationObservation(c, r, b.id)).token;
      return result;
    }),
  );
  router.post(
    '/batches/:id/lines',
    handle(true, async (c, r) => {
      const batchId = parse(uuid, r.params.id),
        d = parse(
          z
            .object({ ...bodyBase, itemId: uuid, itemVersion: z.literal(1), expectedLineCount: count })
            .strict(),
          r.body,
        );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'prepare');
      const b = await batch(c, r, batchId, true),
        source = await item(c, r, d.itemId, true, batchId),
        digest = fingerprint(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-line-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          `select ${lineFields},l.request_fingerprint as fingerprint from invoice_draft_lines l where l.organization_id=$1 and l.legal_entity_id=$2 and l.actor_id=$3 and l.request_id=$4`,
          [...scope(r), r.user.sub, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== digest || old.batchId !== batchId || old.activeRole !== r.user.activeRole)
          throw fail(409, 'INVOICE_DRAFT_KEY', 'Original line request differs.');
        delete old.fingerprint;
        return { ...(await detail(c, r, b)), line: lineView(old), replayed: true };
      }
      const draft = {
          clientId: b.clientId,
          contractId: b.contractId,
          engagementId: b.engagementId,
          currency: b.currency,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          periodBasis: b.periodBasis,
          ownerUserId: b.ownerUserId,
          ownerRole: b.ownerRole,
        },
        match = {
          itemId: source.itemId,
          itemVersion: source.itemVersion,
          clientId: source.clientId,
          contractId: source.contractId,
          engagementId: source.engagementId,
          currency: source.currency,
          workDate: source.workDate,
          eligibleOn: source.eligibleOn,
          amount: source.amount,
          current: source.current,
        };
      if (
        b.state !== 'Draft' ||
        !b.ownerCurrent ||
        !(source.sourceType === 'MILESTONE_ACCEPTANCE'
          ? milestoneInvoiceAcquisitionAllowed(draft, source)
          : invoiceItemMatches(draft, match))
      )
        throw fail(409, 'INVOICE_DRAFT_SOURCE', 'The whole current item is unavailable for this draft.');
      const lineId = randomUUID();
      await context(c, r, batchId, lineId, null, d.expectedLineCount);
      const lineArgs = [
        lineId,
        ...scope(r),
        batchId,
        d.expectedLineCount + 1,
        d.itemId,
        d.itemVersion,
        source.eventId,
        source.snapshotId,
        source.currency,
        source.amount,
        JSON.stringify(source.evidence),
        r.user.sub,
        r.user.activeRole,
        d.requestId,
        digest,
        d.reason,
        r.operationId,
      ];
      if (source.sourceType === 'MILESTONE_ACCEPTANCE')
        await c.query(
          "insert into invoice_draft_lines(id,organization_id,legal_entity_id,batch_id,sequence,item_id,item_version,event_id,snapshot_id,currency,amount,billing_evidence,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,source_type)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,'MILESTONE_ACCEPTANCE')",
          lineArgs,
        );
      else
        await c.query(
          'insert into invoice_draft_lines(id,organization_id,legal_entity_id,batch_id,sequence,item_id,item_version,event_id,snapshot_id,currency,amount,billing_evidence,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)',
          lineArgs,
        );
      await c.query(
        'insert into invoice_draft_occupancies(item_id,item_version,batch_id,line_id)values($1,$2,$3,$4)',
        [d.itemId, d.itemVersion, batchId, lineId],
      );
      await audit(c, r, 'Acquire Item', lineId, { batchId, lineId, itemId: d.itemId });
      const saved = (await c.query(`select ${lineFields} from invoice_draft_lines l where l.id=$1`, [lineId]))
        .rows[0];
      return { ...(await detail(c, r, b)), line: lineView(saved), replayed: false };
    }),
  );
  router.post(
    '/batches/:id/cancellations',
    handle(true, async (c, r) => {
      const batchId = parse(uuid, r.params.id),
        d = parse(
          z
            .object({ ...bodyBase, expectedLineCount: count, expectedCancellationToken: key.optional() })
            .strict(),
          r.body,
        );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'cancel');
      const b = await batch(c, r, batchId, true),
        digest = fingerprint(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-cancel-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          `select ${cancellationFields},c.request_fingerprint as fingerprint from invoice_draft_cancellations c where c.organization_id=$1 and c.legal_entity_id=$2 and c.actor_id=$3 and c.request_id=$4`,
          [...scope(r), r.user.sub, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== digest || old.batchId !== batchId || old.activeRole !== r.user.activeRole)
          throw fail(409, 'INVOICE_DRAFT_KEY', 'Original cancellation differs.');
        delete old.fingerprint;
        return { ...(await detail(c, r, b)), cancellation: old, replayed: true };
      }
      const observed = await cancellationObservation(c, r, batchId);
      // Older clients can cancel only an original, never-submitted draft. Existing receipts replay above.
      if (
        d.expectedCancellationToken
          ? d.expectedCancellationToken !== observed.token
          : observed.state !== 'Draft' || observed.review_id !== null
      ) {
        throw fail(
          409,
          'INVOICE_CANCELLATION_STALE',
          'Invoice review changed. Inspect the batch again before cancelling.',
        );
      }
      const cancellationId = randomUUID();
      if (observed.state === 'Under Review') {
        const i = (
          await c.query(
            'select * from invoice_batch_approval_instances where batch_id=$1 order by sequence desc limit 1',
            [batchId],
          )
        ).rows[0];
        if (!i) throw fail(409, 'INVOICE_DRAFT_SOURCE', 'Active review unavailable.');
        const invalidationId = randomUUID();
        await c.query("select set_config('workos.invoice_batch_approval_context',$1,true)", [
          JSON.stringify({
            organizationId: scope(r)[0],
            legalEntityId: scope(r)[1],
            actorId: r.user.sub,
            activeRole: r.user.activeRole,
            operationId: r.operationId,
            batchId,
            instanceId: i.id,
            invalidationId,
          }),
        ]);
        await c.query(
          'insert into invoice_batch_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
          [invalidationId, i.id, r.user.sub, r.user.activeRole, d.requestId, digest, d.reason, r.operationId],
        );
        await c.query(
          "update approval_records set status='Cancelled',updated_at=now() where entity_type='InvoiceBatchApproval' and entity_id=$1",
          [i.id],
        );
        await o.audit(c, r, {
          module: 'Invoice Batch Approval',
          action: 'Cancel Review',
          entityType: 'InvoiceBatchApproval',
          entityId: invalidationId,
          newValue: { invalidationId, instanceId: i.id, batchId },
          reason: 'Scoped review cancellation.',
          details: 'No financial amount in general audit.',
        });
      }
      await context(c, r, batchId, null, cancellationId, d.expectedLineCount);
      const cancelArgs = [
        cancellationId,
        ...scope(r),
        batchId,
        d.expectedLineCount,
        r.user.sub,
        r.user.activeRole,
        d.requestId,
        digest,
        d.reason,
        r.operationId,
      ];
      if (await milestoneBatchModel(c, r, batchId)) {
        await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
        await c.query(
          "insert into invoice_draft_cancellations(id,organization_id,legal_entity_id,batch_id,expected_line_count,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,source_type)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MILESTONE_ACCEPTANCE')",
          cancelArgs,
        );
      } else
        await c.query(
          'insert into invoice_draft_cancellations(id,organization_id,legal_entity_id,batch_id,expected_line_count,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          cancelArgs,
        );
      await c.query('delete from invoice_draft_occupancies where batch_id=$1', [batchId]);
      await audit(c, r, 'Cancel Draft', cancellationId, { batchId, cancellationId });
      return { ...(await detail(c, r, await batch(c, r, batchId))), replayed: false };
    }),
  );
  router.get(
    '/receipts/:type/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const typ = parse(z.enum(['batch', 'line', 'cancellation']), r.params.type),
        requestId = parse(uuid, r.params.requestId);
      if (typ === 'batch') {
        const row = (
          await c.query(
            'select id from invoice_draft_batches where organization_id=$1 and legal_entity_id=$2 and preparer_user_id=$3 and preparer_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
        if (!row) throw fail(404, 'INVOICE_DRAFT_UNCONFIRMED', 'Original receipt unavailable.');
        return { ...(await detail(c, r, await batch(c, r, row.id))), type: typ };
      }
      const table = typ === 'line' ? 'invoice_draft_lines' : 'invoice_draft_cancellations',
        fields =
          typ === 'line'
            ? lineFields.replaceAll('l.', 'x.').replaceAll('to_jsonb(l)', 'to_jsonb(x)')
            : cancellationFields.replaceAll('c.', 'x.'),
        row = (
          await c.query(
            `select ${fields} from ${table} x where x.organization_id=$1 and x.legal_entity_id=$2 and x.actor_id=$3 and x.active_role=$4 and x.request_id=$5`,
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
      if (!row) throw fail(404, 'INVOICE_DRAFT_UNCONFIRMED', 'Original receipt unavailable.');
      const d = await detail(c, r, await batch(c, r, row.batchId));
      return typ === 'line'
        ? { ...d, type: typ, line: lineView(row) }
        : { ...d, type: typ, cancellation: row };
    }),
  );
  return router;
};
