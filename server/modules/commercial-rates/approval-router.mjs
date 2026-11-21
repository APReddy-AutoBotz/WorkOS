import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  validCommercialCandidatePolicy,
  commercialApprovalState,
  commercialApprovalRecipients,
  renderCommercialApproval,
} from '../../../shared/commercial-candidate-approval.mjs';
import { approvalEventIdentity } from '../../../shared/work-approval.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { authorizeRateCandidate, scopedRateCandidateSource, rateCandidateContext } from './router.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';

const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  reason = z.string().trim().min(3).max(1000),
  date = z.string().date();
const err = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId];
const parse = (schema, value) => {
  const p = schema.safeParse(value);
  if (!p.success)
    throw err(400, 'COMMERCIAL_APPROVAL_INVALID', 'Supply an explicit valid commercial approval command.');
  return p.data;
};
const fence = (r, key) => {
  if (workApprovalOwner(r) !== key)
    throw err(409, 'COMMERCIAL_APPROVAL_CONTEXT_CHANGED', 'Account or selected scope changed. Reload.');
};
const fp = (x) => capacityHash(capacityCanonical(x));
const policyView = (p) => ({
  id: p.id,
  candidateId: p.candidate_id,
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
const instanceView = async (c, i) => {
  const p = (
    await c.query('select *,effective_from::text from commercial_candidate_approval_policies where id=$1', [
      i.policy_id,
    ])
  ).rows[0];
  const transitions = (
    await c.query(
      'select id,sequence,stage,decision,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from commercial_candidate_approval_transitions where instance_id=$1 order by sequence',
      [i.id],
    )
  ).rows;
  const state = commercialApprovalState(p.definition, transitions),
    cancel =
      (
        await c.query(
          'select id,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from commercial_candidate_approval_invalidations where instance_id=$1',
          [i.id],
        )
      ).rows[0] ?? null,
    current = (
      await c.query(
        'select commercial_candidate_approval_is_current(i) current from commercial_candidate_approval_instances i where i.id=$1',
        [i.id],
      )
    ).rows[0].current;
  return {
    id: i.id,
    candidateId: i.candidate_id,
    ownerEventId: i.owner_event_id,
    policy: policyView(p),
    requesterUserId: i.requester_user_id,
    activeRole: i.active_role,
    requestId: i.request_id,
    reason: i.reason,
    createdAt: i.created_at,
    state: cancel ? { status: 'Cancelled', sequence: state.sequence, currentStage: null } : state,
    current,
    transitions,
    cancellation: cancel,
  };
};
const eventId = (id, seq, key, op) =>
  approvalEventIdentity(id, seq, key, op).replace(/^work-approval\//, 'commercial-candidate-approval/');
export const createCommercialCandidateApprovalRouter = (o) => {
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
      else if (['CCA01', 'CCA02', 'CCA03', 'CCA04', '23505', '23514', '40001', '40P01'].includes(e.code))
        res
          .status(e.code === 'CCA01' ? 403 : 409)
          .json({
            code: e.code === 'CCA01' ? 'COMMERCIAL_APPROVAL_AUTHORITY' : 'COMMERCIAL_APPROVAL_CONFLICT',
            error: 'Current commercial approval authority or source changed. Reload.',
          });
      else {
        o.logError?.(e);
        res
          .status(503)
          .json({
            code: 'COMMERCIAL_APPROVAL_UNCONFIRMED',
            error: 'The operation could not be confirmed. Read its original receipt.',
          });
      }
    } finally {
      c?.release();
    }
  };
  const candidate = async (c, r, id, write = false) => {
    const x = (
      await c.query(
        'select * from commercial_rate_candidates where id=$1 and organization_id=$2 and legal_entity_id=$3',
        [id, ...scope(r)],
      )
    ).rows[0];
    if (!x) throw err(404, 'COMMERCIAL_APPROVAL_NOT_FOUND', 'The candidate is unavailable in this scope.');
    await authorizeRateCandidate(c, r, x.kind, write);
    if (write && x.kind === 'billing') {
      await c.query(
        "select permission_key from role_permissions where role_name=$1 and permission_key='commercial.contracts.manage' for share",
        [r.user.activeRole],
      );
      await c.query(
        "select permission_key from user_permission_grants where user_id=$1 and permission_key='commercial.contracts.manage' for share",
        [r.user.sub],
      );
      await assertCommercialAuthority(c, r, 'commercial.contracts.manage');
    }
    await scopedRateCandidateSource(c, r, x.kind, x.binding_type, x.binding_id, o, write);
    return x;
  };
  const instance = async (c, r, id) => {
    const x = (
      await c.query(
        'select * from commercial_candidate_approval_instances where id=$1 and organization_id=$2 and legal_entity_id=$3',
        [id, ...scope(r)],
      )
    ).rows[0];
    if (!x) throw err(404, 'COMMERCIAL_APPROVAL_NOT_FOUND', 'The approval is unavailable in this scope.');
    const source = await candidate(c, r, x.candidate_id);
    return { x, source };
  };
  const ctx = async (c, r, id = null) =>
    c.query("select set_config('workos.commercial_approval_context',$1,true)", [
      JSON.stringify({
        organizationId: scope(r)[0],
        legalEntityId: scope(r)[1],
        actorId: r.user.sub,
        activeRole: r.user.activeRole,
        operationId: r.operationId,
        instanceId: id,
      }),
    ]);
  const audit = async (c, r, action, id, instanceId) =>
    o.audit(c, r, {
      module: 'Commercial Approval',
      action,
      entityType: 'CommercialCandidateApproval',
      entityId: id,
      newValue: { approvalEventId: id, instanceId },
      reason: 'Protected commercial approval evidence retained.',
      details: 'No rate or cost details are included in general audit.',
    });
  const emit = async (c, r, i, p, sequence, stage, key) => {
    const template = p.definition.templates.find((x) => x.key === key);
    if (!template) throw err(409, 'COMMERCIAL_APPROVAL_TEMPLATE', 'Canonical template unavailable.');
    const rendered = renderCommercialApproval(template, i.candidate_id, stage + 1),
      source = (await c.query('select * from commercial_rate_candidates where id=$1', [i.candidate_id]))
        .rows[0],
      owner = (await c.query('select * from commercial_candidate_owners where id=$1', [i.owner_event_id]))
        .rows[0];
    let worker = null;
    if (key !== 'approval.action_required' && source.kind === 'cost') {
      const rows = (
        await c.query(
          "select u.id from users u join user_organization_scopes s on s.user_id=u.id where u.employee_record_id=$1 and u.status='Active' and s.organization_id=$2 and s.legal_entity_id=$3 and s.active order by u.id limit 2",
          [source.binding_id, ...scope(r)],
        )
      ).rows;
      if (rows.length !== 1)
        throw err(409, 'COMMERCIAL_APPROVAL_RECIPIENT', 'Affected worker relationship is unavailable.');
      worker = rows[0].id;
    }
    const entries =
        key === 'approval.action_required'
          ? [{ userId: p.definition.stages[stage].userId, reason: 'current_stage_approver' }]
          : [
              { userId: i.requester_user_id, reason: 'requester' },
              ...(key === 'approval.rejected_or_correction_required'
                ? [{ userId: owner.owner_user_id, reason: 'commercial_change_owner' }]
                : []),
              ...(worker ? [{ userId: worker, reason: 'affected_worker' }] : []),
            ],
      recipients = commercialApprovalRecipients(entries),
      mandatory = key !== 'approval.completed',
      id = eventId(i.id, sequence, key, r.operationId);
    await c.query(
      'insert into commercial_candidate_approval_events(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        i.id,
        sequence,
        stage,
        key,
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
            [item.userId, key],
          )
        ).rows[0],
        channel = mandatory
          ? 'Required'
          : !p.definition.completionInApp
            ? 'SuppressedPolicy'
            : pref?.in_app === false
              ? 'SuppressedPreference'
              : 'Enabled',
        inApp = ['Required', 'Enabled'].includes(channel),
        rid = randomUUID();
      await c.query(
        'insert into commercial_candidate_approval_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)',
        [rid, id, item.userId, item.reasons, inApp, channel],
      );
      if (inApp)
        await c.query(
          "insert into commercial_candidate_approval_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
          [randomUUID(), rid],
        );
    }
  };
  const bodyFence = { expectedOwnerKey: hash, requestId: uuid };
  router.post(
    '/policies',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            ...bodyFence,
            expectedLatestId: uuid.nullable(),
            effectiveFrom: date,
            definition: z.unknown().refine(validCommercialCandidatePolicy),
            reason,
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      const source = await candidate(c, r, d.definition.candidateId, true);
      if (source.kind !== d.definition.kind)
        throw err(409, 'COMMERCIAL_APPROVAL_SOURCE', 'Candidate kind changed.');
      const digest = fp(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-policy-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          'select *,effective_from::text from commercial_candidate_approval_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
          [...scope(r), r.user.sub, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.request_fingerprint !== digest || old.active_role !== r.user.activeRole)
          throw err(409, 'COMMERCIAL_APPROVAL_KEY', 'Original policy request differs.');
        return { ...(await rateCandidateContext(c, r)), policy: policyView(old), replayed: true };
      }
      const prior = (
        await c.query(
          'select * from commercial_candidate_approval_policies where organization_id=$1 and legal_entity_id=$2 and candidate_id=$3 order by sequence desc limit 1',
          [...scope(r), source.id],
        )
      ).rows[0];
      if ((prior?.id ?? null) !== d.expectedLatestId)
        throw err(409, 'COMMERCIAL_APPROVAL_POLICY_STALE', 'Policy changed. Reload.');
      await ctx(c, r);
      const id = randomUUID(),
        row = (
          await c.query(
            'insert into commercial_candidate_approval_policies(id,organization_id,legal_entity_id,candidate_id,sequence,previous_id,effective_from,definition,actor_id,active_role,reason,request_id,request_fingerprint,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)returning *,effective_from::text',
            [
              id,
              ...scope(r),
              source.id,
              (prior?.sequence ?? 0) + 1,
              prior?.id ?? null,
              d.effectiveFrom,
              JSON.stringify(d.definition),
              r.user.sub,
              r.user.activeRole,
              d.reason,
              d.requestId,
              digest,
              r.operationId,
            ],
          )
        ).rows[0];
      await audit(c, r, 'Configure Candidate Approval', id, id);
      return { ...(await rateCandidateContext(c, r)), policy: policyView(row), replayed: false };
    }),
  );
  router.post(
    '/requests',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            ...bodyFence,
            candidateId: uuid,
            expectedOwnerEventId: uuid,
            expectedPolicyId: uuid,
            reason,
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      const source = await candidate(c, r, d.candidateId, true),
        digest = fp(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-approval-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          'select * from commercial_candidate_approval_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and request_id=$4',
          [...scope(r), r.user.sub, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.request_fingerprint !== digest || old.active_role !== r.user.activeRole)
          throw err(409, 'COMMERCIAL_APPROVAL_KEY', 'Original request differs.');
        return {
          ...(await rateCandidateContext(c, r)),
          approval: await instanceView(c, old),
          replayed: true,
        };
      }
      const p = (
        await c.query(
          'select * from commercial_candidate_approval_policies where id=$1 and organization_id=$2 and legal_entity_id=$3 and candidate_id=$4',
          [d.expectedPolicyId, ...scope(r), source.id],
        )
      ).rows[0];
      if (!p) throw err(409, 'COMMERCIAL_APPROVAL_POLICY', 'Policy unavailable.');
      const id = randomUUID();
      await ctx(c, r, id);
      const i = (
        await c.query(
          'insert into commercial_candidate_approval_instances(id,organization_id,legal_entity_id,candidate_id,owner_event_id,policy_id,requester_user_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)returning *',
          [
            id,
            ...scope(r),
            source.id,
            d.expectedOwnerEventId,
            p.id,
            r.user.sub,
            r.user.activeRole,
            d.requestId,
            digest,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await c.query(
        "insert into approval_records(id,entity_type,entity_id,subject_employee_id,status,source)values($1,'CommercialCandidateApproval',$2,$3,'Pending','Web')",
        ['commercial-candidate-' + id, id, source.kind === 'cost' ? source.binding_id : null],
      );
      await emit(c, r, i, p, 0, 0, 'approval.action_required');
      await audit(c, r, 'Request Candidate Approval', id, id);
      return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, i), replayed: false };
    }),
  );
  router.get(
    '/instances/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      const { x } = await instance(c, r, parse(uuid, r.params.id));
      return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, x) };
    }),
  );
  router.post(
    '/instances/:id/decisions',
    handle(true, async (c, r) => {
      const id = parse(uuid, r.params.id),
        d = parse(
          z
            .object({
              ...bodyFence,
              expectedCandidateId: uuid,
              expectedOwnerEventId: uuid,
              expectedPolicyId: uuid,
              expectedSequence: z.number().int().min(0).max(9),
              decision: z.enum(['Approved', 'Rejected']),
              reason,
            })
            .strict(),
          r.body,
        );
      fence(r, d.expectedOwnerKey);
      const { x, source } = await instance(c, r, id);
      await scopedRateCandidateSource(c, r, source.kind, source.binding_type, source.binding_id, o, true);
      const decisionPermission =
        source.kind === 'billing' ? 'commercial.rate_approvals.decide' : 'commercial.cost_approvals.decide';
      for (const k of [decisionPermission, 'approvals.view', 'notifications.view']) {
        await c.query(
          'select permission_key from role_permissions where role_name=$1 and permission_key=$2 for share',
          [r.user.activeRole, k],
        );
        await c.query(
          'select permission_key from user_permission_grants where user_id=$1 and permission_key=$2 for share',
          [r.user.sub, k],
        );
        await assertCommercialAuthority(c, r, k);
      }
      const digest = fp(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-approval-decision:${id}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          'select * from commercial_candidate_approval_transitions where instance_id=$1 and request_id=$2',
          [id, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (
          old.request_fingerprint !== digest ||
          old.actor_id !== r.user.sub ||
          old.active_role !== r.user.activeRole
        )
          throw err(409, 'COMMERCIAL_APPROVAL_KEY', 'Original decision differs.');
        return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, x), replayed: true };
      }
      if (
        x.candidate_id !== d.expectedCandidateId ||
        x.owner_event_id !== d.expectedOwnerEventId ||
        x.policy_id !== d.expectedPolicyId
      )
        throw err(409, 'COMMERCIAL_APPROVAL_STALE', 'Source changed.');
      const p = (
          await c.query('select * from commercial_candidate_approval_policies where id=$1', [x.policy_id])
        ).rows[0],
        ts = (
          await c.query(
            'select sequence,stage,decision from commercial_candidate_approval_transitions where instance_id=$1 order by sequence',
            [id],
          )
        ).rows,
        state = commercialApprovalState(p.definition, ts);
      if (state.status !== 'Pending' || state.sequence !== d.expectedSequence)
        throw err(409, 'COMMERCIAL_APPROVAL_STALE', 'The stage changed. Reload.');
      await ctx(c, r, id);
      const transitionId = randomUUID(),
        seq = state.sequence + 1;
      await c.query(
        'insert into commercial_candidate_approval_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          transitionId,
          id,
          seq,
          state.currentStage,
          d.decision,
          r.user.sub,
          r.user.activeRole,
          d.requestId,
          digest,
          d.reason,
          r.operationId,
        ],
      );
      const final = d.decision === 'Rejected' || seq === p.definition.stages.length,
        status = d.decision === 'Rejected' ? 'Rejected' : final ? 'Approved' : 'Pending';
      await c.query(
        "update approval_records set status=$2,updated_at=now() where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [id, status],
      );
      if (!final) await emit(c, r, x, p, seq, seq, 'approval.action_required');
      else if (d.decision === 'Rejected')
        await emit(c, r, x, p, seq, state.currentStage, 'approval.rejected_or_correction_required');
      else {
        await c.query('savepoint optional_commercial_notice');
        try {
          await emit(c, r, x, p, seq, state.currentStage, 'approval.completed');
          await c.query('set constraints complete_commercial_candidate_approval_transition immediate');
          await c.query('set constraints complete_commercial_candidate_approval_transition deferred');
          await c.query('release savepoint optional_commercial_notice');
        } catch {
          await c.query('rollback to savepoint optional_commercial_notice');
          await c.query(
            "insert into commercial_candidate_approval_notification_failures(id,instance_id,transition_sequence,code)values($1,$2,$3,'INFORMATIONAL_NOTIFICATION_UNAVAILABLE')",
            [randomUUID(), id, seq],
          );
          await c.query('release savepoint optional_commercial_notice');
        }
      }
      await audit(c, r, 'Decide Candidate Approval', transitionId, id);
      return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, x), replayed: false };
    }),
  );
  router.post(
    '/instances/:id/cancellations',
    handle(true, async (c, r) => {
      const id = parse(uuid, r.params.id),
        d = parse(z.object({ ...bodyFence, expectedSequence: z.number().int().min(0).max(9).optional(), reason }).strict(), r.body);
      fence(r, d.expectedOwnerKey);
      const { x } = await instance(c, r, id);
      const source = await candidate(c, r, x.candidate_id, true);
      const digest = fp(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-cancel-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query(
          'select * from commercial_candidate_approval_invalidations where actor_id=$1 and request_id=$2',
          [r.user.sub, d.requestId],
        )
      ).rows[0];
      if (old) {
        if (
          old.request_fingerprint !== digest ||
          old.instance_id !== id ||
          old.active_role !== r.user.activeRole
        )
          throw err(409, 'COMMERCIAL_APPROVAL_KEY', 'Original cancellation differs.');
        return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, x), replayed: true };
      }
      // Approval transitions acquire this stream lock in the database before they append.
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `rate-candidate:${scope(r).join(':')}:${source.stream_id}`,
      ]);
      const { state } = await instanceView(c, x);
      if (state.status !== 'Pending' || state.sequence !== (d.expectedSequence ?? 0))
        throw err(409, 'COMMERCIAL_APPROVAL_STAGE_CHANGED', 'Reload the current stage before cancelling.');
      await ctx(c, r, id);
      const cid = randomUUID();
      await c.query(
        'insert into commercial_candidate_approval_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
        [cid, id, r.user.sub, r.user.activeRole, d.requestId, digest, d.reason, r.operationId],
      );
      await c.query(
        "update approval_records set status='Cancelled',updated_at=now() where entity_type='CommercialCandidateApproval' and entity_id=$1",
        [id],
      );
      await o.audit(c, r, {
        module: 'Commercial Approval',
        action: 'Cancel Request',
        entityType: 'CommercialCandidateApproval',
        entityId: cid,
        newValue: { cancellationId: cid, instanceId: id },
        reason: 'Protected commercial approval cancellation retained.',
        details: 'No rate or cost details are included in general audit.',
      });
      return { ...(await rateCandidateContext(c, r)), approval: await instanceView(c, x), replayed: false };
    }),
  );
  router.get(
    '/policies',
    handle(false, async (c, r) => {
      const q = parse(
        z.object({ candidateId: uuid, includeEffective: z.literal('true').optional() }).strict(),
        r.query,
      );
      await candidate(c, r, q.candidateId);
      const rows = (
        await c.query(
          'select *,effective_from::text from commercial_candidate_approval_policies where organization_id=$1 and legal_entity_id=$2 and candidate_id=$3 order by sequence desc limit 11',
          [...scope(r), q.candidateId],
        )
      ).rows;
      const env = await rateCandidateContext(c, r);
      const result = {
        ...env,
        candidateId: q.candidateId,
        policies: rows.slice(0, 10).map(policyView),
        truncated: rows.length > 10,
      };
      if (q.includeEffective) {
        const active = await c.query(
          'select *,effective_from::text from commercial_candidate_approval_policies where organization_id=$1 and legal_entity_id=$2 and candidate_id=$3 and effective_from<=$4::date order by sequence desc limit 1',
          [...scope(r), q.candidateId, env.serverDate],
        );
        result.effectivePolicy = active.rowCount ? policyView(active.rows[0]) : null;
      }
      return result;
    }),
  );
  router.get(
    '/requests',
    handle(false, async (c, r) => {
      const q = parse(z.object({ candidateId: uuid }).strict(), r.query);
      await candidate(c, r, q.candidateId);
      const rows = (
        await c.query(
          'select * from commercial_candidate_approval_instances where organization_id=$1 and legal_entity_id=$2 and candidate_id=$3 order by created_at desc,id desc limit 11',
          [...scope(r), q.candidateId],
        )
      ).rows;
      return {
        ...(await rateCandidateContext(c, r)),
        candidateId: q.candidateId,
        approvals: await Promise.all(rows.slice(0, 10).map((x) => instanceView(c, x))),
        truncated: rows.length > 10,
      };
    }),
  );
  router.get(
    '/receipts/:type/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      const typ = parse(z.enum(['policy', 'request', 'decision', 'cancellation']), r.params.type),
        id = parse(uuid, r.params.requestId);
      if (typ === 'policy') {
        const p = (
          await c.query(
            'select *,effective_from::text from commercial_candidate_approval_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, id],
          )
        ).rows[0];
        if (!p) throw err(404, 'COMMERCIAL_APPROVAL_NOT_FOUND', 'Original receipt is unavailable.');
        await candidate(c, r, p.candidate_id);
        return { ...(await rateCandidateContext(c, r)), type: typ, policy: policyView(p) };
      }
      let i;
      if (typ === 'request')
        i = (
          await c.query(
            'select * from commercial_candidate_approval_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, id],
          )
        ).rows[0];
      else {
        const table =
          typ === 'decision'
            ? 'commercial_candidate_approval_transitions'
            : 'commercial_candidate_approval_invalidations';
        i = (
          await c.query(
            `select i.* from ${table} t join commercial_candidate_approval_instances i on i.id=t.instance_id where i.organization_id=$1 and i.legal_entity_id=$2 and t.actor_id=$3 and t.active_role=$4 and t.request_id=$5`,
            [...scope(r), r.user.sub, r.user.activeRole, id],
          )
        ).rows[0];
      }
      if (!i) throw err(404, 'COMMERCIAL_APPROVAL_NOT_FOUND', 'Original receipt is unavailable.');
      await candidate(c, r, i.candidate_id);
      return { ...(await rateCandidateContext(c, r)), type: typ, approval: await instanceView(c, i) };
    }),
  );
  return router;
};
