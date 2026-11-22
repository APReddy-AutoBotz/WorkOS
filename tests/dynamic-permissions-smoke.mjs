import assert from 'node:assert/strict';

const store = new Map();

globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};
globalThis.sessionStorage = {
  getItem: (key) => (store.has(`session:${key}`) ? store.get(`session:${key}`) : null),
  setItem: (key, value) => store.set(`session:${key}`, String(value)),
  removeItem: (key) => store.delete(`session:${key}`),
  clear: () => {
    for (const key of [...store.keys()]) {
      if (key.startsWith('session:')) store.delete(key);
    }
  },
};

const { DataStorage } = await import('../src/services/storage.ts');
const { adminService, employeeService } = await import('../src/services/api.ts');
const { authService } = await import('../src/services/authService.ts');
const { ROUTE_ROLES, canManageAllocations, canManagePermissions, hasRouteRole } = await import('../src/services/accessControl.ts');
const { PERMISSION_DEFINITIONS, PROTECTED_PERMISSION_KEYS, hasPermission } = await import('../src/services/permissions.ts');
const { STORAGE_KEYS } = await import('../src/services/storage.ts');

DataStorage.resetDemoData();

await assert.rejects(
  () => adminService.getPermissionConfig(),
  /Permission settings require protected permission-management access/,
  'permission config must not be readable before protected permission-management authentication',
);

const admin = await authService.login('admin-1', 'workos-test-only');
assert.ok(admin, 'admin account should be available');
assert.equal(canManagePermissions(admin), true, 'Admin should manage permission settings by default');

const config = await adminService.getPermissionConfig();
assert.ok(config.permissions.length >= 20, 'permission registry should expose enterprise permission keys');
for (const key of ['commercial.service_units.policy','commercial.service_units.value','commercial.service_units.issue','commercial.service_cost.view','commercial.service_cost.record','commercial.fixed_fee_cost.record','commercial.fixed_fee_cost.view','commercial.service_margin.view','commercial.service_margin.record','commercial.service_periods.issue','commercial.service_periods.value','commercial.service_periods.decide','commercial.service_units.decide','commercial.service_units.capture','commercial.retainer_statements.prepare','commercial.retainer_statements.decide','commercial.retainer_eligibility.issue','commercial.rate_candidates.view','commercial.rate_candidates.manage','commercial.cost_candidates.view','commercial.cost_candidates.manage']) {
  assert.ok(PERMISSION_DEFINITIONS.some(permission => permission.key === key && permission.optIn), `${key} must be explicitly opt-in`);
  assert.ok(!config.rolePermissions.some(item => item.permissionKey === key && item.enabled), `${key} must not be granted by default`);
  assert.equal(hasPermission(admin,key),false,`${key} must not be inferred for Admin`);
}
assert.ok(config.rolePermissions.some(item => item.roleName === 'Admin' && item.permissionKey === 'permissions.manage' && item.enabled), 'Admin must retain permission management by default');
assert.ok(PROTECTED_PERMISSION_KEYS.has('permissions.manage'), 'permission management must be protected');
assert.ok(PERMISSION_DEFINITIONS.some(permission => permission.key === 'allocations.manage'), 'allocation management permission must exist');
assert.ok(PROTECTED_PERMISSION_KEYS.has('audit.deployment.view'), 'deployment-wide audit access must be protected');
assert.ok(PROTECTED_PERMISSION_KEYS.has('audit.organization.view'), 'organization audit access must be protected');
assert.ok(!config.rolePermissions.some(item => item.permissionKey === 'audit.deployment.view' && item.enabled),
  'deployment-wide audit access must default off for every role, including Admin');
assert.equal(hasPermission(admin, 'audit.deployment.view'), false, 'an Admin must not receive deployment audit access by default');
assert.equal(hasPermission(admin, 'audit.organization.view'), false, 'an Admin must not receive organization audit access by default');

assert.equal(hasRouteRole(admin, ROUTE_ROLES.auditTrail), true, 'Admin should keep audit access through default permissions');

const employees = await employeeService.getAll();
const deliveryEmployee = employees.find(employee => employee.employeeId.startsWith('EMP-'));
assert.ok(deliveryEmployee, 'seed data should include an employee');
let employee = await authService.login(deliveryEmployee.employeeId, 'workos-test-only', 'Employee');
assert.ok(employee, 'employee login should work');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.planningWorkspace), false, 'Employee should not see planning by default');
assert.equal(canManageAllocations(employee), false, 'Employee should not manage allocations by default');

const permissionManager = await authService.login('admin-1', 'workos-test-only');
assert.ok(permissionManager, 'the permission manager can log in for protected grant tests');
const user = (await adminService.getPermissionConfig()).users.find(item => item.employeeId === deliveryEmployee.employeeId);
assert.ok(user, 'permission users should include the selected employee');
await adminService.grantUserPermission(user.id, 'allocations.view');
await authService.logout();
employee = await authService.login(deliveryEmployee.employeeId, 'workos-test-only', 'Employee');
assert.ok(employee?.permissions?.includes('allocations.view'), 'new login should include user-specific extra grant');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.planningWorkspace), true, 'extra grant should expose the route without changing role');
assert.equal(canManageAllocations(employee), false, 'view grant must not imply mutation permission');

const roleSettings = DataStorage.get(STORAGE_KEYS.PERMISSION_ROLE_SETTINGS, config.rolePermissions);
DataStorage.set(STORAGE_KEYS.PERMISSION_ROLE_SETTINGS, roleSettings.map(setting =>
  setting.roleName === 'Employee' && setting.permissionKey === 'allocations.manage'
    ? { ...setting, enabled: true }
    : setting
));
employee = await authService.refreshSession();
assert.ok(employee?.permissions?.includes('allocations.manage'), 'session refresh should pick up changed role defaults without a full re-login');
assert.equal(canManageAllocations(employee), true, 'refreshed session should expose newly granted action permissions');

await authService.login('admin-1', 'workos-test-only');
await assert.rejects(
  () => adminService.grantUserPermission(user.id, 'audit.organization.view'),
  /specific organization/,
  'organization audit access cannot be granted through deployment-wide user exceptions',
);
await assert.rejects(
  () => adminService.setRolePermission('Admin', 'audit.organization.view', true),
  /specific organization/,
  'organization audit access cannot be enabled role-wide',
);
const designatedOrganizationAuditor = {...employee, permissions: ['audit.organization.view']};
assert.equal(hasRouteRole(designatedOrganizationAuditor, ROUTE_ROLES.auditTrail), true,
  'an explicitly designated non-Admin organization auditor may open the audit route');
await assert.rejects(
  () => adminService.grantUserPermission(user.id, 'audit.view'),
  /Protected permissions/,
  'protected permissions cannot be granted to non-Admin users',
);
await assert.rejects(
  () => adminService.grantUserPermission(permissionManager.id, 'audit.deployment.view'),
  /different active user with an assigned role/,
  'a permission manager cannot grant deployment-wide audit access to their own account',
);
const deploymentAuditGrant = await adminService.grantUserPermission(user.id, 'audit.deployment.view');
assert.equal(deploymentAuditGrant.permissionKey, 'audit.deployment.view',
  'an active non-Admin account can receive deployment-wide audit access through the existing per-user exception path');
await assert.rejects(
  () => adminService.setRolePermission('Admin', 'audit.deployment.view', true),
  /individual users/,
  'deployment-wide audit access cannot be enabled for an entire role',
);
await assert.rejects(
  () => adminService.setRolePermission('TeamLead', 'permissions.manage', true),
  /Protected permissions/,
  'protected permission toggles must stay locked for non-Admin roles',
);
await assert.rejects(
  () => adminService.setRolePermission('Admin', 'permissions.manage', false),
  /cannot be disabled/,
  'Admin permission management cannot be removed',
);
await authService.logout();
employee = await authService.login(deliveryEmployee.employeeId, 'workos-test-only', 'Employee');
assert.ok(employee?.permissions?.includes('audit.deployment.view'),
  'the selected active non-Admin user should receive the explicit deployment audit permission');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.auditTrail), true,
  'a specifically designated non-Admin user should be able to open the audit page');
await authService.login('admin-1', 'workos-test-only');
await adminService.deleteUserPermissionGrant(deploymentAuditGrant.id);
await authService.logout();
employee = await authService.login(deliveryEmployee.employeeId, 'workos-test-only', 'Employee');
assert.equal(hasPermission(employee, 'audit.deployment.view'), false,
  'revoking the explicit deployment audit grant must remove the permission on the next login');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.auditTrail), false,
  'revoking the explicit deployment audit grant must remove access to the audit page');

console.log(JSON.stringify({
  status: 'passed',
  permissions: config.permissions.length,
  protectedPermissions: [...PROTECTED_PERMISSION_KEYS],
  deploymentAuditDefault: 'denied',
  extraGrant: 'allocations.view',
}, null, 2));
