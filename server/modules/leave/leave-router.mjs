import {startLeaveApproval,prepareLeaveSourceEdit,retainLeaveCancellation,assertLegacyLeaveApproval,lockLeaveApprovalScope,unlockLeaveApprovalScope} from '../approvals/leave-approval-service.mjs';
import {Router} from 'express';
import {assertIndependentLeaveDecision} from './decision-independence.mjs';
import {z} from 'zod';
import {quoteCalendarLeave,requireCalendarLeaveQuote,retainCalendarLeave,assertCalendarLeaveDecision,calendarLeaveError} from './calendar-leave-service.mjs';

export const createLeaveRouter = ({
  pool,
  run,
  requireDatabase,
  requireAuth,
  requirePermission,
  buildEmployeeScopeWhere,
  audit,
  getBusinessLeaveDays,
  getLeaveYear,
  ensureLeaveBalanceForRequest,
  refreshLeaveBalancesForEmployee,
  upsertApprovalRecord,
  decideApprovalRecord,
  fetchUserAuthRowByWhere,
  getEffectivePermissionsForUser,
}) => {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || ![run, buildEmployeeScopeWhere, audit, getBusinessLeaveDays, getLeaveYear,
        ensureLeaveBalanceForRequest, refreshLeaveBalancesForEmployee, upsertApprovalRecord,
        decideApprovalRecord].every(value => typeof value === 'function')
      || ![requireDatabase, requireAuth, requirePermission].every(value => typeof value === 'function')) {
    throw new TypeError('Leave routes require a database, identity guards, scope resolver, leave services, and audit writer.');
  }

  const approvalOptions={buildEmployeeScopeWhere,audit,getBusinessLeaveDays,getLeaveYear,ensureLeaveBalanceForRequest,refreshLeaveBalancesForEmployee,upsertApprovalRecord,decideApprovalRecord,fetchUserAuthRowByWhere,getEffectivePermissionsForUser};
  const approvalError=(res,error)=>{if(String(error.code).startsWith('LEAVE_APPROVAL_')){res.status(error.statusCode||409).json({error:error.message,code:error.code});return true;}if(['LGA01','LGA02','LGA03','LGA04','40001','40P01'].includes(error.code)){res.status(409).json({error:'Leave source or current approval authority changed. Inspect history before retrying.',code:'LEAVE_APPROVAL_CONFLICT'});return true;}return false;};
  const router = Router();
  router.get('/v1/leave-calendar/workers/:id/period', requireDatabase, requireAuth, requirePermission('leave.self_service'), async(req,res)=>{
    const c=await pool.connect();try{await c.query('begin isolation level repeatable read');const q=z.object({startsOn:z.string(),endsOn:z.string()}).strict().safeParse(req.query);if(!q.success){await c.query('rollback');res.status(400).json({error:'Choose explicit leave dates.'});return;}const computed=await quoteCalendarLeave(c,req,req.params.id,q.data.startsOn,q.data.endsOn,buildEmployeeScopeWhere,getBusinessLeaveDays);await c.query('commit');res.json({contractVersion:'calendar-leave/1',organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,quote:computed.quote});}catch(e){await c.query('rollback');if(!calendarLeaveError(res,e))res.status(e.statusCode||503).json({error:'Calendar leave quote could not be confirmed. Reload explicitly.'});}finally{c.release();}
  });
  router.get('/v1/leave-calendar/requests/:id/history',requireDatabase,requireAuth,requirePermission('leave.self_service'),async(req,res)=>{
    const c=await pool.connect();try{await c.query('begin isolation level repeatable read');const parsed=z.object({before:z.string().regex(/^[1-9]\d*$/).refine(v=>Number(v)<=2147483647).optional()}).strict().safeParse(req.query);if(!parsed.success){await c.query('rollback');res.status(400).json({error:'Invalid calendar history cursor.'});return;}const params=[req.params.id],where=buildEmployeeScopeWhere(req,params,'e'),row=(await c.query(`select lr.id,lr.employee_id from leave_requests lr join employees e on e.id=lr.employee_id where lr.id=$1 and ${where}`,params)).rows[0];if(!row){await c.query('rollback');res.status(404).json({error:'Leave calendar history is unavailable in this scope.'});return;}const rows=(await c.query('select id,sequence,created_at,active_role,source,quote from leave_calendar_evidence where request_id=$1 and employee_id=$2 and organization_id=$3 and legal_entity_id=$4 and($5::integer is null or sequence<$5)order by sequence desc limit 11',[row.id,row.employee_id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,parsed.data.before?Number(parsed.data.before):null])).rows;await c.query('commit');res.json({contractVersion:'calendar-leave/1',organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,requestId:row.id,employeeId:row.employee_id,evidence:rows.slice(0,10).map(e=>({id:e.id,sequence:e.sequence,createdAt:e.created_at,activeRole:e.active_role,source:e.source,quote:e.quote})),nextBefore:rows.length>10?rows[9].sequence:null});}catch(e){await c.query('rollback');res.status(503).json({error:'Leave calendar history could not be confirmed. Reload explicitly.'});}finally{c.release();}
  });
  const leavePolicySelect = `
    select lp.*,
      coalesce(array_agg(lpt.leave_type_id order by lpt.leave_type_id) filter (where lpt.leave_type_id is not null), '{}') as leave_type_ids
    from leave_policies lp
    left join leave_policy_types lpt on lpt.policy_id = lp.id
    group by lp.id
  `;

  router.get('/leave/types', requireDatabase, requireAuth, requirePermission('leave.self_service'), (_req, res) => {
    run(res, 'select * from leave_types order by active desc, name');
  });

  router.post('/leave/types', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      code: z.string().min(1),
      name: z.string().min(1),
      paid: z.boolean().default(true),
      requires_approval: z.boolean().default(true),
      active: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const previous = parsed.data.id ? (await client.query('select * from leave_types where id = $1', [parsed.data.id])).rows[0] : null;
      const result = await client.query(`
        insert into leave_types (id, code, name, paid, requires_approval, active)
        values (coalesce($1, 'leave-type-' || gen_random_uuid()::text), upper($2), $3, $4, $5, $6)
        on conflict (id) do update set code = upper(excluded.code), name = excluded.name, paid = excluded.paid,
          requires_approval = excluded.requires_approval, active = excluded.active, updated_at = now()
        returning *
      `, [parsed.data.id || null, parsed.data.code, parsed.data.name, parsed.data.paid, parsed.data.requires_approval, parsed.data.active]);
      await audit(client, req, {
        module: 'Leave',
        action: previous ? 'Update Leave Type' : 'Create Leave Type',
        entityType: 'LeaveType',
        entityId: result.rows[0].id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `${previous ? 'Updated' : 'Created'} leave type ${result.rows[0].name}`,
        // Leave-type definitions are shared deployment configuration.
        organizationScope: null,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      console.error(error);
      res.status(500).json({ error: 'Leave type save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/leave/policies', requireDatabase, requireAuth, requirePermission('leave.self_service'), (_req, res) => {
    run(res, `${leavePolicySelect} order by lp.status desc, lp.name`);
  });

  router.post('/leave/policies', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      country: z.string().min(1).default('Global'),
      annual_allowance_days: z.number().min(0).max(366),
      carry_forward_days: z.number().min(0).max(366).default(0),
      accrual_method: z.string().default('Annual'),
      status: z.enum(['Active', 'Inactive']).default('Active'),
      leave_type_ids: z.array(z.string()).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const previous = parsed.data.id ? (await client.query(`${leavePolicySelect} having lp.id = $1`, [parsed.data.id])).rows[0] : null;
      const result = await client.query(`
        insert into leave_policies (id, name, country, annual_allowance_days, carry_forward_days, accrual_method, status)
        values (coalesce($1, 'leave-policy-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7)
        on conflict (id) do update set name = excluded.name, country = excluded.country,
          annual_allowance_days = excluded.annual_allowance_days, carry_forward_days = excluded.carry_forward_days,
          accrual_method = excluded.accrual_method, status = excluded.status, updated_at = now()
        returning *
      `, [parsed.data.id || null, parsed.data.name, parsed.data.country, parsed.data.annual_allowance_days, parsed.data.carry_forward_days, parsed.data.accrual_method, parsed.data.status]);
      await client.query('delete from leave_policy_types where policy_id = $1', [result.rows[0].id]);
      for (const leaveTypeId of parsed.data.leave_type_ids) {
        await client.query('insert into leave_policy_types (policy_id, leave_type_id) values ($1, $2) on conflict do nothing', [result.rows[0].id, leaveTypeId]);
      }
      const next = (await client.query(`${leavePolicySelect} having lp.id = $1`, [result.rows[0].id])).rows[0];
      await audit(client, req, {
        module: 'Leave',
        action: previous ? 'Update Leave Policy' : 'Create Leave Policy',
        entityType: 'LeavePolicy',
        entityId: next.id,
        oldValue: previous,
        newValue: next,
        details: `${previous ? 'Updated' : 'Created'} leave policy ${next.name}`,
        // Leave policies and their type links are shared deployment configuration.
        organizationScope: null,
      });
      await client.query('commit');
      res.json(next);
    } catch (error) {
      await client.query('rollback');
      console.error(error);
      res.status(500).json({ error: 'Leave policy save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/holiday-calendars', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (_req, res) => {
    try {
      const result = await pool.query(`
        select hc.*,
          coalesce(json_agg(json_build_object('id', h.id, 'calendar_id', h.calendar_id, 'name', h.name, 'holiday_date', h.holiday_date, 'holiday_type', h.holiday_type) order by h.holiday_date)
            filter (where h.id is not null), '[]') as holidays
        from holiday_calendars hc
        left join holidays h on h.calendar_id = hc.id
        group by hc.id
        order by hc.calendar_year desc, hc.country, hc.name
      `);
      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Holiday calendar load failed' });
    }
  });

  router.post('/holiday-calendars', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      country: z.string().min(1).default('Global'),
      year: z.number().int().min(2000).max(2100),
      status: z.enum(['Active', 'Inactive']).default('Active'),
      holidays: z.array(z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        date: z.string().min(10),
        type: z.string().default('Public'),
      })).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const previous = parsed.data.id ? (await client.query('select * from holiday_calendars where id = $1', [parsed.data.id])).rows[0] : null;
      const result = await client.query(`
        insert into holiday_calendars (id, name, country, calendar_year, status)
        values (coalesce($1, 'holiday-calendar-' || gen_random_uuid()::text), $2, $3, $4, $5)
        on conflict (id) do update set name = excluded.name, country = excluded.country,
          calendar_year = excluded.calendar_year, status = excluded.status, updated_at = now()
        returning *
      `, [parsed.data.id || null, parsed.data.name, parsed.data.country, parsed.data.year, parsed.data.status]);
      await client.query('delete from holidays where calendar_id = $1', [result.rows[0].id]);
      for (const holiday of parsed.data.holidays) {
        await client.query(`
          insert into holidays (id, calendar_id, name, holiday_date, holiday_type)
          values (coalesce($1, 'holiday-' || gen_random_uuid()::text), $2, $3, $4, $5)
        `, [holiday.id || null, result.rows[0].id, holiday.name, holiday.date, holiday.type]);
      }
      await audit(client, req, {
        module: 'Leave',
        action: previous ? 'Update Holiday Calendar' : 'Create Holiday Calendar',
        entityType: 'HolidayCalendar',
        entityId: result.rows[0].id,
        oldValue: previous,
        newValue: { ...result.rows[0], holidays: parsed.data.holidays },
        details: `${previous ? 'Updated' : 'Created'} holiday calendar ${result.rows[0].name}`,
        // Holiday calendars and their holiday rows are shared deployment configuration.
        organizationScope: null,
      });
      await client.query('commit');
      res.json({ ...result.rows[0], holidays: parsed.data.holidays });
    } catch (error) {
      await client.query('rollback');
      console.error(error);
      res.status(500).json({ error: 'Holiday calendar save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/leave/balances', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const params = [];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    await run(res, `
      select lb.*, e.name as employee_name, lt.name as leave_type_name
      from leave_balances lb
      join employees e on e.id = lb.employee_id
      join leave_types lt on lt.id = lb.leave_type_id
      where ${where}
      order by lb.balance_year desc, e.name, lt.name
    `, params);
  });

  router.post('/leave/balances', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      employee_id: z.string().min(1),
      leave_type_id: z.string().min(1),
      policy_id: z.string().nullable().optional(),
      year: z.number().int().min(2000).max(2100),
      opening_days: z.number().min(0).max(366).default(0),
      accrued_days: z.number().min(0).max(366).default(0),
      adjusted_days: z.number().min(-366).max(366).default(0),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const employeeScopeParams = [parsed.data.employee_id];
      const employeeScopeWhere = buildEmployeeScopeWhere(req, employeeScopeParams, 'e');
      const employee = (await client.query(`
        select e.id, e.employee_id, e.organization_id, e.legal_entity_id
        from employees e
        where e.id = $1 and ${employeeScopeWhere}
        limit 1
        for no key update of e
      `, employeeScopeParams)).rows[0];
      if (!employee) {
        await client.query('rollback');
        res.status(422).json({ error: 'Leave balance employee is not available in the active scope' });
        return;
      }

      const previous = parsed.data.id ? (await client.query(`
        select lb.*
        from leave_balances lb
        where lb.id = $1
          and lb.employee_id = $2
          and lb.leave_type_id = $3
          and lb.balance_year = $4
        for update of lb
      `, [parsed.data.id, employee.id, parsed.data.leave_type_id, parsed.data.year])).rows[0]
        : (await client.query(`
          select lb.*
          from leave_balances lb
          where lb.employee_id = $1 and lb.leave_type_id = $2 and lb.balance_year = $3
          for update of lb
        `, [employee.id, parsed.data.leave_type_id, parsed.data.year])).rows[0] ?? null;
      if (parsed.data.id && !previous) {
        await client.query('rollback');
        res.status(404).json({ error: 'Leave balance not found' });
        return;
      }
      const result = await client.query(`
        insert into leave_balances (id, employee_id, leave_type_id, policy_id, balance_year, opening_days, accrued_days, adjusted_days, available_days)
        values (
          coalesce($1, 'leave-balance-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8,
          greatest(0::numeric, $6::numeric + $7::numeric + $8::numeric)
        )
        on conflict (employee_id, leave_type_id, balance_year) do update set
          policy_id = excluded.policy_id,
          opening_days = excluded.opening_days,
          accrued_days = excluded.accrued_days,
          adjusted_days = excluded.adjusted_days,
          available_days = greatest(0, excluded.opening_days + excluded.accrued_days + excluded.adjusted_days - leave_balances.used_days - leave_balances.pending_days),
          updated_at = now()
        returning *
      `, [parsed.data.id || null, employee.id, parsed.data.leave_type_id, parsed.data.policy_id || null, parsed.data.year, parsed.data.opening_days, parsed.data.accrued_days, parsed.data.adjusted_days]);
      await refreshLeaveBalancesForEmployee(client, employee.id, parsed.data.year);
      await audit(client, req, {
        module: 'Leave',
        action: previous ? 'Update Leave Balance' : 'Create Leave Balance',
        entityType: 'LeaveBalance',
        entityId: result.rows[0].id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `${previous ? 'Updated' : 'Created'} leave balance for ${employee.employee_id}`,
        organizationScope: {
          organizationId: employee.organization_id,
          legalEntityId: employee.legal_entity_id,
        },
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      console.error(error);
      res.status(500).json({ error: 'Leave balance save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/leave/requests', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const params = [];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    await run(res, `
      select lr.*, lr.start_date::text as start_date,lr.end_date::text as end_date,ce.quote as calendar_quote,(select id from leave_approval_instances where request_id=lr.id order by sequence desc limit 1)as approval_instance_id, e.name as employee_name, lt.name as leave_type_name
      from leave_requests lr
      left join leave_calendar_evidence ce on ce.id=lr.calendar_evidence_id and ce.request_id=lr.id and ce.employee_id=lr.employee_id
      join employees e on e.id = lr.employee_id
      join leave_types lt on lt.id = lr.leave_type_id
      where ${where}
      order by lr.start_date desc, lr.created_at desc
    `, params);
  });

  router.post('/leave/requests', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const schema = z.object({
      employee_id: z.string().min(1),
      leave_type_id: z.string().min(1),
      start_date: z.string().min(10),
      end_date: z.string().min(10),
      total_days: z.number().min(0).max(366).optional(),
      expected_calendar_token:z.string().regex(/^[a-f0-9]{64}$/).optional(),
      reason: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.end_date < parsed.data.start_date) {
      res.status(422).json({ error: 'Leave end date must be on or after start date' });
      return;
    }
    const startYear = getLeaveYear(parsed.data.start_date);
    const endYear = getLeaveYear(parsed.data.end_date);
    if (startYear !== endYear) {
      res.status(422).json({ error: 'Leave requests that span calendar years must be split by year' });
      return;
    }
    if (req.user.activeRole === 'Employee' && parsed.data.employee_id !== req.user.employeeRecordId && parsed.data.employee_id !== req.user.employeeId) {
      res.status(403).json({ error: 'Employees can submit leave only for themselves' });
      return;
    }
    const client = await pool.connect();
    try {
      await lockLeaveApprovalScope(client,req);
      await client.query('begin');
      const employee = (await client.query('select * from employees where id = $1 or employee_id = $1', [parsed.data.employee_id])).rows[0];
      if (!employee || employee.status === 'Exited') {
        await client.query('rollback');
        res.status(422).json({ error: 'Leave request must reference an active employee' });
        return;
      }
      const scopeParams = [employee.id];
      const scopedEmployee = (await client.query(`
        select 1
        from employees e
        where e.id = $1 and ${buildEmployeeScopeWhere(req, scopeParams, 'e')}
        limit 1
      `, scopeParams)).rows[0];
      if (!scopedEmployee) {
        await client.query('rollback');
        res.status(403).json({ error: 'Leave request is outside active-role data scope' });
        return;
      }
      const calendar=await quoteCalendarLeave(client,req,employee.id,parsed.data.start_date,parsed.data.end_date,buildEmployeeScopeWhere,getBusinessLeaveDays,true);
      const totalDays=requireCalendarLeaveQuote(calendar,parsed.data.expected_calendar_token);
      if(totalDays<=0){await client.query('rollback');res.status(422).json({error:'Leave request must include at least one business day'});return;}
      const overlapping = (await client.query(`
        select id
        from leave_requests
        where employee_id = $1
          and status in ('Draft', 'Submitted', 'Approved')
          and start_date <= $3::date
          and end_date >= $2::date
        limit 1
      `, [employee.id, parsed.data.start_date, parsed.data.end_date])).rows[0];
      if (overlapping) {
        await client.query('rollback');
        res.status(422).json({ error: 'Leave request overlaps an existing draft, submitted, or approved request' });
        return;
      }
      const { leaveType, balance } = await ensureLeaveBalanceForRequest(client, employee, parsed.data.leave_type_id, startYear, parsed.data.start_date);
      if (leaveType.paid && balance && Number(balance.available_days || 0) < totalDays) {
        await client.query('rollback');
        res.status(422).json({ error: `Insufficient leave balance. Available: ${Number(balance.available_days || 0)} day(s), requested: ${totalDays} day(s)` });
        return;
      }
      const result = await client.query(`
        insert into leave_requests (employee_id, leave_type_id, start_date, end_date, total_days, status, reason, submitted_at)
        values ($1, $2, $3, $4, $5, 'Submitted', $6, now())
        returning *
      `, [employee.id, parsed.data.leave_type_id, parsed.data.start_date, parsed.data.end_date, totalDays, parsed.data.reason || null]);
      result.rows[0]=await retainCalendarLeave(client,req,result.rows[0],calendar);
      const governed=await startLeaveApproval(client,req,result.rows[0],approvalOptions,true);
      await refreshLeaveBalancesForEmployee(client, employee.id, startYear);
      if(!governed)await upsertApprovalRecord(client, req, {
        entityType: 'LeaveRequest',
        entityId: result.rows[0].id,
        subjectEmployeeId: employee.id,
        requesterId: employee.id,
        requesterName: employee.name,
        status: 'Pending',
        source: 'Web',
        dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      });
      await audit(client, req, {
        module: 'Leave',
        action: 'Submit Leave',
        entityType: 'LeaveRequest',
        entityId: result.rows[0].id,
        newValue: result.rows[0],
        details: `Submitted leave request for ${employee.employee_id}`,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if(approvalError(res,error)||calendarLeaveError(res,error))return;
      console.error(error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Leave request submit failed' });
    } finally {
      let discard=false;try{await unlockLeaveApprovalScope(client,req);}catch{discard=true;}client.release(discard);
    }
  });

  router.patch('/leave/requests/:id', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const schema = z.object({
      leave_type_id: z.string().min(1),
      start_date: z.string().min(10),
      end_date: z.string().min(10),
      total_days: z.number().min(0).max(366).optional(),
      expected_calendar_token:z.string().regex(/^[a-f0-9]{64}$/).optional(),
      reason: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.end_date < parsed.data.start_date) {
      res.status(422).json({ error: 'Leave end date must be on or after start date' });
      return;
    }
    const startYear = getLeaveYear(parsed.data.start_date);
    const endYear = getLeaveYear(parsed.data.end_date);
    if (startYear !== endYear) {
      res.status(422).json({ error: 'Leave requests that span calendar years must be split by year' });
      return;
    }
    const client = await pool.connect();
    try {
      await lockLeaveApprovalScope(client,req);
      await client.query('begin');
      const previous = (await client.query('select *,start_date::text,end_date::text from leave_requests where id = $1 for update', [req.params.id])).rows[0];
      if (!previous) {
        await client.query('rollback');
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }
      if (previous.status !== 'Submitted') {
        await client.query('rollback');
        res.status(422).json({ error: 'Only submitted leave requests can be edited' });
        return;
      }
      const scopeParams = [previous.employee_id];
      const scopedEmployee = (await client.query(`
        select 1
        from employees e
        where e.id = $1 and ${buildEmployeeScopeWhere(req, scopeParams, 'e')}
        limit 1
      `, scopeParams)).rows[0];
      if (!scopedEmployee) {
        await client.query('rollback');
        res.status(403).json({ error: 'Leave request is outside active-role data scope' });
        return;
      }
      const overlapping = (await client.query(`
        select id
        from leave_requests
        where employee_id = $1
          and id <> $4
          and status in ('Draft', 'Submitted', 'Approved')
          and start_date <= $3::date
          and end_date >= $2::date
        limit 1
      `, [previous.employee_id, parsed.data.start_date, parsed.data.end_date, req.params.id])).rows[0];
      if (overlapping) {
        await client.query('rollback');
        res.status(422).json({ error: 'Leave request overlaps an existing draft, submitted, or approved request' });
        return;
      }
      const employee = (await client.query('select * from employees where id = $1', [previous.employee_id])).rows[0];
      const calendar=await quoteCalendarLeave(client,req,employee.id,parsed.data.start_date,parsed.data.end_date,buildEmployeeScopeWhere,getBusinessLeaveDays,true);
      const totalDays=requireCalendarLeaveQuote(calendar,parsed.data.expected_calendar_token);
      if(totalDays<=0){await client.query('rollback');res.status(422).json({error:'Leave request must include at least one business day'});return;}
      const { leaveType, balance } = await ensureLeaveBalanceForRequest(client, employee, parsed.data.leave_type_id, startYear, parsed.data.start_date);
      const previousDaysAdjustment = previous.leave_type_id === parsed.data.leave_type_id ? Number(previous.total_days || 0) : 0;
      if (leaveType.paid && balance && Number(balance.available_days || 0) + previousDaysAdjustment < totalDays) {
        await client.query('rollback');
        res.status(422).json({ error: `Insufficient leave balance. Available: ${Number(balance.available_days || 0)} day(s), requested: ${totalDays} day(s)` });
        return;
      }
      await prepareLeaveSourceEdit(client,req,req.params.id);
      const result = await client.query(`
        update leave_requests
        set leave_type_id = $2,
          start_date = $3,
          end_date = $4,
          total_days = $5,
          reason = $6,
          updated_at = now()
        where id = $1
        returning *
      `, [req.params.id, parsed.data.leave_type_id, parsed.data.start_date, parsed.data.end_date, totalDays, parsed.data.reason || null]);
      result.rows[0]=await retainCalendarLeave(client,req,result.rows[0],calendar);
      await startLeaveApproval(client,req,result.rows[0],approvalOptions,false);
      const previousYear = getLeaveYear(previous.start_date);
      await refreshLeaveBalancesForEmployee(client, previous.employee_id, previousYear);
      if (startYear !== previousYear) {
        await refreshLeaveBalancesForEmployee(client, previous.employee_id, startYear);
      }
      await audit(client, req, {
        module: 'Leave',
        action: 'Update Leave',
        entityType: 'LeaveRequest',
        entityId: req.params.id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `Updated leave request ${req.params.id}`,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if(approvalError(res,error)||calendarLeaveError(res,error))return;
      console.error(error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Leave request update failed' });
    } finally {
      let discard=false;try{await unlockLeaveApprovalScope(client,req);}catch{discard=true;}client.release(discard);
    }
  });

  router.patch('/leave/requests/:id/cancel', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
    const schema = z.object({
      comments: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await lockLeaveApprovalScope(client,req);
      await client.query('begin');
      const previous = (await client.query('select *,start_date::text,end_date::text from leave_requests where id = $1 for update', [req.params.id])).rows[0];
      if (!previous) {
        await client.query('rollback');
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }
      if (!['Submitted', 'Approved'].includes(previous.status)) {
        await client.query('rollback');
        res.status(422).json({ error: 'Only submitted or approved leave requests can be cancelled' });
        return;
      }
      if (previous.employee_id !== req.user.employeeRecordId && previous.employee_id !== req.user.employeeId) {
        await client.query('rollback');
        res.status(403).json({ error: 'Employees can cancel only their own leave requests' });
        return;
      }
      const governed=await retainLeaveCancellation(client,req,previous,parsed.data.comments);
      const result = await client.query(`
        update leave_requests
        set status = 'Cancelled',
          comments = $2,
          decided_at = now(),
          updated_at = now()
        where id = $1
        returning *
      `, [req.params.id, parsed.data.comments || null]);
      await refreshLeaveBalancesForEmployee(client, previous.employee_id, getLeaveYear(previous.start_date));
      await decideApprovalRecord(client, req, {
        entityType: 'LeaveRequest',
        entityId: req.params.id,
        status: 'Cancelled',
        comments: parsed.data.comments || null,
        ...(governed?{suppressNotification:true}:{}),
      });
      await audit(client, req, {
        module: 'Leave',
        action: 'Cancelled Leave',
        entityType: 'LeaveRequest',
        entityId: req.params.id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `Cancelled leave request ${req.params.id}`,
        reason: parsed.data.comments,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if(approvalError(res,error))return;
      console.error(error);
      res.status(500).json({ error: 'Leave request cancellation failed' });
    } finally {
      let discard=false;try{await unlockLeaveApprovalScope(client,req);}catch{discard=true;}client.release(discard);
    }
  });

  router.patch('/leave/requests/:id/status', requireDatabase, requireAuth, requirePermission('leave.approve'), async (req, res) => {
    const schema = z.object({
      status: z.enum(['Approved', 'Rejected', 'Cancelled']),
      comments: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.status === 'Rejected' && !parsed.data.comments?.trim()) {
      res.status(422).json({ error: 'Rejected leave requests require comments' });
      return;
    }
    const client = await pool.connect();
    try {
      await lockLeaveApprovalScope(client,req);
      await client.query('begin');
      const previous = (await client.query('select *,start_date::text,end_date::text from leave_requests where id = $1 for update', [req.params.id])).rows[0];
      if (!previous) {
        await client.query('rollback');
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }
      if (parsed.data.status !== 'Cancelled' && previous.status !== 'Submitted') {
        await client.query('rollback');
        res.status(422).json({ error: 'Only submitted leave requests can be decided' });
        return;
      }
      if (parsed.data.status === 'Cancelled' && !['Submitted', 'Approved'].includes(previous.status)) {
        await client.query('rollback');
        res.status(422).json({ error: 'Only submitted or approved leave requests can be cancelled' });
        return;
      }
      const decisionScopeParams = [previous.employee_id];
      const decisionScopedEmployee = (await client.query(`
        select 1
        from employees e
        where e.id = $1 and ${buildEmployeeScopeWhere(req, decisionScopeParams, 'e')}
        limit 1
      `, decisionScopeParams)).rows[0];
      if (!decisionScopedEmployee) {
        await client.query('rollback');
        res.status(403).json({ error: 'Leave request is outside active-role data scope' });
        return;
      }
      if (req.user.activeRole === 'CountryDirector') {
        const scoped = (await client.query(`
          select 1
          from employees e
          left join employee_country_director_map ecdm on ecdm.employee_id = e.id
          where e.id = $1 and (e.primary_country_director_id = $2 or ecdm.country_director_id = $2)
          limit 1
        `, [previous.employee_id, req.user.countryDirectorId])).rows[0];
        if (!scoped) {
          await client.query('rollback');
          res.status(403).json({ error: 'Country Directors can decide only scoped employee leave requests' });
          return;
        }
      }
      if (req.user.activeRole === 'TeamLead') {
        const scoped = (await client.query('select 1 from employees where id = $1 and reporting_manager_id = $2', [previous.employee_id, req.user.employeeRecordId])).rows[0];
        if (!scoped) {
          await client.query('rollback');
          res.status(403).json({ error: 'Team Leads can decide only direct-report leave requests' });
          return;
        }
      }
      let governed=false;
      if(parsed.data.status==='Cancelled')governed=Boolean(await retainLeaveCancellation(client,req,previous,parsed.data.comments));else await assertLegacyLeaveApproval(client,previous.id);
      if(parsed.data.status!=='Cancelled')await assertIndependentLeaveDecision(client,req,previous);
      await assertCalendarLeaveDecision(client,req,previous,parsed.data.status,buildEmployeeScopeWhere,getBusinessLeaveDays);
      const result = await client.query(`
        update leave_requests
        set status = $2,
          comments = $3,
          approver_id = $4,
          approver_name = $5,
          decided_at = now(),
          updated_at = now()
        where id = $1
        returning *
      `, [req.params.id, parsed.data.status, parsed.data.comments || null, req.user.employeeRecordId || req.user.sub, req.user.username]);
      await refreshLeaveBalancesForEmployee(client, previous.employee_id, getLeaveYear(previous.start_date));
      await audit(client, req, {
        module: 'Leave',
        action: `${parsed.data.status} Leave`,
        entityType: 'LeaveRequest',
        entityId: req.params.id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `${parsed.data.status} leave request ${req.params.id}`,
        reason: parsed.data.comments,
      });
      await decideApprovalRecord(client, req, {
        entityType: 'LeaveRequest',
        entityId: req.params.id,
        status: parsed.data.status,
        comments: parsed.data.comments || null,
        ...(governed?{suppressNotification:true}:{}),
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if(approvalError(res,error)||calendarLeaveError(res,error))return;
      console.error(error);
      res.status(500).json({ error: 'Leave request status update failed' });
    } finally {
      let discard=false;try{await unlockLeaveApprovalScope(client,req);}catch{discard=true;}client.release(discard);
    }
  });

  return router;
};
