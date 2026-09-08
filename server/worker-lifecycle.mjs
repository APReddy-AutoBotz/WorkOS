export const initializeNewWorkerLifecycle = async (client, {
  employeeId,
  organizationId,
  legalEntityId,
  actorId,
  isNew,
}) => {
  if (!isNew) return false;

  const profile = await client.query(`
    insert into worker_profiles (employee_id, organization_id, legal_entity_id, lifecycle_status, effective_from)
    select e.id, $2, $3,
      case e.status when 'Exited' then 'Exited' when 'On Leave' then 'On Leave' else 'Active' end,
      coalesce(e.joining_date, e.created_at::date, current_date)
    from employees e
    where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3
  `, [employeeId, organizationId, legalEntityId]);
  if (profile.rowCount !== 1) throw new Error('New worker profile initialization failed');
  const history = await client.query(`
    insert into worker_history (employee_id, organization_id, legal_entity_id, effective_from, status, snapshot, actor_id)
    select e.id, $2, $3, wp.effective_from, wp.lifecycle_status, to_jsonb(e), $4
    from employees e
    join worker_profiles wp on wp.employee_id=e.id and wp.organization_id=$2 and wp.legal_entity_id=$3
    where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3
  `, [employeeId, organizationId, legalEntityId, actorId]);
  if (history.rowCount !== 1) throw new Error('Initial worker history creation failed');
  return true;
};

export const disableLinkedWorkerIdentity = async (client, {
  employeeId,
  organizationId,
  legalEntityId,
}) => {
  const users = await client.query(`
    update users set status='Disabled', updated_at=now()
    where employee_record_id=$1
    returning id
  `, [employeeId]);
  if (users.rowCount) {
    const scopes = await client.query(`
      update user_organization_scopes set active=false
      where user_id=any($1::uuid[]) and organization_id=$2 and legal_entity_id=$3
      returning user_id
    `, [users.rows.map(user => user.id), organizationId, legalEntityId]);
    if (scopes.rowCount !== users.rowCount) {
      throw new Error('Linked worker identity scope synchronization failed');
    }
  }
  return users.rowCount;
};

export const restoreLinkedWorkerIdentity = async (client, {
  employeeId,
  organizationId,
  legalEntityId,
}) => {
  const users = await client.query(`
    update users set status='Active', updated_at=now()
    where employee_record_id=$1
    returning id
  `, [employeeId]);
  if (users.rowCount) {
    const scopes = await client.query(`
      update user_organization_scopes set active=true
      where user_id=any($1::uuid[]) and organization_id=$2 and legal_entity_id=$3
      returning user_id
    `, [users.rows.map(user => user.id), organizationId, legalEntityId]);
    if (scopes.rowCount !== users.rowCount) {
      const error = new Error('Linked worker identity scope synchronization failed');
      error.code = 'WORKER_IDENTITY_SYNC_CONFLICT';
      throw error;
    }
  }
  return users.rowCount;
};
