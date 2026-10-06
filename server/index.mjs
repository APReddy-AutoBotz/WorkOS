import 'dotenv/config';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import {fetchBoundedJson, getGovernedAppUrls, loadEntraOpenIdConfiguration} from './identity-discovery.mjs';
import {validateRuntimeEnvironment} from './environment.mjs';
import {registerHealthRoutes} from './health.mjs';
import { listAuthorizedOrganizationScopes, registerOrganizationSetupRoutes, resolveOrganizationScope } from './organization-setup.mjs';
import {createRequestContextMiddleware} from './api/request-context.mjs';
import {versionedApiErrorHandler, versionedApiResponseContract} from './api/v1/error-contract.mjs';
import {createIdentityAccessMiddleware} from './modules/identity-access/middleware.mjs';
import {createIdentityReadRouter} from './modules/identity-access/read-router.mjs';
import {recordAuditEvent} from './modules/audit/audit-record.mjs';
import { disableLinkedWorkerIdentity, initializeNewWorkerLifecycle, synchronizeWorkerReactivation } from './worker-lifecycle.mjs';
import { assertReportingPeriodAllows, REPORTING_PERIOD_OPERATIONS, ReportingPeriodError, sendReportingPeriodError } from './reporting-periods.mjs';

const { Pool } = pg;

const serverDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(serverDir, '..', 'dist');
const runtimeEnvironment = validateRuntimeEnvironment(process.env, {purpose: 'server'});
const isProduction = runtimeEnvironment.nodeEnv === 'production';
const sessionSecret = process.env.API_SESSION_SECRET || 'dev-only-change-me';

const app = express();
const port = runtimeEnvironment.port;
const pool = new Pool({
  connectionString: runtimeEnvironment.databaseUrl,
  ssl: runtimeEnvironment.pgSslMode === 'require' ? { rejectUnauthorized: false } : undefined,
});
const round1 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;

app.set('trust proxy', 1);
app.use(cors({
  origin: process.env.APP_URL || 'http://localhost:3000',
  credentials: true,
  exposedHeaders: ['X-Correlation-ID', 'X-Operation-ID'],
}));
app.use('/api', createRequestContextMiddleware());
app.use('/api/v1', versionedApiResponseContract);
app.use(express.json({ limit: '1mb' }));

const signToken = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

const {requireIdentity, requireAuth} = createIdentityAccessMiddleware({
  verifyToken,
  database: pool,
  resolveOrganizationScope,
  allowTestFallback: () => process.env.APP_MODE === 'test' && process.env.ALLOW_TEST_FALLBACK === 'true',
});

const loginAttempts = new Map();
const loginRateLimit = (req, res, next) => {
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = Number(process.env.LOGIN_RATE_LIMIT || 8);
  const username = String(req.body?.username || '').toLowerCase().trim();
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${username}`;
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (attempt.resetAt <= now) {
    attempt.count = 0;
    attempt.resetAt = now + windowMs;
  }
  attempt.count += 1;
  loginAttempts.set(key, attempt);
  if (attempt.count > maxAttempts) {
    res.setHeader('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)));
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }
  next();
};

const requireRoles = (...roles) => (req, res, next) => {
  const activeRole = req.user?.activeRole;
  if (!roles.includes(activeRole)) {
    res.status(403).json({ error: 'Insufficient role privileges' });
    return;
  }
  next();
};

const systemRoles = ['Admin', 'HR', 'CountryDirector', 'ProjectManager', 'TeamLead', 'Employee'];
const permissionDefinitions = [
  ['dashboard.view', 'Home', 'Overview Dashboard', false],
  ['employee_workspace.view', 'Workforce', 'My Workspace', false],
  ['pm_workspace.view', 'Delivery', 'PM Workspace', false],
  ['employees.view', 'Workforce', 'Employee Directory', false],
  ['employees.manage', 'Workforce', 'Manage Employees', false],
  ['employees.password_reset', 'Admin', 'Reset Employee Passwords', false],
  ['projects.view', 'Delivery', 'Project Master', false],
  ['projects.manage', 'Delivery', 'Manage Projects', false],
  ['projects.status_update', 'Delivery', 'Update Project Status', false],
  ['clients.view', 'Delivery', 'Client Portfolio', false],
  ['clients.manage', 'Delivery', 'Manage Clients', false],
  ['allocations.view', 'Planning', 'Planning Workspace', false],
  ['allocations.manage', 'Planning', 'Manage Allocations', false],
  ['timesheets.submit', 'Timesheets', 'Submit Timesheets', false],
  ['timesheets.approve', 'Timesheets', 'Approve Timesheets', false],
  ['reports.view_utilization', 'Reports', 'Utilization Reports', false],
  ['reports.export', 'Reports', 'Reports Center', false],
  ['reports.data_quality', 'Reports', 'Data Quality', false],
  ['governance.brd_traceability', 'Governance', 'BRD Traceability', false],
  ['leave.self_service', 'Leave', 'Leave Self-Service', false],
  ['leave.team', 'Leave', 'Team Leave Calendar', false],
  ['leave.approve', 'Leave', 'Approve Leave', false],
  ['leave.admin', 'Leave', 'Leave Administration', false],
  ['approvals.view', 'Approvals', 'Approvals Inbox', false],
  ['notifications.view', 'Notifications', 'Notifications', false],
  ['notifications.manage', 'Notifications', 'Manage Notifications', false],
  ['integrations.identity', 'Integrations', 'Identity Mapping', false],
  ['integrations.teams', 'Integrations', 'Teams Mapping', false],
  ['integrations.teams_actions', 'Integrations', 'Teams Actions', false],
  ['imports.manage', 'Admin', 'Import / Export', false],
  ['audit.view', 'Admin', 'Audit Trail', true],
  ['settings.manage', 'Admin', 'Governance Settings', false],
  ['permissions.manage', 'Admin', 'Permission Settings', true],
];
const protectedPermissionKeys = new Set(permissionDefinitions.filter(([, , , protectedCore]) => protectedCore).map(([key]) => key));
const defaultRolePermissions = {
  Admin: permissionDefinitions.map(([key]) => key),
  HR: ['dashboard.view', 'employees.view', 'employees.manage', 'employees.password_reset', 'projects.view', 'projects.manage', 'projects.status_update', 'clients.view', 'clients.manage', 'allocations.view', 'allocations.manage', 'timesheets.submit', 'reports.view_utilization', 'reports.export', 'reports.data_quality', 'governance.brd_traceability', 'leave.self_service', 'leave.team', 'leave.approve', 'leave.admin', 'approvals.view', 'notifications.view', 'notifications.manage', 'integrations.identity', 'integrations.teams', 'integrations.teams_actions', 'settings.manage'],
  CountryDirector: ['dashboard.view', 'employees.view', 'projects.view', 'clients.view', 'allocations.view', 'allocations.manage', 'timesheets.submit', 'timesheets.approve', 'reports.view_utilization', 'reports.export', 'reports.data_quality', 'governance.brd_traceability', 'leave.self_service', 'leave.team', 'leave.approve', 'approvals.view', 'notifications.view', 'integrations.teams_actions'],
  ProjectManager: ['pm_workspace.view', 'employees.view', 'projects.view', 'projects.status_update', 'allocations.view', 'allocations.manage', 'timesheets.submit', 'timesheets.approve', 'reports.view_utilization', 'reports.export', 'reports.data_quality', 'governance.brd_traceability', 'leave.self_service', 'leave.team', 'leave.approve', 'approvals.view', 'notifications.view', 'integrations.teams_actions'],
  TeamLead: ['employees.view', 'projects.view', 'allocations.view', 'timesheets.submit', 'timesheets.approve', 'reports.view_utilization', 'reports.export', 'reports.data_quality', 'governance.brd_traceability', 'leave.self_service', 'leave.team', 'leave.approve', 'approvals.view', 'notifications.view', 'integrations.teams_actions'],
  Employee: ['employee_workspace.view', 'employees.view', 'projects.view', 'timesheets.submit', 'leave.self_service', 'notifications.view'],
};

const permissionPayloadDefinitions = () => permissionDefinitions.map(([key, module, label, protectedCore]) => ({
  key,
  module,
  label,
  description: label,
  protected: Boolean(protectedCore),
}));

const getDefaultPermissionsForRole = (roleName) => defaultRolePermissions[roleName] || [];

const getEffectivePermissionsForUser = async (client, userId, activeRole) => {
  try {
    const roleResult = await client.query(
      'select permission_key, enabled from role_permissions where role_name = $1',
      [activeRole],
    );
    const rolePermissions = roleResult.rows.length > 0
      ? roleResult.rows.filter(row => row.enabled).map(row => row.permission_key)
      : getDefaultPermissionsForRole(activeRole);
    const grantResult = await client.query(
      'select permission_key from user_permission_grants where user_id = $1',
      [userId],
    );
    return [...new Set([...rolePermissions, ...grantResult.rows.map(row => row.permission_key)])];
  } catch (error) {
    if (error?.code === '42P01') return getDefaultPermissionsForRole(activeRole);
    throw error;
  }
};

const requirePermission = (permissionKey) => async (req, res, next) => {
  try {
    const permissions = await getEffectivePermissionsForUser(pool, req.user.sub, req.user.activeRole);
    if (!permissions.includes(permissionKey)) {
      res.status(403).json({ error: 'Insufficient permission privileges' });
      return;
    }
    req.user.permissions = permissions;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Permission check failed' });
  }
};

const verifyPassword = async (password, passwordHash) => {
  if (!passwordHash) return false;
  const [scheme, salt, key] = passwordHash.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex')));
  });
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(key, 'hex'));
};

const scryptHash = async (value) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(value, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex')));
  });
  return `scrypt$${salt}$${key}`;
};

const getPasswordMinLength = () => {
  const configured = Number(process.env.PASSWORD_MIN_LENGTH || 6);
  return Number.isFinite(configured) && configured >= 6 ? configured : 6;
};

const getSessionTtlMs = () => {
  const configuredHours = Number(process.env.API_SESSION_TTL_HOURS || 8);
  const safeHours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 8;
  return safeHours * 60 * 60 * 1000;
};

const getSessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  maxAge: getSessionTtlMs(),
});

const validateNewPassword = (password, identityValues = []) => {
  const minLength = getPasswordMinLength();
  if (typeof password !== 'string' || password.length < minLength) {
    return `Password must be at least ${minLength} characters.`;
  }
  const normalized = password.toLowerCase();
  const identityHit = identityValues
    .filter(Boolean)
    .map(value => String(value).toLowerCase())
    .some(value => value.length >= 3 && normalized.includes(value));
  if (identityHit) return 'Password must not contain the username, employee ID, or email.';
  return null;
};

const generateTemporaryPassword = () => {
  return `WOS-${crypto.randomBytes(9).toString('base64url')}`;
};

const isGlobalRole = (req) => ['Admin', 'HR'].includes(req.user?.activeRole);

const requireDatabase = (req, res, next) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'DATABASE_URL is not configured' });
    return;
  }
  next();
};

const run = async (res, query, params = []) => {
  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database operation failed' });
  }
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isStrictIsoDate = (dateValue) => {
  if (typeof dateValue !== 'string' || !isoDatePattern.test(dateValue)) return false;
  const [year, month, day] = dateValue.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};
const strictIsoDateSchema = z.string()
  .regex(isoDatePattern, 'Date must be in YYYY-MM-DD format')
  .refine(isStrictIsoDate, 'Date must be a valid calendar date');
const optionalImportIsoDateSchema = z.union([strictIsoDateSchema, z.literal('')]).optional();
const todayIso = () => new Date().toISOString().slice(0, 10);
const isAfterToday = (dateValue) => dateValue > todayIso();
const toIsoDate = (dateValue) => dateValue instanceof Date ? dateValue.toISOString().slice(0, 10) : String(dateValue).slice(0, 10);
const addDaysIso = (dateValue, days) => {
  const [year, month, day] = String(dateValue).slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const isWorkDateInsideWeek = (workDate, weekEnding) => workDate >= addDaysIso(weekEnding, -6) && workDate <= weekEnding;

const parsePercent = (value) => Number(value || 0);
const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
};
const splitPipeList = (value) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || '').split('|').map(item => item.trim()).filter(Boolean);
};
const normalizeImportKey = (value) => String(value || '').trim().toLowerCase();
const collectDuplicateImportRows = (rows, getKeys) => {
  const seen = new Map();
  const duplicateRowNumbers = new Set();
  const errors = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    for (const { field, value, label } of getKeys(row)) {
      const normalizedValue = normalizeImportKey(value);
      if (!normalizedValue) continue;
      const key = `${field}:${normalizedValue}`;
      if (seen.has(key)) {
        duplicateRowNumbers.add(rowNumber);
        errors.push({
          rowNumber,
          field,
          message: `Duplicate ${label || field} also appears on row ${seen.get(key)}.`,
        });
      } else {
        seen.set(key, rowNumber);
      }
    }
  });
  return { duplicateRowNumbers, errors };
};

const buildEmployeeScopeWhere = (req, params, employeeAlias = 'e') => {
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  const ownership = `${employeeAlias}.organization_id = $${params.length - 1} and ${employeeAlias}.legal_entity_id = $${params.length}`;
  if (req.user.activeRole === 'Employee') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and (${employeeAlias}.id = $${params.length - 1} or ${employeeAlias}.employee_id = $${params.length})`;
  }
  if (req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and (
      ${employeeAlias}.id = $${params.length - 1}
      or ${employeeAlias}.employee_id = $${params.length}
      or ${employeeAlias}.reporting_manager_id = $${params.length - 1}
      or ${employeeAlias}.reporting_manager_id = $${params.length}
      or ${employeeAlias}.id in (
        with recursive reporting_chain as (
          select id from employees where reporting_manager_id = $${params.length - 1} or reporting_manager_id = $${params.length}
          union all
          select e.id
          from employees e
          join reporting_chain chain on e.reporting_manager_id = chain.id
        )
        select id from reporting_chain
      )
    )`;
  }
  if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    return `(${ownership}) and (
      ${employeeAlias}.primary_country_director_id = $${params.length}
      or exists (
        select 1 from employee_country_director_map scope
        where scope.employee_id = ${employeeAlias}.id and scope.country_director_id = $${params.length}
      )
    )`;
  }
  if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and (
      ${employeeAlias}.id = $${params.length - 1}
      or ${employeeAlias}.employee_id = $${params.length}
      or exists (
        select 1
        from project_allocations scope_pa
        join projects scope_p on scope_p.id = scope_pa.project_id
        where scope_pa.employee_id = ${employeeAlias}.id
          and (scope_p.manager_id = $${params.length - 1} or scope_p.manager_id = $${params.length})
      )
    )`;
  }
  return ownership;
};

const buildProjectScopeWhere = (req, params, projectAlias = 'p') => {
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  const ownership = `${projectAlias}.organization_id = $${params.length - 1} and ${projectAlias}.legal_entity_id = $${params.length}`;
  if (isGlobalRole(req)) return ownership;
  if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and exists (
      select 1 from project_allocations scope_pa
      where scope_pa.project_id = ${projectAlias}.id
        and (scope_pa.employee_id = $${params.length - 1} or scope_pa.employee_id = $${params.length})
    )`;
  }
  if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `(${ownership}) and (${projectAlias}.manager_id = $${params.length - 1} or ${projectAlias}.manager_id = $${params.length})`;
  }
  if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    return `(${ownership}) and exists (
      select 1
      from project_allocations scope_pa
      join employees scope_e on scope_e.id = scope_pa.employee_id
      left join employee_country_director_map scope_ecdm on scope_ecdm.employee_id = scope_e.id
      where scope_pa.project_id = ${projectAlias}.id
        and (scope_e.primary_country_director_id = $${params.length} or scope_ecdm.country_director_id = $${params.length})
    )`;
  }
  return 'false';
};

const getSetting = async (key, fallback) => {
  const result = await pool.query('select value from system_settings where key = $1', [key]);
  const raw = result.rows[0]?.value;
  return raw === undefined ? fallback : raw;
};

const audit = recordAuditEvent;

const workerExitDependencies = async (client, employeeId, { organizationId, legalEntityId }) => client.query(`select kind,id from (
  select 'active_assignment' kind,id from project_allocations where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 and status='Active'
  union all select 'pending_approval',id::text from approval_records where subject_employee_id=$1 and status='Pending'
  union all select 'open_work',id::text from timesheets where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Draft','Submitted')
  union all select 'project_owner',id from projects where manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Proposed','Active','On Hold')
  union all select 'direct_report',id from employees where reporting_manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status<>'Exited'
) d limit 101`, [employeeId, organizationId, legalEntityId]);

const isoDateOnly = value => typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

const assertWorkerMayExit = async (client, employee, scope, effectiveFrom) => {
  if (!employee) return effectiveFrom;
  if (employee.status === 'Exited') {
    const terminal = (await client.query(`select effective_from from worker_history where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 and status='Exited' order by effective_from desc limit 1 for update`,
      [employee.id, scope.organizationId, scope.legalEntityId])).rows[0];
    if (!terminal) {
      const error = new Error('Worker exit conflicts with existing history');
      error.code = 'WORKER_VERSION_CONFLICT';
      throw error;
    }
    const authoritativeExitDate = isoDateOnly(terminal.effective_from);
    if (effectiveFrom != null && isoDateOnly(effectiveFrom) !== authoritativeExitDate) {
      const error = new Error('Worker exit conflicts with existing history');
      error.code = 'WORKER_VERSION_CONFLICT';
      throw error;
    }
    return authoritativeExitDate;
  }
  const dependencies = await workerExitDependencies(client, employee.id, scope);
  if (dependencies.rowCount) {
    const error = new Error('Worker has active dependencies');
    error.code = 'WORKER_DEPENDENCY_CONFLICT';
    error.dependencies = dependencies.rows.slice(0, 100);
    error.truncated = dependencies.rows.length > 100;
    throw error;
  }
  const latest = (await client.query(`select effective_from from worker_history where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 order by effective_from desc limit 1`,
    [employee.id, scope.organizationId, scope.legalEntityId])).rows[0];
  if (latest && effectiveFrom <= isoDateOnly(latest.effective_from)) {
    const error = new Error('Worker exit conflicts with existing history');
    error.code = 'WORKER_VERSION_CONFLICT';
    throw error;
  }
  return effectiveFrom;
};

const synchronizeWorkerExit = async (client, req, employee, effectiveFrom, reason) => {
  const scope = req.organizationScope;
  const profile = (await client.query(`select * from worker_profiles where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 for update`,
    [employee.id, scope.organizationId, scope.legalEntityId])).rows[0];
  if (!profile) throw new Error('Worker profile synchronization failed');
  if (profile.lifecycle_status !== 'Exited') {
    const latest = (await client.query(`select effective_from from worker_history where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 order by effective_from desc limit 1 for update`,
      [employee.id, scope.organizationId, scope.legalEntityId])).rows[0];
    if (latest && effectiveFrom <= isoDateOnly(latest.effective_from)) {
      const error = new Error('Worker exit conflicts with existing history');
      error.code = 'WORKER_VERSION_CONFLICT';
      throw error;
    }
    await client.query(`update worker_history set effective_to=$4::date-1 where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 and effective_to is null`,
      [employee.id, scope.organizationId, scope.legalEntityId, effectiveFrom]);
    const snapshot = { status: 'Exited', reason, source: 'canonical-employee-exit' };
    await client.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot,actor_id) values($1,$2,$3,$4,'Exited',$5,$6)`,
      [employee.id, scope.organizationId, scope.legalEntityId, effectiveFrom, JSON.stringify(snapshot), req.user.sub]);
    await client.query(`update worker_profiles set lifecycle_status='Exited',effective_from=$4,updated_at=now() where employee_id=$1 and organization_id=$2 and legal_entity_id=$3`,
      [employee.id, scope.organizationId, scope.legalEntityId, effectiveFrom]);
  }
  const updated = (await client.query(`update employees set status='Exited',exit_date=coalesce(exit_date,$4),updated_at=now() where id=$1 and organization_id=$2 and legal_entity_id=$3 returning *`,
    [employee.id, scope.organizationId, scope.legalEntityId, effectiveFrom])).rows[0];
  if (!updated) throw new Error('Worker employee synchronization failed');
  await disableLinkedWorkerIdentity(client, { employeeId: employee.id, organizationId: scope.organizationId, legalEntityId: scope.legalEntityId });
  return updated;
};

const upsertApprovalRecord = async (client, req, {
  entityType,
  entityId,
  subjectEmployeeId,
  requesterId,
  requesterName,
  approverRole = null,
  status = 'Pending',
  comments = null,
  source = 'Web',
  dueAt = null,
}) => {
  const result = await client.query(`
    insert into approval_records (
      entity_type, entity_id, subject_employee_id, requester_id, requester_name,
      approver_role, active_role, status, comments, source, due_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (entity_type, entity_id) do update set
      subject_employee_id = excluded.subject_employee_id,
      requester_id = excluded.requester_id,
      requester_name = excluded.requester_name,
      approver_role = coalesce(excluded.approver_role, approval_records.approver_role),
      active_role = excluded.active_role,
      status = excluded.status,
      comments = excluded.comments,
      source = excluded.source,
      due_at = excluded.due_at,
      updated_at = now()
    returning *
  `, [
    entityType,
    entityId,
    subjectEmployeeId,
    requesterId,
    requesterName,
    approverRole,
    req.user?.activeRole || null,
    status,
    comments,
    source,
    dueAt,
  ]);
  if (status === 'Pending') {
    await sendNotification(client, req, {
      recipientEmployeeId: subjectEmployeeId,
      eventType: 'ApprovalRequested',
      title: `${entityType} approval requested`,
      body: `${requesterName || 'A user'} submitted ${entityType} for approval.`,
      entityType,
      entityId,
      severity: 'Info',
    });
  }
  return result.rows[0];
};

const decideApprovalRecord = async (client, req, { entityType, entityId, status, comments = null }) => {
  const result = await client.query(`
    update approval_records
    set status = $3,
      comments = $4,
      approver_id = $5,
      approver_name = $6,
      approver_role = $7,
      active_role = $7,
      decided_at = now(),
      updated_at = now()
    where entity_type = $1 and entity_id = $2
    returning *
  `, [
    entityType,
    entityId,
    status,
    comments,
    req.user?.employeeRecordId || req.user?.sub || null,
    req.user?.username || 'system',
    req.user?.activeRole || 'system',
  ]);
  const next = result.rows[0] || null;
  if (next) {
    await sendNotification(client, req, {
      recipientEmployeeId: next.subject_employee_id,
      eventType: 'ApprovalDecided',
      title: `${entityType} approval ${status.toLowerCase()}`,
      body: `${entityType} ${entityId} was ${status.toLowerCase()}.`,
      entityType,
      entityId,
      severity: status === 'Rejected' ? 'Warning' : 'Info',
    });
  }
  return next;
};

const recordAllocationChangeApproval = async (client, req, { action, allocation, previous = null, employee, project }) => {
  const entityId = `allocation-change-${crypto.randomUUID()}`;
  const result = await client.query(`
    insert into approval_records (
      entity_type, entity_id, subject_employee_id, requester_id, requester_name,
      approver_id, approver_name, approver_role, active_role, status, comments, source, due_at, decided_at
    )
    values ($1,$2,$3,$4,$5,$4,$5,$6,$6,'Approved',$7,'Web',now(),now())
    returning *
  `, [
    'AllocationChange',
    entityId,
    allocation.employee_id,
    req.user?.employeeRecordId || req.user?.sub || null,
    req.user?.username || 'system',
    req.user?.activeRole || 'system',
    JSON.stringify({
      action,
      allocationId: allocation.id,
      employeeId: employee?.employee_id || allocation.employee_id,
      projectCode: project?.project_code || allocation.project_id,
      previous,
      allocation,
    }),
  ]);
  await sendNotification(client, req, {
    recipientEmployeeId: allocation.employee_id,
    eventType: 'AllocationChangeApproved',
    title: `Allocation ${action.toLowerCase()} recorded`,
    body: `${project?.project_code || 'Project'} allocation change was recorded by ${req.user?.username || 'system'}.`,
    entityType: 'AllocationChange',
    entityId,
    severity: 'Info',
  });
  return result.rows[0];
};

const graphConfig = (purpose = 'graph') => ({
  tenantId: process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || process.env.TEAMS_TENANT_ID,
  clientId: process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID,
  clientSecret: process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET,
  purpose,
});

const graphTokenCache = new Map();
const getGraphAccessToken = async (purpose = 'graph') => {
  const { tenantId, clientId, clientSecret } = graphConfig(purpose);
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(`${purpose} Graph credentials are not configured`);
  }
  const cacheKey = `${tenantId}:${clientId}:${purpose}`;
  const cached = graphTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.accessToken;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/.default',
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Graph token request failed with ${response.status}`);
  }
  const expiresInSeconds = Number(payload.expires_in || 3600);
  graphTokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresInSeconds - 60, 60) * 1000,
  });
  return payload.access_token;
};

const renderNotificationText = (template, fallback, context) => {
  const raw = template || fallback || '';
  return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

const buildAppUrl = (path = '/') => {
  const base = process.env.APP_URL || 'http://localhost:3000';
  try {
    return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
  } catch {
    return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  }
};

const buildTeamsActionUrl = (token) => buildAppUrl(`/teams/actions/${encodeURIComponent(token)}`);

const credentialChecks = () => {
  const graphTenant = Boolean(process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || process.env.TEAMS_TENANT_ID);
  const graphClient = Boolean(process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID);
  const graphSecret = Boolean(process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET);
  return [
    { area: 'Core', key: 'APP_URL', label: 'Application URL', configured: Boolean(process.env.APP_URL) },
    { area: 'Core', key: 'API_SESSION_SECRET', label: 'API session secret', configured: Boolean(process.env.API_SESSION_SECRET && process.env.API_SESSION_SECRET !== 'dev-only-change-me'), secret: true },
    { area: 'Identity', key: 'IDENTITY_PROVIDER', label: 'Identity provider set to Entra', configured: (process.env.IDENTITY_PROVIDER || 'local') === 'entra' },
    { area: 'Identity', key: 'ENTRA_TENANT_ID', label: 'Entra tenant ID', configured: Boolean(getEntraTenantId()) },
    { area: 'Identity', key: 'ENTRA_CLIENT_ID', label: 'Entra client ID', configured: Boolean(getEntraClientId()) },
    { area: 'Identity', key: 'ENTRA_CLIENT_SECRET', label: 'Entra client secret', configured: Boolean(getEntraClientSecret()), secret: true },
    { area: 'Identity', key: 'ENTRA_REDIRECT_URI', label: 'Registered Entra redirect URI or APP_URL fallback', configured: Boolean(process.env.ENTRA_REDIRECT_URI || process.env.APP_URL) },
    { area: 'Email', key: 'EMAIL_PROVIDER', label: 'Email provider set to Graph', configured: (process.env.EMAIL_PROVIDER || 'mock') === 'graph' },
    { area: 'Email', key: 'GRAPH_TENANT_ID', label: 'Graph tenant ID', configured: graphTenant },
    { area: 'Email', key: 'GRAPH_CLIENT_ID', label: 'Graph client ID', configured: graphClient },
    { area: 'Email', key: 'GRAPH_CLIENT_SECRET', label: 'Graph client secret', configured: graphSecret, secret: true },
    { area: 'Email', key: 'GRAPH_SENDER_UPN', label: 'Graph sender mailbox UPN', configured: Boolean(process.env.GRAPH_SENDER_UPN || process.env.SMTP_FROM) },
    { area: 'Teams', key: 'TEAMS_PROVIDER', label: 'Teams provider set to Graph', configured: (process.env.TEAMS_PROVIDER || 'mock') === 'graph' },
    { area: 'Teams', key: 'TEAMS_TENANT_ID', label: 'Teams tenant ID', configured: Boolean(process.env.TEAMS_TENANT_ID || process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID) },
    { area: 'Teams', key: 'TEAMS_APP_ID', label: 'Teams app ID', configured: Boolean(process.env.TEAMS_APP_ID) },
    { area: 'Teams', key: 'TEAMS_ACTIVITY_TYPE', label: 'Teams activity type', configured: Boolean(process.env.TEAMS_ACTIVITY_TYPE) },
  ];
};

const decodeBase64UrlJson = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

const getEntraTenantId = () => process.env.ENTRA_TENANT_ID || process.env.GRAPH_TENANT_ID || process.env.TEAMS_TENANT_ID;
const getEntraClientId = () => process.env.ENTRA_CLIENT_ID || process.env.GRAPH_CLIENT_ID;
const getEntraClientSecret = () => process.env.ENTRA_CLIENT_SECRET || process.env.GRAPH_CLIENT_SECRET;
const getEntraRedirectUri = () => process.env.NODE_ENV === 'production'
  ? getGovernedAppUrls().redirectUri
  : process.env.ENTRA_REDIRECT_URI || buildAppUrl('/api/auth/entra/callback');
const isEntraLoginConfigured = () => Boolean(getEntraTenantId() && getEntraClientId() && getEntraClientSecret());

const signEntraState = (payload) => signToken({ ...payload, kind: 'entra_auth_state', exp: Date.now() + 10 * 60 * 1000 });

const verifyEntraState = (state) => {
  const payload = verifyToken(state);
  if (!payload || payload.kind !== 'entra_auth_state') return null;
  return payload;
};

const entraStateCookieName = 'workos_entra_state';
const hashEntraState = (value) => crypto.createHash('sha256').update(value).digest('hex');
const entraStateCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/entra/callback',
  maxAge: 10 * 60 * 1000,
};
const entraStateCookieClearOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/entra/callback',
};

const getMicrosoftOpenIdConfiguration = async () => {
  return loadEntraOpenIdConfiguration();
};

const exchangeEntraCode = async (code) => {
  const config = await getMicrosoftOpenIdConfiguration();
  const body = new URLSearchParams({
    client_id: getEntraClientId(),
    client_secret: getEntraClientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: getEntraRedirectUri(),
    scope: 'openid profile email',
  });
  const payload = await fetchBoundedJson(config.token_endpoint, 'Microsoft token endpoint', {fetchOptions: {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body,
  }});
  if (!payload.id_token) {
    throw new Error(payload.error_description || payload.error || 'Microsoft token exchange failed');
  }
  return { config, tokenPayload: payload };
};

const verifyEntraIdToken = async (idToken, { nonce, config }) => {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid Entra ID token format');
  const header = decodeBase64UrlJson(parts[0]);
  const claims = decodeBase64UrlJson(parts[1]);
  if (!header.kid) throw new Error('Entra ID token is missing key id');
  const keysPayload = await fetchBoundedJson(config.jwks_uri, 'Microsoft JWKS endpoint');
  const jwk = keysPayload.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('Entra signing key was not found');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const valid = verifier.verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), parts[2], 'base64url');
  if (!valid) throw new Error('Entra ID token signature is invalid');
  if (claims.aud !== getEntraClientId()) throw new Error('Entra ID token audience is invalid');
  if (claims.iss !== config.issuer) throw new Error('Entra ID token issuer is invalid');
  if (claims.nonce !== nonce) throw new Error('Entra ID token nonce is invalid');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('Entra ID token is expired');
  const expectedTenant = getEntraTenantId();
  if (expectedTenant && !['common', 'organizations'].includes(expectedTenant) && claims.tid !== expectedTenant) {
    throw new Error('Entra ID token tenant is invalid');
  }
  return claims;
};

const userAuthSelect = `
  select u.id, u.username, u.employee_id, u.email, u.must_change_password, u.status,
    e.id as employee_record_id, e.name, cd.id as country_director_id,
    coalesce(json_agg(distinct r.name) filter (where r.name is not null), '[]') as roles
  from users u
  left join employees e on e.id = u.employee_record_id
  left join country_directors cd on cd.id = e.primary_country_director_id
    and (
      lower(e.designation) in ('country director', 'regional lead', 'director')
      or lower(e.department) = 'regional leadership'
    )
  left join user_roles ur on ur.user_id = u.id
  left join roles r on r.id = ur.role_id
`;

const fetchUserAuthRowByWhere = async (clientOrPool, whereSql, params) => {
  const result = await clientOrPool.query(`
    ${userAuthSelect}
    ${whereSql}
    group by u.id, e.id, e.name, cd.id
    limit 1
  `, params);
  return result.rows[0] || null;
};

const mappedRolesFromEntraGroups = async (clientOrPool, groups = []) => {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  const result = await clientOrPool.query(`
    select distinct role_name
    from entra_group_role_mappings
    where active = true and group_id = any($1::text[])
  `, [groups.map(String)]);
  return result.rows.map(row => row.role_name);
};

const buildLoginResponse = async (clientOrPool, res, user, requestedRole = null, extraRoles = []) => {
  if (!user || user.status !== 'Active') throw new Error('User is not active');
  const roles = [...new Set([...(user.roles || []), ...extraRoles])].filter(Boolean);
  if (roles.length === 0) throw new Error('No active role is assigned to this user');
  const activeRole = requestedRole && roles.includes(requestedRole) ? requestedRole : roles[0];
  const permissions = await getEffectivePermissionsForUser(clientOrPool, user.id, activeRole);
  const sessionExpiresAt = Date.now() + getSessionTtlMs();
  const token = signToken({
    sub: user.id,
    username: user.username,
    employeeId: user.employee_id,
    employeeRecordId: user.employee_record_id,
    countryDirectorId: user.country_director_id,
    roles,
    activeRole,
    permissions,
    permissionRole: activeRole,
    exp: sessionExpiresAt,
  });
  res.cookie?.('workos_session', token, getSessionCookieOptions());
  return {
    id: user.id,
    username: user.username,
    employeeId: user.employee_id,
    employeeRecordId: user.employee_record_id,
    countryDirectorId: user.country_director_id,
    email: user.email,
    name: user.name,
    roles,
    activeRole,
    permissions,
    permissionRole: activeRole,
    mustChangePassword: Boolean(user.must_change_password),
    sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
    token,
  };
};

const recordNotificationAttempt = async (client, {
  notificationId,
  channel,
  provider,
  status,
  responseMetadata = {},
}) => {
  const result = await client.query(`
    insert into notification_delivery_attempts (notification_id, channel, provider, status, response_metadata)
    values ($1,$2,$3,$4,$5)
    returning *
  `, [notificationId, channel, provider, status, JSON.stringify(responseMetadata)]);
  return result.rows[0];
};

const deliverGraphEmail = async ({ recipient, subject, body }) => {
  const sender = process.env.GRAPH_SENDER_UPN || process.env.SMTP_FROM;
  if (!sender) throw new Error('GRAPH_SENDER_UPN is not configured');
  if (!recipient?.email) throw new Error('Recipient email is not available');
  const token = await getGraphAccessToken('email');
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: recipient.email } }],
      },
      saveToSentItems: false,
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `Graph sendMail failed with ${response.status}`);
  }
  return { statusCode: response.status, sender, recipient: recipient.email };
};

const deliverGraphTeamsActivity = async ({ recipient, subject, body, actionUrl }) => {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) throw new Error('TEAMS_APP_ID is not configured');
  const teamsUser = recipient?.teams_user_id || recipient?.teams_upn || recipient?.email;
  if (!teamsUser) throw new Error('Recipient Teams user ID or UPN is not available');
  const token = await getGraphAccessToken('teams');
  const topic = {
    source: 'text',
    value: subject,
  };
  const webUrl = actionUrl || process.env.APP_URL || '';
  topic.webUrl = String(webUrl).startsWith('https://teams.microsoft.com/l/')
    ? webUrl
    : `https://teams.microsoft.com/l/app/${appId}`;
  const requestBody = {
    topic,
    activityType: process.env.TEAMS_ACTIVITY_TYPE || 'systemDefault',
    previewText: { content: body },
    templateParameters: [
      { name: 'actor', value: 'Configured product' },
      { name: 'reason', value: subject },
    ],
    teamsAppId: appId,
  };
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(teamsUser)}/teamwork/sendActivityNotification`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `Graph Teams activity failed with ${response.status}`);
  }
  return { statusCode: response.status, teamsUser, activityType: requestBody.activityType };
};

const notificationProviderForChannel = (channel) => {
  if (channel === 'Email') return process.env.EMAIL_PROVIDER || 'mock';
  if (channel === 'Teams') return process.env.TEAMS_PROVIDER || 'mock';
  return 'internal';
};

const fetchNotificationRecipient = async (client, recipientEmployeeId) => {
  if (!recipientEmployeeId) return null;
  const result = await client.query(`
    select e.*, tul.teams_user_id as linked_teams_user_id, tul.teams_upn, tul.teams_tenant_id
    from employees e
    left join teams_user_links tul on tul.employee_id = e.id and tul.status = 'Linked'
    where e.id = $1 or e.employee_id = $1
    limit 1
  `, [recipientEmployeeId]);
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    teams_user_id: row.linked_teams_user_id || row.teams_user_id,
  };
};

const fetchNotificationTemplate = async (client, eventType, channel) => {
  const result = await client.query(`
    select *
    from notification_templates
    where event_type = $1 and channel = $2 and active = true
    limit 1
  `, [eventType, channel]);
  return result.rows[0] || null;
};

const sendNotification = async (client, req, {
  recipientEmployeeId = null,
  eventType,
  title,
  body,
  entityType = null,
  entityId = null,
  severity = 'Info',
  channel = 'InApp',
  channels = null,
  provider = null,
  actionUrl = null,
}) => {
  const eventResult = await client.query(`
    insert into notification_events (recipient_employee_id, event_type, title, body, entity_type, entity_id, severity)
    values ($1,$2,$3,$4,$5,$6,$7)
    returning *
  `, [recipientEmployeeId, eventType, title, body, entityType, entityId, severity]);
  const event = eventResult.rows[0];

  const recipient = await fetchNotificationRecipient(client, recipientEmployeeId);
  const preference = recipient?.id
    ? (await client.query('select * from notification_preferences where employee_id = $1 and event_type = $2', [recipient.id, eventType])).rows[0]
    : null;
  const channelSet = new Set(Array.isArray(channels) && channels.length > 0 ? channels : [channel || 'InApp']);
  if (preference?.in_app) channelSet.add('InApp');
  if (preference?.email) channelSet.add('Email');
  if (preference?.teams) channelSet.add('Teams');
  const deliveryResults = [];

  for (const deliveryChannel of channelSet) {
    const template = await fetchNotificationTemplate(client, eventType, deliveryChannel);
    const context = {
      title,
      body,
      eventType,
      entityType: entityType || '',
      entityId: entityId || '',
      actionUrl: actionUrl || process.env.APP_URL || '',
      employeeName: recipient?.name || '',
    };
    const subject = renderNotificationText(template?.subject, title, context);
    const messageBody = renderNotificationText(template?.body, body, context);
    const selectedProvider = provider || notificationProviderForChannel(deliveryChannel);
    try {
      let metadata = { mode: selectedProvider, deterministic: true };
      if (deliveryChannel === 'Email' && selectedProvider === 'graph') {
        metadata = { ...metadata, ...(await deliverGraphEmail({ recipient, subject, body: messageBody })) };
      } else if (deliveryChannel === 'Email' && selectedProvider !== 'mock') {
        throw new Error(`Email provider ${selectedProvider} is not supported by this build`);
      } else if (deliveryChannel === 'Teams' && selectedProvider === 'graph') {
        metadata = { ...metadata, ...(await deliverGraphTeamsActivity({ recipient, subject, body: messageBody, actionUrl })) };
      } else if (deliveryChannel === 'Teams' && selectedProvider !== 'mock') {
        throw new Error(`Teams provider ${selectedProvider} is not supported by this build`);
      }
      await recordNotificationAttempt(client, {
        notificationId: event.id,
        channel: deliveryChannel,
        provider: selectedProvider,
        status: 'Delivered',
        responseMetadata: metadata,
      });
      deliveryResults.push({ channel: deliveryChannel, provider: selectedProvider, status: 'Delivered' });
      if (deliveryChannel === 'Email' || deliveryChannel === 'Teams') {
        await logIntegrationEvent(client, {
          provider: deliveryChannel === 'Teams' ? 'teams' : 'email',
          eventType: `${deliveryChannel}NotificationDelivered`,
          entityType: entityType || 'NotificationEvent',
          entityId: entityId || event.id,
          status: 'Success',
          responsePayload: metadata,
        });
      }
    } catch (error) {
      await recordNotificationAttempt(client, {
        notificationId: event.id,
        channel: deliveryChannel,
        provider: selectedProvider,
        status: 'Failed',
        responseMetadata: { error: error.message, deterministic: true },
      });
      deliveryResults.push({ channel: deliveryChannel, provider: selectedProvider, status: 'Failed', error: error.message });
      await logIntegrationEvent(client, {
        provider: deliveryChannel === 'Teams' ? 'teams' : deliveryChannel === 'Email' ? 'email' : selectedProvider,
        eventType: `${deliveryChannel}NotificationFailed`,
        entityType: entityType || 'NotificationEvent',
        entityId: entityId || event.id,
        status: 'Failed',
        responsePayload: { error: error.message },
      });
    }
  }

  await audit(client, req, {
    module: 'Notifications',
    action: 'Send Notification',
    entityType: entityType || 'NotificationEvent',
    entityId: entityId || event.id,
    newValue: { ...event, deliveryResults },
    details: `Sent notification ${event.title} to ${deliveryResults.map(item => `${item.channel}:${item.status}`).join(', ')}`,
    source: channelSet.has('Teams') ? 'Teams' : channelSet.has('Email') ? 'Email' : 'System',
  });
  return event;
};

registerHealthRoutes({app, pool, rootDir: serverDir});

app.get('/api/auth/entra/config', requireDatabase, async (_req, res) => {
  res.json({
    enabled: (process.env.IDENTITY_PROVIDER || 'local') === 'entra' && isEntraLoginConfigured(),
    provider: process.env.IDENTITY_PROVIDER || 'local',
    startUrl: '/api/auth/entra/start',
    redirectUri: isEntraLoginConfigured() ? getEntraRedirectUri() : null,
  });
});

app.get('/api/auth/entra/start', requireDatabase, async (req, res) => {
  try {
    if ((process.env.IDENTITY_PROVIDER || 'local') !== 'entra' || !isEntraLoginConfigured()) {
      res.redirect('/login?error=entra_not_configured');
      return;
    }
    const config = await getMicrosoftOpenIdConfiguration();
    const nonce = crypto.randomUUID();
    const browserBinding = crypto.randomBytes(32).toString('base64url');
    const transactionId = crypto.randomUUID();
    const state = signEntraState({
      transactionId,
      nonce,
      requestedRole: req.query.role ? String(req.query.role) : null,
      returnTo: req.query.returnTo ? String(req.query.returnTo) : '/',
    });
    await pool.query('delete from entra_auth_transactions where expires_at <= now()');
    await pool.query(`
      insert into entra_auth_transactions (id, state_hash, browser_binding_hash, expires_at)
      values ($1, $2, $3, now() + interval '10 minutes')
    `, [transactionId, hashEntraState(state), hashEntraState(browserBinding)]);
    res.cookie(entraStateCookieName, browserBinding, entraStateCookieOptions);
    const url = new URL(config.authorization_endpoint);
    url.searchParams.set('client_id', getEntraClientId());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', getEntraRedirectUri());
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    res.redirect(url.toString());
  } catch (error) {
    console.error(error);
    res.redirect('/login?error=entra_start_failed');
  }
});

app.get('/api/auth/entra/callback', requireDatabase, loginRateLimit, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = req.query.code ? String(req.query.code) : '';
    const state = verifyEntraState(req.query.state ? String(req.query.state) : '');
    const browserBinding = readCookie(req, entraStateCookieName);
    res.clearCookie(entraStateCookieName, entraStateCookieClearOptions);
    if ((!code && !req.query.error) || !state || !browserBinding || !state.transactionId) {
      res.redirect('/login?error=entra_invalid_state');
      return;
    }
    await client.query('begin');
    const consumed = (await client.query(`
      delete from entra_auth_transactions
      where id = $1 and state_hash = $2 and browser_binding_hash = $3 and expires_at > now()
      returning id
    `, [state.transactionId, hashEntraState(String(req.query.state)), hashEntraState(browserBinding)])).rows[0];
    if (!consumed) {
      await client.query('rollback');
      res.redirect('/login?error=entra_invalid_state');
      return;
    }
    await client.query('commit');
    if (req.query.error) {
      res.redirect(`/login?error=${encodeURIComponent(String(req.query.error))}`);
      return;
    }
    const { config, tokenPayload } = await exchangeEntraCode(code);
    const claims = await verifyEntraIdToken(tokenPayload.id_token, { nonce: state.nonce, config });
    const providerSubject = claims.oid || claims.sub;
    const upn = claims.preferred_username || claims.upn || claims.email;
    if (!providerSubject) {
      res.redirect('/login?error=entra_missing_identity');
      return;
    }
    await client.query('begin');
    let user = await fetchUserAuthRowByWhere(client, `
      left join identity_provider_links ipl on ipl.employee_id = e.id and ipl.provider = 'entra' and ipl.status = 'Linked'
      where ipl.provider_subject = $1
        or u.entra_object_id = $1
        or e.entra_object_id = $1
    `, [providerSubject]);
    if (!user || user.status !== 'Active') {
      await logIntegrationEvent(client, {
        provider: 'entra',
        eventType: 'EntraLoginRejected',
        entityType: 'IdentityProviderLink',
        entityId: providerSubject || upn || null,
        status: 'Failed',
        responsePayload: { reason: 'No active linked user', upn, providerSubject },
      });
      await client.query('commit');
      res.redirect('/login?error=entra_unlinked_user');
      return;
    }
    if (providerSubject && user.employee_record_id) {
      await client.query(`
        insert into identity_provider_links (id, employee_id, provider, provider_subject, provider_upn, status)
        values ('identity-link-' || gen_random_uuid()::text, $1, 'entra', $2, $3, 'Linked')
        on conflict (employee_id, provider) do update set
          provider_subject = excluded.provider_subject,
          provider_upn = excluded.provider_upn,
          status = 'Linked',
          updated_at = now()
      `, [user.employee_record_id, providerSubject, upn || null]);
      await client.query('update employees set entra_object_id = coalesce(entra_object_id, $2), updated_at = now() where id = $1', [user.employee_record_id, providerSubject]);
    }
    const mappedRoles = await mappedRolesFromEntraGroups(client, claims.groups || []);
    const session = await buildLoginResponse(client, res, user, state.requestedRole, mappedRoles);
    await logIntegrationEvent(client, {
      provider: 'entra',
      eventType: 'EntraLoginSucceeded',
      entityType: 'User',
      entityId: user.id,
      status: 'Success',
      responsePayload: {
        upn,
        providerSubject,
        mappedRoles,
        groupCount: Array.isArray(claims.groups) ? claims.groups.length : 0,
        groupOverage: Boolean(claims._claim_names?.groups),
      },
    });
    req.user = { sub: user.id, username: user.username, activeRole: session.activeRole };
    await audit(client, req, {
      module: 'Auth',
      action: 'Entra Login',
      entityType: 'User',
      entityId: user.id,
      details: `Signed in through Microsoft Entra as ${session.activeRole}`,
      newValue: { upn, activeRole: session.activeRole, mappedRoles },
      source: 'System',
    });
    await client.query('commit');
    const completionUrl = process.env.NODE_ENV === 'production'
      ? new URL('/auth/entra/complete', getGovernedAppUrls().appUrl).href
      : buildAppUrl('/auth/entra/complete');
    res.redirect(completionUrl);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error(error);
    res.redirect('/login?error=entra_callback_failed');
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', loginRateLimit, requireDatabase, async (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.LOCAL_LOGIN_ENABLED === 'false') return res.status(404).json({ error: 'Not found' });
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    requestedRole: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const result = await pool.query(`
      with direct_users as (
        select id from users where lower(username)=lower($1) or lower(email)=lower($1)
      ), login_candidates as (
        select id from direct_users
        union all
        select u2.id from users u2
        join employees e2 on e2.id=u2.employee_record_id
        where not exists(select 1 from direct_users)
          and lower(u2.employee_id)=lower($1)
          and u2.status='Active' and e2.status<>'Exited'
      )
      select u.id, u.username, u.employee_id, u.email, u.password_hash, u.must_change_password, u.status, e.id as employee_record_id, e.name, cd.id as country_director_id,
        coalesce(json_agg(r.name) filter (where r.name is not null), '[]') as roles
      from users u
      left join employees e on e.id = u.employee_record_id
      left join country_directors cd on cd.id = e.primary_country_director_id
        and (
          lower(e.designation) in ('country director', 'regional lead', 'director')
          or lower(e.department) = 'regional leadership'
        )
      left join user_roles ur on ur.user_id = u.id
      left join roles r on r.id = ur.role_id
      where u.id in (select id from login_candidates)
      group by u.id, e.id, e.name, cd.id
      limit 2
    `, [parsed.data.username]);
    const user = result.rows.length === 1 ? result.rows[0] : null;
    if (!user || user.status !== 'Active' || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const activeRole = parsed.data.requestedRole && user.roles.includes(parsed.data.requestedRole)
      ? parsed.data.requestedRole
      : user.roles[0];
    const permissions = await getEffectivePermissionsForUser(pool, user.id, activeRole);
    const sessionExpiresAt = Date.now() + getSessionTtlMs();
    const token = signToken({
      sub: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      roles: user.roles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      exp: sessionExpiresAt,
    });
    res.cookie?.('workos_session', token, getSessionCookieOptions());
    res.json({
      id: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      mustChangePassword: Boolean(user.must_change_password),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie?.('workos_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ status: 'ok' });
});

// Scope discovery deliberately authenticates identity without resolving a
// context first; it is the only endpoint used to choose among multiple scopes.
const listOrganizationScopes = async (req, res) => {
  try {
    res.json(await listAuthorizedOrganizationScopes(pool, req.user.sub));
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Authoritative organization scopes are unavailable', code: 'ORG_SCOPE_UNAVAILABLE' });
  }
};

app.post('/api/auth/switch-role', requireDatabase, requireAuth, async (req, res) => {
  const schema = z.object({ role: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const user = await fetchUserAuthRowByWhere(pool, 'where u.id = $1', [req.user.sub]);
    if (!user || user.status !== 'Active') {
      res.status(401).json({ error: 'User is not active' });
      return;
    }
    const dbRoles = user.roles || [];
    if (!dbRoles.includes(parsed.data.role)) {
      res.status(403).json({ error: 'Role is not assigned to this user' });
      return;
    }
    const activeRole = parsed.data.role;
    const permissions = await getEffectivePermissionsForUser(pool, user.id, activeRole);
    const sessionExpiresAt = Date.now() + getSessionTtlMs();
    const token = signToken({
      sub: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      roles: dbRoles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      exp: sessionExpiresAt,
    });
    res.cookie?.('workos_session', token, getSessionCookieOptions());
    await audit(pool, req, {
      module: 'Auth',
      action: 'Switch Role',
      entityType: 'User',
      entityId: user.id,
      details: `Switched active role to ${activeRole}`,
      newValue: { activeRole },
    });
    res.json({
      id: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      email: user.email,
      name: user.name,
      roles: dbRoles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      mustChangePassword: Boolean(user.must_change_password),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Role switch failed' });
  }
});

const refreshIdentitySession = async (req, res) => {
  try {
    const result = await pool.query(`
      select u.id, u.username, u.employee_id, u.email, u.must_change_password, u.status,
        e.id as employee_record_id, e.name, cd.id as country_director_id,
        coalesce(json_agg(r.name) filter (where r.name is not null), '[]') as roles
      from users u
      left join employees e on e.id = u.employee_record_id
      left join country_directors cd on cd.id = e.primary_country_director_id
        and (
          lower(e.designation) in ('country director', 'regional lead', 'director')
          or lower(e.department) = 'regional leadership'
        )
      left join user_roles ur on ur.user_id = u.id
      left join roles r on r.id = ur.role_id
      where u.id = $1
      group by u.id, e.id, e.name, cd.id
      limit 1
    `, [req.user.sub]);
    const user = result.rows[0];
    if (!user || user.status !== 'Active') {
      res.status(401).json({ error: 'User is not active' });
      return;
    }
    const activeRole = user.roles.includes(req.user.activeRole) ? req.user.activeRole : user.roles[0];
    const permissions = await getEffectivePermissionsForUser(pool, user.id, activeRole);
    const sessionExpiresAt = Date.now() + getSessionTtlMs();
    const token = signToken({
      sub: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      roles: user.roles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      exp: sessionExpiresAt,
    });
    res.cookie?.('workos_session', token, getSessionCookieOptions());
    res.json({
      id: user.id,
      username: user.username,
      employeeId: user.employee_id,
      employeeRecordId: user.employee_record_id,
      countryDirectorId: user.country_director_id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      activeRole,
      permissions,
      permissionRole: activeRole,
      mustChangePassword: Boolean(user.must_change_password),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Session refresh failed' });
  }
};

const identityReadRouteDependencies = {
  requireDatabase,
  requireIdentity,
  listOrganizationScopes,
  refreshSession: refreshIdentitySession,
};
app.use('/api/auth', createIdentityReadRouter(identityReadRouteDependencies));
app.use('/api/v1/auth', createIdentityReadRouter(identityReadRouteDependencies));

app.post('/api/auth/change-password', requireDatabase, requireAuth, async (req, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const user = (await client.query(
      'select id, username, employee_id, email, password_hash, status, must_change_password from users where id = $1 for update',
      [req.user.sub]
    )).rows[0];
    if (!user || user.status !== 'Active') {
      await client.query('rollback');
      res.status(404).json({ error: 'Active user was not found' });
      return;
    }
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      await client.query('rollback');
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const passwordError = validateNewPassword(parsed.data.newPassword, [user.username, user.employee_id, user.email]);
    if (passwordError) {
      await client.query('rollback');
      res.status(400).json({ error: passwordError });
      return;
    }
    const passwordHash = await scryptHash(parsed.data.newPassword);
    await client.query(
      'update users set password_hash = $1, must_change_password = false, updated_at = now() where id = $2',
      [passwordHash, user.id]
    );
    await audit(client, req, {
      module: 'Auth',
      action: 'Change Password',
      entityType: 'User',
      entityId: user.id,
      details: `Changed password for ${user.username}`,
    });
    await client.query('commit');
    res.json({ status: 'ok', mustChangePassword: false });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Password change failed' });
  } finally {
    client.release();
  }
});

app.post('/api/users/:id/password-reset', requireDatabase, requireAuth, requirePermission('employees.password_reset'), async (req, res) => {
  const schema = z.object({
    newPassword: z.string().optional(),
    mustChangePassword: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const user = (await client.query(`
      select u.id, u.username, u.employee_id, u.email, u.status, u.must_change_password
      from users u
      join employees e on e.id = u.employee_record_id
      where (u.id::text = $1 or lower(u.username) = lower($1) or lower(u.employee_id) = lower($1) or lower(u.email) = lower($1))
        and e.organization_id = $2 and e.legal_entity_id = $3
      for update
      limit 1
    `, [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
    if (!user) {
      await client.query('rollback');
      res.status(404).json({ error: 'User was not found' });
      return;
    }
    const temporaryPassword = parsed.data.newPassword || generateTemporaryPassword();
    const passwordError = validateNewPassword(temporaryPassword, [user.username, user.employee_id, user.email]);
    if (passwordError) {
      await client.query('rollback');
      res.status(400).json({ error: passwordError });
      return;
    }
    const passwordHash = await scryptHash(temporaryPassword);
    const mustChangePassword = parsed.data.mustChangePassword ?? true;
    await client.query(
      `update users u set password_hash = $1, must_change_password = $2, updated_at = now()
       from employees e
       where u.id = $3 and e.id = u.employee_record_id
         and e.organization_id = $4 and e.legal_entity_id = $5`,
      [passwordHash, mustChangePassword, user.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    );
    await audit(client, req, {
      module: 'Admin',
      action: 'Reset Password',
      entityType: 'User',
      entityId: user.id,
      details: `Reset password for ${user.username}`,
      newValue: { mustChangePassword },
    });
    await client.query('commit');
    res.json({
      status: 'ok',
      userId: user.id,
      userName: user.username,
      mustChangePassword,
      temporaryPassword: parsed.data.newPassword ? undefined : temporaryPassword,
    });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Password reset failed' });
  } finally {
    client.release();
  }
});

app.get('/api/employees', requireDatabase, requireAuth, requirePermission('employees.view'), async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where e.id = $1
         or e.employee_id = $2
         or e.reporting_manager_id = $1
         or e.reporting_manager_id = $2
         or e.id in (
          with recursive reporting_chain as (
            select reporting_manager_id from employees where id = $1 or employee_id = $2
            union all
            select manager.reporting_manager_id
            from employees manager
            join reporting_chain chain on manager.id = chain.reporting_manager_id
            where chain.reporting_manager_id is not null
          )
          select reporting_manager_id from reporting_chain where reporting_manager_id is not null
        )
    `;
  } else if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    where = `
      where e.primary_country_director_id = $1
         or exists (
          select 1 from employee_country_director_map scope
          where scope.employee_id = e.id and scope.country_director_id = $1
        )
    `;
  } else if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where e.id = $1 or e.employee_id = $2
         or exists (
          select 1
          from project_allocations pa
          join projects p on p.id = pa.project_id
          where pa.employee_id = e.id
            and (p.manager_id = $1 or p.manager_id = $2)
        )
    `;
  }
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  where = `where e.organization_id = $${params.length - 1} and e.legal_entity_id = $${params.length}${where ? ` and (${where.replace(/^\s*where\s+/, '').trim()})` : ''}`;
  await run(res, `
    select e.*, coalesce(json_agg(ecdm.country_director_id) filter (where ecdm.country_director_id is not null), '[]') as mapped_country_director_ids
    from employees e
    left join employee_country_director_map ecdm on ecdm.employee_id = e.id
    ${where}
    group by e.id
    order by e.name
  `, params);
});

app.post('/api/employees', requireDatabase, requireAuth, requirePermission('employees.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).optional(),
    employee_id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    designation: z.string().min(1),
    department: z.string().min(1),
    country: z.string().min(1),
    region: z.string().optional().nullable(),
    business_unit: z.string().optional().nullable(),
    reporting_manager_id: z.string().min(1).optional().nullable(),
    primary_country_director_id: z.string().min(1),
    mapped_country_director_ids: z.array(z.string()).default([]),
    utilization_eligible: z.boolean().optional(),
    joining_date: strictIsoDateSchema.optional().nullable(),
    exit_date: strictIsoDateSchema.optional().nullable(),
    standard_weekly_hours: z.number().min(1).max(168).optional().nullable(),
    capacity_type: z.string().min(1).optional().nullable(),
    contract_type: z.string().min(1).optional().nullable(),
    leave_policy_id: z.string().optional().nullable(),
    entra_object_id: z.string().optional().nullable(),
    teams_user_id: z.string().optional().nullable(),
    roles: z.array(z.enum(['Employee', 'TeamLead', 'ProjectManager', 'CountryDirector', 'HR', 'Admin'])).optional(),
    initial_password: z.string().min(6).optional(),
    status: z.enum(['Active', 'On Leave', 'Exited']).default('Active'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `employee:${req.organizationScope.organizationId}:${parsed.data.employee_id}`,
    ]);
    const previous = (await client.query(
      'select * from employees where employee_id = $1 and organization_id = $2 and legal_entity_id = $3 for update',
      [parsed.data.employee_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
    )).rows[0];
    if (!previous) {
      const otherLegalEntityEmployee = (await client.query(
        'select id from employees where employee_id = $1 and organization_id = $2 and legal_entity_id is distinct from $3 for update',
        [parsed.data.employee_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
      )).rows[0];
      if (otherLegalEntityEmployee) {
        await client.query('rollback');
        res.status(409).json({ error: 'Employee ID is already assigned to another legal entity', code: 'EMPLOYEE_SCOPE_CONFLICT' });
        return;
      }
    }
    let effectiveExitDate = parsed.data.exit_date;
    if (previous?.status === 'Exited' && parsed.data.status !== 'Exited') effectiveExitDate = null;
    if (previous && parsed.data.status === 'Exited') {
      effectiveExitDate = await assertWorkerMayExit(
        client,
        previous,
        req.organizationScope,
        previous.status === 'Exited' ? parsed.data.exit_date : (parsed.data.exit_date || new Date().toISOString().slice(0, 10)),
      );
    }
    if (parsed.data.id && (!previous || previous.id !== parsed.data.id)) {
      const unavailableId = (await client.query('select 1 from employees where id = $1', [parsed.data.id])).rows[0];
      if (unavailableId) {
        await client.query('rollback');
        res.status(404).json({ error: 'Employee not found in the authorized organization and legal entity' });
        return;
      }
    }
    const employeeRecordId = parsed.data.id || previous?.id || `e-${crypto.randomUUID()}`;
    if (parsed.data.reporting_manager_id === employeeRecordId) {
      await client.query('rollback');
      res.status(422).json({ error: 'An employee cannot report to themselves' });
      return;
    }
    if (parsed.data.reporting_manager_id) {
      const manager = (await client.query(
        'select id, status from employees where id = $1 and organization_id = $2 and legal_entity_id = $3',
        [parsed.data.reporting_manager_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
      )).rows[0];
      if (!manager || manager.status === 'Exited') {
        await client.query('rollback');
        res.status(422).json({ error: 'Reporting manager must reference an active employee' });
        return;
      }
      const cycle = (await client.query(`
        with recursive manager_chain as (
          select id, reporting_manager_id from employees where id = $1 and organization_id = $3 and legal_entity_id = $4
          union all
          select e.id, e.reporting_manager_id
          from employees e
          join manager_chain chain on e.id = chain.reporting_manager_id
          where chain.reporting_manager_id is not null and e.organization_id = $3 and e.legal_entity_id = $4
        )
        select 1 from manager_chain where id = $2 limit 1
      `, [parsed.data.reporting_manager_id, employeeRecordId, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (cycle) {
        await client.query('rollback');
        res.status(422).json({ error: 'This reporting manager change would create a circular hierarchy' });
        return;
      }
    }
    const employeeCode = parsed.data.employee_id.toUpperCase();
    const designation = parsed.data.designation.toLowerCase();
    const department = parsed.data.department.toLowerCase();
    const defaultUtilizationEligible = !(
      employeeCode.startsWith('ADMIN-') ||
      employeeCode.startsWith('HR-') ||
      employeeCode.startsWith('CD-') ||
      designation === 'country director' ||
      designation === 'system administrator' ||
      designation === 'hr manager' ||
      department === 'regional leadership' ||
      department === 'administration' ||
      department === 'human resources'
    );
    const utilizationEligible = parsed.data.utilization_eligible ?? defaultUtilizationEligible;
    const employeeResult = await client.query(`
      insert into employees (
        id, employee_id, name, email, designation, department, country, region, business_unit, reporting_manager_id,
        primary_country_director_id, status, utilization_eligible, joining_date, exit_date,
        standard_weekly_hours, capacity_type, contract_type, leave_policy_id, entra_object_id, teams_user_id, organization_id, legal_entity_id
      )
      values ($1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      on conflict (organization_id, employee_id) do update set
        name = excluded.name,
        email = excluded.email,
        designation = excluded.designation,
        department = excluded.department,
        country = excluded.country,
        region = excluded.region,
        business_unit = excluded.business_unit,
        reporting_manager_id = excluded.reporting_manager_id,
        primary_country_director_id = excluded.primary_country_director_id,
        status = excluded.status,
        utilization_eligible = excluded.utilization_eligible,
        joining_date = excluded.joining_date,
        exit_date = excluded.exit_date,
        standard_weekly_hours = excluded.standard_weekly_hours,
        capacity_type = excluded.capacity_type,
        contract_type = excluded.contract_type,
        leave_policy_id = excluded.leave_policy_id,
        entra_object_id = excluded.entra_object_id,
        teams_user_id = excluded.teams_user_id,
        updated_at = now()
      returning *
    `, [
      employeeRecordId,
      parsed.data.employee_id,
      parsed.data.name,
      parsed.data.email,
      parsed.data.designation,
      parsed.data.department,
      parsed.data.country,
      parsed.data.region || null,
      parsed.data.business_unit || null,
      parsed.data.reporting_manager_id || null,
      parsed.data.primary_country_director_id,
      parsed.data.status,
      utilizationEligible,
      parsed.data.joining_date || null,
      effectiveExitDate || null,
      parsed.data.standard_weekly_hours || 40,
      parsed.data.capacity_type || (utilizationEligible ? 'Delivery' : 'Governance'),
      parsed.data.contract_type || 'Permanent',
      parsed.data.leave_policy_id || null,
      parsed.data.entra_object_id || null,
      parsed.data.teams_user_id || null,
      req.organizationScope.organizationId, req.organizationScope.legalEntityId,
    ]);
    const employee = employeeResult.rows[0];
    await initializeNewWorkerLifecycle(client, {
      employeeId: employee.id,
      organizationId: req.organizationScope.organizationId,
      legalEntityId: req.organizationScope.legalEntityId,
      actorId: req.user.sub,
      isNew: !previous,
    });
    const mappedIds = Array.from(new Set([parsed.data.primary_country_director_id, ...parsed.data.mapped_country_director_ids].filter(Boolean)));
    await client.query('delete from employee_country_director_map where employee_id = $1', [employee.id]);
    for (const directorId of mappedIds) {
      await client.query(`
        insert into employee_country_director_map (employee_id, country_director_id)
        values ($1,$2)
        on conflict do nothing
      `, [employee.id, directorId]);
    }

    const existingUser = (await client.query('select id, username from users where employee_record_id = $1', [employee.id])).rows[0];
    if (!existingUser && !parsed.data.initial_password) {
      throw new Error('initial_password is required when creating a new user.');
    }
    const passwordHash = existingUser && !parsed.data.initial_password
      ? null
      : await scryptHash(parsed.data.initial_password);
    const baseUsername = parsed.data.employee_id.toLowerCase();
    const username = (existingUser?.username || !(await client.query('select 1 from users where lower(username) = lower($1)', [baseUsername])).rowCount)
      ? (existingUser?.username || baseUsername)
      : `${baseUsername}-${req.organizationScope.organizationId}-${req.organizationScope.legalEntityId}`.toLowerCase();
    const userResult = await client.query(`
      insert into users (username, employee_id, employee_record_id, email, password_hash, status, updated_at)
      values ($1,$2,$3,$4,$5,$6,now())
      on conflict (username) do update set
        employee_id = excluded.employee_id,
        employee_record_id = excluded.employee_record_id,
        email = excluded.email,
        password_hash = coalesce($5, users.password_hash),
        status = excluded.status,
        updated_at = now()
      returning id
    `, [
      username,
      parsed.data.employee_id,
      employee.id,
      parsed.data.email,
      passwordHash,
      parsed.data.status === 'Exited' ? 'Disabled' : 'Active',
    ]);
    await client.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,$4) on conflict(user_id,organization_id,legal_entity_id) do update set active=excluded.active`,[userResult.rows[0].id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,employee.status !== 'Exited']);
    if (previous?.status === 'Exited' && employee.status !== 'Exited') {
      await synchronizeWorkerReactivation(client, {
        employeeId: employee.id,
        organizationId: req.organizationScope.organizationId,
        legalEntityId: req.organizationScope.legalEntityId,
        actorId: req.user.sub,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        status: employee.status,
        reason: 'Reactivated through employee save',
        source: 'Employee save',
      });
    }
    const defaultRoleNames = employeeCode.startsWith('ADMIN-')
      ? ['Admin']
      : employeeCode.startsWith('HR-')
        ? ['HR']
        : employeeCode.startsWith('CD-')
          ? ['CountryDirector']
          : employeeCode.startsWith('PM-')
            ? ['ProjectManager', 'Employee']
            : ['Employee'];
    const roleNames = parsed.data.roles || defaultRoleNames;
    const roleResult = await client.query('select id, name from roles where name = any($1::text[])', [roleNames]);
    await client.query('delete from user_roles where user_id = $1', [userResult.rows[0].id]);
    for (const role of roleResult.rows) {
      await client.query('insert into user_roles (user_id, role_id) values ($1,$2) on conflict do nothing', [userResult.rows[0].id, role.id]);
    }
    if (previous && previous.status !== 'Exited' && employee.status === 'Exited') {
      await synchronizeWorkerExit(client, req, employee, parsed.data.exit_date || new Date().toISOString().slice(0, 10), 'Employee save');
    }
    await audit(client, req, {
      module: 'Employee',
      action: previous ? 'Update Employee' : 'Create Employee',
      entityType: 'Employee',
      entityId: employee.id,
      oldValue: previous,
      newValue: employee,
      details: `${previous ? 'Updated' : 'Created'} employee ${employee.employee_id} and synchronized login`,
    });
    await client.query('commit');
    res.json({ ...employee, mapped_country_director_ids: mappedIds });
  } catch (error) {
    await client.query('rollback');
    if (['WORKER_DEPENDENCY_CONFLICT', 'WORKER_VERSION_CONFLICT', 'WORKER_IDENTITY_SYNC_CONFLICT'].includes(error.code)) {
      res.status(409).json({ error: error.message, code: error.code, dependencies: error.dependencies, truncated: error.truncated });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Employee save failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/employees/:id', requireDatabase, requireAuth, requirePermission('employees.manage'), async (req, res) => {
  const schema = z.object({
    reason: z.string().optional(),
    confirm_direct_reports: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const employeeKey = (await client.query('select employee_id from employees where id=$1 and organization_id=$2 and legal_entity_id=$3', [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
    if (!employeeKey) {
      await client.query('rollback');
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `employee:${req.organizationScope.organizationId}:${employeeKey.employee_id}`,
    ]);
    const previous = (await client.query('select * from employees where id=$1 and organization_id=$2 and legal_entity_id=$3 for update', [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    const effectiveFrom = new Date().toISOString().slice(0, 10);
    await assertWorkerMayExit(client, previous, req.organizationScope, effectiveFrom);
    const result = { rows: [await synchronizeWorkerExit(client, req, previous, effectiveFrom, parsed.data.reason || 'Employee deactivation')] };
    await audit(client, req, {
      module: 'Employee',
      action: 'Deactivate Employee',
      entityType: 'Employee',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Deactivated employee ${previous.employee_id} and disabled login`,
      reason: parsed.data.reason,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === 'WORKER_DEPENDENCY_CONFLICT' || error.code === 'WORKER_VERSION_CONFLICT') {
      res.status(409).json({ error: error.message, code: error.code, dependencies: error.dependencies, truncated: error.truncated });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Employee deactivation failed' });
  } finally {
    client.release();
  }
});

app.get('/api/projects', requireDatabase, requireAuth, requirePermission('projects.view'), async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where exists (
        select 1 from project_allocations pa
        where pa.project_id = projects.id
          and (pa.employee_id = $1 or pa.employee_id = $2)
      )
    `;
  } else if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = 'where manager_id = $1 or manager_id = $2';
  } else if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    where = `
      where exists (
        select 1
        from project_allocations pa
        join employees e on e.id = pa.employee_id
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where pa.project_id = projects.id
          and (e.primary_country_director_id = $1 or ecdm.country_director_id = $1)
      )
    `;
  }
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  where = `where projects.organization_id = $${params.length - 1} and projects.legal_entity_id = $${params.length}${where ? ` and (${where.replace(/^\s*where\s+/, '').trim()})` : ''}`;
  await run(res, `select * from projects ${where} order by name`, params);
});
app.post('/api/projects', requireDatabase, requireAuth, requirePermission('projects.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).optional(),
    project_code: z.string().min(1),
    name: z.string().min(1),
    client_id: z.string().min(1),
    manager_id: z.string().min(1),
    start_date: strictIsoDateSchema,
    end_date: strictIsoDateSchema,
    status: z.enum(['Proposed', 'Active', 'On Hold', 'Completed']).default('Proposed'),
    billable: z.boolean().default(true),
    project_type: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Project end date cannot be before start date' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const clientResult = await client.query('select id, name, status from clients where id = $1 and organization_id = $2 and legal_entity_id = $3', [parsed.data.client_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    const clientRecord = clientResult.rows[0];
    if (!clientRecord || clientRecord.status !== 'Active') {
      await client.query('rollback');
      res.status(422).json({ error: 'Project must reference an active client' });
      return;
    }
    const managerResult = await client.query('select id, name, status from employees where id = $1 and organization_id = $2 and legal_entity_id = $3', [parsed.data.manager_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    const manager = managerResult.rows[0];
    if (!manager || manager.status === 'Exited') {
      await client.query('rollback');
      res.status(422).json({ error: 'Project manager must reference an active employee' });
      return;
    }
    const previous = parsed.data.id
      ? (await client.query('select * from projects where id = $1 and organization_id = $2 and legal_entity_id = $3 for update', [parsed.data.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0]
      : null;
    if (parsed.data.id && !previous) {
      const unavailableId = (await client.query('select 1 from projects where id = $1', [parsed.data.id])).rows[0];
      if (unavailableId) {
        await client.query('rollback');
        res.status(404).json({ error: 'Project not found in the authorized organization and legal entity' });
        return;
      }
    }
    const result = await client.query(`
      insert into projects (id, project_code, name, client_id, client, manager_id, manager_name, start_date, end_date, status, billable, project_type, country, notes, organization_id, legal_entity_id)
      values (coalesce($1, 'p-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      on conflict (id) do update set
        project_code = excluded.project_code,
        name = excluded.name,
        client_id = excluded.client_id,
        client = excluded.client,
        manager_id = excluded.manager_id,
        manager_name = excluded.manager_name,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        status = excluded.status,
        billable = excluded.billable,
        project_type = excluded.project_type,
        country = excluded.country,
        notes = excluded.notes,
        updated_at = now()
      where projects.organization_id = excluded.organization_id
        and projects.legal_entity_id = excluded.legal_entity_id
      returning *
    `, [
      parsed.data.id || null,
      parsed.data.project_code,
      parsed.data.name,
      clientRecord.id,
      clientRecord.name,
      manager.id,
      manager.name,
      parsed.data.start_date,
      parsed.data.end_date,
      parsed.data.status,
      parsed.data.billable,
      parsed.data.project_type || null,
      parsed.data.country || null,
      parsed.data.notes || null,
      req.organizationScope.organizationId, req.organizationScope.legalEntityId,
    ]);
    if (result.rowCount === 0) {
      await client.query('rollback');
      res.status(404).json({ error: 'Project not found in the authorized organization and legal entity' });
      return;
    }
    await audit(client, req, {
      module: 'Projects',
      action: previous ? 'Update Project' : 'Create Project',
      entityType: 'Project',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} project ${result.rows[0].project_code}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Project save failed' });
  } finally {
    client.release();
  }
});

app.patch('/api/projects/:id/status', requireDatabase, requireAuth, requirePermission('projects.status_update'), async (req, res) => {
  const schema = z.object({
    status: z.enum(['Proposed', 'Active', 'On Hold', 'Completed']),
    reason: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query(
      'select * from projects where id = $1 and organization_id = $2 and legal_entity_id = $3 for update',
      [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    )).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (
      req.user.activeRole === 'ProjectManager' &&
      previous.manager_id !== req.user.employeeRecordId &&
      previous.manager_id !== req.user.employeeId
    ) {
      await client.query('rollback');
      res.status(403).json({ error: 'Project managers can close only their own projects' });
      return;
    }
    const result = await client.query(`
      update projects
      set status = $2,
        end_date = case when $2 = 'Completed' and end_date > current_date then current_date else end_date end,
        updated_at = now()
      where id = $1 and organization_id = $3 and legal_entity_id = $4
      returning *
    `, [req.params.id, parsed.data.status, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    if (parsed.data.status === 'Completed') {
      await client.query(`
        update project_allocations
        set status = 'Completed',
          end_date = case when end_date > current_date then current_date else end_date end,
          updated_at = now()
        where project_id = $1 and organization_id = $2 and legal_entity_id = $3 and status = 'Active'
      `, [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    }
    await audit(client, req, {
      module: 'Projects',
      action: 'Update Project Status',
      entityType: 'Project',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Changed project ${previous.project_code} status to ${parsed.data.status}`,
      reason: parsed.data.reason,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Project status update failed' });
  } finally {
    client.release();
  }
});
app.get('/api/clients', requireDatabase, requireAuth, requirePermission('clients.view'), async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    where = `
      where exists (
        select 1 from client_country_director_map scope
        where scope.client_id = c.id and scope.country_director_id = $1
      )
    `;
  } else if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = 'where exists (select 1 from projects p where p.client_id = c.id and (p.manager_id = $1 or p.manager_id = $2))';
  } else if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where exists (
        select 1
        from projects p
        join project_allocations pa on pa.project_id = p.id
        where p.client_id = c.id and (pa.employee_id = $1 or pa.employee_id = $2)
      )
    `;
  }
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  where = `where c.organization_id = $${params.length - 1} and c.legal_entity_id = $${params.length}${where ? ` and (${where.replace(/^\s*where\s+/, '').trim()})` : ''}`;
  await run(res, `
    select c.*, coalesce(json_agg(ccdm.country_director_id) filter (where ccdm.country_director_id is not null), '[]') as country_director_ids
    from clients c
    left join client_country_director_map ccdm on ccdm.client_id = c.id
    ${where}
    group by c.id
    order by c.name
  `, params);
});
app.post('/api/clients', requireDatabase, requireAuth, requirePermission('clients.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    industry: z.string().min(1).default('Unclassified'),
    account_owner_id: z.string().optional().nullable(),
    country_director_ids: z.array(z.string()).default([]),
    status: z.enum(['Active', 'Inactive']).default('Active'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (parsed.data.id) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`client:${parsed.data.id}`]);
    const previousBase = parsed.data.id
      ? (await client.query('select * from clients where id = $1 and organization_id=$2 and legal_entity_id=$3 for update', [parsed.data.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0]
      : null;
    if (parsed.data.id && !previousBase && (await client.query('select 1 from clients where id=$1', [parsed.data.id])).rowCount) {
      await client.query('rollback');
      res.status(404).json({ error: 'Client not found in the authorized organization and legal entity' });
      return;
    }
    if (parsed.data.account_owner_id) {
      const owner = (await client.query(`select id from employees where id=$1 and organization_id=$2 and legal_entity_id=$3 and status='Active'`,
        [parsed.data.account_owner_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (!owner) {
        await client.query('rollback');
        res.status(422).json({ error: 'Account owner must reference an active employee in the authorized organization and legal entity' });
        return;
      }
    }
    const previousDirectorIds = previousBase
      ? (await client.query('select country_director_id from client_country_director_map where client_id = $1 order by country_director_id', [previousBase.id])).rows.map(row => row.country_director_id)
      : [];
    const previous = previousBase ? { ...previousBase, country_director_ids: previousDirectorIds } : null;
    const result = await client.query(`
      insert into clients (id, name, industry, account_owner_id, status, organization_id, legal_entity_id)
      values (coalesce($1, 'client-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7)
      on conflict (id) do update set
        name = excluded.name,
        industry = excluded.industry,
        account_owner_id = excluded.account_owner_id,
        status = excluded.status,
        updated_at = now()
      where clients.organization_id=excluded.organization_id and clients.legal_entity_id=excluded.legal_entity_id
      returning *
    `, [parsed.data.id || null, parsed.data.name, parsed.data.industry, parsed.data.account_owner_id || null, parsed.data.status, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    const saved = result.rows[0];
    if (!saved) {
      await client.query('rollback');
      res.status(404).json({ error: 'Client not found in the authorized organization and legal entity' });
      return;
    }
    await client.query('delete from client_country_director_map where client_id = $1', [saved.id]);
    for (const countryDirectorId of parsed.data.country_director_ids) {
      await client.query(`
        insert into client_country_director_map (client_id, country_director_id)
        values ($1, $2)
        on conflict do nothing
      `, [saved.id, countryDirectorId]);
    }
    await client.query(
      'update projects set client_id = $1, client = $2, updated_at = now() where organization_id=$4 and legal_entity_id=$5 and (client_id = $1 or client = $3)',
      [saved.id, saved.name, previous?.name || saved.name, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    );
    await audit(client, req, {
      module: 'Clients',
      action: previous ? 'Update Client' : 'Create Client',
      entityType: 'Client',
      entityId: saved.id,
      oldValue: previous,
      newValue: { ...saved, country_director_ids: parsed.data.country_director_ids },
      details: `${previous ? 'Updated' : 'Created'} client ${saved.name}`,
    });
    await client.query('commit');
    res.json(saved);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Client save failed' });
  } finally {
    client.release();
  }
});
app.delete('/api/clients/:id', requireDatabase, requireAuth, requirePermission('clients.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query(
      'select * from clients where id = $1 and organization_id = $2 and legal_entity_id = $3 for update',
      [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    )).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    const activeProjects = Number((await client.query(
      `select count(*)::int as count from projects
       where client_id = $1 and organization_id = $2 and legal_entity_id = $3 and status <> 'Completed'`,
      [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    )).rows[0]?.count || 0);
    if (activeProjects > 0) {
      await audit(client, req, {
        module: 'Clients',
        action: 'Deactivate Blocked',
        entityType: 'Client',
        entityId: req.params.id,
        oldValue: previous,
        details: `Blocked client deactivation for ${previous.name}; ${activeProjects} active project(s) remain`,
        reason: `${activeProjects} active project(s)`,
      });
      await client.query('commit');
      res.status(409).json({ error: 'Client has active projects. Complete or reassign projects before deactivation.' });
      return;
    }
    const result = await client.query(`
      update clients
      set status = 'Inactive', updated_at = now()
      where id = $1 and organization_id = $2 and legal_entity_id = $3
      returning *
    `, [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    await audit(client, req, {
      module: 'Clients',
      action: 'Deactivate Client',
      entityType: 'Client',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Deactivated client ${previous.name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Client deactivation failed' });
  } finally {
    client.release();
  }
});
app.get('/api/allocations', requireDatabase, requireAuth, requirePermission('timesheets.submit'), async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.activeRole === 'Employee' || req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = 'where employee_id = $1 or employee_id = $2';
  } else if (req.user.activeRole === 'ProjectManager') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    where = `
      where exists (
        select 1 from projects p
        where p.id = project_allocations.project_id
          and (p.manager_id = $1 or p.manager_id = $2)
      )
    `;
  } else if (req.user.activeRole === 'CountryDirector') {
    params.push(req.user.countryDirectorId);
    where = `
      where exists (
        select 1
        from employees e
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where e.id = project_allocations.employee_id
          and (e.primary_country_director_id = $1 or ecdm.country_director_id = $1)
      )
    `;
  }
  params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
  where = `where organization_id = $${params.length - 1} and legal_entity_id = $${params.length}${where ? ` and (${where.replace(/^\s*where\s+/, '').trim()})` : ''}`;
  await run(res, `select * from project_allocations ${where} order by start_date desc`, params);
});
app.post('/api/allocations', requireDatabase, requireAuth, requirePermission('allocations.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).optional(),
    employee_id: z.string().min(1),
    project_id: z.string().min(1),
    role_on_project: z.string().min(1).optional().nullable(),
    percentage: z.number().min(0).max(200),
    start_date: strictIsoDateSchema,
    end_date: strictIsoDateSchema,
    billable: z.boolean().default(true),
    status: z.enum(['Active', 'Paused', 'Completed']).default('Active'),
    comments: z.string().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Allocation end date cannot be before start date' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const employee = (await client.query('select * from employees where id = $1 and organization_id = $2 and legal_entity_id = $3', [parsed.data.employee_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
    if (!employee || employee.status === 'Exited') {
      await client.query('rollback');
      res.status(422).json({ error: 'Allocation must reference an active employee' });
      return;
    }
    const project = (await client.query('select * from projects where id = $1 and organization_id = $2 and legal_entity_id = $3', [parsed.data.project_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
    if (!project || !['Active', 'Proposed'].includes(project.status)) {
      await client.query('rollback');
      res.status(422).json({ error: 'Allocation must reference an active or proposed project' });
      return;
    }
    if (parsed.data.start_date < toIsoDate(project.start_date) || parsed.data.end_date > toIsoDate(project.end_date)) {
      await client.query('rollback');
      res.status(422).json({ error: 'Allocation dates must stay within the project timeline' });
      return;
    }
    if (req.user.activeRole === 'ProjectManager' && project.manager_id !== req.user.employeeRecordId && project.manager_id !== req.user.employeeId) {
      await client.query('rollback');
      res.status(403).json({ error: 'Project managers can allocate only on their own projects' });
      return;
    }
    if (req.user.activeRole === 'CountryDirector') {
      const scoped = (await client.query(`
        select 1
        from employee_country_director_map
        where employee_id = $1 and country_director_id = $2
        union
        select 1
        from employees
        where id = $1 and primary_country_director_id = $2
        limit 1
      `, [parsed.data.employee_id, req.user.countryDirectorId || req.user.cdId])).rows[0];
      if (!scoped) {
        await client.query('rollback');
        res.status(403).json({ error: 'Country Directors can allocate only scoped employees' });
        return;
      }
    }

    const blockOverAllocation = await getSetting('blockOverAllocation', false);
    if (blockOverAllocation && parsed.data.status === 'Active') {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [parsed.data.employee_id]);
      const loadResult = await client.query(`
        select coalesce(sum(percentage), 0) as total
        from project_allocations
        where employee_id = $1
          and organization_id = $5 and legal_entity_id = $6
          and status = 'Active'
          and id <> coalesce($2, '')
          and daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
      `, [parsed.data.employee_id, parsed.data.id || null, parsed.data.start_date, parsed.data.end_date, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
      const total = parsePercent(loadResult.rows[0]?.total) + parsed.data.percentage;
      if (total > 100) {
        await client.query('rollback');
        res.status(422).json({ error: `Allocation would exceed 100% for overlapping dates (${total}%)` });
        return;
      }
    }

    const previous = parsed.data.id
      ? (await client.query('select * from project_allocations where id = $1 and organization_id = $2 and legal_entity_id = $3 for update', [parsed.data.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0]
      : null;
    const allocationIdExistsOutsideScope = parsed.data.id && !previous
      ? (await client.query('select 1 from project_allocations where id = $1', [parsed.data.id])).rowCount > 0
      : false;
    if (allocationIdExistsOutsideScope) {
      await client.query('rollback');
      res.status(404).json({ error: 'Allocation not found in the authorized organization and legal entity' });
      return;
    }
    const result = await client.query(`
      insert into project_allocations (id, employee_id, project_id, role_on_project, percentage, start_date, end_date, billable, status, comments, organization_id, legal_entity_id)
      values (coalesce($1, 'a-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict (id) do update set
        employee_id = excluded.employee_id,
        project_id = excluded.project_id,
        role_on_project = excluded.role_on_project,
        percentage = excluded.percentage,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        billable = excluded.billable,
        status = excluded.status,
        comments = excluded.comments,
        updated_at = now()
      where project_allocations.organization_id = excluded.organization_id
        and project_allocations.legal_entity_id = excluded.legal_entity_id
      returning *
    `, [
      parsed.data.id || null,
      parsed.data.employee_id,
      parsed.data.project_id,
      parsed.data.role_on_project || null,
      parsed.data.percentage,
      parsed.data.start_date,
      parsed.data.end_date,
      parsed.data.billable,
      parsed.data.status,
      parsed.data.comments || null,
      req.organizationScope.organizationId, req.organizationScope.legalEntityId,
    ]);
    if (result.rowCount === 0) {
      await client.query('rollback');
      res.status(404).json({ error: 'Allocation not found in the authorized organization and legal entity' });
      return;
    }
    await audit(client, req, {
      module: 'Allocations',
      action: previous ? 'Update Allocation' : 'Create Allocation',
      entityType: 'Allocation',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} allocation for ${employee.employee_id} on ${project.project_code}`,
    });
    await recordAllocationChangeApproval(client, req, {
      action: previous ? 'Update' : 'Create',
      allocation: result.rows[0],
      previous,
      employee,
      project,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Allocation save failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/allocations/:id', requireDatabase, requireAuth, requirePermission('allocations.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from project_allocations where id = $1 and organization_id = $2 and legal_entity_id = $3 for update', [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Allocation not found' });
      return;
    }
    if (req.user.activeRole === 'ProjectManager') {
      const managed = (await client.query('select 1 from projects where id = $1 and (manager_id = $2 or manager_id = $3)', [previous.project_id, req.user.employeeRecordId, req.user.employeeId])).rows[0];
      if (!managed) {
        await client.query('rollback');
        res.status(403).json({ error: 'Project managers can end only allocations on their own projects' });
        return;
      }
    }

    if (req.user.activeRole === 'CountryDirector') {
      const scoped = (await client.query(`
        select 1
        from employees e
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where e.id = $1 and (e.primary_country_director_id = $2 or ecdm.country_director_id = $2)
        limit 1
      `, [previous.employee_id, req.user.countryDirectorId])).rows[0];
      if (!scoped) {
        await client.query('rollback');
        res.status(403).json({ error: 'Country Directors can end only scoped employee allocations' });
        return;
      }
    }
    const result = await client.query(`
      update project_allocations
      set status = 'Completed',
        end_date = case when end_date > current_date then current_date else end_date end,
        updated_at = now()
      where id = $1 and organization_id = $2 and legal_entity_id = $3
      returning *
    `, [req.params.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
    await audit(client, req, {
      module: 'Allocations',
      action: 'End Allocation',
      entityType: 'Allocation',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: 'Soft-ended allocation',
    });
    const employee = (await client.query('select * from employees where id = $1', [result.rows[0].employee_id])).rows[0];
    const project = (await client.query('select * from projects where id = $1', [result.rows[0].project_id])).rows[0];
    await recordAllocationChangeApproval(client, req, {
      action: 'End',
      allocation: result.rows[0],
      previous,
      employee,
      project,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Allocation end failed' });
  } finally {
    client.release();
  }
});
app.get('/api/timesheets', requireDatabase, requireAuth, requirePermission('timesheets.submit'), async (req, res) => {
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
  await run(res, `
    select
      t.*,
      coalesce(json_agg(json_build_object(
        'id', te.id,
        'employee_id', t.employee_id,
        'project_id', te.project_id,
        'project_name', p.name,
        'work_type', te.work_type,
        'client_name', te.client_name,
        'category', te.category,
        'work_date', te.work_date,
        'hours', te.hours,
        'remark', te.remark,
        'status', t.status,
        'billable', te.billable,
        'week_ending', t.week_ending
      ) order by te.work_date, te.id) filter (where te.id is not null), '[]') as entries
    from timesheets t
    join employees e on e.id = t.employee_id
    left join timesheet_entries te on te.timesheet_id = t.id
    left join projects p on p.id = te.project_id
    ${where}
    group by t.id
    order by t.week_ending desc, t.updated_at desc
  `, params);
});
app.post('/api/timesheets', requireDatabase, requireAuth, requirePermission('timesheets.submit'), async (req, res) => {
  const entrySchema = z.object({
    id: z.string().optional(),
    project_id: z.string().optional().nullable(),
    work_type: z.enum(['Project Work', 'Client Misc Task']),
    client_name: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    work_date: strictIsoDateSchema,
    hours: z.number().min(0).max(24),
    remark: z.string().optional().nullable(),
    billable: z.boolean().default(true),
  });
  const schema = z.object({
    employee_id: z.string().min(1),
    week_ending: strictIsoDateSchema,
    status: z.enum(['Draft', 'Submitted']).default('Draft'),
    rejection_reason: z.string().optional().nullable(),
    entries: z.array(entrySchema).min(1).max(100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (isAfterToday(parsed.data.week_ending) || parsed.data.entries.some(entry => isAfterToday(entry.work_date))) {
    res.status(422).json({ error: 'Future week timesheets and future-dated entries cannot be saved or submitted' });
    return;
  }
  const outOfWeekEntry = parsed.data.entries.find(entry => !isWorkDateInsideWeek(entry.work_date, parsed.data.week_ending));
  if (outOfWeekEntry) {
    res.status(422).json({
      error: `Entry work date ${outOfWeekEntry.work_date} must fall within the seven-day period ending ${parsed.data.week_ending}`,
    });
    return;
  }
  const invalidProjectEntry = parsed.data.entries.find(entry => entry.work_type === 'Project Work' && !entry.project_id);
  if (invalidProjectEntry) {
    res.status(422).json({ error: 'Project Work entries require a project' });
    return;
  }
  const invalidClientEntry = parsed.data.entries.find(entry => entry.work_type === 'Client Misc Task' && !entry.client_name);
  if (invalidClientEntry) {
    res.status(422).json({ error: 'Client Misc Task entries require a client name' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertReportingPeriodAllows(client, {
      organizationId: req.organizationScope.organizationId,
      legalEntityId: req.organizationScope.legalEntityId,
      relevantDates: [parsed.data.week_ending, ...parsed.data.entries.map(entry => entry.work_date)],
      operation: REPORTING_PERIOD_OPERATIONS.CONTENT,
    });
    const employee = (await client.query('select * from employees where id = $1 and organization_id = $2 and legal_entity_id = $3', [parsed.data.employee_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
    if (!employee || employee.status === 'Exited') {
      await client.query('rollback');
      res.status(422).json({ error: 'Timesheet must reference an active employee' });
      return;
    }
    const writeScopeParams = [employee.id];
    const inWriteScope = (await client.query(`
      select 1 from employees e where e.id = $1 and ${buildEmployeeScopeWhere(req, writeScopeParams, 'e')} limit 1
    `, writeScopeParams)).rows[0];
    if (!inWriteScope) {
      await client.query('rollback');
      res.status(403).json({ error: 'Timesheet is outside active-role data scope' });
      return;
    }

    const projectIds = [...new Set(parsed.data.entries.map(entry => entry.project_id).filter(Boolean))];
    if (projectIds.length > 0) {
      const projectResult = await client.query('select id, status from projects where id = any($1::text[]) and organization_id = $2 and legal_entity_id = $3', [projectIds, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
      const activeProjectIds = new Set(projectResult.rows.filter(project => project.status !== 'Completed').map(project => project.id));
      const missingOrClosed = projectIds.find(projectId => !activeProjectIds.has(projectId));
      if (missingOrClosed) {
        await client.query('rollback');
        res.status(422).json({ error: 'Timesheet project entries must reference active, proposed, or on-hold projects' });
        return;
      }
      const unassignedEntry = (await client.query(`
        select input.project_id, input.work_date
        from jsonb_to_recordset($1::jsonb) as input(project_id text, work_date date)
        where input.project_id is not null and not exists (
          select 1 from project_allocations pa
          where pa.employee_id = $2 and pa.project_id = input.project_id
            and pa.organization_id = $3 and pa.legal_entity_id = $4
            and pa.status = 'Active' and input.work_date between pa.start_date and pa.end_date
        )
        limit 1
      `, [JSON.stringify(parsed.data.entries), employee.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (unassignedEntry) {
        await client.query('rollback');
        res.status(422).json({ error: 'Project work requires an active allocation covering the entry date' });
        return;
      }
    }

    const totalHours = round1(parsed.data.entries.reduce((sum, entry) => sum + entry.hours, 0));
    const billableHours = round1(parsed.data.entries.filter(entry => entry.billable).reduce((sum, entry) => sum + entry.hours, 0));
    const previous = (await client.query('select * from timesheets where organization_id = $1 and legal_entity_id = $2 and employee_id = $3 and week_ending = $4 for update', [req.organizationScope.organizationId, req.organizationScope.legalEntityId, parsed.data.employee_id, parsed.data.week_ending])).rows[0];
    if (previous && !['Draft', 'Rejected'].includes(previous.status)) {
      await client.query('rollback');
      res.status(422).json({ error: 'Only draft or rejected timesheets can be edited or submitted' });
      return;
    }
    const timesheetResult = await client.query(`
      insert into timesheets (employee_id, week_ending, status, total_hours, billable_hours, rejection_reason, submitted_at, organization_id, legal_entity_id)
      values ($1,$2,$3,$4,$5,$6, case when $3 = 'Submitted' then now() else null end,$7,$8)
      on conflict (organization_id, employee_id, week_ending) do update set
        status = excluded.status,
        total_hours = excluded.total_hours,
        billable_hours = excluded.billable_hours,
        rejection_reason = excluded.rejection_reason,
        submitted_at = case when excluded.status = 'Submitted' then coalesce(timesheets.submitted_at, now()) else timesheets.submitted_at end,
        updated_at = now()
      returning *
    `, [
      parsed.data.employee_id,
      parsed.data.week_ending,
      parsed.data.status,
      totalHours,
      billableHours,
      parsed.data.rejection_reason || null,
      req.organizationScope.organizationId, req.organizationScope.legalEntityId,
    ]);
    const timesheet = timesheetResult.rows[0];
    await client.query('delete from timesheet_entries where timesheet_id = $1', [timesheet.id]);
    for (const entry of parsed.data.entries) {
      await client.query(`
        insert into timesheet_entries (timesheet_id, project_id, work_type, client_name, category, work_date, hours, remark, billable)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        timesheet.id,
        entry.project_id || null,
        entry.work_type,
        entry.client_name || null,
        entry.category || null,
        entry.work_date,
        round1(entry.hours),
        entry.remark || null,
        entry.billable,
      ]);
    }
    if (parsed.data.status === 'Submitted') {
      await upsertApprovalRecord(client, req, {
        entityType: 'Timesheet',
        entityId: String(timesheet.id),
        subjectEmployeeId: employee.id,
        requesterId: employee.id,
        requesterName: employee.name,
        status: 'Pending',
        source: 'Web',
        dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    await audit(client, req, {
      module: 'Timesheets',
      action: previous ? 'Update Timesheet' : 'Create Timesheet',
      entityType: 'Timesheet',
      entityId: String(timesheet.id),
      oldValue: previous,
      newValue: timesheet,
      details: `${previous ? 'Updated' : 'Created'} ${parsed.data.status} timesheet for ${employee.employee_id}, week ending ${parsed.data.week_ending}`,
      reason: parsed.data.rejection_reason || null,
    });
    await client.query('commit');
    res.json({ ...timesheet, entries: parsed.data.entries });
  } catch (error) {
    await client.query('rollback');
    if (sendReportingPeriodError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Timesheet save failed' });
  } finally {
    client.release();
  }
});

app.patch('/api/timesheets/:id/status', requireDatabase, requireAuth, requirePermission('timesheets.approve'), async (req, res) => {
  const schema = z.object({
    status: z.enum(['Approved', 'Rejected']),
    reason: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.status === 'Rejected' && !parsed.data.reason?.trim()) {
    res.status(422).json({ error: 'Rejected timesheets require a rejection reason' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select t.* from timesheets t join employees e on e.id=t.employee_id where t.id=$1 and t.organization_id=$2 and t.legal_entity_id=$3 and e.legal_entity_id=$3 for update', [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Timesheet not found' });
      return;
    }
    await assertReportingPeriodAllows(client, {
      organizationId: previous.organization_id,
      legalEntityId: previous.legal_entity_id,
      relevantDate: previous.week_ending,
      operation: REPORTING_PERIOD_OPERATIONS.DECISION,
    });
    if (previous.status !== 'Submitted') {
      await client.query('rollback');
      res.status(422).json({ error: 'Only submitted timesheets can be approved or rejected' });
      return;
    }

    if (req.user.activeRole === 'CountryDirector') {
      const scoped = (await client.query(`
        select 1
        from employees e
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where e.id = $1
          and (e.primary_country_director_id = $2 or ecdm.country_director_id = $2)
        limit 1
      `, [previous.employee_id, req.user.countryDirectorId])).rows[0];
      if (!scoped) {
        await client.query('rollback');
        res.status(403).json({ error: 'Country Directors can approve only scoped employee timesheets' });
        return;
      }
    }

    if (req.user.activeRole === 'ProjectManager') {
      const managed = (await client.query(`
        select 1
        from timesheet_entries te
        join projects p on p.id = te.project_id
        where te.timesheet_id = $1
          and (p.manager_id = $2 or p.manager_id = $3)
        limit 1
      `, [req.params.id, req.user.employeeRecordId, req.user.employeeId])).rows[0];
      if (!managed) {
        await client.query('rollback');
        res.status(403).json({ error: 'Project Managers can approve only timesheets containing their projects' });
        return;
      }
    }

    if (req.user.activeRole === 'TeamLead') {
      const directReport = (await client.query(`
        select 1 from employees
        where id = $1 and (reporting_manager_id = $2 or reporting_manager_id = $3)
        limit 1
      `, [previous.employee_id, req.user.employeeRecordId, req.user.employeeId])).rows[0];
      if (!directReport) {
        await client.query('rollback');
        res.status(403).json({ error: 'Team Leads can approve only direct-report timesheets' });
        return;
      }
    }

    const approved = parsed.data.status === 'Approved';
    const result = await client.query(`
      update timesheets
      set status = $2,
        rejection_reason = case when $2 = 'Rejected' then $3 else null end,
        approved_at = case when $2 = 'Approved' then now() else approved_at end,
        approved_by = case when $2 = 'Approved' then $4 else approved_by end,
        rejected_at = case when $2 = 'Rejected' then now() else rejected_at end,
        rejected_by = case when $2 = 'Rejected' then $4 else rejected_by end,
        updated_at = now()
      where id = $1
      returning *
    `, [req.params.id, parsed.data.status, parsed.data.reason || null, req.user.username]);
    await audit(client, req, {
      module: 'Timesheets',
      action: approved ? 'Approve Timesheet' : 'Reject Timesheet',
      entityType: 'Timesheet',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${approved ? 'Approved' : 'Rejected'} timesheet ${req.params.id}`,
      reason: parsed.data.reason,
    });
    await decideApprovalRecord(client, req, {
      entityType: 'Timesheet',
      entityId: req.params.id,
      status: parsed.data.status,
      comments: parsed.data.reason || null,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (sendReportingPeriodError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Timesheet status update failed' });
  } finally {
    client.release();
  }
});

const refreshLeaveBalancesForEmployee = async (client, employeeId, year) => {
  await client.query(`
    update leave_balances lb
    set
      used_days = coalesce((
        select sum(lr.total_days)
        from leave_requests lr
        where lr.employee_id = lb.employee_id
          and lr.leave_type_id = lb.leave_type_id
          and extract(year from lr.start_date)::int = lb.balance_year
          and lr.status = 'Approved'
      ), 0),
      pending_days = coalesce((
        select sum(lr.total_days)
        from leave_requests lr
        where lr.employee_id = lb.employee_id
          and lr.leave_type_id = lb.leave_type_id
          and extract(year from lr.start_date)::int = lb.balance_year
          and lr.status = 'Submitted'
      ), 0),
      available_days = greatest(0,
        lb.opening_days + lb.accrued_days + lb.adjusted_days
        - coalesce((
          select sum(lr.total_days)
          from leave_requests lr
          where lr.employee_id = lb.employee_id
            and lr.leave_type_id = lb.leave_type_id
            and extract(year from lr.start_date)::int = lb.balance_year
            and lr.status = 'Approved'
        ), 0)
        - coalesce((
          select sum(lr.total_days)
          from leave_requests lr
          where lr.employee_id = lb.employee_id
            and lr.leave_type_id = lb.leave_type_id
            and extract(year from lr.start_date)::int = lb.balance_year
            and lr.status = 'Submitted'
        ), 0)
      ),
      updated_at = now()
    where lb.employee_id = $1
      and lb.balance_year = $2
  `, [employeeId, year]);
};

const leaveValidationError = (message, status = 422) => Object.assign(new Error(message), { status });

const getBusinessLeaveDays = async (client, startDate, endDate, employee = {}) => {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const holidayResult = await client.query(`
    select h.holiday_date
    from holidays h
    join holiday_calendars c on c.id = h.calendar_id
    where c.status = 'Active'
      and (lower(c.country) = lower($1) or lower(c.country) = 'global')
      and h.holiday_date between $2::date and $3::date
  `, [employee.country || 'Global', startDate, endDate]);
  const holidays = new Set(holidayResult.rows.map(row => toIsoDate(row.holiday_date)));
  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    const dateValue = cursor.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(dateValue)) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

const getLeaveYear = (dateValue) => Number(toIsoDate(dateValue).slice(0, 4));

const calculateAccruedLeaveDays = (policy, asOfDate) => {
  const annualAllowance = Number(policy?.annual_allowance_days || 0);
  const method = String(policy?.accrual_method || 'Annual').toLowerCase();
  if (method.includes('month') || method.includes('prorat')) {
    const month = new Date(`${asOfDate}T00:00:00`).getMonth() + 1;
    return round1((annualAllowance * month) / 12);
  }
  if (method.includes('manual')) return 0;
  return round1(annualAllowance);
};

const getPolicyLeaveTypeIds = async (client, policyId) => {
  if (!policyId) return [];
  const result = await client.query('select leave_type_id from leave_policy_types where policy_id = $1', [policyId]);
  return result.rows.map(row => row.leave_type_id);
};

const findLeavePolicyForEmployee = async (client, employee) => {
  if (employee.leave_policy_id) {
    const explicit = (await client.query('select * from leave_policies where id = $1 and status = $2', [employee.leave_policy_id, 'Active'])).rows[0];
    if (explicit) return explicit;
  }
  const scoped = (await client.query(`
    select *
    from leave_policies
    where status = 'Active' and lower(country) = lower($1)
    order by updated_at desc nulls last, created_at desc nulls last
    limit 1
  `, [employee.country || 'Global'])).rows[0];
  if (scoped) return scoped;
  return (await client.query(`
    select *
    from leave_policies
    where status = 'Active' and lower(country) = 'global'
    order by updated_at desc nulls last, created_at desc nulls last
    limit 1
  `)).rows[0] || null;
};

const ensureLeaveBalanceForRequest = async (client, employee, leaveTypeId, year, asOfDate) => {
  const leaveType = (await client.query('select * from leave_types where id = $1 and active = true', [leaveTypeId])).rows[0];
  if (!leaveType) throw leaveValidationError('Leave request must reference an active leave type');

  const policy = await findLeavePolicyForEmployee(client, employee);
  if (!policy && leaveType.paid) {
    throw leaveValidationError('Paid leave requires an active leave policy for this employee');
  }

  const policyLeaveTypeIds = await getPolicyLeaveTypeIds(client, policy?.id);
  if (policy && policyLeaveTypeIds.length > 0 && !policyLeaveTypeIds.includes(leaveTypeId)) {
    throw leaveValidationError('Selected leave type is not enabled in the employee leave policy');
  }

  if (!leaveType.paid) return { leaveType, policy, balance: null };

  const accruedDays = calculateAccruedLeaveDays(policy, asOfDate);
  const currentBalance = (await client.query(`
    select *
    from leave_balances
    where employee_id = $1 and leave_type_id = $2 and balance_year = $3
    for update
  `, [employee.id, leaveTypeId, year])).rows[0];

  if (!currentBalance) {
    await client.query(`
      insert into leave_balances (id, employee_id, leave_type_id, policy_id, balance_year, opening_days, accrued_days, used_days, adjusted_days, pending_days, available_days)
      values ('leave-balance-' || gen_random_uuid()::text, $1, $2, $3, $4, 0, $5, 0, 0, 0, $5)
    `, [employee.id, leaveTypeId, policy.id, year, accruedDays]);
  } else if (policy?.id || accruedDays > Number(currentBalance.accrued_days || 0)) {
    await client.query(`
      update leave_balances
      set policy_id = coalesce($4, policy_id),
        accrued_days = greatest(accrued_days, $5),
        updated_at = now()
      where employee_id = $1 and leave_type_id = $2 and balance_year = $3
    `, [employee.id, leaveTypeId, year, policy?.id || null, accruedDays]);
  }

  await refreshLeaveBalancesForEmployee(client, employee.id, year);
  const balance = (await client.query(`
    select *
    from leave_balances
    where employee_id = $1 and leave_type_id = $2 and balance_year = $3
  `, [employee.id, leaveTypeId, year])).rows[0];
  return { leaveType, policy, balance };
};

const leavePolicySelect = `
  select lp.*,
    coalesce(array_agg(lpt.leave_type_id order by lpt.leave_type_id) filter (where lpt.leave_type_id is not null), '{}') as leave_type_ids
  from leave_policies lp
  left join leave_policy_types lpt on lpt.policy_id = lp.id
  group by lp.id
`;

app.get('/api/leave/types', requireDatabase, requireAuth, requirePermission('leave.self_service'), (_req, res) => {
  run(res, 'select * from leave_types order by active desc, name');
});

app.post('/api/leave/types', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    paid: z.boolean().default(true),
    requires_approval: z.boolean().default(true),
    active: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = parsed.data.id ? (await client.query('select * from leave_types where id = $1', [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into leave_types (id, code, name, paid, requires_approval, active)
      values (coalesce($1, 'leave-type-' || gen_random_uuid()::text), upper($2), $3, $4, $5, $6)
      on conflict (id) do update set code = upper(excluded.code), name = excluded.name, paid = excluded.paid,
        requires_approval = excluded.requires_approval, active = excluded.active, updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.code, parsed.data.name, parsed.data.paid, parsed.data.requires_approval, parsed.data.active]);
    await audit(client, req, {
      module: 'Leave',
      action: previous ? 'Update Leave Type' : 'Create Leave Type',
      entityType: 'LeaveType',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} leave type ${result.rows[0].name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Leave type save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/leave/policies', requireDatabase, requireAuth, requirePermission('leave.self_service'), (_req, res) => {
  run(res, `${leavePolicySelect} order by lp.status desc, lp.name`);
});

app.post('/api/leave/policies', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    country: z.string().min(1).default('Global'),
    annual_allowance_days: z.number().min(0).max(366),
    carry_forward_days: z.number().min(0).max(366).default(0),
    accrual_method: z.string().default('Annual'),
    status: z.enum(['Active', 'Inactive']).default('Active'),
    leave_type_ids: z.array(z.string()).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = parsed.data.id ? (await client.query(`${leavePolicySelect} having lp.id = $1`, [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into leave_policies (id, name, country, annual_allowance_days, carry_forward_days, accrual_method, status)
      values (coalesce($1, 'leave-policy-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7)
      on conflict (id) do update set name = excluded.name, country = excluded.country,
        annual_allowance_days = excluded.annual_allowance_days, carry_forward_days = excluded.carry_forward_days,
        accrual_method = excluded.accrual_method, status = excluded.status, updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.name, parsed.data.country, parsed.data.annual_allowance_days, parsed.data.carry_forward_days, parsed.data.accrual_method, parsed.data.status]);
    await client.query('delete from leave_policy_types where policy_id = $1', [result.rows[0].id]);
    for (const leaveTypeId of parsed.data.leave_type_ids) {
      await client.query('insert into leave_policy_types (policy_id, leave_type_id) values ($1, $2) on conflict do nothing', [result.rows[0].id, leaveTypeId]);
    }
    const next = (await client.query(`${leavePolicySelect} having lp.id = $1`, [result.rows[0].id])).rows[0];
    await audit(client, req, {
      module: 'Leave',
      action: previous ? 'Update Leave Policy' : 'Create Leave Policy',
      entityType: 'LeavePolicy',
      entityId: next.id,
      oldValue: previous,
      newValue: next,
      details: `${previous ? 'Updated' : 'Created'} leave policy ${next.name}`,
    });
    await client.query('commit');
    res.json(next);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Leave policy save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/holiday-calendars', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (_req, res) => {
  try {
    const result = await pool.query(`
      select hc.*,
        coalesce(json_agg(json_build_object('id', h.id, 'calendar_id', h.calendar_id, 'name', h.name, 'holiday_date', h.holiday_date, 'holiday_type', h.holiday_type) order by h.holiday_date)
          filter (where h.id is not null), '[]') as holidays
      from holiday_calendars hc
      left join holidays h on h.calendar_id = hc.id
      group by hc.id
      order by hc.calendar_year desc, hc.country, hc.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Holiday calendar load failed' });
  }
});

app.post('/api/holiday-calendars', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    country: z.string().min(1).default('Global'),
    year: z.number().int().min(2000).max(2100),
    status: z.enum(['Active', 'Inactive']).default('Active'),
    holidays: z.array(z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      date: z.string().min(10),
      type: z.string().default('Public'),
    })).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = parsed.data.id ? (await client.query('select * from holiday_calendars where id = $1', [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into holiday_calendars (id, name, country, calendar_year, status)
      values (coalesce($1, 'holiday-calendar-' || gen_random_uuid()::text), $2, $3, $4, $5)
      on conflict (id) do update set name = excluded.name, country = excluded.country,
        calendar_year = excluded.calendar_year, status = excluded.status, updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.name, parsed.data.country, parsed.data.year, parsed.data.status]);
    await client.query('delete from holidays where calendar_id = $1', [result.rows[0].id]);
    for (const holiday of parsed.data.holidays) {
      await client.query(`
        insert into holidays (id, calendar_id, name, holiday_date, holiday_type)
        values (coalesce($1, 'holiday-' || gen_random_uuid()::text), $2, $3, $4, $5)
      `, [holiday.id || null, result.rows[0].id, holiday.name, holiday.date, holiday.type]);
    }
    await audit(client, req, {
      module: 'Leave',
      action: previous ? 'Update Holiday Calendar' : 'Create Holiday Calendar',
      entityType: 'HolidayCalendar',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: { ...result.rows[0], holidays: parsed.data.holidays },
      details: `${previous ? 'Updated' : 'Created'} holiday calendar ${result.rows[0].name}`,
    });
    await client.query('commit');
    res.json({ ...result.rows[0], holidays: parsed.data.holidays });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Holiday calendar save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/leave/balances', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const params = [];
  const where = buildEmployeeScopeWhere(req, params, 'e');
  await run(res, `
    select lb.*, e.name as employee_name, lt.name as leave_type_name
    from leave_balances lb
    join employees e on e.id = lb.employee_id
    join leave_types lt on lt.id = lb.leave_type_id
    where ${where}
    order by lb.balance_year desc, e.name, lt.name
  `, params);
});

app.post('/api/leave/balances', requireDatabase, requireAuth, requirePermission('leave.admin'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    employee_id: z.string().min(1),
    leave_type_id: z.string().min(1),
    policy_id: z.string().nullable().optional(),
    year: z.number().int().min(2000).max(2100),
    opening_days: z.number().min(0).max(366).default(0),
    accrued_days: z.number().min(0).max(366).default(0),
    adjusted_days: z.number().min(-366).max(366).default(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = parsed.data.id ? (await client.query('select * from leave_balances where id = $1', [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into leave_balances (id, employee_id, leave_type_id, policy_id, balance_year, opening_days, accrued_days, adjusted_days, available_days)
      values (
        coalesce($1, 'leave-balance-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8,
        greatest(0, $6 + $7 + $8)
      )
      on conflict (employee_id, leave_type_id, balance_year) do update set
        policy_id = excluded.policy_id,
        opening_days = excluded.opening_days,
        accrued_days = excluded.accrued_days,
        adjusted_days = excluded.adjusted_days,
        available_days = greatest(0, excluded.opening_days + excluded.accrued_days + excluded.adjusted_days - leave_balances.used_days - leave_balances.pending_days),
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.employee_id, parsed.data.leave_type_id, parsed.data.policy_id || null, parsed.data.year, parsed.data.opening_days, parsed.data.accrued_days, parsed.data.adjusted_days]);
    await refreshLeaveBalancesForEmployee(client, parsed.data.employee_id, parsed.data.year);
    await audit(client, req, {
      module: 'Leave',
      action: previous ? 'Update Leave Balance' : 'Create Leave Balance',
      entityType: 'LeaveBalance',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} leave balance for ${parsed.data.employee_id}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Leave balance save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/leave/requests', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const params = [];
  const where = buildEmployeeScopeWhere(req, params, 'e');
  await run(res, `
    select lr.*, e.name as employee_name, lt.name as leave_type_name
    from leave_requests lr
    join employees e on e.id = lr.employee_id
    join leave_types lt on lt.id = lr.leave_type_id
    where ${where}
    order by lr.start_date desc, lr.created_at desc
  `, params);
});

app.post('/api/leave/requests', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const schema = z.object({
    employee_id: z.string().min(1),
    leave_type_id: z.string().min(1),
    start_date: z.string().min(10),
    end_date: z.string().min(10),
    total_days: z.number().min(0).max(366).optional(),
    reason: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Leave end date must be on or after start date' });
    return;
  }
  const startYear = getLeaveYear(parsed.data.start_date);
  const endYear = getLeaveYear(parsed.data.end_date);
  if (startYear !== endYear) {
    res.status(422).json({ error: 'Leave requests that span calendar years must be split by year' });
    return;
  }
  if (req.user.activeRole === 'Employee' && parsed.data.employee_id !== req.user.employeeRecordId && parsed.data.employee_id !== req.user.employeeId) {
    res.status(403).json({ error: 'Employees can submit leave only for themselves' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const employee = (await client.query('select * from employees where id = $1 or employee_id = $1', [parsed.data.employee_id])).rows[0];
    if (!employee || employee.status === 'Exited') {
      await client.query('rollback');
      res.status(422).json({ error: 'Leave request must reference an active employee' });
      return;
    }
    const totalDays = await getBusinessLeaveDays(client, parsed.data.start_date, parsed.data.end_date, employee);
    if (totalDays <= 0) {
      await client.query('rollback');
      res.status(422).json({ error: 'Leave request must include at least one business day' });
      return;
    }
    const scopeParams = [employee.id];
    const scopedEmployee = (await client.query(`
      select 1
      from employees e
      where e.id = $1 and ${buildEmployeeScopeWhere(req, scopeParams, 'e')}
      limit 1
    `, scopeParams)).rows[0];
    if (!scopedEmployee) {
      await client.query('rollback');
      res.status(403).json({ error: 'Leave request is outside active-role data scope' });
      return;
    }
    const overlapping = (await client.query(`
      select id
      from leave_requests
      where employee_id = $1
        and status in ('Draft', 'Submitted', 'Approved')
        and start_date <= $3::date
        and end_date >= $2::date
      limit 1
    `, [employee.id, parsed.data.start_date, parsed.data.end_date])).rows[0];
    if (overlapping) {
      await client.query('rollback');
      res.status(422).json({ error: 'Leave request overlaps an existing draft, submitted, or approved request' });
      return;
    }
    const { leaveType, balance } = await ensureLeaveBalanceForRequest(client, employee, parsed.data.leave_type_id, startYear, parsed.data.start_date);
    if (leaveType.paid && balance && Number(balance.available_days || 0) < totalDays) {
      await client.query('rollback');
      res.status(422).json({ error: `Insufficient leave balance. Available: ${Number(balance.available_days || 0)} day(s), requested: ${totalDays} day(s)` });
      return;
    }
    const result = await client.query(`
      insert into leave_requests (employee_id, leave_type_id, start_date, end_date, total_days, status, reason, submitted_at)
      values ($1, $2, $3, $4, $5, 'Submitted', $6, now())
      returning *
    `, [employee.id, parsed.data.leave_type_id, parsed.data.start_date, parsed.data.end_date, totalDays, parsed.data.reason || null]);
    await refreshLeaveBalancesForEmployee(client, employee.id, startYear);
    await upsertApprovalRecord(client, req, {
      entityType: 'LeaveRequest',
      entityId: result.rows[0].id,
      subjectEmployeeId: employee.id,
      requesterId: employee.id,
      requesterName: employee.name,
      status: 'Pending',
      source: 'Web',
      dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await audit(client, req, {
      module: 'Leave',
      action: 'Submit Leave',
      entityType: 'LeaveRequest',
      entityId: result.rows[0].id,
      newValue: result.rows[0],
      details: `Submitted leave request for ${employee.employee_id}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Leave request submit failed' });
  } finally {
    client.release();
  }
});

app.patch('/api/leave/requests/:id', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const schema = z.object({
    leave_type_id: z.string().min(1),
    start_date: z.string().min(10),
    end_date: z.string().min(10),
    total_days: z.number().min(0).max(366).optional(),
    reason: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Leave end date must be on or after start date' });
    return;
  }
  const startYear = getLeaveYear(parsed.data.start_date);
  const endYear = getLeaveYear(parsed.data.end_date);
  if (startYear !== endYear) {
    res.status(422).json({ error: 'Leave requests that span calendar years must be split by year' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from leave_requests where id = $1 for update', [req.params.id])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Leave request not found' });
      return;
    }
    if (previous.status !== 'Submitted') {
      await client.query('rollback');
      res.status(422).json({ error: 'Only submitted leave requests can be edited' });
      return;
    }
    const scopeParams = [previous.employee_id];
    const scopedEmployee = (await client.query(`
      select 1
      from employees e
      where e.id = $1 and ${buildEmployeeScopeWhere(req, scopeParams, 'e')}
      limit 1
    `, scopeParams)).rows[0];
    if (!scopedEmployee) {
      await client.query('rollback');
      res.status(403).json({ error: 'Leave request is outside active-role data scope' });
      return;
    }
    const overlapping = (await client.query(`
      select id
      from leave_requests
      where employee_id = $1
        and id <> $4
        and status in ('Draft', 'Submitted', 'Approved')
        and start_date <= $3::date
        and end_date >= $2::date
      limit 1
    `, [previous.employee_id, parsed.data.start_date, parsed.data.end_date, req.params.id])).rows[0];
    if (overlapping) {
      await client.query('rollback');
      res.status(422).json({ error: 'Leave request overlaps an existing draft, submitted, or approved request' });
      return;
    }
    const employee = (await client.query('select * from employees where id = $1', [previous.employee_id])).rows[0];
    const totalDays = await getBusinessLeaveDays(client, parsed.data.start_date, parsed.data.end_date, employee);
    if (totalDays <= 0) {
      await client.query('rollback');
      res.status(422).json({ error: 'Leave request must include at least one business day' });
      return;
    }
    const { leaveType, balance } = await ensureLeaveBalanceForRequest(client, employee, parsed.data.leave_type_id, startYear, parsed.data.start_date);
    const previousDaysAdjustment = previous.leave_type_id === parsed.data.leave_type_id ? Number(previous.total_days || 0) : 0;
    if (leaveType.paid && balance && Number(balance.available_days || 0) + previousDaysAdjustment < totalDays) {
      await client.query('rollback');
      res.status(422).json({ error: `Insufficient leave balance. Available: ${Number(balance.available_days || 0)} day(s), requested: ${totalDays} day(s)` });
      return;
    }
    const result = await client.query(`
      update leave_requests
      set leave_type_id = $2,
        start_date = $3,
        end_date = $4,
        total_days = $5,
        reason = $6,
        updated_at = now()
      where id = $1
      returning *
    `, [req.params.id, parsed.data.leave_type_id, parsed.data.start_date, parsed.data.end_date, totalDays, parsed.data.reason || null]);
    const previousYear = getLeaveYear(previous.start_date);
    await refreshLeaveBalancesForEmployee(client, previous.employee_id, previousYear);
    if (startYear !== previousYear) {
      await refreshLeaveBalancesForEmployee(client, previous.employee_id, startYear);
    }
    await audit(client, req, {
      module: 'Leave',
      action: 'Update Leave',
      entityType: 'LeaveRequest',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Updated leave request ${req.params.id}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Leave request update failed' });
  } finally {
    client.release();
  }
});

app.patch('/api/leave/requests/:id/cancel', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const schema = z.object({
    comments: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from leave_requests where id = $1 for update', [req.params.id])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Leave request not found' });
      return;
    }
    if (!['Submitted', 'Approved'].includes(previous.status)) {
      await client.query('rollback');
      res.status(422).json({ error: 'Only submitted or approved leave requests can be cancelled' });
      return;
    }
    if (previous.employee_id !== req.user.employeeRecordId && previous.employee_id !== req.user.employeeId) {
      await client.query('rollback');
      res.status(403).json({ error: 'Employees can cancel only their own leave requests' });
      return;
    }
    const result = await client.query(`
      update leave_requests
      set status = 'Cancelled',
        comments = $2,
        decided_at = now(),
        updated_at = now()
      where id = $1
      returning *
    `, [req.params.id, parsed.data.comments || null]);
    await refreshLeaveBalancesForEmployee(client, previous.employee_id, getLeaveYear(previous.start_date));
    await decideApprovalRecord(client, req, {
      entityType: 'LeaveRequest',
      entityId: req.params.id,
      status: 'Cancelled',
      comments: parsed.data.comments || null,
    });
    await audit(client, req, {
      module: 'Leave',
      action: 'Cancelled Leave',
      entityType: 'LeaveRequest',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Cancelled leave request ${req.params.id}`,
      reason: parsed.data.comments,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Leave request cancellation failed' });
  } finally {
    client.release();
  }
});

app.patch('/api/leave/requests/:id/status', requireDatabase, requireAuth, requirePermission('leave.approve'), async (req, res) => {
  const schema = z.object({
    status: z.enum(['Approved', 'Rejected', 'Cancelled']),
    comments: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.status === 'Rejected' && !parsed.data.comments?.trim()) {
    res.status(422).json({ error: 'Rejected leave requests require comments' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from leave_requests where id = $1 for update', [req.params.id])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'Leave request not found' });
      return;
    }
    if (parsed.data.status !== 'Cancelled' && previous.status !== 'Submitted') {
      await client.query('rollback');
      res.status(422).json({ error: 'Only submitted leave requests can be decided' });
      return;
    }
    if (parsed.data.status === 'Cancelled' && !['Submitted', 'Approved'].includes(previous.status)) {
      await client.query('rollback');
      res.status(422).json({ error: 'Only submitted or approved leave requests can be cancelled' });
      return;
    }
    const decisionScopeParams = [previous.employee_id];
    const decisionScopedEmployee = (await client.query(`
      select 1
      from employees e
      where e.id = $1 and ${buildEmployeeScopeWhere(req, decisionScopeParams, 'e')}
      limit 1
    `, decisionScopeParams)).rows[0];
    if (!decisionScopedEmployee) {
      await client.query('rollback');
      res.status(403).json({ error: 'Leave request is outside active-role data scope' });
      return;
    }
    if (req.user.activeRole === 'CountryDirector') {
      const scoped = (await client.query(`
        select 1
        from employees e
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where e.id = $1 and (e.primary_country_director_id = $2 or ecdm.country_director_id = $2)
        limit 1
      `, [previous.employee_id, req.user.countryDirectorId])).rows[0];
      if (!scoped) {
        await client.query('rollback');
        res.status(403).json({ error: 'Country Directors can decide only scoped employee leave requests' });
        return;
      }
    }
    if (req.user.activeRole === 'TeamLead') {
      const scoped = (await client.query('select 1 from employees where id = $1 and reporting_manager_id = $2', [previous.employee_id, req.user.employeeRecordId])).rows[0];
      if (!scoped) {
        await client.query('rollback');
        res.status(403).json({ error: 'Team Leads can decide only direct-report leave requests' });
        return;
      }
    }
    const result = await client.query(`
      update leave_requests
      set status = $2,
        comments = $3,
        approver_id = $4,
        approver_name = $5,
        decided_at = now(),
        updated_at = now()
      where id = $1
      returning *
    `, [req.params.id, parsed.data.status, parsed.data.comments || null, req.user.employeeRecordId || req.user.sub, req.user.username]);
    await refreshLeaveBalancesForEmployee(client, previous.employee_id, getLeaveYear(previous.start_date));
    await audit(client, req, {
      module: 'Leave',
      action: `${parsed.data.status} Leave`,
      entityType: 'LeaveRequest',
      entityId: req.params.id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${parsed.data.status} leave request ${req.params.id}`,
      reason: parsed.data.comments,
    });
    await decideApprovalRecord(client, req, {
      entityType: 'LeaveRequest',
      entityId: req.params.id,
      status: parsed.data.status,
      comments: parsed.data.comments || null,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Leave request status update failed' });
  } finally {
    client.release();
  }
});

app.get('/api/reports/availability', requireDatabase, requireAuth, requirePermission('leave.self_service'), async (req, res) => {
  const params = [];
  const where = buildEmployeeScopeWhere(req, params, 'e');
  params.push(new Date().getFullYear());
  const yearParam = `$${params.length}`;
  await run(res, `
    select
      e.id as employee_id,
      e.name as employee_name,
      e.standard_weekly_hours,
      coalesce(l.approved_leave_days, 0)::numeric as approved_leave_days,
      coalesce(h.holiday_days, 0)::numeric as holiday_days,
      greatest(0, (e.standard_weekly_hours * 52) - ((coalesce(l.approved_leave_days, 0) + coalesce(h.holiday_days, 0)) * (e.standard_weekly_hours / 5)))::numeric as availability_hours
    from employees e
    left join (
      select employee_id, sum(total_days) as approved_leave_days
      from leave_requests
      where status = 'Approved' and extract(year from start_date)::int = ${yearParam}
      group by employee_id
    ) l on l.employee_id = e.id
    left join lateral (
      select count(*) as holiday_days
      from holiday_calendars hc
      join holidays h on h.calendar_id = hc.id
      where hc.status = 'Active'
        and hc.calendar_year = ${yearParam}
        and (hc.country = e.country or hc.country = 'Global')
    ) h on true
    where e.status <> 'Exited' and ${where}
    order by e.name
  `, params);
});

const buildApprovalScopeWhere = (req, params) => {
  if (isGlobalRole(req)) return 'true';
  params.push(req.user.employeeRecordId);
  const delegateParam = `$${params.length}`;
  const delegatedScope = `exists (
    select 1
    from approval_delegations ad
    where ad.delegate_id = ${delegateParam}
      and ad.status = 'Active'
      and current_date between ad.start_date and ad.end_date
      and (e.id = ad.delegator_id or e.reporting_manager_id = ad.delegator_id)
  )`;
  if (req.user.activeRole === 'TeamLead') {
    params.push(req.user.employeeRecordId, req.user.employeeId);
    return `((e.id = $${params.length - 1} or e.employee_id = $${params.length} or e.reporting_manager_id = $${params.length - 1}) or ${delegatedScope})`;
  }
  return `(${buildEmployeeScopeWhere(req, params, 'e')} or ${delegatedScope})`;
};

const approvalSelect = `
  select ar.*, e.name as subject_employee_name
  from approval_records ar
  left join employees e on e.id = ar.subject_employee_id
`;

app.get('/api/approvals', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const params = [];
  const where = buildApprovalScopeWhere(req, params);
  await run(res, `
    ${approvalSelect}
    where ${where}
    order by case when ar.status = 'Pending' then 0 else 1 end, ar.created_at desc
  `, params);
});

app.patch('/api/approvals/:id/status', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const schema = z.object({
    status: z.enum(['Approved', 'Rejected', 'Cancelled']),
    comments: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.status === 'Rejected' && !parsed.data.comments?.trim()) {
    res.status(422).json({ error: 'Rejected approvals require comments' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const approval = (await client.query('select * from approval_records where id = $1 for update', [req.params.id])).rows[0];
    if (!approval) {
      await client.query('rollback');
      res.status(404).json({ error: 'Approval record not found' });
      return;
    }
    if (approval.status !== 'Pending') {
      await client.query('rollback');
      res.status(422).json({ error: 'Only pending approvals can be decided' });
      return;
    }

    const scopeParams = [approval.subject_employee_id];
    const scoped = (await client.query(`
      select e.name as subject_employee_name
      from employees e
      where e.id = $1 and ${buildApprovalScopeWhere(req, scopeParams)}
      limit 1
    `, scopeParams)).rows[0];
    if (!scoped) {
      await client.query('rollback');
      res.status(403).json({ error: 'Approval is outside active-role data scope' });
      return;
    }
    approval.subject_employee_name = scoped.subject_employee_name;
    const actorEmployeeIds = new Set([req.user.employeeRecordId, req.user.employeeId].filter(Boolean).map(String));
    if (
      parsed.data.status !== 'Cancelled' &&
      (actorEmployeeIds.has(String(approval.requester_id)) || actorEmployeeIds.has(String(approval.subject_employee_id)))
    ) {
      await client.query('rollback');
      res.status(403).json({ error: 'Users cannot decide their own approval requests' });
      return;
    }

    if (approval.entity_type === 'Timesheet') {
      const previous = (await client.query('select * from timesheets where id=$1 and organization_id=$2 and legal_entity_id=$3 for update', [approval.entity_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (!previous || previous.status !== 'Submitted') {
        await client.query('rollback');
        res.status(422).json({ error: 'Linked timesheet is not submitted' });
        return;
      }
      await assertReportingPeriodAllows(client, {
        organizationId: previous.organization_id,
        legalEntityId: previous.legal_entity_id,
        relevantDate: previous.week_ending,
        operation: REPORTING_PERIOD_OPERATIONS.DECISION,
      });
      const nextStatus = parsed.data.status === 'Approved' ? 'Approved' : 'Rejected';
      await client.query(`
        update timesheets
        set status = $2,
          rejection_reason = case when $2 = 'Rejected' then $3 else null end,
          approved_at = case when $2 = 'Approved' then now() else approved_at end,
          approved_by = case when $2 = 'Approved' then $4 else approved_by end,
          rejected_at = case when $2 = 'Rejected' then now() else rejected_at end,
          rejected_by = case when $2 = 'Rejected' then $4 else rejected_by end,
          updated_at = now()
        where id = $1
      `, [approval.entity_id, nextStatus, parsed.data.comments || null, req.user.username]);
    }

    if (approval.entity_type === 'LeaveRequest') {
      const previous = (await client.query('select * from leave_requests where id = $1 for update', [approval.entity_id])).rows[0];
      if (!previous || previous.status !== 'Submitted') {
        await client.query('rollback');
        res.status(422).json({ error: 'Linked leave request is not submitted' });
        return;
      }
      await client.query(`
        update leave_requests
        set status = $2,
          comments = $3,
          approver_id = $4,
          approver_name = $5,
          decided_at = now(),
          updated_at = now()
        where id = $1
      `, [approval.entity_id, parsed.data.status, parsed.data.comments || null, req.user.employeeRecordId || req.user.sub, req.user.username]);
      await refreshLeaveBalancesForEmployee(client, previous.employee_id, getLeaveYear(previous.start_date));
    }

    const nextApproval = await decideApprovalRecord(client, req, {
      entityType: approval.entity_type,
      entityId: approval.entity_id,
      status: parsed.data.status,
      comments: parsed.data.comments || null,
    });
    await audit(client, req, {
      module: 'Approvals',
      action: `${parsed.data.status} Approval`,
      entityType: 'ApprovalRecord',
      entityId: req.params.id,
      oldValue: approval,
      newValue: nextApproval,
      details: `${parsed.data.status} ${approval.entity_type} approval ${req.params.id}`,
      reason: parsed.data.comments,
    });
    await client.query('commit');
    res.json(nextApproval);
  } catch (error) {
    await client.query('rollback');
    if (sendReportingPeriodError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Approval status update failed' });
  } finally {
    client.release();
  }
});

app.get('/api/approval-delegations', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const params = [];
  let where = 'true';
  if (!isGlobalRole(req)) {
    params.push(req.user.employeeRecordId);
    where = '(ad.delegator_id = $1 or ad.delegate_id = $1)';
  }
  await run(res, `
    select ad.*, delegator.name as delegator_name, delegate.name as delegate_name
    from approval_delegations ad
    left join employees delegator on delegator.id = ad.delegator_id
    left join employees delegate on delegate.id = ad.delegate_id
    where ${where}
    order by ad.status desc, ad.start_date desc
  `, params);
});

app.post('/api/approval-delegations', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    delegator_id: z.string().min(1),
    delegate_id: z.string().min(1),
    role: z.string().min(1),
    start_date: z.string().min(10),
    end_date: z.string().min(10),
    status: z.enum(['Active', 'Inactive']).default('Active'),
    reason: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.end_date < parsed.data.start_date) {
    res.status(422).json({ error: 'Delegation end date must be on or after start date' });
    return;
  }
  if (parsed.data.delegator_id === parsed.data.delegate_id) {
    res.status(422).json({ error: 'Delegator and delegate must be different employees' });
    return;
  }
  if (!isGlobalRole(req) && parsed.data.delegator_id !== req.user.employeeRecordId) {
    res.status(403).json({ error: 'Users can create delegations only for themselves' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const people = (await client.query(`
      select id, status
      from employees
      where id in ($1, $2)
    `, [parsed.data.delegator_id, parsed.data.delegate_id])).rows;
    const delegator = people.find(row => row.id === parsed.data.delegator_id);
    const delegate = people.find(row => row.id === parsed.data.delegate_id);
    if (!delegator || !delegate || delegator.status === 'Exited' || delegate.status === 'Exited') {
      await client.query('rollback');
      res.status(422).json({ error: 'Delegation requires active delegator and delegate employees' });
      return;
    }
    const overlapping = (await client.query(`
      select id
      from approval_delegations
      where id <> coalesce($1, '')
        and delegator_id = $2
        and delegate_id = $3
        and status = 'Active'
        and start_date <= $5::date
        and end_date >= $4::date
      limit 1
    `, [parsed.data.id || null, parsed.data.delegator_id, parsed.data.delegate_id, parsed.data.start_date, parsed.data.end_date])).rows[0];
    if (overlapping && parsed.data.status === 'Active') {
      await client.query('rollback');
      res.status(422).json({ error: 'An active approval delegation already overlaps this date range' });
      return;
    }
    const previous = parsed.data.id ? (await client.query('select * from approval_delegations where id = $1', [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into approval_delegations (id, delegator_id, delegate_id, role, start_date, end_date, status, reason)
      values (coalesce($1, 'approval-delegation-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8)
      on conflict (id) do update set
        delegator_id = excluded.delegator_id,
        delegate_id = excluded.delegate_id,
        role = excluded.role,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.delegator_id, parsed.data.delegate_id, parsed.data.role, parsed.data.start_date, parsed.data.end_date, parsed.data.status, parsed.data.reason || null]);
    await audit(client, req, {
      module: 'Approvals',
      action: previous ? 'Update Approval Delegation' : 'Create Approval Delegation',
      entityType: 'ApprovalDelegation',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} approval delegation ${result.rows[0].id}`,
      reason: parsed.data.reason,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Approval delegation save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/reports/approval-sla', requireDatabase, requireAuth, requirePermission('approvals.view'), async (req, res) => {
  const params = [];
  const where = buildApprovalScopeWhere(req, params);
  try {
    const rows = (await pool.query(`
      ${approvalSelect}
      where ${where}
      order by ar.created_at desc
    `, params)).rows;
    const pending = rows.filter(row => row.status === 'Pending');
    const now = Date.now();
    const ages = pending.map(row => Math.max(0, (now - new Date(row.created_at).getTime()) / 36e5));
    res.json({
      generatedAt: new Date().toISOString(),
      pendingCount: pending.length,
      overdueCount: pending.filter(row => row.due_at && new Date(row.due_at).getTime() < now).length,
      averageAgeHours: ages.length ? round1(ages.reduce((sum, age) => sum + age, 0) / ages.length) : 0,
      rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Approval SLA report failed' });
  }
});

app.get('/api/notifications', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
  const params = [];
  const where = buildEmployeeScopeWhere(req, params, 'e');
  await run(res, `
    select ne.*, e.name as recipient_name
    from notification_events ne
    left join employees e on e.id = ne.recipient_employee_id
    where ${where}
    order by ne.created_at desc
    limit 300
  `, params);
});

app.patch('/api/notifications/:id/read', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
  try {
    const params = [req.params.id];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    const result = await pool.query(`
      update notification_events ne
      set read_at = coalesce(read_at, now())
      from employees e
      where ne.id = $1 and e.id = ne.recipient_employee_id and ${where}
      returning ne.*
    `, params);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Notification read update failed' });
  }
});

app.get('/api/notification-templates', requireDatabase, requireAuth, requirePermission('notifications.manage'), (_req, res) => {
  run(res, 'select * from notification_templates order by event_type, channel');
});

app.post('/api/notification-templates', requireDatabase, requireAuth, requirePermission('notifications.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    event_type: z.string().min(1),
    channel: z.enum(['InApp', 'Email', 'Teams']),
    subject: z.string().min(1),
    body: z.string().min(1),
    active: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = parsed.data.id ? (await client.query('select * from notification_templates where id = $1', [parsed.data.id])).rows[0] : null;
    const result = await client.query(`
      insert into notification_templates (id, event_type, channel, subject, body, active)
      values (coalesce($1, 'notification-template-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
      on conflict (event_type, channel) do update set
        subject = excluded.subject,
        body = excluded.body,
        active = excluded.active,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.event_type, parsed.data.channel, parsed.data.subject, parsed.data.body, parsed.data.active]);
    await audit(client, req, {
      module: 'Notifications',
      action: previous ? 'Update Notification Template' : 'Create Notification Template',
      entityType: 'NotificationTemplate',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} notification template ${result.rows[0].event_type}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Notification template save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/notification-preferences', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
  const params = [];
  const where = buildEmployeeScopeWhere(req, params, 'e');
  await run(res, `
    select np.*, e.name as employee_name
    from notification_preferences np
    join employees e on e.id = np.employee_id
    where ${where}
    order by e.name, np.event_type
  `, params);
});

app.post('/api/notification-preferences', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    employee_id: z.string().min(1),
    event_type: z.string().min(1),
    in_app: z.boolean().default(true),
    email: z.boolean().default(false),
    teams: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (req.user.activeRole === 'Employee' && parsed.data.employee_id !== req.user.employeeRecordId && parsed.data.employee_id !== req.user.employeeId) {
    res.status(403).json({ error: 'Employees can update only their own notification preferences' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const scopeParams = [parsed.data.employee_id];
    const scopeWhere = buildEmployeeScopeWhere(req, scopeParams, 'e');
    const targetEmployee = (await client.query(`
      select e.*
      from employees e
      where (e.id = $1 or e.employee_id = $1) and ${scopeWhere}
      limit 1
    `, scopeParams)).rows[0];
    if (!targetEmployee) {
      await client.query('rollback');
      res.status(403).json({ error: 'Notification preference is outside active-role data scope' });
      return;
    }
    const previous = (await client.query('select * from notification_preferences where employee_id = $1 and event_type = $2', [targetEmployee.id, parsed.data.event_type])).rows[0];
    const result = await client.query(`
      insert into notification_preferences (id, employee_id, event_type, in_app, email, teams)
      values (coalesce($1, 'notification-preference-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
      on conflict (employee_id, event_type) do update set
        in_app = excluded.in_app,
        email = excluded.email,
        teams = excluded.teams,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, targetEmployee.id, parsed.data.event_type, parsed.data.in_app, parsed.data.email, parsed.data.teams]);
    await audit(client, req, {
      module: 'Notifications',
      action: 'Update Notification Preference',
      entityType: 'NotificationPreference',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `Updated notification preference ${result.rows[0].event_type}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Notification preference save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/notification-delivery-attempts', requireDatabase, requireAuth, requirePermission('notifications.manage'), (_req, res) => {
  run(res, 'select * from notification_delivery_attempts order by attempted_at desc limit 300');
});

app.post('/api/notifications/test-delivery', requireDatabase, requireAuth, requirePermission('notifications.manage'), async (req, res) => {
  const schema = z.object({
    employee_id: z.string().min(1),
    channels: z.array(z.enum(['InApp', 'Email', 'Teams'])).min(1).default(['InApp']),
    title: z.string().min(1).default('Configured product notification test'),
    body: z.string().min(1).default('This validates configured notification delivery from Configured product.'),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const scopeParams = [parsed.data.employee_id];
    const scopeWhere = buildEmployeeScopeWhere(req, scopeParams, 'e');
    const targetEmployee = (await client.query(`
      select e.*
      from employees e
      where (e.id = $1 or e.employee_id = $1) and ${scopeWhere}
      limit 1
    `, scopeParams)).rows[0];
    if (!targetEmployee) {
      await client.query('rollback');
      res.status(403).json({ error: 'Notification test recipient is outside active-role data scope' });
      return;
    }
    const event = await sendNotification(client, req, {
      recipientEmployeeId: targetEmployee.id,
      eventType: 'TestDelivery',
      title: parsed.data.title,
      body: parsed.data.body,
      entityType: 'NotificationTest',
      entityId: targetEmployee.id,
      severity: 'Info',
      channels: parsed.data.channels,
      actionUrl: process.env.APP_URL || null,
    });
    await client.query('commit');
    res.json(event);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Notification test delivery failed' });
  } finally {
    client.release();
  }
});

const logIntegrationEvent = async (client, {
  provider,
  eventType,
  entityType = null,
  entityId = null,
  status = 'Success',
  requestPayload = null,
  responsePayload = null,
}) => {
  const result = await client.query(`
    insert into integration_event_logs (provider, event_type, entity_type, entity_id, status, request_payload, response_payload)
    values ($1,$2,$3,$4,$5,$6,$7)
    returning *
  `, [provider, eventType, entityType, entityId, status, requestPayload ? JSON.stringify(requestPayload) : null, responsePayload ? JSON.stringify(responsePayload) : null]);
  return result.rows[0];
};

const isTeamsActionEntityInScope = async (client, req, entityType, entityId) => {
  if (entityType === 'PortalLink') return true;

  if (entityType === 'ApprovalRecord') {
    const params = [entityId];
    const where = buildApprovalScopeWhere(req, params);
    const result = await client.query(`
      ${approvalSelect}
      where ar.id = $1 and ${where}
      limit 1
    `, params);
    return Boolean(result.rows[0]);
  }

  if (entityType === 'LeaveRequest') {
    const params = [entityId];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    const result = await client.query(`
      select 1
      from leave_requests lr
      join employees e on e.id = lr.employee_id
      where lr.id = $1 and ${where}
      limit 1
    `, params);
    return Boolean(result.rows[0]);
  }

  if (entityType === 'Timesheet') {
    const params = [entityId];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    const result = await client.query(`
      select 1
      from timesheets t
      join employees e on e.id = t.employee_id
      where t.id = $1 and ${where}
      limit 1
    `, params);
    return Boolean(result.rows[0]);
  }

  return false;
};

app.get('/api/integrations/identity-links', requireDatabase, requireAuth, requirePermission('integrations.identity'), (req, res) => {
  run(res, `
    select ipl.*, e.name as employee_name
    from identity_provider_links ipl
    join employees e on e.id = ipl.employee_id
    where e.organization_id = $1 and e.legal_entity_id = $2
    order by e.name, ipl.provider
  `, [req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
});

app.post('/api/integrations/identity-links', requireDatabase, requireAuth, requirePermission('integrations.identity'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    employee_id: z.string().min(1),
    provider: z.enum(['local', 'entra']).default('entra'),
    provider_subject: z.string().min(1),
    provider_upn: z.string().optional().nullable(),
    status: z.enum(['Linked', 'Pending', 'Disabled']).default('Linked'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const employee = (await client.query(
      'select id from employees where id = $1 and organization_id = $2 and legal_entity_id = $3 for update',
      [parsed.data.employee_id, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    )).rows[0];
    if (!employee) {
      await client.query('rollback');
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    const previous = (await client.query(
      `select ipl.* from identity_provider_links ipl
       join employees e on e.id = ipl.employee_id
       where ipl.employee_id = $1 and ipl.provider = $2
         and e.organization_id = $3 and e.legal_entity_id = $4
       for update`,
      [employee.id, parsed.data.provider, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    )).rows[0];
    if (parsed.data.id && previous && parsed.data.id !== previous.id) {
      await client.query('rollback');
      res.status(404).json({ error: 'Identity link not found' });
      return;
    }
    if (parsed.data.id && !previous) {
      const conflictingLink = (await client.query('select 1 from identity_provider_links where id = $1', [parsed.data.id])).rows[0];
      if (conflictingLink) {
        await client.query('rollback');
        res.status(404).json({ error: 'Identity link not found' });
        return;
      }
    }
    const result = await client.query(`
      insert into identity_provider_links (id, employee_id, provider, provider_subject, provider_upn, status)
      values (coalesce($1, 'identity-link-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
      on conflict (employee_id, provider) do update set
        provider_subject = excluded.provider_subject,
        provider_upn = excluded.provider_upn,
        status = excluded.status,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, employee.id, parsed.data.provider, parsed.data.provider_subject, parsed.data.provider_upn || null, parsed.data.status]);
    await client.query(
      'update employees set entra_object_id = $2, updated_at = now() where id = $1 and organization_id = $3 and legal_entity_id = $4',
      [employee.id, parsed.data.provider_subject, req.organizationScope.organizationId, req.organizationScope.legalEntityId]
    );
    await logIntegrationEvent(client, {
      provider: parsed.data.provider,
      eventType: 'IdentityLinkUpserted',
      entityType: 'IdentityProviderLink',
      entityId: result.rows[0].id,
      responsePayload: result.rows[0],
    });
    await audit(client, req, {
      module: 'Integrations',
      action: previous ? 'Update Identity Link' : 'Create Identity Link',
      entityType: 'IdentityProviderLink',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} ${parsed.data.provider} identity link`,
      source: 'System',
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Identity link save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/integrations/entra-role-mappings', requireDatabase, requireAuth, requirePermission('integrations.identity'), (_req, res) => {
  run(res, 'select * from entra_group_role_mappings order by role_name, group_name');
});

app.post('/api/integrations/entra-role-mappings', requireDatabase, requireAuth, requirePermission('integrations.identity'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    group_id: z.string().min(1),
    group_name: z.string().min(1),
    role_name: z.enum(['Employee', 'TeamLead', 'ProjectManager', 'CountryDirector', 'HR', 'Admin']),
    active: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from entra_group_role_mappings where group_id = $1', [parsed.data.group_id])).rows[0];
    const result = await client.query(`
      insert into entra_group_role_mappings (id, group_id, group_name, role_name, active)
      values (coalesce($1, 'entra-role-map-' || gen_random_uuid()::text), $2, $3, $4, $5)
      on conflict (group_id) do update set
        group_name = excluded.group_name,
        role_name = excluded.role_name,
        active = excluded.active,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.group_id, parsed.data.group_name, parsed.data.role_name, parsed.data.active]);
    await logIntegrationEvent(client, {
      provider: 'entra',
      eventType: 'RoleMappingUpserted',
      entityType: 'EntraRoleMapping',
      entityId: result.rows[0].id,
      responsePayload: result.rows[0],
    });
    await audit(client, req, {
      module: 'Integrations',
      action: previous ? 'Update Entra Role Mapping' : 'Create Entra Role Mapping',
      entityType: 'EntraRoleMapping',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} Entra mapping for ${parsed.data.role_name}`,
      source: 'System',
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Entra role mapping save failed' });
  } finally {
    client.release();
  }
});

app.get('/api/integrations/teams-user-links', requireDatabase, requireAuth, requirePermission('integrations.teams'), (_req, res) => {
  run(res, `
    select tul.*, e.name as employee_name
    from teams_user_links tul
    join employees e on e.id = tul.employee_id
    order by e.name
  `);
});

app.post('/api/integrations/teams-user-links', requireDatabase, requireAuth, requirePermission('integrations.teams'), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    employee_id: z.string().min(1),
    teams_user_id: z.string().min(1),
    teams_upn: z.string().optional().nullable(),
    teams_tenant_id: z.string().optional().nullable(),
    status: z.enum(['Linked', 'Pending', 'Disabled']).default('Linked'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from teams_user_links where employee_id = $1', [parsed.data.employee_id])).rows[0];
    const result = await client.query(`
      insert into teams_user_links (id, employee_id, teams_user_id, teams_upn, teams_tenant_id, status)
      values (coalesce($1, 'teams-link-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
      on conflict (employee_id) do update set
        teams_user_id = excluded.teams_user_id,
        teams_upn = excluded.teams_upn,
        teams_tenant_id = excluded.teams_tenant_id,
        status = excluded.status,
        updated_at = now()
      returning *
    `, [parsed.data.id || null, parsed.data.employee_id, parsed.data.teams_user_id, parsed.data.teams_upn || null, parsed.data.teams_tenant_id || null, parsed.data.status]);
    await client.query('update employees set teams_user_id = $2, updated_at = now() where id = $1', [parsed.data.employee_id, parsed.data.teams_user_id]);
    await logIntegrationEvent(client, {
      provider: 'teams',
      eventType: 'TeamsUserLinkUpserted',
      entityType: 'TeamsUserLink',
      entityId: result.rows[0].id,
      responsePayload: result.rows[0],
    });
    await audit(client, req, {
      module: 'Integrations',
      action: previous ? 'Update Teams User Link' : 'Create Teams User Link',
      entityType: 'TeamsUserLink',
      entityId: result.rows[0].id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} Teams user link`,
      source: 'System',
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Teams user link save failed' });
  } finally {
    client.release();
  }
});

app.post('/api/integrations/teams-action-tokens', requireDatabase, requireAuth, requirePermission('integrations.teams_actions'), async (req, res) => {
  const schema = z.object({
    entity_type: z.enum(['ApprovalRecord', 'LeaveRequest', 'Timesheet', 'PortalLink']),
    entity_id: z.string().min(1),
    action: z.enum(['approve', 'reject', 'open_portal']),
    target_url: z.string().optional().nullable(),
    expires_at: z.string().datetime(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const inScope = await isTeamsActionEntityInScope(client, req, parsed.data.entity_type, parsed.data.entity_id);
    if (!inScope) {
      await client.query('rollback');
      res.status(403).json({ error: 'Teams action target is outside active-role data scope' });
      return;
    }
    const token = crypto.randomUUID();
    const result = await client.query(`
      insert into teams_action_tokens (token, entity_type, entity_id, action, target_url, expires_at, created_by)
      values ($1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [token, parsed.data.entity_type, parsed.data.entity_id, parsed.data.action, parsed.data.target_url || null, parsed.data.expires_at, req.user.sub]);
    const responseToken = { ...result.rows[0], action_url: buildTeamsActionUrl(token) };
    await logIntegrationEvent(client, {
      provider: 'teams',
      eventType: 'TeamsActionTokenCreated',
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      responsePayload: { action: parsed.data.action, actionUrl: responseToken.action_url, deterministic: true },
    });
    await audit(client, req, {
      module: 'Integrations',
      action: 'Create Teams Action Token',
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      newValue: { action: parsed.data.action, expires_at: parsed.data.expires_at },
      details: `Created deterministic Teams ${parsed.data.action} action token`,
      source: 'Teams',
    });
    await client.query('commit');
    res.json(responseToken);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Teams action token creation failed' });
  } finally {
    client.release();
  }
});

app.post('/api/integrations/teams-action-tokens/:token/execute', requireDatabase, requireAuth, requirePermission('integrations.teams_actions'), async (req, res) => {
  const schema = z.object({ comments: z.string().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const lookup = await client.query('select * from teams_action_tokens where token = $1 for update', [req.params.token]);
    const actionToken = lookup.rows[0];
    if (!actionToken) {
      await client.query('rollback');
      res.status(404).json({ error: 'Teams action token not found' });
      return;
    }
    if (actionToken.used_at) {
      await client.query('rollback');
      res.status(409).json({ error: 'Teams action token was already used' });
      return;
    }
    if (new Date(actionToken.expires_at).getTime() < Date.now()) {
      await client.query('rollback');
      res.status(410).json({ error: 'Teams action token expired' });
      return;
    }
    const inScope = await isTeamsActionEntityInScope(client, req, actionToken.entity_type, actionToken.entity_id);
    if (!inScope) {
      await client.query('rollback');
      res.status(403).json({ error: 'Teams action target is outside active-role data scope' });
      return;
    }
    if (actionToken.entity_type === 'ApprovalRecord' && ['approve', 'reject'].includes(actionToken.action)) {
      const approval = await client.query('select * from approval_records where id = $1', [actionToken.entity_id]);
      if (!approval.rows[0]) {
        await client.query('rollback');
        res.status(404).json({ error: 'Approval record not found' });
        return;
      }
      await decideApprovalRecord(client, req, {
        entityType: approval.rows[0].entity_type,
        entityId: approval.rows[0].entity_id,
        status: actionToken.action === 'approve' ? 'Approved' : 'Rejected',
        comments: parsed.data.comments || 'Decided from deterministic Teams action.',
      });
    }
    const result = await client.query('update teams_action_tokens set used_at = now() where id = $1 returning *', [actionToken.id]);
    await logIntegrationEvent(client, {
      provider: 'teams',
      eventType: 'TeamsActionTokenExecuted',
      entityType: actionToken.entity_type,
      entityId: actionToken.entity_id,
      requestPayload: { action: actionToken.action },
      responsePayload: { deterministic: true },
    });
    await audit(client, req, {
      module: 'Integrations',
      action: 'Execute Teams Action Token',
      entityType: actionToken.entity_type,
      entityId: actionToken.entity_id,
      newValue: { action: actionToken.action, used_at: result.rows[0].used_at },
      details: `Executed deterministic Teams ${actionToken.action} action`,
      source: 'Teams',
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Teams action execution failed' });
  } finally {
    client.release();
  }
});

app.post('/api/integrations/teams-action-tokens/:token/send', requireDatabase, requireAuth, requirePermission('integrations.teams_actions'), async (req, res) => {
  const schema = z.object({
    recipient_employee_id: z.string().min(1),
    title: z.string().min(1).default('Configured product action required'),
    body: z.string().min(1).default('Open Configured product to complete this Teams action.'),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const actionToken = (await client.query('select * from teams_action_tokens where token = $1', [req.params.token])).rows[0];
    if (!actionToken) {
      await client.query('rollback');
      res.status(404).json({ error: 'Teams action token not found' });
      return;
    }
    if (actionToken.used_at) {
      await client.query('rollback');
      res.status(409).json({ error: 'Teams action token was already used' });
      return;
    }
    if (new Date(actionToken.expires_at).getTime() < Date.now()) {
      await client.query('rollback');
      res.status(410).json({ error: 'Teams action token expired' });
      return;
    }
    const actionInScope = await isTeamsActionEntityInScope(client, req, actionToken.entity_type, actionToken.entity_id);
    if (!actionInScope) {
      await client.query('rollback');
      res.status(403).json({ error: 'Teams action target is outside active-role data scope' });
      return;
    }
    const scopeParams = [parsed.data.recipient_employee_id];
    const scopeWhere = buildEmployeeScopeWhere(req, scopeParams, 'e');
    const recipient = (await client.query(`
      select e.*
      from employees e
      where (e.id = $1 or e.employee_id = $1) and ${scopeWhere}
      limit 1
    `, scopeParams)).rows[0];
    if (!recipient) {
      await client.query('rollback');
      res.status(403).json({ error: 'Teams action recipient is outside active-role data scope' });
      return;
    }
    const actionUrl = buildTeamsActionUrl(actionToken.token);
    const event = await sendNotification(client, req, {
      recipientEmployeeId: recipient.id,
      eventType: 'TeamsAction',
      title: parsed.data.title,
      body: `${parsed.data.body}\n\nAction link: ${actionUrl}`,
      entityType: actionToken.entity_type,
      entityId: actionToken.entity_id,
      severity: 'Info',
      channels: ['Teams'],
      actionUrl,
    });
    await logIntegrationEvent(client, {
      provider: 'teams',
      eventType: 'TeamsActionNotificationSent',
      entityType: actionToken.entity_type,
      entityId: actionToken.entity_id,
      requestPayload: { recipientEmployeeId: recipient.id, action: actionToken.action },
      responsePayload: { notificationId: event.id, actionUrl },
    });
    await audit(client, req, {
      module: 'Integrations',
      action: 'Send Teams Action Notification',
      entityType: actionToken.entity_type,
      entityId: actionToken.entity_id,
      newValue: { recipientEmployeeId: recipient.id, action: actionToken.action, actionUrl },
      details: `Sent deterministic Teams ${actionToken.action} action notification`,
      source: 'Teams',
    });
    await client.query('commit');
    res.json({ ...actionToken, action_url: actionUrl, notification_id: event.id });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Teams action notification send failed' });
  } finally {
    client.release();
  }
});

app.get('/api/integrations/events', requireDatabase, requireAuth, requirePermission('integrations.identity'), (_req, res) => {
  run(res, 'select * from integration_event_logs order by created_at desc limit 300');
});

app.get('/api/integrations/health', requireDatabase, requireAuth, requirePermission('integrations.identity'), async (_req, res) => {
  try {
    const graphReady = Boolean((process.env.GRAPH_TENANT_ID || process.env.ENTRA_TENANT_ID || process.env.TEAMS_TENANT_ID)
      && (process.env.GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID)
      && (process.env.GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET));
    const emailReady = (process.env.EMAIL_PROVIDER || 'mock') === 'mock'
      || (graphReady && Boolean(process.env.GRAPH_SENDER_UPN || process.env.SMTP_FROM));
    const teamsReady = (process.env.TEAMS_PROVIDER || 'mock') === 'mock'
      || (graphReady && Boolean(process.env.TEAMS_APP_ID));
    const result = await pool.query(`
      with active_employees as (
        select id from employees where status = 'Active'
      )
      select
        $1::text as identity_provider,
        $2::text as teams_provider,
        $3::text as email_provider,
        (select count(distinct employee_id)::int from identity_provider_links where status = 'Linked') as linked_identity_count,
        (select count(distinct employee_id)::int from teams_user_links where status = 'Linked') as linked_teams_count,
        (select count(*)::int from entra_group_role_mappings where active = true) as active_role_mappings,
        (select count(*)::int from teams_action_tokens where used_at is null and expires_at > now()) as open_action_tokens,
        (select count(*)::int from integration_event_logs where status = 'Failed') as recent_failures,
        (select count(*)::int from active_employees ae where not exists (select 1 from identity_provider_links ipl where ipl.employee_id = ae.id and ipl.status = 'Linked')) as missing_identity_links,
        (select count(*)::int from active_employees ae where not exists (select 1 from teams_user_links tul where tul.employee_id = ae.id and tul.status = 'Linked')) as missing_teams_links
    `, [process.env.IDENTITY_PROVIDER || 'local', process.env.TEAMS_PROVIDER || 'mock', process.env.EMAIL_PROVIDER || 'mock']);
    const events = await pool.query('select * from integration_event_logs order by created_at desc limit 25');
    const row = result.rows[0] || {};
    res.json({
      generatedAt: new Date().toISOString(),
      identity_provider: row.identity_provider,
      teams_provider: row.teams_provider,
      email_provider: row.email_provider,
      linked_identity_count: row.linked_identity_count,
      linked_teams_count: row.linked_teams_count,
      active_role_mappings: row.active_role_mappings,
      open_action_tokens: row.open_action_tokens,
      recent_failures: row.recent_failures,
      missing_identity_links: row.missing_identity_links,
      missing_teams_links: row.missing_teams_links,
      identityProvider: row.identity_provider,
      teamsProvider: row.teams_provider,
      emailProvider: row.email_provider,
      linkedIdentityCount: row.linked_identity_count,
      linkedTeamsCount: row.linked_teams_count,
      activeRoleMappings: row.active_role_mappings,
      openActionTokens: row.open_action_tokens,
      recentFailures: row.recent_failures,
      missingIdentityLinks: row.missing_identity_links,
      missingTeamsLinks: row.missing_teams_links,
      graphCredentialReady: graphReady,
      emailCredentialReady: emailReady,
      teamsCredentialReady: teamsReady,
      teamsActivityType: process.env.TEAMS_ACTIVITY_TYPE || 'systemDefault',
      credentialChecks: credentialChecks(),
      events: events.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Integration health report failed' });
  }
});

app.get('/api/permissions/config', requireDatabase, requireAuth, requirePermission('permissions.manage'), async (_req, res) => {
  try {
    const [rolePermissions, userGrants, users] = await Promise.all([
      pool.query('select role_name, permission_key, enabled, updated_at from role_permissions order by permission_key, role_name'),
      pool.query(`
        select upg.*, u.username, u.employee_id, e.name as display_name
        from user_permission_grants upg
        join users u on u.id = upg.user_id
        left join employees e on e.id = u.employee_record_id
        order by upg.created_at desc
      `),
      pool.query(`
        select u.id,
          u.username,
          u.employee_id,
          u.email,
          u.status,
          e.id as employee_record_id,
          coalesce(e.name, u.username) as display_name,
          coalesce(json_agg(r.name order by r.name) filter (where r.name is not null), '[]') as roles
        from users u
        left join employees e on e.id = u.employee_record_id
        left join user_roles ur on ur.user_id = u.id
        left join roles r on r.id = ur.role_id
        group by u.id, e.id, e.name
        order by display_name
      `),
    ]);
    res.json({
      permissions: permissionPayloadDefinitions(),
      role_permissions: rolePermissions.rows,
      user_grants: userGrants.rows,
      users: users.rows,
    });
  } catch (error) {
    if (error?.code === '42P01') {
      res.json({
        permissions: permissionPayloadDefinitions(),
        role_permissions: systemRoles.flatMap(roleName => permissionDefinitions.map(([permissionKey]) => ({
          role_name: roleName,
          permission_key: permissionKey,
          enabled: getDefaultPermissionsForRole(roleName).includes(permissionKey),
        }))),
        user_grants: [],
        users: [],
      });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Permission configuration failed' });
  }
});

app.patch('/api/permissions/roles/:roleName', requireDatabase, requireAuth, requirePermission('permissions.manage'), async (req, res) => {
  const schema = z.object({
    permissionKey: z.string().min(1),
    enabled: z.boolean(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || !systemRoles.includes(req.params.roleName)) {
    res.status(400).json({ error: parsed.success ? 'Invalid role name' : parsed.error.flatten() });
    return;
  }
  if (!permissionDefinitions.some(([key]) => key === parsed.data.permissionKey)) {
    res.status(400).json({ error: 'Unknown permission key' });
    return;
  }
  if (protectedPermissionKeys.has(parsed.data.permissionKey) && req.params.roleName !== 'Admin') {
    res.status(422).json({ error: 'Protected permissions can be enabled only for Admin.' });
    return;
  }
  if (parsed.data.permissionKey === 'permissions.manage' && req.params.roleName === 'Admin' && !parsed.data.enabled) {
    res.status(422).json({ error: 'Admin permission management cannot be disabled.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query(
      'select * from role_permissions where role_name = $1 and permission_key = $2 for update',
      [req.params.roleName, parsed.data.permissionKey],
    )).rows[0] || null;
    const result = await client.query(`
      insert into role_permissions (role_name, permission_key, enabled, updated_by, updated_at)
      values ($1,$2,$3,$4,now())
      on conflict (role_name, permission_key) do update set
        enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning *
    `, [req.params.roleName, parsed.data.permissionKey, parsed.data.enabled, req.user.sub]);
    await client.query(`
      insert into permission_change_history (change_type, role_name, permission_key, old_value, new_value, changed_by, active_role)
      values ('RolePermission', $1, $2, $3::jsonb, $4::jsonb, $5, $6)
    `, [
      req.params.roleName,
      parsed.data.permissionKey,
      previous ? JSON.stringify(previous) : null,
      JSON.stringify(result.rows[0]),
      req.user.sub,
      req.user.activeRole,
    ]);
    await audit(client, req, {
      module: 'Permissions',
      action: 'Update Role Permission',
      entityType: 'RolePermission',
      entityId: `${req.params.roleName}:${parsed.data.permissionKey}`,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${parsed.data.enabled ? 'Enabled' : 'Disabled'} ${parsed.data.permissionKey} for ${req.params.roleName}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Role permission update failed' });
  } finally {
    client.release();
  }
});

app.post('/api/permissions/user-grants', requireDatabase, requireAuth, requirePermission('permissions.manage'), async (req, res) => {
  const schema = z.object({
    userId: z.string().min(1),
    permissionKey: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!permissionDefinitions.some(([key]) => key === parsed.data.permissionKey)) {
    res.status(400).json({ error: 'Unknown permission key' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const target = (await client.query(`
      select u.id, u.username, u.employee_id, coalesce(json_agg(r.name) filter (where r.name is not null), '[]') as roles
      from users u
      left join user_roles ur on ur.user_id = u.id
      left join roles r on r.id = ur.role_id
      where u.id::text = $1
      group by u.id
    `, [parsed.data.userId])).rows[0];
    if (!target) {
      await client.query('rollback');
      res.status(404).json({ error: 'User was not found' });
      return;
    }
    if (protectedPermissionKeys.has(parsed.data.permissionKey) && !target.roles.includes('Admin')) {
      await client.query('rollback');
      res.status(422).json({ error: 'Protected permissions can be granted only to Admin users.' });
      return;
    }
    const result = await client.query(`
      insert into user_permission_grants (user_id, permission_key, granted_by, active_role)
      values ($1,$2,$3,$4)
      on conflict (user_id, permission_key) do update set granted_by = excluded.granted_by
      returning *
    `, [target.id, parsed.data.permissionKey, req.user.sub, req.user.activeRole]);
    await client.query(`
      insert into permission_change_history (change_type, user_id, permission_key, new_value, changed_by, active_role)
      values ('UserGrant', $1, $2, $3::jsonb, $4, $5)
    `, [target.id, parsed.data.permissionKey, JSON.stringify(result.rows[0]), req.user.sub, req.user.activeRole]);
    await audit(client, req, {
      module: 'Permissions',
      action: 'Grant User Permission',
      entityType: 'UserPermissionGrant',
      entityId: result.rows[0].id,
      newValue: result.rows[0],
      details: `Granted ${parsed.data.permissionKey} to ${target.username}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'User permission grant failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/permissions/user-grants/:id', requireDatabase, requireAuth, requirePermission('permissions.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('delete from user_permission_grants where id = $1 returning *', [req.params.id])).rows[0];
    if (!previous) {
      await client.query('rollback');
      res.status(404).json({ error: 'User permission grant was not found' });
      return;
    }
    await client.query(`
      insert into permission_change_history (change_type, user_id, permission_key, old_value, changed_by, active_role)
      values ('UserGrantRevoked', $1, $2, $3::jsonb, $4, $5)
    `, [previous.user_id, previous.permission_key, JSON.stringify(previous), req.user.sub, req.user.activeRole]);
    await audit(client, req, {
      module: 'Permissions',
      action: 'Revoke User Permission',
      entityType: 'UserPermissionGrant',
      entityId: previous.id,
      oldValue: previous,
      details: `Revoked ${previous.permission_key}`,
    });
    await client.query('commit');
    res.json({ status: 'ok' });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'User permission revoke failed' });
  } finally {
    client.release();
  }
});

app.get('/api/settings', requireDatabase, requireAuth, (_req, res) => run(res, 'select key, value from system_settings order by key'));
app.post('/api/settings', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const schema = z.object({
    expectedWeeklyHours: z.number().min(1).max(168),
    utilizationThresholdHigh: z.number().min(0).max(300),
    utilizationThresholdLow: z.number().min(0).max(300),
    benchThreshold: z.number().min(0).max(100),
    timesheetPolicyMaxHours: z.number().min(1).max(168).optional(),
    blockOverAllocation: z.boolean().optional(),
    demoSubmissionMode: z.boolean().optional(),
    currency: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select key, value from system_settings order by key')).rows;
    for (const [key, value] of Object.entries(parsed.data)) {
      await client.query(`
        insert into system_settings (key, value, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `, [key, JSON.stringify(value)]);
    }
    await audit(client, req, {
      module: 'Settings',
      action: 'Update Settings',
      entityType: 'SystemSettings',
      entityId: 'system',
      oldValue: previous,
      newValue: parsed.data,
      details: 'Updated system settings',
    });
    await client.query('commit');
    const result = await pool.query('select key, value from system_settings order by key');
    res.json(result.rows);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Settings save failed' });
  } finally {
    client.release();
  }
});

const catalogTypeSchema = z.enum(['departments', 'countries', 'industries']);
const catalogModules = {
  departments: 'Department Catalog',
  countries: 'Country Catalog',
  industries: 'Industry Catalog',
};

const getCatalogUsage = async (client, catalogType, name) => {
  if (catalogType === 'departments') {
    const employees = Number((await client.query('select count(*)::int as count from employees where department = $1', [name])).rows[0]?.count || 0);
    const roles = Number((await client.query('select count(*)::int as count from role_definitions where department = $1 and active = true', [name])).rows[0]?.count || 0);
    return { count: employees + roles, reason: `${employees} employee(s), ${roles} role(s) still reference this department` };
  }
  if (catalogType === 'countries') {
    const employees = Number((await client.query('select count(*)::int as count from employees where country = $1', [name])).rows[0]?.count || 0);
    return { count: employees, reason: `${employees} employee(s) still reference this country` };
  }
  const clients = Number((await client.query('select count(*)::int as count from clients where industry = $1 and status = $2', [name, 'Active'])).rows[0]?.count || 0);
  return { count: clients, reason: `${clients} active client(s) still reference this industry` };
};

app.get('/api/catalogs/:catalogType', requireDatabase, requireAuth, async (req, res) => {
  const parsed = catalogTypeSchema.safeParse(req.params.catalogType);
  if (!parsed.success) {
    res.status(404).json({ error: 'Unknown catalog type' });
    return;
  }
  await run(res, `
    select id, catalog_type, name, active, created_at, updated_at
    from catalog_items
    where catalog_type = $1 and active = true
    order by name
  `, [parsed.data]);
});

app.post('/api/catalogs/:catalogType', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const catalogType = catalogTypeSchema.safeParse(req.params.catalogType);
  const body = z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    active: z.boolean().default(true),
  }).safeParse(req.body);
  if (!catalogType.success || !body.success) {
    res.status(400).json({ error: body.error?.flatten?.() || 'Invalid catalog type' });
    return;
  }

  const client = await pool.connect();
  const id = body.data.id || `${catalogType.data.slice(0, -1)}-${crypto.randomUUID()}`;
  try {
    await client.query('begin');
    const previous = (await client.query('select * from catalog_items where id = $1 for update', [id])).rows[0];
    const result = await client.query(`
      insert into catalog_items (id, catalog_type, name, active)
      values ($1,$2,$3,$4)
      on conflict (id) do update set
        catalog_type = excluded.catalog_type,
        name = excluded.name,
        active = excluded.active,
        updated_at = now()
      returning *
    `, [id, catalogType.data, body.data.name.trim(), body.data.active]);
    await audit(client, req, {
      module: catalogModules[catalogType.data],
      action: previous ? 'Update Catalog Item' : 'Create Catalog Item',
      entityType: 'CatalogItem',
      entityId: id,
      oldValue: previous,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} ${catalogModules[catalogType.data]} item ${result.rows[0].name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') {
      res.status(409).json({ error: 'Catalog item name already exists for this catalog' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Catalog save failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/catalogs/:catalogType/:id', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const catalogType = catalogTypeSchema.safeParse(req.params.catalogType);
  if (!catalogType.success) {
    res.status(404).json({ error: 'Unknown catalog type' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const item = (await client.query('select * from catalog_items where id = $1 and catalog_type = $2 for update', [req.params.id, catalogType.data])).rows[0];
    if (!item) {
      await client.query('rollback');
      res.status(404).json({ error: 'Catalog item not found' });
      return;
    }
    const usage = await getCatalogUsage(client, catalogType.data, item.name);
    if (usage.count > 0) {
      await audit(client, req, {
        module: catalogModules[catalogType.data],
        action: 'Deactivate Blocked',
        entityType: 'CatalogItem',
        entityId: item.id,
        oldValue: item,
        details: `Blocked deactivation of ${item.name}; it is still referenced`,
        reason: usage.reason,
      });
      await client.query('commit');
      res.status(409).json({ error: 'Catalog item is still in use', reason: usage.reason });
      return;
    }
    const result = await client.query('update catalog_items set active = false, updated_at = now() where id = $1 returning *', [req.params.id]);
    await audit(client, req, {
      module: catalogModules[catalogType.data],
      action: 'Deactivate Catalog Item',
      entityType: 'CatalogItem',
      entityId: item.id,
      oldValue: item,
      newValue: result.rows[0],
      details: `Deactivated ${catalogModules[catalogType.data]} item ${item.name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Catalog item deactivation failed' });
  } finally {
    client.release();
  }
});

app.get('/api/country-directors', requireDatabase, requireAuth, (_req, res) => run(res, 'select * from country_directors order by region, name'));
app.post('/api/country-directors', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    region: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const previous = (await client.query('select * from country_directors where id = $1 for update', [parsed.data.id])).rows[0];
    const result = await client.query(`
      insert into country_directors (id, name, region)
      values ($1,$2,$3)
      on conflict (id) do update set
        name = excluded.name,
        region = excluded.region
      returning *
    `, [parsed.data.id, parsed.data.name, parsed.data.region]);
    await audit(client, req, {
      module: 'Country Director',
      action: previous ? 'Update Country Director' : 'Create Country Director',
      entityType: 'CountryDirector',
      entityId: parsed.data.id,
      oldValue: previous || null,
      newValue: result.rows[0],
      details: `${previous ? 'Updated' : 'Created'} Country Director ${parsed.data.name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Country Director save failed' });
  } finally {
    client.release();
  }
});
app.delete('/api/country-directors/:id', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const director = (await client.query('select * from country_directors where id = $1 for update', [req.params.id])).rows[0];
    if (!director) {
      await client.query('rollback');
      res.status(404).json({ error: 'Country Director not found' });
      return;
    }
    const employeeCount = Number((await client.query(`
      select count(*)::int as count
      from employees e
      left join employee_country_director_map ecdm on ecdm.employee_id = e.id
      where e.primary_country_director_id = $1 or ecdm.country_director_id = $1
    `, [req.params.id])).rows[0]?.count || 0);
    const clientCount = Number((await client.query('select count(*)::int as count from client_country_director_map where country_director_id = $1', [req.params.id])).rows[0]?.count || 0);
    if (employeeCount > 0 || clientCount > 0) {
      await audit(client, req, {
        module: 'Country Director',
        action: 'Delete Blocked',
        entityType: 'CountryDirector',
        entityId: req.params.id,
        oldValue: director,
        details: `Blocked deletion of ${director.name}; scope mappings still exist`,
        reason: `${employeeCount} employee mapping(s), ${clientCount} client mapping(s)`,
      });
      await client.query('commit');
      res.status(409).json({ error: 'Country Director is still mapped to employees or clients', employeeCount, clientCount });
      return;
    }
    const result = await client.query('delete from country_directors where id = $1 returning *', [req.params.id]);
    await audit(client, req, {
      module: 'Country Director',
      action: 'Delete Country Director',
      entityType: 'CountryDirector',
      entityId: req.params.id,
      oldValue: director,
      details: `Deleted Country Director ${director.name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Country Director deletion failed' });
  } finally {
    client.release();
  }
});
app.get('/api/role-definitions', requireDatabase, requireAuth, (_req, res) => run(res, 'select * from role_definitions where active = true order by name'));
app.post('/api/role-definitions', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const schema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    department: z.string().min(1),
    description: z.string().optional(),
    active: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await run(res, `
    insert into role_definitions (id, name, department, description, active)
    values ($1,$2,$3,$4,$5)
    on conflict (id) do update set
      name = excluded.name,
      department = excluded.department,
      description = excluded.description,
      active = excluded.active,
      updated_at = now()
    returning *
  `, [parsed.data.id, parsed.data.name, parsed.data.department, parsed.data.description || null, parsed.data.active]);
});
app.delete('/api/role-definitions/:id', requireDatabase, requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const role = (await client.query('select * from role_definitions where id = $1 for update', [req.params.id])).rows[0];
    if (!role) {
      await client.query('rollback');
      res.status(404).json({ error: 'Role definition not found' });
      return;
    }
    const employeeCount = Number((await client.query('select count(*)::int as count from employees where designation = $1', [role.name])).rows[0]?.count || 0);
    const allocationCount = Number((await client.query('select count(*)::int as count from project_allocations where role_on_project = $1', [role.name])).rows[0]?.count || 0);
    if (employeeCount > 0 || allocationCount > 0) {
      await audit(client, req, {
        module: 'Role Definition',
        action: 'Delete Blocked',
        entityType: 'RoleDefinition',
        entityId: req.params.id,
        oldValue: role,
        details: `Blocked deactivation of role ${role.name}; it is still in use`,
        reason: `${employeeCount} employee(s), ${allocationCount} allocation(s)`,
      });
      await client.query('commit');
      res.status(409).json({ error: 'Role definition is still used by employees or allocations', employeeCount, allocationCount });
      return;
    }
    const result = await client.query('update role_definitions set active = false, updated_at = now() where id = $1 returning *', [req.params.id]);
    await audit(client, req, {
      module: 'Role Definition',
      action: 'Deactivate Role Definition',
      entityType: 'RoleDefinition',
      entityId: req.params.id,
      oldValue: role,
      newValue: result.rows[0],
      details: `Deactivated role definition ${role.name}`,
    });
    await client.query('commit');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Role definition deactivation failed' });
  } finally {
    client.release();
  }
});
app.get('/api/audit-logs', requireDatabase, requireAuth, requirePermission('audit.view'), (_req, res) => run(res, 'select * from audit_logs order by created_at desc limit 500'));

app.post('/api/audit-events', requireDatabase, requireAuth, async (req, res) => {
  const schema = z.object({
    action: z.enum(['Export', 'Import', 'Notify']),
    module: z.string().min(1).max(120),
    details: z.string().min(1).max(1000),
    entityType: z.string().max(120).optional(),
    entityId: z.string().max(160).optional(),
    newValue: z.unknown().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    await audit(pool, req, {
      ...parsed.data,
      source: parsed.data.action,
    });
    res.status(201).json({ status: 'ok' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Audit event failed' });
  }
});

const utilizationReportSchema = z.object({
  date: strictIsoDateSchema.optional(),
  months: z.coerce.number().int().min(1).max(24).optional(),
});

const getUtilizationReport = async (req, res, mode) => {
  const parsed = utilizationReportSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const settingsResult = await pool.query('select key, value from system_settings');
  const settings = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
  const expectedWeeklyHours = Number(settings.expectedWeeklyHours || 40);
  const highThreshold = Number(settings.utilizationThresholdHigh || 100);
  const lowThreshold = Number(settings.utilizationThresholdLow || 80);
  const benchThreshold = Number(settings.benchThreshold || 20);

  const reportDate = parsed.data.date || todayIso();
  const forecastMonths = parsed.data.months || 3;
  const forecastDate = new Date(`${reportDate}T00:00:00.000Z`);
  forecastDate.setUTCMonth(forecastDate.getUTCMonth() + forecastMonths);
  const targetDate = mode === 'forecast' ? forecastDate.toISOString().slice(0, 10) : reportDate;
  const includeProposed = mode === 'forecast';

  const params = [targetDate, expectedWeeklyHours, highThreshold, lowThreshold, benchThreshold, includeProposed, mode];
  const scopeWhere = buildEmployeeScopeWhere(req, params, 'e');

  try {
    const result = await pool.query(`
      with scoped_employees as (
        select e.*,
          coalesce(jsonb_agg(ecdm.country_director_id) filter (where ecdm.country_director_id is not null), '[]'::jsonb) as mapped_country_director_ids
        from employees e
        left join employee_country_director_map ecdm on ecdm.employee_id = e.id
        where ${scopeWhere}
        group by e.id
      ),
      employee_load as (
        select
          e.id,
          e.employee_id,
          e.name,
          e.email,
          e.designation,
          e.department,
          e.country,
          e.reporting_manager_id,
          e.primary_country_director_id,
          e.mapped_country_director_ids,
          e.status,
          e.utilization_eligible,
          e.joining_date,
          e.exit_date,
          e.standard_weekly_hours,
          e.capacity_type,
          e.contract_type,
          e.leave_policy_id,
          e.entra_object_id,
          e.teams_user_id,
          coalesce(sum(pa.percentage) filter (
            where pa.status = 'Active'
              and p.id is not null
              and (p.status = 'Active' or ($6::boolean and p.status = 'Proposed'))
              and p.start_date <= $1::date
              and p.end_date >= $1::date
              and pa.start_date <= $1::date
              and pa.end_date >= $1::date
          ), 0) as planned_utilization,
          count(pa.id) filter (
            where pa.status = 'Active'
              and p.id is not null
              and (p.status = 'Active' or ($6::boolean and p.status = 'Proposed'))
              and p.start_date <= $1::date
              and p.end_date >= $1::date
              and pa.start_date <= $1::date
              and pa.end_date >= $1::date
          )::int as active_project_count
        from scoped_employees e
        left join project_allocations pa on pa.employee_id = e.id
        left join projects p on p.id = pa.project_id
        where e.status = 'Active' and e.utilization_eligible = true
        group by e.id, e.employee_id, e.name, e.email, e.designation, e.department, e.country,
          e.reporting_manager_id, e.primary_country_director_id, e.mapped_country_director_ids, e.status,
          e.utilization_eligible, e.joining_date, e.exit_date, e.standard_weekly_hours, e.capacity_type,
          e.contract_type, e.leave_policy_id, e.entra_object_id, e.teams_user_id
      ),
      latest_approved as (
        select distinct on (t.employee_id)
          t.employee_id,
          t.week_ending,
          t.billable_hours,
          round((t.billable_hours / nullif($2::numeric, 0)) * 1000) / 10 as actual_utilization
        from timesheets t
        where t.status = 'Approved'
        order by t.employee_id, t.week_ending desc
      )
      select
        el.id,
        el.employee_id,
        el.name,
        el.email,
        el.designation,
        el.department,
        el.country,
        el.reporting_manager_id,
        el.primary_country_director_id,
        el.mapped_country_director_ids,
        el.status,
        el.utilization_eligible,
        el.joining_date,
        el.exit_date,
        el.standard_weekly_hours,
        el.capacity_type,
        el.contract_type,
        el.leave_policy_id,
        el.entra_object_id,
        el.teams_user_id,
        el.planned_utilization,
        coalesce(la.actual_utilization, 0) as actual_utilization,
        la.week_ending as latest_approved_week,
        el.active_project_count,
        case
          when el.planned_utilization > $3::numeric then 'Overloaded'
          when el.planned_utilization <= $5::numeric then 'Bench'
          when el.planned_utilization < $4::numeric then 'Underutilized'
          else 'Balanced'
        end as utilization_band
      from employee_load el
      left join latest_approved la on la.employee_id = el.id
      where (
        not (upper(el.employee_id) like 'PM-%' or el.designation = 'Project Manager')
        or el.active_project_count > 0
        or el.planned_utilization > 0
      )
      order by
        case when $7 = 'actual' then coalesce(la.actual_utilization, 0) else el.planned_utilization end desc,
        el.name
    `, params);
    res.json({
      mode,
      asOfDate: targetDate,
      sourceDate: reportDate,
      forecastMonths: mode === 'forecast' ? forecastMonths : null,
      expectedWeeklyHours,
      thresholds: {
        high: highThreshold,
        low: lowThreshold,
        bench: benchThreshold,
      },
      summary: {
        rows: result.rows.length,
        averagePlanned: result.rows.length
          ? Number((result.rows.reduce((sum, row) => sum + Number(row.planned_utilization), 0) / result.rows.length).toFixed(1))
          : 0,
        averageActual: result.rows.length
          ? Number((result.rows.reduce((sum, row) => sum + Number(row.actual_utilization), 0) / result.rows.length).toFixed(1))
          : 0,
        overloaded: result.rows.filter(row => Number(row.planned_utilization) > highThreshold).length,
        underutilized: result.rows.filter(row => {
          const planned = Number(row.planned_utilization);
          return planned < lowThreshold && planned > benchThreshold;
        }).length,
        bench: result.rows.filter(row => Number(row.planned_utilization) <= benchThreshold).length,
      },
      rows: result.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Utilization report failed' });
  }
};

app.get('/api/reports/planned-utilization', requireDatabase, requireAuth, requirePermission('reports.view_utilization'), (req, res) => {
  getUtilizationReport(req, res, 'planned');
});
app.get('/api/reports/actual-utilization', requireDatabase, requireAuth, requirePermission('reports.view_utilization'), (req, res) => {
  getUtilizationReport(req, res, 'actual');
});
app.get('/api/reports/forecast-utilization', requireDatabase, requireAuth, requirePermission('reports.view_utilization'), (req, res) => {
  getUtilizationReport(req, res, 'forecast');
});

const getResourcePlanningPayload = async (req) => {
  const asOfDate = String(req.query.date || todayIso()).slice(0, 10);
  const employeeParams = [];
  const employeeScopeWhere = buildEmployeeScopeWhere(req, employeeParams, 'e');
  const settingsRows = (await pool.query('select key, value from system_settings')).rows;
  const settings = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));
  const highThreshold = Number(settings.utilizationThresholdHigh || 100);
  const lowThreshold = Number(settings.utilizationThresholdLow || 80);
  const benchThreshold = Number(settings.benchThreshold || 20);

  const employees = (await pool.query(`
    select e.*,
      coalesce(array_agg(distinct ecdm.country_director_id) filter (where ecdm.country_director_id is not null), '{}') as mapped_country_director_ids
    from employees e
    left join employee_country_director_map ecdm on ecdm.employee_id = e.id
    where e.status = 'Active' and e.utilization_eligible = true and ${employeeScopeWhere}
    group by e.id
    order by e.name
  `, employeeParams)).rows;
  const employeeIds = employees.map(employee => employee.id);
  if (employeeIds.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      asOfDate,
      summary: {
        people: 0,
        averagePlanned: 0,
        averageAvailabilityAdjustedCapacity: 0,
        benchCount: 0,
        overloadedCount: 0,
        underloadedCount: 0,
        rollOffSoonCount: 0,
      },
      rows: [],
    };
  }

  const [allocationsResult, availabilityResult, actualResult] = await Promise.all([
    pool.query(`
      select
        pa.id as allocation_id,
        pa.employee_id,
        pa.project_id,
        pa.percentage::numeric as percentage,
        pa.billable and p.billable as billable,
        pa.start_date,
        pa.end_date,
        p.project_code,
        p.name as project_name,
        p.client,
        p.manager_name
      from project_allocations pa
      join projects p on p.id = pa.project_id
      where pa.employee_id = any($1)
        and pa.status = 'Active'
        and p.status in ('Active', 'Proposed')
        and p.start_date <= $2::date
        and p.end_date >= $2::date
        and pa.start_date <= $2::date
        and pa.end_date >= $2::date
      order by pa.percentage desc, p.name
    `, [employeeIds, asOfDate]),
    pool.query(`
      select
        e.id as employee_id,
        e.standard_weekly_hours,
        coalesce(l.approved_leave_days, 0)::numeric as approved_leave_days,
        coalesce(h.holiday_days, 0)::numeric as holiday_days,
        greatest(0, (e.standard_weekly_hours * 52) - ((coalesce(l.approved_leave_days, 0) + coalesce(h.holiday_days, 0)) * (e.standard_weekly_hours / 5)))::numeric as availability_hours
      from employees e
      left join (
        select employee_id, sum(total_days) as approved_leave_days
        from leave_requests
        where status = 'Approved' and extract(year from start_date)::int = extract(year from $2::date)::int
        group by employee_id
      ) l on l.employee_id = e.id
      left join lateral (
        select count(*) as holiday_days
        from holiday_calendars hc
        join holidays h on h.calendar_id = hc.id
        where hc.status = 'Active'
          and hc.calendar_year = extract(year from $2::date)::int
          and (hc.country = e.country or hc.country = 'Global')
      ) h on true
      where e.id = any($1)
    `, [employeeIds, asOfDate]),
    pool.query(`
      select distinct on (employee_id)
        employee_id,
        round((billable_hours / nullif($1::numeric, 0)) * 1000) / 10 as actual_utilization
      from timesheets
      where status = 'Approved' and employee_id = any($2)
      order by employee_id, week_ending desc
    `, [Number(settings.expectedWeeklyHours || 40), employeeIds]),
  ]);

  const allocationsByEmployee = new Map();
  allocationsResult.rows.forEach(allocation => {
    const list = allocationsByEmployee.get(allocation.employee_id) || [];
    list.push({
      allocation_id: allocation.allocation_id,
      project_id: allocation.project_id,
      project_code: allocation.project_code,
      project_name: allocation.project_name,
      client: allocation.client,
      manager_name: allocation.manager_name,
      percentage: Number(allocation.percentage || 0),
      billable: Boolean(allocation.billable),
      start_date: toIsoDate(allocation.start_date),
      end_date: toIsoDate(allocation.end_date),
    });
    allocationsByEmployee.set(allocation.employee_id, list);
  });
  const availabilityByEmployee = new Map(availabilityResult.rows.map(row => [row.employee_id, row]));
  const actualByEmployee = new Map(actualResult.rows.map(row => [row.employee_id, Number(row.actual_utilization || 0)]));

  const rows = employees.map(employee => {
    const allocations = allocationsByEmployee.get(employee.id) || [];
    const availability = availabilityByEmployee.get(employee.id);
    const standardWeeklyHours = Number(availability?.standard_weekly_hours || employee.standard_weekly_hours || settings.expectedWeeklyHours || 40);
    const annualCapacityHours = Math.max(standardWeeklyHours * 52, 1);
    const availabilityHours = round1(Number(availability?.availability_hours ?? annualCapacityHours));
    const plannedUtilization = round1(allocations.reduce((sum, allocation) => sum + allocation.percentage, 0));
    const billableAllocationPercent = round1(allocations.filter(allocation => allocation.billable).reduce((sum, allocation) => sum + allocation.percentage, 0));
    const rollOffDate = allocations.length ? allocations.map(allocation => allocation.end_date).sort()[0] : null;
    return {
      employee_id: employee.id,
      employee_code: employee.employee_id,
      employee_name: employee.name,
      department: employee.department,
      country: employee.country,
      capacity_type: employee.capacity_type,
      contract_type: employee.contract_type,
      standard_weekly_hours: standardWeeklyHours,
      planned_utilization: plannedUtilization,
      actual_utilization: actualByEmployee.get(employee.id) || 0,
      availability_hours: availabilityHours,
      availability_adjusted_capacity_percent: round1((availabilityHours / annualCapacityHours) * 100),
      approved_leave_days: Number(availability?.approved_leave_days || 0),
      holiday_days: Number(availability?.holiday_days || 0),
      active_project_count: allocations.length,
      billable_allocation_percent: billableAllocationPercent,
      bench: plannedUtilization <= benchThreshold,
      overloaded: plannedUtilization > highThreshold,
      underloaded: plannedUtilization < lowThreshold && plannedUtilization > benchThreshold,
      roll_off_date: rollOffDate,
      allocations,
    };
  }).sort((a, b) => b.planned_utilization - a.planned_utilization || a.employee_name.localeCompare(b.employee_name));

  const rollOffLimit = new Date(`${asOfDate}T00:00:00`);
  rollOffLimit.setDate(rollOffLimit.getDate() + 45);
  const rollOffSoonCount = rows.filter(row => row.roll_off_date && new Date(`${row.roll_off_date}T00:00:00`) <= rollOffLimit).length;

  return {
    generatedAt: new Date().toISOString(),
    asOfDate,
    summary: {
      people: rows.length,
      averagePlanned: rows.length ? round1(rows.reduce((sum, row) => sum + row.planned_utilization, 0) / rows.length) : 0,
      averageAvailabilityAdjustedCapacity: rows.length ? round1(rows.reduce((sum, row) => sum + row.availability_adjusted_capacity_percent, 0) / rows.length) : 0,
      benchCount: rows.filter(row => row.bench).length,
      overloadedCount: rows.filter(row => row.overloaded).length,
      underloadedCount: rows.filter(row => row.underloaded).length,
      rollOffSoonCount,
    },
    rows,
  };
};

app.get('/api/reports/resource-planning', requireDatabase, requireAuth, requirePermission('allocations.view'), async (req, res) => {
  try {
    res.json(await getResourcePlanningPayload(req));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Resource planning report failed' });
  }
});

app.get('/api/reports/workforce-command-center', requireDatabase, requireAuth, requirePermission('reports.data_quality'), async (req, res) => {
  try {
    const approvalParams = ['Pending'];
    const approvalScopeWhere = buildApprovalScopeWhere(req, approvalParams);
    const integrationParams = [];
    const integrationEmployeeScopeWhere = buildEmployeeScopeWhere(req, integrationParams, 'e');
    const notificationParams = [];
    const notificationEmployeeScopeWhere = buildEmployeeScopeWhere(req, notificationParams, 'e');
    const staffingParams = [];
    const staffingProjectScopeWhere = buildProjectScopeWhere(req, staffingParams, 'p');
    const [planning, quality, sla, integrations, notificationRiskResult, staffingRiskResult] = await Promise.all([
      getResourcePlanningPayload(req),
      getDataQualityPayload(req),
      pool.query(`
        select
          count(*)::int as pending,
          count(*) filter (where ar.due_at is not null and ar.due_at < now())::int as overdue
        from approval_records ar
        left join employees e on e.id = ar.subject_employee_id
        where ar.status = $1 and ${approvalScopeWhere}
      `, approvalParams),
      pool.query(`
        with scoped_employees as (
          select e.id
          from employees e
          where e.status = 'Active' and ${integrationEmployeeScopeWhere}
        )
        select
          (select count(*)::int from scoped_employees e where not exists (select 1 from identity_provider_links ipl where ipl.employee_id = e.id and ipl.status = 'Linked')) as missing_identity_links,
          (select count(*)::int from scoped_employees e where not exists (select 1 from teams_user_links tul where tul.employee_id = e.id and tul.status = 'Linked')) as missing_teams_links
      `, integrationParams),
      pool.query(`
        select count(*)::int as failed
        from notification_delivery_attempts nda
        join notification_events ne on ne.id = nda.notification_id
        join employees e on e.id = ne.recipient_employee_id
        where nda.status = 'Failed' and ${notificationEmployeeScopeWhere}
      `, notificationParams),
      pool.query(`
        select count(*)::int as staffing_risks
        from projects p
        where p.status in ('Active', 'Proposed')
          and ${staffingProjectScopeWhere}
          and not exists (
            select 1 from project_allocations pa
            where pa.project_id = p.id and pa.status = 'Active' and pa.start_date <= current_date and pa.end_date >= current_date
          )
      `, staffingParams),
    ]);
    const topRisks = [
      ...planning.rows.filter(row => row.overloaded).slice(0, 4).map(row => ({
        riskType: 'Overload',
        severity: 'Critical',
        description: `${row.employee_name} is planned at ${row.planned_utilization}%.`,
        owner: row.department,
      })),
      ...quality.issues.slice(0, 4).map(issue => ({
        riskType: issue.issueType,
        severity: 'Warning',
        description: issue.impact,
        owner: issue.owner,
      })),
    ];
    res.json({
      generatedAt: new Date().toISOString(),
      dataConfidenceScore: quality.score,
      leaveAdjustedAvailabilityHours: round1(planning.rows.reduce((sum, row) => sum + row.availability_hours, 0)),
      pendingApprovalLoad: sla.rows[0]?.pending || 0,
      overdueApprovalLoad: sla.rows[0]?.overdue || 0,
      notificationDeliveryRisk: notificationRiskResult.rows[0]?.failed || 0,
      missingIdentityLinks: integrations.rows[0]?.missing_identity_links || 0,
      missingTeamsLinks: integrations.rows[0]?.missing_teams_links || 0,
      projectStaffingRisks: staffingRiskResult.rows[0]?.staffing_risks || 0,
      benchCount: planning.summary.benchCount,
      overloadedCount: planning.summary.overloadedCount,
      underloadedCount: planning.summary.underloadedCount,
      topRisks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Workforce command center report failed' });
  }
});

const getDataQualityPayload = async (req) => {
  const params = [];
  const employeeScopeWhere = buildEmployeeScopeWhere(req, params, 'e');
  const result = await pool.query(`
    with scoped_employees as (
      select e.*
      from employees e
      where ${employeeScopeWhere}
    ),
    scoped_allocations as (
      select pa.*, p.name as project_name, p.start_date as project_start_date, p.end_date as project_end_date
      from project_allocations pa
      join scoped_employees e on e.id = pa.employee_id
      join projects p on p.id = pa.project_id
    ),
    issues as (
      select
        'Employee' as entity_type,
        e.id as entity_id,
        e.name as entity,
        'Missing reporting manager' as issue_type,
        coalesce(e.email, e.employee_id) as owner,
        'Approval routing and team views may be unreliable.' as impact,
        'Assign a reporting manager in Employee Master.' as suggested_action
      from scoped_employees e
      where e.status = 'Active' and e.reporting_manager_id is null

      union all

      select
        'Employee',
        e.id,
        e.name,
        'Missing capacity profile',
        coalesce(e.email, e.employee_id),
        'Availability and utilization handover checks cannot be fully trusted.',
        'Set standard weekly hours, capacity type, and contract type.'
      from scoped_employees e
      where e.status = 'Active'
        and (e.standard_weekly_hours is null or e.capacity_type is null or e.contract_type is null)

      union all

      select
        'Employee',
        e.id,
        e.name,
        'Missing Teams identity link',
        coalesce(e.email, e.employee_id),
        'Future Teams approvals and reminders cannot target this user.',
        'Capture the Teams user link during identity onboarding.'
      from scoped_employees e
      where e.status = 'Active' and nullif(e.teams_user_id, '') is null

      union all

      select
        'Employee',
        e.id,
        e.name,
        'Demo data remnant',
        coalesce(e.email, e.employee_id),
        'Production handover may still contain seeded demo records.',
        'Replace demo user and employee records with company-owned data.'
      from scoped_employees e
      where e.email ilike '%.demo' or e.email ilike '%@example.test'

      union all

      select
        'Allocation',
        sa.id,
        sa.project_name,
        'Allocation outside project timeline',
        sa.employee_id,
        'Planned and forecast utilization can be incorrect for this assignment.',
        'Adjust allocation dates to fit within the project start and end dates.'
      from scoped_allocations sa
      where sa.start_date < sa.project_start_date or sa.end_date > sa.project_end_date
    )
    select * from issues order by issue_type, entity
  `, params);

  const scopedCount = await pool.query(`
    select count(*)::int as count
    from employees e
    where ${employeeScopeWhere}
  `, params);
  const totalRecords = Number(scopedCount.rows[0]?.count || 0);
  const issueCount = result.rows.length;
  const denominator = Math.max(totalRecords * 4, 1);
  const score = Math.max(0, Math.round(((denominator - issueCount) / denominator) * 100));
  const byType = result.rows.reduce((acc, issue) => {
    acc[issue.issue_type] = (acc[issue.issue_type] || 0) + 1;
    return acc;
  }, {});
  return {
    score,
    totalRecords,
    issueCount,
    byType,
    issues: result.rows,
    generatedAt: new Date().toISOString(),
  };
};

app.get('/api/reports/data-quality', requireDatabase, requireAuth, requirePermission('reports.data_quality'), async (req, res) => {
  try {
    res.json(await getDataQualityPayload(req));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Data quality report failed' });
  }
});

app.get('/api/reports/dashboard', requireDatabase, requireAuth, requirePermission('reports.data_quality'), async (req, res) => {
  const params = [];
  const employeeScopeWhere = buildEmployeeScopeWhere(req, params, 'e');
  const projectRiskParams = [];
  const projectScopeWhere = buildProjectScopeWhere(req, projectRiskParams, 'p');
  try {
    const [settingsResult, workforceResult, projectRiskResult, pendingTimesheetsResult, quality] = await Promise.all([
      pool.query('select key, value from system_settings'),
      pool.query(`
        select
          count(*) filter (where e.status = 'Active')::int as active_people,
          count(*) filter (where e.status = 'Active' and e.utilization_eligible = true)::int as utilization_eligible_fte,
          count(*) filter (where e.status = 'Active' and e.utilization_eligible = false)::int as governance_users
        from employees e
        where ${employeeScopeWhere}
      `, params),
      pool.query(`
        select count(distinct p.id)::int as staffing_risks
        from projects p
        where p.status in ('Active', 'Proposed')
          and ${projectScopeWhere}
          and not exists (
            select 1 from project_allocations pa
            where pa.project_id = p.id and pa.status = 'Active'
          )
      `, projectRiskParams),
      pool.query(`
        select count(*)::int as pending
        from timesheets t
        join employees e on e.id = t.employee_id
        where t.status = 'Submitted' and ${employeeScopeWhere}
      `, params),
      getDataQualityPayload(req),
    ]);
    const settings = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
    res.json({
      generatedAt: new Date().toISOString(),
      settings,
      workforce: workforceResult.rows[0] || {},
      projectStaffingRisks: Number(projectRiskResult.rows[0]?.staffing_risks || 0),
      pendingTimesheets: Number(pendingTimesheetsResult.rows[0]?.pending || 0),
      dataQuality: quality,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Dashboard report failed' });
  }
});

app.get('/api/import-export-logs', requireDatabase, requireAuth, requirePermission('employees.manage'), (_req, res) => run(res, 'select * from import_export_logs order by created_at desc limit 100'));
app.post('/api/import-export-logs', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const schema = z.object({
    operation: z.enum(['Import', 'Export']),
    channel: z.string().min(1),
    fileName: z.string().min(1),
    status: z.enum(['Success', 'Partial', 'Failed', 'Dry Run']),
    totalRows: z.number().int().min(0),
    validRows: z.number().int().min(0),
    errorRows: z.number().int().min(0),
    errors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await run(res, `
    insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    returning *
  `, [
    parsed.data.operation,
    parsed.data.channel,
    parsed.data.fileName,
    parsed.data.status,
    parsed.data.totalRows,
    parsed.data.validRows,
    parsed.data.errorRows,
    parsed.data.errors ? JSON.stringify(parsed.data.errors) : null,
    req.user.username,
  ]);
});

app.post('/api/imports/employees/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const rowSchema = z.object({
    employeeId: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    designation: z.string().optional(),
    department: z.string().optional(),
    country: z.string().optional(),
    region: z.string().optional(),
    businessUnit: z.string().optional(),
    reportingManagerId: z.string().optional(),
    primaryCountryDirectorId: z.string().optional(),
    mappedCountryDirectorIds: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['Active', 'On Leave', 'Exited']).optional(),
    utilizationEligible: z.union([z.boolean(), z.string()]).optional(),
    joiningDate: optionalImportIsoDateSchema,
    exitDate: optionalImportIsoDateSchema,
    standardWeeklyHours: z.union([z.number(), z.string()]).optional(),
    capacityType: z.string().optional(),
    contractType: z.string().optional(),
    entraObjectId: z.string().optional(),
    teamsUserId: z.string().optional(),
    roles: z.union([z.string(), z.array(z.string())]).optional(),
    initialPassword: z.string().optional(),
  });
  const schema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [
    { field: 'employeeId', value: row.employeeId, label: 'employee ID' },
    { field: 'email', value: row.email, label: 'email' },
  ]);
  const errors = [...(parsed.data.clientErrors || []), ...duplicateImportRows.errors];
  let saved = 0;
  try {
    await client.query('begin');
    const directorResult = await client.query('select id from country_directors');
    const directorIds = new Set(directorResult.rows.map(row => row.id));
    const employeeRole = (await client.query('select id from roles where name = $1', ['Employee'])).rows[0];

    for (const [index, row] of parsed.data.rows.entries()) {
      const rowNumber = index + 2;
      if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `employee:${req.organizationScope.organizationId}:${row.employeeId}`,
      ]);
      const mappedIds = splitPipeList(row.mappedCountryDirectorIds);
      const primaryDirectorId = row.primaryCountryDirectorId || mappedIds[0] || null;
      const rowErrors = [];
      if (!primaryDirectorId) rowErrors.push({ rowNumber, field: 'primaryCountryDirectorId', message: 'Primary country director is required.' });
      if (primaryDirectorId && !directorIds.has(primaryDirectorId)) rowErrors.push({ rowNumber, field: 'primaryCountryDirectorId', message: 'Primary country director does not exist.' });
      for (const directorId of mappedIds) {
        if (!directorIds.has(directorId)) rowErrors.push({ rowNumber, field: 'mappedCountryDirectorIds', message: `Country director ${directorId} does not exist.` });
      }
      let reportingManagerId = null;
      if (row.reportingManagerId) {
        const manager = (await client.query(`
          select id from employees
          where (id = $1 or employee_id = $1) and status <> 'Exited'
            and organization_id = $2 and legal_entity_id = $3
          limit 1
        `, [row.reportingManagerId, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
        if (!manager) rowErrors.push({ rowNumber, field: 'reportingManagerId', message: 'Reporting manager employee record does not exist or is exited.' });
        reportingManagerId = manager?.id || null;
      }
      const previous = (await client.query(
        'select * from employees where employee_id = $1 and organization_id = $2 and legal_entity_id = $3 limit 1 for update',
        [row.employeeId, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
      )).rows[0];
      if (!previous) {
        const otherLegalEntityEmployee = (await client.query(
          'select id from employees where employee_id = $1 and organization_id = $2 and legal_entity_id is distinct from $3 limit 1 for update',
          [row.employeeId, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
        )).rows[0];
        if (otherLegalEntityEmployee) {
          errors.push({ rowNumber, field: 'employeeId', message: 'Employee ID is already assigned to another legal entity.', code: 'EMPLOYEE_SCOPE_CONFLICT' });
          continue;
        }
      }
      if (reportingManagerId && (reportingManagerId === previous?.id || row.reportingManagerId === row.employeeId)) {
        rowErrors.push({ rowNumber, field: 'reportingManagerId', message: 'Employee cannot report to themselves.' });
      }
      if (reportingManagerId && previous?.id) {
        const cycle = (await client.query(`
          with recursive manager_chain as (
            select id, reporting_manager_id from employees where id = $1 and organization_id = $3 and legal_entity_id = $4
            union all
            select e.id, e.reporting_manager_id
            from employees e
            join manager_chain chain on e.id = chain.reporting_manager_id
            where chain.reporting_manager_id is not null and e.organization_id = $3 and e.legal_entity_id = $4
          )
          select 1 from manager_chain where id = $2 limit 1
        `, [reportingManagerId, previous.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
        if (cycle) rowErrors.push({ rowNumber, field: 'reportingManagerId', message: 'Reporting manager would create a circular hierarchy.' });
      }
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }
      const targetStatus = row.status || previous?.status || 'Active';
      let effectiveExitDate = row.exitDate;
      if (previous && targetStatus === 'Exited') {
        try {
          effectiveExitDate = await assertWorkerMayExit(
            client,
            previous,
            req.organizationScope,
            previous.status === 'Exited' ? row.exitDate : (row.exitDate || new Date().toISOString().slice(0, 10)),
          );
        } catch (error) {
          if (!['WORKER_DEPENDENCY_CONFLICT', 'WORKER_VERSION_CONFLICT'].includes(error.code)) throw error;
          errors.push({ rowNumber, field: 'status', message: `${error.message}.`, code: error.code });
          continue;
        }
      }
      const employeeExitDate = previous?.status === 'Exited' && targetStatus !== 'Exited'
        ? null
        : effectiveExitDate || previous?.exit_date || null;
      const employeeCode = row.employeeId.toUpperCase();
      const designation = row.designation || previous?.designation || 'Consultant';
      const department = row.department || previous?.department || 'Digital Transformation';
      const defaultUtilizationEligible = !(
        employeeCode.startsWith('ADMIN-') ||
        employeeCode.startsWith('HR-') ||
        employeeCode.startsWith('CD-') ||
        designation.toLowerCase() === 'country director' ||
        designation.toLowerCase() === 'system administrator' ||
        designation.toLowerCase() === 'hr manager' ||
        department.toLowerCase() === 'regional leadership' ||
        department.toLowerCase() === 'administration' ||
        department.toLowerCase() === 'human resources'
      );
      const utilizationEligible = parseBoolean(row.utilizationEligible, previous?.utilization_eligible ?? defaultUtilizationEligible);
      const standardWeeklyHours = row.standardWeeklyHours === undefined || row.standardWeeklyHours === ''
        ? Number(previous?.standard_weekly_hours || 40)
        : Number(row.standardWeeklyHours);
      const reactivationSavepoint = previous?.status === 'Exited' && targetStatus !== 'Exited'
        ? `employee_reactivation_${index}`
        : null;
      if (reactivationSavepoint) await client.query(`savepoint ${reactivationSavepoint}`);
      const employeeResult = await client.query(`
        insert into employees (
          id, employee_id, name, email, designation, department, country, region, business_unit, reporting_manager_id,
          primary_country_director_id, status, utilization_eligible, joining_date, exit_date,
          standard_weekly_hours, capacity_type, contract_type, entra_object_id, teams_user_id, organization_id, legal_entity_id, updated_at
        )
        values (coalesce($1, 'e-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now())
        on conflict (organization_id,employee_id) do update set
          name = excluded.name,
          email = excluded.email,
          designation = excluded.designation,
          department = excluded.department,
          country = excluded.country,
          region = excluded.region,
          business_unit = excluded.business_unit,
          reporting_manager_id = excluded.reporting_manager_id,
          primary_country_director_id = excluded.primary_country_director_id,
          status = excluded.status,
          utilization_eligible = excluded.utilization_eligible,
          joining_date = excluded.joining_date,
          exit_date = excluded.exit_date,
          standard_weekly_hours = excluded.standard_weekly_hours,
          capacity_type = excluded.capacity_type,
          contract_type = excluded.contract_type,
          entra_object_id = excluded.entra_object_id,
          teams_user_id = excluded.teams_user_id,
          updated_at = now()
        returning *
      `, [
        previous?.id || null,
        row.employeeId,
        row.name,
        row.email,
        designation,
        department,
        row.country || previous?.country || 'United Kingdom',
        row.region || previous?.region || row.country || previous?.country || null,
        row.businessUnit || previous?.business_unit || 'Other',
        reportingManagerId || previous?.reporting_manager_id || null,
        primaryDirectorId,
        row.status || previous?.status || 'Active',
        utilizationEligible,
        row.joiningDate || previous?.joining_date || null,
        employeeExitDate,
        Number.isFinite(standardWeeklyHours) ? standardWeeklyHours : 40,
        row.capacityType || previous?.capacity_type || (utilizationEligible ? 'Delivery' : 'Governance'),
        row.contractType || previous?.contract_type || 'Permanent',
        row.entraObjectId || previous?.entra_object_id || null,
        row.teamsUserId || previous?.teams_user_id || null,
        req.organizationScope.organizationId, req.organizationScope.legalEntityId,
      ]);
      const employee = employeeResult.rows[0];
      await initializeNewWorkerLifecycle(client, {
        employeeId: employee.id,
        organizationId: req.organizationScope.organizationId,
        legalEntityId: req.organizationScope.legalEntityId,
        actorId: req.user.sub,
        isNew: !previous,
      });
      const allMappedIds = Array.from(new Set([primaryDirectorId, ...mappedIds].filter(Boolean)));
      await client.query('delete from employee_country_director_map where employee_id = $1', [employee.id]);
      for (const directorId of allMappedIds) {
        await client.query(`
          insert into employee_country_director_map (employee_id, country_director_id)
          values ($1,$2)
          on conflict do nothing
        `, [employee.id, directorId]);
      }

      const existingUser = (await client.query('select id, username from users where employee_record_id = $1', [employee.id])).rows[0];
      if (!existingUser && !row.initialPassword) {
        throw new Error(`initialPassword is required for new user ${row.employeeId}`);
      }
      const passwordHash = existingUser ? null : await scryptHash(row.initialPassword);
      const baseUsername = row.employeeId.toLowerCase();
      const username = (existingUser?.username || !(await client.query('select 1 from users where lower(username) = lower($1)', [baseUsername])).rowCount)
        ? (existingUser?.username || baseUsername)
        : `${baseUsername}-${req.organizationScope.organizationId}-${req.organizationScope.legalEntityId}`.toLowerCase();
      const userResult = await client.query(`
        insert into users (username, employee_id, employee_record_id, email, password_hash, status, updated_at)
        values ($1,$2,$3,$4,$5,$6,now())
        on conflict (username) do update set
          employee_id = excluded.employee_id,
          employee_record_id = excluded.employee_record_id,
          email = excluded.email,
          password_hash = coalesce($5, users.password_hash),
          status = excluded.status,
          updated_at = now()
        returning id
      `, [
        username,
        row.employeeId,
        employee.id,
        row.email,
        passwordHash,
        employee.status === 'Exited' ? 'Disabled' : 'Active',
      ]);
      await client.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,$4) on conflict(user_id,organization_id,legal_entity_id) do update set active=excluded.active`,[userResult.rows[0].id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,employee.status !== 'Exited']);
      if (previous?.status === 'Exited' && employee.status !== 'Exited') {
        try {
          await synchronizeWorkerReactivation(client, {
            employeeId: employee.id,
            organizationId: req.organizationScope.organizationId,
            legalEntityId: req.organizationScope.legalEntityId,
            actorId: req.user.sub,
            effectiveFrom: new Date().toISOString().slice(0, 10),
            status: employee.status,
            reason: `Reactivated through employee import ${parsed.data.fileName}`,
            source: 'Employee import',
          });
          await client.query(`release savepoint ${reactivationSavepoint}`);
        } catch (error) {
          await client.query(`rollback to savepoint ${reactivationSavepoint}`);
          await client.query(`release savepoint ${reactivationSavepoint}`);
          if (!['WORKER_VERSION_CONFLICT', 'WORKER_IDENTITY_SYNC_CONFLICT'].includes(error.code)) throw error;
          errors.push({ rowNumber, field: 'status', message: `${error.message}.`, code: error.code });
          continue;
        }
      }
      const roleNames = splitPipeList(row.roles);
      const requestedRoles = roleNames.length > 0 ? roleNames : ['Employee'];
      const rolesResult = await client.query('select id, name from roles where name = any($1::text[])', [requestedRoles]);
      if (rolesResult.rows.length > 0) {
        await client.query('delete from user_roles where user_id = $1', [userResult.rows[0].id]);
        for (const role of rolesResult.rows) {
          await client.query('insert into user_roles (user_id, role_id) values ($1,$2) on conflict do nothing', [userResult.rows[0].id, role.id]);
        }
      } else if (employeeRole) {
        await client.query('insert into user_roles (user_id, role_id) values ($1,$2) on conflict do nothing', [userResult.rows[0].id, employeeRole.id]);
      }
      if (previous && previous.status !== 'Exited' && employee.status === 'Exited') {
        await synchronizeWorkerExit(client, req, employee, row.exitDate || new Date().toISOString().slice(0, 10), `Employee import ${parsed.data.fileName}`);
      }
      await audit(client, req, {
        module: 'Import',
        action: previous ? 'Import Update Employee' : 'Import Create Employee',
        entityType: 'Employee',
        entityId: employee.id,
        oldValue: previous,
        newValue: employee,
        details: `${previous ? 'Updated' : 'Created'} employee ${employee.employee_id} from ${parsed.data.fileName}`,
      });
      saved += 1;
    }

    const status = saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
    const logResult = await client.query(`
      insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
      values ('Import','Employee Master',$1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [
      parsed.data.fileName,
      status,
      parsed.data.totalRows ?? parsed.data.rows.length,
      saved,
      errors.length,
      errors.length ? JSON.stringify(errors) : null,
      req.user.username,
    ]);
    await client.query('commit');
    res.json({
      status,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      validRows: saved,
      errorRows: errors.length,
      errors,
      log: logResult.rows[0],
    });
  } catch (error) {
    await client.query('rollback');
    if (['WORKER_VERSION_CONFLICT', 'WORKER_IDENTITY_SYNC_CONFLICT'].includes(error.code)) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Employee import apply failed' });
  } finally {
    client.release();
  }
});

app.post('/api/imports/clients/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const rowSchema = z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    industry: z.string().optional(),
    accountOwnerId: z.string().optional(),
    countryDirectorIds: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.enum(['Active', 'Inactive']).optional(),
  });
  const schema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [
    { field: 'id', value: row.id, label: 'client ID' },
    { field: 'name', value: row.name, label: 'client name' },
  ]);
  const errors = [...(parsed.data.clientErrors || []), ...duplicateImportRows.errors];
  let saved = 0;
  try {
    await client.query('begin');
    const directorResult = await client.query('select id from country_directors');
    const directorIds = new Set(directorResult.rows.map(row => row.id));

    for (const [index, row] of parsed.data.rows.entries()) {
      const rowNumber = index + 2;
      if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
      const countryDirectorIds = splitPipeList(row.countryDirectorIds);
      const rowErrors = [];
      for (const directorId of countryDirectorIds) {
        if (!directorIds.has(directorId)) rowErrors.push({ rowNumber, field: 'countryDirectorIds', message: `Country director ${directorId} does not exist.` });
      }
      let accountOwnerId = row.accountOwnerId || null;
      if (accountOwnerId) {
        const owner = (await client.query(
          'select id from employees where (id = $1 or employee_id = $1) and status <> $2 and organization_id = $3 and legal_entity_id = $4',
          [accountOwnerId, 'Exited', req.organizationScope.organizationId, req.organizationScope.legalEntityId],
        )).rows[0];
        if (!owner) {
          rowErrors.push({ rowNumber, field: 'accountOwnerId', message: 'Account owner employee record does not exist or is exited.' });
        } else {
          accountOwnerId = owner.id;
        }
      }
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      const previous = (await client.query(`
        select *
        from clients
        where (($1::text is not null and id = $1) or lower(name) = lower($2))
          and organization_id = $3 and legal_entity_id = $4
        limit 1
      `, [row.id || null, row.name, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      const crossScopeClient = !previous && (await client.query(`
        select 1 from clients
        where ($1::text is not null and id = $1) or lower(name) = lower($2)
        limit 1
      `, [row.id || null, row.name])).rows[0];
      if (crossScopeClient) {
        errors.push({ rowNumber, field: row.id ? 'id' : 'name', message: 'Client is not available in the authorized organization and legal entity.' });
        continue;
      }
      const result = await client.query(`
        insert into clients (id, name, industry, account_owner_id, status, organization_id, legal_entity_id)
        values (coalesce($1, 'client-' || gen_random_uuid()::text), $2, $3, $4, $5, $6, $7)
        on conflict (id) do update set
          name = excluded.name,
          industry = excluded.industry,
          account_owner_id = excluded.account_owner_id,
          status = excluded.status,
          updated_at = now()
        returning *
      `, [
        previous?.id || row.id || null,
        row.name,
        row.industry || previous?.industry || 'Unclassified',
        accountOwnerId || previous?.account_owner_id || null,
        row.status || previous?.status || 'Active',
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      const savedClient = result.rows[0];
      await client.query('delete from client_country_director_map where client_id = $1', [savedClient.id]);
      for (const directorId of countryDirectorIds) {
        await client.query(`
          insert into client_country_director_map (client_id, country_director_id)
          values ($1, $2)
          on conflict do nothing
        `, [savedClient.id, directorId]);
      }
      await client.query(
        'update projects set client_id = $1, client = $2, updated_at = now() where organization_id = $4 and legal_entity_id = $5 and (client_id = $1 or client = $3)',
        [savedClient.id, savedClient.name, previous?.name || savedClient.name, req.organizationScope.organizationId, req.organizationScope.legalEntityId],
      );
      await audit(client, req, {
        module: 'Import',
        action: previous ? 'Import Update Client' : 'Import Create Client',
        entityType: 'Client',
        entityId: savedClient.id,
        oldValue: previous,
        newValue: savedClient,
        details: `${previous ? 'Updated' : 'Created'} client ${savedClient.name} from ${parsed.data.fileName}`,
      });
      saved += 1;
    }

    const status = saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
    const logResult = await client.query(`
      insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
      values ('Import','Client Master',$1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [
      parsed.data.fileName,
      status,
      parsed.data.totalRows ?? parsed.data.rows.length,
      saved,
      errors.length,
      errors.length ? JSON.stringify(errors) : null,
      req.user.username,
    ]);
    await client.query('commit');
    res.json({
      status,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      validRows: saved,
      errorRows: errors.length,
      errors,
      log: logResult.rows[0],
    });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Client import apply failed' });
  } finally {
    client.release();
  }
});

app.post('/api/imports/projects/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const rowSchema = z.object({
    projectCode: z.string().min(1),
    name: z.string().min(1),
    clientId: z.string().optional(),
    client: z.string().min(1),
    managerId: z.string().min(1),
    startDate: strictIsoDateSchema,
    endDate: strictIsoDateSchema,
    status: z.enum(['Proposed', 'Active', 'On Hold', 'Completed']).optional(),
    billable: z.union([z.boolean(), z.string()]).optional(),
    projectType: z.string().optional(),
    country: z.string().optional(),
    notes: z.string().optional(),
  });
  const schema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [
    { field: 'projectCode', value: row.projectCode, label: 'project code' },
  ]);
  const errors = [...(parsed.data.clientErrors || []), ...duplicateImportRows.errors];
  let saved = 0;
  try {
    await client.query('begin');

    for (const [index, row] of parsed.data.rows.entries()) {
      const rowNumber = index + 2;
      if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
      const rowErrors = [];
      if (row.endDate < row.startDate) {
        rowErrors.push({ rowNumber, field: 'endDate', message: 'End date must be on or after start date.' });
      }

      const clientRecord = (await client.query(`
        select id, name, status
        from clients
        where (($1::text is not null and id = $1) or lower(name) = lower($2))
          and organization_id=$3 and legal_entity_id=$4
        limit 1
      `, [row.clientId || null, row.client, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (!clientRecord || clientRecord.status !== 'Active') {
        rowErrors.push({ rowNumber, field: 'client', message: 'Project must reference an active client.' });
      }

      const manager = (await client.query(`
        select id, name, status
        from employees
        where (id = $1 or employee_id = $1) and status = 'Active'
          and organization_id=$2 and legal_entity_id=$3
        limit 1
      `, [row.managerId, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (!manager) {
        rowErrors.push({ rowNumber, field: 'managerId', message: 'Project manager employee record does not exist or is exited.' });
      }

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      const previous = (await client.query(`select * from projects where project_code=$1 and organization_id=$2 and legal_entity_id=$3 limit 1`,
        [row.projectCode, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      const crossLegalCollision = !previous && (await client.query(`select 1 from projects where project_code=$1 and organization_id=$2 and legal_entity_id<>$3 limit 1`,
        [row.projectCode, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (crossLegalCollision) {
        errors.push({ rowNumber, field: 'projectCode', message: 'Project code belongs to another legal entity in this organization.', code: 'PROJECT_SCOPE_CONFLICT' });
        continue;
      }
      const result = await client.query(`
        insert into projects (id, project_code, name, client_id, client, manager_id, manager_name, start_date, end_date, status, billable, project_type, country, notes, organization_id, legal_entity_id)
        values (coalesce($1, 'p-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        on conflict (organization_id,project_code) do update set
          name = excluded.name,
          client_id = excluded.client_id,
          client = excluded.client,
          manager_id = excluded.manager_id,
          manager_name = excluded.manager_name,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          status = excluded.status,
          billable = excluded.billable,
          project_type = excluded.project_type,
          country = excluded.country,
          notes = excluded.notes,
          updated_at = now()
        returning *
      `, [
        previous?.id || null,
        row.projectCode,
        row.name,
        clientRecord.id,
        clientRecord.name,
        manager.id,
        manager.name,
        row.startDate,
        row.endDate,
        row.status || previous?.status || 'Proposed',
        parseBoolean(row.billable, previous?.billable ?? true),
        row.projectType || previous?.project_type || null,
        row.country || previous?.country || null,
        row.notes || previous?.notes || null,
        req.organizationScope.organizationId, req.organizationScope.legalEntityId,
      ]);
      const project = result.rows[0];
      await audit(client, req, {
        module: 'Import',
        action: previous ? 'Import Update Project' : 'Import Create Project',
        entityType: 'Project',
        entityId: project.id,
        oldValue: previous,
        newValue: project,
        details: `${previous ? 'Updated' : 'Created'} project ${project.project_code} from ${parsed.data.fileName}`,
      });
      saved += 1;
    }

    const status = saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
    const logResult = await client.query(`
      insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
      values ('Import','Project Master',$1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [
      parsed.data.fileName,
      status,
      parsed.data.totalRows ?? parsed.data.rows.length,
      saved,
      errors.length,
      errors.length ? JSON.stringify(errors) : null,
      req.user.username,
    ]);
    await client.query('commit');
    res.json({
      status,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      validRows: saved,
      errorRows: errors.length,
      errors,
      log: logResult.rows[0],
    });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Project import apply failed' });
  } finally {
    client.release();
  }
});

app.post('/api/imports/allocations/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const rowSchema = z.object({
    id: z.string().min(1).optional(),
    employeeId: z.string().min(1),
    projectId: z.string().min(1),
    roleOnProject: z.string().optional(),
    percentage: z.coerce.number().min(0).max(200),
    startDate: strictIsoDateSchema,
    endDate: strictIsoDateSchema,
    billable: z.union([z.boolean(), z.string()]).optional(),
    status: z.enum(['Active', 'Paused', 'Completed']).optional(),
    comments: z.string().optional(),
  });
  const schema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [
    { field: 'id', value: row.id, label: 'allocation ID' },
  ]);
  const errors = [...(parsed.data.clientErrors || []), ...duplicateImportRows.errors];
  let saved = 0;
  try {
    await client.query('begin');
    const blockOverAllocation = await getSetting('blockOverAllocation', false);

    for (const [index, row] of parsed.data.rows.entries()) {
      const rowNumber = index + 2;
      if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
      const rowErrors = [];
      if (row.endDate < row.startDate) {
        rowErrors.push({ rowNumber, field: 'endDate', message: 'End date must be on or after start date.' });
      }

      const employee = (await client.query(`
        select *
        from employees
        where (id = $1 or employee_id = $1) and status <> 'Exited'
          and organization_id=$2 and legal_entity_id=$3
        limit 1
      `, [row.employeeId,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if (!employee) {
        rowErrors.push({ rowNumber, field: 'employeeId', message: 'Allocation must reference an active employee.' });
      }

      const project = (await client.query(`
        select *
        from projects
        where (id = $1 or project_code = $1) and status in ('Active', 'Proposed')
          and organization_id=$2 and legal_entity_id=$3
        limit 1
      `, [row.projectId,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if (!project) {
        rowErrors.push({ rowNumber, field: 'projectId', message: 'Allocation must reference an active or proposed project.' });
      } else if (row.startDate < toIsoDate(project.start_date) || row.endDate > toIsoDate(project.end_date)) {
        rowErrors.push({ rowNumber, field: 'startDate', message: 'Allocation dates must stay within the project timeline.' });
      }

      if (blockOverAllocation && employee && row.status !== 'Paused' && row.status !== 'Completed') {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [employee.id]);
        const loadResult = await client.query(`
          select coalesce(sum(percentage), 0) as total
          from project_allocations
          where employee_id = $1
            and organization_id = $5 and legal_entity_id = $6
            and id <> coalesce($2, '')
            and status = 'Active'
            and daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
        `, [employee.id, row.id || null, row.startDate, row.endDate, req.organizationScope.organizationId, req.organizationScope.legalEntityId]);
        const total = parsePercent(loadResult.rows[0]?.total) + row.percentage;
        if (total > 100) {
          rowErrors.push({ rowNumber, field: 'percentage', message: `Allocation would exceed 100% for overlapping dates (${total}%).` });
        }
      }

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      const previous = row.id
        ? (await client.query(`select pa.* from project_allocations pa
          join projects p on p.id=pa.project_id and p.organization_id=pa.organization_id
          join employees e on e.id=pa.employee_id and e.organization_id=pa.organization_id
          where pa.id=$1 and pa.organization_id=$2 and pa.legal_entity_id=$3 and p.legal_entity_id=$3 and e.legal_entity_id=$3 limit 1`,
        [row.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0]
        : null;
      if (row.id && !previous && (await client.query('select 1 from project_allocations where id=$1',[row.id])).rowCount) {
        errors.push({rowNumber,field:'id',message:'Allocation is not available in the authorized organization and legal entity.'});
        continue;
      }
      const result = await client.query(`
        insert into project_allocations (id, employee_id, project_id, role_on_project, percentage, start_date, end_date, billable, status, comments, organization_id, legal_entity_id)
        values (coalesce($1, 'a-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (id) do update set
          employee_id = excluded.employee_id,
          project_id = excluded.project_id,
          role_on_project = excluded.role_on_project,
          percentage = excluded.percentage,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          billable = excluded.billable,
          status = excluded.status,
          comments = excluded.comments,
          updated_at = now()
        where project_allocations.organization_id=excluded.organization_id and project_allocations.legal_entity_id=excluded.legal_entity_id
        returning *
      `, [
        previous?.id || row.id || null,
        employee.id,
        project.id,
        row.roleOnProject || previous?.role_on_project || employee.designation,
        row.percentage,
        row.startDate,
        row.endDate,
        parseBoolean(row.billable, previous?.billable ?? true),
        row.status || previous?.status || 'Active',
        row.comments || previous?.comments || null,
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      const allocation = result.rows[0];
      await audit(client, req, {
        module: 'Import',
        action: previous ? 'Import Update Allocation' : 'Import Create Allocation',
        entityType: 'Allocation',
        entityId: allocation.id,
        oldValue: previous,
        newValue: allocation,
        details: `${previous ? 'Updated' : 'Created'} allocation for ${employee.employee_id} on ${project.project_code} from ${parsed.data.fileName}`,
      });
      saved += 1;
    }

    const status = saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
    const logResult = await client.query(`
      insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
      values ('Import','Allocation Control',$1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [
      parsed.data.fileName,
      status,
      parsed.data.totalRows ?? parsed.data.rows.length,
      saved,
      errors.length,
      errors.length ? JSON.stringify(errors) : null,
      req.user.username,
    ]);
    await client.query('commit');
    res.json({
      status,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      validRows: saved,
      errorRows: errors.length,
      errors,
      log: logResult.rows[0],
    });
  } catch (error) {
    await client.query('rollback');
    console.error(error);
    res.status(500).json({ error: 'Allocation import apply failed' });
  } finally {
    client.release();
  }
});

app.post('/api/imports/timesheets/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
  const rowSchema = z.object({
    employeeId: z.string().min(1),
    weekEnding: strictIsoDateSchema,
    workType: z.enum(['Project Work', 'Client Misc Task']),
    projectId: z.string().optional(),
    clientName: z.string().optional(),
    category: z.string().optional(),
    date: strictIsoDateSchema,
    hours: z.coerce.number().min(0).max(24),
    remark: z.string().optional(),
    billable: z.union([z.boolean(), z.string()]).optional(),
    status: z.enum(['Draft', 'Submitted', 'Approved', 'Rejected']).optional(),
    rejectionReason: z.string().optional(),
  });
  const schema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(z.object({
      rowNumber: z.number().int(),
      field: z.string().optional(),
      message: z.string(),
    })).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [{
    field: 'timesheetEntryKey',
    label: 'Timesheet entry key',
    value: [row.employeeId, row.weekEnding, row.date, row.workType, row.projectId || row.clientName].join('|'),
  }]);
  const client = await pool.connect();
  const errors = [...(parsed.data.clientErrors || []), ...duplicateImportRows.errors];
  const groups = new Map();
  let validEntryRows = 0;
  try {
    await client.query('begin');

    for (const [index, row] of parsed.data.rows.entries()) {
      const rowNumber = index + 2;
      if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
      const rowErrors = [];
      if (isAfterToday(row.weekEnding) || isAfterToday(row.date)) {
        rowErrors.push({ rowNumber, field: 'date', message: 'Future week timesheets and future-dated entries cannot be imported.' });
      }

      const employee = (await client.query(`
        select id, employee_id, name, status
        from employees
        where (id = $1 or employee_id = $1)
          and organization_id = $2 and legal_entity_id = $3
          and status <> 'Exited'
        limit 1
      `, [row.employeeId, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
      if (!employee) {
        rowErrors.push({ rowNumber, field: 'employeeId', message: 'Timesheet must reference an active employee.' });
      }

      let project = null;
      if (row.workType === 'Project Work') {
        if (!row.projectId) {
          rowErrors.push({ rowNumber, field: 'projectId', message: 'Project Work entries require a project.' });
        } else {
          project = (await client.query(`
            select id, name, status
            from projects
            where (id = $1 or project_code = $1)
              and organization_id = $2 and legal_entity_id = $3
              and status <> 'Completed'
            limit 1
          `, [row.projectId, req.organizationScope.organizationId, req.organizationScope.legalEntityId])).rows[0];
          if (!project) {
            rowErrors.push({ rowNumber, field: 'projectId', message: 'Project Work entries must reference active, proposed, or on-hold projects.' });
          } else if (!(await client.query(`
            select 1 from project_allocations
            where employee_id = $1 and project_id = $2
              and organization_id = $3 and legal_entity_id = $4
              and status = 'Active' and $5::date between start_date and end_date
            limit 1
          `, [employee?.id || '', project.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId, row.date])).rows[0]) {
            rowErrors.push({ rowNumber, field: 'projectId', message: 'Project work requires an active allocation covering the entry date.' });
          }
        }
      }
      if (row.workType === 'Client Misc Task' && !row.clientName) {
        rowErrors.push({ rowNumber, field: 'clientName', message: 'Client Misc Task entries require a client name.' });
      }

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      const status = row.status || 'Submitted';
      const key = `${employee.id}:${row.weekEnding}`;
      const group = groups.get(key) || {
        employee,
        weekEnding: row.weekEnding,
        status,
        rejectionReason: row.rejectionReason || null,
        entries: [],
      };
      if (group.status !== status) {
        errors.push({ rowNumber, field: 'status', message: 'Rows for the same employee/week must use the same timesheet status.' });
        continue;
      }
      group.entries.push({
        rowNumber,
        projectId: project?.id || null,
        workType: row.workType,
        clientName: row.clientName || null,
        category: row.category || null,
        workDate: row.date,
        hours: round1(row.hours),
        remark: row.remark || null,
        billable: parseBoolean(row.billable, row.workType === 'Project Work'),
      });
      groups.set(key, group);
      validEntryRows += 1;
    }

    for (const group of groups.values()) {
      try {
        await assertReportingPeriodAllows(client, {
          organizationId: req.organizationScope.organizationId,
          legalEntityId: req.organizationScope.legalEntityId,
          relevantDates: [group.weekEnding, ...group.entries.map(entry => entry.workDate)],
          operation: REPORTING_PERIOD_OPERATIONS.CONTENT,
        });
      } catch (error) {
        if (!(error instanceof ReportingPeriodError)) throw error;
        errors.push(...group.entries.map(entry => ({ rowNumber: entry.rowNumber, field: 'date', message: error.message, code: error.code })));
        validEntryRows -= group.entries.length;
        continue;
      }
      const totalHours = round1(group.entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0));
      const billableHours = round1(group.entries.filter(entry => entry.billable).reduce((sum, entry) => sum + Number(entry.hours || 0), 0));
      const previous = (await client.query('select * from timesheets where organization_id = $1 and legal_entity_id = $2 and employee_id = $3 and week_ending = $4 for update', [req.organizationScope.organizationId, req.organizationScope.legalEntityId, group.employee.id, group.weekEnding])).rows[0];
      const timesheetResult = await client.query(`
        insert into timesheets (employee_id, week_ending, status, total_hours, billable_hours, rejection_reason, submitted_at, organization_id, legal_entity_id)
        values ($1,$2,$3,$4,$5,$6, case when $3 = 'Submitted' then now() else null end,$7,$8)
        on conflict (organization_id, employee_id, week_ending) do update set
          status = excluded.status,
          total_hours = excluded.total_hours,
          billable_hours = excluded.billable_hours,
          rejection_reason = excluded.rejection_reason,
          submitted_at = case when excluded.status = 'Submitted' then coalesce(timesheets.submitted_at, now()) else timesheets.submitted_at end,
          updated_at = now()
        returning *
      `, [
        group.employee.id,
        group.weekEnding,
        group.status,
        totalHours,
        billableHours,
        group.rejectionReason,
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      const timesheet = timesheetResult.rows[0];
      await client.query('delete from timesheet_entries where timesheet_id = $1', [timesheet.id]);
      for (const entry of group.entries) {
        await client.query(`
          insert into timesheet_entries (timesheet_id, project_id, work_type, client_name, category, work_date, hours, remark, billable)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
          timesheet.id,
          entry.projectId,
          entry.workType,
          entry.clientName,
          entry.category,
          entry.workDate,
          entry.hours,
          entry.remark,
          entry.billable,
        ]);
      }
      await audit(client, req, {
        module: 'Import',
        action: previous ? 'Import Update Timesheet' : 'Import Create Timesheet',
        entityType: 'Timesheet',
        entityId: String(timesheet.id),
        oldValue: previous,
        newValue: timesheet,
        details: `${previous ? 'Updated' : 'Created'} ${group.status} timesheet for ${group.employee.employee_id}, week ending ${group.weekEnding} from ${parsed.data.fileName}`,
        reason: group.rejectionReason,
      });
    }

    const status = validEntryRows === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
    const logResult = await client.query(`
      insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name)
      values ('Import','Timesheet Import',$1,$2,$3,$4,$5,$6,$7)
      returning *
    `, [
      parsed.data.fileName,
      status,
      parsed.data.totalRows ?? parsed.data.rows.length,
      validEntryRows,
      errors.length,
      errors.length ? JSON.stringify(errors) : null,
      req.user.username,
    ]);
    await client.query('commit');
    res.json({
      status,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      validRows: validEntryRows,
      errorRows: errors.length,
      errors,
      log: logResult.rows[0],
    });
  } catch (error) {
    await client.query('rollback');
    if (sendReportingPeriodError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Timesheet import apply failed' });
  } finally {
    client.release();
  }
});

registerOrganizationSetupRoutes({
  app,
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  audit,
  mountPaths: ['/api/organization-setup', '/api/v1/organization-setup'],
});

app.use('/api/v1', versionedApiErrorHandler);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (isProduction || process.env.SERVE_STATIC === 'true') {
  if (existsSync(distDir)) {
    app.use('/assets', express.static(join(distDir, 'assets'), {
      immutable: true,
      maxAge: '1y',
    }));
    app.use(express.static(distDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    }));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/assets/')) {
        res.status(404).send('Asset not found');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(distDir, 'index.html'));
    });
  } else if (isProduction) {
    console.error(`Production startup blocked. Built frontend not found at ${distDir}. Run npm run build first.`);
    process.exit(1);
  }
}

app.listen(port, () => {
  console.log(`Configured product Workforce Operations Core API listening on http://localhost:${port}`);
});
