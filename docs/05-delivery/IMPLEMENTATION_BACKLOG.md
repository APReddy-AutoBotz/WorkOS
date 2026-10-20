# WorkOS Implementation Backlog

**Status:** Controller baseline  
**Delivery model:** Outcome-based work packages implemented through Draft pull requests  
**Default merge method:** Squash  
**Target:** WorkOS v1.0

## 1. Backlog control rules

- Work packages run in dependency order unless the controller records a safe non-overlap decision.
- Schema, identity, authorization, approval and commercial-engine changes are serialized by default.
- Every package includes applicable schema, server, UI, authorization, audit, tests, migration, operations and documentation evidence.
- Codex completion messages, commit count and changed-line count are not acceptance evidence.
- No feature implementation or source import begins before WOS-00 Gate B approval and merge.
- A package receives programme credit only after exact-head acceptance and merge.

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
| WOS-07 | 6% | v0.8.0 | Reporting, leakage controls, notifications and integrations |
| WOS-08 | 8% | v0.9.0 | Enterprise security, observability, recovery and deployment |
| WOS-09 | 4% | v1.0.0 | Production-like acceptance and buyer handover |

## 3. Cross-cutting implementation ownership

### 3.1 CORE ownership

| Requirement | Accountable planned PRs | Minimum evidence |
|---|---|---|
| WOS-CORE-001, 006–007 | PR-003 | Configurable branding/terminology, demo-production separation and forbidden-term evidence |
| WOS-CORE-002 | PR-004 | Organization/legal-entity ownership, setup and cross-scope denial |
| WOS-CORE-003 | PR-006 | Modular-monolith boundaries, versioned API and compatibility evidence |
| WOS-CORE-004 | PR-004, 007–012 | Effective-date, historical-version and controlled-correction evidence across affected domains |
| WOS-CORE-005 | PR-006 through PR-014 | Common mutation/audit contract and module-specific actor, role, source, entity, reason and before/after evidence |
| WOS-CORE-008 | PR-010 through PR-013 | Decimal-safe deterministic calculations, immutable evidence and control-total reconciliation |

### 3.2 NFR ownership

| Family | Accountable planned PRs | Minimum evidence |
|---|---|---|
| SEC-001–014 | PR-003, 005, 006, 009, 010, 012, 013, 014, 016 | Threat boundaries, secure defaults, negative authorization and scan evidence |
| PRV-001–006 | PR-004, 008, 010, 012, 013, 014, 016 | Data minimization, sensitive-field scope, retention/anonymization and export evidence |
| REL-001–009 | PR-005, 006, 008, 009, 011, 012, 013, 015, 016 | Fail-closed, transaction/idempotency, recovery and exact-head reliability evidence |
| PERF-001–008 | PR-006, 008, 011, 012, 013, 015, 016 | Query/index review, bounded jobs/exports and Standard-profile evidence |
| DAT-001–008 | PR-004, 007–013, 016 | Ownership, temporal integrity, precision, constraints, snapshots, lineage and reconciliation |
| MNT-001–008 | PR-002 through PR-016 | Bounded modules/files, typed contracts, documentation and maintainability evidence |
| DPL-001–007 | PR-003, 005, 015, 016 | Portable container/environment, migration and deployment evidence |
| OBS-001–006 | PR-005, 006, 009, 011, 012, 013, 015, 016 | Correlation, safe logs, job/integration/notification health and alerts |
| UX-001–006 | PR-003, 004, 008, 009, 012, 013, 016 | Accessibility, responsive role journeys, terminology/locale and errors |
| CMP-001–004 | PR-003, 004, 006, 008, 013, 014, 016 | Browser/API/version compatibility and provider-neutral contracts |
| RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, artifact and release evidence |

## 4. Planned pull-request sequence

### PR-001 — WOS-00 governing blueprint

**Branch:** `controller/wos-00-blueprint`  
**Outcome:** Establish the authoritative product, architecture, quality, provenance, delivery, risk and traceability system.

**Acceptance:** Complete required document inventory; unique/mapped requirements and NFRs; eight valid ADRs; no source import or sensitive content; all blocking independent-review findings resolved; product-owner Gate B recorded before merge.

### PR-002 — WOS-01 authorized source bootstrap

**Branch:** `codex/wos-01-authorized-source-bootstrap`  
**Outcome:** Import only approved source files from `f2de1d85126f5d64f0e2e21b085b0303ca1d8417` without Git history.

**Requirements:** WOS-CORE-007, WOS-GOV-005, WOS-OPS-007, WOS-OPS-009.

**Scope/evidence:** Verified source SHA; explicit include/exclude manifest and checksums; no presentations/screenshots/company-only artifacts; forbidden-file/secret scan; locked install, type/lint, build and inherited regressions; no write to the reference repository.

**Merge boundary:** PR-002 cannot merge while prohibited company-specific runtime branding/data remains. Cleanup occurs in PR-002, or PR-003 remains stacked and only the combined clean state may merge.

### PR-003 — WOS-01 neutral branding and configuration foundation

**Branch:** `codex/wos-01-neutral-branding-config`  
**Outcome:** Centralize product/organization branding and eliminate runtime company-specific dependencies.

**Requirements:** WOS-CORE-001, 006–007; WOS-ORG-001, 005–006; WOS-OPS-009.

**Scope/evidence:** Product configuration service; neutral assets, seeds and notifications; configurable name/logo/favicon/colours/support identity; safe cookie/service/password prefixes; demo-production separation; repository and built-artifact forbidden-term scans; login/navigation/notification browser evidence.

### PR-004 — WOS-02 organization and setup foundation

**Branch:** `codex/wos-02-organization-setup`  
**Outcome:** Add organization/legal-entity ownership, configurable structures, calendars, periods and guided setup.

**Requirements:** WOS-CORE-002, 004; WOS-ORG-001–010; WOS-IAM-005; WOS-WKF-001–002, 006.

**Scope/evidence:** Organization/legal entity/business structures; default-organization migration; scoped identifiers; calendars/periods; worker master/type/lifecycle; server-derived setup readiness; fresh/upgrade migrations; cross-scope negatives; effective-history and worker-dependency journeys.

### PR-005 — WOS-03 CI/CD, migrations and production profiles

**Branch:** `codex/wos-03-ci-migration-platform`  
**Outcome:** Establish reproducible engineering and deployment gates.

**Requirements:** WOS-OPS-001–009 and applicable DPL/RELSE NFRs.

**Scope/evidence:** GitHub Actions; locked install, type/lint, build, tests, migration, secret/dependency scans; production Dockerfile/Compose; environment validation; explicit migration command/ledger; health/build metadata; fresh/upgrade and fail-closed production startup evidence.

### PR-006 — WOS-03 modular and API foundation

**Branch:** `codex/wos-03-modular-api-foundation`  
**Outcome:** Create enforceable module/API seams without a big-bang rewrite.

**Requirements:** WOS-CORE-003, 005; WOS-GOV-001–004; MNT NFRs.

**Scope/evidence:** Domain/application module conventions; identity/organization/audit seams; `/api/v1` and stable errors; correlation/operation IDs; common mutation/audit contract; compatibility adapters; API/authorization regression evidence and bounded central-file growth.

### PR-007 — WOS-04 contracts and engagement models

**Branch:** `codex/wos-04-engagement-models`  
**Outcome:** Model reusable client, contract, engagement and project/workstream structures.

**Requirements:** WOS-CORE-004–005; WOS-CLI-001–002; WOS-CTR-001–003; WOS-ENG-001–005.

**Scope/evidence:** Client hierarchy; contracts/SOWs; POs; T&M, fixed-fee, milestone, retainer, managed-service, internal and pre-sales engagements; project lifecycle; current-data migration; effective versions, dependency-safe closure, authorization and browser evidence.

### PR-008 — WOS-04 flexible work capture and resource planning

**Branch:** `codex/wos-04-flexible-work-capture`  
**Outcome:** Support configurable daily/weekly work evidence and reusable capacity/assignment planning.

**Requirements:** WOS-CORE-004–005; WOS-TIM-001–012; WOS-RES-001–009; WOS-WKF-003–005, 007–008.

**Scope/evidence:** Work modes/categories/references; assignment/contract/period policy; increments/limits/deadlines/evidence; correction/reopen history; duplicate protection; capacity/skills; leave single-count availability; self-service and scoped hierarchy; migrations, API/browser and historical-integrity evidence.

### PR-009 — WOS-05 approval and policy engine

**Branch:** `codex/wos-05-approval-policy-engine`  
**Outcome:** Reusable routing, stages, delegation, SLA/escalation and period locking.

**Requirements:** WOS-CORE-004–005; WOS-APR-001–008; WOS-ORG-009.

**Scope/evidence:** Approval state machine; effective-dated policy; multi-stage routing; delegation; escalation/reminders; bulk decisions; period locks/reopen; integration with work/leave/assignment/commercial/batch approvals; canonical shared `approval.*` notification events; mutually exclusive pending-stage versus pre-submission/domain-remediation events; negative scope/idempotency/browser evidence.

### PR-010 — WOS-06 rates, costs and commercial terms

**Branch:** `codex/wos-06-rates-costs-terms`  
**Outcome:** Secure, effective-dated commercial master data and deterministic rate resolution.

**Requirements:** WOS-CORE-004–005, 008; WOS-COM-001–005, 014–015.

**Scope/evidence:** Billing rate cards and precedence; confidential cost rates/overhead; currency/FX/rounding; budgets/POs; effective overlap controls; resolution evidence; commercial approval/audit; historical stability and confidentiality negatives.

### PR-011 — WOS-06 commercial calculation and margin engine

**Branch:** `codex/wos-06-commercial-engine`  
**Outcome:** Calculate billable value, cost, margin, EAC and explicitly configured non-statutory operational earned-management metrics.

**Requirements:** WOS-CORE-004–005, 008; WOS-COM-006–013.

**Scope/evidence:** T&M, fixed-fee, milestone, retainer and managed-service calculations; versioned snapshots; fail-closed non-T&M policy selection; fixed-fee operational earned-management calculations that are explicitly non-statutory and independent from billing eligibility/invoice readiness; budgets/POs/EAC; deterministic golden vectors; currency/rounding; reconciliation; immutability and controlled recalculation.

**Gate boundary:** PR-011 establishes calculation/margin engineering readiness only. It cannot satisfy Gate C.

### PR-012 — WOS-06 invoice readiness

**Branch:** `codex/wos-06-invoice-readiness`  
**Outcome:** Convert source-specific eligible evidence into versioned billing events, one-to-one approved-unbilled items and controlled batches/exports.

**Requirements:** WOS-CORE-004–005, 008; WOS-INV-001–008.

**Scope:**

- T&M, milestone, fixed-fee, retainer, managed-service and adjustment eligibility.
- Source → versioned billing-eligibility event → one-to-one approved-unbilled item → line/batch lineage.
- Approved-unbilled item as the only batchable object; direct raw-source/snapshot bypass rejection.
- Canonical `Draft`, `Under Review`, `Approved`, `Exported`, `Billed/Confirmed`, `Cancelled` states.
- Database-unique current occupancy per approved-unbilled-item ID/version, rejecting same-batch, cross-batch and concurrent duplicates with no orphan line, duplicate amount or control-total drift.
- Same-key identical retry returns the existing membership; same-key changed-input and different-key duplicates conflict; bulk, import and compatibility routes cannot bypass occupancy.
- Partial-billing, presentation-splitting and multiple-line reuse are prohibited; separately billable portions require distinct authorized/versioned event/item versions with reconciled source totals.
- Immutable historical membership, valid pre-export cancellation with atomic current-occupancy release, controlled re-batching as a new membership version, and permanent `Exported`/`Billed/Confirmed` occupancy.
- Initial provider/CSV delivery only from `Approved`.
- Provider acceptance or atomic immutable CSV-artifact acceptance as the single `Approved → Exported` transition.
- Failed delivery/generation remains `Approved`; idempotent retry returns the same accepted result.
- Final-state retrieval/status only; no duplicate delivery or re-transition.
- Versioned reversals/supersessions/correction batches and immutable accepted evidence.

**Mandatory evidence:** Fresh/upgrade migrations for the database-unique current-occupancy invariant; direct-bypass negatives; event/register one-to-one; duplicate same-batch and cross-batch insertion; concurrent same-item requests proving one accepted membership, deterministic conflicts and no orphan line, duplicate amount or control-total drift; same-key identical retry, same-key changed-input conflict and different-key duplicate conflict; bulk/import/compatibility-route enforcement; split/partial-line rejection and separately authorized portion reconciliation; valid cancellation release and controlled re-batching with immutable history; permanent final occupancy; versioned post-export/billing corrections; all state transitions and terminal rules; provider and CSV acceptance metadata/control totals; locked periods; API/browser selection; source-to-export reconciliation and audit.

**Gate C:** Product-owner Gate C occurs only after PR-010, PR-011 and PR-012 are merged **and PR-012 engineering acceptance is independently proven at an exact head before Gate C**. Evidence covers terms, deterministic calculations, source-specific eligibility, approved-unbilled, complete provider/CSV batch lifecycle, corrections, authorization and reconciliation. Gate C is additional owner acceptance and never substitutes for PR-012 engineering evidence.

### PR-013 — WOS-07 reporting, leakage, notifications and adapters

**Branch:** `codex/wos-07-reporting-leakage-integrations`  
**Outcome:** Deliver scoped insight, deterministic leakage controls, governed notifications and provider-neutral integrations.

**Requirements:** WOS-CORE-005, 008; WOS-RPT-001–007; WOS-INT-001–006.

**Scope:**

- Operational, utilization and commercial reports, leakage signals, data quality and reconciliation.
- Controlled report exports and worklog/finance adapter contracts.
- In-app notification centre and provider-neutral email/collaboration adapters.
- Versioned, locale-aware, channel-safe templates.
- Four authoritative policy classes: `ACTION_REQUIRED`, `CONTROL_MANDATORY`, `INFORMATIONAL`, `OPERATIONAL_CRITICAL`.
- Complete canonical WOS-INT-002 matrix of thirteen event/template keys and default relationship recipients:
  - `work_period.submission_due`
  - `work_period.submission_overdue`
  - `approval.action_required`
  - `approval.rejected_or_correction_required`
  - `approval.completed`
  - `approval.overdue_or_escalated`
  - `assignment.created_or_materially_changed`
  - `commercial.approval_required`
  - `commercial.risk_threshold_breached`
  - `invoice_batch.action_required`
  - `invoice_batch.export_failed`
  - `invoice_batch.exported_or_billed_confirmed`
  - `integration.delivery_failed_or_degraded`
- `approval.action_required` is the exclusive action-request event whenever a valid generic stage is pending, including commercial and invoice-batch approvals.
- `commercial.approval_required` is restricted to a pre-submission requester/change-owner prompt to create, complete or submit the generic approval request; it is never sent to approvers and never emitted for a pending stage.
- `invoice_batch.action_required` is restricted to batch-owner pre-submission evidence, reconciliation, validation or export-preparation remediation while no generic stage is pending; generic approval rejection/correction uses `approval.rejected_or_correction_required`.
- One source entity/version and triggering operation may create at most one action-required event; domain modules cannot duplicate the generic approval event.
- Server-resolved recipient relationships/reasons, preferences/mandatory decisions, event/template/source versions, delivery attempts, retries/backoff, idempotency, failure isolation, correlation and sanitized health.
- Shared approval events supplied once by PR-009 for work, leave, assignment, commercial and batch approvals.
- No client recipients in v1; protected extension cannot remove a default mandatory recipient or downgrade a mandatory class.
- Finance initial delivery `Approved`-only; final-state retrieval/status idempotent and non-duplicating.

**Mandatory evidence:**

- Report/snapshot/event/register/batch/export control-total reconciliation and out-of-scope negatives.
- Positive and negative deterministic tests for every canonical event, template version, trigger, recipient relationship and policy class.
- Preference behavior for all four classes and mandatory override/no-opt-out evidence.
- Visible failure when a mandatory event resolves no recipient.
- Recipient scope/redirection negatives and no client recipient.
- Shared approval-event reuse with no incompatible duplicate keys.
- Explicit transition vectors proving `commercial.approval_required` before submission, `approval.action_required` after a stage becomes pending, and never both for the same source/version/operation.
- Explicit transition vectors proving `invoice_batch.action_required` only for non-approval batch-owner remediation, never for a pending stage or generic approval rejection/correction.
- Event/in-app/channel idempotency and no-duplicate delivery across replay, scheduler and provider retry.
- Safe provider failure without core-transaction rollback; retry/owner/health evidence.
- Template variables, locale, sanitization and no secret/personal/cost/margin leakage.
- Email/collaboration/worklog/finance mock adapter contracts and scoped operational health.
- Audit evidence including event, template, source, recipient reason, class, channel decision, operation and correlation.

### PR-014 — WOS-08 identity, session and security hardening

**Branch:** `codex/wos-08-security-identity`  
**Outcome:** Enterprise identity/session controls and high-risk application-security closure.

**Requirements:** WOS-CORE-005; WOS-IAM-001–010; applicable SEC NFRs.

**Scope/evidence:** OIDC/Entra production path; local accounts non-production/demo only; production OIDC fail-closed with no WorkOS local-auth fallback; externally governed named/audited IdP/infrastructure break-glass preserving WorkOS scope/session controls; revocable sessions; account lifecycle; throttling; CSRF/CORS/headers; access review; threat model, negative authorization, disabled-user/session and no-secret evidence.

### PR-015 — WOS-08 observability, recovery and release operations

**Branch:** `codex/wos-08-operations-hardening`  
**Outcome:** Supportable and recoverable buyer-owned deployment.

**Requirements:** WOS-OPS-004–010 and applicable reliability/performance/observability NFRs.

**Scope/evidence:** Structured logs/metrics; job/integration/notification failure signals; backup/restore scripts and rehearsal; monitoring/alerts; release metadata and migration/rollback notes; Standard-profile performance; runbook consistency.

### PR-016 — WOS-09 v1 release acceptance and handover

**Branch:** `controller/wos-09-v1-release-acceptance`  
**Outcome:** Independently reviewed, production-like, sellable WorkOS v1 package.

**Requirements:** All accepted v1 requirements.

**Scope/evidence:** Full traceability; multi-role UAT; fresh/upgrade; commercial/invoice/notification/identity reconciliation; security disposition; restore/monitoring; buyer handover; exact-head green matrix; no blockers; product-owner Gate D; version/tag `v1.0.0`.

## 5. Codex model policy

Use the strongest available Sol reasoning model for architecture, security, migrations and commercial calculations; an appropriate Sol model for bounded implementation/tests/docs; and a fresh independent Sol review pass before acceptance. Model choice never replaces evidence.

## 6. Definition of ready

A package is ready when requirements, dependencies, scope/exclusions, migration/rollback, acceptance evidence and owner decisions are known.

## 7. Definition of done

A package is done only when code/schema, applicable tests, authorization, migration, browser, audit, operations, rollback, documentation and traceability evidence are merged at the exact accepted head and any owner gate is recorded.

## WOS-00F ownership overlay

- **PR-009:** implement generic approval finality, source-state validation, stable conflict/replay behavior, immutable decisions and authorization negatives. It must not provide invoice-batch generic reopen.
- **PR-012:** implement the canonical batch transitions, atomic approval/occupancy invariants, protected cancellation/replacement, failed-export behavior, reversal/supersession and correction-batch evidence. It owns API/database/browser agreement.
- **PR-013:** implement bounded server-side source-owner resolution, scope validation, deduplication/reasons, fail-closed protected delivery, idempotency and same-decision event exclusivity.

These assignments are retained while `main@880b3dc244bf516c4e535fb68e455e6153aec395` is under WOS-00F corrective hold. WOS-01A PR #12 is not ready to resume until PR #14 is published, clean-reviewed and merged, the corrected exact `main` SHA is recorded, and the controller explicitly reauthorizes and recreates or rebases PR #12 from that corrected baseline.

## Recorded bounded non-overlap exceptions

On 2026-10-20, the implementation controller recorded the [Utilization overview read-recovery exception](../tasks/UTILIZATION-OVERVIEW-READ-RECOVERY.md). This UI-only UX-001/005 and OBS-005 remediation is a separate dependent Draft stacked on unchanged PR41. It does not resume blocked security work, change backend/authorization/calculation/export/schema, complete PR-013 or earn programme credit. Dependency, exact-head review/CI and owner/release gates remain unchanged.

On 2026-10-20, the controller additionally recorded the [Planned Utilization detail read-recovery exception](../tasks/PLANNED-UTILIZATION-READ-RECOVERY.md), dependent on unchanged PR43. It repairs only existing read-state presentation, retry/generation handling and page-level current-evidence export availability, preserving successful export format/helper/audit behavior. Actual/Forecast, backend, authorization, calculations, schema, dependencies and blocked security work remain excluded; no programme, prerequisite or review/merge/release gate is bypassed.
