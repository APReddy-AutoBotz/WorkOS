# Configured product BRD and Technical Plan

> **Historical reference — not current WorkOS authority.** On 2026-11-14 the product owner approved this classification while preserving the retained text below. [PRODUCT_REQUIREMENTS.md](../00-control/PRODUCT_REQUIREMENTS.md) is authoritative for current WorkOS product scope and acceptance, in the document order established by the repository operating contract. The original authority, implementation-status, release-target and supersession statements below describe the retained source baseline only. Its billing exclusions do not override current WorkOS commercial requirements. Its allowance for release with known P1 defects does not override the current [blocking-review policy](../05-delivery/CODEX_EXECUTION_PLAYBOOK.md). Historical completion statements are not current executable acceptance evidence.

**Single source of truth for product scope, production-core requirements, implementation status, and next technical plan.**

**Product:** Configured product Workforce Operations Core
**Owner:** AP
**Last updated:** 26 May 2026
**Current release target:** Enterprise Production-Core Release Candidate
**Current implementation state:** Product-owned Production Core and Workforce OS modules are treated as Enterprise Production-Core RC engineering scope. Remaining blockers are tracked separately as release gates for hosted UAT evidence, real/UAT data reconciliation, company credentials, Microsoft tenant consent, operations owners, policy decisions, and formal sign-off.

---

## 1. Document Authority

This document consolidates and supersedes the earlier BRD, production-core plan, technical status notes, and handover readiness summaries. Supporting documents remain valid only as operational checklists or user guides:

- `Configured product_User_Flow_Guide.md`
- `PRODUCTION_CORE_RC_GOAL.md`
- `PRODUCTION_CORE_RC_EVIDENCE.md`
- `CONFIGURED_PRODUCT_PRODUCTION_HANDOVER_CHECKLIST.md`
- `PRODUCTION_RUNBOOK.md`
- `REAL_DATA_IMPORT_GUIDE.md`
- `SECURITY_OPERATIONS_CHECKLIST.md`
- `ROLE_UAT_CHECKLIST.md`
- `ROLE_BROWSER_UAT_EVIDENCE.md`
- `AUDIT_GOVERNANCE_POLICY.md`
- `BACKUP_RESTORE_RUNBOOK.md`
- `MONITORING_OPERATIONS_RUNBOOK.md`
- `CREDENTIAL_HANDOVER_RUNBOOK.md`
- `DEPLOYMENT_SUPABASE_RENDER.md`

If any supporting document conflicts with this BRD, this document wins.

---

## 2. Product Positioning

Configured product Workforce Operations Core is an internal workforce operations platform for employee master data, client/project allocation, timesheets, utilization reporting, import/export, audit, and governance.

The first production handover must remain premium, focused, and enterprise-safe, while the broader Workforce OS modules are implemented as controlled, release-gated enterprise capabilities.

### In Scope for Production Core

- Employee master and identity-ready workforce records
- ESS / My WorkOS Hub
- Client master and project master
- Project/resource allocations
- Weekly client/project timesheets
- Timesheet approval and rejection
- Planned, actual, and forecast utilization
- Dashboard and scoped reports
- Data-quality report
- CSV import/export
- Audit trail and governance visibility
- Role-based access control using identity, selected active role, permissions, and scoped data access
- Release-gated leave, approval, notification, planning, Entra-ready identity, and Teams-ready action modules when their company gates pass
- Production-mode hardening that disables demo fallback when backend mode is required
- Company handover documentation and operational checklists

### Out of Scope for Production Core

- Calling release-gated Workforce OS modules fully accepted before backend-mode UAT, audit/export verification, and company sign-off
- Live Microsoft Teams/Entra/Graph operation without company app registration, tenant consent, credentials, and test users
- Billing, invoicing, rate cards, or revenue recognition
- AI, Gemini, assistants, forecasting intelligence, or recommendations
- Kanban/task management
- Broad workflow engine
- Payroll or HRMS replacement

Out-of-scope commercial/product-adjacent items can be considered later, but they must not block the Workforce OS handover.

### Production-Core RC Two-Axis Readiness Model

All modules must separate engineering readiness from release acceptance:

- Engineering status: `Prod Core RC`, `Company Input Blocked`, or `Post-Go-Live`.
- Release gate: `Ready for UAT`, `Company UAT Required`, `Credential/Consent Required`, `Owner/Policy Sign-off Required`, or `Post-Go-Live`.
- `Prod Core RC`: UI, backend API, permissions, row/data scope, audit, tests, and handover documentation are ready for enterprise release-candidate review.
- `Company Input Blocked`: code is ready or adapter-ready, but final acceptance depends on company infrastructure, credentials, real data, tenant consent, operations ownership, or business sign-off.
- `Post-Go-Live`: intentionally deferred work that is not required for the Production-Core RC.

Hosted browser UAT, real-data reconciliation, credential provisioning, owner assignment, policy approval, and sign-off are release gates. They must stay visible in the handover pack, but they do not make a product-owned engineering-complete module appear unfinished in BRD traceability.

---

## 3. Workforce OS Implementation Vision

The v4 strategic BRD positioned the product as an employee-first workforce operating system. That direction is now accepted as the enterprise implementation target, delivered through release-gated enterprise increments.

Long-term product promise:

```text
One trusted operational layer for employees, capacity, availability, allocations, time, approvals, notifications, reporting, and governance.
```

| Workforce OS Module | BRD Intent | Current Status | Implementation Decision |
|---|---|---|---|
| Employee Master as root | Employee data feeds identity, reporting, capacity, allocations, timesheets, approvals, leave, notifications, and Teams identity. | Prod Core RC | Included now; identity/leave/Teams fields are the bridge into Enterprise Workforce OS release gates. |
| ESS Portal | Employee self-service for profile, allocations, projects, utilization, timesheets, leave, notifications, actions, and identity readiness. | Prod Core RC | `/ess` is now the core My WorkOS Hub and composes employee master, allocation, project, timesheet, leave, approval, notification, and identity data. Release gate: backend-mode Employee browser UAT against hosted UAT data. |
| Leave Management | Leave requests, balances, policies, calendars, approvals, and utilization availability impact. | Prod Core RC | Leave model, APIs, self-service, team calendar, admin policy view, reports, edit/cancel, overlap prevention, and balance guardrails exist. Release gate: policy calibration, browser UAT, balance/availability reconciliation, and HR sign-off. |
| Approval Management | Common approval model for timesheets, leave, allocation changes, delegations, and SLAs. | Prod Core RC | Shared records, inbox/history, delegations, scoped SLA metrics, and timesheet/leave linkage exist. Release gate: browser UAT, SLA/delegation evidence, and final PM/Team Lead authority sign-off. |
| Notification Center | Role/scope/event based in-app, email, and Teams notifications. | Company Input Blocked | In-app notifications, templates, preferences, delivery attempts, mock delivery, and Graph adapters exist. Prod Core RC requires company credentials, provider-mode test-send evidence, and hosted UAT. |
| Microsoft Teams | Personal tab, deterministic bot commands, Adaptive Cards, and secure action tokens. | Company Input Blocked | Teams links, tenant mapping, deterministic action tokens, portal actions, mock execution, Graph activity adapter, event logs, and health UI/API exist. Prod Core RC requires Teams app approval, Graph permissions, and company UAT. |
| Microsoft Entra SSO | Enterprise identity and group-to-role mapping. | Company Input Blocked | Identity links, group-role mappings, OIDC login routes, signed state/nonce, ID-token validation, role mapping, event logs, and health UI/API exist. Prod Core RC requires company app registration, redirect URI, admin consent, and SSO UAT. |
| Planning Workspace | Availability-aware allocation planning, bench/roll-off visibility, and allocation control in one workspace. | Prod Core RC | Planning signals and source-of-record allocation edits are unified on `/planning`; release gate: hosted backend planning fixtures, scenario sign-off, and role-scoped browser UAT. |
| Workforce Action Signals | Executive dashboard with utilization, regional portfolio, attention items, and data confidence. | Prod Core RC | Overview Dashboard uses one action queue and distinct client footprint. Release gate: role-by-role backend browser evidence and real/UAT data reconciliation. |
| Reports | Utilization, allocation, timesheet, data-quality, leave, notification, planning, and audit reports. | Prod Core RC | Core and Workforce OS reports exist; release gate: hosted data fixtures, browser UAT, and company data reconciliation. |

This preserves the stable Production Core while making the career-grade Workforce OS implementation explicit and actionable.

---

## 4. Business Objectives

1. Replace spreadsheet-led workforce utilization tracking with a controlled web application.
2. Provide a centralized source of truth for employees, clients, projects, allocations, and approved timesheets.
3. Make planned, actual, and forecast utilization visible at company, Country Director, project, client, and employee levels.
4. Keep utilization calculations delivery-capacity focused.
5. Support multi-role users without allowing inactive roles to bypass authorization.
6. Preserve a full audit trail for production-relevant mutations and exports.
7. Support real-data onboarding through controlled CSV imports and validation reports.
8. Prepare the company for production handover with clear runbooks, UAT checklists, security checklists, rollback guidance, and environment ownership.

---

## 5. Roles and Access Model

The required authorization model is:

```text
identity + selected activeRole + action permission + data scope
```

Assigned roles alone must not authorize a request. A multi-role user can only perform actions allowed by the role they selected for the current session.

| Role | Core Permissions | Required Data Scope |
|---|---|---|
| Employee | View own profile, scoped Project Master rows for assigned projects, allocations, own timesheets; draft/submit/correct timesheets. | Own employee record, own timesheets, and assignment-backed project rows. |
| Team Lead | View mapped team/resource information, scoped Project Master rows, and team utilization where configured; may participate in timesheet governance if allowed by policy. | Team Lead mapping rules and approved project/team scope; final approval authority pending. |
| Project Manager | View owned projects, project resources, allocation context, project utilization; manage allocations where permitted. | Projects they manage and employees allocated to those projects. |
| Country Director | View mapped employees, projects, utilization, submitted timesheets; approve/reject scoped timesheets. | Employees mapped to that Country Director, including shared employees. |
| HR | Maintain employee master and workforce catalogs; view workforce/utilization reports where permitted. | Broad workforce visibility, excluding Admin-only security operations unless assigned. |
| Admin | Full platform administration, settings, audit, imports/exports, users, roles, and all data. | Global. |

### Authorization Rules

- Frontend navigation must hide unauthorized routes.
- Backend APIs must enforce active-role checks.
- Backend reads and writes must enforce row/data scope.
- Exports and reports must obey backend data scope in production.
- Audit logs must include actor, active role, source, entity type, entity ID, old value, new value, reason where applicable, and timestamp.

---

## 6. Core Functional Requirements

### Employee Master

Required production fields:

- Employee ID, name, email, designation, department, country, status
- Primary Country Director and mapped Country Directors
- Reporting manager
- Joining date and exit date
- Standard weekly hours
- Capacity type and contract type
- Utilization eligibility
- Username/login linkage
- Nullable placeholders for Entra ID, Teams user ID, Teams channel ID, leave policy ID, and holiday calendar ID

Status: **Prod Core RC with release gates.** Demo and backend schema support exist. Employee Directory, Employee Detail, self-profile routing, and org-chart views share the scoped visibility model. The org chart shows one explicit Country Director/Incharge per operating unit from leadership records and keeps ordinary employees in the team list. Final real-data load and company identity mappings are pending.

### Client and Project Master

Required:

- Client master records with industry/status/scope metadata
- Project master records linked to clients and Project Managers
- Project status and dependency guardrails
- Project detail views showing assigned resources, allocation percentages, actual contribution, Country Director mapping, and ownership

Status: **Prod Core RC with release gates.** Backend APIs and UI are implemented for core flows. Project Master uses active-role scoping for Country Directors, PMs, Team Leads, and Employees: directors see scoped delivery projects, PMs see managed projects, Team Leads see their approved scoped project set, and Employees see assignment-backed projects. Project Master derives client labels from scoped project rows when Client Portfolio or `/api/clients` access is denied, so scoped roles do not get a blank screen. Project mutation controls remain Admin/HR-owned, and Project Detail renders derived delivery signals and approved timesheet evidence rather than static placeholders. Client Portfolio keeps full active client master visibility for Admin/HR, but director-scoped views show only clients with active scoped delivery footprint and cannot clear active-role scope for Country Directors. Final backend-mode UAT and real-data validation are pending.

### Allocation Control

Required:

- Employee, project, allocation percentage, date range, status, billable/client-related indicator, and comments
- Planned utilization calculated from active allocations
- Over-allocation detection based on thresholds
- Allocation edits available from project, employee, or allocation context while keeping allocation logic centralized

Status: **Prod Core RC with release gates.** UI and backend endpoints exist with validation guardrails. Release evidence still needed: deeper API parity tests, concurrency behavior, and full role-scope UAT.

### Timesheets

Required:

- Weekly client/project timesheets
- Assigned project entries and client miscellaneous task entries
- Draft, submitted, approved, rejected statuses
- Rejection reason required and visible to employee
- Approved client/project hours only count toward actual utilization
- Draft, submitted, and rejected timesheets do not count toward actual utilization
- Future timesheets must be blocked or controlled by business rule

Status: **Mostly complete for controlled UAT.** UI and backend flows exist. My Timesheet limits selectable projects to assignments active for the selected week, future-week saves/submits are blocked, rejection reasons are shown back to employees, and Timesheet Governance now scopes Team Lead and Country Director rows through the shared org visibility model. Approval/rejection controls are shown only for submitted timesheets. Remaining work is role-by-role backend browser UAT and final company sign-off on PM/Team Lead approval authority.

### Utilization

Required:

- Planned utilization from active allocation percentages
- Actual utilization from approved client/project timesheet hours divided by expected weekly hours
- Forecast utilization from future allocation date ranges for 1, 2, and 3 month horizons
- Company metrics must count each active person once and use delivery-eligible employees for utilization denominators
- Country Director metrics can include shared employees in each mapped CD view but must avoid double-counting in company totals

Status: **Mostly complete.** Frontend and backend report endpoints exist for planned, actual, and forecast reports, backend role guards now match the UI route model by blocking Employee access to global utilization reports, and report/import-export downloads now use the shared audited CSV/import-export log path. Dashboard/report parity and real-data validation remain pending.

### Dashboard and Reports

Required:

- Company KPIs
- Utilization-eligible FTE
- Governance user separation
- Country Director portfolio
- Immediate attention panel
- Client/project/resource drilldowns
- Planned, actual, forecast, dashboard, and data-quality reports

Status: **Mostly complete for demo and controlled UAT.** Data-quality and dashboard endpoints exist. Final production browser UAT and report/export scope validation remain pending.

### Import and Export

Required:

- CSV-first import/export
- Templates for employees, clients, projects, allocations, and timesheets
- Backend import apply endpoints
- Validation feedback before data is trusted
- Import/export history and audit
- Shared export/audit path where practical

Status: **Prod Core RC with release gates.** CSV templates, import apply endpoints, history persistence, export audit hardening, duplicate-row checks, and strict date validation exist. Release evidence still needed: real-file UAT, duplicate-resolution policy sign-off, and optional XLSX/PDF only if company requires them.

### Audit and Governance

Required:

- Critical mutation audit trail
- Imports, exports, approvals, rejections, password changes/resets, settings changes, and master-data changes audited
- Source and active-role metadata captured
- Client audit events constrained to approved UI-generated actions
- Admin audit visibility

Status: **Prod Core RC with release gates.** Backend audit exists for major writes and export events; arbitrary client audit source submission has been blocked. Release evidence still needed: full immutable audit coverage, retention policy, and audit export governance.

---

## 7. Public Interfaces and Configuration

### Required Environment Variables

```text
APP_MODE=production|demo
DISABLE_DEMO_FALLBACK=true|false
DATABASE_URL=postgresql://...
API_SESSION_SECRET=<company-owned secret>
API_SESSION_TTL_HOURS=<number>
PGSSLMODE=require|disable|...
APP_URL=https://service.example.test
PASSWORD_MIN_LENGTH=<number>
NODE_ENV=production
AUTO_SEED_DEMO=false
```

Frontend deployments should use the matching Vite-prefixed values where required:

```text
VITE_APP_MODE=production
VITE_DISABLE_DEMO_FALLBACK=true
VITE_FEATURE_LEAVE=true|false
VITE_FEATURE_NOTIFICATIONS=true|false
VITE_FEATURE_TEAMS=true|false
VITE_FEATURE_ENTRA=true|false
VITE_FEATURE_PLANNING=true|false
```

### Implemented API Surface

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/switch-role`
- `GET /api/auth/me`
- `POST /api/auth/change-password`
- `POST /api/users/:id/password-reset`
- Employee, client, project, allocation, timesheet, leave, holiday calendar, settings, catalog, Country Director, role, audit, and import/export endpoints
- `GET /api/reports/planned-utilization`
- `GET /api/reports/actual-utilization`
- `GET /api/reports/forecast-utilization`
- `GET /api/reports/data-quality`
- `GET /api/reports/dashboard`
- `GET /api/reports/availability`
- `GET /api/reports/resource-planning`
- `GET /api/reports/workforce-command-center`
- `GET/POST /api/leave/requests`
- `PATCH /api/leave/requests/:id/status`
- `GET/POST /api/leave/policies`
- `GET/POST /api/leave/balances`
- `GET/POST /api/holiday-calendars`
- `GET /api/approvals`
- `PATCH /api/approvals/:id/status`
- `GET/POST /api/approval-delegations`
- `GET /api/reports/approval-sla`
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `GET/POST /api/notification-templates`
- `GET/POST /api/notification-preferences`
- `GET /api/notification-delivery-attempts`
- CSV import apply endpoints for employees, clients, projects, allocations, and timesheets

---

## 8. Completed vs Pending Status

### Completed or Ready for Controlled UAT

| Area | Status | Evidence |
|---|---|---|
| Product rename | Complete | App, code, package name, docs, and Git remote use Configured product. |
| Anonymized UAT seed data | Prod Core RC | Browser/backend demo seed uses placeholder display names (`ADMIN-1`, `HR-1`, `CD-1` through `CD-8`, `PM-1`, `EMP-1`, etc.) and generic `Client-*` / `Process-*` records. Existing browser sessions detect legacy named demo data and reset to the anonymized seed on startup. |
| Master-data rename audit | Prod Core RC | Employee, Country Director, client, and project create/update/rename paths now write audit entries with old/new values. Client and Country Director protected deletes/deactivations are blocked when dependent mappings exist and those blocked attempts are audited with the dependency reason. |
| Production-mode fallback guard | Complete | `APP_MODE` and `DISABLE_DEMO_FALLBACK` are implemented and covered by production hardening checks. |
| Demo credential wording cleanup | Complete for production path | Production copy no longer relies on old demo product framing. |
| Active-role backend authorization | Prod Core RC | Backend role guard checks selected `activeRole`; production hardening smoke covers inactive-role bypass risk. |
| Multi-role role switching | Prod Core RC | Backend role switch endpoint and frontend active-role handling exist. |
| Employee production fields | Prod Core RC | Production-core migration adds manager, weekly hours, capacity, contract, Entra/Teams placeholders, and related fields. |
| Data-quality report | Prod Core RC | UI route and backend endpoint exist; export is audited. |
| Dashboard report endpoint | Prod Core RC | Backend endpoint exists for command-center style summary. |
| BRD traceability UI | Prod Core RC | `/governance/brd-traceability` maps BRD modules to engineering readiness, release gates, UI status, API/data status, evidence needed, and company owner needed. |
| Enterprise release-gate controls | Prod Core RC | ESS, Leave, Approvals, Notifications, Integrations, Planning, and dashboard risk-signal surfaces are controlled by Workforce OS feature flags and company release gates. |
| Role-based navigation consolidation | Prod Core RC | Sidebar is organized by user jobs: Home, Workforce, Delivery, Planning, Reports, Action Center, Governance, and Admin. Planning Workspace combines planning metrics/signals with embedded Allocation Control, Action Center remains the approvals/notifications workspace, Utilization Reports is a selectable reporting workspace with Planned/Current/Forecast lenses, and Reports Center owns controlled CSV downloads. Navigation is role-pruned so self-service, management, planning, governance, and admin items do not appear as equal-weight tabs for every role. Overview Dashboard remains the primary operational dashboard with a single action queue; duplicate read-only Risk Command Center navigation has been removed. |
| ESS / My WorkOS Hub | Phase 2 Prod Core RC | `/ess` is the primary employee hub using `employee_workspace.view`; it shows profile, manager/CD mappings, employment and capacity fields, allocation-derived work, planned utilization, latest approved actual utilization, current timesheet status, actionable personal follow-ups, and optional leave/notification/identity signals. `/my-workspace` remains a compatibility route focused on Work & Utilization. |
| Leave request workflow | Phase 2 Prod Core RC | `/leave/my` supports leave balance review and employee leave request submission; service and backend APIs persist requests with audit, recompute business days server-side, reject overlaps, reject calendar-year-spanning requests, and block paid leave above available balance. |
| Team leave calendar | Phase 2 Prod Core RC | `/leave/team-calendar` shows scoped leave requests, approval/rejection actions, and availability timeline. |
| Leave administration and reports | Phase 2 Prod Core RC | `/leave/admin` shows leave policies, holiday calendars, and balance reporting; policy save is audited. |
| Leave data model and migration | Phase 2 Prod Core RC | `007_workforce_os_leave.sql` adds leave types, policies, policy-type mapping, holiday calendars, holidays, balances, and requests. |
| Availability-adjusted capacity | Phase 2 Prod Core RC | `GET /api/reports/availability` and local service calculate annual availability hours from standard weekly hours minus approved leave and holidays. |
| Leave smoke coverage | Complete | `test:leave` covers leave seed data, request submission, approval, overlap rejection, over-balance rejection, balance impact, availability impact, and audit entries. |
| Generic approval data model | Phase 3 Prod Core RC | `008_workforce_os_approvals.sql` adds approval records and approval delegations with entity type, entity ID, subject employee, active role, status, comments, source, timestamps, and SLA due date. |
| Shared approval APIs | Phase 3 Prod Core RC | `GET /api/approvals`, `PATCH /api/approvals/:id/status`, delegation APIs, and approval SLA report are implemented with active-role data scope. Active delegations extend view/decision scope only to the delegator's own/direct-report approval queue and are guarded against self-delegation, inactive employees, and overlapping active delegation ranges. |
| Timesheet/leave approval migration | Phase 3 Prod Core RC | Submitted timesheets and leave requests create approval records; decisions through module endpoints or `/approvals` update the shared approval record. |
| Allocation-change approval history | Phase 3 Prod Core RC | Allocation create/update/end operations remain source-of-record Planning Workspace mutations, and each mutation now writes an approved `AllocationChange` approval-history record with requester, active role, subject employee, previous/new allocation payload, notification, and audit-adjacent traceability. |
| Approval workspace UI | Phase 3 Prod Core RC | `/approvals` renders approval inbox, history, delegation creation/listing, and SLA metrics behind the Workforce OS feature flag. |
| Approval smoke coverage | Complete | `test:approvals` covers generic approval records for submitted timesheets and leave requests, linked entity decisions, active delegation decision routing, allocation-change approval history, and SLA rows. |
| Notification data model | Phase 4 Company Input Blocked | `009_workforce_os_notifications.sql` adds notification events, templates, preferences, and delivery attempts. |
| Notification center UI | Phase 4 Company Input Blocked | `/notifications` renders inbox, editable delivery preferences, admin templates, and delivery monitoring behind the Workforce OS feature flag. |
| Mock notification delivery | Phase 4 Company Input Blocked | Approval request/decision events create in-app notification events, mock delivery attempts, and notification audit records. |
| Notification smoke coverage | Complete | `test:notifications` covers notification events, read state, editable user preferences, template editing, and mock delivery logging. |
| Identity integration release gate | Phase 5 Company Input Blocked | `/integrations/identity` renders identity provider links, Entra role mappings, integration health, and event logs behind `FEATURE_ENTRA`. |
| Teams integration release gate | Phase 5 Company Input Blocked | `/integrations/teams` renders Teams user links, deterministic Teams action tokens, integration health, and event logs behind `FEATURE_TEAMS`. |
| Integration data model and migration | Phase 5 Company Input Blocked | `010_workforce_os_integrations.sql` adds identity provider links, Entra group-role mappings, Teams user links, Teams action tokens, and integration event logs. |
| Integration adapter smoke coverage | Complete | `test:integrations` covers local/mock identity links, Entra role mappings, Teams links, action token execution, health, and integration events. |
| Planning workspace and allocation control | Phase 6 Prod Core RC | `/planning` renders a compact Planning Actions and Capacity Signals console, roll-off/bench highlights, client delivery footprint, and embedded Allocation Control. `/allocations` remains a compatibility route into the same workspace and focuses the allocation control section. Planning signal focus actions filter the allocation grid instead of opening duplicate edit actions. |
| Workforce action-signal dashboard UI | Phase 6 Prod Core RC | The command-center report remains a backend service, but the separate `/reports/command-center` UI has been retired from navigation. Overview Dashboard now focuses on executive KPIs, regional portfolio, one Action Queue, and client deployment footprint. |
| Planning smoke coverage | Complete | `test:planning` proves planning load derives from active allocations, availability derives from leave availability, and command-center risk counts derive from planning summaries. |
| Phase 7 scoped module hardening | Prod Core RC | Command-center approval, notification, identity/Teams gap, and staffing-risk counts now reuse active-role data scope; notification read/preference writes, leave submission, and Teams action-token create/execute flows reject out-of-scope targets. Covered by `test:phase7-scope`. |
| Automated browser UX smoke | Prod Core RC | `test:browser-ux` starts the built app, launches headless Microsoft Edge, signs in as Admin, verifies Overview Dashboard, My Timesheet, Planning Workspace, `/allocations` focus behavior, planning signal focus behavior, planned/current/forecast Utilization Reports, Reports Center, Project Master, Project Detail delivery signals, Client Portfolio, Import / Export, Admin Settings, Action Center, and dark-surface contrast, and asserts removed duplicate dashboard, planning, and delivery placeholder panels stay absent. |
| Hosted report smoke coverage | Prod Core RC | Backend API and role smoke tests now cover planned, actual, forecast, dashboard, and data-quality report endpoints, including Employee 403 checks for global utilization reports. |
| CSV import templates | Complete | Templates exist and are covered by `test:import-templates`. |
| Backend CSV apply endpoints | Prod Core RC | Employees, clients, projects, allocations, and timesheets apply endpoints exist. |
| Import header, duplicate-row, and date guardrails | Prod Core RC | Employee, client, project, allocation, and timesheet backend imports reject duplicate rows inside a single file, backend date schemas reject impossible `YYYY-MM-DD` calendar dates, and the UI dry run now flags missing required headers, empty files, duplicate employee IDs/emails, client IDs/names, project codes, allocation keys, timesheet entry keys, and invalid dates before apply. |
| Password change/reset readiness | Prod Core RC | Self-service change, Admin/HR reset endpoints, hashing, and audit exist. |
| Configurable session lifetime | Prod Core RC | `API_SESSION_TTL_HOURS` now controls signed token expiry and HTTP-only session cookie max age; login and role switch responses expose `sessionExpiresAt`. |
| Production hardening smoke | Complete | `test:prod-hardening` covers production mode, active-role guard, data-quality report, migration, and audit restrictions. |
| Backend UAT matrix guard | Prod Core RC | `test:backend-uat` verifies the role UAT checklist, backend API/role smoke scripts, documented hosted-backend variables, active-role expectations, employee report restrictions, audit/password-reset restrictions, browser UX evidence, and handover checklist stay aligned. |
| Hosted backend UAT evidence runner | Prod Core RC | `test:backend-evidence` runs the hosted backend API and role/scope smoke checks when `BACKEND_SMOKE_BASE_URL` is set, redacts the backend password, and writes `BACKEND_UAT_EVIDENCE.md` for the handover pack. |
| Audit governance guard | Prod Core RC | `test:audit-governance` verifies the immutable audit migration, Admin-only audit API, append-only audit route posture, retention policy document, handover checklist, and BRD traceability. |
| Operations readiness guard | Prod Core RC | `test:operations-readiness` verifies the health endpoint, backup/restore runbook, monitoring runbook, security checklist, handover checklist, and BRD status keep production operations gates explicit. |
| Credential handover guard | Prod Core RC | `test:credential-handover` verifies the credential runbook, `.env.example` placeholders, `.env` ignore rules, provider credential inventory, rotation requirements, and handover checklist. |
| Real-data cutover rehearsal guard | Prod Core RC | `test:real-data-cutover` starts from anonymized seed data, replaces representative Country Director, employee, client, and project records through controlled service workflows, verifies relationship cascade, old/new audit evidence, and import/export evidence. |
| Role browser UAT evidence guard | Prod Core RC | `test:role-browser-uat` verifies the role browser evidence pack, role checklist, route-role matrix, protected deep-link evidence, scoped Project Master evidence for PM/Team Lead/Employee, role home redirects, and automated Admin browser UX spine stay aligned. |
| Handover docs | Prod Core RC | Runbook, real-data guide, security checklist, role UAT checklist, role browser UAT evidence pack, audit policy, backup/restore runbook, monitoring runbook, credential handover runbook, deployment guide, and handover checklist exist. |

### Pending Before Company Production

| Priority | Area | Pending Requirement | Blocked By Company Input |
|---:|---|---|---|
| P0 | Company infrastructure | Replace personal/demo Supabase/Render values with company-owned DB, hosting account, secrets, domain, and HTTPS. Credential inventory and rotation runbook exist; company values and owners remain pending. | Yes |
| P0 | Real data | Local cutover rehearsal guard exists. Remaining work: load company catalogs, employees, users, clients, projects, allocations, and optional historical timesheets in hosted/backend mode, then reconcile reports and audit evidence. | Yes |
| P0 | Role UAT | Role browser UAT evidence pack, hosted backend evidence runner, and static guard exist. Remaining work: complete Admin, HR, Country Director, Project Manager, Team Lead, and Employee browser UAT in backend mode with screenshots/results. | Partly |
| P0 | Team Lead rules | Confirm final visibility and approval authority. | Yes |
| P0 | Project Manager rules | Confirm whether PMs can approve timesheets or only view/recommend. | Yes |
| P0 | Auth operations | Session lifetime is configurable. Remaining work: final password policy, reset channel, initial admin users, lockout persistence policy, refresh behavior, and user lifecycle sign-off. | Yes |
| P0 | Backup/restore | Backup/restore runbook and operations smoke exist. Remaining work: company backup frequency, retention, restore owner, RPO/RTO target, and one restore rehearsal. | Yes |
| P0 | Monitoring/logging | Monitoring runbook and operations smoke exist. Remaining work: company monitoring owner, health monitoring configuration, alert channel, database alert owner, initial response SLA, and first-week operations review owner. | Yes |
| P0 | Audit governance | Immutable audit update/delete guard, audit policy, and audit governance smoke exist. Remaining work: company retention period, export approver, DBA owner, and emergency remediation sign-off. | Yes |
| P1 | Backend report parity | Hosted smoke coverage now includes core report endpoints, and `test:backend-uat` locks the backend UAT evidence matrix. Remaining work: DB-backed calculation fixtures, client/CD report reconciliation, and browser validation against real/UAT data. | No |
| P1 | Import hardening | Duplicate identifier handling, strict calendar date validation, and automated local real-data cutover rehearsal are implemented. Remaining work: real CSV UAT, rejected-row workflow validation with business files, duplicate-resolution policy sign-off, and hosted import runbook rehearsal. | Partly |
| P1 | Automated browser QA | `test:browser-ux` now runs a built-app Microsoft Edge smoke for the highest-risk navigation/reporting/dashboard flows. Remaining work is role-by-role backend-mode browser journeys against real/UAT data. | Partly |
| P2 | Code consolidation | Continue reducing table/filter/report duplication after UAT stabilizes requirements. | No |
| P2 | Loading/error polish | Standardize save/loading/error states across every API-backed page. | No |

---

### BRD Feature to UI/API Traceability

| BRD Feature | Production Core Decision | UI Status | API/Data Status | Engineering Status / Release Gate |
|---|---|---|---|---|
| Employee Master as root | Included now | Employee Directory, Employee Detail, org chart, imports, data quality, and self-profile deep links | Backend employee APIs, production fields, shared org-scope visibility, Team Lead/PM/CD scoping, and one explicit org-unit incharge representation exist | Prod Core RC; release gate: real data, identity mapping, and final Team Lead policy |
| ESS / Employee Workspace | Included now as Workforce OS self-service | My WorkOS Hub, My Workspace compatibility route, My Leave deep link, My Timesheet, and employee profile deep links exist | Employee-scoped APIs, manager/CD mappings, capacity/employment fields, allocation/project-derived planned utilization, approved-timesheet actual utilization, leave balances/requests, availability, actionable personal follow-ups, approvals, notifications, and no-unlinked-profile fallback guards exist | Prod Core RC; release gate: browser/backend UAT evidence |
| Client and Project Master | Included now | Client Portfolio, Project Master, Project Detail | Backend client/project APIs, imports, Country Director scoped project/client lists, PM managed-project scope, Team Lead scoped project visibility, Employee assignment-backed project visibility, Admin/HR mutation gating, client dependency guards, client-denial-safe Project Master rendering, and derived project detail signals exist | Prod Core RC; release gate: backend-mode scoped UAT and real-data reconciliation |
| Allocation Management | Included now | Embedded Allocation Control inside Planning Workspace plus project/employee allocation entry points | Backend allocation APIs and import guardrails exist | Prod Core RC; release gate: DB-backed parity fixtures, concurrency behavior, and role UAT |
| Timesheet Management | Included now | My Timesheet and Timesheet Governance | Backend timesheet, entries, status, approval, rejection reason, import APIs, active-week assignment filtering, submitted-only decision controls, and Team Lead/CD scoped governance exist | Prod Core RC; release gate: PM/Team Lead authority sign-off and backend-mode UAT |
| Workforce Action Signals | Included now and extended by Workforce OS | Overview Dashboard and Data Quality | Dashboard, data-quality, and workforce command-center report endpoints exist with Phase 7 active-role scoped risk counts; the visible dashboard uses one action queue instead of duplicate risk panels | Prod Core RC; release gate: real-data validation and role browser evidence |
| Reports | Included now for core and Workforce OS reports | Utilization Reports hub with Planned, Current, Forecast; Reports Center downloads; Data Quality; Audit; Import/Export; Planning | Core report endpoints, utilization hub, downloadable report center, shared audited CSV export path, planning report, command-center report, scope hardening, Employee global-report blocks, and smoke coverage exist | Prod Core RC; release gate: DB fixtures, export-scope checks, and browser QA |
| Import / Export | Included now as CSV-first | Import / Export center with dry run, required-header validation, duplicate-row validation, strict date validation, aligned templates, errors, history, error reports, and exports | Backend apply endpoints, duplicate-row guardrails, strict backend date schemas, shared audited CSV export/download path, logs, and local real-data cutover rehearsal guard | Prod Core RC; release gate: hosted real-file UAT and duplicate-resolution policy |
| Audit and Governance | Included now | Audit Trail, Governance Settings, Data Quality | Backend audit metadata and constrained audit events exist | Prod Core RC; release gate: retention/export/DBA owner sign-off |
| Dynamic RBAC | Included now | Admin Settings Permission Settings with role matrix, user exceptions, protected locks, module filters, and access preview; sidebar, route guards, header search, client management controls, notification operations, project mutation controls, and allocation controls honor effective permissions. Permission Settings is visible only to users with protected `permissions.manage`; HR keeps non-security Governance Settings without permission-admin visibility. | Permission registry, role permission defaults, user-specific grants, protected-core backend guardrails, permission-aware sessions, audited permission changes, protected permission-config read/write APIs, refreshed `/api/auth/me` permission payloads, and permission middleware across core workforce, delivery, allocations, timesheets, leave, approvals, notifications, integrations, admin catalogs, audit, imports, reports, planning, command-center, and dashboard-report surfaces exist | Prod Core RC; release gate: company governance sign-off, DB-backed UAT fixtures, and access-review cadence |
| Leave Management | Release-gated Enterprise Workforce OS | ESS Leave section, My Leave deep link, Team Calendar, and Leave Admin available when `FEATURE_LEAVE` is enabled | Leave tables, APIs, approvals, balances, holidays, availability report, scoped submission guardrails, edit/cancel flow, policy accrual defaults, overlap checks, and insufficient-balance checks exist | Prod Core RC; release gate: policy calibration, browser UAT evidence, and final HR sign-off |
| Notification Center | Release-gated Enterprise Workforce OS | Notification inbox and editable preferences for scoped users; Admin/HR templates, delivery monitoring, and test-send validation | Events, templates, preferences, delivery attempts, mock delivery logging, Graph email delivery, Graph Teams activity delivery, scoped read/preference mutations, and Admin/HR-only operation controls exist | Company Input Blocked; release gate: company credentials and hosted integration UAT |
| Microsoft Teams | Release-gated Enterprise Workforce OS | Teams Mapping and `/teams/actions/:token` action landing available when `FEATURE_TEAMS` is enabled | Teams user links with tenant ID, deterministic action tokens, portal action URLs, action notification send API, mock execution, Graph activity notification delivery, health, event logs, and scoped action-token target checks exist | Company Input Blocked; release gate: Teams app approval, Graph permissions, and UAT |
| Microsoft Entra SSO | Release-gated Enterprise Workforce OS | Identity Mapping available when `FEATURE_ENTRA` is enabled; Login shows Microsoft Entra when `IDENTITY_PROVIDER=entra` and credentials are configured | Identity provider links, Entra group-role mappings, OIDC authorization-code login, signed state/nonce validation, ID-token signature/claim checks, group-to-role mapping, health, and event logs exist | Company Input Blocked; release gate: company app registration, redirect URI, admin consent, and UAT |
| Planning Workspace | Release-gated Enterprise Workforce OS | Planning Workspace combines a compact planning signal console and allocation control | Employee, allocation, project, leave availability, and utilization report data are composed into one report; allocation edits remain source-of-record mutations | Prod Core RC; release gate: scenario planning sign-off, hosted fixtures, and browser UAT |

The same mapping is available in the application at `/governance/brd-traceability` for reviewers and UAT leads.

---

## 9. Updated Technical Plan

### Phase 0: Stabilized Production Core Baseline

Status: **Mostly complete.**

Exit criteria:

- Lint/build/backend/access/requirements/import-template/prod-hardening tests pass.
- Production mode fails closed when backend is unavailable and demo fallback is disabled.
- Active-role authorization is enforced by backend.
- Production-core schema fields and data-quality report exist.
- Core handover docs exist.

Remaining Phase 0 work:

- Run the full readiness suite after every hardening change.
- Keep `.agent/` runtime files out of commits.
- Keep demo seed disabled before any real-data edits.
- Treat seeded UAT names as placeholders only. Production employee, Country Director, client, and project names must be loaded through imports or admin edit workflows so audit logs record old/new values.
- Before real-data cutover, verify master-data rename samples in Audit Trail for one employee, one Country Director, one client, and one project.

### Phase 1: Company-Owned Controlled UAT

Status: **Next major step.**

Work:

1. Configure company-owned PostgreSQL/Supabase and hosting secrets.
2. Run migrations.
3. Seed only required baseline catalogs/admins.
4. Import real or UAT data using documented templates.
5. Review the data-quality report and resolve blockers.
6. Run role UAT for Admin, HR, Country Director, Project Manager, Team Lead, and Employee.
7. Validate exports and audit entries.
8. Validate dashboard, planned, actual, forecast, and data-quality reports against real/UAT data.

Exit criteria:

- `/api/health` reports `database: connected`.
- `APP_MODE=production`, `DISABLE_DEMO_FALLBACK=true`, and `AUTO_SEED_DEMO=false`.
- No production-critical role bypass or data-scope issue remains.
- UAT evidence is attached to the handover package.

### Phase 2: Production Operations Hardening

Status: **Pending company decisions.**

Work:

1. Finalize password policy, reset delivery, lockout, and session settings.
2. Add production logging and monitoring ownership.
3. Define backup/restore schedule and run restore test.
4. Finalize audit retention and audit export policy.
5. Confirm support owner, release owner, rollback owner, and escalation channel.
6. Freeze demo credentials and demo seed behavior out of company production.

Exit criteria:

- Security operations checklist signed off.
- Production runbook has company-specific values.
- Backup and restore are tested.
- Monitoring and alert ownership are assigned.

### Phase 3: Production Release Candidate

Status: **Pending UAT and operations sign-off.**

Work:

1. Run complete test suite.
2. Run hosted backend smoke tests with `BACKEND_SMOKE_BASE_URL`.
3. Complete browser UAT evidence.
4. Resolve P0/P1 UAT defects.
5. Tag release and hand over deployment notes.

Exit criteria:

- Company technical owner accepts code, env, data, runbook, UAT evidence, and rollback plan.
- No known P0 defects.
- Known P1/P2 items are documented as post-go-live backlog.

---

## 10. Required Verification Commands

Run locally before each handover build:

```bash
npm run lint
npm run build
npm run test:backend
npm run test:access
npm run test:ess
npm run test:requirements
npm run test:import-templates
npm run test:permissions
npm run test:prod-hardening
npm run test:prod-core-rc
npm run test:backend-uat
npm run test:audit-governance
npm run test:operations-readiness
npm run test:credential-handover
npm run test:role-browser-uat
npm run test:prod-readiness
```

Run against hosted backend when available:

```bash
BACKEND_SMOKE_BASE_URL=<url> npm run test:backend-api
BACKEND_SMOKE_BASE_URL=<url> npm run test:backend-roles
```

`test:backend-api` and `test:backend-roles` skip hosted checks unless `BACKEND_SMOKE_BASE_URL` is set. Hosted role UAT can also provide `BACKEND_SMOKE_PASSWORD`, `BACKEND_SMOKE_USERNAME`, `BACKEND_SMOKE_ADMIN_USERNAME`, `BACKEND_SMOKE_HR_USERNAME`, `BACKEND_SMOKE_PM_USERNAME`, `BACKEND_SMOKE_CD_USERNAME`, `BACKEND_SMOKE_EMPLOYEE_USERNAME`, `BACKEND_SMOKE_TEAMLEAD_USERNAME`, and `BACKEND_SMOKE_MUTATIONS`.

---

## 11. UAT Acceptance

Production Core is acceptable for company handover only when:

- Admin can manage master data, settings, imports, exports, audit, and password resets.
- HR can maintain workforce data and validate reports within allowed scope.
- Country Director can view scoped employees/projects/reports and approve/reject scoped timesheets.
- Project Manager can view owned project/resource data, open managed Project Master rows, and perform only approved actions.
- Team Lead can view only the scope confirmed by company policy, including scoped Project Master rows where approved.
- Employee can view own data, assignment-backed Project Master rows, and submit/correct timesheets.
- Multi-role users cannot use inactive roles to bypass permissions.
- Data-quality issues are reviewed and accepted or fixed.
- Real-data reports reconcile against expected operational totals.
- Production env, backup, monitoring, audit, and rollback ownership are documented.

---

## 12. Company Inputs Still Needed

| Input | Required For |
|---|---|
| Company database connection and SSL mode | Production persistence |
| Company hosting target and deployment owner | Production deployment |
| Internal URL/domain and HTTPS approach | Secure access and cookie settings |
| Company secret management approach | `API_SESSION_SECRET`, DB credentials, rotation |
| Initial production admin users | First login and user provisioning |
| Password and reset policy | Auth lifecycle |
| Team Lead visibility/approval policy | Final RBAC |
| Project Manager approval policy | Timesheet governance |
| Real employee/client/project/allocation/timesheet files | Real-data UAT |
| Governance vs delivery capacity mapping | Accurate utilization denominators |
| Import/export format requirement | Decide whether CSV is enough or XLSX/PDF is required |
| Audit retention and export policy | Governance and compliance |
| Backup/restore policy | Operations sign-off |
| Monitoring/logging tool and owner | Production support |

---

## 13. Enterprise Workforce OS Implementation

Enterprise Workforce OS modules are implemented behind release gates, with BRD traceability, tests, runbooks, and UAT evidence updated as gates are closed:

1. Release gate 1: enterprise feature flags, route readiness, adapter-first configuration, and traceability.
2. Release gate 2: ESS and Leave Management. Unified ESS/My WorkOS Hub now composes profile, allocation/project work, planned utilization, approved-timesheet actual utilization, current timesheet status, actionable personal follow-ups, leave balances/requests, and leave-adjusted availability; `/my-workspace` remains a compatibility route. Core leave model, APIs, self-service leave, team calendar, admin policy view, balance report, availability report, policy-driven balance creation, overlap/overdraw prevention, edit/cancel flows, and smoke test coverage are complete; remaining gates are company-specific policy calibration, browser UAT evidence, and HR sign-off.
3. Release gate 3: generic approval engine. Shared records, APIs, approval workspace, delegation model, active delegation decision routing, SLA report, timesheet/leave approval linkage, and approved allocation-change governance records are complete. Remaining gates are browser UAT evidence and a company policy decision on whether allocation changes should ever be held pending before application.
4. Release gate 4: notification center with in-app, Graph email, and Graph Teams activity adapters. In-app events, templates, preferences, delivery attempts, delivery monitoring, test-send UI/API, mock provider logging, template variable rendering, Graph adapter code, and smoke coverage are complete; remaining gates are company credential configuration and browser UAT evidence.
5. Release gate 5: Entra-ready identity mapping and deterministic Teams actions. Identity links, group-role mappings, OIDC Entra login routes, signed state/nonce validation, ID-token verification, Teams user links with tenant mapping, deterministic action tokens, secure portal action URLs, Teams action landing route, mock execution, Graph Teams activity notification adapter, Teams app package RSC expectation for `TeamsActivity.Send.User`, event logs, integration health, UI, migration, and smoke coverage are complete; remaining gates are company Entra/Teams credentials, redirect URI registration, Teams app approval/install with consent, Graph permission consent, and browser UAT evidence.
6. Release gate 6: unified planning workspace and dashboard-level workforce action signals. Resource planning report/API, compact planning action console, capacity signals, bench and roll-off highlights, client delivery footprint, embedded allocation control, command-center report/API, dashboard action queue, and smoke coverage are complete; remaining gates are scenario-planning sign-off, browser UAT evidence, hosted backend fixtures, and company data reconciliation.
7. Release gate 7: production readiness hardening for all new modules. Scope hardening is complete for command-center scoped metrics, notification read/preference mutations, leave submission, deterministic Teams action-token create/execute flows, dynamic permission middleware across current backend API routes, protected permission-admin config access, permission/session refresh, browser UX smoke coverage, backend UAT matrix alignment, immutable audit governance guardrails, backup/restore handover runbook, monitoring operations runbook, credential handover guardrails, and role browser UAT evidence guardrails. Remaining gates are deeper DB-backed role fixtures, company audit retention/export sign-off, hosted/browser UAT execution, production monitoring configuration, restore rehearsal, company credential values, and owner sign-off.

Billing, AI, and Kanban/task management remain excluded from this enterprise build.
