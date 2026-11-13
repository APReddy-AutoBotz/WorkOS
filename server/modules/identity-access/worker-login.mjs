import {randomUUID} from 'node:crypto';

const conflict = () => Object.assign(new Error('Worker login ownership conflicts with an existing account.'), {
  statusCode: 409, code: 'WORKER_LOGIN_CONFLICT',
});

// Call within the employee transaction. A username collision is never update authority.
export const saveWorkerLogin = async (client, {existingUser, employee, passwordHash, scope}) => {
  try {
    if (existingUser) {
      const result = await client.query(`update users u set employee_id=$2,email=$3,status=$4,updated_at=now()
        where u.id=$1 and u.employee_record_id=$5 and exists (
          select 1 from employees e where e.id=u.employee_record_id and e.organization_id=$6 and e.legal_entity_id=$7)
        returning u.id`, [existingUser.id, employee.employee_id, employee.email,
        employee.status==='Exited'?'Disabled':'Active', employee.id, scope.organizationId, scope.legalEntityId]);
      if (result.rowCount !== 1) throw conflict();
      return result;
    }
    // Provisioning is infrequent; serialize name selection across this isolated deployment.
    // The unique constraint still handles conflicting writers outside this helper.
    await client.query("select pg_advisory_xact_lock(hashtext('workos:worker-login-creation'))");
    const owned = await client.query('select 1 from employees where id=$1 and organization_id=$2 and legal_entity_id=$3',
      [employee.id, scope.organizationId, scope.legalEntityId]);
    if (!owned.rowCount) throw conflict();
    const base = employee.employee_id.toLowerCase();
    const scoped = `${base}-${scope.organizationId}-${scope.legalEntityId}`.toLowerCase();
    const candidates = [base, scoped, ...Array.from({length: 3}, () => `${scoped}-${randomUUID()}`)];
    for (const username of candidates) {
      if ((await client.query('select 1 from users where lower(username)=lower($1)', [username])).rowCount) continue;
      const result = await client.query(`insert into users(username,employee_id,employee_record_id,email,password_hash,status,updated_at)
        values($1,$2,$3,$4,$5,$6,now()) on conflict(username) do nothing returning id`,
      [username, employee.employee_id, employee.id, employee.email, passwordHash, employee.status==='Exited'?'Disabled':'Active']);
      if (result.rowCount === 1) return result;
    }
    throw conflict();
  } catch (error) {
    if (error.code === '23505') throw conflict();
    throw error;
  }
};
