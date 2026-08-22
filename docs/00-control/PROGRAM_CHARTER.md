# WorkOS Commercial Productization Programme Charter

**Document status:** Programme initiation approved on 2026-08-22; governing blueprint acceptance pending Gate B  
**Programme code:** WOS  
**Product working name:** WorkOS  
**Repository:** `APReddy-AutoBotz/WorkOS`  
**Reference source baseline:** `APReddy-AutoBotz/Boundaryless-WorkOS@f2de1d85126f5d64f0e2e21b085b0303ca1d8417`  
**Programme owner:** AP  
**Implementation controller:** ChatGPT operating through governed GitHub and Codex workflows  
**Initial target:** WorkOS v1.0 buyer-owned enterprise release

## 1. Purpose

The programme converts an authorized company-oriented workforce application into a commercially reusable, buyer-owned professional-services operations platform.

The work is not a visual rename and is not a greenfield rewrite. It will preserve proven capabilities from the authorized baseline while removing company-specific assumptions, introducing configuration-driven organization and terminology controls, supporting multiple engagement and work-capture models, adding commercial and profitability controls, and packaging the system for repeatable enterprise deployment and handover.

## 2. Product mission

WorkOS will give project-based service organizations one controlled operational layer for:

- People, capacity and availability.
- Clients, contracts, engagements and projects.
- Assignments, work evidence and timesheets.
- Approvals, policy enforcement and audit.
- Utilization and resource planning.
- Rates, costs, budgets, revenue and gross margin.
- Invoice-ready work and revenue-leakage control.
- Reporting, governance and buyer-owned deployment.

## 3. Target customer profile

WorkOS v1 is designed primarily for organizations with approximately 25 to 500 project-based workers, including:

- IT and software-services companies.
- AI, automation and transformation consultancies.
- Engineering and design service providers.
- Digital, creative and marketing agencies.
- Management and specialist consulting firms.
- Managed-service and knowledge-service providers.
- CRO, clinical, regulatory and related professional-service organizations.
- Internal shared-service or transformation groups that manage multiple demand owners.

The primary buying conditions are:

- Multiple clients or internal demand owners.
- Hourly, fixed-fee, retainer, milestone or managed-service work.
- Spreadsheet-led or disconnected capacity, timesheet and project-financial controls.
- A preference for a buyer-owned application, database and source code rather than dependence on a shared SaaS tenancy.

## 4. Product positioning

> WorkOS is a buyer-owned professional-services operations platform that connects workforce capacity, client engagements, work capture, approvals, utilization, revenue and project margin.

WorkOS must not be positioned as:

- A generic employee tracker.
- A payroll or full HRMS replacement.
- A full ERP or general ledger.
- A broad CRM.
- A task-management or Kanban product.
- An AI-first assistant without deterministic operational controls.

## 5. Programme outcomes

### 5.1 Commercial foundation

- A clean private repository and product history.
- No company-specific branding, confidential artifacts or runtime terminology.
- Centralized product, organization and terminology configuration.
- Clear product licensing, provenance and third-party notices.
- Repeatable setup and buyer onboarding.

### 5.2 Flexible operating model

- Configurable organization and management hierarchy.
- Multiple engagement and commercial models.
- Flexible work-capture and timesheet policies.
- Role- and policy-based approval routing.
- Buyer-configurable calendars, periods, currencies and terminology.

### 5.3 Revenue and margin control

- Effective-dated billing and cost rates.
- Budgets, purchase orders and commercial limits.
- T&M, fixed-fee, milestone and retainer calculations.
- Approved-unbilled and invoice-ready work registers.
- Project revenue, cost, margin and estimate-at-completion reporting.
- Revenue-leakage and commercial-risk signals.

### 5.4 Enterprise delivery

- Organization-ready data boundaries.
- Strong authorization and audit controls.
- Versioned migrations and reproducible deployment.
- CI/CD, testing, security scans and release evidence.
- Backup, restore, monitoring and operational handover.
- One isolated deployment and database per buyer for v1.

## 6. Programme principles

1. **Reuse proven capability, redesign assumptions.** Reuse stable code and tests where suitable, but do not preserve company-specific domain constraints merely because they already exist.
2. **Configuration before customization.** A buyer should change branding, terminology, calendars, policies and catalogs without editing feature code.
3. **Deterministic core, optional intelligence.** Permissions, calculations, approvals, period locks and audit remain server-authoritative. AI is optional and assistive.
4. **Modular monolith before microservices.** Improve module boundaries without creating unnecessary distributed-system complexity.
5. **Buyer-owned by default.** Each buyer receives an isolated deployment, database and configuration.
6. **Evidence-based completion.** A capability is complete only when code, tests, documentation, migration evidence and acceptance evidence agree.
7. **Security and audit by construction.** Authorization and traceability are part of each feature, not post-release additions.
8. **No silent historical recalculation.** Commercial terms and effective-dated rates preserve historical truth.
9. **Minimal owner dependency.** Governing specifications provide defaults so routine implementation proceeds without repeated owner questions.
10. **Controlled scope.** Product-adjacent features that do not materially strengthen the v1 buying case remain deferred.

## 7. Scope boundaries

### 7.1 WorkOS v1 in scope

- Organization, legal entity, business unit, location and cost-centre configuration.
- Branding and terminology configuration.
- Employee/resource records and identity linkage.
- Clients, contracts, statements of work, engagements and projects.
- Assignments and resource planning.
- Worklogs, weekly/daily timesheets and configurable work categories.
- Leave-adjusted capacity and availability.
- Approval routing, delegation, escalation and period locking.
- T&M, fixed-fee, milestone, retainer, managed-service and internal engagement models.
- Rate cards, cost rates, budgets, purchase orders and margin controls.
- Invoice-ready work registers and export/integration interfaces.
- Operational, utilization, commercial and governance reporting.
- OIDC/Entra-ready identity, notifications and integration adapters.
- Audit, data quality, import/export and operational runbooks.
- Dockerized and cloud-deployable buyer-owned packaging.

### 7.2 Explicitly deferred from v1

- Shared multi-tenant SaaS operation.
- Payroll and statutory payroll processing.
- Full accounting, general ledger or tax engine.
- Complete CRM and sales pipeline management.
- Native mobile applications.
- Full client portal.
- Expense reimbursement.
- Full SCIM provisioning.
- Large marketplace of native third-party connectors.
- Autonomous AI approval or financial decision-making.
- Advanced generative-AI assistant beyond optional BYOK foundations.

Deferred capabilities may be prepared through extension points but must not delay v1.

## 8. Repository and IP boundary

- The original `Boundaryless-WorkOS` repository remains unchanged.
- WorkOS receives a clean authorized snapshot, not the original Git history.
- The commercial repository must exclude company-only presentations, screenshots, credentials, domains, data and confidential operating material.
- `PROVENANCE.md` records the declared permission basis and exact technical baseline.
- Proprietary WorkOS code, buyer-specific customizations and third-party/open-source components must be clearly distinguished.
- Transaction-specific pricing, valuation and legal/commercial strategy must remain outside the deliverable product repository.

## 9. Delivery governance

### 9.1 Governing artifacts

- `PRODUCT_REQUIREMENTS.md` is the authoritative product scope.
- Architecture decisions are recorded as ADRs.
- `IMPLEMENTATION_BACKLOG.md` controls work-package sequence and acceptance.
- `IMPLEMENTATION_STATUS.md` records weighted progress against accepted capability.
- `REQUIREMENTS_TRACEABILITY.md` links requirements to issues, pull requests, tests and evidence.
- `RISK_REGISTER.md` records material programme risk and mitigation.

### 9.2 Pull-request policy

- No implementation directly on `main`.
- One substantial outcome per branch and Draft PR.
- Required code, schema, tests, documents and evidence travel together.
- Exact-head review is required before merge.
- Squash merge is the default.
- Codex-generated work must be independently inspected; agent statements are not acceptance evidence.

### 9.3 Escalation policy

The controller may decide routine technical implementation matters within approved requirements. Owner approval is required for:

- Final commercial product name and trademark decision.
- Material product-positioning change.
- Scope growth greater than approximately 10 percent of the approved programme.
- Destructive migration or irreversible data conversion.
- A security risk that materially changes release suitability.
- A commercial calculation policy that materially changes buyer financial results.
- IP, exclusivity, licensing or sale terms.
- Production credentials, customer data or deployment approval.

### 9.4 Controlled approval gates

The owner's 2026-08-22 programme-initiation approval authorized the private repository strategy, controller operation and WOS-00 blueprint creation. It is contextual authority, not a product acceptance gate and does not authorize source import.

- **Gate B — Blueprint acceptance:** required before importing the application source or starting WOS-01 implementation.
- **Gate C — Commercial-engine acceptance:** required after deterministic revenue/margin/invoice-readiness evidence and before treating the commercial engine as accepted.
- **Gate D — v1 release acceptance:** required before declaring/tagging the sellable WorkOS v1.0 release.

## 10. Weighted programme plan

| Workstream | Outcome | Weight |
|---|---|---:|
| WOS-00 | Baseline, charter, requirements, architecture and control system | 8% |
| WOS-01 | Clean commercial source baseline and neutral configuration-driven brand | 10% |
| WOS-02 | Organization, legal entity, terminology and guided setup | 10% |
| WOS-03 | Modular architecture, API boundaries, CI/CD and migration harness | 10% |
| WOS-04 | Engagement models and flexible work capture | 16% |
| WOS-05 | Policy engine, approvals, delegation and period locking | 8% |
| WOS-06 | Rates, costs, budgets, revenue, margin and invoice readiness | 20% |
| WOS-07 | Reporting, leakage controls and integration framework | 6% |
| WOS-08 | Enterprise security, observability, backup and deployment hardening | 8% |
| WOS-09 | Production-like UAT, release evidence and buyer handover | 4% |
| **Total** |  | **100%** |

Progress is earned only after the applicable acceptance gates are merged.

## 11. Release roadmap

| Release | Exit meaning |
|---|---|
| v0.1.0 | Governing blueprint and controlled commercial repository baseline |
| v0.2.0 | Neutral WorkOS runtime and configuration-driven branding |
| v0.4.0 | Organization and platform foundation |
| v0.5.0 | Flexible engagements, work capture and approval policies |
| v0.7.0 | Commercial, revenue, margin and invoice-readiness engine |
| v0.8.0 | Reporting, leakage controls and integration contracts |
| v0.9.0 | Enterprise security/operations release candidate with production-like evidence |
| v1.0.0 | Sellable buyer-owned product and handover package |

## 12. Programme success criteria

WorkOS v1 is successful when:

- A new buyer can deploy an isolated environment without changing feature code.
- Branding, terminology, calendars, roles and policies are configurable.
- Multiple engagement models produce reconciled work, revenue, cost and margin outcomes.
- Organization and role boundaries prevent unauthorized cross-scope access.
- Fresh installation, upgrade, backup and restore are demonstrably repeatable.
- High-risk role journeys pass in production-like browser UAT.
- The release contains complete provenance, security, operations and buyer-handover evidence.
- No prohibited company-specific runtime references remain.
- The product can be demonstrated and commercially evaluated without requiring the original repository.
