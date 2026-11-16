import {sessionEntraGroups} from './middleware.mjs';

const denied = message => Object.assign(new Error(message), {statusCode: 403, code: 'IDENTITY_ADMINISTRATION_REQUIRED'});
const invalid = message => Object.assign(new Error(message), {statusCode: 422, code: 'IDENTITY_ASSIGNMENT_INVALID'});
const canonical = roles => [...new Set(roles)].sort();

export const readAssignedRoles = async (client, userId) => (await client.query(`
  select r.name from user_roles ur join roles r on r.id=ur.role_id
  where ur.user_id=$1 order by r.name for share of ur`, [userId])).rows.map(row => row.name);

export const assertSecurityAdministrator = async (client, req, getPermissions) => {
  if (req.user.activeRole !== 'Admin') throw denied('Security administration requires the active Admin role.');
  const groups = sessionEntraGroups(req.user);
  await client.query('select id from users where id=$1 for share', [req.user.sub]);
  await client.query('select role_id from user_roles where user_id=$1 for share', [req.user.sub]);
  await client.query("select id from entra_group_role_mappings where active and role_name='Admin' and group_id=any($1::text[]) for share", [groups]);
  const held = await client.query(`select 1 from users u where u.id=$1 and u.status='Active' and (
    exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name='Admin')
    or exists(select 1 from entra_group_role_mappings m where m.active and m.role_name='Admin' and m.group_id=any($2::text[])))
    for share of u`, [req.user.sub, groups]);
  if (!held.rowCount) throw denied('Current security-administrator authority is required.');
  await client.query(`select permission_key from role_permissions
    where role_name='Admin' and permission_key='permissions.manage' for share`);
  await client.query(`select permission_key from user_permission_grants
    where user_id=$1 and permission_key='permissions.manage' for share`, [req.user.sub]);
  if (!(await getPermissions(client, req.user.sub, req.user.activeRole)).includes('permissions.manage')) {
    throw denied('Protected permission-management authority is required.');
  }
};

export const assertCredentialTarget = async (client, req, userId, getPermissions) => {
  if (!userId) return;
  const roles = await readAssignedRoles(client, userId);
  const grants = await client.query('select 1 from user_permission_grants where user_id=$1 limit 1', [userId]);
  const organizationGrants = await client.query('select 1 from organization_audit_grants where user_id=$1 limit 1', [userId]);
  // The caller holds the target user/employee locks. Provider groups are not
  // persisted as local roles, so a bound account cannot be classified as an
  // ordinary Employee solely from user_roles. Disabled/pending links still bind
  // identity and do not make a workforce credential takeover safe.
  const providerBinding = await client.query(`select 1 from users u
    join employees e on e.id=u.employee_record_id where u.id=$1 and (
      nullif(u.entra_object_id,'') is not null or nullif(e.entra_object_id,'') is not null
      or exists(select 1 from identity_provider_links l where l.employee_id=e.id and l.provider='entra'))`, [userId]);
  if (roles.some(role => role !== 'Employee') || grants.rowCount || organizationGrants.rowCount || providerBinding.rowCount) {
    await assertSecurityAdministrator(client, req, getPermissions);
  }
};

export const assignEmployeeRoles = async (client, req, {
  userId, requestedRoles, newAccount, supportedRoles, getPermissions, audit,
}) => {
  await client.query("select pg_advisory_xact_lock(hashtext('workos:security-role-administration'))");
  const previous = await readAssignedRoles(client, userId);
  // Omission is profile maintenance, including mapped-only provider accounts.
  // Explicit empty role assignments still pass through validation below.
  if (!newAccount && requestedRoles === undefined) return;
  const next = canonical(requestedRoles === undefined ? (newAccount ? ['Employee'] : previous) : requestedRoles);
  if (!next.length || next.some(role => !supportedRoles.includes(role))) throw invalid('Select at least one supported role.');
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  if (!(newAccount && next.length === 1 && next[0] === 'Employee')) {
    await assertSecurityAdministrator(client, req, getPermissions);
    if (previous.includes('Admin') && !next.includes('Admin')) {
      const stranded = await client.query(`select 1 from user_organization_scopes target
        where target.user_id=$1 and target.active and not exists (
          select 1 from users u join user_roles ur on ur.user_id=u.id
          join roles r on r.id=ur.role_id and r.name='Admin'
          join user_organization_scopes s on s.user_id=u.id and s.active
          where u.id<>$1 and u.status='Active' and s.organization_id=target.organization_id
            and s.legal_entity_id=target.legal_entity_id) limit 1`, [userId]);
      if (stranded.rowCount) throw invalid('Keep an active assigned administrator for every affected organization scope.');
    }
  }
  const rows = await client.query('select id,name from roles where name=any($1::text[]) order by name', [next]);
  if (rows.rowCount !== next.length) throw invalid('A requested role is unavailable.');
  await client.query('delete from user_roles where user_id=$1', [userId]);
  for (const role of rows.rows) await client.query('insert into user_roles(user_id,role_id)values($1,$2)', [userId, role.id]);
  await audit(client, req, {module: 'Identity', action: 'Assign User Roles', entityType: 'User', entityId: userId,
    oldValue: {roles: previous}, newValue: {roles: next}, details: 'Explicit authorized role assignment; employee codes do not grant authority.'});
};

export const synchronizeEntraBinding = async (client, req, {
  employeeId, userId, previousSubject, nextSubject, subjectSpecified, getPermissions, audit,
}) => {
  if (!subjectSpecified) return;
  const before = previousSubject || null, after = nextSubject || null;
  if (after && before === after) return;
  const user = (await client.query('select entra_object_id from users where id=$1 and employee_record_id=$2 for update', [userId, employeeId])).rows[0];
  const link = (await client.query("select provider_subject,status from identity_provider_links where employee_id=$1 and provider='entra' for update", [employeeId])).rows[0];
  if (!after && !before && !user?.entra_object_id && (!link || link.status === 'Disabled')) return;
  if (!(await getPermissions(client, req.user.sub, req.user.activeRole)).includes('integrations.identity')) {
    throw denied('Identity integration authority is required to change a login binding.');
  }
  await assertSecurityAdministrator(client, req, getPermissions);
  if (after) {
    await client.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,status)
      values ('identity-link-'||gen_random_uuid()::text,$1,'entra',$2,'Linked')
      on conflict(employee_id,provider) do update set provider_subject=excluded.provider_subject,status='Linked',updated_at=now()`,
    [employeeId, after]);
  } else {
    // A durable revocation record must also cover pre-link legacy identities.
    // Otherwise callbacks can bootstrap the old user subject back into Linked.
    const revokedSubject = link?.provider_subject || before || user?.entra_object_id;
    if (revokedSubject) {
      const revoked = await client.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,status)
      values ('identity-link-'||gen_random_uuid()::text,$1,'entra',$2,'Disabled')
      on conflict(employee_id,provider) do update set status='Disabled',updated_at=now() returning provenance_reference`, [employeeId, revokedSubject]);
      await audit(client, req, {module:'Identity',action:'Clear Identity Binding',entityType:'IdentityProviderLink',entityId:revoked.rows[0].provenance_reference,
        oldValue:{status:link?.status || 'Legacy',hasEmployeeSubject:Boolean(before),hasUserSubject:Boolean(user?.entra_object_id)},
        newValue:{status:'Disabled',hasEmployeeSubject:false,hasUserSubject:false},
        details:'Explicit identity unlink revokes legacy fallback authority.',source:'Entra',sourceIdentifier:revoked.rows[0].provenance_reference});
    }
  }
  await client.query('update users set entra_object_id=$2,updated_at=now() where id=$1 and employee_record_id=$3', [userId, after, employeeId]);
};
