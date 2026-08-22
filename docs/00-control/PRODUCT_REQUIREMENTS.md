# WorkOS Product Requirements

**Authority:** This document is the single authoritative source for WorkOS product scope and product-level acceptance.  
**Status:** v1 blueprint baseline  
**Requirement format:** `WOS-<DOMAIN>-<NUMBER>`  
**Target release:** WorkOS v1.0

## 1. Product statement

WorkOS is a buyer-owned professional-services operations platform for organizations that manage people, clients, engagements, project capacity, work evidence, approvals, utilization, revenue and margin.

The product must support organizations whose delivery and reporting models differ from the original reference implementation. It must therefore separate stable domain concepts from configurable labels, policies and commercial models.

## 2. Product outcomes

WorkOS must enable a buyer to:

1. Establish an organization, legal entities, business units, calendars, currencies, roles and terminology without modifying source code.
2. Manage employees/resources, clients, contracts, engagements, projects and assignments as controlled master data.
3. Capture work through configurable daily or weekly flows and govern submission, correction and approval.
4. Calculate planned, actual and forecast utilization using explicit capacity and availability rules.
5. Manage billing rates, cost rates, budgets, purchase orders, fixed-fee/retainer consumption, revenue and gross margin.
6. Prepare controlled invoice-ready work and identify revenue leakage.
7. Enforce role, permission, organization and row/data-scope authorization.
8. Provide immutable operational and commercial audit evidence.
9. Deploy as an isolated buyer-owned application and database with repeatable setup, migration, backup, restore and monitoring.

## 3. Personas and primary jobs

| Persona | Primary jobs |
|---|---|
| Organization Administrator | Configure organization, identity, roles, terminology, integrations and release settings |
| HR / People Operations | Maintain workforce records, employment capacity, calendars and leave inputs |
| Resource Manager / Delivery Lead | Plan capacity, allocate resources, manage bench/roll-off and resolve staffing risk |
| Engagement / Project Manager | Maintain engagements/projects, budgets, assignments, work approval and delivery forecasts |
| Account / Commercial Manager | Maintain contracts, purchase orders, rate cards, billing schedules and client commercial controls |
| Finance / Billing Analyst | Review approved-unbilled work, prepare invoice-ready batches, reconcile revenue and export billing data |
| Team Lead / Approver | Review scoped work, leave or other approval items and delegate authority when permitted |
| Employee / Contractor | View assignments, enter work, submit timesheets, correct rejected entries and view personal utilization |
| Executive / Practice Leader | Review capacity, utilization, client concentration, revenue, margin, risk and data confidence |
| Auditor / Control Owner | Review immutable audit evidence, access changes, commercial changes, exports and policy exceptions |
| Integration Administrator | Configure and monitor identity, notification and external-system adapters |

User-facing role names may be configured. Internal canonical role/permission concepts must remain stable for authorization and migrations.

## 4. Cross-cutting product rules

### WOS-CORE-001 — Configuration before customization

Organization branding, terminology, calendars, currencies, hierarchy labels, work categories, approval policies and feature enablement must be managed through controlled configuration rather than feature-code edits.

### WOS-CORE-002 — Isolated buyer deployment

WorkOS v1 must support one isolated application and database per buyer. The data model must nevertheless include organization/legal-entity ownership boundaries where required to prevent future structural lock-in.

### WOS-CORE-003 — Server authority

Permissions, row scope, commercial calculations, approval transitions, period locks, audit identity and final report totals must be calculated or validated on the server.

### WOS-CORE-004 — Effective-dated truth

Rates, costs, assignments, contracts, calendars and other time-sensitive terms must use effective dates. Historical approved and financial results must not silently change when future terms are edited.

### WOS-CORE-005 — Traceable state changes

Every production-relevant mutation must identify actor, active role, source, timestamp, entity, reason where applicable, and material before/after values.

### WOS-CORE-006 — Configurable terminology

The buyer must be able to configure user-facing labels for at least employee/resource, manager, team lead, business unit, region, engagement, project and timesheet/worklog without changing domain keys or API contracts.

### WOS-CORE-007 — No company-specific runtime dependencies

No runtime feature, seed, template, notification or document delivered with the product may require Boundaryless names, assets, domains, roles, data or operating conventions.

### WOS-CORE-008 — Deterministic financial behavior

All financial calculations must be deterministic, decimal safe, explicit about currency and rounding, and testable without generative AI.

## 5. Organization and configuration requirements

### WOS-ORG-001 — Organization profile

Administrators must maintain organization name, legal name, product display name, support contact, default locale, default time zone, base currency, fiscal-year start and default week-start day.

### WOS-ORG-002 — Legal entities

The product must support one or more legal entities with legal name, registration/tax identifiers as optional fields, reporting currency, address, status and effective dates.

### WOS-ORG-003 — Business structure

The product must support configurable business units, departments, cost centres, practices, locations and regions, with active/inactive status and dependency-safe retirement.

### WOS-ORG-004 — Organizational hierarchy

The buyer must be able to represent reporting-manager and operational-ownership relationships without relying on one hardcoded leadership title.

### WOS-ORG-005 — Brand configuration

Administrators must configure product name, organization name, logo, compact mark, favicon, primary/secondary accent tokens and email/report branding through a centralized configuration surface.

### WOS-ORG-006 — Terminology configuration

Administrators must configure approved singular/plural labels and help text for defined user-facing domain terms. Changes must not alter canonical data keys.

### WOS-ORG-007 — Feature configuration

Administrators must enable or disable optional modules by environment and record the release owner, evidence and activation timestamp.

### WOS-ORG-008 — Working calendars

The product must support calendars by country, legal entity or worker group, including work week, daily standard hours, public/company holidays and effective dates.

### WOS-ORG-009 — Period configuration

The product must support weekly, monthly and fiscal reporting periods and distinguish open, submission-closed, approval-closed and financially locked states.

### WOS-ORG-010 — Guided setup

A new installation must provide a guided setup status that covers organization, legal entity, calendars, roles, identity, initial users, imports, commercial defaults, notifications and production-readiness checks.

## 6. Identity, roles and access requirements

### WOS-IAM-001 — Identity providers

WorkOS must support local controlled accounts for non-production/demo use and OIDC-based enterprise identity, including Microsoft Entra as a supported configuration.

### WOS-IAM-002 — Named production accounts

Production operation must use named user identities. Shared demo accounts must be disabled or absent in production mode.

### WOS-IAM-003 — Active role

A multi-role user must select or be assigned an active role for the session. Assigned roles alone must not authorize an action outside the selected active role.

### WOS-IAM-004 — Permission registry

The platform must maintain a stable permission registry with role templates and controlled user-specific exceptions.

### WOS-IAM-005 — Data scope

Authorization must combine identity, active role, permission and data scope. Data scope must cover organization/legal entity and relevant employee, team, engagement, client and project relationships.

### WOS-IAM-006 — Protected permissions

Security administration, audit administration and permission-management capabilities must have protected guardrails that cannot be accidentally removed from every administrator.

### WOS-IAM-007 — Access review

Administrators must be able to export or review role permissions, user exceptions and effective access for governance review.

### WOS-IAM-008 — Session operations

Production sessions must be revocable, time limited and securely cookie/token managed. Session lifetime must be configurable and changes auditable.

### WOS-IAM-009 — Account lifecycle

The product must support joiner, mover, leaver and disabled-account states, with dependency-aware effects on assignments, approvals and login access.

### WOS-IAM-010 — Negative authorization evidence

Every protected module must include tests proving unauthorized roles and out-of-scope identities are denied at API and data levels.

## 7. Workforce and availability requirements

### WOS-WKF-001 — Workforce master

The workforce master must support employee/resource code, name, email, worker type, employment/contract status, role/designation, organization structure, location, manager, start/end dates, standard capacity and utilization eligibility.

### WOS-WKF-002 — Worker types

The product must distinguish at least employee, contractor, fixed-term worker, intern and external resource, with configurable user-facing labels.

### WOS-WKF-003 — Capacity profiles

Capacity must support weekly hours, part-time percentage, effective dates, working calendar and utilization eligibility.

### WOS-WKF-004 — Skills and capabilities

Workers may have skills, proficiency, certifications and availability notes for planning and reporting. Skill matching is deterministic in v1; AI suggestions are optional and non-authoritative.

### WOS-WKF-005 — Leave and absence impact

Approved leave and configured holidays must reduce availability according to calendar and capacity rules.

### WOS-WKF-006 — Workforce lifecycle guardrails

Exiting or disabling a worker must identify active assignments, open approvals, unsubmitted work and ownership dependencies before completion.

### WOS-WKF-007 — Self-service view

A worker must be able to see personal profile, capacity, assignments, current work status, leave/availability where enabled, utilization and action items within authorized scope.

### WOS-WKF-008 — Organization views

Authorized users must view directory and hierarchy information according to active-role data scope, not through global client-side filtering alone.

## 8. Client, contract and engagement requirements

### WOS-CLI-001 — Client master

The client master must support code, legal/display name, industry, status, account owner, billing contacts, currency defaults and organization ownership.

### WOS-CLI-002 — Client hierarchy

The product should support parent/client account relationships and multiple billing entities or business units without requiring duplicate uncontrolled client records.

### WOS-CTR-001 — Contract master

A contract must support client, legal entity, contract/SOW number, effective dates, status, currency, commercial model, value, billing terms, purchase-order linkage and documents/links metadata.

### WOS-CTR-002 — Purchase orders

Purchase orders must support identifier, currency, value, effective dates, consumed/committed value, remaining value, status and warning thresholds.

### WOS-CTR-003 — Contract versioning

Material contract changes must be versioned or effective dated and audited. Historical approved work must retain the commercial terms applicable at the work date.

### WOS-ENG-001 — Engagement models

Engagements must support at least:

- Time and materials.
- Fixed fee.
- Milestone based.
- Retainer.
- Managed service.
- Internal/non-client initiative.
- Pre-sales/non-billable initiative.

### WOS-ENG-002 — Engagement structure

An engagement must link client, contract, legal entity, owner, commercial model, dates, status, currency, budget and one or more projects/workstreams.

### WOS-ENG-003 — Project/workstream master

Projects/workstreams must support code, name, engagement, manager, dates, status, billability policy, budget allocation and closure controls.

### WOS-ENG-004 — Dependency-safe closure

Closing a contract, engagement or project must identify open assignments, draft/submitted work, pending approvals, unbilled approved work and commercial balances.

### WOS-ENG-005 — Internal engagements

Internal and pre-sales work must use the same controlled work-capture model while remaining non-billable and attributable to cost centres or business units.

## 9. Resource planning and assignment requirements

### WOS-RES-001 — Assignment model

An assignment must link worker, engagement/project, role, allocation percentage or planned hours, date range, billability, cost/revenue treatment, status and comments.

### WOS-RES-002 — Date guardrails

Assignment dates must remain within the applicable engagement/project dates unless a controlled exception is approved and audited.

### WOS-RES-003 — Over-allocation policy

The buyer must configure warning and blocking thresholds for overlapping capacity. The system must calculate overlap server-side.

### WOS-RES-004 — Planned utilization

Planned utilization must derive from effective assignments and applicable worker capacity for the selected period.

### WOS-RES-005 — Forecast utilization

Forecast utilization must support configurable horizons and include future approved/planned assignments according to status rules.

### WOS-RES-006 — Bench and roll-off

Authorized users must identify bench, underutilization, overload, upcoming roll-off and unstaffed demand using configurable thresholds.

### WOS-RES-007 — Demand records

The product should support unfilled demand/role requirements with dates, skill/role, capacity and status so planning is not limited to already assigned workers.

### WOS-RES-008 — Assignment approval

The buyer may require assignment creation or material changes to follow configurable approval rules.

### WOS-RES-009 — Historical integrity

Ending or editing an assignment must not rewrite approved work evidence or historical financial snapshots.

## 10. Work capture and timesheet requirements

### WOS-TIM-001 — Work-capture modes

The buyer must be able to enable weekly grid and daily-entry modes. A timer may be added as an optional v1 extension but must create reviewable work records rather than directly approved time.

### WOS-TIM-002 — Work categories

Work categories must distinguish billable client work, non-billable client work, internal delivery, pre-sales, training, leave/absence reference, administration and buyer-defined categories.

### WOS-TIM-003 — Entry dimensions

A work entry must support worker, date, engagement/project, optional task/ticket/milestone reference, category, hours/quantity, billability, comment, evidence link and source.

### WOS-TIM-004 — Assignment validation

The system must validate whether work is permitted against the selected engagement/project, assignment, contract dates and period state. Exceptions must follow policy and be auditable.

### WOS-TIM-005 — Entry increments and limits

The buyer must configure minimum time increments, daily/weekly maximums, overtime rules and comment/evidence requirements.

### WOS-TIM-006 — States

Timesheets/work periods must support Draft, Submitted, Approved, Rejected, Reopened/Correction Required and Locked states as applicable.

### WOS-TIM-007 — Submission deadlines

Submission deadlines and grace periods must be configurable by worker group, legal entity or period policy.

### WOS-TIM-008 — Rejection and correction

Rejected work must include a reason visible to the worker. Corrected submissions must preserve the prior submitted/approved history.

### WOS-TIM-009 — Future and locked periods

Future work and locked-period edits must be blocked unless explicitly allowed by policy and authorized exception.

### WOS-TIM-010 — Actual utilization

Actual utilization must use approved work according to configured inclusion rules divided by applicable available capacity for the period.

### WOS-TIM-011 — Worklog import

The product must provide adapter-ready import contracts for external worklogs such as Jira, Azure DevOps, ServiceNow or CSV without making those integrations mandatory for v1.

### WOS-TIM-012 — Duplicate prevention

The server must prevent or flag duplicate imported and manually entered work according to deterministic keys and source identifiers.

## 11. Approval and policy requirements

### WOS-APR-001 — Generic approval record

The platform must maintain a generic approval record that can link to timesheets, leave, assignments, budget changes, commercial changes and invoice-ready batches.

### WOS-APR-002 — Approval routing

Approval routing must be configurable using entity type, organization, engagement/project, worker, amount/value threshold, active role and sequence.

### WOS-APR-003 — Multi-step approvals

The platform must support single-step and ordered multi-step approvals where required by policy.

### WOS-APR-004 — Delegation

Authorized approvers must create time-bound delegations. The delegate must receive no broader data scope than the delegated authority.

### WOS-APR-005 — SLA and escalation

Approval policies may define due dates, reminders and escalation targets. Overdue items must be reportable.

### WOS-APR-006 — Decision integrity

Only pending/current-stage approvals may be decided. Rejection comments must be required where configured.

### WOS-APR-007 — Period locking

Approved work and finalized commercial periods must be lockable. Reopening must require authorized reason and audit evidence.

### WOS-APR-008 — Bulk decisions

Authorized approvers may perform bulk approval only when every selected item independently passes permission, scope and policy validation.

## 12. Commercial, revenue and margin requirements

### WOS-COM-001 — Billing rate cards

The product must support effective-dated billing rates by one or more dimensions, including client, contract, engagement, project, role, worker, location or grade, with deterministic precedence rules.

### WOS-COM-002 — Cost rates

The product must support confidential effective-dated cost rates and optionally burden/overhead components. Cost visibility must be permission controlled.

### WOS-COM-003 — Rate resolution evidence

Every calculated commercial line must record the rate/cost source, effective period, currency and resolution rule used.

### WOS-COM-004 — Currency and rounding

The product must support engagement currency, organization/base currency and configured exchange-rate inputs. Rounding must be explicit by amount type and currency precision.

### WOS-COM-005 — Budgets

Engagements/projects must support budgeted hours/units, revenue, cost and expenses as applicable, with approved change history.

### WOS-COM-006 — T&M calculation

For T&M work, approved billable quantity multiplied by the resolved billing rate must produce billable value, subject to configured rounding, caps and exclusions.

### WOS-COM-007 — Fixed-fee control

Fixed-fee engagements must track contract value, billing schedule, recognized/earned value policy, consumed effort/cost and margin risk without treating all approved hours as directly invoiceable.

### WOS-COM-008 — Milestone control

Milestones must support value, due date, acceptance status, billing eligibility, evidence and approval.

### WOS-COM-009 — Retainer control

Retainers must support period, contracted value/capacity, consumption, rollover/expiry policy and overage handling.

### WOS-COM-010 — Managed-service control

Managed-service engagements must support service units, tickets, shifts or other configured quantity dimensions while retaining optional time/cost evidence.

### WOS-COM-011 — Revenue and cost snapshots

The system must produce period snapshots for approved work, billable value, recognized/earned revenue where configured, cost, gross margin and margin percentage.

### WOS-COM-012 — Estimate at completion

Authorized users must review budget, actuals, remaining forecast and estimate-at-completion for hours, revenue, cost and margin.

### WOS-COM-013 — Purchase-order consumption

The system must calculate committed/consumed purchase-order value and warn or block activity according to thresholds and policy.

### WOS-COM-014 — Commercial change approval

Changes to rates, budgets, contract values, PO limits and billing schedules must be auditable and may require configured approval.

### WOS-COM-015 — Confidentiality

Cost rates, individual compensation-derived data and margin details must be separately permission controlled from operational project access.

## 13. Invoice-readiness requirements

### WOS-INV-001 — Approved-unbilled register

Finance-authorized users must see approved billable work or milestones not yet included in an invoice-ready batch.

### WOS-INV-002 — Invoice-ready batches

Users must create controlled invoice-ready batches by client, legal entity, engagement, period and currency.

### WOS-INV-003 — Batch line traceability

Every batch line must trace to approved work, milestone, retainer schedule or adjustment and preserve its commercial calculation evidence.

### WOS-INV-004 — Adjustments

Authorized users may add controlled discounts, credits, write-offs or corrections with reason, approval policy and audit.

### WOS-INV-005 — Supporting evidence

Invoice-ready batches must include or link to approved timesheet/work evidence and client-required references where configured.

### WOS-INV-006 — Batch states

Batches must support Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled states with valid transitions.

### WOS-INV-007 — Export and integration

The product must provide controlled CSV and API-ready exports for accounting/billing systems. WorkOS v1 is not required to issue statutory invoices or post to a general ledger.

### WOS-INV-008 — No double billing

The server must prevent the same eligible source line from being included in multiple active/finalized invoice-ready batches unless an authorized reversal/correction exists.

## 14. Reporting and control requirements

### WOS-RPT-001 — Operational dashboard

Authorized users must review active workforce, capacity, utilization, staffing risk, pending work/approvals and data confidence within their scope.

### WOS-RPT-002 — Utilization reporting

Reports must provide planned, actual and forecast utilization with explicit denominator, inclusion rules and scoped drilldown.

### WOS-RPT-003 — Commercial reporting

Reports must provide budget versus actual, approved-unbilled, revenue, cost, gross margin, PO consumption, fixed-fee/retainer consumption and estimate-at-completion.

### WOS-RPT-004 — Revenue-leakage signals

The product must identify at least:

- Missing or late timesheets.
- Submitted but unapproved work.
- Approved but unbilled work.
- Work outside assignment/contract dates.
- Missing or conflicting rates.
- PO threshold or expiry risk.
- Fixed-fee effort/cost overrun.
- Retainer overconsumption or expiry.
- Margin below threshold.
- Duplicate or anomalous billing eligibility.

### WOS-RPT-005 — Data-quality reporting

The system must report missing, inconsistent or unsafe master-data and commercial-data conditions with owner and suggested action.

### WOS-RPT-006 — Export governance

Report exports must obey server-side permission and scope, record audit evidence and identify filters/as-of date.

### WOS-RPT-007 — Reconciliation

Commercial reports must reconcile to invoice-ready and period snapshot records through defined control totals.

## 15. Integration and notification requirements

### WOS-INT-001 — Adapter architecture

Identity, email, collaboration, worklog and finance integrations must use explicit provider adapters with mock/test implementations.

### WOS-INT-002 — Notification channels

The product must support in-app notifications and adapter-ready email/collaboration notifications with templates, preferences and delivery evidence.

### WOS-INT-003 — Idempotency

Inbound integrations and webhook-style operations must support idempotency or duplicate detection.

### WOS-INT-004 — Integration health

Administrators must see configured provider, credential readiness without exposing secrets, recent failures and relevant mapping gaps.

### WOS-INT-005 — Failure isolation

External delivery or integration failure must not silently roll back an otherwise valid core transaction unless the business policy explicitly requires atomic behavior.

### WOS-INT-006 — Outbound financial interface

Invoice-ready and commercial exports must provide stable versioned contracts suitable for downstream accounting adapters.

## 16. Governance and audit requirements

### WOS-GOV-001 — Immutable audit posture

Audit records must be append-only for normal application users. Corrections must create new evidence rather than rewriting history.

### WOS-GOV-002 — Audit coverage

Audit must cover authentication events, role/permission changes, master data, assignments, timesheets, approvals, rates, costs, budgets, POs, commercial calculations, invoice-ready batches, imports, exports, settings and integration operations.

### WOS-GOV-003 — Retention policy

Audit and operational retention must be configurable and documented. Deletion/anonymization must respect legal and buyer policy constraints.

### WOS-GOV-004 — Data provenance

Imported and integrated records must retain source, source identifier, import/batch reference and processing result where applicable.

### WOS-GOV-005 — Release traceability

The product repository must link requirements to implementation issues, pull requests, tests and release evidence.

## 17. Operations and deployment requirements

### WOS-OPS-001 — Reproducible deployment

The release must provide a reproducible production build and container/deployment configuration for one isolated buyer environment.

### WOS-OPS-002 — Environment validation

Production startup must validate required configuration and fail closed on missing/unsafe secrets or database settings.

### WOS-OPS-003 — Migration execution

Migrations must run through a controlled command or release step with fresh-install and prior-version upgrade evidence. Application startup must not be the only safe migration mechanism.

### WOS-OPS-004 — Health endpoints

The product must expose liveness and readiness/health information without disclosing secrets.

### WOS-OPS-005 — Backup and restore

The release must include buyer-owned backup/restore instructions and a tested restore rehearsal.

### WOS-OPS-006 — Monitoring

The product must provide structured logs, operational health signals and documented alert ownership.

### WOS-OPS-007 — CI/CD

CI must run build, type/lint, tests, migration validation, secret scanning and dependency/security checks as configured before merge/release.

### WOS-OPS-008 — Release artifacts

Releases must be versioned, tagged and accompanied by changelog, migration notes, known limitations, test evidence and rollback guidance.

### WOS-OPS-009 — Demo/production separation

Demo data, shortcuts and fallback storage must not be available in production unless explicitly enabled in a non-production deployment profile.

### WOS-OPS-010 — Buyer handover

The v1 package must include deployment, credential, data import, role UAT, security, backup, monitoring, support and acceptance checklists.

## 18. Deferred requirements

The following are deliberately deferred unless promoted through an approved scope change:

- Shared multi-tenant SaaS control plane.
- Native mobile apps.
- Payroll processing.
- Statutory invoice generation and general-ledger posting.
- Complete CRM/sales pipeline.
- Full expense-management module.
- Full SCIM lifecycle provisioning.
- Autonomous AI approval or financial decisions.
- Broad connector marketplace.

## 19. Definition of product acceptance

A requirement may be marked accepted only when:

1. The implementation and data model are merged.
2. Positive and negative automated tests pass.
3. Applicable migration paths pass.
4. Applicable role/browser journeys pass.
5. Audit and authorization behavior is proven.
6. Documentation and traceability are updated.
7. Known limitations are recorded.
8. The exact accepted commit is identified.

Statements such as “implemented,” “code complete” or “tests should pass” are not acceptance evidence without the corresponding executable results.
