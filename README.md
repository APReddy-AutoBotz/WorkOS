# WorkOS

WorkOS is a buyer-owned professional-services operations platform that connects resource planning, approved work, effective capacity and commercial control. Its direction is an enterprise utilization product where every percentage has an explicit period, denominator, inclusion rule and authorized source.

> **Naming note:** WorkOS is the temporary product working name. Runtime branding and buyer terminology must remain configuration-driven.

## Current programme state

Commercial drafting supports effective-dated billing-rate candidates for contracts and engagements. The workforce directory supports confidential cost-rate candidates for scoped workers. Preview a date, currency and unit to see the highest-priority match, a tie or a missing rate. Each capability requires an explicit permission grant. An authorized administrator can assign an owner to a candidate version. Approval and explicit adoption establish the rate source. For time-and-materials engagements, authorized users can retain a valuation snapshot and independently review billing eligibility. Eligibility does not issue an invoice. Authorized preparers can reserve approved-unbilled items in a named invoice-ready draft and inspect its native-currency total. Cancellation releases its reservations and preserves the original membership history. A preparer can submit a batch to configured reviewers. Review pins the line versions and total, and each decision records the acting reviewer and stage. Reviewers can inspect and queue up to 20 invoices, choose a decision and reason for each, and check each receipt separately. Authorized operators can export an approved batch to CSV and verify the retained bytes, checksum and native-currency total. Configured notices report acceptance or generation failure, with recovery available for incomplete notification evidence. A separately authorized user can confirm downstream billing against that exact export. The confirmation retains the external reference, actor, timestamp, currency and total, and keeps the billed lines reserved. Finance users can reconcile visible T&M items, reservations and invoice states by engagement and native currency.

The workforce directory shows workers and reporting relationships within the signed-in role and legal entity. Use it to select a worker before opening their capacity or capability view.

If a commercial draft save has an uncertain outcome, reload the workspace and inspect the server records before creating another draft. If that read fails, use **Retry workspace**.

Buyers can require approval for changes to selected assignment fields. A pending proposal keeps the current allocation in effect. Final approval rechecks the assignment version and overlap rules before applying the change. [Material assignment approvals](docs/tasks/WOS-05-MATERIAL-ASSIGNMENT-APPROVALS.md)

Authorized operators can evaluate weekly submission deadlines and issue in-app notices to the affected worker and configured overdue contact. A submitted timesheet suppresses the missing-submission notice. [Weekly deadline notices](docs/tasks/WOS-04-DEADLINE-INAPP-NOTICES.md)

Work approvals can route a submitted timesheet through configured reviewers. Each stage checks the reviewer’s current role and worker relationship before issuing its inbox notice. Only final approval changes the work to Approved. [Staged work approvals](docs/tasks/WOS-05-STAGED-WORK-APPROVALS.md)

Planners can review assigned percentages at one-, two- and three-month checkpoints, inspect the underlying assignments and retain a dated forecast export. Capacity hours appear separately. [Forecast scope](docs/tasks/WOS-04-NATIVE-PERCENTAGE-FORECAST.md)

Full-day leave requests use the worker’s effective schedule and calendar once adopted. Each request retains the dates counted, so approvals, leave balances and utilization can use the same evidence. [Calendar leave intake](docs/tasks/WOS-04-CALENDAR-LEAVE-INTAKE.md)

Actual Utilization reconciles approved hours against eligible capacity for a selected worker and period. The report shows excluded hours, unresolved classifications and the sources behind its percentage. [Actual work reconciliation](docs/tasks/WOS-04-ACTUAL-WORK-RECONCILIATION.md)

Buyers can adopt effective-dated work categories for project, descriptive client and non-client work. Capture and CSV imports retain the selected catalog version with the submitted entry. [Work category specification](docs/tasks/WOS-04-WORK-CATEGORY-CONTEXT.md)

Allocation Control supports buyer-selected warning and blocking thresholds for overlapping active assignments. Thresholds use the declared assignment percentages and become effective on the adopted date. [Assignment overlap policy](docs/tasks/WOS-04-ASSIGNMENT-OVERLAP-POLICY.md)

Production Compose accepts `API_SESSION_TTL_HOURS` in hours, including fractions. The default is eight hours. Invalid durations prevent API startup. [Operations runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#configuring-session-lifetime)

The merged PostgreSQL session and browser journeys verify current-session logout and absolute expiry. Auditing changes to session lifetime remains open under WOS-IAM-008. [Session acceptance evidence](docs/05-delivery/SECURITY_ACCEPTANCE_LEDGER.md#session-evidence-on-main-november-18-2026)

Run `npm ci` to install the locked frontend tools. For development, `npm run dev` starts a Node server on port 3000 and a Bun compiler on loopback. Bun is included in the development dependencies. For production assets, run `npm run build` (esbuild and Tailwind PostCSS), then `npm run preview` to serve the build on localhost port 4173. Both servers forward `/api` to the local API port (`API_PORT`, then `PORT`, default 4000). Use `npm run preview -- --help` for preview listener options.

Application source, organization/setup foundations, CI/migration/production-profile infrastructure and the modular API/import/audit foundation are present on `main`. Utilization recovery (PR43–46), organization-profile and terminology editors (PR47/48), the read-only calendar inspector (PR49), import/audit acceptance evidence (PR50), commercial drafting (PR51), governed activation/project lifecycle (PR52), scoped customer profiles (PR53), governed commercial amendments (PR54), assignment/work-date convergence (PR55), effective-dated capture policy (PR56), daily/weekly capture with optimistic saves (PR57), optional work-entry evidence links (PR58), descriptive task/ticket/milestone references (PR59), buyer-configurable required evidence (PR60), identical-entry advisories (PR61), retained submission-history inspection (PR62), named Employee/approver acceptance evidence (PR63), explicit overtime capture policy (PR64), submission deadlines/grace (PR65), source-linked capture protection (PR66), workforce capabilities (PR67), and demand/assignment-reference planning (PR68) are merged. Commercial capabilities include seven engagement models, immutable terms, exact-version activation, governed projects, Active/On Hold history, effective-dated customer profiles and explicit per-entity term adoption; they grant no billing or approval authority. That historical checkpoint was `b4beea218d5bd46c0396f5149dd05531420523ac`. Exact-head checks and independent reviews passed; PR67 main checks passed all 60 application and 5 secret-scan steps; PR68 main checks passed all 62 application and 5 secret-scan steps. Source bootstrap entered the repository through PR16.

Effective worker capacity and approved-absence deductions (PR69) and immutable percentage-assignment versions (PR70) have since merged. That integration checkpoint was `0709097bcf72f0be8c03654398f64f719a10bc8e`. PR69 passed exact-head and main CI; PR70 passed independent corrected-head review and all 66 application and 5 secret-scan steps before merge. Its main verification also passed all 71 steps. Assignment history now follows manual, CSV, soft-end and direct SQL changes; new work submissions retain matching version pins. Capacity hours and assignment percentages remain separate quantities.

Own-worker period planning (PR71) connects canonical employee identity, effective capacity, original-unit assignments and retained history. Subsequent security corrections enforce current selected-role authority (PR162), protected identity administration and durable unlink (PR163), verified database TLS (PR164), and setup read permissions, worker privacy and safe asynchronous failures (PR165). Their exact-head and post-merge hosted checks passed; PR165's accepted main is `0489b181b0f5c3fc3e4825a662cecbf3987b98d8` with 77 steps passed in each run.

Bounded authentication throttling and explicit proxy trust (PR166), followed by durable session revocation (PR167), are merged and passed exact-head and post-merge checks. PR167 is accepted at `b1822ca9f9683c5eeaf40db6db1d6450ca214fb6`, with all 79 steps passing in each run. Session rollout requires fresh sign-in. [PR168](https://github.com/APReddy-AutoBotz/WorkOS/pull/168) is now merged at `0d65ab6313d4a26bcc2d14702f7ce6d6e7ab88eb`, with all 82 exact-head and post-merge steps passing. It enforces independent leave decisions, qualified delegated scope, the Teams source boundary and canonical current workforce identity. [PR169](https://github.com/APReddy-AutoBotz/WorkOS/pull/169) adds consistent operational CSV literal-text encoding and is accepted at `88262c87a260529c00a680b22d2f021ff7d8cba4`, with all 83 exact-head and main checks passing. This revision follows with [scoped notification diagnostics](docs/tasks/WOS-05-NOTIFICATION-DIAGNOSTIC-BOUNDARY.md), restricting delivery history to current recipient scope and removing raw provider diagnostic payloads from operational readers. [PR170](https://github.com/APReddy-AutoBotz/WorkOS/pull/170) uses the audited frontend toolchain for its real browser journey. The [security evidence ledger](docs/05-delivery/SECURITY_ACCEPTANCE_LEDGER.md) retains remaining commercial, delegation, persistent-throttling and release work.

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

## Shared login throttling

Migration `057c_wos04_shared_auth_throttle` stores expiring login counters in the buyer database. API replicas share the per-IP and per-input limits, including the Entra callback limit. Apply migrations before switching traffic, drain old API processes, and configure identical limits and trusted proxy settings on all replicas. Counters start empty on first upgrade. Storage failure returns HTTP 503 before authentication. Reverting to the previous application restores process-local counters and its readiness check rejects the newer migration ledger. Prefer forward correction and retain the migration.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [AGENTS.md](AGENTS.md) before proposing changes. No implementation may be pushed directly to `main`. Merge in dependency order after exact-head review and applicable checks; verify the resulting main-branch checks and update status afterward.

Legacy approval and delegation checks enforce current delegator authority and retain ownership on edits. The browser journey verifies that operators see a refusal when a save is denied. [Approval scope and acceptance](docs/tasks/WOS-05-LEGACY-APPROVAL-SCOPE.md)

Settings show a saved confirmation only after the API acknowledges the change. Operators can retry a failed load and reconcile an uncertain save. [Settings recovery](docs/tasks/WOS-02-SETTINGS-SAVE-OUTCOMES.md)
