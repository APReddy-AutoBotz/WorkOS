import { correctionApprovalBatch, correctionScopeAvailable } from './correction-batch.mjs';
import { approvalBatchModel, loadMilestoneApprovalBatch } from './milestone-batch.mjs';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { scopedCapacityWorker } from '../planning/worker-capacity-service.mjs';
import { approvalEventIdentity } from '../../../shared/work-approval.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import {
  validInvoiceBatchApprovalPolicy,
  invoiceBatchApprovalState,
  invoiceBatchApprovalRecipients,
  renderInvoiceBatchApprovalNotice,
} from '../../../shared/invoice-batch-approval.mjs';
const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  reason = z.string().trim().min(3).max(1000),
  key = z.string().regex(/^[a-f0-9]{64}$/),
  date = z.string().date(),
  scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId],
  digest = (x) => capacityHash(capacityCanonical(x)),
  fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const parse = (schema, value) => {
  const x = schema.safeParse(value);
  if (!x.success)
    throw fail(400, 'INVOICE_APPROVAL_INVALID', 'Provide explicit valid invoice approval inputs.');
  return x.data;
};
const policyView = (p) => ({
  id: p.id,
  engagementId: p.engagement_id,
  sequence: p.sequence,
  previousId: p.previous_id,
  effectiveFrom: String(p.effective_from).slice(0, 10),
  definition: p.definition,
  actorId: p.actor_id,
  activeRole: p.active_role,
  reason: p.reason,
  requestId: p.request_id,
  createdAt: p.created_at,
});
// Named, scoped stages use protected transactions and canonical in-app events.
export const createInvoiceBatchApprovalRouter = (o) => {
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
      else if (['IBA01', 'IBA02', 'IBA03', '23505', '23514', '40001', '40P01'].includes(e.code))
        res.status(e.code === 'IBA01' ? 403 : 409).json({
          code: e.code === 'IBA01' ? 'INVOICE_APPROVAL_AUTHORITY' : 'INVOICE_APPROVAL_CONFLICT',
          error: 'Current scope, batch or approval stage changed. Reload.',
        });
      else {
        o.logError?.(e);
        res.status(503).json({
          code: 'INVOICE_APPROVAL_UNCONFIRMED',
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
        'employees.view',
        'notifications.view',
        ...(kind === 'manager' ? ['commercial.contracts.manage', 'commercial.invoice_approval.manage'] : []),
        ...(kind === 'submitter'
          ? ['commercial.invoice_drafts.prepare', 'commercial.invoice_approval.manage']
          : []),
        ...(kind === 'decider' ? ['approvals.view', 'commercial.invoice_approval.decide'] : []),
      ].sort(),
      held = await c.query(
        'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
        [r.user.sub, ...scope(r)],
      );
    if (!held.rowCount) throw fail(403, 'INVOICE_APPROVAL_AUTHORITY', 'Current scope unavailable.');
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
  const engagement = async (c, r, engagementId, lock = false) => {
    const row = (
      await c.query(
        `select * from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3${lock ? ' for share' : ''}`,
        [...scope(r), engagementId],
      )
    ).rows[0];
    if (
      !row ||
      !['time_and_materials', 'milestone','retainer'].includes(row.model) ||
      row.origin !== 'manual' ||
      !row.billable ||
      !row.client_id ||
      !row.contract_id
    )
      throw fail(404, 'INVOICE_APPROVAL_SOURCE', 'Scoped billing engagement unavailable.');
    if (row.model === 'retainer') await assertCommercialAuthority(c,r,'commercial.retainer_eligibility.issue');
    if (row.model === 'milestone') await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
    return row;
  };
  const context = async (c, r, fields) =>
    c.query("select set_config('workos.invoice_batch_approval_context',$1,true)", [
      JSON.stringify({
        organizationId: scope(r)[0],
        legalEntityId: scope(r)[1],
        actorId: r.user.sub,
        activeRole: r.user.activeRole,
        operationId: r.operationId,
        ...fields,
      }),
    ]);
  router.get(
    '/policies',
    handle(false, async (c, r) => {
      const q = parse(
        z.object({ engagementId: id, includeEffective: z.literal('true').optional() }).strict(),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const rows = (
        await c.query(
          'select *,effective_from::text from invoice_batch_approval_policies where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by sequence desc limit 21',
          [...scope(r), q.engagementId],
        )
      ).rows;
      const env = await envelope(c, r);
      const result = {
        ...env,
        policies: rows.slice(0, 20).map(policyView),
        truncated: rows.length > 20,
      };
      if (q.includeEffective) {
        const active = await c.query(
          'select p.*,p.effective_from::text from invoice_batch_approval_policies p where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and effective_from<=$4::date order by p.effective_from desc,p.sequence desc limit 1',
          [...scope(r), q.engagementId, env.serverDate],
        );
        result.effectivePolicy = active.rowCount ? policyView(active.rows[0]) : null;
      }
      return result;
    }),
  );
  router.post(
    '/policies',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            expectedOwnerKey: key,
            requestId: uuid,
            reason,
            engagementId: id,
            expectedLatestId: uuid.nullable(),
            effectiveFrom: date,
            definition: z.unknown().refine(validInvoiceBatchApprovalPolicy),
          })
          .strict(),
        r.body,
      );
      if (workApprovalOwner(r) !== d.expectedOwnerKey)
        throw fail(409, 'INVOICE_APPROVAL_CONTEXT', 'Account, role or scope changed. Reload.');
      await authorize(c, r, 'manager');
      await engagement(c, r, d.engagementId, true);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-approval-policy-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = digest(d),
        old = (
          await c.query(
            'select *,effective_from::text from invoice_batch_approval_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (old.request_fingerprint !== fp)
          throw fail(409, 'INVOICE_APPROVAL_KEY', 'Original policy request differs.');
        return { ...(await envelope(c, r)), policy: policyView(old), replayed: true };
      }
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-approval-policy:${scope(r).join(':')}:${d.engagementId}`,
      ]);
      const prior = (
        await c.query(
          'select * from invoice_batch_approval_policies where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by sequence desc limit 1',
          [...scope(r), d.engagementId],
        )
      ).rows[0];
      if ((prior?.id ?? null) !== d.expectedLatestId || d.definition.engagementId !== d.engagementId)
        throw fail(409, 'INVOICE_APPROVAL_POLICY', 'Policy version or engagement changed.');
      const policyId = randomUUID();
      await context(c, r, { policyId });
      const p = (
        await c.query(
          'insert into invoice_batch_approval_policies(id,organization_id,legal_entity_id,engagement_id,sequence,previous_id,effective_from,definition,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)returning *,effective_from::text',
          [
            policyId,
            ...scope(r),
            d.engagementId,
            (prior?.sequence ?? 0) + 1,
            prior?.id ?? null,
            d.effectiveFrom,
            JSON.stringify(d.definition),
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
        module: 'Invoice Batch Approval',
        action: 'Configure Policy',
        entityType: 'InvoiceBatchPolicy',
        entityId: policyId,
        newValue: { policyId, engagementId: d.engagementId },
        reason: 'Prospective invoice batch policy.',
        details: 'No role or account grant was created.',
      });
      return { ...(await envelope(c, r)), policy: policyView(p), replayed: false };
    }),
  );
  const batch = async (c, r, batchId, lock = false) => {
    const correction=await correctionApprovalBatch(c,r,batchId,lock);
    if(correction) return correction;
    const model=await approvalBatchModel(c,r,batchId,true);
    if (model==='milestone' || model==='retainer') return loadMilestoneApprovalBatch(c,r,batchId,lock,model);
    const b = (
      await c.query(
        `select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state,invoice_batch_source_current(b) current,invoice_batch_lineage_hash(b.id) lineage_hash from invoice_draft_batches b where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3${lock ? ' for update of b' : ''}`,
        [batchId, ...scope(r)],
      )
    ).rows[0];
    if (!b) throw fail(404, 'INVOICE_APPROVAL_SOURCE', 'Scoped invoice batch unavailable.');
    if (b.source_type && b.source_type !== 'TM_SNAPSHOT')
      throw fail(409, 'INVOICE_APPROVAL_SOURCE', 'Invoice source does not match its engagement.');
    const lines = (
      await c.query(
        'select l.id,l.sequence,l.item_id,l.item_version,l.event_id,l.snapshot_id,l.currency,l.amount::text,l.billing_evidence,h.employee_id from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id where l.batch_id=$1 order by l.sequence',
        [b.id],
      )
    ).rows;
    for (const line of lines)
      await scopedCapacityWorker(c, r, line.employee_id, o.buildEmployeeScopeWhere, lock);
    const sum = (
      await c.query(
        'select count(*)::int n,trim_scale(coalesce(sum(amount),0))::text total from invoice_draft_lines where batch_id=$1',
        [b.id],
      )
    ).rows[0];
    return { row: b, lines, sum };
  };
  const instance = async (c, r, instanceId, lock = false) => {
    const i = (
      await c.query(
        'select * from invoice_batch_approval_instances where id=$1 and organization_id=$2 and legal_entity_id=$3',
        [instanceId, ...scope(r)],
      )
    ).rows[0];
    if (!i) throw fail(404, 'INVOICE_APPROVAL_SOURCE', 'Scoped review unavailable.');
    const source = await batch(c, r, i.batch_id, lock);
    return { i, source };
  };
  const approvalView = async (c, i) => {
    const p = (
        await c.query('select *,effective_from::text from invoice_batch_approval_policies where id=$1', [
          i.policy_id,
        ])
      ).rows[0],
      transitions = (
        await c.query(
          'select id,sequence,stage,decision,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from invoice_batch_approval_transitions where instance_id=$1 order by sequence',
          [i.id],
        )
      ).rows,
      cancel =
        (
          await c.query(
            'select id,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from invoice_batch_approval_invalidations where instance_id=$1',
            [i.id],
          )
        ).rows[0] ?? null,
      current = (
        await c.query(
          'select invoice_batch_approval_review_current(i) current from invoice_batch_approval_instances i where id=$1',
          [i.id],
        )
      ).rows[0].current;
    return {
      id: i.id,
      batchId: i.batch_id,
      sequence: i.sequence,
      ownerUserId: i.owner_user_id,
      ownerRole: i.owner_role,
      preparerUserId: i.preparer_user_id,
      preparerRole: i.preparer_role,
      requesterUserId: i.requester_user_id,
      activeRole: i.active_role,
      requestId: i.request_id,
      reason: i.reason,
      lineCount: i.line_count,
      lineageHash: i.lineage_hash,
      currency: i.currency,
      ...(String(i.total).startsWith('-') ? {sourceType:'FULL_LINE_REVERSAL'} : {}),
      total: String(i.total),
      createdAt: i.created_at,
      policy: policyView(p),
      state: cancel
        ? { status: 'Cancelled', sequence: transitions.length, currentStage: null }
        : invoiceBatchApprovalState(p.definition, transitions),
      current,
      transitions,
      cancellation: cancel,
    };
  };
  const sourceView = (source) => ({
    id: source.row.id,
    ...(['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD'].includes(source.row.source_type) ? { sourceType: source.row.source_type } : {}),
    state: source.row.state,
    current: source.row.current,
    currency: source.row.currency,
    clientId: source.row.client_id,
    contractId: source.row.contract_id,
    engagementId: source.row.engagement_id,
    periodStart: source.row.period_start,
    periodEnd: source.row.period_end,
    periodBasis: source.row.period_basis,
    lineageHash: source.row.lineage_hash,
    lines: source.lines.map((x) => ({
      id: x.id,
      sequence: x.sequence,
      itemId: x.item_id,
      itemVersion: x.item_version,
      eventId: x.event_id,
      snapshotId: x.snapshot_id,
      ...(['MILESTONE_ACCEPTANCE','FULL_LINE_REVERSAL','RETAINER_PERIOD'].includes(x.source_type) ? { sourceType: x.source_type } : {}),
      currency: x.currency,
      amount: x.amount,
      evidence: x.billing_evidence,
    })),
    total: source.sum.total,
    lineCount: source.sum.n,
  });
  const audit = async (c, r, action, entityId, i) =>
    o.audit(c, r, {
      module: 'Invoice Batch Approval',
      action,
      entityType: 'InvoiceBatchApproval',
      entityId,
      newValue: { instanceId: i.id, batchId: i.batch_id },
      reason: 'Scoped invoice batch review retained.',
      details: 'No financial amount in general audit.',
    });
  const emit = async (c, r, i, p, seq, stage, eventKey) => {
    const template = p.definition.templates.find((x) => x.key === eventKey),
      rendered = renderInvoiceBatchApprovalNotice(template, i.batch_id, stage + 1),
      resolved = (
        await c.query(
          'select x.recipient as "userId",x.reason from invoice_batch_approval_instances i cross join lateral invoice_batch_expected_recipients(i,$2,$3) x where i.id=$1',
          [i.id, eventKey, stage],
        )
      ).rows,
      recipients = invoiceBatchApprovalRecipients(resolved),
      mandatory = eventKey !== 'approval.completed',
      eventId = approvalEventIdentity(i.id, seq, eventKey, r.operationId).replace(
        /^work-approval\//,
        'invoice-batch-approval/',
      );
    await c.query(
      'insert into invoice_batch_approval_notices(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        eventId,
        i.id,
        seq,
        stage,
        eventKey,
        mandatory ? 'ACTION_REQUIRED' : 'INFORMATIONAL',
        p.id,
        r.operationId,
        p.definition.locale,
        rendered.title,
        rendered.body,
      ],
    );
    for (const item of recipients) {
      const pref = (
          await c.query(
            'select n.in_app from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=$1 and n.event_type=$2',
            [item.userId, eventKey],
          )
        ).rows[0],
        channel = mandatory
          ? 'Required'
          : !p.definition.completionInApp
            ? 'SuppressedPolicy'
            : pref?.in_app === false
              ? 'SuppressedPreference'
              : 'Enabled',
        inApp = channel === 'Required' || channel === 'Enabled',
        recipientId = randomUUID();
      await c.query(
        'insert into invoice_batch_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)',
        [recipientId, eventId, item.userId, item.reasons, inApp, channel],
      );
      if (inApp)
        await c.query(
          "insert into invoice_batch_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
          [randomUUID(), recipientId],
        );
    }
  };
  const baseBody = { expectedOwnerKey: key, requestId: uuid, reason };
  const fence = (r, k) => {
    if (workApprovalOwner(r) !== k)
      throw fail(409, 'INVOICE_APPROVAL_CONTEXT', 'Account, role or scope changed. Reload.');
  };
  router.get(
    '/instances',
    handle(false, async (c, r) => {
      const q = parse(z.object({ engagementId: id, after: uuid.optional() }).strict(), r.query);
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const args = [...scope(r), q.engagementId],
        workerWhere = o.buildEmployeeScopeWhere(r, args, 'worker');
      const allowedCorrections=await correctionScopeAvailable(c);
      if(allowedCorrections) args.push(r.user.sub,r.user.activeRole);
      const correctionScope=allowedCorrections
        ? `(coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT')<>'FULL_LINE_REVERSAL' or correction_original_scope_current(b,$${args.length-1},$${args.length}))`
        : "coalesce(to_jsonb(b)->>'source_type','TM_SNAPSHOT')<>'FULL_LINE_REVERSAL'";
      args.push(q.after ?? null);
      const rows = (
        await c.query(
          `select i.* from invoice_batch_approval_instances i join invoice_draft_batches b on b.id=i.batch_id where i.organization_id=$1 and i.legal_entity_id=$2 and b.engagement_id=$3 and ${correctionScope} and ($${args.length}::uuid is null or i.id>$${args.length}::uuid) and not exists(select 1 from invoice_draft_lines l join commercial_tm_valuations v on v.id=l.snapshot_id join work_submission_evidence e on e.id=v.submission_id join timesheets h on h.id=e.timesheet_id left join employees worker on worker.id=h.employee_id where l.batch_id=b.id and not coalesce((${workerWhere}),false)) order by i.id limit 51`,
          args,
        )
      ).rows;
      const approvals = [];
      for (const row of rows.slice(0, 50)) approvals.push(await approvalView(c, row));
      return {
        ...(await envelope(c, r)),
        approvals,
        nextAfter: rows.length > 50 ? rows[49].id : null,
      };
    }),
  );
  router.get('/correction-drafts',handle(false,async(c,r)=>{
    const q=parse(z.object({engagementId:id,after:uuid.optional()}).strict(),r.query);
    await authorize(c,r,'submitter');
    await engagement(c,r,q.engagementId);
    const rows=(await c.query(`select b.id,b.currency from invoice_draft_batches b where b.organization_id=$1 and b.legal_entity_id=$2
      and b.engagement_id=$3 and b.source_type='FULL_LINE_REVERSAL' and invoice_batch_governed_state(b.id)='Draft'
      and correction_original_scope_current(b,$4,$5) and ($6::uuid is null or b.id>$6) order by b.id limit 51`,
      [...scope(r),q.engagementId,r.user.sub,r.user.activeRole,q.after??null])).rows;
    return {...await envelope(c,r),engagementId:q.engagementId,drafts:rows.slice(0,50),nextAfter:rows.length>50?rows[49].id:null};
  }));
  router.get(
    '/sources/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      return { ...(await envelope(c, r)), batch: sourceView(await batch(c, r, parse(uuid, r.params.id))) };
    }),
  );
  router.post(
    '/requests',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            ...baseBody,
            batchId: uuid,
            expectedPolicyId: uuid,
            expectedLineCount: z.number().int().min(1).max(1000000),
            expectedLineageHash: key,
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'submitter');
      const source = await batch(c, r, d.batchId, true),
        b = source.row;
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-approval-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = digest(d),
        old = (
          await c.query(
            'select * from invoice_batch_approval_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (
          old.request_fingerprint !== fp ||
          old.active_role !== r.user.activeRole ||
          old.batch_id !== d.batchId
        )
          throw fail(409, 'INVOICE_APPROVAL_KEY', 'Original review request differs.');
        return { ...(await envelope(c, r)), approval: await approvalView(c, old), replayed: true };
      }
      if (
        b.state !== 'Draft' ||
        !b.current ||
        source.sum.n !== d.expectedLineCount ||
        b.lineage_hash !== d.expectedLineageHash
      )
        throw fail(409, 'INVOICE_APPROVAL_SOURCE', 'The current batch or its lines changed. Reload.');
      const p = (
        await c.query(
          'select * from invoice_batch_approval_policies where id=$1 and organization_id=$2 and legal_entity_id=$3 and engagement_id=$4',
          [d.expectedPolicyId, ...scope(r), b.engagement_id],
        )
      ).rows[0];
      if (!p) throw fail(409, 'INVOICE_APPROVAL_POLICY', 'Exact invoice policy unavailable.');
      const instanceId = randomUUID(),
        seq = (
          await c.query(
            'select coalesce(max(sequence),0)::int n from invoice_batch_approval_instances where batch_id=$1',
            [b.id],
          )
        ).rows[0].n;
      await context(c, r, { batchId: b.id, instanceId });
      const i = (
        await c.query(
          'insert into invoice_batch_approval_instances(id,organization_id,legal_entity_id,batch_id,sequence,policy_id,owner_user_id,owner_role,preparer_user_id,preparer_role,requester_user_id,active_role,line_count,lineage_hash,currency,total,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)returning *',
          [
            instanceId,
            ...scope(r),
            b.id,
            seq + 1,
            p.id,
            b.owner_user_id,
            b.owner_role,
            b.preparer_user_id,
            b.preparer_role,
            r.user.sub,
            r.user.activeRole,
            source.sum.n,
            b.lineage_hash,
            b.currency,
            source.sum.total,
            d.requestId,
            fp,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await c.query(
        "insert into approval_records(id,entity_type,entity_id,subject_employee_id,status,source)values($1,'InvoiceBatchApproval',$2,null,'Pending','Web')",
        ['invoice-batch-' + instanceId, instanceId],
      );
      await emit(c, r, i, p, 0, 0, 'approval.action_required');
      await audit(c, r, 'Request Review', instanceId, i);
      return { ...(await envelope(c, r)), approval: await approvalView(c, i), replayed: false };
    }),
  );
  router.get(
    '/instances/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const { i, source } = await instance(c, r, parse(uuid, r.params.id));
      return { ...(await envelope(c, r)), approval: await approvalView(c, i), batch: sourceView(source) };
    }),
  );
  router.post(
    '/instances/:id/decisions',
    handle(true, async (c, r) => {
      const instanceId = parse(uuid, r.params.id),
        d = parse(
          z
            .object({
              ...baseBody,
              expectedSequence: z.number().int().min(0).max(9),
              decision: z.enum(['Approved', 'Rejected']),
            })
            .strict(),
          r.body,
        );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'decider');
      const { i } = await instance(c, r, instanceId, true);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-approval-decision:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = digest(d),
        old = (
          await c.query(
            'select * from invoice_batch_approval_transitions where actor_id=$1 and request_id=$2',
            [r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (
          old.actor_id !== r.user.sub ||
          old.instance_id !== i.id ||
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== fp
        )
          throw fail(409, 'INVOICE_APPROVAL_KEY', 'Original decision differs.');
        return { ...(await envelope(c, r)), approval: await approvalView(c, i), replayed: true };
      }
      const p = (await c.query('select * from invoice_batch_approval_policies where id=$1', [i.policy_id]))
          .rows[0],
        transitions = (
          await c.query(
            'select sequence,stage,decision from invoice_batch_approval_transitions where instance_id=$1 order by sequence',
            [i.id],
          )
        ).rows,
        state = invoiceBatchApprovalState(p.definition, transitions);
      if (state.status !== 'Pending' || state.sequence !== d.expectedSequence)
        throw fail(409, 'INVOICE_APPROVAL_STALE', 'The current stage changed. Reload.');
      const final = d.decision === 'Approved' && state.sequence + 1 === p.definition.stages.length,
        transitionId = randomUUID();
      await context(c, r, { batchId: i.batch_id, instanceId: i.id, transitionId });
      await c.query(
        'insert into invoice_batch_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          transitionId,
          i.id,
          state.sequence + 1,
          state.currentStage,
          d.decision,
          r.user.sub,
          r.user.activeRole,
          d.requestId,
          fp,
          d.reason,
          r.operationId,
        ],
      );
      const status = d.decision === 'Rejected' ? 'Rejected' : final ? 'Approved' : 'Pending';
      await c.query(
        "update approval_records set status=$2,updated_at=now() where entity_type='InvoiceBatchApproval' and entity_id=$1",
        [i.id, status],
      );
      await audit(c, r, 'Decide Review', transitionId, i);
      if (!final && d.decision === 'Approved')
        await emit(c, r, i, p, state.sequence + 1, state.currentStage + 1, 'approval.action_required');
      else if (d.decision === 'Rejected')
        await emit(
          c,
          r,
          i,
          p,
          state.sequence + 1,
          state.currentStage,
          'approval.rejected_or_correction_required',
        );
      else {
        await c.query('savepoint optional_invoice_batch_notice');
        try {
          await emit(c, r, i, p, state.sequence + 1, state.currentStage, 'approval.completed');
          await c.query('set constraints complete_invoice_batch_review_transition immediate');
          await c.query('set constraints complete_invoice_batch_review_transition deferred');
          await c.query('release savepoint optional_invoice_batch_notice');
        } catch {
          await c.query('rollback to savepoint optional_invoice_batch_notice');
          await c.query(
            "insert into invoice_batch_approval_notice_failures(id,instance_id,transition_sequence,code)values($1,$2,$3,'INFORMATIONAL_NOTIFICATION_UNAVAILABLE')",
            [randomUUID(), i.id, state.sequence + 1],
          );
          await c.query('release savepoint optional_invoice_batch_notice');
        }
      }
      return { ...(await envelope(c, r)), approval: await approvalView(c, i), replayed: false };
    }),
  );
  router.post(
    '/instances/:id/withdrawals',
    handle(true, async (c, r) => {
      const instanceId = parse(uuid, r.params.id),
        d = parse(z.object({ ...baseBody }).strict(), r.body);
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'submitter');
      const { i, source } = await instance(c, r, instanceId, true);
      if (i.requester_user_id !== r.user.sub || i.active_role !== r.user.activeRole)
        throw fail(403, 'INVOICE_APPROVAL_AUTHORITY', 'Only the retained requester may withdraw the review.');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `invoice-approval-withdrawal:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const fp = digest(d),
        old = (
          await c.query(
            'select * from invoice_batch_approval_invalidations where actor_id=$1 and request_id=$2',
            [r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (
          old.instance_id !== i.id ||
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== fp
        )
          throw fail(409, 'INVOICE_APPROVAL_KEY', 'Original withdrawal differs.');
        return { ...(await envelope(c, r)), approval: await approvalView(c, i), replayed: true };
      }
      if (source.row.state !== 'Under Review')
        throw fail(409, 'INVOICE_APPROVAL_STALE', 'The review is no longer pending.');
      const invalidationId = randomUUID();
      await context(c, r, { batchId: i.batch_id, instanceId: i.id, invalidationId });
      await c.query(
        'insert into invoice_batch_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
        [invalidationId, i.id, r.user.sub, r.user.activeRole, d.requestId, fp, d.reason, r.operationId],
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
        newValue: { invalidationId, instanceId: i.id, batchId: i.batch_id },
        reason: 'Scoped review withdrawal.',
        details: 'No financial amount in general audit.',
      });
      return { ...(await envelope(c, r)), approval: await approvalView(c, i), replayed: false };
    }),
  );
  router.get(
    '/receipts/:type/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const typ = parse(z.enum(['policy', 'request', 'decision', 'withdrawal']), r.params.type),
        requestId = parse(uuid, r.params.requestId);
      if (typ === 'policy') {
        const p = (
          await c.query(
            'select *,effective_from::text from invoice_batch_approval_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
        if (!p) throw fail(404, 'INVOICE_APPROVAL_UNCONFIRMED', 'Original receipt unavailable.');
        await engagement(c, r, p.engagement_id);
        return { ...(await envelope(c, r)), type: typ, policy: policyView(p) };
      }
      const table =
          typ === 'request'
            ? 'invoice_batch_approval_instances'
            : typ === 'decision'
              ? 'invoice_batch_approval_transitions'
              : 'invoice_batch_approval_invalidations',
        owner = typ === 'request' ? 'requester_user_id' : 'actor_id',
        join =
          typ === 'request'
            ? 'join invoice_batch_approval_instances i on i.id=t.id'
            : 'join invoice_batch_approval_instances i on i.id=t.instance_id',
        rows = (
          await c.query(
            `select t.* from ${table} t ${join} where t.${owner}=$1 and t.active_role=$2 and t.request_id=$3 and i.organization_id=$4 and i.legal_entity_id=$5 limit 2`,
            [r.user.sub, r.user.activeRole, requestId, ...scope(r)],
          )
        ).rows;
      if (rows.length !== 1)
        throw fail(
          rows.length ? 409 : 404,
          'INVOICE_APPROVAL_UNCONFIRMED',
          'Original receipt cannot be uniquely confirmed.',
        );
      const row = rows[0],
        { i } = await instance(c, r, typ === 'request' ? row.id : row.instance_id);
      return { ...(await envelope(c, r)), type: typ, approval: await approvalView(c, i) };
    }),
  );
  return router;
};
