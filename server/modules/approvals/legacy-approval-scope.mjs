import {qualifiedDirectorSql} from '../identity-access/workforce-authority.mjs';

// Legacy delegation never bypasses current owner authority or selected entity.
export const legacyApprovalScope = (req, params, {isGlobalRole, buildEmployeeScopeWhere, timesheetId = null}) => {
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  const ownership = `e.organization_id=$${params.length - 1} and e.legal_entity_id=$${params.length}`;
  if (isGlobalRole(req)) return ownership;
  params.push(req.user.employeeRecordId, req.user.activeRole);
  const delegateParam = `$${params.length - 1}`;
  const roleParam = `$${params.length}`;
  // A visible approval is not sufficient authority to decide its work source.
  // Timesheet decisions require the delegator's current source permission and
  // cannot turn the delegator's own work into independently approvable work.
  let timesheetParam;
  if (timesheetId) { params.push(timesheetId); timesheetParam = `$${params.length}`; }
  const sourcePermission = timesheetId ? `and e.id <> owner.id
    and (exists(select 1 from role_permissions rp where rp.role_name=ad.role and rp.permission_key='timesheets.approve' and rp.enabled)
      or exists(select 1 from user_permission_grants pg where pg.user_id=owner_user.id and pg.permission_key='timesheets.approve'))` : '';
  const managedWork = alias => `exists(select 1 from timesheet_entries te join projects p on p.id=te.project_id
    where te.timesheet_id=${timesheetParam} and p.organization_id=e.organization_id and p.legal_entity_id=e.legal_entity_id
      and p.manager_id in (${alias}.id,${alias}.employee_id))`;
  const delegatedScope = `exists (
    select 1
    from approval_delegations ad
    join employees owner on owner.id=ad.delegator_id
    join employees recipient on recipient.id=ad.delegate_id
    join users owner_user on owner_user.employee_record_id=owner.id and owner_user.status='Active'
    where ad.delegate_id = ${delegateParam}
      and ad.role = ${roleParam}
      and owner.status <> 'Exited' and recipient.status <> 'Exited'
      and owner.organization_id=e.organization_id and owner.legal_entity_id=e.legal_entity_id
      and recipient.organization_id=e.organization_id and recipient.legal_entity_id=e.legal_entity_id
      and exists(select 1 from user_roles ur join roles r on r.id=ur.role_id
        where ur.user_id=owner_user.id and r.name=ad.role)
      and exists(select 1 from user_organization_scopes os where os.user_id=owner_user.id
        and os.organization_id=e.organization_id and os.legal_entity_id=e.legal_entity_id and os.active)
      and (exists(select 1 from role_permissions rp where rp.role_name=ad.role and rp.permission_key='approvals.view' and rp.enabled)
        or exists(select 1 from user_permission_grants pg where pg.user_id=owner_user.id and pg.permission_key='approvals.view'))
      ${sourcePermission}
      and (ad.role in ('Admin','HR','TeamLead')
        or (ad.role='Employee' and e.id=owner.id)
        or (ad.role='CountryDirector'
          and (${qualifiedDirectorSql('owner')}) is not null
          and (e.primary_country_director_id=owner.primary_country_director_id
            or exists(select 1 from employee_country_director_map cm where cm.employee_id=e.id and cm.country_director_id=owner.primary_country_director_id)))
        or (ad.role='ProjectManager' ${timesheetId ? `and ${managedWork('owner')}` : ''} and (e.id=owner.id or exists(
          select 1 from project_allocations pa join projects p on p.id=pa.project_id
          where pa.employee_id=e.id and p.organization_id=e.organization_id and p.legal_entity_id=e.legal_entity_id
            and p.manager_id in (owner.id,owner.employee_id)))))
      and ad.status = 'Active'
      and current_date between ad.start_date and ad.end_date
      and (e.id = ad.delegator_id or e.reporting_manager_id = ad.delegator_id)
  )`;
  if (req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and ((e.id = $${params.length - 1} or e.employee_id = $${params.length} or e.reporting_manager_id = $${params.length - 1}) or ${delegatedScope})`;
  }
  let directScope;
  if (timesheetId && req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId);
    directScope = `exists(select 1 from employees direct_owner where direct_owner.id=$${params.length}
      and ${managedWork('direct_owner')})`;
  } else {
    directScope = buildEmployeeScopeWhere(req, params, 'e');
  }
  return `(${ownership}) and (${directScope} or ${delegatedScope})`;
};
