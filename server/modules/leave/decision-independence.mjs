// Legacy approval must retain the same requester/worker separation as configured
// stages. Resolve identity from the database, not stale session worker claims.
export const assertIndependentLeaveDecision = async (client, req, leave) => {
  const result = await client.query(`select
    exists(select 1 from users u join employees e on e.id=$2
      where u.id=$1::uuid and (u.employee_record_id=e.id
        or (u.employee_record_id is null and u.employee_id=e.employee_id)))
    or exists(select 1 from audit_logs a where a.entity_type='LeaveRequest'
      and a.entity_id=$3 and a.module='Leave' and a.action='Submit Leave'
      and a.user_id=$1::text) as self_decision`, [req.user.sub, leave.employee_id, leave.id]);
  if (result.rows[0]?.self_decision) {
    const error = new Error('The requester or affected worker cannot decide their own leave request.');
    error.code = 'LEAVE_APPROVAL_SELF_DECISION';
    error.statusCode = 403;
    throw error;
  }
};
