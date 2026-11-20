import { registerPeriodRoutes } from './period-versions.mjs';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { scopedCapacityWorker } from '../planning/worker-capacity-service.mjs';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { scopedRateCandidateSource } from '../commercial-rates/router.mjs';
import { validTmValuationPolicy, calculateTmEntry } from '../../../shared/governed-tm-valuation.mjs';
const uuid = z.string().uuid(),
  textId = z.string().min(1).max(200),
  date = z.string().date(),
  reason = z.string().trim().min(3).max(1000),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  definition = z.unknown().refine(validTmValuationPolicy),
  scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId],
  fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
  parse = (s, v) => {
    const p = s.safeParse(v);
    if (!p.success) throw fail(400, 'TM_INVALID', 'Provide explicit valid sources and policy.');
    return p.data;
  };
const canonical = (x) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const policyProjection = `id,engagement_id as "engagementId",sequence,previous_id as "previousId",effective_from::text as "effectiveFrom",definition,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt"`;
const snapshotProjection = `id,engagement_id as "engagementId",policy_id as "policyId",submission_id as "submissionId",decision_id as "decisionId",entry_id as "entryId",billing_adoption_id as "billingAdoptionId",cost_adoption_id as "costAdoptionId",source_evidence as "sourceEvidence",result,actor_id as "actorId",active_role as "activeRole",request_id as "requestId",reason,created_at as "createdAt"`;
const policyCommand = z
  .object({
    expectedOwnerKey: hash,
    requestId: uuid,
    engagementId: textId,
    expectedLatestId: uuid.nullable(),
    effectiveFrom: date,
    definition,
    reason,
  })
  .strict();
const calculateCommand = z
  .object({
    expectedOwnerKey: hash,
    requestId: uuid,
    engagementId: textId,
    policyId: uuid,
    submissionId: textId,
    entryId: uuid,
    billingAdoptionId: uuid,
    costAdoptionId: uuid,
    reason,
  })
  .strict();
export const createGovernedTmRouter = (o) => {
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
      const version = out.valuation?.result.version ?? out.policy?.definition.version;
      res.status(write && !out.replayed ? 201 : 200).json(version ? {...out, calculationVersion:version} : out);
    } catch (e) {
      if (begun) await c.query('rollback').catch(() => {});
      if (e.statusCode) res.status(e.statusCode).json({ code: e.code, error: e.message });
      else if (e.code === 'CTM04')
        res
          .status(409)
          .json({
            code: 'TM_FINANCIAL_PERIOD_CLOSED',
            error: 'The reporting periods covering this work date do not permit a new valuation.',
          });
      else if (['CTM01', 'CTM02', 'CTM03', '23505', '23514', '40001', '40P01'].includes(e.code))
        res.status(e.code === 'CTM01' ? 403 : 409).json({
          code: e.code === 'CTM01' ? 'TM_AUTHORITY' : 'TM_CONFLICT',
          error: 'Current scoped work, policy or rate source changed. Reload.',
        });
      else {
        o.logError?.(e);
        res.status(503).json({
          code: 'TM_UNCONFIRMED',
          error: 'Operation could not be confirmed. Read the original receipt.',
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
    serverDate: (await c.query("select to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD')d"))
      .rows[0].d,
    calculationVersion: 'governed-tm/1',
  });
  const authorize = async (c, r, write = false, policy = false) => {
    const keys = [
      'commercial.contracts.view',
      'commercial.rate_candidates.view',
      'commercial.cost_candidates.view',
      'employees.view',
      'commercial.tm_valuation.view',
      ...(write ? ['commercial.tm_valuation.create'] : []),
      ...(policy ? ['commercial.contracts.manage'] : []),
    ].sort();
    const held = await c.query(
      'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
      [r.user.sub, ...scope(r)],
    );
    if (!held.rowCount) throw fail(403, 'TM_AUTHORITY', 'Current scoped authority is unavailable.');
    await c.query(
      'select permission_key from role_permissions where role_name=$1 and permission_key=any($2::text[]) order by permission_key for share',
      [r.user.activeRole, keys],
    );
    await c.query(
      'select permission_key from user_permission_grants where user_id=$1 and permission_key=any($2::text[]) order by permission_key for share',
      [r.user.sub, keys],
    );
    for (const key of keys) await assertCommercialAuthority(c, r, key);
  };
  const engagement = async (c, r, id, lock = false) => {
    const x = (
      await c.query(
        `select *,starts_on::text,ends_on::text from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3${lock ? ' for share' : ''}`,
        [...scope(r), id],
      )
    ).rows[0];
    if (!x || x.model !== 'time_and_materials' || x.origin !== 'manual' || !x.contract_id)
      throw fail(404, 'TM_SOURCE_UNAVAILABLE', 'The governed T&M engagement is unavailable.');
    return x;
  };
  const worker = async (c, r, workerId, write = false) =>
    write
      ? scopedRateCandidateSource(c, r, 'cost', 'worker', workerId, o, true)
      : scopedCapacityWorker(c, r, workerId, o.buildEmployeeScopeWhere);
  const ownedPolicy = async (c, r, id) =>
    (
      await c.query(
        `select ${policyProjection} from commercial_tm_policy_versions where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4`,
        [...scope(r), r.user.sub, id],
      )
    ).rows[0];
  const ownedSnapshot = async (c, r, id) =>
    (
      await c.query(
        `select ${snapshotProjection} from commercial_tm_valuations where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4`,
        [...scope(r), r.user.sub, id],
      )
    ).rows[0];
  router.get(
    '/policies',
    handle(false, async (c, r) => {
      const q = parse(
        z
          .object({
            engagementId: textId,
            beforeSequence: z.coerce.number().int().min(1).max(2147483647).optional(),
          })
          .strict(),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const rows = (
        await c.query(
          `select ${policyProjection} from commercial_tm_policy_versions where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and ($4::int is null or sequence<$4) order by sequence desc limit 21`,
          [...scope(r), q.engagementId, q.beforeSequence ?? null],
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        engagementId: q.engagementId,
        policies: rows.slice(0, 20),
        truncated: rows.length > 20,
      };
    }),
  );
  router.get('/effective-policy', handle(false, async (c, r) => {
    const q = parse(z.object({ engagementId: textId, workDate: date }).strict(), r.query);
    await authorize(c, r);
    await engagement(c, r, q.engagementId);
    const { rows } = await c.query(
      `select ${policyProjection} from commercial_tm_policy_versions
       where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and effective_from<=$4
       order by sequence desc limit 1`,
      [...scope(r), q.engagementId, q.workDate],
    );
    return { ...(await envelope(c, r)), engagementId: q.engagementId, workDate: q.workDate, policy: rows[0] ?? null };
  }));
  router.post(
    '/policies',
    handle(true, async (c, r) => {
      const input = parse(policyCommand, r.body),
        { expectedOwnerKey, ...d } = input,
        env = await envelope(c, r);
      if (expectedOwnerKey !== env.ownerKey) throw fail(409, 'TM_CONTEXT', 'Account, role or scope changed.');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-tm-policy-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      await authorize(c, r, true, true);
      await engagement(c, r, d.engagementId, true);
      const old = await ownedPolicy(c, r, d.requestId);
      if (old) {
        if (
          old.activeRole !== r.user.activeRole ||
          old.engagementId !== d.engagementId ||
          old.previousId !== d.expectedLatestId ||
          old.effectiveFrom !== d.effectiveFrom ||
          canonical(old.definition) !== canonical(d.definition) ||
          old.reason !== d.reason
        )
          throw fail(409, 'TM_KEY', 'Original policy request differs.');
        return { ...env, policy: old, replayed: true };
      }
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-tm-policy:${scope(r).join(':')}:${d.engagementId}`,
      ]);
      const prior = (
        await c.query(
          `select ${policyProjection} from commercial_tm_policy_versions where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 order by sequence desc limit 1`,
          [...scope(r), d.engagementId],
        )
      ).rows[0];
      if ((prior?.id ?? null) !== d.expectedLatestId) throw fail(409, 'TM_STALE', 'Policy changed. Reload.');
      const eventId = randomUUID();
      await c.query("select set_config('workos.commercial_tm_context',$1,true)", [
        JSON.stringify({
          eventId,
          organizationId: scope(r)[0],
          legalEntityId: scope(r)[1],
          actorId: r.user.sub,
          activeRole: r.user.activeRole,
          operationId: r.operationId,
        }),
      ]);
      const row = (
        await c.query(
          `insert into commercial_tm_policy_versions(id,organization_id,legal_entity_id,engagement_id,sequence,previous_id,effective_from,definition,actor_id,active_role,request_id,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)returning ${policyProjection}`,
          [
            eventId,
            ...scope(r),
            d.engagementId,
            (prior?.sequence ?? 0) + 1,
            prior?.id ?? null,
            d.effectiveFrom,
            JSON.stringify(d.definition),
            r.user.sub,
            r.user.activeRole,
            d.requestId,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await o.audit(c, r, {
        module: 'T&M Valuation',
        action: 'Configure Policy',
        entityType: 'TMPolicy',
        entityId: eventId,
        newValue: { policyId: eventId, engagementId: d.engagementId },
        reason: 'Protected explicit valuation policy.',
        details: 'No seeded rounding, grant or invoice authority.',
      });
      return { ...env, policy: row, replayed: false };
    }),
  );
  registerPeriodRoutes(router, { handle, parse, authorize, engagement, scope, envelope, fail, o });
  router.get(
    '/sources',
    handle(false, async (c, r) => {
      const q = parse(
        z
          .object({
            engagementId: textId,
            afterDate: date.optional(),
            afterEntryId: uuid.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(100),
          })
          .strict()
          .refine((v) => Boolean(v.afterDate) === Boolean(v.afterEntryId)),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const params = [...scope(r), q.engagementId, q.afterDate ?? null, q.afterEntryId ?? null, q.limit + 1],
        where = o.buildEmployeeScopeWhere(r, params, 'worker');
      const rows = (
        await c.query(
          `select s.id "submissionId",d.id "decisionId",entry.id "entryId",entry.work_date::text "workDate",trim_scale(entry.hours)::text "hoursExact",entry.project_id "projectId",t.employee_id "workerId",worker.name "workerName",worker.status "workerStatus",b.id "bindingId",v.id "valuationId" from work_submission_evidence s join work_submission_decisions d on d.submission_id=s.id and d.status='Approved' join timesheets t on t.id=s.timesheet_id and t.status='Approved' and t.organization_id=s.organization_id and t.legal_entity_id=s.legal_entity_id join employees worker on worker.id=t.employee_id join timesheet_entries entry on entry.timesheet_id=t.id and entry.billable and entry.hours>0 join lateral(select x from jsonb_array_elements(s.entries)x where x->>'entryId'=entry.id::text and x->>'kind'='governed') retained on true join commercial_project_bindings b on b.id=retained.x->>'bindingId' and b.project_id=entry.project_id and b.engagement_id=$3 and b.organization_id=s.organization_id and b.legal_entity_id=s.legal_entity_id and b.model='time_and_materials' left join commercial_tm_valuations v on v.entry_id=entry.id and v.organization_id=s.organization_id and v.legal_entity_id=s.legal_entity_id where s.organization_id=$1 and s.legal_entity_id=$2 and ($4::date is null or entry.work_date<$4 or (entry.work_date=$4 and entry.id>$5::uuid)) and ${where} order by entry.work_date desc,entry.id limit $6`,
          params,
        )
      ).rows;
      return {
        ...(await envelope(c, r)),
        engagementId: q.engagementId,
        sources: rows.slice(0, q.limit),
        truncated: rows.length > q.limit,
      };
    }),
  );
  const source = async (c, r, d, lock = false) => {
    const s = (
      await c.query(
        'select * from work_submission_evidence where id=$1 and organization_id=$2 and legal_entity_id=$3',
        [d.submissionId, ...scope(r)],
      )
    ).rows[0];
    if (!s) throw fail(404, 'TM_SOURCE_UNAVAILABLE', 'Approved work is unavailable.');
    const h = (
      await c.query(
        `select * from timesheets where id=$1 and organization_id=$2 and legal_entity_id=$3${lock ? ' for share' : ''}`,
        [s.timesheet_id, ...scope(r)],
      )
    ).rows[0];
    if (!h) throw fail(404, 'TM_SOURCE_UNAVAILABLE', 'Approved work is unavailable.');
    await worker(c, r, h.employee_id, lock);
    const e = (
      await c.query(
        `select *,work_date::text,trim_scale(hours)::text "hoursExact" from timesheet_entries where id=$1 and timesheet_id=$2${lock ? ' for share' : ''}`,
        [d.entryId, s.timesheet_id],
      )
    ).rows[0];
    const decision = (
      await c.query("select * from work_submission_decisions where submission_id=$1 and status='Approved'", [
        s.id,
      ])
    ).rows[0];
    const item = s.entries.filter((x) => x.entryId === d.entryId);
    if (!e || !decision || item.length !== 1)
      throw fail(409, 'TM_SOURCE_UNAVAILABLE', 'Exact approved work evidence is required.');
    return { s, h, e, decision, item: item[0] };
  };
  router.get(
    '/valuations/:id',
    handle(false, async (c, r) => {
      const q = parse(z.object({ includeRateEvidence: z.literal('true').optional() }).strict(), r.query);
      await authorize(c, r);
      const v = (
        await c.query(
          `select ${snapshotProjection} from commercial_tm_valuations where id=$1 and organization_id=$2 and legal_entity_id=$3`,
          [parse(uuid, r.params.id), ...scope(r)],
        )
      ).rows[0];
      if (!v) throw fail(404, 'TM_SOURCE_UNAVAILABLE', 'Protected valuation is unavailable.');
      await engagement(c, r, v.engagementId);
      await source(c, r, v);
      const p = (
        await c.query(
          `select ${policyProjection} from commercial_tm_policy_versions where id=$1 and organization_id=$2 and legal_entity_id=$3 and engagement_id=$4`,
          [v.policyId, ...scope(r), v.engagementId],
        )
      ).rows[0];
      if (!p) throw fail(409, 'TM_SOURCE_UNAVAILABLE', 'Retained policy is unavailable.');
      const rateFields = q.includeRateEvidence
        ? ',c.effective_from::text as "effectiveFrom",c.effective_to::text as "effectiveTo",c.binding_type as "bindingType",c.binding_id as "bindingId",c.priority'
        : '';
      const rates = (
          await c.query(
            `select a.id "adoptionId",c.id "candidateId",c.kind,c.amount::text,c.currency,c.unit${rateFields} from commercial_rate_adoptions a join commercial_rate_candidates c on c.id=a.candidate_id and c.organization_id=a.organization_id and c.legal_entity_id=a.legal_entity_id where a.organization_id=$1 and a.legal_entity_id=$2 and a.id=any($3::uuid[])`,
            [...scope(r), [v.billingAdoptionId, v.costAdoptionId]],
          )
        ).rows,
        billingRate = rates.find((x) => x.adoptionId === v.billingAdoptionId && x.kind === 'billing'),
        costRate = rates.find((x) => x.adoptionId === v.costAdoptionId && x.kind === 'cost');
      if (!billingRate || !costRate)
        throw fail(409, 'TM_SOURCE_UNAVAILABLE', 'Retained rate sources are unavailable.');
      return {
        ...(await envelope(c, r)),
        valuation: v,
        policy: p,
        billingRate,
        costRate,
        ...(q.includeRateEvidence ? { resolutionRule: 'UNIQUE_HIGHEST_PRIORITY' } : {}),
      };
    }),
  );
  router.get(
    '/receipts/policy/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const p = await ownedPolicy(c, r, parse(uuid, r.params.id));
      if (!p || p.activeRole !== r.user.activeRole)
        throw fail(404, 'TM_UNCONFIRMED', 'No original receipt is confirmed.');
      await engagement(c, r, p.engagementId);
      return { ...(await envelope(c, r)), policy: p };
    }),
  );
  router.get(
    '/receipts/valuation/:id',
    handle(false, async (c, r) => {
      parse(z.object({}).strict(), r.query);
      await authorize(c, r);
      const v = await ownedSnapshot(c, r, parse(uuid, r.params.id));
      if (!v || v.activeRole !== r.user.activeRole)
        throw fail(404, 'TM_UNCONFIRMED', 'No original receipt is confirmed.');
      await engagement(c, r, v.engagementId);
      await source(c, r, v);
      return { ...(await envelope(c, r)), valuation: v };
    }),
  );
  router.post(
    '/valuations',
    handle(true, async (c, r) => {
      const input = parse(calculateCommand, r.body),
        { expectedOwnerKey, ...d } = input,
        env = await envelope(c, r);
      if (expectedOwnerKey !== env.ownerKey) throw fail(409, 'TM_CONTEXT', 'Account, role or scope changed.');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        `commercial-tm-valuation-request:${scope(r).join(':')}:${r.user.sub}:${d.requestId}`,
      ]);
      await authorize(c, r, true);
      const eng = await engagement(c, r, d.engagementId, true),
        x = await source(c, r, d, true),
        old = await ownedSnapshot(c, r, d.requestId);
      if (old) {
        if (
          old.activeRole !== r.user.activeRole ||
          old.engagementId !== d.engagementId ||
          old.policyId !== d.policyId ||
          old.submissionId !== d.submissionId ||
          old.entryId !== d.entryId ||
          old.billingAdoptionId !== d.billingAdoptionId ||
          old.costAdoptionId !== d.costAdoptionId ||
          old.reason !== d.reason
        )
          throw fail(409, 'TM_KEY', 'Original valuation request differs.');
        return { ...env, valuation: old, replayed: true };
      }
      const p = (
        await c.query(
          'select * from commercial_tm_policy_versions where id=$1 and organization_id=$2 and legal_entity_id=$3 and engagement_id=$4',
          [d.policyId, ...scope(r), d.engagementId],
        )
      ).rows[0];
      const rates = (
        await c.query(
          'select a.id,c.amount::text,c.currency,c.unit from commercial_rate_adoptions a join commercial_rate_candidates c on c.id=a.candidate_id and c.organization_id=a.organization_id and c.legal_entity_id=a.legal_entity_id where a.organization_id=$1 and a.legal_entity_id=$2 and a.id=any($3::uuid[])',
          [...scope(r), [d.billingAdoptionId, d.costAdoptionId]],
        )
      ).rows;
      const billing = rates.find((v) => v.id === d.billingAdoptionId),
        cost = rates.find((v) => v.id === d.costAdoptionId);
      if (!p || !billing || !cost || !validTmValuationPolicy(p.definition))
        throw fail(409, 'TM_SOURCE_UNAVAILABLE', 'The selected policy or adopted sources are unavailable.');
      let result;
      try {
        result = calculateTmEntry({
          hours: x.e.hoursExact,
          billingRate: billing.amount,
          costRate: cost.amount,
          currency: eng.currency,
          unit: 'HOUR',
          policy: p.definition,
        });
      } catch {
        throw fail(409, 'TM_SOURCE_UNAVAILABLE', 'Native unit, currency or decimal sources are unavailable.');
      }
      const sourceEvidence = {
        submissionId: x.s.id,
        decisionId: x.decision.id,
        entryId: x.e.id,
        projectId: x.e.project_id,
        bindingId: x.item.bindingId,
        workDate: x.e.work_date,
        hours: x.e.hoursExact,
        references: x.item.references,
        assignmentSnapshots: x.item.assignmentSnapshots,
        billingAdoptionId: d.billingAdoptionId,
        costAdoptionId: d.costAdoptionId,
        policyId: d.policyId,
      };
      const eventId = randomUUID();
      await c.query("select set_config('workos.commercial_tm_context',$1,true)", [
        JSON.stringify({
          eventId,
          organizationId: scope(r)[0],
          legalEntityId: scope(r)[1],
          actorId: r.user.sub,
          activeRole: r.user.activeRole,
          operationId: r.operationId,
        }),
      ]);
      const row = (
        await c.query(
          `insert into commercial_tm_valuations(id,organization_id,legal_entity_id,engagement_id,policy_id,submission_id,decision_id,entry_id,billing_adoption_id,cost_adoption_id,source_evidence,result,actor_id,active_role,request_id,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)returning ${snapshotProjection}`,
          [
            eventId,
            ...scope(r),
            d.engagementId,
            d.policyId,
            d.submissionId,
            x.decision.id,
            d.entryId,
            d.billingAdoptionId,
            d.costAdoptionId,
            JSON.stringify(sourceEvidence),
            JSON.stringify(result),
            r.user.sub,
            r.user.activeRole,
            d.requestId,
            d.reason,
            r.operationId,
          ],
        )
      ).rows[0];
      await o.audit(c, r, {
        module: 'T&M Valuation',
        action: 'Calculate Work',
        entityType: 'TMValuation',
        entityId: eventId,
        newValue: { valuationId: eventId, submissionId: d.submissionId, entryId: d.entryId },
        reason: 'Protected source-bound valuation.',
        details: 'Operational calculation evidence; no eligibility or invoice.',
      });
      return { ...env, valuation: row, replayed: false };
    }),
  );
  return router;
};
