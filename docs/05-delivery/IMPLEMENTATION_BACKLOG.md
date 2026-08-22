# WorkOS Implementation Backlog

**Status:** Controller baseline  
**Delivery model:** Outcome-based work packages implemented through Draft pull requests  
**Default merge method:** Squash  
**Target:** WorkOS v1.0

## 1. Backlog control rules

- Work packages are executed in dependency order unless the controller records a safe parallelization decision.
- One work package may span more than one pull request only when the split reduces review or migration risk.
- Schema, authentication, authorization and financial-engine changes are serialized unless an explicit non-overlap assessment exists.
- A work package earns its programme weight only when code, tests, documentation, migration evidence and acceptance evidence are merged.
- Codex task completion, commit count and lines changed are not progress measures.
- No feature implementation begins until the governing blueprint PR is accepted.

## 2. Programme map

| Workstream | Weight | Target release | Primary outcome |
|---|---:|---|---|
| WOS-00 | 8% | v0.1.0 | Governing blueprint and source-control baseline |
| WOS-01 | 10% | v0.2.0 | Clean commercial source and neutral configurable brand |
| WOS-02 | 10% | v0.4.0 | Organization, legal entity, terminology and guided setup |
| WOS-03 | 10% | v0.4.0 | Modular architecture, API boundaries, CI/CD and migration harness |
| WOS-04 | 16% | v0.5.0 | Engagement models and flexible work capture |
| WOS-05 | 8% | v0.5.0 | Policy engine, approvals, delegation and period locking |
| WOS-06 | 20% | v0.7.0 | Rates, costs, budgets, revenue, margin and invoice readiness |
| WOS-07 | 6% | v0.8.0 | Reporting, leakage controls and integration framework |
| WOS-08 | 8% | v0.9.0 | Enterprise security, observability, recovery and deployment |
| WOS-09 | 4% | v1.0.0 | Production-like acceptance and buyer handover |

### 2.1 NFR implementation ownership

| NFR family | Accountable planned PRs | Minimum evidence |
|---|---|---|
| SEC-001–014 | PR-003, PR-005, PR-006, PR-009, PR-010, PR-012, PR-013, PR-014, PR-016 | Threat boundaries, secure defaults, negative authorization, secret/dependency and security-review evidence |
| PRV-001–006 | PR-004, PR-008, PR-010, PR-012, PR-013, PR-014, PR-016 | Data minimization, field-level scope, retention/anonymization and privacy export evidence |
| REL-001–009 | PR-005, PR-006, PR-008, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Fail-closed, transaction/idempotency, recovery and exact-head reliability evidence |
| PERF-001–008 | PR-006, PR-008, PR-011, PR-012, PR-013, PR-015, PR-016 | Pagination/query review, bounded jobs/exports and Standard-profile performance evidence |
| DAT-001–008 | PR-004, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012, PR-013, PR-016 | Ownership, temporal, precision, snapshot, constraint and control-total evidence |
| MNT-001–008 | PR-002 through PR-016 | Bounded modules/files, typed contracts, documentation and maintainability evidence in every affected PR |
| DPL-001–007 | PR-003, PR-005, PR-015, PR-016 | Portable container/environment, explicit migration and production deployment evidence |
| OBS-001–006 | PR-005, PR-006, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Correlation, safe structured logs, job/integration health and alert evidence |
| UX-001–006 | PR-003, PR-004, PR-008, PR-009, PR-012, PR-013, PR-016 | Accessibility, responsive role journeys, terminology/locale and understandable errors |
| CMP-001–004 | PR-003, PR-004, PR-006, PR-008, PR-013, PR-014, PR-016 | Supported browser/API/version compatibility and provider-neutral contracts |
| RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, immutable-artifact and release-evidence controls |

### 2.2 CORE implementation ownership

| CORE requirement | Accountable planned PRs | Minimum evidence |
|---|---|---|
| WOS-CORE-001, WOS-CORE-006–007 | PR-003 | Configuration-driven brand/terminology, production/demo separation and prohibited-term scans |
| WOS-CORE-002 | PR-004 | Organization/legal-entity ownership, setup and cross-scope evidence |
| WOS-CORE-003 | PR-006 | Modular-monolith boundaries, versioned API and compatibility evidence |
| WOS-CORE-004 | PR-004, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012 | Effective-date overlap, historical-version resolution, immutable-history and controlled-correction evidence across workforce, engagement, policy and commercial domains |
| WOS-CORE-005 | PR-006, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012, PR-013, PR-014 | Common mutation/audit contract and module-specific actor, active-role, source, entity, reason and material before/after evidence |
| WOS-CORE-008 | PR-010, PR-011, PR-012, PR-013 | Decimal-safe rate/amount behavior, deterministic vectors, immutable snapshots/batches and report/control-total reconciliation |

## 3. Planned pull-request sequence

### PR-001 — WOS-00 Governing blueprint

**Branch:** `controller/wos-00-blueprint`  
**Outcome:** Establish the authoritative charter, requirements, architecture, quality gates, provenance, execution playbook, backlog, risk and traceability system.

**Includes:**

- Root `AGENTS.md`.
- Programme charter.
- Product requirements.
- Architecture overview and initial ADRs.
- Non-functional requirements.
- Backlog, controller process, risk register, status and traceability templates.
- README and repository-governance baseline.

**Acceptance:**

- Documents use consistent requirement/work-package IDs.
- No product implementation or reference source import.
- Codex performs an independent consistency review.
- Controller resolves material review findings.
- Owner Gate B approval is recorded before product implementation.

### PR-002 — WOS-01 Authorized source bootstrap

**Branch:** `codex/wos-01-authorized-source-bootstrap`  
**Outcome:** Import a clean source snapshot from the pinned reference commit and restore its build/test baseline in WorkOS without importing Git history.

**Includes:**

- Copy approved application source from `f2de1d85126f5d64f0e2e21b085b0303ca1d8417`.
- Exclude `.git`, leadership/demo presentations, screenshots, generated presentations and company-only artifacts.
- Add `PROVENANCE.md`, import manifest and checksum/evidence.
- Rename package/service internals only where necessary to build safely.
- Establish a forbidden-file/secret scan.

**Requirements:** WOS-CORE-007, WOS-GOV-005, WOS-OPS-007, WOS-OPS-009.

**Mandatory evidence:**

- Exact source commit verified.
- Imported-file allow/exclude manifest.
- `npm ci`, type/lint, build and existing regression suite results.
- No write or pull request against the pinned reference repository.

**Merge boundary:** PR-002 may not merge to `main` while prohibited company-specific runtime branding, data or operational references remain. The imported runtime must be neutralized inside PR-002, or PR-003 must remain stacked on PR-002 and only the combined clean, configuration-driven state may merge.

### PR-003 — WOS-01 Neutral branding and product configuration foundation

**Branch:** `codex/wos-01-neutral-branding-config`  
**Outcome:** Remove runtime company-specific identity and make product/organization branding centrally configurable.

**Includes:**

- Product configuration service/provider.
- Product name, organization name, logos, favicon, accent tokens, support contact and email/report display configuration.
- Neutral WorkOS seed and notification copy.
- Replace old asset names, cookie prefixes, password prefixes and service names.
- Forbidden-term CI guard.
- Demo/production copy separation.

**Requirements:** WOS-CORE-001, WOS-CORE-006, WOS-CORE-007, WOS-ORG-001, WOS-ORG-005, WOS-ORG-006, WOS-OPS-009.

**Mandatory evidence:**

- Repository and built-artifact scan for prohibited terms.
- Browser evidence for login, navigation and notification branding.
- Production build contains no company logo/domain.

### PR-004 — WOS-02 Organization and setup foundation

**Branch:** `codex/wos-02-organization-setup`  
**Outcome:** Introduce organization/legal-entity ownership, configurable hierarchy/catalogs and guided setup status.

**Includes:**

- Organization and legal-entity schema.
- Business units, cost centres, practices, locations and configurable regions.
- Default-organization migration for imported data.
- Organization-scoped identifiers and access context.
- Working calendar and period configuration foundations.
- Guided setup/readiness page and API.
- Worker-master ownership fields, configurable worker types and dependency-aware worker lifecycle controls.

**Requirements:** WOS-ORG-001 through WOS-ORG-010, WOS-CORE-002, WOS-CORE-004, WOS-IAM-005, WOS-WKF-001, WOS-WKF-002, WOS-WKF-006.

**Mandatory evidence:**

- Fresh install and upgrade from PR-003.
- Existing records assigned to a default organization without loss.
- Out-of-scope organization attempts denied.
- Guided setup states are server derived.
- Imported workers retain identity and relationships; worker-type and lifecycle dependency tests cover active assignments, approvals, work and ownership.
- Effective-dated organization, worker and calendar history resolves to the correct prior version after later changes.

### PR-005 — WOS-03 CI/CD, migration harness and production profiles

**Branch:** `codex/wos-03-ci-migration-platform`  
**Outcome:** Establish repeatable engineering and release gates before deeper product expansion.

**Includes:**

- GitHub Actions for locked install, type/lint, build, tests, migration tests, secret scan and dependency scan.
- Production Dockerfile and local production-like Compose profile.
- Environment schema validation.
- Explicit migration command and migration ledger checks.
- Liveness/readiness and build metadata.

**Requirements:** WOS-OPS-001 through WOS-OPS-009; applicable WOS-NFR-DPL and WOS-NFR-RELSE requirements.

**Mandatory evidence:**

- Green clean-run CI.
- Fresh database install and upgrade from previous head.
- Production mode fails closed on unsafe config.
- Container health verification.

### PR-006 — WOS-03 Modular extraction and versioned API foundation

**Branch:** `codex/wos-03-modular-api-foundation`  
**Outcome:** Create enforceable module/API seams without a big-bang rewrite.

**Includes:**

- Module directories and shared domain/application conventions.
- Extract identity/access, organization/configuration and audit/platform seams from large shared files.
- `/api/v1` foundation and error contract.
- Request correlation and operation IDs.
- Common production-mutation/audit contract.
- Compatibility adapters for unchanged UI flows.

**Requirements:** WOS-CORE-003, WOS-CORE-005, WOS-GOV-001 through WOS-GOV-004, WOS-NFR-MNT-001 through WOS-NFR-MNT-008.

**Mandatory evidence:**

- Existing high-risk user journeys remain green.
- API contract tests for v1 foundation.
- No authorization regression.
- Measurable reduction or bounded-growth rule for central files.
- Common mutation evidence captures actor, active role, source, entity, action, reason and material before/after values without sensitive-data leakage.

### PR-007 — WOS-04 Contracts, engagement models and project hierarchy

**Branch:** `codex/wos-04-engagement-models`  
**Outcome:** Expand the domain from company-specific projects to reusable client, contract, engagement and workstream models.

**Includes:**

- Client hierarchy and billing entities.
- Contracts/SOWs and purchase-order foundation.
- Engagement types: T&M, fixed fee, milestone, retainer, managed service, internal and pre-sales.
- Project/workstream relationship and lifecycle guardrails.
- Migration of current clients/projects into default engagement records.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-CLI-001, WOS-CLI-002, WOS-CTR-001 through WOS-CTR-003, WOS-ENG-001 through WOS-ENG-005.

**Mandatory evidence:**

- Fresh/upgrade migration tests.
- Engagement-specific validation tests.
- Dependency-safe closure tests.
- Scoped browser journeys for admin, manager and operational roles.
- Contract/engagement/project effective versions and all production mutations preserve historical and audit evidence.

### PR-008 — WOS-04 Flexible work capture and assignment validation

**Branch:** `codex/wos-04-flexible-work-capture`  
**Outcome:** Support different buyer timesheet/worklog models while retaining governed utilization evidence.

**Includes:**

- Configurable daily and weekly entry modes.
- Work categories and billability policy.
- Task/ticket/milestone reference fields and source identifiers.
- Entry increments, limits, evidence/comment requirements and deadlines.
- Assignment/contract/period validation.
- Correction/reopen history and duplicate protection.
- Compatibility migration for current timesheets.
- Effective capacity profiles, skills/certifications, single-count leave/holiday availability, workforce self-service and scoped directory/hierarchy views.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-TIM-001 through WOS-TIM-012, WOS-RES-001 through WOS-RES-009, WOS-WKF-003 through WOS-WKF-005, WOS-WKF-007, WOS-WKF-008.

**Mandatory evidence:**

- Positive and negative policy tests.
- Work outside assignment/contract/period blocked or routed as configured.
- Daily and weekly browser journeys.
- Historical imported timesheets remain readable.
- Capacity/skills/availability calculations, leave single-count rules, worker self-service and cross-scope workforce views have positive and negative API/browser evidence.
- Assignment/capacity/work corrections create versioned history and complete mutation audit rather than rewriting accepted evidence.

### PR-009 — WOS-05 Approval and policy engine

**Branch:** `codex/wos-05-approval-policy-engine`  
**Outcome:** Make approval routing, delegation, escalation and period locking configurable and reusable across domains.

**Includes:**

- Approval-policy/routing schema.
- Single- and multi-stage approvals.
- Delegation scope restrictions.
- SLA, reminders and escalation records.
- Period lock/reopen controls.
- Bulk decision safety.
- Integration with timesheets, leave and assignment changes.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-APR-001 through WOS-APR-008, WOS-ORG-009.

**Mandatory evidence:**

- Approval state-machine tests.
- Delegation cannot broaden data scope.
- Locked periods reject all write paths including imports.
- Multi-role browser and API evidence.
- Effective-dated policies resolve historically and every decision, delegation, escalation, reassignment and reopen transition is traceably audited.

### PR-010 — WOS-06 Rate cards, cost rates and commercial terms

**Branch:** `codex/wos-06-rates-costs-terms`  
**Outcome:** Introduce secure, effective-dated commercial master data and deterministic rate resolution.

**Includes:**

- Billing rate cards and precedence rules.
- Confidential cost rates and overhead components.
- Currency precision and exchange-rate input foundation.
- Effective-date overlap controls.
- Rate-resolution service and evidence.
- Commercial change audit and approval hooks.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-CORE-008, WOS-COM-001 through WOS-COM-005, WOS-COM-014, WOS-COM-015.

**Mandatory evidence:**

- Rate precedence/effective-date test vectors.
- Cost visibility negative tests.
- Decimal and rounding tests.
- Historical rate resolution remains stable after later edits.
- Commercial-term mutations retain authorized reason, approval reference and material before/after evidence.

### PR-011 — WOS-06 Commercial calculation and project margin engine

**Branch:** `codex/wos-06-commercial-engine`  
**Outcome:** Calculate reconciled billable value, cost, margin and explicitly configured operational earned-management revenue across supported engagement models.

**Includes:**

- Calculation engine/version.
- T&M billable value.
- Fixed-fee effort/cost consumption.
- Milestone eligibility/value.
- Retainer consumption/overage.
- Managed-service quantity foundation.
- Revenue/cost/margin snapshots.
- Effective-dated operational earned-management policy profiles that fail closed for non-T&M models until an authorized policy is selected; billing eligibility remains independent.
- Budget versus actual and estimate at completion.
- PO consumption and thresholds.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-CORE-008, WOS-COM-006 through WOS-COM-013.

**Mandatory evidence:**

- Golden financial test vectors for every engagement type, including policy-disabled and each enabled earned-management profile.
- Evidence that operational earned-management metrics are non-statutory and cannot run for non-T&M models without an authorized effective-dated policy.
- Reconciliation to source work/terms/rates.
- Currency and rounding edge cases.
- Snapshot immutability and controlled recalculation evidence.
- Calculation/recalculation/finalization jobs preserve operation ID, source versions, actor or system identity and audit evidence.
- Owner Gate C working-product review.

### PR-012 — WOS-06 Invoice readiness

**Branch:** `codex/wos-06-invoice-readiness`  
**Outcome:** Convert source-specific approved or contractually due commercial evidence into versioned billing-eligibility events, one-to-one approved-unbilled register items and controlled invoice-ready batches without becoming a statutory invoicing system.

**Includes:**

- Source-specific eligibility evaluation for approved T&M snapshots, accepted milestones, approved/due fixed-fee schedule versions, approved retainer base/period/overage events, approved managed-service period/unit events and approved adjustments.
- Versioned billing-eligibility-event aggregate retaining source type/version, organization/legal entity, approval or contractual-due evidence, eligible date, currency, amount, calculation/policy evidence, reversal/supersession and batch state.
- One-to-one versioned approved-unbilled-item register; the register item is the only batchable object.
- Invoice-ready batch and line model in which every line references exactly one approved-unbilled-item version and through it exactly one eligibility-event/source version.
- Direct raw-source/snapshot-to-line rejection at domain, API, import and compatibility boundaries.
- Adjustments, discounts, credits and write-offs through approved versioned source → event → register lineage.
- Evidence links and source → event → register → line → batch control totals.
- State machine and approval integration.
- Database constraints, locking and idempotency preventing repeated active/final inclusion.
- Versioned reversal/supersession and correction paths.
- Versioned CSV/API-ready export only from approved/finalized batch lines.

**Requirements:** WOS-CORE-004, WOS-CORE-005, WOS-CORE-008, WOS-INV-001 through WOS-INV-008.

**Mandatory evidence:**

- Fresh-install and supported-upgrade migration tests for event/register/line relationships and constraints.
- Direct-bypass negative tests for raw work, snapshots, milestones, schedules, retainer/managed-service events and adjustments.
- One source version to one current eligibility-event/register-item evidence, including idempotent retry behavior.
- Register-to-batch reconciliation by source/event/register version, organization/legal entity, approval/eligibility evidence, currency, eligible date and amount.
- Active/final inclusion uniqueness under concurrent requests across every eligible source type.
- Batch state/approval tests and locked-period enforcement.
- Authorized reversal/supersession/correction paths that preserve prior evidence and exclude stale/reversed items from new batches.
- API and browser proof that only approved-unbilled items can be selected for a line.
- Export traceability from approved/finalized batch line through register/event to source and audit.
- Finalized event/register/source versions and batch lines remain immutable; every transition and adjustment is traceably audited.

### PR-013 — WOS-07 Reporting, leakage control and adapter contracts

**Branch:** `codex/wos-07-reporting-leakage-integrations`  
**Outcome:** Deliver buyer-facing operational/commercial insight and stable extension interfaces.

**Includes:**

- Operational, utilization and commercial report projections.
- Revenue-leakage signal engine.
- Data-quality expansion.
- Report reconciliation/control totals.
- Controlled exports.
- Worklog import and finance-export adapter contracts.
- Integration health and idempotency patterns.

**Requirements:** WOS-CORE-005, WOS-CORE-008, WOS-RPT-001 through WOS-RPT-007, WOS-INT-001 through WOS-INT-006.

**Mandatory evidence:**

- Report totals reconcile to snapshots, eligibility events, approved-unbilled register items and batches.
- Leakage scenarios have deterministic fixtures.
- Out-of-scope report/export tests.
- Adapter mock contract tests.
- Finance exports reject incomplete event/register lineage and originate only from approved/finalized batch lines.
- Report/export operations are audited with actor, scope, filters, as-of/version and control totals.

### PR-014 — WOS-08 Identity, session and security hardening

**Branch:** `codex/wos-08-security-identity`  
**Outcome:** Establish enterprise-ready identity/session controls and close high-risk application-security gaps.

**Includes:**

- OIDC/Entra production path and local-account restrictions.
- Revocable sessions and account lifecycle enforcement.
- Persistent/distributed login throttling design suitable for deployment profile.
- CSRF/CORS/security-header posture.
- Permission/access-review export.
- Threat-model-driven fixes and security tests.

**Requirements:** WOS-CORE-005, WOS-IAM-001 through WOS-IAM-010 and applicable WOS-NFR-SEC requirements.

**Mandatory evidence:**

- Threat model.
- Negative authorization suite.
- Disabled user/session invalidation.
- Security headers and identity configuration evidence.
- No secrets in build/logs.
- Identity, session, role, permission and access-review mutations are traceably audited without exposing tokens or secrets.

### PR-015 — WOS-08 Observability, recovery and release operations

**Branch:** `codex/wos-08-operations-hardening`  
**Outcome:** Make WorkOS supportable and recoverable as a buyer-owned enterprise deployment.

**Includes:**

- Structured logs, metrics and job/integration failure signals.
- Backup and restore scripts/runbooks.
- Restore rehearsal automation/evidence.
- Alert/monitoring configuration guidance.
- Release metadata, changelog and migration/rollback notes.
- Performance test harness and Standard-profile baseline.

**Requirements:** WOS-OPS-004 through WOS-OPS-010 and applicable reliability/performance/observability NFRs.

**Mandatory evidence:**

- Production-like restore rehearsal.
- Health/monitoring evidence.
- Standard-profile performance report.
- Runbook consistency tests.

### PR-016 — WOS-09 v1 release acceptance and buyer handover

**Branch:** `controller/wos-09-v1-release-acceptance`  
**Outcome:** Produce an independently reviewed, production-like, sellable WorkOS v1 release package.

**Includes:**

- Full requirements traceability.
- Role/browser UAT across operational, commercial, finance and admin personas.
- Fresh install and supported upgrade evidence.
- Commercial reconciliation and invoice-readiness evidence.
- Security review and finding disposition.
- Backup/restore and monitoring evidence.
- Buyer handover checklist and release notes.
- Version/tag `v1.0.0` after owner approval.

**Requirements:** All accepted v1 requirements.

**Mandatory evidence:**

- Exact-head green acceptance matrix.
- No unresolved release-blocking findings.
- Owner Gate D approval.

## 4. Codex model policy

Where Codex exposes model selection:

- Use the strongest available **Sol** reasoning model for architecture, data migrations, authorization, security and financial calculation tasks.
- Use an appropriate Sol model for bounded implementation, tests and documentation consistency work.
- Do not reduce reasoning quality merely to shorten execution time for high-risk tasks.
- Independent review must use a fresh review pass and must not rely only on the implementing task's self-assessment.

Model selection does not replace bounded task specifications, automated tests or controller review.

## 5. Definition of ready for a work package

A package is ready when:

- Governing requirement IDs are identified.
- Dependencies are merged and stable.
- Scope and explicit exclusions are written.
- Migration and rollback expectations are known.
- Acceptance tests and evidence are defined.
- No unresolved owner decision blocks correct behavior.

## 6. Definition of done for a work package

A package is done only when:

- Code and schema are merged.
- Required tests and CI are green at the exact head.
- Positive and negative authorization evidence exists.
- Fresh/upgrade migration evidence exists where applicable.
- Browser evidence exists where applicable.
- Audit, operations and rollback behavior are documented.
- Requirements traceability and implementation status are updated.
- The controller has reviewed the actual diff and evidence.
- Any required owner gate is recorded.