import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';
import { authService } from './services/authService';
import { getOrganizationScope } from './services/apiClient';
import { canOpenAuditWithoutOrganizationScope, hasRouteRole, ROUTE_ROLES } from './services/accessControl';
import { UserRole } from './types';
import { EnterpriseFeatureFlag, isEnterpriseFeatureEnabled } from './config/featureFlags';
import { RuntimeTerminology } from './config/RuntimeTerminology';
import { OrganizationScopeGate } from './components/auth/OrganizationScopeGate';

const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const EmployeeMaster = lazy(() => import('./pages/EmployeeMaster').then(module => ({ default: module.EmployeeMaster })));
const EmployeeDetail = lazy(() => import('./pages/EmployeeDetail').then(module => ({ default: module.EmployeeDetail })));
const EmployeeWorkspace = lazy(() => import('./pages/EmployeeWorkspace').then(module => ({ default: module.EmployeeWorkspace })));
const ProjectMaster = lazy(() => import('./pages/ProjectMaster').then(module => ({ default: module.ProjectMaster })));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail').then(module => ({ default: module.ProjectDetail })));
const ProjectManagerWorkspace = lazy(() => import('./pages/ProjectManagerWorkspace').then(module => ({ default: module.ProjectManagerWorkspace })));
const PlanningWorkspace = lazy(() => import('./pages/PlanningWorkspace').then(module => ({ default: module.PlanningWorkspace })));
const ActionCenterHub = lazy(() => import('./pages/ActionCenterHub').then(module => ({ default: module.ActionCenterHub })));
const ClientPortfolio = lazy(() => import('./pages/ClientPortfolio').then(module => ({ default: module.ClientPortfolio })));
const MyTimesheet = lazy(() => import('./pages/MyTimesheet').then(module => ({ default: module.MyTimesheet })));
const TimesheetApproval = lazy(() => import('./pages/TimesheetApproval').then(module => ({ default: module.TimesheetApproval })));
const PlannedUtilization = lazy(() => import('./pages/PlannedUtilization').then(module => ({ default: module.PlannedUtilization })));
const ActualUtilization = lazy(() => import('./pages/ActualUtilization').then(module => ({ default: module.ActualUtilization })));
const ForecastUtilization = lazy(() => import('./pages/ForecastUtilization').then(module => ({ default: module.ForecastUtilization })));
const UtilizationReports = lazy(() => import('./pages/UtilizationReports').then(module => ({ default: module.UtilizationReports })));
const ReportsCenter = lazy(() => import('./pages/ReportsCenter').then(module => ({ default: module.ReportsCenter })));
const DataQuality = lazy(() => import('./pages/DataQuality').then(module => ({ default: module.DataQuality })));
const BRDTraceability = lazy(() => import('./pages/BRDTraceability').then(module => ({ default: module.BRDTraceability })));
const EnterpriseModuleShell = lazy(() => import('./pages/EnterpriseModuleShell').then(module => ({ default: module.EnterpriseModuleShell })));
const ESSHome = lazy(() => import('./pages/LeaveManagement').then(module => ({ default: module.ESSHome })));
const MyLeave = lazy(() => import('./pages/LeaveManagement').then(module => ({ default: module.MyLeave })));
const TeamLeaveCalendar = lazy(() => import('./pages/LeaveManagement').then(module => ({ default: module.TeamLeaveCalendar })));
const LeaveAdmin = lazy(() => import('./pages/LeaveManagement').then(module => ({ default: module.LeaveAdmin })));
const ApprovalsWorkspace = lazy(() => import('./pages/ApprovalsWorkspace').then(module => ({ default: module.ApprovalsWorkspace })));
const NotificationCenter = lazy(() => import('./pages/NotificationCenter').then(module => ({ default: module.NotificationCenter })));
const IdentityIntegration = lazy(() => import('./pages/IntegrationsWorkspace').then(module => ({ default: module.IdentityIntegration })));
const TeamsIntegration = lazy(() => import('./pages/IntegrationsWorkspace').then(module => ({ default: module.TeamsIntegration })));
const TeamsActionLanding = lazy(() => import('./pages/TeamsActionLanding').then(module => ({ default: module.TeamsActionLanding })));
const EntraLoginComplete = lazy(() => import('./pages/EntraLoginComplete').then(module => ({ default: module.EntraLoginComplete })));
const ImportExport = lazy(() => import('./pages/ImportExport').then(module => ({ default: module.ImportExport })));
const AuditTrail = lazy(() => import('./pages/AuditTrail').then(module => ({ default: module.AuditTrail })));
const WorkingCalendarInspector = lazy(() => import('./pages/WorkingCalendarInspector').then(module => ({ default: module.WorkingCalendarInspector })));
const TerminologyConfigurationEditor = lazy(() => import('./pages/TerminologyConfigurationEditor').then(module => ({ default: module.TerminologyConfigurationEditor })));
const OrganizationProfileEditor = lazy(() => import('./pages/OrganizationProfileEditor').then(module => ({ default: module.OrganizationProfileEditor })));
const AdminSettings = lazy(() => import('./pages/AdminSettings').then(module => ({ default: module.AdminSettings })));
const Login = lazy(() => import('./pages/Login').then(module => ({ default: module.Login })));

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  if (!authService.isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  const user = authService.getCurrentUser();
  const canUseScopeFreeAudit = canOpenAuditWithoutOrganizationScope(user);
  const auditScopeFreePath = canUseScopeFreeAudit
    && ['/', '/audit', '/audit-trail'].includes(location.pathname);
  return <OrganizationScopeGate allowAuditWithoutScope={auditScopeFreePath}>
    <RuntimeTerminology>{children}</RuntimeTerminology>
  </OrganizationScopeGate>;
};

const RoleRoute = ({ children, roles }: { children: React.ReactNode; roles: readonly UserRole[] }) => {
  const user = authService.getCurrentUser();
  if (!hasRouteRole(user, roles)) {
    return <Navigate to="/no-access" replace />;
  }
  return <>{children}</>;
};

const FeatureRoute = ({
  children,
  flag,
  roles,
}: {
  children: React.ReactNode;
  flag: EnterpriseFeatureFlag;
  roles: readonly UserRole[];
}) => {
  if (!isEnterpriseFeatureEnabled(flag)) {
    return <Navigate to="/governance/brd-traceability" replace />;
  }
  return <RoleRoute roles={roles}>{children}</RoleRoute>;
};

const getRoleHomePath = (role: UserRole) => {
  if (role === 'Employee') return '/ess';
  if (role === 'ProjectManager') return '/pm-workspace';
  if (role === 'TeamLead') return '/timesheets/approval';
  return null;
};

const DashboardRoute = () => {
  const user = authService.getCurrentUser();
  if (!user) return <Navigate to="/login" replace />;
  if (canOpenAuditWithoutOrganizationScope(user) && !getOrganizationScope()) {
    return <Navigate to="/audit-trail" replace />;
  }
  if (!hasRouteRole(user, ROUTE_ROLES.dashboard)) {
    return <Navigate to={getRoleHomePath(user.role) || '/no-access'} replace />;
  }
  return <Dashboard />;
};

const EmployeeDetailRoute = () => {
  const user = authService.getCurrentUser();
  if (!user) return <Navigate to="/" replace />;
  return <EmployeeDetail />;
};

const ProjectDetailRoute = () => {
  const user = authService.getCurrentUser();
  if (!user) return <Navigate to="/" replace />;
  return <ProjectDetail />;
};

const NotFound = () => (
  <div className="h-[60vh] flex flex-col items-center justify-center text-center px-6">
    <h1 className="text-3xl font-black text-heading">Page not found</h1>
    <p className="text-sm text-body/60 mt-2 max-w-md">The route you opened is not part of the utilization tracker workspace.</p>
    <Link to="/" className="btn-primary py-2.5 px-6 mt-8">Return to Dashboard</Link>
  </div>
);

const NoAccess = () => (
  <div className="h-[60vh] flex flex-col items-center justify-center text-center px-6">
    <h1 className="text-3xl font-black text-heading">Access denied</h1>
    <p className="text-sm text-body/60 mt-2 max-w-md">Your active role does not grant access to this page.</p>
  </div>
);

const RouteFallback = () => (
  <div className="h-[50vh] flex items-center justify-center">
    <div className="h-8 w-8 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
  </div>
);

export default function App() {
  return (
    <Router>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/entra/complete" element={<EntraLoginComplete />} />

          <Route path="/*" element={
            <ProtectedRoute>
              <AppLayout>
                <Routes>
                  <Route path="/no-access" element={<NoAccess />} />
                  <Route path="/" element={<DashboardRoute />} />
                  <Route path="/dashboard" element={<Navigate to="/" replace />} />

                {/* Employee Routes */}
                <Route path="/my-workspace" element={
                  <RoleRoute roles={ROUTE_ROLES.employeeWorkspace}>
                    <EmployeeWorkspace />
                  </RoleRoute>
                } />
                <Route path="/employees" element={
                  <RoleRoute roles={ROUTE_ROLES.employees}>
                    <EmployeeMaster />
                  </RoleRoute>
                } />
                <Route path="/employees/:id" element={<EmployeeDetailRoute />} />

                {/* Project Routes */}
                <Route path="/pm-workspace" element={
                  <RoleRoute roles={ROUTE_ROLES.projectManagerWorkspace}>
                    <ProjectManagerWorkspace />
                  </RoleRoute>
                } />
                <Route path="/planning" element={
                  <RoleRoute roles={ROUTE_ROLES.planningWorkspace}>
                    <PlanningWorkspace />
                  </RoleRoute>
                } />
                <Route path="/action-center" element={
                  <RoleRoute roles={ROUTE_ROLES.actionCenter}>
                    <ActionCenterHub />
                  </RoleRoute>
                } />
                <Route path="/projects" element={
                  <RoleRoute roles={ROUTE_ROLES.projects}>
                    <ProjectMaster />
                  </RoleRoute>
                } />
                <Route path="/projects/:id" element={<ProjectDetailRoute />} />
                <Route path="/clients" element={
                  <RoleRoute roles={ROUTE_ROLES.clients}>
                    <ClientPortfolio />
                  </RoleRoute>
                } />

                <Route path="/allocations" element={
                  <RoleRoute roles={ROUTE_ROLES.allocations}>
                    <PlanningWorkspace />
                  </RoleRoute>
                } />
                <Route path="/timesheets" element={
                  <RoleRoute roles={ROUTE_ROLES.timesheets}>
                    <MyTimesheet />
                  </RoleRoute>
                } />
                <Route path="/timesheets/my" element={
                  <Navigate to="/timesheets" replace />
                } />
                <Route path="/timesheets/approval" element={
                  <RoleRoute roles={ROUTE_ROLES.timesheetApproval}>
                    <TimesheetApproval />
                  </RoleRoute>
                } />

                {/* Utilization Routes */}
                <Route path="/reports/utilization" element={
                  <RoleRoute roles={ROUTE_ROLES.utilization}>
                    <UtilizationReports />
                  </RoleRoute>
                } />
                <Route path="/reports/center" element={
                  <RoleRoute roles={ROUTE_ROLES.reportsCenter}>
                    <ReportsCenter />
                  </RoleRoute>
                } />
                <Route path="/reports/utilization/planned" element={
                  <Navigate to="/utilization/planned" replace />
                } />
                <Route path="/reports/utilization/current" element={
                  <Navigate to="/utilization/actual" replace />
                } />
                <Route path="/reports/utilization/actual" element={
                  <Navigate to="/utilization/actual" replace />
                } />
                <Route path="/reports/utilization/forecast" element={
                  <Navigate to="/utilization/forecast" replace />
                } />
                <Route path="/utilization/planned" element={
                  <RoleRoute roles={ROUTE_ROLES.utilization}>
                    <PlannedUtilization />
                  </RoleRoute>
                } />
                <Route path="/utilization/actual" element={
                  <RoleRoute roles={ROUTE_ROLES.utilization}>
                    <ActualUtilization />
                  </RoleRoute>
                } />
                <Route path="/utilization/forecast" element={
                  <RoleRoute roles={ROUTE_ROLES.utilization}>
                    <ForecastUtilization />
                  </RoleRoute>
                } />
                <Route path="/reports/data-quality" element={
                  <RoleRoute roles={ROUTE_ROLES.dataQuality}>
                    <DataQuality />
                  </RoleRoute>
                } />
                <Route path="/governance/brd-traceability" element={
                  <RoleRoute roles={ROUTE_ROLES.brdTraceability}>
                    <BRDTraceability />
                  </RoleRoute>
                } />
                <Route path="/ess" element={
                  <RoleRoute roles={ROUTE_ROLES.ess}>
                    <ESSHome />
                  </RoleRoute>
                } />
                <Route path="/leave/my" element={
                  <FeatureRoute flag="leave" roles={ROUTE_ROLES.leaveSelfService}>
                    <MyLeave />
                  </FeatureRoute>
                } />
                <Route path="/leave/team-calendar" element={
                  <FeatureRoute flag="leave" roles={ROUTE_ROLES.leaveTeam}>
                    <TeamLeaveCalendar />
                  </FeatureRoute>
                } />
                <Route path="/leave/admin" element={
                  <FeatureRoute flag="leave" roles={ROUTE_ROLES.leaveAdmin}>
                    <LeaveAdmin />
                  </FeatureRoute>
                } />
                <Route path="/approvals" element={
                  <FeatureRoute flag="notifications" roles={ROUTE_ROLES.approvals}>
                    <ApprovalsWorkspace />
                  </FeatureRoute>
                } />
                <Route path="/notifications" element={
                  <FeatureRoute flag="notifications" roles={ROUTE_ROLES.notifications}>
                    <NotificationCenter />
                  </FeatureRoute>
                } />
                <Route path="/integrations/identity" element={
                  <FeatureRoute flag="entra" roles={ROUTE_ROLES.identityIntegrations}>
                    <IdentityIntegration />
                  </FeatureRoute>
                } />
                <Route path="/integrations/teams" element={
                  <FeatureRoute flag="teams" roles={ROUTE_ROLES.teamsIntegrations}>
                    <TeamsIntegration />
                  </FeatureRoute>
                } />
                <Route path="/teams/actions/:token" element={
                  <FeatureRoute flag="teams" roles={ROUTE_ROLES.teamsActions}>
                    <TeamsActionLanding />
                  </FeatureRoute>
                } />
                <Route path="/planning/resources" element={
                  <RoleRoute roles={ROUTE_ROLES.planningWorkspace}>
                    <Navigate to="/planning" replace />
                  </RoleRoute>
                } />
                <Route path="/reports/command-center" element={
                  <Navigate to="/" replace />
                } />

                {/* System Routes */}
                <Route path="/import-export" element={
                  <RoleRoute roles={ROUTE_ROLES.importExport}>
                    <ImportExport />
                  </RoleRoute>
                } />
                <Route path="/audit-trail" element={
                  <RoleRoute roles={ROUTE_ROLES.auditTrail}>
                    <AuditTrail />
                  </RoleRoute>
                } />
                <Route path="/audit" element={
                  <RoleRoute roles={ROUTE_ROLES.auditTrail}>
                    <AuditTrail />
                  </RoleRoute>
                } />
                <Route path="/admin" element={
                  <RoleRoute roles={ROUTE_ROLES.adminSettings}>
                    <AdminSettings />
                  </RoleRoute>
                } />
                <Route path="/admin/organization-profile" element={
                  <RoleRoute roles={ROUTE_ROLES.adminSettings}>
                    <OrganizationProfileEditor />
                  </RoleRoute>
                } />
                <Route path="/admin/working-calendars" element={
                  <RoleRoute roles={ROUTE_ROLES.adminSettings}>
                    <WorkingCalendarInspector />
                  </RoleRoute>
                } />
                <Route path="/admin/terminology" element={
                  <RoleRoute roles={ROUTE_ROLES.adminSettings}>
                    <TerminologyConfigurationEditor />
                  </RoleRoute>
                } />
                <Route path="/admin/settings" element={
                  <Navigate to="/admin" replace />
                } />

                {/* Catch all */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </AppLayout>
            </ProtectedRoute>
          } />
        </Routes>
      </Suspense>
    </Router>
  );
}
