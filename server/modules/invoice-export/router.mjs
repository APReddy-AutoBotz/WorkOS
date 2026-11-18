import {
  currentInvoiceNoticePolicy,
  emitInvoiceExportNotice,
  recoverInvoiceExportRecipients,
} from './notice-producer.mjs';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { scopedCapacityWorker } from '../planning/worker-capacity-service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { invoiceCsvArtifact, INVOICE_CSV_SCHEMA } from './csv.mjs';
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
      else if (
        [
          'ICV01',
          'ICV02',
          'ICV03',
          'INC01',
          'INC02',
          'INC03',
          'CCA02',
          'TBE02',
          '23505',
          '23514',
          '40001',
          '40P01',
        ].includes(e.code)
      )
        res
          .status(['ICV01', 'INC01'].includes(e.code) ? 403 : 409)
          .json({
            code: ['ICV01', 'INC01'].includes(e.code) ? 'INVOICE_CSV_AUTHORITY' : 'INVOICE_CSV_CONFLICT',
            error: 'Current batch, approval, scope or artifact changed. Reload.',
          });
      else {
        o.logError?.(e);
        res
          .status(503)
          .json({
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
    const b = (
      await c.query(
        `select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state from invoice_draft_batches b where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3${lock ? ' for update of b' : ''}`,
        [batchId, ...scope(r)],
      )
    ).rows[0];
    if (!b) throw fail(404, 'INVOICE_CSV_SOURCE', 'Scoped invoice batch unavailable.');
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
      details: 'No cost, ledger posting or provider delivery.',
    });
  router.get(
    '/batches/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const { row, source, review } = await batch(c, r, parse(uuid, r.params.id)),
        stored =
          (await c.query('select id from invoice_csv_artifacts where batch_id=$1', [row.id])).rows[0] ?? null;
      let total = null;
      try {
        const x = invoiceCsvArtifact(source);
        total = { lineCount: x.lineCount, total: x.total, currency: x.currency };
      } catch {
        /* Historical source can remain inspectable without becoming exportable. */
      }
      return {
        ...(await envelope(c, r)),
        batch: {
          id: row.id,
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
          lines: source.lines.map((x) => ({
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
          })),
          control: total,
        },
      };
    }),
  );
  router.post(
    '/exports',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            expectedOwnerKey: key,
            requestId: uuid,
            batchId: uuid,
            approvalId: uuid,
            finalTransitionId: uuid,
            lineageHash: key,
            schemaVersion: z.literal(INVOICE_CSV_SCHEMA),
            expectedLineCount: z.number().int().min(1).max(1000000),
            expectedTotal: money,
            reason,
          })
          .strict(),
        r.body,
      );
      if (workApprovalOwner(r) !== d.expectedOwnerKey)
        throw fail(409, 'INVOICE_CSV_CONTEXT', 'Account, role or scope changed. Reload.');
      await authorize(c, r, 'create');
      const { row, source, review } = await batch(c, r, d.batchId, true);
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
        rendered = invoiceCsvArtifact(source);
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
      if (rendered.lineCount !== d.expectedLineCount || rendered.total !== d.expectedTotal)
        throw fail(409, 'INVOICE_CSV_TOTAL', 'The approved control totals changed.');
      const artifactId = randomUUID();
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
      await batch(c, r, a.batch_id);
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
      await batch(c, r, id);
      const rows = (
        await c.query(
          `select * from (select f.id,'producer'::text kind,f.policy_id,f.created_at from invoice_export_notice_producer_failures f where f.batch_id=$1 and not exists(select 1 from invoice_export_notice_events e where (f.artifact_id is not null and e.artifact_id=f.artifact_id) or (f.failure_id is not null and e.failure_id=f.failure_id)) union all select e.id,'event'::text kind,e.policy_id,e.created_at from invoice_export_notice_events e join invoice_export_notice_failures f on f.event_id=e.id where e.batch_id=$1 and not exists(select 1 from invoice_export_notice_recipients x where x.event_id=e.id)) x where ($2::uuid is null or x.id>$2) order by x.id limit 21`,
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
      await batch(c, r, x.batch_id);
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
      const { row } = await batch(c, r, d.batchId, true);
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
            'select 1 from invoice_export_notice_events where ($1::uuid is not null and artifact_id=$1) or ($2::uuid is not null and failure_id=$2)',
            [producerFailure.artifact_id, producerFailure.failure_id],
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
        const resultId = producerFailure.artifact_id ?? producerFailure.failure_id,
          kind = producerFailure.artifact_id ? 'artifact' : 'failure';
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
      await batch(c, r, result.batch_id);
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
      await batch(c, r, (a ?? f).batch_id);
      return {
        ...(await envelope(c, r)),
        artifact: a ? artifactView(a) : null,
        failure: f ? failureView(f) : null,
      };
    }),
  );
  return router;
};
