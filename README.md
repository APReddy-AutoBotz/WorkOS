# WorkOS

WorkOS is a buyer-owned professional-services operations platform that connects resource planning, approved work, effective capacity and commercial control. Its direction is an enterprise utilization product where every percentage has an explicit period, denominator, inclusion rule and authorized source.

Managed-service reporting supports a read-only comparison of a retained monthly margin percentage with a user-entered threshold (WOS-RPT-004). Finance can also page through the latest visible engagement margins for a month, including engagements with no retained version. An unavailable percentage stays unavailable. If the next page fails to load, choose **Retry next engagements** to request that page again. Changing the month or threshold starts a new search. A buyer can adopt a standing managed-service margin threshold through a governed engagement amendment. After UTC month-end, a retained engagement margin below its approved closing threshold triggers an in-app alert for the engagement owner, scoped commercial manager and finance/billing owner. Finance can inspect delivery attempts and recover a pending notice. [Configure and troubleshoot margin notices](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#configure-managed-service-margin-notices)

The application build and runtime share an immutable Node image. CI and buyer Compose use the same pinned PostgreSQL image. CI retains the tested production image, its checksums and runtime package inventories for seven days. [Container verification and handover](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#verifying-the-tested-container)

If a fixed-fee installment export succeeds and its notification fails, open **Invoice notification recovery**. Select the engagement and batch, load the recovery targets, and record the reason for retrying the notice. Changing the engagement, batch or target clears the previous reason. Enter a reason for the selected target before submitting. Finance can retrieve the original invoice CSV throughout recovery.

Billing reconciliation exports use a single request ID across engagement and portfolio reports. If a retry reports that the export was already recorded, use the original request ID to check audit history. Uppercase and lowercase UUIDs identify the same request.

Microsoft Entra sign-in issues the session cookie after the identity link, login event and audit record commit together. If persistence fails, start a fresh sign-in after service recovers.

Switching roles records the previous and selected roles before the browser receives the new session. If the audit write fails, retry the switch once the audit database is available.

The compatibility forecast counts projects below 100% allocated using eligible workers and projects in term at the horizon end. Peak pressure requires positive workforce capacity. Utilization and resource planning reports honor a configured 0% threshold. With a 0% bench threshold, only workers with zero planned utilization count as bench.

When a buyer requires assignment creation approval, a future assignment enters the worker’s planned hours after the final approver accepts it. For example, a one-day 20% assignment adds 1.6 planned hours on a day with eight available hours.

Forecast checkpoints and roll-offs use the UTC source date returned by the report. The chart labels individual checkpoint dates and the audited CSV includes the source and horizon end dates.

The compatibility utilization report distinguishes approved zero billable hours from unapproved work or unavailable weekly capacity. Its global CSV uses the same inclusion rule. Weekly plan gaps require matching worker coverage. The missing-worker list uses the scoped eligible roster and all timesheets in the selected period. Weekly submission coverage counts each eligible worker once, independently of the review filter.

For verified delivery status, remaining launch work and buyer acceptance gates, see the [weighted programme checkpoint](docs/00-control/IMPLEMENTATION_STATUS.md#launch-acceptance-checkpoint).

> **Naming note:** WorkOS is the temporary product working name. Runtime branding and buyer terminology must remain configuration-driven.

Release CI restores a populated retainer invoice and its applied credit into a fresh database, verifies both signed amounts and receipts, and records recovery timings in the workflow summary. See the [recovery runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#backup-and-restore). An 082p backup can also be recovered when its source database is unavailable. The [recovery runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#backup-and-restore) includes the transactional restore command and verification steps.

Managed-service contracts support buyer-defined quantity dimensions. Commercial managers can set unit codes, display labels, and decimal precision for tickets, shifts, or another unit and inspect the terms on each contract version.

## Current programme state

Retainer contract versions can record service periods with included hours and a base fee in contract currency. Contract history shows approved billable and non-billable hours by service period for workers the viewer can access. Each entry follows its retained contract version. A buyer can waive excess-hour charges or select the adopted contract hourly rate at period end. Authorized users can preview the exact price and its approval source. A contract can also specify monetary rounding for its base fee and overage. The period preview shows both rounded components and their total. Authorized preparers can inspect the approved work behind each period and retain a versioned statement after its UTC end date. A separately authorized reviewer can approve or reject the latest statement after inspecting its saved evidence. The decision records the reviewer and reason. Authorized billing staff can register an approved service period against a covered engagement. Finance can reserve the whole registered charge in an invoice draft, inspect its statement and review, and release it by cancelling the draft. An engagement policy can route a retainer invoice draft through named independent reviewers who inspect its retained charges and control total. An approved retainer batch can be exported to a verified CSV that identifies its original register items, events, statements and reviews. Finance can record a downstream billing reference against that exact artifact and total in Invoice billing confirmation. From the verified CSV, finance can request a full-line reversal and submit the original line and billing reference for independent review. Once every reversal stage approves, finance can issue the full negative credit, reserve it in a correction batch, and export the separately approved credit with the original line ID and artifact checksum. Buyers can choose which approved hours consume capacity and whether unused hours expire or carry forward. Viewers with entity-wide worker scope can inspect the resulting contract balances and excess hours.

Milestone billing requests show the selected due date, amount and contract version. Changing milestones clears the previous acceptance references, review policy, owner and reason.

Finance can inspect a T&M snapshot’s billable amount, approved work entry, adopted billing rate and contract version before requesting billing review. Reviewers see the same retained evidence.

Milestone acceptance reviews can be cancelled at the stage a manager inspected. Finance can recover the cancellation receipt after a lost response.

Rate approval managers must reload a billing or cost rate review if a reviewer advances the stage before cancellation. Switching reviews clears the previous decision and reason.

T&M billing cancellations apply to the inspected review stage. If another reviewer advances it, finance must reopen the current stage before cancelling.

When adopted rates tie, finance can see the shared priority and two candidate version IDs in rate resolution and T&M valuation review.

Finance can reopen an adopted billing or cost rate to inspect its recorded reason, actor, role and approval references. Resolving a rate shows the selected version, binding, effective dates and priority.

Commercial drafting supports effective-dated billing-rate candidates for contracts and engagements. Select approved T&M work to see the valuation policy effective on its work date, then confirm that version before inspecting the adopted billing and cost rates. A buyer may set a maximum billable value per approved entry in engagement currency. The snapshot retains the full rate-times-hours amount, capped amount and full cost. A separate billing review uses the capped value. An authorized policy owner can also set an effective-dated non-chargeable phase. Approved work retains its hours, adopted rates and labor cost, with zero billable value and no billing eligibility. A subsequent policy restores charging prospectively. Finance can reconcile a retained period by currency, from value at adopted rates through ceiling reductions and non-chargeable work to final billable value. For contributing projects, finance can compare the whole-project commercial allocation referenced by the work with valued hours, billable value and labor cost for the retained period. Work approved under amended T&M terms can proceed through valuation and billing review when the project, engagement and contract evidence all identify the same applicable contract version. The retained valuation keeps each amendment ID. A separate commercial reviewer can release an in-force purchase order against the active contract version. Inspect release in the purchase order list shows the protected authorization reference. Open invoice reviews track the employee links of the requester, batch owner, preparer and every named reviewer. If a link changes, the requester can withdraw and resubmit for a fresh review. Restoring the old link still requires a fresh review. Commercial managers can capture dated installments on a fixed-fee contract version and inspect the schedule from its version history. PostgreSQL verifies that positive installment amounts in contract currency sum exactly to the version value. The schedule is planning evidence. Billing eligibility requires a separate decision. An independent reviewer with fixed-fee issuance access can select a due installment and its active billing engagement. Approval records one billing eligibility event and one approved-unbilled item for that installment across the contract. Inspect the installment register in contract version history to retrieve its receipt. In Invoice-ready draft batches, finance can reserve whole registered installments for one engagement and eligibility period, inspect their source evidence and release reservations by cancelling the draft. Finance can commit approved T&M and milestone invoice lines to a released purchase order in the same currency and contract version. Coverage uses the work date for T&M and the independent billing-eligibility date for accepted milestones. The order reserves the line amount until downstream billing confirmation moves it to gross consumed. The balance warns at the configured threshold and blocks an allocation above the available limit. In Invoice CSV export, reviewers with billing-rate access can inspect each T&M line to reconcile its amount to the retained hours, rate, ceiling and rounding. Billing review policy history lists each retained version, its effective date, change reason and ordered reviewers. Use Load older billing policies to review earlier versions. The workforce directory supports confidential cost-rate candidates for scoped workers. Preview a date, currency and unit to see the highest-priority match, a tie or a missing rate. Each capability requires an explicit permission grant. An authorized administrator can assign an owner to a candidate version. Billing and cost reviews use the candidate policy effective today in UTC, including when newer versions are scheduled. Approval and explicit adoption establish the rate source. For time-and-materials engagements, authorized users can retain a valuation snapshot and independently review billing eligibility. The calculation receipt shows approved hours, exact products, rounding policy and gross margin. A financial period lock prevents new T&M valuations for covered work dates while preserving historical receipts. Governance administrators can inspect, financially lock or permanently close a reporting period. Both close actions require the inspected revision and an audited reason. Reopening for financial valuation requires an explicit grant and an audited reason. Final T&M and milestone billing approvals check the reporting periods covering the UTC eligibility date before adding an approved-unbilled item. Finance can select an inclusive work-date range to see hours, billable value, cost and gross-margin percentage for visible T&M snapshots in each currency. Finance can retain the inspected period and reopen any numbered version after later valuations arrive. Open a retained version to page through its contributing entries and inspect the original billing and cost rate receipts. Inspect a retained T&M snapshot to see the original billing and cost rates, their effective periods, scope and selection priority. Finance can load older approved work and policy versions when valuing an engagement. Billing review uses the policy effective today in UTC, even when finance has scheduled newer versions. Eligibility does not issue an invoice. Authorized preparers can reserve approved-unbilled items in a named invoice-ready draft and inspect its native-currency total. Before cancelling a reviewed batch, inspect its current stage. A later decision requires a fresh inspection. Milestone reviews, milestones and approved-unbilled items can be loaded beyond the first 50 records. Finance can inspect each retained line’s supporting work approval and adopted billing rate, or open its recorded milestone acceptance references. Cancellation releases its reservations and preserves the original membership history. A preparer can submit a batch to the reviewers configured by the policy effective today in UTC, even when later versions are scheduled. Review pins the line versions and total, and each decision records the acting reviewer and stage. Reviewers can inspect and queue up to 20 invoices, choose a decision and reason for each, and check each receipt separately. Authorized operators can export an approved batch to CSV and verify the retained bytes, checksum and native-currency total. Configured notices report acceptance or generation failure, with recovery available for incomplete notification evidence. A separately authorized user can confirm downstream billing against that exact export. The confirmation retains the external reference, actor, timestamp, currency and total, and keeps the billed lines reserved. Finance users can reconcile visible T&M items, reservations and invoice states by engagement and native currency. Finance can reconcile visible T&M and milestone billing across engagements for an inclusive eligibility-date range. The portfolio report shows current register states and source, reservation, export and confirmation control totals by currency. Authorized finance users can download the inspected portfolio totals as a CSV with its filters and timestamp. The audit record includes the file checksum.

The workforce directory shows workers and reporting relationships within the signed-in role and legal entity. Search by the current buyer-defined worker type or select a worker to open their capacity or capability view. Workers without a current classification appear as unclassified. Entity administrators can retire locally owned catalog entries after dependency checks. Organization-wide entries remain available for shared use. With workforce management access, open a worker, load types for the effective date and record the assignment with a reason. Future assignments take effect on their UTC date. Earlier entries and the original profile are retained.

If a commercial draft save has an uncertain outcome, reload the workspace and inspect the server records before creating another draft. If that read fails, use **Retry workspace**.

Buyers can require approval for changes to selected assignment fields. A pending proposal keeps the current allocation in effect. Final approval rechecks the assignment version and overlap rules before applying the change. [Material assignment approvals](docs/tasks/WOS-05-MATERIAL-ASSIGNMENT-APPROVALS.md)

Authorized operators can evaluate weekly submission deadlines and issue in-app notices to the affected worker and configured overdue contact. A submitted timesheet suppresses the missing-submission notice. [Weekly deadline notices](docs/tasks/WOS-04-DEADLINE-INAPP-NOTICES.md)

A finance preparer can assess an empty T&M invoice draft and send an in-app notice to its recorded owner and preparer. When one person holds both roles, they receive one notice with both reasons. [Invoice action notices](docs/tasks/WOS-06-INVOICE-ACTION-REQUIRED.md)

Milestone engagements can record acceptance evidence and route it to named independent reviewers. Final approval adds one item in the milestone’s currency to the approved-unbilled register. The reconciliation report follows an accepted milestone through its invoice history and shows the totals at each step. Finance can reserve an accepted item, review the batch, export its milestone CSV and attest to downstream billing against the retained artifact. [Invoice workflow](docs/tasks/WOS-06-MILESTONE-INVOICING.md) · [Milestone billing eligibility](docs/tasks/WOS-06-MILESTONE-ELIGIBILITY.md)

Work approvals can route a submitted timesheet through configured reviewers. Each stage checks the reviewer’s current role and worker relationship before issuing its inbox notice. Only final approval changes the work to Approved. [Staged work approvals](docs/tasks/WOS-05-STAGED-WORK-APPROVALS.md)

Planners can review assigned percentages at one-, two- and three-month checkpoints, inspect the underlying assignments and retain a dated forecast export. Capacity hours appear separately. [Forecast scope](docs/tasks/WOS-04-NATIVE-PERCENTAGE-FORECAST.md)

Full-day leave requests use the worker’s effective schedule and calendar once adopted. Each request retains the dates counted, so approvals, leave balances and utilization can use the same evidence. [Calendar leave intake](docs/tasks/WOS-04-CALENDAR-LEAVE-INTAKE.md)

Actual Utilization reconciles approved hours against eligible capacity for a selected worker and period. The report shows excluded hours, unresolved classifications and the sources behind its percentage. [Actual work reconciliation](docs/tasks/WOS-04-ACTUAL-WORK-RECONCILIATION.md)

Buyers can adopt effective-dated work categories for project, descriptive client and non-client work. Capture and CSV imports retain the selected catalog version with the submitted entry. [Work category specification](docs/tasks/WOS-04-WORK-CATEGORY-CONTEXT.md)

Allocation Control supports buyer-selected warning and blocking thresholds for overlapping active assignments. Thresholds use the declared assignment percentages and become effective on the adopted date. [Assignment overlap policy](docs/tasks/WOS-04-ASSIGNMENT-OVERLAP-POLICY.md)

Production Compose accepts `API_SESSION_TTL_HOURS` in hours, including fractions. The default is eight hours. Production startup, readiness and sign-in require the configured duration to match the audited database value. On upgrade, a named database operator must record the current lifetime before starting the new API. [Operations runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#configuring-session-lifetime)

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

Buyer operations can run `npm run --silent ops:delivery-health` to check pending invoice alerts, their oldest age and recent delivery failures. [Delivery monitoring and database grants](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#delivery-monitoring)

Finance users can browse older billing and confidential worker-cost candidates in pages of 100 for the selected source. Each page checks current access.

Single and bulk decisions from the timesheet approval desk use the version displayed to the reviewer. If an employee resubmits before a decision arrives, reload and review the corrected work.

Team leads can open submitted timesheets and retained correction history for their current direct reports in the selected legal entity. Their personal timesheet history stays scoped to their own work.

Bulk timesheet approval previews the selected employees and weeks. After confirmation, the approval desk shows each timesheet’s refreshed status and whether its decision was acknowledged.

Timesheet approval closes the previous workspace when an operator switches organization scope. Reloading approvals fetches the current view. A decision already accepted by the server retains its original scope.

Timesheet Ops Export prepares large CSVs in batches, keeps the approval page responsive and cancels an in-progress download when the operator switches scope.

Production API replicas emit one JSON traffic summary per minute for monitoring request volume, failures and latency. See [API traffic monitoring](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#api-traffic-monitoring) for alert ownership and aggregation.

Run `npm run test:standard-profile` on a disposable loopback PostgreSQL instance to measure timesheet reads, draft saves, submissions, independent direct-manager approvals, two-stage approvals and utilization reports. Each measured wave issues 75 concurrent authenticated requests. The [performance runbook](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#standard-profile-api-performance) explains the dataset, thresholds and deployment evidence.

A designated database incident responder can revoke all application sessions for one account. The next sign-in starts a new generation. See the [account revocation procedure](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#revoking-all-sessions-for-an-account).

Run `npm run test:restore` with a disposable loopback PostgreSQL database and matching PostgreSQL client tools to exercise archive recovery, commercial data integrity and scoped API access. See the [backup and restore procedure](docs/05-delivery/RELEASE_AND_OPERATIONS_RUNBOOK.md#backup-and-restore).

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

The [commercial acceptance evidence](docs/00-control/REQUIREMENTS_TRACEABILITY.md#commercial-acceptance-evidence-for-independent-review) links the PostgreSQL and browser checks for invoice reservations, export and corrections.

### Verify invoice export lineage

T&M invoice CSV generation and download check that each line, register item, eligibility event and valuation snapshot occurs once in the batch. Milestone invoices also require a distinct accepted milestone per line. Milestone identifiers preserve their original casing.

### Request a full reversal of an exported line

In Invoice CSV export, inspect an exported or billed batch and retrieve its retained CSV. Finance preparers can select a line, check for an existing request and record the reason for a full reversal. Reopen the line to retrieve the receipt after an interrupted response. The request preserves the original export, control totals and occupancy. A policy administrator can explicitly enable named review stages for full-line reversals when recording an engagement policy. Check reversal reviewers on a recorded request to see the policy effective today in UTC. The check requires distinct reviewers with current access, independent of the requester and batch preparer. The original requester can submit the inspected request. WorkOS records the policy version and current downstream confirmation and delivers an action notice to the first named reviewer. Use Check reversal reviewers to recover the submission receipt. Reviewers can acknowledge the notice in their governed notifications inbox. Named reviewers can inspect the original line, amount, export checksum and current downstream confirmation in their inbox. Each stage records its decision and reason. Approval advances to the next named reviewer. Rejection ends the review and notifies the affected parties. The requester can retrieve the final outcome. After final approval, a finance preparer with the explicitly granted `commercial.reversal_eligibility.create` permission can inspect the original line and issue one approved-unbilled credit. The database uses the original currency and full line amount, checks the financial calendar for the UTC issue date, and retains the original export, final decision and credit receipt. In Invoice CSV export, select an engagement and choose **View issued credits** to find the signed amount, original batch and line, and register item. Finance preparers see credits only when they can view the entire original batch. Finance preparers with draft ownership permission can select up to 50 whole credits from the same original export, enter a reason, and reserve them in one correction draft. The register shows the occupying batch. Authorized preparers can cancel the draft to release every credit and retain its line history. Select **Inspect correction draft** to verify the owner, signed total, eligibility dates, original export checksum and versioned credit lines. A recorded owner access loss requires cancellation and a replacement draft before review. Under Invoice batch approvals, use **Find correction drafts** and inspect the signed total and credit lines before submitting. The effective engagement policy supplies the named stages. Each reviewer must be independent of the requester, owner and preparer and retain access to the original export. Final approval retains the credit reservations. Rejection returns the batch to Draft. In Invoice CSV export, use **Find credit exports** to accept or retrieve the approved correction CSV. Each signed credit line identifies its original artifact, checksum and line. Multiple approved partial credits can reference the same original charge. Each original eligibility event must identify the same original invoice line throughout the credit export. Select the original batch and choose **Check exported credits** to see which lines were credited. In Invoice billing confirmation, select the engagement and choose Find exported credits. A scoped confirmer inspects the retained artifact, checks its negative total and records the downstream credit reference. The receipt is a manual attestation. Recheck exported credits on the original invoice to see which credit lines have a downstream attestation. To suspend new attestations, revoke the confirmation permission and retain historical receipts and artifacts.

Managed-service engagements can record delivered quantities by service date and evidence reference against active contract and engagement terms. The service unit and decimal precision come from the adopted contract version.

Independent reviewers can accept or reject a delivered quantity from its engagement history. Each receipt shows the decision and reason. Acceptance alone creates no monetary entry.

Commercial managers can set a price per managed-service unit in contract currency. The version history shows the exact price, including explicit zero. A blank price leaves the unit unpriced.

Managed-service operators can retain an operational value for independently accepted units. A policy owner selects the effective date and rounding precision. Each valuation preserves the service-date policy, accepted quantity, versioned contract price and contract currency.

Managed-service contract versions can authorize billing by accepted unit and specify the charge precision. Billing operators inspect an independently accepted receipt and record its contractual charge in the approved-unbilled register. The receipt retains the eligibility event and register item.

Invoice preparers can reserve a whole approved managed-service charge in a draft for its engagement, currency and eligibility period. The line shows the accepted quantity and unit price and retains its review, event and register item. Cancelling the draft releases the item for another batch.

Managed-service invoice batches can follow an engagement-specific approval policy. Reviewers inspect each reserved charge, its accepted quantity and unit price. The decision retains the reviewed line set and total.

## Managed-service invoice export

In **Invoice CSV export**, select an approved service-unit batch, inspect its approval and control total, then accept and download the verified CSV. In **Invoice billing confirmation**, inspect the retained export and record the downstream invoice reference after matching the amount.

To correct an exported managed-service line, retrieve the original CSV, select the line and submit a full reversal under its engagement review policy. After independent approval, finance can issue a credit and track its separate draft, export and downstream confirmation.

## Managed-service fixed charges

In a managed-service contract or revision, choose **Add fixed-period charge** and enter the inclusive dates and exact amount in contract currency. Inspect the contract version to see its retained schedule. Each version keeps its original terms.

## Review a fixed-period service charge

Inspect a managed-service contract version and select a period under **Fixed-period charge review**. Reviewers with period decision access can approve or reject the closed charge with a reason. The receipt records the contract currency and amount.

## Value a managed-service period

Select the engagement in **Fixed-period operational valuation**. A policy owner can schedule the approved fixed-period profile and rounding precision. After independent period approval, finance can inspect the period-end policy and record the operational management value.

## Register an approved fixed-period charge

Inspect the decision on the contract version, select a billing engagement, and choose **Inspect billing eligibility**. Finance can register the whole contractual charge with a reason. The receipt identifies the approved-unbilled item, amount and UTC eligibility date.

## Prepare a fixed-period invoice draft

In **Invoice-ready draft batches**, choose the engagement option labelled **fixed-period charges**, enter an eligibility-date range and select the draft owner. Reserve a whole approved-unbilled charge and inspect its original period decision, dates and contract version. Cancelling the draft releases the item for another draft.

## Approve a fixed-period invoice batch

In **Invoice batch approvals**, select the engagement and inspect the draft. Submit its exact total and retained lines under the effective approval policy. Each named reviewer can inspect the contract version, period dates and original period decision before recording a decision.

## Export and confirm an approved fixed-period batch

Select the approved batch in **Invoice CSV export** and choose **Fixed-period CSV v1**. The downloaded CSV includes the period decision, original contract version, eligibility date and exact native-currency amount. After the downstream system accepts it, use **Invoice billing confirmation** to record its reference against the retained artifact.

## Correct a billed fixed-period charge

Inspect the retained export and select the original line. Request a full reversal with a reason. After the named reviewers approve it, finance can issue the negative amount, reserve it in a correction batch and submit that batch for approval. The credit export and downstream confirmation keep their own receipts and link back to the original charge.

## Record effort for delivered service units

In **Record delivered units**, enter **Your effort in hours (optional)** when the delivery has supporting time evidence. Enter actual hours for your own work on the service date, to four decimal places. The receipt and its review history retain the reported hours alongside the delivered quantity.

## Retain worker cost for accepted service effort

Open an accepted unit receipt and choose **Inspect effort cost**. Finance can retain a cost when one adopted hourly rate has the highest priority for that worker, service date and engagement currency. The snapshot shows the hours, rate, effective dates, priority and exact cost. Viewing and recording require separate permissions and access to that worker.

Choose **Compare approved effort** on a service receipt to compare recorded hours with approved timesheet entries. Use the same work reference on both records. Reviewers need worker visibility and utilization reporting access.

## Inspect a managed-service month

In Commercial drafting, select the managed-service engagement and a reporting month, then choose **Inspect month**. The report uses all contract versions for that engagement. Registered billable value includes unit and fixed-period charges and their issued credits. The cost figure shows retained worker cost. Gross margin appears once accepted effort, approved timesheets and cost snapshots reconcile. **Retain month** saves the inspected evidence and amounts. **Previous retained version** opens the earlier record.

The fixed-fee installment register shows whether the original schedule author and independent approver still resolve to the verified workers. An invoice preparer can reserve the charge while both identities are current. A historical charge stays visible if an identity can no longer be verified.

For fixed-fee batches, select the engagement under **Invoice batch approvals** and configure its named review stages. After reserving a due installment, submit the inspected batch for review. The reviewer sees each installment’s number, due date, contract version and amount. Final approval moves the batch to Approved. Rejection returns it to Draft and preserves its reservations.

After final approval of a fixed-fee batch, open **Invoice CSV export**, inspect its installments and total, and accept the fixed-fee CSV. Finance can download the verified artifact. Once the downstream system accepts it, use **Invoice billing confirmation** to record the reference against that exact file.

To correct an exported fixed-fee installment, inspect the original CSV line and request a full reversal. Independent reviewers approve the request before finance can issue the credit. Reserve the credit in a correction draft, obtain batch approval and confirm its export against the downstream credit reference.

In **Billing reconciliation**, select a fixed-fee engagement and choose **Load billing reconciliation**. For each currency, the report shows registered installments, credits and net amount in each billing state. A confirmed 12,000 charge and confirmed −12,000 credit therefore have a net confirmed balance of zero. Earned management value and costs are calculated separately.

In Commercial drafting, open a fixed-fee engagement, select **Effort month** and choose **Inspect approved effort**. The report shows approved billable and non-billable hours for workers you can see. Unresolved entries are counted separately so you can investigate missing or inconsistent approval evidence.

In a fixed-fee engagement’s approved-effort report, **Inspect worker costs** shows the hourly worker rate adopted for each verified entry’s work date. **Retain worker cost** saves the calculation and its source. Equally ranked rates, a currency mismatch or missing adoption leave the cost unavailable. The report labels partial subtotals and shows a verified monthly cost once all work in the viewer’s scope is verified and costed.

Choose **Check allocation risk** on a fixed-fee engagement to compare its effective contract allocation with retained labor costs through a work date. The report covers the whole engagement, so it requires entity-wide worker and cost visibility. It shows the remaining allocation and flags missing cost evidence. A negative balance means retained labor alone already exceeds the allocation.

When adopting new terms for a fixed-fee engagement in **Commercial amendments**, enter its approved **Labor-cost budget** in the engagement currency. Preview and confirm the amendment with its approval reference. **Check allocation risk** shows the effective labor budget, retained labor cost and remaining labor budget alongside the contract allocation. Existing engagements show an unset budget until one is approved.

Use **Budgeted hours** when amending a fixed-fee engagement to approve an effort budget. **Check allocation risk** compares the effective hours budget with verified billable and non-billable work through your chosen date. Unresolved approved time is counted separately.

To forecast fixed-fee completion, choose a work-through date in **Check allocation risk** and select **Inspect completion forecast**. Enter remaining delivery hours, remaining labor cost in engagement currency, and the assumptions behind them. Recording a version preserves the budgets, actuals and estimates reviewed that day. Incomplete hours or cost evidence leaves its respective completion estimate unavailable.

Finance users can also enter expected total revenue at completion in the engagement currency. Leave it blank when the outlook is unknown. Each saved version preserves the assumption independently of earned revenue and invoicing.

The fixed-fee forecast also shows expected revenue less projected labor cost for the selected version. Both inputs must be available. A zero revenue forecast still shows the projected labor loss, with no percentage.

Each fixed-fee forecast shows how far its estimated hours and labor cost are over or under the budgets retained at review. An exact match shows “On budget”. A missing budget or incomplete estimate makes only that comparison unavailable.

For fixed-fee operational earned-management valuation, an authorized amendment owner selects **Elapsed service days** and the rounding precision when approving engagement terms. In the engagement’s finance view, choose a service date and select **Inspect elapsed service day**. Finance users with the recording permission can retain the daily amount and its approval evidence. The default is disabled.

To reconcile fixed-fee elapsed-time values, select the final service day, enter the period start, and choose **Reconcile period**. Daily evidence shows the latest retained version and the currently approved amount. A total appears only when at least one day matches and all applicable days reconcile.

In the fixed-fee completion forecast, inspect a work-through date to see reconciled operational earned-management revenue for the engagement through that date. Remaining revenue is the selected forecast version’s expected total less that earned amount. A negative balance means earned value exceeds the forecast. Missing or stale daily evidence withholds the balance.

Grant **View fixed-fee margins** to finance users who need actual, remaining and forecast margin after labor cost. Actual margin uses reconciled revenue under the effective fixed-fee policy and complete labor costs through the review date. Remaining margin uses the selected forecast’s remaining revenue and labor cost when its reviewed evidence is current. Percentages require positive revenue.

For effort-based fixed-fee engagements, select **Approved delivery hours** and the currency precision in the engagement amendment. Set a positive hours budget. In **Inspect approved delivery progress**, finance users can see billable and non-billable verified hours and the cumulative earned-management amount. Recording a version requires the separate progress recording permission.

The fixed-fee forecast follows the approved effort profile on its work-through date. Retain a matching cumulative progress version for that exact date to compare earned and remaining revenue. The forecast shows the retained version and whether its evidence still matches.

### Fixed-fee policy changes

On the closing effort day, finance can preview a scheduled switch to elapsed time. The forecast shows the verified closing value, the remaining allocation, and the proposed first-day total. A finance user with transition approval permission can sign off the schedule with a reason. The forecast uses the approved cumulative amount while the closing evidence, policy and service remain valid.

### Fixed-fee financial locks

Before retaining a daily elapsed value or cumulative effort value, verify weekly coverage for its valuation date. Overlapping monthly and fiscal locks also apply. A transition approval checks its schedule from the switch date, including any future dates that finance has already locked. Retained versions remain readable.

### Sign a fixed-fee period statement

Choose the end date of a weekly, monthly or fiscal reporting period in the fixed-fee engagement. In **Inspect period statement**, finance can compare the verified opening and closing management balances and inspect their source records. A designated signer can enter a reason and sign once the reporting period is financially locked or closed. If the closing balance is lower, enter a separate reduction explanation before signing the negative movement. After an audited reopening and a new lock, a new signed version preserves the original.

### Approved fixed-fee expense budgets

In Commercial amendments, enter the expense budget in the engagement currency. Preview and apply the amendment with its approval reference. Check allocation risk on the applicable date to see the approved amount and effective date. An explicit zero is supported.

### Record an actual fixed-fee project cost

In the fixed-fee forecast, open **Non-labor project costs** for the incurred date. Select the project, enter the cost reference and amount in the engagement currency, and submit it. The selector lists projects whose approved terms cover the incurred date. A second finance user with decision permission can approve or reject the entry with a reason. Approved costs through the forecast date reduce actual gross margin. Buyers grant preparation and decision permissions separately. [Project cost acceptance](https://github.com/APReddy-AutoBotz/WorkOS/pull/382)

### Recover a finance-provider delivery

In the invoice export workspace, an authorized finance operator can reserve an approved batch for the configured provider. During an upgrade, existing batches remain readable before the provider delivery schema is installed. Provider receipt bodies must fit within 64 KiB. If delivery is unconfirmed, reopen that batch and retry the existing reservation. If the original provider is unavailable, restore its configuration before retrying. Verify the retained artifact and receipt before recording downstream billing confirmation. [Delivery and recovery evidence](https://github.com/APReddy-AutoBotz/WorkOS/pull/384)

### Project expense allocations

After the engagement has adopted an expense budget, select a fixed-fee project in Commercial amendments and allocate part of that budget. Check allocation risk shows how many in-term projects have budgets, the total allocated and the amount still available.

### Fixed-fee budget warnings

In Commercial amendments, set **Budget warning (% used)** to a whole percentage from 1 to 100. After approval, **Check allocation risk** shows whether verified delivery hours or retained labor costs have reached that share of their respective budgets. Clear the field in a later amendment to disable the warning. With the **Configure fixed-fee risk notices** permission, open **Review budget warning recipients** to version the commercial manager, finance or billing owner, and localized in-app title and body. The engagement supplies the third required recipient through its owner. Each named account must hold its selected role and have access to the engagement owner in the selected legal entity. WorkOS checks active warning terms in the background. Required recipients receive one in-app alert per metric and source approval, even if they have disabled optional notifications. If database validation fails after the receipts are written, the worker rolls them back and schedules a retry. Use **Check warning deliveries** to inspect recent attempts and **Load my governed notifications** to open an alert. The budget warning API identifies the approval that last changed the percentage or the corresponding budget separately for hours and cost.

### Review purchase-order risk

In the commercial workspace, use **Check purchase-order risks** to review released orders for the selected legal entity. Choose an inclusive expiry date. The register includes already expired orders, orders ending by that date, and orders whose committed plus gross consumed value reaches their configured warning threshold or exhausts their available value. The date controls the expiry window. Balances reflect current invoice commitments and confirmations. Each row retains its currency.

### Purchase-order alert assignments

Once a purchase order is released, open **Review alert assignments** and select the engagements that use it. A shared order can have several engagement owners. Finance can filter the risk register for missing assignments or unavailable owners before the first commitment.

In **Review purchase-order risk recipients**, an authorized administrator selects the commercial manager, finance/billing owner and buyer notice template. The governed inbox alerts the current recipients when the order expires, crosses its warning threshold or runs out of available value. **Check order alert deliveries** shows pending retries and evidence of delivery.

### Retainer capacity risks

In Commercial drafting, select **Check governed retainer versions** to find service periods with excess approved hours or unused hours that expired. The register identifies the contract number, exact version, dates and hours. It also flags missing capacity policies. Use **Check next retainer versions** to continue across the portfolio. Access requires entity-wide worker visibility and utilization reporting permission.

### Retainer alert ownership

In a retainer version’s history, open **Review alert assignments** and select the engagements whose current owners should receive capacity alerts. Finance can use **Show missing retainer assignments or owners** before anyone books time. A notice policy names the commercial manager and finance/billing owner and sets the buyer’s template. In **Check retainer alert deliveries**, finance can inspect attempts and recover missing assignments or grants.
