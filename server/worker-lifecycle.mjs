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

const reactivationConflict = () => {
  const error = new Error('Worker reactivation conflicts with existing history');
  error.code = 'WORKER_VERSION_CONFLICT';
  return error;
};

const lifecycleDateOnly = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

// Call inside the same transaction as the employee and linked-identity writes.
export const synchronizeWorkerReactivation = async (client, {
  employeeId,
  organizationId,
  legalEntityId,
  actorId,
  effectiveFrom,
  status,
  reason,
  source,
}) => {
  if (!['Active', 'On Leave'].includes(status)) throw reactivationConflict();
  const effectiveDate = lifecycleDateOnly(effectiveFrom);
  const profile = (await client.query(`
    select lifecycle_status, effective_from
    from worker_profiles
    where employee_id=$1 and organization_id=$2 and legal_entity_id=$3
    for update
  `, [employeeId, organizationId, legalEntityId])).rows[0];
  const latest = (await client.query(`
    select status, effective_from, effective_to
    from worker_history
    where employee_id=$1 and organization_id=$2 and legal_entity_id=$3
    order by effective_from desc limit 1 for update
  `, [employeeId, organizationId, legalEntityId])).rows[0];

  if (
    !profile || !latest ||
    !['Exited', 'Disabled'].includes(profile.lifecycle_status) ||
    latest.status !== profile.lifecycle_status ||
    lifecycleDateOnly(profile.effective_from) !== lifecycleDateOnly(latest.effective_from) ||
    latest.effective_to != null ||
    effectiveDate <= lifecycleDateOnly(latest.effective_from)
  ) throw reactivationConflict();

  try {
    const closed = await client.query(`
      update worker_history set effective_to=$4::date - 1
      where employee_id=$1 and organization_id=$2 and legal_entity_id=$3
        and effective_from=$5 and status=$6 and effective_to is null
      returning employee_id
    `, [employeeId, organizationId, legalEntityId, effectiveDate, lifecycleDateOnly(latest.effective_from), profile.lifecycle_status]);
    if (closed.rowCount !== 1) throw reactivationConflict();

    const history = await client.query(`
      insert into worker_history (employee_id, organization_id, legal_entity_id, effective_from, status, snapshot, actor_id)
      select e.id, $2, $3, $4::date, $5::text,
        jsonb_build_object('status', $5::text, 'reason', $6::text, 'source', $7::text, 'previousStatus', $8::text, 'employee', to_jsonb(e)), $9
      from employees e
      where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3 and e.status=$5::text
      returning employee_id
    `, [employeeId, organizationId, legalEntityId, effectiveDate, status, reason, source, profile.lifecycle_status, actorId]);
    if (history.rowCount !== 1) throw reactivationConflict();

    const updatedProfile = await client.query(`
      update worker_profiles
      set lifecycle_status=$4, effective_from=$5, updated_at=now()
      where employee_id=$1 and organization_id=$2 and legal_entity_id=$3
        and lifecycle_status=$6 and effective_from=$7
      returning employee_id
    `, [employeeId, organizationId, legalEntityId, status, effectiveDate, profile.lifecycle_status, lifecycleDateOnly(profile.effective_from)]);
    if (updatedProfile.rowCount !== 1) throw reactivationConflict();

    await restoreLinkedWorkerIdentity(client, { employeeId, organizationId, legalEntityId });
    return true;
  } catch (error) {
    if (['23P01', '23505', '23514'].includes(error.code)) throw reactivationConflict();
    throw error;
  }
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
