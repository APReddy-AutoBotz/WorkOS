import {Router} from 'express';

export const createAvailabilityReportRouter = ({
  run,
  requireDatabase,
  requireAuth,
  requirePermission,
  buildEmployeeScopeWhere,
}) => {
  if (![run, requireDatabase, requireAuth, requirePermission, buildEmployeeScopeWhere]
    .every(value => typeof value === 'function')) {
    throw new TypeError('Availability report routes require a query runner, identity guards, permission guard, and employee scope resolver.');
  }

  const router = Router();
  router.get('/reports/availability', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const params = [];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    params.push(new Date().getFullYear());
    const yearParam = `$${params.length}`;
    await run(res, `
      select
        e.id as employee_id,
        e.name as employee_name,
        e.standard_weekly_hours,
        coalesce(l.approved_leave_days, 0)::numeric as approved_leave_days,
        coalesce(h.holiday_days, 0)::numeric as holiday_days,
        greatest(0, (e.standard_weekly_hours * 52) - ((coalesce(l.approved_leave_days, 0) + coalesce(h.holiday_days, 0)) * (e.standard_weekly_hours / 5)))::numeric as availability_hours
      from employees e
      left join (
        select employee_id, sum(total_days) as approved_leave_days
        from leave_requests
        where status = 'Approved' and extract(year from start_date)::int = ${yearParam}
        group by employee_id
      ) l on l.employee_id = e.id
      left join lateral (
        select count(*) as holiday_days
        from holiday_calendars hc
        join holidays h on h.calendar_id = hc.id
        where hc.status = 'Active'
          and hc.calendar_year = ${yearParam}
          and (hc.country = e.country or hc.country = 'Global')
      ) h on true
      where e.status <> 'Exited' and ${where}
      order by e.name
    `, params);
  });
  return router;
};
