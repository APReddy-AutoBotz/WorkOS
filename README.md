# WorkOS

WorkOS is a buyer-owned professional-services operations platform for workforce, client engagements, work capture, approvals, utilization, revenue, margin and invoice readiness.

> **Naming note:** WorkOS is the temporary product working name. Runtime branding and buyer terminology must remain configuration-driven.

## Current programme state

The repository is in the **WOS-00 governing-blueprint stage**. Application source is intentionally not present yet. The authorized source bootstrap starts only after the blueprint is approved and merged.

## Governing documents

1. `docs/00-control/PRODUCT_REQUIREMENTS.md` — authoritative product requirements.
2. `docs/00-control/PROGRAM_CHARTER.md` — purpose, scope and programme governance.
3. `docs/02-architecture/ARCHITECTURE_OVERVIEW.md` — target modular-monolith architecture.
4. `docs/04-quality/NON_FUNCTIONAL_REQUIREMENTS.md` — mandatory quality attributes.
5. `docs/05-delivery/IMPLEMENTATION_BACKLOG.md` — workstream sequence and acceptance.
6. `PROVENANCE.md` — authorized source boundary and import controls.
7. `AGENTS.md` — operating contract for human and AI-assisted work.

## Product boundaries

WorkOS v1 supports isolated buyer deployments, configurable organization and terminology, multiple engagement models, daily/weekly work capture, resource planning, approvals, effective-dated commercial terms, revenue/margin controls and invoice-ready exports.

WorkOS v1 is not a payroll system, statutory invoicing engine, general ledger, complete CRM, shared multi-tenant SaaS control plane or autonomous AI decision-maker.

## Delivery model

- One substantial outcome per branch and Draft pull request.
- Server-authoritative authorization, approval, financial and audit behavior.
- Versioned migrations with fresh-install and upgrade evidence.
- Exact-head review and evidence before merge.
- Squash merge by default.
- Sol reasoning models preferred for Codex architecture, security, migration and commercial-engine tasks.

## Documentation map

- `docs/01-product/` — positioning, personas, scope, feature catalog and white-label behavior.
- `docs/02-architecture/` — domain, data, API, integration, security and deployment architecture plus ADRs.
- `docs/03-specifications/` — implementation specifications for product capabilities.
- `docs/04-quality/` — NFRs, test strategy, security/privacy and release acceptance.
- `docs/05-delivery/` — backlog, Codex playbook, review policy, operations and buyer handover.

## Contributing

Read `CONTRIBUTING.md`, `SECURITY.md` and `AGENTS.md` before proposing changes. No implementation may be pushed directly to `main`.