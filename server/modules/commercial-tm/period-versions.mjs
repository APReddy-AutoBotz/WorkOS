import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { periodMarginPercent } from './period-margin.mjs';

export function registerPeriodRoutes(
  router,
  { handle, parse, authorize, engagement, scope, envelope, fail, o },
) {
  const range = {
    engagementId: z.string().min(1).max(200),
    start: z.string().date(),
    end: z.string().date(),
  };
  const validRange = (v) => v.start <= v.end;
  const key = z.string().regex(/^[0-9a-f]{64}$/);
  const projection = 'id,sequence,created_at as "createdAt",membership_key as "membershipKey",totals';
  const periodFilter =
    'organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and starts_on=$4 and ends_on=$5';
  const rangeArgs = (r, q) => [...scope(r), q.engagementId, q.start, q.end];
  const report = async (c, r, q, includeMembers = true) => {
    const params = [...scope(r), q.engagementId, q.start, q.end];
    const workerScope = o.buildEmployeeScopeWhere(r, params, 'worker');
    const totals = await c.query(
      `
        select v.result->>'currency' currency,count(*)::text as "entryCount",
          ${includeMembers ? 'array_agg(v.id order by v.id) members,array_agg(distinct worker.id) workers,' : ''}
          sum((v.result->>'hoursExact')::numeric)::text as hours,
          sum((v.result->>'billableValue')::numeric)::text as billable,
          sum((v.result->>'costValue')::numeric)::text as cost,
          sum((v.result->>'marginValue')::numeric)::text as margin
        from commercial_tm_valuations v
        join work_submission_evidence s on s.id=v.submission_id and s.organization_id=v.organization_id and s.legal_entity_id=v.legal_entity_id
        join timesheets t on t.id=s.timesheet_id and t.organization_id=s.organization_id and t.legal_entity_id=s.legal_entity_id
        join employees worker on worker.id=t.employee_id
        where v.organization_id=$1 and v.legal_entity_id=$2 and v.engagement_id=$3
          and (v.source_evidence->>'workDate')::date between $4::date and $5::date and (${workerScope})
        group by v.result->>'currency' order by currency`,
      params,
    );

    const members = includeMembers ? totals.rows.flatMap((row) => row.members).sort() : [];
    const workers = includeMembers ? [...new Set(totals.rows.flatMap((row) => row.workers))].sort() : [];
    const membershipKey = createHash('sha256')
      .update(JSON.stringify([...rangeArgs(r, q), members, workers]))
      .digest('hex');
    return {
      members,
      workers,
      membershipKey,
      totals: totals.rows.map(({ members, workers, ...row }) => ({
        ...row,
        marginPercent: periodMarginPercent(row.billable, row.cost),
      })),
    };
  };
  router.get(
    '/period-summary',
    handle(false, async (c, r) => {
      const { includeMembershipKey, ...q } = parse(
        z
          .object({ ...range, includeMembershipKey: z.literal('true').optional() })
          .strict()
          .refine(validRange),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const result = await report(c, r, q, Boolean(includeMembershipKey));
      return {
        ...(await envelope(c, r)),
        version: 'tm-period-margin/1',
        ...q,
        totals: result.totals,
        ...(includeMembershipKey ? { membershipKey: result.membershipKey } : {}),
      };
    }),
  );
  const view = (env, q, row) => ({
    ...env,
    version: 'tm-period-margin/1',
    engagementId: q.engagementId,
    start: q.start,
    end: q.end,
    ...row,
  });
  const visibleVersion = async (c, r, q, membershipKey = null) => {
    const params = [...rangeArgs(r, q), q.sequence ?? null, membershipKey];
    const workerScope = o.buildEmployeeScopeWhere(r, params, 'worker');
    return (
      await c.query(
        `with selected as (select * from commercial_tm_period_versions where ${periodFilter} and ($6::int is null or sequence=$6) and ($7::text is null or membership_key=$7) order by sequence desc limit 1)
 select ${projection} from selected p where not exists (select 1 from unnest(p.worker_ids) required(id) where not exists(select 1 from employees worker where worker.id=required.id and (${workerScope})))`,
        params,
      )
    ).rows[0];
  };
  router.get(
    '/period-versions',
    handle(false, async (c, r) => {
      const q = parse(
        z
          .object({ ...range, sequence: z.coerce.number().int().positive().max(2147483647).optional() })
          .strict()
          .refine(validRange),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const row = await visibleVersion(c, r, q);
      if (!row) throw fail(404, 'TM_PERIOD_UNAVAILABLE', 'This period version is unavailable.');
      return view(await envelope(c, r), q, row);
    }),
  );
  router.get(
    '/period-versions/:id/members',
    handle(false, async (c, r) => {
      const periodId = parse(z.string().uuid(), r.params.id);
      const q = parse(
        z
          .object({
            ...range,
            sequence: z.coerce.number().int().positive().max(2147483647),
            offset: z.coerce.number().int().min(0).max(2147483546).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(25),
          })
          .strict()
          .refine(validRange),
        r.query,
      );
      await authorize(c, r);
      await engagement(c, r, q.engagementId);
      const period = await visibleVersion(c, r, q);
      if (period?.id !== periodId)
        throw fail(404, 'TM_PERIOD_UNAVAILABLE', 'This period version is unavailable.');
      const params = [...scope(r), q.engagementId, periodId, q.offset + 1, q.offset + q.limit];
      const where = o.buildEmployeeScopeWhere(r, params, 'worker');
      const members = (
        await c.query(
          `select v.id "valuationId",v.submission_id "submissionId",v.decision_id "decisionId",v.entry_id "entryId",
      v.source_evidence->>'workDate' "workDate",v.source_evidence->>'projectId' "projectId",v.source_evidence->>'bindingId' "bindingId",
      v.result->>'hoursExact' "hoursExact",v.result->>'currency' currency,v.result->>'billableValue' billable,v.result->>'costValue' cost,v.result->>'marginValue' margin,
      worker.id "workerId",worker.name "workerName",worker.status "workerStatus"
      from commercial_tm_period_versions p
      cross join lateral unnest(p.valuation_ids[$5::int:$6::int]) with ordinality as member(id,position)
      join commercial_tm_valuations v on v.id=member.id and v.organization_id=p.organization_id and v.legal_entity_id=p.legal_entity_id and v.engagement_id=p.engagement_id
      join work_submission_evidence s on s.id=v.submission_id and s.organization_id=v.organization_id and s.legal_entity_id=v.legal_entity_id
      join timesheets t on t.id=s.timesheet_id and t.organization_id=s.organization_id and t.legal_entity_id=s.legal_entity_id
      join employees worker on worker.id=t.employee_id
      where p.organization_id=$1 and p.legal_entity_id=$2 and p.engagement_id=$3 and p.id=$4 and (${where}) order by member.position`,
          params,
        )
      ).rows;
      const count = period.totals.reduce((n, row) => n + Number(row.entryCount), 0);
      if (members.length !== Math.min(q.limit, Math.max(0, count - q.offset)))
        throw fail(409, 'TM_PERIOD_UNAVAILABLE', 'Some retained entries are unavailable.');
      return {
        ...(await envelope(c, r)),
        periodId,
        engagementId: q.engagementId,
        sequence: q.sequence,
        offset: q.offset,
        count,
        members,
      };
    }),
  );
  router.post(
    '/period-versions',
    handle(true, async (c, r) => {
      const q = parse(
        z
          .object({ ...range, membershipKey: key, expectedOwnerKey: key })
          .strict()
          .refine(validRange),
        r.body,
      );
      await authorize(c, r, true);
      const env = await envelope(c, r);
      if (q.expectedOwnerKey !== env.ownerKey) throw fail(409, 'TM_STALE', 'Scope changed. Reload.');
      await engagement(c, r, q.engagementId, true);
      const args = rangeArgs(r, q);
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['tm-period', ...args]),
      ]);
      const retained = await visibleVersion(c, r, q, q.membershipKey);
      if (retained) return { ...view(env, q, retained), replayed: true };
      const result = await report(c, r, q);
      const count = (
        await c.query(
          `select count(*)::text n from commercial_tm_valuations where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and (source_evidence->>'workDate')::date between $4 and $5`,
          args,
        )
      ).rows[0].n;
      if (
        !result.members.length ||
        result.membershipKey !== q.membershipKey ||
        String(result.members.length) !== count
      )
        throw fail(
          409,
          'TM_PERIOD_UNAVAILABLE',
          'The inspected period cannot be retained. Reload the report.',
        );
      const prior = (
        await c.query(
          `select sequence from commercial_tm_period_versions where ${periodFilter} order by sequence desc limit 1`,
          args,
        )
      ).rows[0];

      const id = randomUUID(),
        sequence = (prior?.sequence ?? 0) + 1;
      const row = (
        await c.query(
          `insert into commercial_tm_period_versions(organization_id,legal_entity_id,engagement_id,starts_on,ends_on,id,sequence,calculation_version,membership_key,valuation_ids,worker_ids,totals,actor_id,active_role,operation_id)
 values($1,$2,$3,$4,$5,$6,$7,'tm-period-margin/1',$8,$9,$10,$11::jsonb,$12,$13,$14) returning ${projection}`,
          [
            ...args,
            id,
            sequence,
            q.membershipKey,
            result.members,
            result.workers,
            JSON.stringify(result.totals),
            r.user.sub,
            r.user.activeRole,
            r.operationId,
          ],
        )
      ).rows[0];
      await o.audit(c, r, {
        module: 'T&M Valuation',
        action: 'Retain Period',
        entityType: 'TMPeriod',
        entityId: id,
        newValue: { engagementId: q.engagementId, sequence, membershipKey: q.membershipKey },
        reason: 'Retain inspected period valuations.',
        details: 'Historical native-currency totals.',
      });
      return { ...view(env, q, row), replayed: false };
    }),
  );
}
