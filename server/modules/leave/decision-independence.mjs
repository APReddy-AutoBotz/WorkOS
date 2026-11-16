import {qualifiedDirectorSql} from '../identity-access/workforce-authority.mjs';

const deny = (status, code, message) => {
  throw Object.assign(new Error(message), {status, code});
};

// Call inside the source decision transaction, after locking the leave row.
// Session worker claims and approval requester labels are not decision authority.
export const assertIndependentLeaveDecision = async (client, req, leave, buildEmployeeScopeWhere, {getEffectivePermissions, cancellation = false} = {}) => {
  if (!req.user.permissions?.includes('leave.approve')) {
    deny(403, 'LEAVE_DECISION_FORBIDDEN', 'Insufficient permission privileges');
  }
  const actor = (await client.query(`select employee_record_id, employee_id from users
    where id=$1 and status='Active' for share`, [req.user.sub])).rows[0];
  if (!actor) deny(403, 'LEAVE_DECISION_FORBIDDEN', 'Current decision identity is unavailable.');
  const worker = (await client.query(`select id,employee_id,${qualifiedDirectorSql('employees')} as director_id from employees
    where id=$1 for share`, [actor.employee_record_id])).rows[0];
  const currentReq = {...req, user:{...req.user, employeeRecordId:worker?.id,
    employeeId:worker?.employee_id, countryDirectorId:worker?.director_id}};
  const params = [leave.employee_id];
  const scoped = (await client.query(`select e.id from employees e where e.id=$1
    and ${buildEmployeeScopeWhere(currentReq, params, 'e')} for share of e`, params)).rows[0];
  const delegations = !scoped && worker && getEffectivePermissions ? (await client.query(`
    select ad.id,u.id as user_id,delegator.id as worker_id,
      delegator.employee_id as worker_code,${qualifiedDirectorSql('delegator')} as director_id
    from approval_delegations ad
    join employees delegator on delegator.id=ad.delegator_id and delegator.status='Active'
    join employees delegate on delegate.id=ad.delegate_id and delegate.status='Active'
    join employees target on target.id=$1 and target.reporting_manager_id=delegator.id
    join users u on u.employee_record_id=delegator.id and u.status='Active'
    join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id and r.name=ad.role
    join user_organization_scopes os on os.user_id=u.id and os.active=true
      and os.organization_id=$3 and os.legal_entity_id=$4
    where ad.delegate_id=$2 and ad.role=$5 and ad.status='Active'
      and current_date between ad.start_date and ad.end_date
      and target.organization_id=$3 and target.legal_entity_id=$4
      and delegator.organization_id=$3 and delegator.legal_entity_id=$4
      and delegate.organization_id=$3 and delegate.legal_entity_id=$4
    order by ad.id for share of ad,delegator,delegate,target,u,ur,r,os`,
  [leave.employee_id, worker.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId, req.user.activeRole])).rows : [];
  const authorizedDelegators = new Set();
  for (const delegation of delegations) {
    if (!(await getEffectivePermissions(client, delegation.user_id, req.user.activeRole)).includes('leave.approve')) continue;
    const delegatorRequest = {...req,user:{...req.user,sub:delegation.user_id,
      employeeRecordId:delegation.worker_id,employeeId:delegation.worker_code,countryDirectorId:delegation.director_id}};
    const delegatorParams = [leave.employee_id];
    const authority = (await client.query(`select e.id from employees e where e.id=$1
      and ${buildEmployeeScopeWhere(delegatorRequest,delegatorParams,'e')} for share of e`,delegatorParams)).rows[0];
    if (authority) authorizedDelegators.add(delegation.user_id);
  }
  if (!scoped && !authorizedDelegators.size) deny(403, 'LEAVE_DECISION_FORBIDDEN', 'Leave request is outside active-role data scope');
  if (cancellation) return;
  if (worker?.id === leave.employee_id) {
    deny(403, 'LEAVE_APPROVAL_SELF_DECISION', 'The requester or affected worker cannot decide their own leave request.');
  }
  const submitters = (await client.query(`select distinct user_id from audit_logs
    where module='Leave' and action='Submit Leave' and entity_type='LeaveRequest'
      and entity_id=$1 and organization_id=$2 and legal_entity_id=$3`,
  [leave.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows;
  if (submitters.length !== 1 || !submitters[0].user_id) {
    deny(409, 'LEAVE_SUBMITTER_UNCONFIRMED', 'Submission evidence is unavailable or conflicting. Cancel and resubmit this request before a decision.');
  }
  if (submitters[0].user_id === req.user.sub) {
    deny(403, 'LEAVE_APPROVAL_SELF_DECISION', 'The requester or affected worker cannot decide their own leave request.');
  }
  if (!scoped && ![...authorizedDelegators].some(id => id !== submitters[0].user_id))
    deny(403, 'LEAVE_APPROVAL_SELF_DECISION', 'A requester cannot delegate authority to decide their own submission.');
};

export const sendLeaveDecisionError = (res, error) => {
  if (!['LEAVE_DECISION_FORBIDDEN', 'LEAVE_APPROVAL_SELF_DECISION', 'LEAVE_SUBMITTER_UNCONFIRMED'].includes(error.code)) return false;
  res.status(error.status).json({error:error.message, code:error.code});
  return true;
};
