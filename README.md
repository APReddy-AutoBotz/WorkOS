# WorkOS

WorkOS is a buyer-owned professional-services operations platform that connects resource planning, approved work, effective capacity and commercial control. Its direction is an enterprise utilization product where every percentage has an explicit period, denominator, inclusion rule and authorized source.

> **Naming note:** WorkOS is the temporary product working name. Runtime branding and buyer terminology must remain configuration-driven.

## Current programme state

Application source, organization/setup foundations, CI/migration/production-profile infrastructure and the modular API/import/audit foundation are present on `main`. Utilization recovery (PR43–46), organization-profile and terminology editors (PR47/48), the read-only calendar inspector (PR49), import/audit acceptance evidence (PR50), commercial drafting (PR51), governed activation/project lifecycle (PR52), scoped customer profiles (PR53), governed commercial amendments (PR54), assignment/work-date convergence (PR55), effective-dated capture policy (PR56), daily/weekly capture with optimistic saves (PR57), optional work-entry evidence links (PR58), descriptive task/ticket/milestone references (PR59), buyer-configurable required evidence (PR60), identical-entry advisories (PR61), retained submission-history inspection (PR62), named Employee/approver acceptance evidence (PR63), explicit overtime capture policy (PR64), submission deadlines/grace (PR65), source-linked capture protection (PR66), workforce capabilities (PR67), and demand/assignment-reference planning (PR68) are merged. Commercial capabilities include seven engagement models, immutable terms, exact-version activation, governed projects, Active/On Hold history, effective-dated customer profiles and explicit per-entity term adoption; they grant no billing or approval authority. That historical checkpoint was `b4beea218d5bd46c0396f5149dd05531420523ac`. Exact-head checks and independent reviews passed; PR67 main checks passed all 60 application and 5 secret-scan steps; PR68 main checks passed all 62 application and 5 secret-scan steps. Source bootstrap entered the repository through PR16.

Effective worker capacity and approved-absence deductions (PR69) and immutable percentage-assignment versions (PR70) have since merged. That integration checkpoint was `0709097bcf72f0be8c03654398f64f719a10bc8e`. PR69 passed exact-head and main CI; PR70 passed independent corrected-head review and all 66 application and 5 secret-scan steps before merge. Its main verification also passed all 71 steps. Assignment history now follows manual, CSV, soft-end and direct SQL changes; new work submissions retain matching version pins. Capacity hours and assignment percentages remain separate quantities.

Own-worker period planning (PR71) connects canonical employee identity, effective capacity, original-unit assignments and retained history. Subsequent security corrections enforce current selected-role authority (PR162), protected identity administration and durable unlink (PR163), verified database TLS (PR164), and setup read permissions, worker privacy and safe asynchronous failures (PR165). Their exact-head and post-merge hosted checks passed; PR165's accepted main is `0489b181b0f5c3fc3e4825a662cecbf3987b98d8` with 77 steps passed in each run.

Bounded authentication throttling and explicit trusted-proxy configuration (PR166) are merged at `06516367ec9f452032b3d1a65658a22011448147`; independent review and all 77 exact-head and post-merge hosted steps passed. Throttling and audit use the same trusted client address. Counters remain process-local, so persistent production throttling remains open. This revision adds [durable session logout](docs/tasks/WOS-04-DURABLE-SESSION-REVOCATION.md), covering copied credentials across refresh, role changes and API restarts. Its rollout requires existing users to sign in again; exact final acceptance is recorded with the work package. See the [security evidence ledger](docs/05-delivery/SECURITY_ACCEPTANCE_LEDGER.md) for accepted revisions, limitations and remaining priorities.

Substantial operational, commercial and security work remains in dependent Draft pull requests. Passing checks on those branches do not mean the changes are merged or that v1 is production-ready. Later packages still require integration validation, independent exact-head review and fresh hosted acceptance. The governed project-contribution report and retained export in Draft PR146 passed current-head hosted checks; prerequisite integration and recorded bootstrap-scan debt remain open.

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
