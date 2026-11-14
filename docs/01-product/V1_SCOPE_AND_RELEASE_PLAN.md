# WorkOS v1 Scope and Release Plan

## v1 outcome

A buyer can deploy an isolated WorkOS environment, configure organization and terminology, import controlled master data, manage engagements and work evidence, calculate utilization and commercial results, prepare invoice-ready exports, operate securely and complete a documented handover.

## In-scope capability groups

- Organization, legal entities, structure, branding, terminology, calendars and periods.
- Named identities, active roles, permissions, data scope and access review.
- Workforce, capacity, availability, skills and lifecycle guardrails.
- Clients, contracts/SOWs, POs, engagements, projects and milestones.
- Demand, assignments, planned/forecast utilization, bench and roll-off.
- Daily/weekly work capture, submission, correction and import contracts.
- Approval routing, stages, delegation, SLA/escalation and locks.
- Rates, costs, budgets, multi-model revenue/margin and EAC.
- Approved-unbilled register, invoice-ready batches and controlled exports.
- Operational/commercial reporting, leakage signals, data quality and audit.
- OIDC/Entra-ready identity and provider-neutral integration adapters.
- CI/CD, migrations, containers, health, monitoring, backup/restore and handover.

## Deferred from v1

- Shared multi-tenant SaaS control plane.
- Payroll, statutory invoices, tax engine and general ledger posting.
- Full CRM, expense platform, client portal and native mobile apps.
- Full SCIM and broad native connector marketplace.
- Autonomous AI finance or approval decisions.

## Workstream and release mapping

| Release | Workstreams | Exit meaning |
|---|---|---|
| v0.1.0 | WOS-00 | Accepted blueprint; no runnable product claim |
| v0.2.0 | WOS-01 | Clean source baseline and neutral configurable brand |
| v0.4.0 | WOS-02 to WOS-03 | Organization and platform foundation |
| v0.5.0 | WOS-04 to WOS-05 | Flexible engagements, work capture and policy |
| v0.7.0 | WOS-06 | Commercial engine and invoice readiness |
| v0.8.0 | WOS-07 | Reporting, leakage controls and integration contracts |
| v0.9.0 | WOS-08 | Enterprise security/operations release candidate |
| v1.0.0 | WOS-09 | Production-like acceptance and buyer handover |

## Release-gate model

The [enterprise delivery and integration roadmap](../05-delivery/ENTERPRISE_DELIVERY_ROADMAP.md), updated 2026-11-14, prioritizes verified integration, consistent utilization, workflow recovery, scale/restore evidence and buyer acceptance within this existing scope. The [current implementation status](../00-control/IMPLEMENTATION_STATUS.md) distinguishes merged source from draft evidence. The milestone table above defines exit meanings, not a claim that those releases have been accepted.

Engineering readiness and buyer/environment acceptance are separate. A module can be code-complete while still requiring buyer identity configuration, data reconciliation, operations ownership or UAT.

No release may claim readiness solely from implementation-agent output. Exact-head CI, migration, authorization, browser, security and operational evidence must satisfy `docs/04-quality/RELEASE_ACCEPTANCE_CRITERIA.md`.
