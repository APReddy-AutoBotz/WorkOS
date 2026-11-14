# WorkOS

WorkOS is a buyer-owned professional-services operations platform that connects resource planning, approved work, effective capacity and commercial control. Its direction is an enterprise utilization product where every percentage has an explicit period, denominator, inclusion rule and authorized source.

> **Naming note:** WorkOS is the temporary product working name. Runtime branding and buyer terminology must remain configuration-driven.

## Current programme state

Application source, organization/setup foundations and CI/migration/production-profile infrastructure are present on `main`. The verified baseline for this documentation refresh is `b9a57f8a462d8585bb3f73129080d6fae5173343`; source bootstrap entered the repository through PR16. The previous statement that application source was absent was stale.

Substantial operational, commercial and security work remains in dependent Draft pull requests. Passing checks on those branches do not mean the changes are merged or that v1 is production-ready. The governed project-contribution replacement is still being implemented and must complete export and end-to-end acceptance before publication.

Start with the [current implementation status](docs/00-control/IMPLEMENTATION_STATUS.md), [product vision](docs/01-product/PRODUCT_VISION_AND_POSITIONING.md), and [delivery and integration roadmap](docs/05-delivery/ENTERPRISE_DELIVERY_ROADMAP.md).

## Product direction

- **Trust the numbers:** effective part-time capacity, calendars and once-only leave reductions; approved evidence and category inclusion; exact decimal calculations and reproducible exports.
- **Plan with context:** distinguish planned, approved actual and forecast work; expose bench, overload, demand and roll-off within the viewer's scope.
- **Recover clearly:** loading, empty, denied, unavailable and uncertain-save states must remain distinct. Preserve edits and reconcile uncertain commands before retrying.
- **Operate securely:** current identity/role/data scope, independent approvals, immutable audit evidence, verified database TLS, controlled migrations and tested recovery.
- **Stay buyer-owned:** isolated application/database deployment, configurable terminology and branding, provider adapters and documented handover.

These are product and acceptance commitments, not claims that every capability is already accepted on `main`. Financial valuation, billing eligibility and invoice readiness remain separate decisions; operational earned-management metrics are not statutory accounting recognition.

## Development and operations

The application uses React/TypeScript, Node.js/Express and PostgreSQL in a modular monolith. Install the checked-out revision's lockfile with `npm ci`; consult [environment examples](.env.example), the [deployment architecture](docs/02-architecture/DEPLOYMENT_ARCHITECTURE.md) and [operations runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md) before configuring or running it. Production requires its documented infrastructure and identity configuration; demo/test settings are not production setup.

Available commands and acceptance suites live in [package.json](package.json). Run checks for the revision you intend to use, not a different Draft head. Do not treat this README as a deployment approval or buyer UAT sign-off.

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

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [AGENTS.md](AGENTS.md) before proposing changes. No implementation may be pushed directly to `main`. Merge in dependency order after exact-head review and applicable checks; verify the resulting main-branch checks and update status afterward.
