import { canTransitionReportingPeriod } from '../reporting-periods.mjs';
import { z } from 'zod';
import { assertCommercialAuthority } from './commercial-drafting/service.mjs';
import { workApprovalOwner } from './approvals/work-approval-service.mjs';

const fields =
  'id,code,name,frequency,starts_on::text as "startsOn",ends_on::text as "endsOn",status,revision';
const bad = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function registerFinancialPeriodRoutes(router, { pool, requirePermission, audit }) {
  const handle = (fn) => async (req, res) => {
    let c;
    try {
      c = await pool.connect();
      await c.query('begin');
      const value = await fn(c, req);
      await c.query('commit');
      res.set('Cache-Control', 'no-store').json(value);
    } catch (e) {
      if (c) await c.query('rollback').catch(() => {});
      if (e.statusCode) res.status(e.statusCode).json({ error: e.message });
      else if (['RPF01', '40001', '40P01'].includes(e.code))
        res.status(409).json({ error: 'Financial period transition could not be confirmed. Reload.' });
      else res.status(503).json({ error: 'Financial period unavailable. Reload to verify its state.' });
    } finally {
      c?.release();
    }
  };
  const scope = (r) => [r.organizationScope.organizationId, r.organizationScope.legalEntityId];
  const context = (r) => ({
    organizationId: r.organizationScope.organizationId,
    legalEntityId: r.organizationScope.legalEntityId,
    ownerKey: workApprovalOwner(r),
  });
  const authorize = async (c, r, keys) => {
    const held = await c.query(
      'select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share',
      [r.user.sub, ...scope(r)],
    );
    if (!held.rowCount) throw bad(403, 'Selected scope is unavailable.');
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
  router.get(
    '/financial-periods',
    requirePermission('settings.manage'),
    handle(async (c, r) => {
      const parsed = z.object({ date: z.string().date() }).strict().safeParse(r.query);
      if (!parsed.success) throw bad(400, 'Select a valid reporting date.');
      await authorize(c, r, ['settings.manage']);
      const result = await c.query(
        `select ${fields} from reporting_periods where organization_id=$1 and legal_entity_id=$2 and $3::date between starts_on and ends_on order by frequency,id`,
        [...scope(r), parsed.data.date],
      );
      return { ...context(r), periods: result.rows };
    }),
  );
  router.post(
    '/financial-periods/:id/transitions',
    requirePermission('settings.manage'),
    handle(async (c, r) => {
      const parsed = z
        .object({
          expectedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/),
          expectedRevision: z.number().int().positive(),
          action: z.enum(['lock', 'reopen', 'close']),
          reason: z.string().trim().min(3).max(1000),
        })
        .strict()
        .safeParse(r.body);
      if (!parsed.success) throw bad(400, 'Supply the inspected revision, action and reason.');
      const d = parsed.data,
        reopen = d.action === 'reopen';
      await authorize(c, r, reopen ? ['settings.manage', 'periods.financial_reopen'] : ['settings.manage']);
      if (d.expectedOwnerKey !== workApprovalOwner(r))
        throw bad(409, 'Actor or scope changed. Inspect the period again.');
      const args = [...scope(r), r.params.id];
      const where = 'organization_id=$1 and legal_entity_id=$2 and id=$3';
      const found = (await c.query('select frequency from reporting_periods where ' + where, args)).rows[0];
      if (!found) throw bad(404, 'Period unavailable.');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [
        ['reporting-period', ...scope(r), found.frequency].join(':'),
      ]);
      const previous = (
        await c.query(
          'select to_jsonb(p) as data from reporting_periods p where ' + where + ' for update',
          args,
        )
      ).rows[0]?.data;
      const target = { reopen: 'Approval Closed', lock: 'Financially Locked', close: 'Closed' }[d.action];
      if (
        !previous ||
        previous.frequency !== found.frequency ||
        previous.revision !== d.expectedRevision ||
        previous.status === target ||
        !(reopen ? previous.status === 'Financially Locked' : canTransitionReportingPeriod(previous.status, target))
      )
        throw bad(409, 'The inspected period cannot make this transition. Reload.');
      await c.query("select set_config('workos.financial_period_operation',$1,true)", [r.operationId]);
      const updated = (
        await c.query(
          `update reporting_periods p set status=$4 where ${where} returning to_jsonb(p) as data,${fields}`,
          [...args, target],
        )
      ).rows[0];
      const { data, ...period } = updated;
      await audit(c, r, {
        module: 'Organization Setup',
        action: { reopen: 'Reopen Financial Period', lock: 'Lock Financial Period', close: 'Close Financial Period' }[d.action],
        entityType: 'Reporting Period',
        entityId: period.id,
        oldValue: previous,
        newValue: data,
        reason: d.reason,
        details: 'Authorized financial period transition.',
      });
      return { ...context(r), period };
    }),
  );
}
