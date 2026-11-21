// Personal work and direct-report review use distinct row scopes for both list and history reads.
export function authorizeDirectReportReview(req, res, next) {
  if (req.query.view === 'direct-report-review' &&
      (req.user.activeRole !== 'TeamLead' || !req.user.permissions.includes('timesheets.approve'))) {
    return res.status(403).json({error: 'Direct-report review requires team lead approval access.'});
  }
  next();
}

export const timesheetReadScope=req=>{
  const params = [];
  let where = '';
  if (req.query?.view === 'direct-report-review' && req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `where e.organization_id = t.organization_id and e.reporting_manager_id in ($1,$2) and t.status in ('Submitted','Approved','Rejected')
      and e.id is distinct from $1 and e.employee_id is distinct from $2`;
  } else if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
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
