import {z} from 'zod';

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'A valid calendar date is required');

export const registerLegacyDelegationRoutes = ({app, pool, run, requireDatabase, requireAuth, requirePermission, isGlobalRole, audit}) => {
app.get('/api/approval-delegations', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const params = [req.organizationScope.organizationId, req.organizationScope.legalEntityId];
  let where = 'delegator.organization_id=$1 and delegator.legal_entity_id=$2 and delegate.organization_id=$1 and delegate.legal_entity_id=$2';
  if (!isGlobalRole(req)) {
    params.push(req.user.employeeRecordId);
    where += ' and (ad.delegator_id = $3 or ad.delegate_id = $3)';
  }
  await run(res, `
    select ad.*, delegator.name as delegator_name, delegate.name as delegate_name
    from approval_delegations ad
    left join employees delegator on delegator.id = ad.delegator_id
    left join employees delegate on delegate.id = ad.delegate_id
    where ${where}
    order by ad.status desc, ad.start_date desc
  `, params);
});

app.post('/api/approval-delegations', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).max(200).optional(),
    delegator_id: z.string().min(1),
    delegate_id: z.string().min(1),
    role: z.string().min(1),
    start_date: dateInput,
    end_date: dateInput,
    status: z.enum(['Active', 'Inactive']).default('Active'),
    reason: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Delegation end date must be on or after start date' });
    return;
  }
  if (parsed.data.delegator_id === parsed.data.delegate_id) {
    res.status(422).json({ error: 'Delegator and delegate must be different employees' });
    return;
  }
  if (!isGlobalRole(req) && parsed.data.delegator_id !== req.user.employeeRecordId) {
    res.status(403).json({ error: 'Users can create delegations only for themselves' });
    return;
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('begin');
    // Serialize supplied identities before looking up retained ownership. Serialize
    // the owner as well so overlapping creates cannot both pass the predicate.
    if (parsed.data.id) await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['legacy-delegation-id:' + parsed.data.id]);
    const previous = parsed.data.id ? (await client.query('select * from approval_delegations where id=$1 for update', [parsed.data.id])).rows[0] : null;
    if (previous && (previous.delegator_id !== parsed.data.delegator_id
      || (!isGlobalRole(req) && previous.delegator_id !== req.user.employeeRecordId))) {
      await client.query('rollback');
      res.status(403).json({error: 'The retained delegation owner cannot be replaced'});
      return;
    }
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['legacy-delegation-owner:' + parsed.data.delegator_id]);
    if (previous) {
      const retained = await client.query(`select id from employees
        where id=any($1::text[]) and organization_id=$2 and legal_entity_id=$3
        order by id for share`, [[previous.delegator_id, previous.delegate_id], req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
      if (retained.rowCount !== 2) {
        await client.query('rollback');
        res.status(403).json({error: 'Retained delegation is outside the selected entity'});
        return;
      }
    }

    const people = (await client.query(`
      select id, status
      from employees
      where id in ($1, $2) and organization_id=$3 and legal_entity_id=$4
      order by id for share
    `, [parsed.data.delegator_id, parsed.data.delegate_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows;
    const delegator = people.find(row => row.id === parsed.data.delegator_id);
    const delegate = people.find(row => row.id === parsed.data.delegate_id);
    if (!delegator || !delegate || (parsed.data.status === 'Active' && (delegator.status === 'Exited' || delegate.status === 'Exited'))) {
      await client.query('rollback');
      res.status(422).json({ error: 'Delegation requires active delegator and delegate employees' });
      return;
    }
    if (parsed.data.status === 'Active') {
      const accounts = await client.query(`select u.id,u.employee_record_id from users u
        where u.employee_record_id=any($1::text[]) and u.status='Active' order by u.id for share`,
      [[delegator.id, delegate.id]]);
      const accountIds = accounts.rows.map(row => row.id);
      await client.query('select user_id from user_roles where user_id=any($1::uuid[]) for share', [accountIds]);
      await client.query('select user_id from user_organization_scopes where user_id=any($1::uuid[]) for share', [accountIds]);
      await client.query("select role_name from role_permissions where role_name=$1 and permission_key='approvals.view' for share", [parsed.data.role]);
      await client.query("select user_id from user_permission_grants where user_id=any($1::uuid[]) and permission_key='approvals.view' for share", [accountIds]);
      const authorized = await client.query(`select distinct u.employee_record_id from users u
        where u.id=any($1::uuid[]) and u.status='Active'
          and exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name=$2)
          and exists(select 1 from user_organization_scopes os where os.user_id=u.id and os.organization_id=$3 and os.legal_entity_id=$4 and os.active)
          and (exists(select 1 from role_permissions rp where rp.role_name=$2 and rp.permission_key='approvals.view' and rp.enabled)
            or exists(select 1 from user_permission_grants pg where pg.user_id=u.id and pg.permission_key='approvals.view'))`,
      [accountIds, parsed.data.role, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
      if (authorized.rowCount !== 2) {
        await client.query('rollback');
        res.status(422).json({error: 'Active delegation requires both participants to hold the selected role, scope and approval permission'});
        return;
      }
    }
    const overlapping = (await client.query(`
      select id
      from approval_delegations
      where id <> coalesce($1, '')
        and delegator_id = $2
        and delegate_id = $3
        and status = 'Active'
        and start_date <= $5::date
        and end_date >= $4::date
      limit 1
    `, [parsed.data.id || null, parsed.data.delegator_id, parsed.data.delegate_id, parsed.data.start_date, parsed.data.end_date])).rows[0];
    if (overlapping && parsed.data.status === 'Active') {
      await client.query('rollback');
      res.status(422).json({ error: 'An active approval delegation already overlaps this date range' });
      return;
    }
    const result = await client.query(`
      insert into approval_delegations (id, delegator_id, delegate_id, role, start_date, end_date, status, reason)
      values (coalesce($1, 'approval-delegation-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8)
      on conflict (id) do update set
        delegate_id = excluded.delegate_id,
        role = excluded.role,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.delegator_id, parsed.data.delegate_id, parsed.data.role, parsed.data.start_date, parsed.data.end_date, parsed.data.status, parsed.data.reason || null]);
    await audit(client, req, {
      module: 'Approvals',
      action: previous ? 'Update Approval Delegation' : 'Create Approval Delegation',
      entityType: 'ApprovalDelegation',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} approval delegation ${result.rows[0].id}`,
      reason: parsed.data.reason,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    if (client) await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Approval delegation save failed' });
  } finally {
    client?.release();
  }
});

};
