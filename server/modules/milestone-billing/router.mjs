import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { approvalEventIdentity } from '../../../shared/work-approval.mjs';
import {
  validMilestoneBillingPolicy,
  validMilestoneEvidence,
  milestoneBillingState,
  renderMilestoneBillingNotice,
} from '../../../shared/milestone-billing-eligibility.mjs';

const uuid = z.string().uuid(),
  id = z.string().trim().min(1).max(200),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  reason = z.string().trim().min(3).max(1000);
const scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId];
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const parse = (schema, value) => {
  const p = schema.safeParse(value);
  if (!p.success)
    throw fail(400, 'MILESTONE_BILLING_INVALID', 'Supply explicit valid milestone billing inputs.');
  return p.data;
};
const fingerprint = (x) => capacityHash(capacityCanonical(x));
const policyView = (p) => ({
  id: p.id,
  engagementId: p.engagement_id,
  sequence: p.sequence,
  previousId: p.previous_id,
  effectiveFrom: String(p.effective_from).slice(0, 10),
  definition: p.definition,
  actorId: p.actor_id,
  activeRole: p.active_role,
  requestId: p.request_id,
  reason: p.reason,
  createdAt: p.created_at,
});

export const createMilestoneBillingRouter = (o) => {
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
      const result = await fn(c, r);
      await c.query('commit');
      begun = false;
      res.status(write && !result.replayed ? 201 : 200).json(result);
    } catch (e) {
      if (begun) await c.query('rollback').catch(() => {});
      if (e.statusCode) res.status(e.statusCode).json({ code: e.code, error: e.message });
      else if (['MBE01', 'MBE02', 'MBE03', 'MBE04', '23505', '23514', '40001', '40P01'].includes(e.code))
        res.status(e.code === 'MBE01' ? 403 : 409).json({
          code: e.code === 'MBE01' ? 'MILESTONE_BILLING_AUTHORITY' : 'MILESTONE_BILLING_CONFLICT',
          error: 'Current milestone, owner, scope or approval changed. Reload.',
        });
      else {
        o.logError?.(e);
        res.status(503).json({
          code: 'MILESTONE_BILLING_UNCONFIRMED',
          error: 'The operation could not be confirmed. Read its original receipt.',
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
    organizationId: scope(r)[0],
    legalEntityId: scope(r)[1],
    serverDate: (await c.query("select to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD') d"))
      .rows[0].d,
  });
  const authorize = async (c, r, kind = 'viewer') => {
    const keys = [
      'commercial.contracts.view',
      'commercial.milestone_billing.view',
      'employees.view',
      'notifications.view',
      ...(kind === 'manager'
        ? ['commercial.contracts.manage', 'commercial.milestone_billing.manage']
        : kind === 'decider'
          ? ['approvals.view', 'commercial.milestone_billing.decide']
          : []),
    ].sort();
    const held = await c.query(
      'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
      [r.user.sub, ...scope(r)],
    );
    if (!held.rowCount) throw fail(403, 'MILESTONE_BILLING_AUTHORITY', 'Current scope unavailable.');
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
  const fence = (r, k) => {
    if (workApprovalOwner(r) !== k)
      throw fail(409, 'MILESTONE_BILLING_CONTEXT', 'Account, role or scope changed. Reload.');
  };
  const ctx = async (c, r, extra = {}) =>
    c.query("select set_config('workos.milestone_billing_context',$1,true)", [
      JSON.stringify({
        organizationId: scope(r)[0],
        legalEntityId: scope(r)[1],
        actorId: r.user.sub,
        activeRole: r.user.activeRole,
        operationId: r.operationId,
        ...extra,
      }),
    ]);
  const audit = async (c, r, action, eventId, instanceId, milestoneId) =>
    o.audit(c, r, {
      module: 'Milestone Billing Eligibility',
      action,
      entityType: 'MilestoneBillingEligibilityApproval',
      entityId: eventId,
      newValue: { instanceId, milestoneId },
      reason: 'Protected milestone billing review.',
      details: 'No source evidence or commercial amount is included in general audit.',
    });
  const source = async (c, r, milestoneId, lock = false) => {
    const x = (
      await c.query(
        `select m.id,m.engagement_id as "engagementId",m.code,m.name,m.due_on::text as "dueOn",m.currency,m.amount::text,e.client_id as "clientId",e.contract_id as "contractId",e.contract_version_id as "contractVersionId",(select id from commercial_lifecycle_events where organization_id=m.organization_id and legal_entity_id=m.legal_entity_id and entity_type='Engagement' and entity_id=m.engagement_id order by sequence desc limit 1) as "engagementLifecycleId",(select id from commercial_lifecycle_events where organization_id=m.organization_id and legal_entity_id=m.legal_entity_id and entity_type='Contract' and entity_id=e.contract_id order by sequence desc limit 1) as "contractLifecycleId" from commercial_milestones m join commercial_engagements e on e.id=m.engagement_id and e.organization_id=m.organization_id and e.legal_entity_id=m.legal_entity_id where m.id=$1 and m.organization_id=$2 and m.legal_entity_id=$3${lock ? ' for share of m,e' : ''}`,
        [milestoneId, ...scope(r)],
      )
    ).rows[0];
    if (!x) throw fail(404, 'MILESTONE_BILLING_SOURCE', 'Scoped milestone unavailable.');
    x.current = (
      await c.query('select milestone_billing_source_valid($1,$2,$3,$4,$5,$6) current', [
        ...scope(r),
        x.engagementId,
        x.id,
        x.engagementLifecycleId,
        x.contractLifecycleId,
      ])
    ).rows[0].current;
    return x;
  };
  const instance = async (c, r, instanceId, lock = false) => {
    const row = (
      await c.query(
        `select * from milestone_billing_instances where id=$1 and organization_id=$2 and legal_entity_id=$3${lock ? ' for update' : ''}`,
        [instanceId, ...scope(r)],
      )
    ).rows[0];
    if (!row) throw fail(404, 'MILESTONE_BILLING_SOURCE', 'Scoped review unavailable.');
    return row;
  };
  const view = async (c, i) => {
    const p = (
        await c.query('select *,effective_from::text from milestone_billing_policies where id=$1', [
          i.policy_id,
        ])
      ).rows[0],
      transitions = (
        await c.query(
          'select id,sequence,stage,decision,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from milestone_billing_transitions where instance_id=$1 order by sequence',
          [i.id],
        )
      ).rows,
      cancel =
        (
          await c.query(
            'select id,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt" from milestone_billing_invalidations where instance_id=$1',
            [i.id],
          )
        ).rows[0] ?? null,
      current = (
        await c.query(
          'select milestone_billing_review_current(i) current from milestone_billing_instances i where i.id=$1',
          [i.id],
        )
      ).rows[0].current;
    return {
      id: i.id,
      engagementId: i.engagement_id,
      milestoneId: i.milestone_id,
      ownerUserId: i.owner_user_id,
      ownerRole: i.owner_role,
      requesterUserId: i.requester_user_id,
      activeRole: i.active_role,
      requestId: i.request_id,
      reason: i.reason,
      evidence: i.evidence,
      engagementLifecycleId: i.engagement_lifecycle_id,
      contractLifecycleId: i.contract_lifecycle_id,
      createdAt: i.created_at,
      policy: policyView(p),
      state: cancel
        ? { status: 'Cancelled', sequence: transitions.length, currentStage: null }
        : milestoneBillingState(p.definition, transitions),
      current,
      transitions,
      cancellation: cancel,
    };
  };
  const outcome = async (c, instanceId) =>
    (
      await c.query(
        'select ev.id as "eventId",item.id as "itemId" from billing_eligibility_events ev join approved_unbilled_items item on item.event_id=ev.id where ev.milestone_instance_id=$1',
        [instanceId],
      )
    ).rows[0] ?? { eventId: null, itemId: null };
  const eventId = (instanceId, sequence, key, operationId) =>
    approvalEventIdentity(instanceId, sequence, key, operationId).replace(
      /^work-approval\//,
      'milestone-billing/',
    );
  const emit = async (c, r, i, p, sequence, stage, key) => {
    const template = p.definition.templates.find((x) => x.key === key);
    if (!template) throw fail(409, 'MILESTONE_BILLING_TEMPLATE', 'Configured template unavailable.');
    const rendered = renderMilestoneBillingNotice(template, i.milestone_id, stage + 1),
      nid = eventId(i.id, sequence, key, r.operationId),
      entries =
        key === 'approval.action_required'
          ? [{ userId: p.definition.stages[stage].userId, reason: 'current_stage_approver' }]
          : [
              { userId: i.requester_user_id, reason: 'requester' },
              ...(key === 'approval.rejected_or_correction_required'
                ? [{ userId: i.owner_user_id, reason: 'commercial_change_owner' }]
                : []),
            ],
      grouped = new Map();
    for (const entry of entries) {
      const reasons = grouped.get(entry.userId) ?? [];
      if (!reasons.includes(entry.reason)) reasons.push(entry.reason);
      grouped.set(entry.userId, reasons);
    }
    await ctx(c, r, { instanceId: i.id, noticeId: nid });
    await c.query(
      'insert into milestone_billing_notices(id,instance_id,transition_sequence,stage,event_key,policy_class,policy_id,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        nid,
        i.id,
        sequence,
        stage,
        key,
        key === 'approval.completed' ? 'INFORMATIONAL' : 'ACTION_REQUIRED',
        p.id,
        r.operationId,
        p.definition.locale,
        rendered.title,
        rendered.body,
      ],
    );
    for (const [userId, reasons] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
      const pref = (
          await c.query(
            'select n.in_app from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=$1 and n.event_type=$2',
            [userId, key],
          )
        ).rows[0],
        channel =
          key !== 'approval.completed'
            ? 'Required'
            : !p.definition.completionInApp
              ? 'SuppressedPolicy'
              : pref?.in_app === false
                ? 'SuppressedPreference'
                : 'Enabled',
        inApp = ['Required', 'Enabled'].includes(channel),
        rid = randomUUID();
      await c.query(
        'insert into milestone_billing_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)',
        [rid, nid, userId, reasons.sort(), inApp, channel],
      );
      if (inApp)
        await c.query(
          "insert into milestone_billing_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",
          [randomUUID(), rid],
        );
    }
  };
  const body = { expectedOwnerKey: hash, requestId: uuid, reason };
  router.get(
    '/policies',
    handle(false, async (c, r) => {
      const q = parse(z.object({ engagementId: id }).strict(), r.query);
      await authorize(c, r);
      const rows = (
        await c.query(
          'select *,effective_from::text from milestone_billing_policies where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by sequence desc limit 21',
          [...scope(r), q.engagementId],
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        policies: rows.slice(0, 20).map(policyView),
        truncated: rows.length > 20,
      };
    }),
  );
  router.post(
    '/policies',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            ...body,
            engagementId: id,
            expectedLatestId: uuid.nullable(),
            effectiveFrom: z.string().date(),
            definition: z.unknown().refine(validMilestoneBillingPolicy),
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'manager');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `milestone-billing-policy-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const digest = fingerprint(d),
        old = (
          await c.query(
            'select *,effective_from::text from milestone_billing_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (old.request_fingerprint !== digest || old.active_role !== r.user.activeRole)
          throw fail(409, 'MILESTONE_BILLING_KEY', 'Original policy request differs.');
        return { ...(await envelope(c, r)), policy: policyView(old), replayed: true };
      }
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `commercial-lifecycle:${scope(r).join(':')}`,
      ]);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `milestone-billing-policy:${scope(r).join(':')}:${d.engagementId}`,
      ]);
      const prior = (
        await c.query(
          'select * from milestone_billing_policies where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by sequence desc limit 1',
          [...scope(r), d.engagementId],
        )
      ).rows[0];
      if ((prior?.id ?? null) !== d.expectedLatestId || d.definition.engagementId !== d.engagementId)
        throw fail(409, 'MILESTONE_BILLING_POLICY', 'Policy or engagement changed.');
      const policyId = randomUUID();
      await ctx(c, r, { policyId });
      const p = (
        await c.query(
          'insert into milestone_billing_policies(id,organization_id,legal_entity_id,engagement_id,sequence,previous_id,effective_from,definition,actor_id,active_role,reason,request_id,request_fingerprint,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)returning *,effective_from::text',
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
            d.reason,
            d.requestId,
            digest,
            r.operationId,
          ],
        )
      ).rows[0];
      await o.audit(c, r, {
        module: 'Milestone Billing Eligibility',
        action: 'Configure Policy',
        entityType: 'MilestoneBillingPolicy',
        entityId: policyId,
        newValue: { policyId, engagementId: d.engagementId },
        reason: 'Prospective milestone review policy.',
        details: 'No role or account grant was created.',
      });
      return { ...(await envelope(c, r)), policy: policyView(p), replayed: false };
    }),
  );
  router.get(
    '/sources',
    handle(false, async (c, r) => {
      const q = parse(z.object({ engagementId: id, after: id.optional() }).strict(), r.query);
      await authorize(c, r);
      const rows = (
        await c.query(
          'select id from commercial_milestones where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and ($4::text is null or id>$4) order by id limit 51',
          [...scope(r), q.engagementId, q.after ?? null],
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        sources: await Promise.all(rows.slice(0, 50).map((x) => source(c, r, x.id))),
        nextAfter: rows.length > 50 ? rows[49].id : null,
      };
    }),
  );
  router.get(
    '/sources/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      return { ...(await envelope(c, r)), source: await source(c, r, parse(id, r.params.id)) };
    }),
  );
  router.get(
    '/instances',
    handle(false, async (c, r) => {
      const q = parse(z.object({ engagementId: id, after: uuid.optional() }).strict(), r.query);
      await authorize(c, r);
      const rows = (
        await c.query(
          'select * from milestone_billing_instances where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and ($4::uuid is null or id>$4) order by id limit 51',
          [...scope(r), q.engagementId, q.after ?? null],
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        approvals: await Promise.all(rows.slice(0, 50).map((x) => view(c, x))),
        nextAfter: rows.length > 50 ? rows[49].id : null,
      };
    }),
  );
  router.get(
    '/instances/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const i = await instance(c, r, parse(uuid, r.params.id));
      return {
        ...(await envelope(c, r)),
        approval: await view(c, i),
        source: await source(c, r, i.milestone_id),
        ...(await outcome(c, i.id)),
      };
    }),
  );
  router.post(
    '/requests',
    handle(true, async (c, r) => {
      const d = parse(
        z
          .object({
            ...body,
            milestoneId: id,
            expectedPolicyId: uuid,
            ownerUserId: uuid,
            ownerRole: id,
            evidence: z.unknown(),
          })
          .strict(),
        r.body,
      );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'manager');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `milestone-billing-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      const digest = fingerprint(d),
        old = (
          await c.query(
            'select * from milestone_billing_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and request_id=$4',
            [...scope(r), r.user.sub, d.requestId],
          )
        ).rows[0];
      if (old) {
        if (old.request_fingerprint !== digest || old.active_role !== r.user.activeRole)
          throw fail(409, 'MILESTONE_BILLING_KEY', 'Original review request differs.');
        return {
          ...(await envelope(c, r)),
          approval: await view(c, old),
          ...(await outcome(c, old.id)),
          replayed: true,
        };
      }
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `commercial-lifecycle:${scope(r).join(':')}`,
      ]);
      const src = await source(c, r, d.milestoneId, true),
        p = (
          await c.query(
            'select * from milestone_billing_policies where id=$1 and organization_id=$2 and legal_entity_id=$3 and engagement_id=$4',
            [d.expectedPolicyId, ...scope(r), src.engagementId],
          )
        ).rows[0];
      if (!src.current || !p || !validMilestoneEvidence(d.evidence, p.definition.evidenceKinds))
        throw fail(
          409,
          'MILESTONE_BILLING_SOURCE',
          'Current source, policy and required explicit evidence are unavailable.',
        );
      const instanceId = randomUUID();
      await ctx(c, r, { instanceId });
      const i = (
        await c.query(
          'insert into milestone_billing_instances(id,organization_id,legal_entity_id,engagement_id,milestone_id,policy_id,owner_user_id,owner_role,requester_user_id,active_role,evidence,engagement_lifecycle_id,contract_lifecycle_id,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)returning *',
          [
            instanceId,
            ...scope(r),
            src.engagementId,
            src.id,
            p.id,
            d.ownerUserId,
            d.ownerRole,
            r.user.sub,
            r.user.activeRole,
            JSON.stringify(d.evidence),
            src.engagementLifecycleId,
            src.contractLifecycleId,
            d.requestId,
            digest,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await c.query(
        "insert into approval_records(id,entity_type,entity_id,status,source)values($1,'MilestoneBillingEligibilityApproval',$2,'Pending','Web')",
        ['milestone-billing-' + instanceId, instanceId],
      );
      await emit(c, r, i, p, 0, 0, 'approval.action_required');
      await audit(c, r, 'Request Review', instanceId, instanceId, i.milestone_id);
      return {
        ...(await envelope(c, r)),
        approval: await view(c, i),
        eventId: null,
        itemId: null,
        replayed: false,
      };
    }),
  );
  router.post(
    '/instances/:id/decisions',
    handle(true, async (c, r) => {
      const instanceId = parse(uuid, r.params.id),
        d = parse(
          z
            .object({
              ...body,
              expectedSequence: z.number().int().min(0).max(9),
              decision: z.enum(['Approved', 'Rejected']),
            })
            .strict(),
          r.body,
        );
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'decider');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `commercial-lifecycle:${scope(r).join(':')}`,
      ]);
      const i = await instance(c, r, instanceId, true),
        digest = fingerprint(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `milestone-billing-decision:${i.id}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query('select * from milestone_billing_transitions where instance_id=$1 and request_id=$2', [
          i.id,
          d.requestId,
        ])
      ).rows[0];
      if (old) {
        if (
          old.actor_id !== r.user.sub ||
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== digest
        )
          throw fail(409, 'MILESTONE_BILLING_KEY', 'Original decision request differs.');
        return {
          ...(await envelope(c, r)),
          approval: await view(c, i),
          ...(await outcome(c, i.id)),
          replayed: true,
        };
      }
      const p = (await c.query('select * from milestone_billing_policies where id=$1', [i.policy_id]))
          .rows[0],
        transitions = (
          await c.query(
            'select sequence,stage,decision from milestone_billing_transitions where instance_id=$1 order by sequence',
            [i.id],
          )
        ).rows,
        state = milestoneBillingState(p.definition, transitions);
      if (state.status !== 'Pending' || state.sequence !== d.expectedSequence)
        throw fail(409, 'MILESTONE_BILLING_STALE', 'Review stage changed. Reload.');
      const final = d.decision === 'Approved' && state.sequence + 1 === p.definition.stages.length,
        eventId = final ? randomUUID() : null,
        itemId = final ? randomUUID() : null,
        transitionId = randomUUID();
      await ctx(c, r, { instanceId, eventId, itemId });
      await c.query(
        'insert into milestone_billing_transitions(id,instance_id,sequence,stage,decision,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          transitionId,
          i.id,
          state.sequence + 1,
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
      const status = d.decision === 'Rejected' ? 'Rejected' : final ? 'Approved' : 'Pending';
      await c.query(
        "update approval_records set status=$2,updated_at=now() where entity_type='MilestoneBillingEligibilityApproval' and entity_id=$1",
        [i.id, status],
      );
      if (final) {
        await c.query(
          `insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,source_type,milestone_instance_id,milestone_decision_id,version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,created_at)
  select $1,i.organization_id,i.legal_entity_id,e.client_id,e.contract_id,e.id,'MILESTONE_ACCEPTANCE',i.id,$2,1,(clock.ts at time zone 'UTC')::date,m.currency,m.amount,jsonb_build_object('milestoneId',m.id,'sourceVersion',1,'engagementId',e.id,'contractVersionId',e.contract_version_id,'engagementLifecycleId',i.engagement_lifecycle_id,'contractLifecycleId',i.contract_lifecycle_id,'dueOn',to_char(m.due_on,'YYYY-MM-DD'),'evidence',i.evidence,'ownerUserId',i.owner_user_id,'ownerRole',i.owner_role,'policyId',i.policy_id,'decisionId',$2::uuid,'currency',m.currency,'amount',trim_scale(m.amount)::text),$3,$4,$5,clock.ts from milestone_billing_instances i join commercial_milestones m on m.id=i.milestone_id join commercial_engagements e on e.id=i.engagement_id cross join (select clock_timestamp() ts) clock where i.id=$6`,
          [eventId, transitionId, r.user.sub, r.user.activeRole, r.operationId, i.id],
        );
        await c.query(
          "insert into approved_unbilled_items(id,event_id,organization_id,legal_entity_id,version,source_type)values($1,$2,$3,$4,1,'MILESTONE_ACCEPTANCE')",
          [itemId, eventId, ...scope(r)],
        );
      }
      await audit(c, r, 'Decide Review', transitionId, i.id, i.milestone_id);
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
        await c.query('savepoint optional_milestone_notice');
        try {
          await emit(c, r, i, p, state.sequence + 1, state.currentStage, 'approval.completed');
          await c.query('set constraints complete_milestone_billing_transition immediate');
          await c.query('set constraints complete_milestone_billing_transition deferred');
          await c.query('release savepoint optional_milestone_notice');
        } catch {
          await c.query('rollback to savepoint optional_milestone_notice');
          await c.query(
            "insert into milestone_billing_notice_failures(id,instance_id,transition_sequence,code)values($1,$2,$3,'INFORMATIONAL_NOTIFICATION_UNAVAILABLE')",
            [randomUUID(), i.id, state.sequence + 1],
          );
          await c.query('release savepoint optional_milestone_notice');
        }
      }
      return { ...(await envelope(c, r)), approval: await view(c, i), eventId, itemId, replayed: false };
    }),
  );
  router.post(
    '/instances/:id/cancellations',
    handle(true, async (c, r) => {
      const instanceId = parse(uuid, r.params.id),
        d = parse(z.object(body).strict(), r.body);
      fence(r, d.expectedOwnerKey);
      await authorize(c, r, 'manager');
      const i = await instance(c, r, instanceId, true),
        digest = fingerprint(d);
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `milestone-billing-cancel:${i.id}:${r.user.sub}:${d.requestId}`,
      ]);
      const old = (
        await c.query('select * from milestone_billing_invalidations where actor_id=$1 and request_id=$2', [
          r.user.sub,
          d.requestId,
        ])
      ).rows[0];
      if (old) {
        if (
          old.instance_id !== i.id ||
          old.active_role !== r.user.activeRole ||
          old.request_fingerprint !== digest
        )
          throw fail(409, 'MILESTONE_BILLING_KEY', 'Original cancellation differs.');
        return { ...(await envelope(c, r)), approval: await view(c, i), replayed: true };
      }
      const cancellationId = randomUUID();
      await ctx(c, r, { instanceId });
      await c.query(
        'insert into milestone_billing_invalidations(id,instance_id,actor_id,active_role,request_id,request_fingerprint,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
        [cancellationId, i.id, r.user.sub, r.user.activeRole, d.requestId, digest, d.reason, r.operationId],
      );
      await c.query(
        "update approval_records set status='Cancelled',updated_at=now() where entity_type='MilestoneBillingEligibilityApproval' and entity_id=$1",
        [i.id],
      );
      await audit(c, r, 'Cancel Review', cancellationId, i.id, i.milestone_id);
      return { ...(await envelope(c, r)), approval: await view(c, i), replayed: false };
    }),
  );
  router.get(
    '/register',
    handle(false, async (c, r) => {
      const q = parse(z.object({ after: uuid.optional(), engagementId: id.optional() }).strict(), r.query);
      await authorize(c, r);
      const rows = (
        await c.query(
          `select item.id,item.version,ev.id as "eventId",ev.milestone_instance_id as "instanceId",ev.milestone_decision_id as "decisionId",ev.engagement_id as "engagementId",ev.client_id as "clientId",ev.contract_id as "contractId",ev.eligible_on::text as "eligibleOn",ev.currency,ev.amount::text as amount,ev.billing_evidence as evidence from approved_unbilled_items item join billing_eligibility_events ev on ev.id=item.event_id and ev.source_type=item.source_type join milestone_billing_instances i on i.id=ev.milestone_instance_id where item.organization_id=$1 and item.legal_entity_id=$2 and item.source_type='MILESTONE_ACCEPTANCE' and milestone_billing_source_valid(i.organization_id,i.legal_entity_id,i.engagement_id,i.milestone_id,i.engagement_lifecycle_id,i.contract_lifecycle_id) and not exists(select 1 from invoice_draft_occupancies occupied where occupied.item_id=item.id and occupied.item_version=item.version) and ($4::text is null or ev.engagement_id=$4) and ($3::uuid is null or item.id>$3) order by item.id limit 51`,
          [...scope(r), q.after ?? null, q.engagementId ?? null],
        )
      ).rows;
      const capabilities = (
        await c.query('select count(*)::int n from schema_migrations where id=any($1::text[])', [
          [
            '065n_wos06_milestone_invoice_lineage',
            '065o_wos06_milestone_invoice_approval',
            '065p_wos06_milestone_invoice_export',
            '065q_wos06_milestone_invoice_cancel_notice',
            '065r_wos06_milestone_invoice_confirmation',
          ],
        ])
      ).rows[0];
      return {
        ...(await envelope(c, r)),
        items: rows.slice(0, 50),
        nextAfter: rows.length > 50 ? rows[49].id : null,
        batchSupport: capabilities.n === 5,
      };
    }),
  );
  router.get(
    '/receipts/:type/:requestId',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const type = parse(z.enum(['policy', 'request', 'decision', 'cancellation']), r.params.type),
        requestId = parse(uuid, r.params.requestId);
      if (type === 'policy') {
        const p = (
          await c.query(
            'select *,effective_from::text from milestone_billing_policies where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
        if (!p) throw fail(404, 'MILESTONE_BILLING_UNCONFIRMED', 'Original receipt unavailable.');
        return { ...(await envelope(c, r)), type, policy: policyView(p) };
      }
      let i;
      if (type === 'request')
        i = (
          await c.query(
            'select * from milestone_billing_instances where organization_id=$1 and legal_entity_id=$2 and requester_user_id=$3 and active_role=$4 and request_id=$5',
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
      else {
        const table =
          type === 'decision' ? 'milestone_billing_transitions' : 'milestone_billing_invalidations';
        i = (
          await c.query(
            `select i.* from ${table} t join milestone_billing_instances i on i.id=t.instance_id where i.organization_id=$1 and i.legal_entity_id=$2 and t.actor_id=$3 and t.active_role=$4 and t.request_id=$5`,
            [...scope(r), r.user.sub, r.user.activeRole, requestId],
          )
        ).rows[0];
      }
      if (!i) throw fail(404, 'MILESTONE_BILLING_UNCONFIRMED', 'Original receipt unavailable.');
      return {
        ...(await envelope(c, r)),
        type,
        approval: await view(c, i),
        ...(type === 'cancellation' ? {} : await outcome(c, i.id)),
      };
    }),
  );
  return router;
};
