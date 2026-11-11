// Local, unintegrated prototype. Do not wire into routes until the documented
// PostgreSQL acceptance and independent-review gates have passed.
const AUTHORITY_TABLES = Object.freeze([
  'legal_entities', 'legal_entity_profile_versions', 'organization_profile_versions',
  'organizations', 'role_permissions', 'roles', 'user_organization_scopes',
  'user_permission_grants', 'user_roles', 'users',
]);

export class AdminMutationAuthorityError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = 'AdminMutationAuthorityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const denied = () => new AdminMutationAuthorityError(
  'ADMIN_AUTHORITY_REVOKED', 403, 'Current role, permission or organization scope is not authorized.',
);

function captureRequest(request) {
  const actor = {
    userId: request.user?.sub,
    activeRole: request.user?.activeRole,
    expiresAt: request.user?.exp,
    organizationId: request.organizationScope?.organizationId,
    legalEntityId: request.organizationScope?.legalEntityId,
    requestedOrganizationId: String(request.headers?.['x-organization-id'] || '').trim(),
    requestedLegalEntityId: String(request.headers?.['x-legal-entity-id'] || '').trim(),
  };
  if (![actor.userId, actor.activeRole, actor.organizationId, actor.legalEntityId]
    .every(value => typeof value === 'string' && value.length > 0)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw denied();
  return Object.freeze(actor);
}

async function assertCurrentAuthority(client, actor, getDefaultPermissionsForRole) {
  // SRE conflicts with every ordinary INSERT/UPDATE/DELETE, including inserts
  // into an empty permission/scope set. Self-conflict also prevents two legal
  // entity creates from both holding SHARE and then deadlocking on an upgrade.
  // NOWAIT avoids waiting in a new order behind existing authority writers.
  try {
    await client.query(`lock table ${AUTHORITY_TABLES.join(', ')} in share row exclusive mode nowait`);
  } catch (error) {
    if (error.code === '55P03') throw new AdminMutationAuthorityError(
      'ADMIN_AUTHORITY_BUSY', 409, 'Authority is changing. Reload and retry the change.',
    );
    throw error; // Missing tables must never activate role-default fallback.
  }

  const heldRole = await client.query(`select 1 from users u
    join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
    where u.id=$1 and u.status='Active' and r.name=$2`, [actor.userId, actor.activeRole]);
  if (heldRole.rows.length !== 1) throw denied();

  const role = await client.query(
    'select permission_key, enabled from role_permissions where role_name = $1', [actor.activeRole],
  );
  const grants = await client.query(
    'select permission_key from user_permission_grants where user_id = $1', [actor.userId],
  );
  // Preserve existing semantics: defaults only for an entirely absent role
  // configuration; explicit disabled rows suppress defaults; direct grants add.
  const permissions = role.rows.length
    ? role.rows.filter(row => row.enabled === true).map(row => row.permission_key)
    : getDefaultPermissionsForRole(actor.activeRole);
  if (!Array.isArray(permissions)
    || ![...permissions, ...grants.rows.map(row => row.permission_key)].includes('settings.manage')) throw denied();

  // statement_timestamp is intentionally not current_date: BEGIN may have
  // waited on the business lock over midnight. Match original header ambiguity,
  // not just the scope selected by earlier middleware.
  const scope = await client.query(`with authority_clock as (select statement_timestamp()::date today)
    select s.organization_id, s.legal_entity_id, t.today::text authority_date,
      least(extract(epoch from ((least(o.effective_to,lp.effective_to,lp.authority_effective_to)+1)::timestamp
        at time zone current_setting('TimeZone')))*1000,
        case when $2::text='' or $3::text='' then
          extract(epoch from ((t.today+1)::timestamp at time zone current_setting('TimeZone')))*1000
        end) authority_expires_at
    from user_organization_scopes s
    join users u on u.id=s.user_id and u.status='Active'
    join organizations o on o.id=s.organization_id
    cross join authority_clock t
    left join organization_profile_versions op on op.organization_id=o.id
      and t.today between op.effective_from and coalesce(op.effective_to,'infinity'::date)
    join legal_entities le on le.id=s.legal_entity_id and le.organization_id=s.organization_id
    join legal_entity_profile_versions lp on lp.legal_entity_id=le.id and lp.organization_id=le.organization_id
      and t.today between lp.effective_from and coalesce(lp.effective_to,'infinity'::date)
    where s.user_id=$1 and s.active=true and o.status='Active' and lp.status='Active'
      and t.today between o.effective_from and coalesce(o.effective_to,'infinity'::date)
      and t.today between le.effective_from and coalesce(lp.authority_effective_to,'infinity'::date)
      and ($2::text='' or s.organization_id=$2) and ($3::text='' or s.legal_entity_id=$3)
    order by s.organization_id,s.legal_entity_id limit 2`,
  [actor.userId, actor.requestedOrganizationId, actor.requestedLegalEntityId]);
  const current = scope.rows[0];
  if (scope.rows.length !== 1 || current.organization_id !== actor.organizationId
    || current.legal_entity_id !== actor.legalEntityId) throw denied();
  const scopeExpiry = current.authority_expires_at == null ? Infinity : Number(current.authority_expires_at);
  if (Number.isNaN(scopeExpiry) || typeof current.authority_date !== 'string' || !current.authority_date) throw denied();
  return { expiresAt: Math.min(actor.expiresAt, scopeExpiry), authorityDate: current.authority_date };
}

async function assertNotExpired(client, { expiresAt, authorityDate }) {
  // Date equality also fails closed at the first date transition in time zones
  // with an ambiguous/repeated midnight, regardless of timestamp conversion.
  const result = await client.query(
    `with guard_clock as (select clock_timestamp() checked_at)
      select extract(epoch from checked_at)*1000 < $1::double precision
        and checked_at::date = $2::date as authorized from guard_clock`, [expiresAt, authorityDate],
  );
  if (result.rows[0]?.authorized !== true) throw denied();
}

/**
 * Owns a new transaction. Call only after authenticated middleware and input
 * validation. businessLockKey must be constructed server-side exactly as in
 * the existing route. mutate must do only DB work, including audit, on client;
 * it must not commit, release, send a response or perform external effects.
 * Route business rules and optimistic revision checks remain its responsibility.
 */
export async function runAdminMutation({ pool, request, businessLockKey, getDefaultPermissionsForRole, mutate }) {
  const actor = captureRequest(request); // Capture before the first await.
  if (typeof businessLockKey !== 'string' || !businessLockKey
    || typeof getDefaultPermissionsForRole !== 'function' || typeof mutate !== 'function') {
    throw new TypeError('A server business lock, role defaults and mutation callback are required.');
  }
  const client = await pool.connect();
  let transactionStarted = false;
  let committing = false;
  let discard;
  try {
    // A new READ COMMITTED snapshot after the lock wait is necessary. A pooled
    // connection's changed default isolation must not silently freeze old data.
    await client.query('begin isolation level read committed');
    transactionStarted = true;
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [businessLockKey]);
    const deadline = await assertCurrentAuthority(client, actor, getDefaultPermissionsForRole);
    await assertNotExpired(client, deadline);
    const result = await mutate(client, actor);
    await assertNotExpired(client, deadline);
    committing = true;
    await client.query('commit');
    transactionStarted = false;
    return result;
  } catch (error) {
    // A lost COMMIT acknowledgement may mean it committed. Never retry it here
    // or report a definite rollback to the caller.
    if (committing) {
      discard = error;
      throw new AdminMutationAuthorityError('ADMIN_MUTATION_OUTCOME_UNKNOWN', 503,
        'Save outcome is unknown. Reload the record before trying again.');
    }
    // A failed BEGIN acknowledgement may still have opened a transaction.
    // Do not return that connection to the pool without discarding it.
    if (!transactionStarted) discard = error;
    throw error;
  } finally {
    if (transactionStarted && !committing) {
      try { await client.query('rollback'); } catch (error) { discard = error; }
    }
    client.release(discard);
  }
}
