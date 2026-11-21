import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync('server/index.mjs', 'utf8');
const notificationRouter = readFileSync('server/modules/notifications/notification-router.mjs', 'utf8');
const leaveRouter = readFileSync('server/modules/leave/leave-router.mjs', 'utf8');

assert.match(server, /const buildEmployeeScopeWhere = \(req, params, employeeAlias = 'e', coverage\)/, 'employee data scope helper must exist');
assert.match(server, /const buildProjectScopeWhere = \(req, params, projectAlias = 'p'\)/, 'project data scope helper must exist');
assert.match(server, /const buildApprovalScopeWhere = \(req, params\)/, 'approval data scope helper must exist');

assert.match(
  server,
  /app\.get\('\/api\/reports\/workforce-command-center'[\s\S]*approvalScopeWhere = buildApprovalScopeWhere\(req, approvalParams\)[\s\S]*integrationEmployeeScopeWhere = buildEmployeeScopeWhere\(req, integrationParams, 'e'\)[\s\S]*notificationEmployeeScopeWhere = buildEmployeeScopeWhere\(req, notificationParams, 'e'\)[\s\S]*staffingProjectScopeWhere = buildProjectScopeWhere\(req, staffingParams, 'p'\)/,
  'command center must scope approvals, integration gaps, notification risk, and staffing risks',
);
assert.doesNotMatch(
  server,
  /from approval_records where status = \$1/,
  'command center must not use global approval counts',
);
assert.doesNotMatch(
  server,
  /select count\(\*\)::int as failed from notification_delivery_attempts where status = 'Failed'/,
  'command center must not use global notification-delivery counts',
);
assert.doesNotMatch(
  server,
  /from projects p\s+where p\.status in \('Active', 'Proposed'\)\s+and not exists/,
  'command center project staffing risks must include project data scope',
);

assert.match(
  notificationRouter,
  /router\.patch\('\/notifications\/:id\/read'[\s\S]*const where = buildEmployeeScopeWhere\(req, params, 'e'\)[\s\S]*where ne\.id = \$1 and e\.id = ne\.recipient_employee_id and \$\{where\}/,
  'notification read mutations must be employee-scope checked',
);
assert.match(
  notificationRouter,
  /router\.post\('\/notification-preferences'[\s\S]*const scopeWhere = buildEmployeeScopeWhere\(req, scopeParams, 'e'\)[\s\S]*Notification preference is outside active-role data scope/,
  'notification preference saves must be employee-scope checked',
);
assert.match(
  leaveRouter,
  /router\.post\('\/leave\/requests'[\s\S]*buildEmployeeScopeWhere\(req, scopeParams, 'e'\)[\s\S]*Leave request is outside active-role data scope/,
  'leave request submission must be employee-scope checked',
);
assert.match(
  server,
  /const isTeamsActionEntityInScope = async \(client, req, entityType, entityId\)[\s\S]*ApprovalRecord[\s\S]*LeaveRequest[\s\S]*Timesheet[\s\S]*PortalLink/,
  'Teams deterministic actions must validate entity data scope for supported targets',
);
assert.match(
  server,
  /app\.post\('\/api\/integrations\/teams-action-tokens'[\s\S]*isTeamsActionEntityInScope\(client, req, parsed\.data\.entity_type, parsed\.data\.entity_id\)[\s\S]*Teams action target is outside active-role data scope/,
  'Teams action-token creation must reject out-of-scope targets',
);
assert.match(
  server,
  /app\.post\('\/api\/integrations\/teams-action-tokens\/:token\/execute'[\s\S]*isTeamsActionEntityInScope\(client, req, actionToken\.entity_type, actionToken\.entity_id\)[\s\S]*Teams action target is outside active-role data scope/,
  'Teams action-token execution must reject out-of-scope targets',
);

console.log(JSON.stringify({
  status: 'passed',
  phase: 'Phase 7 production readiness hardening',
  commandCenterScoped: true,
  notificationMutationsScoped: true,
  leaveSubmissionScoped: true,
  teamsActionsScoped: true,
}, null, 2));
