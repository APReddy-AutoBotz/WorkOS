import { ClipboardCheck, Layers3, MonitorCheck, ShieldCheck } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';

import { productConfig } from '../config/productConfig';
type EngineeringStatus = 'Prod Core RC' | 'Company Input Blocked' | 'Post-Go-Live';
type ReleaseGate = 'Ready for UAT' | 'Company UAT Required' | 'Credential/Consent Required' | 'Owner/Policy Sign-off Required' | 'Post-Go-Live';
type UiStatus = 'Available' | 'Release-gated' | 'Not required';

interface TraceabilityRow {
  module: string;
  brdIntent: string;
  phase: 'Production Core' | 'Enterprise Workforce OS' | 'Company Handover';
  engineeringStatus: EngineeringStatus;
  releaseGate: ReleaseGate;
  uiStatus: UiStatus;
  apiDataStatus: string;
  evidenceNeeded: string;
  companyOwnerNeeded: string;
}

const rows: TraceabilityRow[] = [
  {
    module: 'Employee Master as root',
    brdIntent: 'Employee records drive identity, reporting lines, capacity, utilization, allocations, approvals, future leave, and Teams identity.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: 'Employee UI, backend APIs, production fields, identity placeholders, and import template are in place.',
    evidenceNeeded: 'Attach real/UAT data load evidence, manager/CD/capacity validation, identity mapping evidence, and role-scope UAT.',
    companyOwnerNeeded: 'HR data owner and workforce governance owner.',
  },
  {
    module: `ESS / My ${productConfig.productName} Hub`,
    brdIntent: 'Employees can see their own profile, work context, projects, utilization, timesheet status, leave, notifications, actions, and identity readiness.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: `My ${productConfig.productName} Hub is the primary /ess employee surface. It composes employee master, manager and ${productConfig.terminology.regionalOwner} mappings, capacity/employment fields, allocation/project work, planned utilization, approved-timesheet actual utilization, current timesheet status, actionable personal follow-ups, optional leave, notifications, and identity readiness. /my-workspace remains a compatibility route only.`,
    evidenceNeeded: 'Attach Employee browser UAT proving profile, work, utilization, actions, leave, notifications, and identity readiness against hosted UAT data.',
    companyOwnerNeeded: 'Employee UAT lead and HR process owner.',
  },
  {
    module: 'Client and Project Master',
    brdIntent: 'Maintain trusted client/project data with ownership, project timelines, resources, and status.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: `Client, project, detail, allocation links, scoped APIs, CSV imports, ${productConfig.terminology.regionalOwner} project scoping, and Admin/HR mutation gating exist. Project Detail uses derived delivery signals and approved timesheet evidence instead of static operational content.`,
    evidenceNeeded: 'Attach real client/project file validation, scoped Project Master UAT, report reconciliation, and audit evidence.',
    companyOwnerNeeded: 'Delivery operations owner and client/project data owner.',
  },
  {
    module: 'Allocation Management',
    brdIntent: 'Track project allocation percentages, date ranges, staffing pressure, and planned utilization.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: 'Allocation UI and backend endpoints exist with validation and duplicate import guardrails.',
    evidenceNeeded: 'Attach DB-backed allocation parity fixtures, concurrency checks, role-scope UAT, and import/export audit evidence.',
    companyOwnerNeeded: 'Resource planning owner and delivery governance owner.',
  },
  {
    module: 'Timesheet Management',
    brdIntent: 'Employees submit weekly client/project time; approvers approve/reject; approved time drives actual utilization.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Available',
    apiDataStatus: 'Self-log, governance UI, backend endpoints, approval/rejection, and import apply path exist.',
    evidenceNeeded: 'Attach PM/Team Lead authority sign-off, backend role evidence, browser UAT, and approval/rejection audit evidence.',
    companyOwnerNeeded: 'Timesheet policy owner and delivery leadership.',
  },
  {
    module: 'Workforce Action Signals',
    brdIntent: 'Expose executive workforce KPIs, attention items, utilization health, and data confidence.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: 'Overview Dashboard remains intact for operational KPIs and now uses one Action Queue for people and delivery follow-ups. Duplicate command-center risk panels, top-risk panels, capacity-risk charts, and project-health tables were removed to reduce duplication.',
    evidenceNeeded: 'Attach role-by-role backend browser evidence and dashboard/report reconciliation against hosted UAT data.',
    companyOwnerNeeded: 'Executive UAT sponsor and reporting owner.',
  },
  {
    module: 'Reports',
    brdIntent: 'Provide scoped utilization, timesheet, allocation, data-quality, and audit reporting.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: 'Utilization Reports is now a first-class Reports entry for planned, current, and forecast reports. Reports Center owns controlled CSV downloads. Dashboard action signals, data-quality, availability, planning, import/export history, and audit surfaces exist.',
    evidenceNeeded: 'Attach DB-backed calculation fixtures, export-scope checks, browser workflows, and source-file reconciliation.',
    companyOwnerNeeded: 'Reporting owner and source-data owner.',
  },
  {
    module: 'Planning Workspace',
    brdIntent: 'Plan workforce capacity and update allocation records using employees, allocations, projects, leave, holidays, utilization, bench, roll-off, and client delivery footprint.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Available',
    apiDataStatus: 'Planning UI composes employee master, allocations, projects, leave availability, actual utilization, and thresholds without a separate planning data copy. Allocation Control is embedded as the source-of-record edit surface.',
    evidenceNeeded: 'Attach hosted backend planning fixtures, allocation-control UAT, role-scoped planning evidence, and scenario-planning sign-off.',
    companyOwnerNeeded: 'Resource planning owner.',
  },
  {
    module: 'Import / Export',
    brdIntent: 'Support controlled CSV data onboarding, validation, error reports, export history, and auditability.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Company UAT Required',
    uiStatus: 'Available',
    apiDataStatus: 'CSV templates, dry-run UI, backend apply endpoints, duplicate-row rejection, and history logging exist.',
    evidenceNeeded: 'Attach real-file UAT, rejected-row workflow validation, duplicate-resolution policy, and hosted import rehearsal evidence.',
    companyOwnerNeeded: 'Data migration owner and business file owner.',
  },
  {
    module: 'Audit and Governance',
    brdIntent: 'Provide source-aware audit trail for critical operations and support security governance.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Available',
    apiDataStatus: 'Audit UI and backend audit writes exist for major operations; client audit event inputs are constrained; audit update/delete immutability migration and policy guard are in place.',
    evidenceNeeded: 'Attach full audit coverage review, retention/export policy, DBA owner, and emergency compensating-entry sign-off.',
    companyOwnerNeeded: 'Governance owner, export approver, and DBA owner.',
  },
  {
    module: 'Dynamic RBAC',
    brdIntent: 'Authorize actions through identity, selected active role, dynamic permissions, protected guardrails, and data scope instead of code-only role lists.',
    phase: 'Production Core',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Available',
    apiDataStatus: 'Permission registry, role defaults, user-specific grants, protected-core checks, permission-aware sessions, audited permission changes, Admin Settings UI, route visibility, and permission middleware across current API routes are in place.',
    evidenceNeeded: 'Attach DB-backed role fixtures, permission ownership sign-off, protected permission policy, and periodic access review cadence.',
    companyOwnerNeeded: 'Security owner and access review owner.',
  },
  {
    module: 'Leave Management',
    brdIntent: 'Leave requests, balances, policies, calendars, approvals, and availability-adjusted utilization.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Release-gated',
    apiDataStatus: 'Leave types, policies, holiday calendars, balances, requests, approval status API, and availability report exist behind feature flags.',
    evidenceNeeded: 'Attach policy calibration, leave edit/cancel regression evidence, balance/availability reconciliation, browser UAT, and HR sign-off.',
    companyOwnerNeeded: 'HR leave policy owner.',
  },
  {
    module: 'Approval Management',
    brdIntent: 'Shared approval model for timesheets, leave, allocation changes, delegations, history, and SLA governance.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Prod Core RC',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Release-gated',
    apiDataStatus: 'Approval records, shared inbox, status decisions, approval history, delegation creation/listing, SLA report, active delegation routing, and allocation-change approval-history records exist; timesheet and leave decisions write shared approval state.',
    evidenceNeeded: 'Attach browser UAT, SLA/delegation evidence, and final PM/Team Lead approval authority sign-off.',
    companyOwnerNeeded: 'Approval policy owner and delivery leadership.',
  },
  {
    module: 'Notification Center',
    brdIntent: 'Role, scope, event, email, and Teams notifications for approvals and operational follow-up.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Company Input Blocked',
    releaseGate: 'Credential/Consent Required',
    uiStatus: 'Release-gated',
    apiDataStatus: 'Notification events, editable user preferences, templates, delivery attempts, in-app inbox, test-send validation, mock delivery logging, Microsoft Graph email/Teams activity adapters, and scoped read/preference mutations exist.',
    evidenceNeeded: 'Attach company Microsoft/email credentials, provider-mode test-send evidence, delivery monitoring, and browser UAT.',
    companyOwnerNeeded: 'IT/Microsoft tenant owner and notification operations owner.',
  },
  {
    module: 'Microsoft Teams Integration',
    brdIntent: 'Teams personal tab, deterministic bot commands, Adaptive Cards, and secure action tokens.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Company Input Blocked',
    releaseGate: 'Credential/Consent Required',
    uiStatus: 'Release-gated',
    apiDataStatus: 'Teams user links with tenant mapping, deterministic approve/reject/open-portal action tokens, secure portal action URLs, scoped create/send/execute checks, mock execution, Microsoft Graph activity notification adapter, integration event logs, health metrics, and audit-backed action handling exist.',
    evidenceNeeded: 'Attach Teams app approval, Graph permissions, action-token evidence, and Teams browser/UAT.',
    companyOwnerNeeded: 'Microsoft Teams app owner and tenant admin.',
  },
  {
    module: 'Microsoft Entra SSO',
    brdIntent: 'Enterprise SSO and group-to-role mapping.',
    phase: 'Enterprise Workforce OS',
    engineeringStatus: 'Company Input Blocked',
    releaseGate: 'Credential/Consent Required',
    uiStatus: 'Release-gated',
    apiDataStatus: 'Identity provider links, Entra group-role mappings, OIDC authorization-code login, signed state/nonce validation, ID-token signature and claim checks, integration event logs, health metrics, and username/password fallback exist.',
    evidenceNeeded: 'Attach Entra app registration, redirect URI, admin consent, group-claim validation, and SSO/role-mapping UAT.',
    companyOwnerNeeded: 'Entra application owner and tenant admin.',
  },
  {
    module: 'Company Production Handover',
    brdIntent: 'Company-owned infrastructure, secrets, real data, UAT evidence, operations, backup, monitoring, and rollback.',
    phase: 'Company Handover',
    engineeringStatus: 'Company Input Blocked',
    releaseGate: 'Owner/Policy Sign-off Required',
    uiStatus: 'Not required',
    apiDataStatus: 'Runbooks, checklists, browser UX smoke, backend UAT matrix guard, role browser UAT evidence pack, audit governance guard, backup/restore runbook, monitoring runbook, and credential handover guard exist; execution depends on company credentials, data, and owners.',
    evidenceNeeded: 'Attach company DB, hosting, domain, secret owner, credential values, hosted smoke evidence, restore rehearsal evidence, role-by-role browser evidence, and UAT sign-off.',
    companyOwnerNeeded: 'Infrastructure owner, secret owner, backup owner, monitoring owner, alert owner, and UAT sponsor.',
  },
];

const statusVariant = (status: EngineeringStatus): 'success' | 'warning' | 'info' | 'neutral' => {
  if (status === 'Prod Core RC') return 'success';
  if (status === 'Company Input Blocked') return 'info';
  return 'neutral';
};

const rcRows = rows.filter(row => row.engineeringStatus === 'Prod Core RC');
const companyBlockedRows = rows.filter(row => row.engineeringStatus === 'Company Input Blocked');
const releaseGatedRows = rows.filter(row => row.uiStatus === 'Release-gated');

export const BRDTraceability = () => (
  <div className="space-y-6 pb-12">
    <PageHeader
      title="BRD Traceability"
      subtitle="Single view of BRD scope, Production-Core RC readiness, company-blocked gates, and remaining evidence needed before release."
      breadcrumb={['Governance', 'BRD Traceability']}
    />

    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-body/50">RC Scope</p>
            <p className="mt-3 text-4xl font-black text-heading">{rcRows.length}</p>
          </div>
          <div className="rounded-2xl bg-orange-50 p-3 text-primary">
            <ClipboardCheck size={22} />
          </div>
        </div>
        <p className="mt-3 text-xs font-semibold text-body/60">Engineering-ready product modules</p>
      </Card>
      <Card className="p-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-body/50">UI Available</p>
        <p className="mt-3 text-4xl font-black text-heading">{rows.filter(row => row.uiStatus === 'Available').length}</p>
        <p className="mt-3 text-xs font-semibold text-body/60">Visible product surfaces today</p>
      </Card>
      <Card className="p-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-body/50">Release Gated</p>
        <p className="mt-3 text-4xl font-black text-heading">{releaseGatedRows.length}</p>
        <p className="mt-3 text-xs font-semibold text-body/60">Available behind company gates</p>
      </Card>
      <Card className="p-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-body/50">Company Blocked</p>
        <p className="mt-3 text-4xl font-black text-heading">{companyBlockedRows.length}</p>
        <p className="mt-3 text-xs font-semibold text-body/60">Inputs required outside code</p>
      </Card>
    </div>

    <Card className="p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-1 text-primary" size={20} />
        <div>
          <h2 className="text-sm font-black uppercase tracking-widest text-heading">Production-Core RC Definition</h2>
          <p className="mt-2 max-w-4xl text-sm font-medium leading-relaxed text-body/70">
            Product-owned modules are tracked on two axes: engineering readiness and release gate. Prod Core RC means the module is engineering-ready
            for enterprise release candidate review. Hosted UAT, real-data reconciliation, credentials, tenant consent, operations owners, and sign-off
            are release gates, not proof that the module is unfinished. Company Input Blocked means final acceptance depends on company-owned input.
          </p>
        </div>
      </div>
    </Card>

    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border-light p-5">
        <div className="flex items-center gap-2">
          <Layers3 size={17} className="text-primary" />
          <h2 className="text-sm font-black uppercase tracking-widest text-heading">Traceability Matrix</h2>
        </div>
        <Badge variant="neutral">{rows.length} BRD lines</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1380px] text-left">
          <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-widest text-body/50">
            <tr>
              <th className="px-5 py-3">BRD Module</th>
              <th className="px-5 py-3">Phase</th>
              <th className="px-5 py-3">Engineering</th>
              <th className="px-5 py-3">Release Gate</th>
              <th className="px-5 py-3">UI</th>
              <th className="px-5 py-3">API / Data Status</th>
              <th className="px-5 py-3">Evidence Needed</th>
              <th className="px-5 py-3">Company Owner Needed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-light">
            {rows.map(row => (
              <tr key={row.module} className="align-top hover:bg-orange-50/40">
                <td className="max-w-xs px-5 py-4">
                  <p className="text-sm font-black text-heading">{row.module}</p>
                  <p className="mt-2 text-xs font-medium leading-relaxed text-body/60">{row.brdIntent}</p>
                </td>
                <td className="px-5 py-4">
                  <Badge variant={row.phase === 'Production Core' ? 'success' : row.phase === 'Company Handover' ? 'info' : 'warning'}>
                    {row.phase}
                  </Badge>
                </td>
                <td className="px-5 py-4">
                  <Badge variant={statusVariant(row.engineeringStatus)}>{row.engineeringStatus}</Badge>
                </td>
                <td className="px-5 py-4">
                  <Badge variant={row.releaseGate === 'Ready for UAT' ? 'success' : row.releaseGate === 'Credential/Consent Required' ? 'info' : 'warning'}>
                    {row.releaseGate}
                  </Badge>
                </td>
                <td className="px-5 py-4">
                  <Badge variant={row.uiStatus === 'Available' ? 'success' : row.uiStatus === 'Release-gated' ? 'warning' : 'neutral'}>
                    <MonitorCheck size={11} className="mr-1" />
                    {row.uiStatus}
                  </Badge>
                </td>
                <td className="max-w-sm px-5 py-4 text-xs font-medium leading-relaxed text-body/70">{row.apiDataStatus}</td>
                <td className="max-w-sm px-5 py-4 text-xs font-bold leading-relaxed text-heading">{row.evidenceNeeded}</td>
                <td className="max-w-xs px-5 py-4 text-xs font-medium leading-relaxed text-body/70">{row.companyOwnerNeeded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  </div>
);
