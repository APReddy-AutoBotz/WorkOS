# WorkOS Commercial Productization Programme Charter

**Document status:** Programme-initiation baseline; product-owner Gate B approved 2026-08-23; clean exact-head review and merge pending  
**Programme code:** WOS  
**Product working name:** WorkOS  
**Repository:** `APReddy-AutoBotz/WorkOS`  
**Reference source baseline:** `APReddy-AutoBotz/Boundaryless-WorkOS@f2de1d85126f5d64f0e2e21b085b0303ca1d8417`  
**Programme owner:** AP  
**Implementation controller:** ChatGPT through governed GitHub and Codex workflows  
**Initial target:** WorkOS v1.0 buyer-owned enterprise release

## 1. Purpose

The programme converts an authorized company-oriented workforce application into a commercially reusable, buyer-owned professional-services operations platform.

The work is not a visual rename and is not a greenfield rewrite. It preserves proven capabilities while removing company-specific assumptions, introducing configuration-driven organization and terminology, supporting multiple engagement/work-capture models, adding commercial/margin controls, and packaging repeatable enterprise deployment and handover.

## 2. Product mission

WorkOS provides one controlled operational layer for:

- People, capacity and availability.
- Clients, contracts, engagements and projects.
- Assignments, work evidence and timesheets.
- Approvals, notifications, policy and audit.
- Utilization and resource planning.
- Rates, costs, budgets, revenue and gross margin.
- Billing eligibility, approved-unbilled work and invoice readiness.
- Reporting, leakage control, integrations and buyer-owned operations.

## 3. Target customer profile

WorkOS v1 primarily targets organizations with approximately 25–500 project-based workers, including IT/software services, AI/automation consultancies, engineering/design firms, agencies, management/specialist consulting, managed/knowledge services, CRO/clinical/regulatory services and internal transformation groups.

Typical buying conditions:

- Multiple clients or internal demand owners.
- T&M, fixed-fee, retainer, milestone or managed-service work.
- Spreadsheet-led/disconnected capacity, timesheet and project-financial control.
- Preference for buyer-owned application, database, configuration and source rather than shared SaaS dependence.

## 4. Positioning

> WorkOS is a buyer-owned professional-services operations platform connecting workforce capacity, client engagements, work capture, approvals, utilization, revenue and project margin.

It is not positioned as a generic employee tracker, payroll/full HRMS, full ERP/general ledger, broad CRM, task-management product or AI-first system without deterministic controls.

## 5. Programme outcomes

### 5.1 Commercial foundation

- Clean private repository and independent product history.
- No company-specific runtime branding, data or confidential artifacts.
- Central product/organization/terminology configuration.
- Clear provenance, third-party notices and reusable setup.

### 5.2 Flexible operating model

- Configurable organization and hierarchy.
- Multiple engagement/commercial models.
- Flexible work-capture/timesheet policies.
- Role/policy-based approvals and governed notifications.
- Configurable calendars, periods, currencies and terminology.

### 5.3 Revenue and margin control

- Effective-dated billing/cost rates.
- Budgets, POs and commercial limits.
- T&M, fixed-fee, milestone, retainer and managed-service calculations.
- Source-specific billing eligibility and approved-unbilled register.
- Invoice-ready batches, provider/CSV export evidence and leakage signals.
- Revenue, cost, margin and estimate-at-completion reporting.

### 5.4 Enterprise delivery

- Organization-ready data boundaries.
- Strong authorization, mandatory production identity and audit.
- Versioned migrations and reproducible deployment.
- CI/CD, tests, security scans and release evidence.
- Backup, restore, monitoring, notifications and operational handover.
- One isolated application/database per buyer for v1.

## 6. Principles

1. **Reuse proven capability, redesign assumptions.**
2. **Configuration before customization.**
3. **Deterministic core, optional intelligence.**
4. **Modular monolith before microservices.**
5. **Buyer-owned by default.**
6. **Evidence-based completion.**
7. **Security, notification scope and audit by construction.**
8. **No silent historical recalculation.**
9. **Minimal owner dependency for routine implementation.**
10. **Controlled scope focused on the v1 buying case.**

## 7. Scope

### 7.1 WorkOS v1 in scope

- Organization, legal entity, business unit, location and cost-centre configuration.
- Branding and terminology configuration.
- Workforce records, capacity, availability, skills and identity linkage.
- Clients, contracts/SOWs, POs, engagements and projects.
- Assignments, demand and resource planning.
- Daily/weekly work capture and configurable categories/policies.
- Leave-adjusted capacity and availability.
- Approval routing, delegation, escalation, canonical notifications and period locking.
- T&M, fixed-fee, milestone, retainer, managed-service and internal engagements.
- Rate cards, cost rates, budgets, POs and margin controls.
- Billing-eligibility events, approved-unbilled register, invoice-ready batches and provider/CSV exports.
- Operational, utilization, commercial, notification and governance reporting.
- Mandatory configured production OIDC identity, including Microsoft Entra as a supported configuration, plus provider-neutral notification/worklog/finance adapters.
- Audit, data quality, imports/exports and operations runbooks.
- Dockerized/cloud-deployable buyer-owned packaging.

### 7.2 Explicitly deferred

- Shared multi-tenant SaaS operation.
- Payroll/statutory payroll.
- Statutory invoice generation, tax engine and general-ledger posting.
- Complete CRM/sales pipeline.
- Native mobile applications.
- Full client portal and client recipients.
- Expense reimbursement.
- Full SCIM provisioning.
- Broad native connector marketplace.
- Autonomous AI approval or financial decisions.
- Advanced generative-AI assistant beyond optional foundations.

Deferred extension points must not delay v1.

## 8. Repository and IP boundary

- The reference repository remains unchanged.
- WorkOS receives a clean authorized snapshot, not its Git history.
- Company-only presentations, screenshots, credentials, domains, data and confidential operations are excluded.
- `PROVENANCE.md` records the declared permission basis and exact technical baseline.
- Product core, generic enhancements, buyer configuration/data, buyer-specific commissioned code and third-party components remain distinguishable.
- Transaction-specific pricing, valuation, licensing, assignment and negotiation strategy remains outside the deliverable repository.

## 9. Delivery governance

### 9.1 Governing artifacts

- `PRODUCT_REQUIREMENTS.md` — authoritative product scope.
- ADRs — architecture decisions.
- `IMPLEMENTATION_BACKLOG.md` — work-package order and acceptance.
- `IMPLEMENTATION_STATUS.md` — weighted accepted progress.
- `REQUIREMENTS_TRACEABILITY.md` — requirements, PRs, tests and evidence.
- `RISK_REGISTER.md` — material risk and controls.

### 9.2 Pull-request policy

- No implementation directly on `main`.
- One substantial outcome per branch/Draft PR.
- Required code, schema, tests, docs and evidence travel together.
- Exact-head review before merge.
- Squash merge by default.
- Codex work is independently inspected; agent statements are not acceptance evidence.

### 9.3 Escalation

Owner approval is required for final commercial name/trademark, material positioning change, >10% scope growth, destructive/irreversible data conversion, material security-release risk, buyer-result-changing financial policy, IP/licensing/sale terms and production credentials/customer data/deployment approval.

### 9.4 Controlled approval gates

The owner's 2026-08-22 programme-initiation approval authorized the private repository strategy, controller operation and WOS-00 blueprint creation. It is contextual authority, not product acceptance and does not authorize source import.

- **Gate B — Blueprint acceptance:** approved by the product owner on 2026-08-23 and recorded in `DOC-WOS-00-003-GATE-B-APPROVAL.md`. Gate B remains approved, but WOS-00F corrective hold supersedes every historical authorization to begin WOS-01 after PR #1 merged. WOS-01A remains blocked until PR #14 is clean-reviewed and merged, the corrected exact `main` SHA is recorded, and the controller explicitly reauthorizes and recreates or rebases PR #12 from that corrected baseline. This dependency supersession is not a new owner gate and does not waive clean-review, provenance, resolved-thread or exact-head merge controls.
- **Gate C — Complete WOS-06 product-owner acceptance:** occurs only after PR-010, PR-011 and PR-012 are merged **and PR-012 engineering acceptance is independently proven at an exact head before the Gate C decision**. Evidence must cover effective-dated commercial terms, deterministic calculations, source-specific billing eligibility, approved-unbilled registration, the complete invoice-ready batch and provider/CSV export lifecycle, reversals/corrections, authorization and control-total reconciliation. PR-011 alone cannot satisfy Gate C. Gate C is additional owner acceptance and never substitutes for PR-012 engineering evidence.
- **Gate D — v1 release acceptance:** required before declaring/tagging the sellable WorkOS v1.0 release and handover.

## 10. Weighted programme plan

| Workstream | Outcome | Weight |
|---|---|---:|
| WOS-00 | Blueprint and control system | 8% |
| WOS-01 | Clean source and configurable brand | 10% |
| WOS-02 | Organization/legal entity/setup | 10% |
| WOS-03 | Modular platform, API, CI/migrations | 10% |
| WOS-04 | Engagements and flexible work capture | 16% |
| WOS-05 | Approvals, notifications and locks | 8% |
| WOS-06 | Commercial and invoice readiness | 20% |
| WOS-07 | Reporting, leakage, notifications and integrations | 6% |
| WOS-08 | Security, observability, recovery and deployment | 8% |
| WOS-09 | UAT, release evidence and handover | 4% |
| **Total** |  | **100%** |

Progress is earned only after applicable evidence/gates merge.

## 11. Release roadmap

| Release | Exit meaning |
|---|---|
| v0.1.0 | Accepted governing blueprint |
| v0.2.0 | Neutral runtime/configurable branding |
| v0.4.0 | Organization/platform foundation |
| v0.5.0 | Engagements, work capture and policy |
| v0.7.0 | Commercial and invoice-readiness engine |
| v0.8.0 | Reporting, leakage, notifications and integrations |
| v0.9.0 | Enterprise security/operations release candidate |
| v1.0.0 | Sellable buyer-owned product/handover |

## 12. Success criteria

WorkOS v1 succeeds when a buyer can deploy without feature-code changes; configure brand, terminology, calendars, roles and policies; support all engagement models; produce reconciled work/revenue/cost/margin/invoice results; enforce scope and notification recipients; repeat installation/upgrade/restore; pass role UAT; provide provenance/security/operations/handover evidence; contain no prohibited runtime references; and operate independently from the reference repository.
