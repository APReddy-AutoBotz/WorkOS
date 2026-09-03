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
const { PERMISSION_DEFINITIONS, PROTECTED_PERMISSION_KEYS } = await import('../src/services/permissions.ts');
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
assert.ok(config.rolePermissions.some(item => item.roleName === 'Admin' && item.permissionKey === 'permissions.manage' && item.enabled), 'Admin must retain permission management by default');
assert.ok(PROTECTED_PERMISSION_KEYS.has('permissions.manage'), 'permission management must be protected');
assert.ok(PERMISSION_DEFINITIONS.some(permission => permission.key === 'allocations.manage'), 'allocation management permission must exist');

assert.equal(hasRouteRole(admin, ROUTE_ROLES.auditTrail), true, 'Admin should keep audit access through default permissions');

const employees = await employeeService.getAll();
const deliveryEmployee = employees.find(employee => employee.employeeId.startsWith('EMP-'));
assert.ok(deliveryEmployee, 'seed data should include an employee');
let employee = await authService.login(deliveryEmployee.employeeId, 'workos-test-only', 'Employee');
assert.ok(employee, 'employee login should work');
assert.equal(hasRouteRole(employee, ROUTE_ROLES.planningWorkspace), false, 'Employee should not see planning by default');
assert.equal(canManageAllocations(employee), false, 'Employee should not manage allocations by default');

await authService.login('admin-1', 'workos-test-only');
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
  () => adminService.grantUserPermission(user.id, 'audit.view'),
  /Protected permissions/,
  'protected permissions cannot be granted to non-Admin users',
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

console.log(JSON.stringify({
  status: 'passed',
  permissions: config.permissions.length,
  protectedPermissions: [...PROTECTED_PERMISSION_KEYS],
  extraGrant: 'allocations.view',
}, null, 2));
