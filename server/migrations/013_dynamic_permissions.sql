create table if not exists permission_definitions (
  permission_key text primary key,
  module text not null,
  label text not null,
  description text not null,
  protected boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_name text not null check (role_name in ('Employee', 'TeamLead', 'ProjectManager', 'CountryDirector', 'HR', 'Admin')),
  permission_key text not null references permission_definitions(permission_key) on delete restrict,
  enabled boolean not null default false,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (role_name, permission_key)
);

create table if not exists user_permission_grants (
  id text primary key default ('permission-grant-' || gen_random_uuid()::text),
  user_id uuid not null references users(id) on delete cascade,
  permission_key text not null references permission_definitions(permission_key) on delete restrict,
  granted_by uuid references users(id) on delete set null,
  active_role text,
  created_at timestamptz not null default now(),
  unique (user_id, permission_key)
);

create table if not exists permission_change_history (
  id text primary key default ('permission-change-' || gen_random_uuid()::text),
  change_type text not null,
  role_name text,
  user_id uuid references users(id) on delete set null,
  permission_key text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid references users(id) on delete set null,
  active_role text,
  created_at timestamptz not null default now()
);

insert into permission_definitions(permission_key, module, label, description, protected)
values
  ('dashboard.view', 'Home', 'Overview Dashboard', 'Open the executive operations dashboard.', false),
  ('employee_workspace.view', 'Workforce', 'My Workspace', 'Open the employee self-service workspace.', false),
  ('pm_workspace.view', 'Delivery', 'PM Workspace', 'Open the project manager workspace.', false),
  ('employees.view', 'Workforce', 'Employee Directory', 'View employee master data inside data scope.', false),
  ('employees.manage', 'Workforce', 'Manage Employees', 'Create and update employee master records.', false),
  ('employees.password_reset', 'Admin', 'Reset Employee Passwords', 'Reset user passwords for supported accounts.', false),
  ('projects.view', 'Delivery', 'Project Master', 'View projects inside data scope.', false),
  ('projects.manage', 'Delivery', 'Manage Projects', 'Create and update project master records.', false),
  ('projects.status_update', 'Delivery', 'Update Project Status', 'Move scoped projects between proposed, active, on-hold, and completed states.', false),
  ('clients.view', 'Delivery', 'Client Portfolio', 'View client portfolio records inside data scope.', false),
  ('clients.manage', 'Delivery', 'Manage Clients', 'Create and update client portfolio records.', false),
  ('allocations.view', 'Planning', 'Planning Workspace', 'View planning signals and allocation records inside data scope.', false),
  ('allocations.manage', 'Planning', 'Manage Allocations', 'Create, edit, and end allocations inside data scope.', false),
  ('timesheets.submit', 'Timesheets', 'Submit Timesheets', 'Create and submit own or scoped timesheets.', false),
  ('timesheets.approve', 'Timesheets', 'Approve Timesheets', 'Approve or reject submitted timesheets inside data scope.', false),
  ('reports.view_utilization', 'Reports', 'Utilization Reports', 'View planned, current, and forecast utilization reports.', false),
  ('reports.export', 'Reports', 'Reports Center', 'Download approved report exports.', false),
  ('reports.data_quality', 'Reports', 'Data Quality', 'View workforce data-quality issues inside data scope.', false),
  ('governance.brd_traceability', 'Governance', 'BRD Traceability', 'View implementation traceability evidence.', false),
  ('leave.self_service', 'Leave', 'Leave Self-Service', 'View balances and submit leave requests.', false),
  ('leave.team', 'Leave', 'Team Leave Calendar', 'View team leave and scoped leave calendars.', false),
  ('leave.approve', 'Leave', 'Approve Leave', 'Approve, reject, or cancel scoped leave requests.', false),
  ('leave.admin', 'Leave', 'Leave Administration', 'Manage leave policies, balances, and holiday calendars.', false),
  ('approvals.view', 'Approvals', 'Approvals Inbox', 'View approval inbox, history, delegations, and SLA signals.', false),
  ('notifications.view', 'Notifications', 'Notifications', 'View notifications, preferences, templates, and delivery monitoring where allowed.', false),
  ('notifications.manage', 'Notifications', 'Manage Notifications', 'Manage notification templates and delivery monitoring.', false),
  ('integrations.identity', 'Integrations', 'Identity Mapping', 'Manage identity and Entra-ready mappings.', false),
  ('integrations.teams', 'Integrations', 'Teams Mapping', 'Manage Teams-ready user links and deterministic action health.', false),
  ('integrations.teams_actions', 'Integrations', 'Teams Actions', 'Create and execute deterministic Teams approval action tokens.', false),
  ('imports.manage', 'Admin', 'Import / Export', 'Run controlled CSV imports and view import/export history.', false),
  ('audit.view', 'Admin', 'Audit Trail', 'View immutable platform audit logs.', true),
  ('settings.manage', 'Admin', 'Governance Settings', 'Manage business settings and catalogs.', false),
  ('permissions.manage', 'Admin', 'Permission Settings', 'Manage role permissions and user-specific permission grants.', true)
on conflict (permission_key) do update set
  module = excluded.module,
  label = excluded.label,
  description = excluded.description,
  protected = excluded.protected;

insert into role_permissions(role_name, permission_key, enabled)
select role_name,
  case when defaults.permission_key = '*' then pd.permission_key else defaults.permission_key end,
  enabled
from (
  values
    ('Admin', '*', true),
    ('HR', 'dashboard.view', true),
    ('HR', 'employees.view', true),
    ('HR', 'employees.manage', true),
    ('HR', 'employees.password_reset', true),
    ('HR', 'projects.view', true),
    ('HR', 'projects.manage', true),
    ('HR', 'projects.status_update', true),
    ('HR', 'clients.view', true),
    ('HR', 'clients.manage', true),
    ('HR', 'allocations.view', true),
    ('HR', 'allocations.manage', true),
    ('HR', 'timesheets.submit', true),
    ('HR', 'reports.view_utilization', true),
    ('HR', 'reports.export', true),
    ('HR', 'reports.data_quality', true),
    ('HR', 'governance.brd_traceability', true),
    ('HR', 'leave.self_service', true),
    ('HR', 'leave.team', true),
    ('HR', 'leave.approve', true),
    ('HR', 'leave.admin', true),
    ('HR', 'approvals.view', true),
    ('HR', 'notifications.view', true),
    ('HR', 'notifications.manage', true),
    ('HR', 'integrations.identity', true),
    ('HR', 'integrations.teams', true),
    ('HR', 'integrations.teams_actions', true),
    ('HR', 'settings.manage', true),
    ('CountryDirector', 'dashboard.view', true),
    ('CountryDirector', 'employees.view', true),
    ('CountryDirector', 'projects.view', true),
    ('CountryDirector', 'clients.view', true),
    ('CountryDirector', 'allocations.view', true),
    ('CountryDirector', 'allocations.manage', true),
    ('CountryDirector', 'timesheets.submit', true),
    ('CountryDirector', 'timesheets.approve', true),
    ('CountryDirector', 'reports.view_utilization', true),
    ('CountryDirector', 'reports.export', true),
    ('CountryDirector', 'reports.data_quality', true),
    ('CountryDirector', 'governance.brd_traceability', true),
    ('CountryDirector', 'leave.self_service', true),
    ('CountryDirector', 'leave.team', true),
    ('CountryDirector', 'leave.approve', true),
    ('CountryDirector', 'approvals.view', true),
    ('CountryDirector', 'notifications.view', true),
    ('CountryDirector', 'integrations.teams_actions', true),
    ('ProjectManager', 'pm_workspace.view', true),
    ('ProjectManager', 'employees.view', true),
    ('ProjectManager', 'projects.view', true),
    ('ProjectManager', 'projects.status_update', true),
    ('ProjectManager', 'allocations.view', true),
    ('ProjectManager', 'allocations.manage', true),
    ('ProjectManager', 'timesheets.submit', true),
    ('ProjectManager', 'timesheets.approve', true),
    ('ProjectManager', 'reports.view_utilization', true),
    ('ProjectManager', 'reports.export', true),
    ('ProjectManager', 'reports.data_quality', true),
    ('ProjectManager', 'governance.brd_traceability', true),
    ('ProjectManager', 'leave.self_service', true),
    ('ProjectManager', 'leave.team', true),
    ('ProjectManager', 'approvals.view', true),
    ('ProjectManager', 'notifications.view', true),
    ('ProjectManager', 'integrations.teams_actions', true),
    ('TeamLead', 'employees.view', true),
    ('TeamLead', 'allocations.view', true),
    ('TeamLead', 'timesheets.submit', true),
    ('TeamLead', 'timesheets.approve', true),
    ('TeamLead', 'reports.view_utilization', true),
    ('TeamLead', 'reports.export', true),
    ('TeamLead', 'reports.data_quality', true),
    ('TeamLead', 'governance.brd_traceability', true),
    ('TeamLead', 'leave.self_service', true),
    ('TeamLead', 'leave.team', true),
    ('TeamLead', 'leave.approve', true),
    ('TeamLead', 'approvals.view', true),
    ('TeamLead', 'notifications.view', true),
    ('TeamLead', 'integrations.teams_actions', true),
    ('Employee', 'employee_workspace.view', true),
    ('Employee', 'employees.view', true),
    ('Employee', 'timesheets.submit', true),
    ('Employee', 'leave.self_service', true),
    ('Employee', 'notifications.view', true)
) as defaults(role_name, permission_key, enabled)
join permission_definitions pd on defaults.permission_key = '*' or pd.permission_key = defaults.permission_key
on conflict (role_name, permission_key) do nothing;

insert into role_permissions(role_name, permission_key, enabled)
select r.role_name, pd.permission_key, false
from (values ('Admin'), ('HR'), ('CountryDirector'), ('ProjectManager'), ('TeamLead'), ('Employee')) as r(role_name)
cross join permission_definitions pd
on conflict (role_name, permission_key) do nothing;

create index if not exists idx_role_permissions_role_enabled on role_permissions(role_name, enabled);
create index if not exists idx_user_permission_grants_user on user_permission_grants(user_id);
create index if not exists idx_permission_change_history_created on permission_change_history(created_at desc);
