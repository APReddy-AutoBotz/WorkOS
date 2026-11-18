import assert from 'node:assert/strict';
import express from 'express';
import {createLeaveRouter} from '../server/modules/leave/leave-router.mjs';

const queries = [];
const auditEvents = [];
const permissionChecks = [];
const approvalDecisions = [];
const balanceRefreshes = [];
const employeeScopeQueries = [];
let connects = 0;
let storageUnavailable = false;
let transactionQueries = [];
const existingLeaveType = {
  id: 'leave-type-existing', code: 'ANNUAL', name: 'Annual Leave', paid: true,
  requires_approval: true, active: true,
};
const makeLeaveRequest = (id, employeeId, status) => ({
  id,
  employee_id: employeeId,
  leave_type_id: 'leave-type-annual',
  start_date: '2026-06-01',
  end_date: '2026-06-02',
  total_days: 2,
  status,
  reason: `Reason for ${id}`,
  comments: null,
  approver_id: null,
  approver_name: null,
  decided_at: null,
  updated_at: 'before-update',
});
const leaveRequests = new Map([
  ['request-approve', makeLeaveRequest('request-approve', 'employee-row-2', 'Submitted')],
  ['request-reject', makeLeaveRequest('request-reject', 'employee-row-2', 'Submitted')],
  ['request-cancel-own', makeLeaveRequest('request-cancel-own', 'employee-row-1', 'Submitted')],
  ['request-cancel-other', makeLeaveRequest('request-cancel-other', 'employee-row-2', 'Submitted')],
  ['request-cancel-admin', makeLeaveRequest('request-cancel-admin', 'employee-row-2', 'Approved')],
  ['request-out-of-scope', makeLeaveRequest('request-out-of-scope', 'employee-row-outside', 'Submitted')],
]);
const inScopeEmployeeIds = new Set(['employee-row-1', 'employee-row-2']);
const pool = {
  async query(sql, params = []) {
    queries.push({sql, params});
    if (sql.includes('select * from leave_types order by')) return {rows: [existingLeaveType]};
    if (sql.includes('from leave_balances lb')) return {rows: [{id: 'balance-visible', employee_name: 'Synthetic Employee'}]};
    throw new Error(`Unexpected leave query: ${sql}`);
  },
  async connect() {
    if (storageUnavailable) throw new Error("synthetic database detail");
    connects += 1;
    transactionQueries = [];
    return {
      async query(sql, params = []) {
        transactionQueries.push({sql, params});
        if (['begin', 'commit', 'rollback'].includes(sql)) return {rows: []};
        if (sql.includes('from users') && sql.includes('for share')) return {rows:[{employee_record_id:'employee-row-1',employee_id:'SYNTHETIC-1'}]};
        if (sql.includes('select id,employee_id,case when')) return {rows:[{id:'employee-row-1',employee_id:'SYNTHETIC-1',director_id:null}]};
        if (sql.includes('select distinct user_id from audit_logs')) return {rows:[{user_id:'independent-submitter'}]};
        if (sql.includes('for share of e')) return {rows:inScopeEmployeeIds.has(params[0])?[{id:params[0]}]:[]};
        if (sql.includes('select * from leave_types where id = $1')) {
          return {rows: params[0] === existingLeaveType.id ? [existingLeaveType] : []};
        }
        if (sql.includes('from leave_requests where id = $1 for update')) {
          assert.match(sql,/start_date::text,end_date::text/,'business DATE fields must remain canonical dates');
          const request = leaveRequests.get(params[0]);
          return {rows: request ? [{...request}] : []};
        }
        if (sql.includes('from employees e') && sql.includes('limit 1')) {
          employeeScopeQueries.push({sql, params: [...params]});
          assert.match(sql, /where e\.id = \$1 and e\.organization_id = \$2 and e\.legal_entity_id = \$3/,
            'decision scope lookup must bind the exact employee and organization/legal-entity pair');
          assert.deepEqual(params.slice(1), ['org-a', 'legal-a']);
          return {rows: inScopeEmployeeIds.has(params[0]) ? [{id: params[0]}] : []};
        }
        if (sql.includes('update leave_requests')) {
          const previous = leaveRequests.get(params[0]);
          assert(previous, `unexpected update for unknown leave request ${params[0]}`);
          const cancelledByOwner = sql.includes("set status = 'Cancelled'");
          const updated = {
            ...previous,
            status: cancelledByOwner ? 'Cancelled' : params[1],
            comments: cancelledByOwner ? params[1] : params[2],
            ...(cancelledByOwner ? {} : {approver_id: params[3], approver_name: params[4]}),
            decided_at: 'decision-time',
            updated_at: 'decision-time',
          };
          leaveRequests.set(params[0], updated);
          return {rows: [{...updated}]};
        }
        if (sql.includes('insert into leave_types')) {
          return {rows: [{
            id: params[0] || 'leave-type-created', code: params[1].toUpperCase(), name: params[2],
            paid: params[3], requires_approval: params[4], active: params[5],
          }]};
        }
        throw new Error(`Unexpected leave transaction query: ${sql}`);
      },
      release() {},
    };
  },
};
const requireDatabase = (_req, _res, next) => next();
const requireAuth = (req, _res, next) => {
  req.user = {
    activeRole: req.get('x-active-role') || 'Admin',
    employeeRecordId: req.get('x-employee-record-id') || 'employee-row-1',
    employeeId: req.get('x-employee-id') || 'E-1',
    username: 'synthetic-user',
  };
  req.organizationScope = {organizationId: 'org-a', legalEntityId: 'legal-a'};
  next();
};
const requirePermission = permission => (req, res, next) => {
  permissionChecks.push(permission);
  const allowed = permission === 'leave.self_service'
    || (permission === 'leave.admin' && ['Admin', 'HR'].includes(req.user.activeRole))
    || (permission === 'leave.approve' && ['Admin', 'HR', 'CountryDirector', 'TeamLead'].includes(req.user.activeRole));
  if (!allowed) return res.status(403).json({error: 'Insufficient permission privileges'});
  req.user.permissions = ['leave.self_service', 'leave.approve'];
  next();
};
const buildEmployeeScopeWhere = (req, params, alias = 'e') => {
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  const ownership = `${alias}.organization_id = $${params.length - 1} and ${alias}.legal_entity_id = $${params.length}`;
  if (req.user.activeRole !== 'Employee') return ownership;
  params.push(req.user.employeeRecordId, req.user.employeeId);
  return `(${ownership}) and (${alias}.id = $${params.length - 1} or ${alias}.employee_id = $${params.length})`;
};
const run = async (res, sql, params = []) => {
  try { res.json((await pool.query(sql, params)).rows); }
  catch { res.status(500).json({error: 'Database operation failed'}); }
};
const audit = async (client, req, event) => auditEvents.push({client, actor: req.user, event});
const leaveRouter = createLeaveRouter({
  pool,
  run,
  requireDatabase,
  requireAuth,
  requirePermission,
  buildEmployeeScopeWhere,
  audit,
  getBusinessLeaveDays: async () => 1,
  getLeaveYear: () => 2026,
  ensureLeaveBalanceForRequest: async () => ({leaveType: {paid: false}, balance: null}),
  refreshLeaveBalancesForEmployee: async (client, employeeId, year) => balanceRefreshes.push({client, employeeId, year}),
  upsertApprovalRecord: async () => {},
  decideApprovalRecord: async (client, req, decision) => approvalDecisions.push({client, actor: req.user, decision}),
});

const routeSignatures = leaveRouter.stack.filter(layer => layer.route).map(layer => {
  const method = Object.keys(layer.route.methods).find(key => layer.route.methods[key]);
  return `${method.toUpperCase()} ${layer.route.path}`;
});
assert.deepEqual(routeSignatures, [
  'GET /v1/leave-calendar/workers/:id/period', 'GET /v1/leave-calendar/requests/:id/history',
  'GET /leave/types', 'POST /leave/types',
  'GET /leave/policies', 'POST /leave/policies',
  'GET /holiday-calendars', 'POST /holiday-calendars',
  'GET /leave/balances', 'POST /leave/balances',
  'GET /leave/requests', 'POST /leave/requests',
  'PATCH /leave/requests/:id', 'PATCH /leave/requests/:id/cancel',
  'PATCH /leave/requests/:id/status',
], 'the leave module retains every legacy route plus the two calendar authority readers');

const app = express();
app.use(express.json());
app.use('/api', leaveRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
const request = (path, {
  method = 'GET', body, role = 'Admin', employeeRecordId = 'employee-row-1', employeeId = 'E-1',
} = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    'x-active-role': role,
    'x-employee-record-id': employeeRecordId,
    'x-employee-id': employeeId,
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

try {
  storageUnavailable = true;
  for (const path of ['/v1/leave-calendar/workers/worker-a/period?startsOn=2026-06-01&endsOn=2026-06-02',
    '/v1/leave-calendar/requests/request-a/history']) {
    const result = await request(path, {role: 'Employee'});
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /synthetic database detail/);
  }
  storageUnavailable = false;
  const types = await request('/leave/types', {role: 'Employee'});
  assert.equal(types.status, 200);
  assert.deepEqual(await types.json(), [existingLeaveType]);
  assert.equal(queries.at(-1).sql, 'select * from leave_types order by active desc, name');

  const employeeConnects = connects;
  const deniedCatalogWrite = await request('/leave/types', {
    method: 'POST',
    role: 'Employee',
    body: {code: 'SPECIAL', name: 'Special Leave'},
  });
  assert.equal(deniedCatalogWrite.status, 403);
  assert.equal(connects, employeeConnects, 'leave.admin denial must happen before opening a transaction');

  const createType = await request('/leave/types', {
    method: 'POST',
    body: {code: 'special', name: 'Special Leave', paid: false},
  });
  assert.equal(createType.status, 200);
  assert.deepEqual(await createType.json(), {
    id: 'leave-type-created', code: 'SPECIAL', name: 'Special Leave',
    paid: false, requires_approval: true, active: true,
  });
  assert.equal(auditEvents.at(-1).actor.username, 'synthetic-user');
  assert.equal(auditEvents.at(-1).event.action, 'Create Leave Type');
  assert.equal(auditEvents.at(-1).event.oldValue, null);
  assert.equal(auditEvents.at(-1).event.newValue.id, 'leave-type-created');
  assert.equal(auditEvents.at(-1).event.organizationScope, null,
    'shared leave catalog audit ownership must remain deployment-wide');
  assert(transactionQueries.some(({sql}) => sql === 'commit'));

  const updateType = await request('/leave/types', {
    method: 'POST',
    body: {id: existingLeaveType.id, code: 'annual', name: 'Annual Leave Updated'},
  });
  assert.equal(updateType.status, 200);
  assert.equal(auditEvents.at(-1).event.action, 'Update Leave Type');
  assert.deepEqual(auditEvents.at(-1).event.oldValue, existingLeaveType);
  assert.equal(auditEvents.at(-1).event.newValue.name, 'Annual Leave Updated');

  const employeeBalances = await request('/leave/balances', {role: 'Employee'});
  assert.equal(employeeBalances.status, 200);
  assert.deepEqual(await employeeBalances.json(), [{id: 'balance-visible', employee_name: 'Synthetic Employee'}]);
  assert.deepEqual(queries.at(-1).params, ['org-a', 'legal-a', 'employee-row-1', 'E-1']);
  assert.match(queries.at(-1).sql, /e\.organization_id = \$1 and e\.legal_entity_id = \$2/);
  assert.match(queries.at(-1).sql, /e\.id = \$3 or e\.employee_id = \$4/);

  const beforeSelfDenial = connects;
  const otherEmployeeRequest = await request('/leave/requests', {
    method: 'POST', role: 'Employee', body: {
      employee_id: 'E-2', leave_type_id: 'leave-type-annual',
      start_date: '2026-06-01', end_date: '2026-06-02', reason: 'Synthetic request',
    },
  });
  assert.equal(otherEmployeeRequest.status, 403);
  assert.equal(connects, beforeSelfDenial,
    'employees must remain blocked from submitting leave for another employee before database access');

  const beforeApprovalPermissionDenial = connects;
  const deniedApproval = await request('/leave/requests/request-approve/status', {
    method: 'PATCH', role: 'Employee', body: {status: 'Approved'},
  });
  assert.equal(deniedApproval.status, 403);
  assert.equal(connects, beforeApprovalPermissionDenial,
    'leave.approve denial must happen before opening a transaction');

  const outOfScopeBefore = {...leaveRequests.get('request-out-of-scope')};
  const outOfScopeAudits = auditEvents.length;
  const outOfScopeDecisions = approvalDecisions.length;
  const outOfScopeBalanceRefreshes = balanceRefreshes.length;
  const outOfScopeDecision = await request('/leave/requests/request-out-of-scope/status', {
    method: 'PATCH', body: {status: 'Approved'},
  });
  assert.equal(outOfScopeDecision.status, 403);
  assert.match((await outOfScopeDecision.json()).error, /outside active-role data scope/);
  assert.equal(leaveRequests.get('request-out-of-scope').status, outOfScopeBefore.status);
  assert.equal(auditEvents.length, outOfScopeAudits);
  assert.equal(approvalDecisions.length, outOfScopeDecisions);
  assert.equal(balanceRefreshes.length, outOfScopeBalanceRefreshes);
  assert.deepEqual(employeeScopeQueries.at(-1).params, ['employee-row-outside', 'org-a', 'legal-a']);
  assert(transactionQueries.some(({sql}) => sql === 'rollback'));
  assert(!transactionQueries.some(({sql}) => sql.includes('update leave_requests')));

  const submittedForApproval = {...leaveRequests.get('request-approve')};
  const approvalAuditIndex = auditEvents.length;
  const approvalDecisionIndex = approvalDecisions.length;
  const approve = await request('/leave/requests/request-approve/status', {
    method: 'PATCH', body: {status: 'Approved', comments: 'Approved for coverage'},
  });
  assert.equal(approve.status, 200);
  const approvedRow = await approve.json();
  assert.equal(approvedRow.status, 'Approved');
  assert.equal(approvedRow.comments, 'Approved for coverage');
  assert.equal(approvedRow.approver_id, 'employee-row-1');
  assert.equal(approvedRow.approver_name, 'synthetic-user');
  assert.deepEqual(auditEvents[approvalAuditIndex].event.oldValue, submittedForApproval);
  assert.deepEqual(auditEvents[approvalAuditIndex].event.newValue, approvedRow);
  assert.equal(auditEvents[approvalAuditIndex].event.action, 'Approved Leave');
  assert.equal(approvalDecisions[approvalDecisionIndex].decision.status, 'Approved');
  assert.equal(approvalDecisions[approvalDecisionIndex].decision.comments, 'Approved for coverage');
  assert(transactionQueries.some(({sql}) => sql === 'commit'));

  const auditCountBeforeInvalidTransition = auditEvents.length;
  const decisionsBeforeInvalidTransition = approvalDecisions.length;
  const invalidTransition = await request('/leave/requests/request-approve/status', {
    method: 'PATCH', body: {status: 'Rejected', comments: 'Attempted second decision'},
  });
  assert.equal(invalidTransition.status, 422);
  assert.match((await invalidTransition.json()).error, /Only submitted leave requests can be decided/);
  assert(transactionQueries.some(({sql}) => sql === 'rollback'));
  assert(!transactionQueries.some(({sql}) => sql === 'commit'));
  assert(!transactionQueries.some(({sql}) => sql.includes('update leave_requests')));
  assert.equal(auditEvents.length, auditCountBeforeInvalidTransition);
  assert.equal(approvalDecisions.length, decisionsBeforeInvalidTransition);

  const submittedForRejection = {...leaveRequests.get('request-reject')};
  const rejectionAuditIndex = auditEvents.length;
  const rejectionDecisionIndex = approvalDecisions.length;
  const reject = await request('/leave/requests/request-reject/status', {
    method: 'PATCH', body: {status: 'Rejected', comments: 'Insufficient coverage'},
  });
  assert.equal(reject.status, 200);
  const rejectedRow = await reject.json();
  assert.equal(rejectedRow.status, 'Rejected');
  assert.equal(rejectedRow.comments, 'Insufficient coverage');
  assert.deepEqual(auditEvents[rejectionAuditIndex].event.oldValue, submittedForRejection);
  assert.deepEqual(auditEvents[rejectionAuditIndex].event.newValue, rejectedRow);
  assert.equal(auditEvents[rejectionAuditIndex].event.action, 'Rejected Leave');
  assert.equal(auditEvents[rejectionAuditIndex].event.reason, 'Insufficient coverage');
  assert.equal(approvalDecisions[rejectionDecisionIndex].decision.status, 'Rejected');
  assert.equal(approvalDecisions[rejectionDecisionIndex].decision.comments, 'Insufficient coverage');
  assert(transactionQueries.some(({sql}) => sql === 'commit'));
  assert(!transactionQueries.some(({sql}) => sql === 'rollback'));

  const submittedForCancellation = {...leaveRequests.get('request-cancel-own')};
  const cancellationAuditIndex = auditEvents.length;
  const cancellationDecisionIndex = approvalDecisions.length;
  const cancellationBalanceIndex = balanceRefreshes.length;
  const cancelOwn = await request('/leave/requests/request-cancel-own/cancel', {
    method: 'PATCH', role: 'Employee', body: {comments: 'Plans changed'},
  });
  assert.equal(cancelOwn.status, 200);
  const cancelledRow = await cancelOwn.json();
  assert.equal(cancelledRow.status, 'Cancelled');
  assert.equal(cancelledRow.comments, 'Plans changed');
  assert.deepEqual(auditEvents[cancellationAuditIndex].event.oldValue, submittedForCancellation);
  assert.deepEqual(auditEvents[cancellationAuditIndex].event.newValue, cancelledRow);
  assert.equal(auditEvents[cancellationAuditIndex].event.action, 'Cancelled Leave');
  assert.equal(auditEvents[cancellationAuditIndex].event.reason, 'Plans changed');
  assert.equal(approvalDecisions[cancellationDecisionIndex].decision.status, 'Cancelled');
  assert(balanceRefreshes[cancellationBalanceIndex].client,
    'successful self-cancellation must refresh the employee balance within its transaction');
  assert.equal(balanceRefreshes[cancellationBalanceIndex].employeeId, 'employee-row-1');
  assert.equal(balanceRefreshes[cancellationBalanceIndex].year, 2026);
  assert(transactionQueries.some(({sql}) => sql === 'commit'));
  assert(!transactionQueries.some(({sql}) => sql === 'rollback'));

  const approvedForManagerCancellation = {...leaveRequests.get('request-cancel-admin')};
  const managerCancellationAuditIndex = auditEvents.length;
  const managerCancellationDecisionIndex = approvalDecisions.length;
  const managerCancel = await request('/leave/requests/request-cancel-admin/status', {
    method: 'PATCH', body: {status: 'Cancelled', comments: 'Cancelled after schedule change'},
  });
  assert.equal(managerCancel.status, 200);
  const managerCancelledRow = await managerCancel.json();
  assert.equal(managerCancelledRow.status, 'Cancelled');
  assert.equal(managerCancelledRow.comments, 'Cancelled after schedule change');
  assert.deepEqual(auditEvents[managerCancellationAuditIndex].event.oldValue, approvedForManagerCancellation);
  assert.deepEqual(auditEvents[managerCancellationAuditIndex].event.newValue, managerCancelledRow);
  assert.equal(auditEvents[managerCancellationAuditIndex].event.action, 'Cancelled Leave');
  assert.equal(auditEvents[managerCancellationAuditIndex].event.reason, 'Cancelled after schedule change');
  assert.equal(approvalDecisions[managerCancellationDecisionIndex].decision.status, 'Cancelled');
  assert.equal(approvalDecisions[managerCancellationDecisionIndex].decision.comments, 'Cancelled after schedule change');
  assert(transactionQueries.some(({sql}) => sql === 'commit'));
  assert(!transactionQueries.some(({sql}) => sql === 'rollback'));

  const otherRequestBeforeSelfDenial = {...leaveRequests.get('request-cancel-other')};
  const selfDenialAuditCount = auditEvents.length;
  const selfDenialDecisionCount = approvalDecisions.length;
  const selfDenialBalanceCount = balanceRefreshes.length;
  const selfDeniedCancel = await request('/leave/requests/request-cancel-other/cancel', {
    method: 'PATCH', role: 'Employee', body: {comments: 'Must not cancel a coworker request'},
  });
  assert.equal(selfDeniedCancel.status, 403);
  assert.match((await selfDeniedCancel.json()).error, /only their own/);
  assert(transactionQueries.some(({sql}) => sql === 'rollback'));
  assert(!transactionQueries.some(({sql}) => sql.includes('update leave_requests')));
  assert.equal(leaveRequests.get('request-cancel-other').status, otherRequestBeforeSelfDenial.status);
  assert.equal(auditEvents.length, selfDenialAuditCount);
  assert.equal(approvalDecisions.length, selfDenialDecisionCount);
  assert.equal(balanceRefreshes.length, selfDenialBalanceCount);

  assert.deepEqual(permissionChecks, [
    'leave.self_service', 'leave.self_service',
    'leave.self_service', 'leave.admin', 'leave.admin', 'leave.admin',
    'leave.self_service', 'leave.self_service', 'leave.approve', 'leave.approve',
    'leave.approve', 'leave.approve', 'leave.approve', 'leave.self_service',
    'leave.approve', 'leave.self_service',
  ]);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

console.log(JSON.stringify({
  status: 'passed', leaveRouter: true, routes: routeSignatures.length,
  transitions: true, refusals: true, auditAndScope: true,
}, null, 2));
