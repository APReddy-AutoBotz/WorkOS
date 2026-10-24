// Preserve the existing header-list visibility contract for all work readers.
export const timesheetReadScope=req=>{
  const params = [];
  let where = '';
  if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = 'where t.employee_id = $1 or e.employee_id = $2';
  } else if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    where = `
      where e.primary_country_director_id = $1
         or exists (
          select 1 from employee_country_director_map ecdm
          where ecdm.employee_id = e.id and ecdm.country_director_id = $1
        )
    `;
  } else if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where exists (
        select 1
        from timesheet_entries scope_te
        join projects scope_p on scope_p.id = scope_te.project_id
        where scope_te.timesheet_id = t.id
          and (scope_p.manager_id = $1 or scope_p.manager_id = $2)
      )
    `;
  }
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  where = `where t.organization_id = $${params.length-1} and t.legal_entity_id = $${params.length} and e.legal_entity_id = $${params.length}${where ? ` and (${where.replace(/^\s*where\s+/, '').trim()})` : ''}`;
  return {params,where};
};
