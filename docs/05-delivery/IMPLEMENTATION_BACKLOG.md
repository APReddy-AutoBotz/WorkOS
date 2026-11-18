# WorkOS Implementation Backlog

**Current execution direction (2026-11-14):** Follow the [enterprise delivery and integration roadmap](ENTERPRISE_DELIVERY_ROADMAP.md) for verified integration, consistent utilization, workflow recovery and remaining release evidence within the work-package dependencies below. Current merged/draft state is recorded in [implementation status](../00-control/IMPLEMENTATION_STATUS.md); historical controller notes below are not a substitute for live exact-head acceptance evidence.

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

On 2026-10-20, the controller recorded the separate [Actual Utilization detail read-recovery exception](../tasks/ACTUAL-UTILIZATION-READ-RECOVERY.md), dependent on unchanged PR44. Its atomic three-reader/four-business-endpoint recovery and current-evidence export guards preserve existing month/status/search, calculations and CSV/helper/audit semantics, including logs with empty report employee rows. Forecast, broader reporting, backend/security/schema/dependency work and blocked diagnostics remain excluded; all programme/dependency/review/merge/release boundaries remain unchanged.

On 2026-10-20, the controller recorded a separate [Forecast Utilization detail read-recovery exception](../tasks/FORECAST-UTILIZATION-READ-RECOVERY.md), dependent on unchanged PR45. Its five existing readers form a current horizon-keyed frontend snapshot, preserving ten nested/duplicate business GET contracts and every successful horizon/date/calculation/omission-or-zero fallback semantic. Safe failure recovery and current-evidence export guards do not alter backend, auth, normalizers, schema, dependencies or export-helper/audit behavior. Independent roll-offs/charts survive section-empty success. Blocked security work remains excluded; all programme/dependency/review/merge/release gates stay unchanged.

On 2026-10-20, a separate [organization profile editor increment](../tasks/ORGANIZATION-PROFILE-EDITOR.md) was recorded as a bounded WOS-02 non-overlap exception, stacked on unchanged PR46. It closes the existing WOS-ORG-001 ordinary metadata UI gap and adds a WOS-ORG-010 profile entry point, preserving the existing server permission, resolved scope, version transaction and audit. Captured identity/permission/scope and generation guards protect pending reads/drafts/mutations. Existing security repairs, legal-entity lifecycle, schema, credentials and whole-setup completion remain excluded; all prerequisite/review/owner/UAT/merge/release boundaries remain unchanged.


On 2026-10-20, the controller recorded a separate [terminology configuration editor increment](../tasks/TERMINOLOGY-CONFIGURATION-EDITOR.md), stacked on unchanged PR47, as a bounded existing WOS-02 non-overlap exception. It closes the existing WOS-ORG-006 buyer-facing editor gap and only a WOS-ORG-010 entry point. Canonical keys, server guards/scope/version transaction/audit and existing consumer coverage remain unchanged. Scope-owned drafts/saves, a minimal runtime stale-response guard and terminology-only date transport are included; branding, readiness writes, security repairs, schema and grants are excluded. All formal prerequisites/review/owner/UAT/merge/release gates remain unchanged.


On 2026-10-20, a separate [working calendar inspector increment](../tasks/WORKING-CALENDAR-INSPECTOR.md), stacked on unchanged PR48, was recorded as a bounded existing WOS-02 non-overlap exception before product writes. It adds only a read-only WOS-ORG-008 calendar inspector and WOS-ORG-010 calendar entry point. Existing GET scope/permission/ownership/predicate/order/limit contracts stay intact with narrowly scoped DATE-as-text transport. Catalog mutations remain NO-GO pending retired-lineage reactivation and reference-semantics decisions. No calendar mutations, worker assignments, capacity integration, grants, security repairs, schema or credentials are included. All formal prerequisites/review/owner/UAT/merge/release boundaries remain unchanged.

On 2026-10-20, the separate [integrated import-to-audit acceptance journey](../tasks/IMPORT-AUDIT-ACCEPTANCE-JOURNEY.md) was recorded before edits as a bounded WOS-03 tests/CI/docs-only non-overlap increment stacked on unchanged PR49. It closes the evidence gap between mocked component browser fixtures and separate real API/PostgreSQL tests for one Project Master validate/apply/reload/reviewer-provenance flow. No production/schema/permissions/grants/dependencies or export scope changes. Product defects are separate-scope findings, not fix authority. All twelve existing browser suites, prerequisite chains, blocked security exclusions and formal review/owner/UAT/merge/deployment/release gates remain unchanged.


On 2026-11-14, PR50 was reconciled with accepted PR49 main. Its journey implementation had already been forwardported into PR41; all current runtime, test, CI and package files are preserved exactly. Only four documentation files remain in the reconciliation, retaining original failed/not-run receipts while explaining subsequent accepted evidence and current owner merge authorization. WOS-CORE-003/005 and WOS-GOV-002/004 remain bounded synthetic journey coverage, not full release acceptance.

## Development-only PR-007A sequencing exception

On 2026-10-20, the owner directed continued implementation of the agreed product plan without waiting for formal review, which may occur at the end. The controller recorded [commercial drafting foundation](../tasks/WOS-04-COMMERCIAL-DRAFTING-FOUNDATION.md) as the substantive next PR-007 development slice on unchanged PR50. It adds real scoped contracts/SOWs, seven-model engagement drafts, POs, milestone drafts, immutable future contract revisions and neutral migration mappings. This changes development sequencing only: open prerequisite acceptance, programme credit, required validation, formal release/merge/production gates, denied security repair and the unchanged blocked diagnostic remain separate. The remaining client/project/lifecycle/billing work is explicitly open in the task. Keep the dependent PR Draft and unmerged.

## Development-only PR-007B continuation

After bounded PR-007A exact-head engineering validation, continue [governed lifecycle and projects](../tasks/WOS-04-GOVERNED-LIFECYCLE.md) on unchanged PR51. Add exact immutable-version activation, server-current-day Active/On Hold history, governed projects/workstreams and explicit legacy Proposed promotion, common legacy mutation guards and actual dependency inspection. Preserve immutable Draft/migration histories and opt-in permissions. Terminal closure is deliberately unavailable while required unbilled/balance/settlement evidence is absent. This is substantive continued development, not a formal-review hold or prerequisite/release acceptance. Client hierarchy/amendments/term rollover/work-date and later commercial lifecycle remain open. Keep the dependent PR Draft/unmerged.

## Development-only PR-007C continuation

After PR-007B exact-head engineering validation, continue [scoped client master and customer billing profiles](../tasks/WOS-04-SCOPED-CLIENT-PROFILES.md) from unchanged PR52. Deliver WOS-CLI-001–002's explicit code/legal/display identity, scoped optional parent accounts and multiple customer billing entities/business units without duplicating operational client identity or confusing buyer legal-entity ownership. Keep append-only effective-dated profiles, scoped cycle/concurrency controls, separate opt-in client-profile permissions, protected audit and unchanged legacy clients/import/seed/governed-cascade behavior. Missing legacy identity/defaults remain incomplete. This continues substantive implementation, not a formal-review wait or prerequisite/release acceptance. Terminal retirement, complex corporate consolidation, tax/payment/invoice routing and later billing/financial authority remain excluded. Keep dependent PR Draft/unmerged.

## Development-only PR-007D continuation

After bounded PR-007C exact-head engineering validation, continue [governed material amendments and term rollover](../tasks/WOS-04-GOVERNED-AMENDMENTS.md) from unchanged PR53. Explicit server-previewed adoption of newer immutable versions adds separate append-only dated Contract/Engagement/Project term snapshots. Preserve original activation pins and accepted historical work, enforce parent adoption, identity/date/decimal dependency limits, expected current versions and protected audit. No implicit child cascade, billing recalculation, default grants, terminal closure or consumption/balance authority is introduced. Work-date/assignment-policy convergence remains PR-008. Keep the dependent PR Draft/unmerged; this is development continuation, not a formal-review hold or prerequisite/release acceptance.

## Development-only PR-008A continuation

After exact-head engineering validation of PR54, continue [assignment and work-date convergence](../tasks/WOS-04-ASSIGNMENT-WORK-DATE-CONVERGENCE.md) as the first bounded PR-008 slice on unchanged PR54. Shared server policy spans manual and compatibility/versioned import assignment/work writers, scoped worker and governed parent lifecycle, independently adopted dated terms and non-billability. New submitted work retains immutable policy/term/assignment evidence; accepted legacy work remains unpinned and cannot be silently overwritten through import/seed. Source-aware approval checks preserve all-entry period authority and correction history. This is substantive development continuation, not full PR-008 completion or formal acceptance. Capture configuration, capacity/skills and later finance/approval dependencies remain open. Keep the dependent PR Draft/unmerged; no Ready, merge or deployment is included.

## Development-only PR-008B continuation

After Draft PR55's exact-head engineering gates pass, continue [effective-dated work capture rules](../tasks/WOS-04-WORK-CAPTURE-POLICY.md) on its unchanged content. Add only scoped append-only Weekly-boundary increments, daily/Weekly aggregate limits and positive-entry comments; decimal-safe manual/import replacement parity and separate capture references; a settings editor and lossless existing-grid preservation. Preserve worker/assignment/period/approval and historical evidence. Full categories, evidence, modes, overtime, deadlines, protected reopen and capacity/finance remain later. Source review is not executable acceptance; all existing gates and new PostgreSQL/browser proof remain mandatory. Keep the separate dependent PR Draft/unmerged, with no Ready, merge, deployment or programme/release credit.

### PR-008C bounded continuation: daily/weekly presentation and optimistic manual saves

Continue WOS-TIM-001 on accepted PR56 under `docs/tasks/WOS-04-WORK-CAPTURE-MODES.md`: explicit scoped buyer modes, the existing weekly header/approval identity, lossless full-header daily/weekly saves, stale revision/mode conflicts and equivalent unfinished-Draft/manual-import period controls. This fresh candidate requires new independent exact-tree review and full exact-head execution, including real PostgreSQL/React acceptance. No default adoption/grants, daily approval, calendar re-keying or previously deferred PR008 scope is included. Full PR008 and formal acceptance remain open.

### PR-008D bounded continuation: optional evidence references

Integrate [work-entry evidence links](../tasks/WOS-04-WORK-ENTRY-EVIDENCE.md) after accepted PR57 under the owner's subsequent authorization for reviewed integration and eligible merges. Preserve existing scope/assignment/period/immutability/CAS semantics, add shared omission-versus-clear preservation for manual and both import writers, retain links across full-header UI saves and immutable correction history, and prove fresh/upgrade/replay plus real React/API/PostgreSQL journeys. Keep the dependent PR Draft until its own independent exact-head review and executable acceptance gates pass. The earlier development-only review deferral is historical; no broader programme or deployment acceptance is implied.

### PR-008E bounded continuation: task/ticket/milestone reference text

Continue the approved WOS-TIM-003 reference dimension under [PR-008E](../tasks/WOS-04-WORK-ENTRY-REFERENCE.md) after accepted PR58. The original acceptance plan preceded product edits as `040e02b`. Deliver optional descriptive per-entry text without provider/entity lookup or business authority, independent evidence/reference preservation, existing history/CAS controls and fresh/upgrade/replay plus real React/API/PostgreSQL proof. The owner's subsequent reviewed-integration authorization supersedes the original development-only review deferral. Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. No broader programme or deployment acceptance is implied.

### PR-008F bounded continuation: required evidence URL option

Follow accepted PR59 with [the approved TIM005 evidence requirement](../tasks/WOS-04-REQUIRED-EVIDENCE-POLICY.md). The acceptance plan preceded implementation as `680088e`. Extend existing legal-entity/Weekly capture policy with a buyer-selected positive-entry URL requirement; preserve omissions for older API/SQL editors, work-date authority, zero exemption, metadata/history and all existing controls. Do not install a requirement by default or invent category/group exceptions, overtime, deadlines or reopen policy. The owner's subsequent reviewed-integration authorization supersedes the original review deferral. Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. No broader programme or deployment acceptance is implied.

### PR-008G bounded continuation: identical saved-entry content advisories

Continue WOS-TIM-012's permitted flagging behavior under [PR-008G](../tasks/WOS-04-IDENTICAL-ENTRY-FLAGS.md), based on accepted PR60 `703ed725e689ae133f6d4c375c76fc2829a0dec2`. Plan commit `b7501ee` precedes implementation. Add deterministic within-header exact-content groups, server-derived last-saved worker/approver advisories and nullable immutable new-submission checks. Preserve distinct context, comments/references, exact quantities, hidden/weekend/zero rows, existing CAS/scope/period and approval rules, and both import aliases' partial/natural-key contracts. No automatic deduplication, hard rejection or financial effect is introduced. Full cross-header/upstream identity semantics, TIM012/PR008 and release acceptance remain open. Require real API/PostgreSQL/browser and retained engineering gates, then require independent exact-head review and hosted acceptance before merge.

Current owner authorization supersedes the historical review/merge deferral above. Fresh local acceptance, independent exact-head review and hosted gates are required before integration; release and buyer acceptance remain open.

### PR-008H development-only continuation: retained work history inspector

Continue WOS-TIM-008 and the work-capture specification's prior submission/decision history under [PR-008H](../tasks/WOS-04-WORK-SUBMISSION-HISTORY.md), based on unchanged Draft PR61 `5b301346688b324af6913ae2ef4d66d2be31b7de`. Plan commit `2b4d596` precedes implementation. Add explicit on-demand worker/approver inspection of the existing immutable snapshots,10-version cursor pages, prior reasons/content/source and honest legacy gaps. Share existing header-read scope verbatim, preserve owner isolation and exact quantities, and keep all writers/workflows/policies/financial behavior unchanged. Require real role/API/PostgreSQL/browser proof and retained engineering gates, then publish a separate dependent Draft and observe hosted CI to terminal. No grants, schema/backfill, reopen/deadline/overtime/category rules, stack integration or monitoring changes; broader acceptance and optional formal reviews remain outstanding.

Current owner authorization supersedes PR-008H historical development-only review/merge deferrals. Integration uses accepted PR61 correction `e7439e3f8e57e39b925c10e316c5b7ce18fb2d40`; fresh local evidence, independent exact-head review and hosted checks remain required. Full TIM008/PR008 and release acceptance remain open.

### PR-008I bounded evidence continuation and defined finish

Before further implementation, reconcile approved PR008 through PR62 using [the finite28-requirement matrix and R1–R10 remainder](../tasks/WOS-04-PR008-ACCEPTANCE-CHECKLIST.md). Preserve its distinction between implemented/partial/missing engineering evidence and formal acceptance, eight missing business-policy decision groups and excluded optional extensions. Continue one safe existing specification outcome as [E1 named worker/approver capture-cycle evidence](../tasks/WOS-04-CAPTURE-ROLE-ACCEPTANCE.md) on unchanged PR62 `0eaf501b4988af107d1a503fe93ccab96b2eb96f`; the checklist/acceptance plan commit precedes test implementation. Actual Employee UI submission/correction and distinct approver rejection/approval must pass without Admin demo overrides or changed product rules. Keep this test/documentation dependent Draft unmerged; R1–R10 and final integration/review/UAT gates remain finite outstanding work, not authority for an open-ended sequence or invented policy.

PR-008I current integration uses frozen PR62 `0f7f1eab7286cd9dc20e6d79879573ac1340539b` under the owner's later reviewed-integration authorization. The linked 28-row matrix is a preserved historical snapshot, not current readiness or approval evidence. Parent acceptance, the named Employee/approver journey, retained checks and independent exact-head review remain required; broader PR008 and release acceptance remain open.

### PR-008J: R2 configurable standard-threshold capture treatment

Resolve D1–D8 against [approved sources and accepted decisions](../tasks/WOS-04-POLICY-DECISION-RESOLUTION.md), rather than requesting eight blanket policy approvals. Continue [R2 / PR-008J](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md) on unchanged Draft PR63 `b40712739d613d5fef9f8b4926d70f1e691e9b08`; plan commit `c60292ad5bcc5faceff37cd7282a42ecba19c995` precedes implementation. Add explicit buyer-configured daily/Weekly thresholds and warn/block in existing scoped immutable prospective capture policy, with no installed thresholds/default adoption. Preserve exact manual/import totals, hard maxima, owner/session/data scope, replay, submission history and prior decisions. Require focused fresh/upgrade/replay, negative/concurrent SQL/API and actual React/API/PostgreSQL evidence plus all retained gates. Publish one dependent Draft and observe hosted CI to terminal. No payroll/legal determination, financial change, exception authority, merge/deploy, denied review/repair retry or monitoring/protection change. Optional formal reviews and full milestone/integrated acceptance remain outstanding.

### PR-008J reviewed integration checkpoint — 2026-11-15

The owner's subsequent authorization supersedes this package's historical review/scan/merge deferral and original fixed-Draft dependency. Current integration includes accepted PR63/main `68d292a77730194ef428b42695aaefe33d429b72`. Bounded WOS-TIM-005 and WOS-CORE-003–005 evidence, response-validation corrections, exact executed gates and pending review/browser/hosted gates are recorded in [the package task](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until those gates pass. Retain migration051 and all history/guards on rollback; no deployment, whole PR008 acceptance or earlier security-finding closure is implied.

### PR-008K: R3 explicit submission deadline/grace mechanics

Continue the well-specified WOS-TIM-007 legal-entity option under [PR-008K](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md) on fixed Draft PR64 `e80fdc634277ffd05648117f98ff345c4e60054f`, with the plan committed before implementation. Require explicit supported UTC anchor, period-relative date/time, grace and warn/block inputs; never infer a browser/worker timezone or install a buyer value. Preserve immutable prospective policy/CAS, Draft editing, accepted decision history, manual/import controls and exact replay diagnostics. Validate real PostgreSQL migration/API/direct-SQL boundaries, real settings/worker/import/approver UI journeys, owner isolation and retained suites, then publish a dependent Draft and follow CI to terminal. This closes the bounded configuration/enforcement/evidence outcome; specified canonical overdue notification handoff/delivery remains a later dependency, not a new scheduler/recipient grant or full R3/milestone acceptance. Optional formal reviews remain deferred/outstanding. Prior Drafts/main and monitoring remain fixed; denied reviews/repairs stay stopped.

### PR-008K reviewed integration checkpoint — 2026-11-15

The owner's subsequent authorization supersedes this package's original fixed-Draft and review/scan/merge restrictions. Current integration includes accepted PR64/main `99bb7249d1f8ff4d2a223b293d2e72699afc4f79`. Bounded WOS-TIM-007 and retained CORE003–005/TIM008/011 evidence, response-validation corrections and pending gates are recorded in [the package task](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. Retain migration052 and immutable history/guards on rollback; notification delivery, full R3/PR008, buyer UAT and deployment remain separate.

### PR-008L: R5 explicit source-linked work identity

Continue [R5 / PR-008L](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md) from fixed Draft PR65 `4b34af26ea2400c9b81af8d909ced6edbd4755be`, under TIM003/011/012 and D5's already specified create/conflict discipline. Commit `42b68e2fa7223134ec4122e5cea9260fd1ed172b` records lineage/acceptance before implementation. Add explicit optional case-sensitive namespace/worklog IDs, scoped append-only source claims, cross-header collision rejection, source-preserving manual/both import/CSV/full-header UI/history, retained batch check acknowledgement and exact replay. Newly tagged work opts into fixed captured content; untagged work and old controls remain unchanged. No provider lookup, inferred legacy match/default, changed-source relinking, approval/financial authority or live connector is created. Require focused real PostgreSQL/API/UI and all retained engineering gates, publish only the dependent Draft with exact receipts, observe CI to terminal. Optional formal reviews, R3 notification dependency/UTC limits, finite R1/R4/R6–R10 and integrated/UAT/release gates remain open. No merge/deploy or monitoring/access/protection changes.

### PR-008L reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR65/main `956eb09cc88869a17793b3e862c4d45d596e8786`; bounded WOS-TIM-003/011/012 and retained CORE004/005/TIM008 evidence, lockfile reconciliation and remaining gates are recorded in [the package task](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. Retain migration053, immutable claims/history/checks and guards on rollback. No provider verification, inferred links, changed-source amendment, financial authority, full milestone or deployment acceptance is implied.

### PR-008M — Structured workforce capabilities continuation

From fixed PR66, [PR-008M](../tasks/WOS-04-WORKFORCE-CAPABILITIES.md) delivers WKF004's structured worker skills/proficiency, explicit certification validity/no-expiry, availability notes and deterministic exact scoped planner search, with append-only versions/CAS/audit and actual HR/Employee browser/API/database evidence. Plan precedes implementation; no buyer vocabulary/rank/default, provider verification, new grant or capacity/assignment effect is inferred. Keep this dependent Draft unmerged. This closes only the capability-record/filtering boundary within R8; demand/assignment integration and other finite outcomes/reviews/integration/UAT/release remain outstanding. PR66 source provenance/amendment and R3 UTC/notification limits remain unchanged.

### PR-008M reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes the package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR66/main `2a8828f9b0762cef514ab670882d12e6dffd2c0f`. Bounded WOS-WKF-004/008, WOS-CORE-004/005 and WOS-NFR-DAT-005 evidence and remaining gates are recorded in [the package task](../tasks/WOS-04-WORKFORCE-CAPABILITIES.md#reviewed-integration-checkpoint--2026-11-15). Keep Draft until local acceptance, independent exact-head review and hosted gates pass. Retain migration054, capability versions and audit on rollback; a compatible binary is required for edits. No new grants, verified certification, inferred rank/capacity, full R8 or enterprise release acceptance is implied.

### PR-008N — Demand-to-recorded-assignment acceptance continuation

From unchanged PR67, [PR-008N](../tasks/WOS-04-RESOURCE-DEMAND.md) closes the coherent RES007/R8 recording path: explicit demand, exact scoped capability candidates, actual existing Allocation Control assignment creation, explicit source-revision reference/planning status, reload/history and visible source staleness. Migration055 preserves all earlier work/assignment/capability/approval/financial evidence, permissions and buyer defaults. This delivers bounded engineering acceptance of the capture/match/reference path, not quantitative fulfilment or full R8/PR008 integration acceptance. Nonexclusive documentary links do not reserve capacity, convert percentage/hours or grant approval; R6/R7/R9 and the finite checklist's remaining outcomes/gates remain open. Keep dependent Draft unmerged and all prior heads fixed.

### PR-008N reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR67/main `3d83653f54200ba7394c8cf7ea6fa00ec33c5f6b`; local acceptance, independent exact-head review and hosted gates remain required before merge. See [the package evidence](../tasks/WOS-04-RESOURCE-DEMAND.md#reviewed-integration-checkpoint--2026-11-15) for WOS-RES-007 and retained RES-001/006/009, WKF-004/008 and CORE-004/005. Preserve migration055 roots/versions/source snapshots/guards/audit on rollback. No inferred capacity, fulfilment, approval or full R8/release acceptance is implied.

### PR-008O — Effective capacity authority through demand planning

From fixed PR68, [PR-008O](../tasks/WOS-04-EFFECTIVE-WORKER-CAPACITY.md) implements R6's coherent explicit prospective schedule/calendar/eligible-denominator/approved-absence authority and consumes actual period totals in the existing demand journey. Pre-code plan `785f5d98cbd1cad82f83eb439172525c94ac88fe` establishes prerequisite ordering: R7 quantitative overlap/assignment and R9 reconciliation depend on this authority. Explicit baseline/part-time/seven-day schedule, eligibility and calendar references activate no buyer defaults; migration056 creates empty immutable scoped stores. Require exact math/calendar precedence, fresh/055 upgrade/replay neutrality, real leave approval/owned worker/demand UI/API/database, stale source/CAS/history/scope, retained engineering and exact-head hosted gates. Unambiguous per-date approved absence and full-date overlaps are resolved; ambiguous legacy multiday/partial allocation and missing/retired calendar source cases remain specifically unavailable without conversion/repair. R6/PR008 acceptance is still partial. Existing reports are not relabeled, assignments/demand quantities are not converted, and no approval/protected-reopen/financial authority is invented. Preserve prior Drafts/main/integration; optional formal reviews and integration/UAT/release gates remain outstanding.

### PR-008O reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR68/main `b4beea218d5bd46c0396f5149dd05531420523ac`; local acceptance, independent exact-head review and hosted gates remain required. See [the package evidence](../tasks/WOS-04-EFFECTIVE-WORKER-CAPACITY.md#reviewed-integration-checkpoint--2026-11-15) for bounded WKF-003/005/007/008, ORG-008, RES-003/004/005, TIM-010 and CORE-004/005. Preserve migration056 profiles, result/source evidence, guards and audit on rollback. Unavailable legacy authority, broader reconciliation and buyer/release acceptance remain open.

### PR-008P — Existing percentage assignment version authority

From fixed PR69, [PR-008P](../tasks/WOS-04-ASSIGNMENT-VERSION-AUTHORITY.md) closes the bounded R7 source-version boundary through actual Allocation Control creation, exact guarded update with separate R6 context, named Employee UI work submission/version pins, and later manual/import/end history preservation. Plan `9f497ca486d3bcb7ff2e7c23289d0a253055062a` precedes code. Empty migration057 captures future source writes without migration backfill, buyer policy/default/grant or historical reconstruction. Existing permission/relationship/date/billability/selected legacy overlap and approval-record behavior remain; no percentage↔hours conversion or generic financial/approval authority. Unspecified range-hours distribution/denominator, cost/revenue rates, capacity-derived overlap policies and configurable material approval remain exact R7 dependencies rather than reasons to halt source versioning. R6 remains partial for its legacy/reference/conversion/report/composite cases; other finite outcomes and deferred formal/integration/UAT/release gates remain open. Require fresh/056 upgrade/replay, real SQL/API/import/history/scope/transport and actual React/Employee journeys plus retained exact-source gates; dependent Draft only, prior heads/main/integration fixed.


### PR-008P reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes historical fixed-Draft and review/scan/merge restrictions. Integration retains accepted capacity/main `f68d605d364941893836060f541ae021c70d654f`, including exact056a validation and owned evidence recovery. See [the assignment package evidence](../tasks/WOS-04-ASSIGNMENT-VERSION-AUTHORITY.md#reviewed-integration-checkpoint--2026-11-15) for bounded WOS-RES-001/002/003/009 and CORE-004/005. Local acceptance, independent exact-head review and hosted gates remain required. Preserve057 versions/pins/guards/audit on rollback; no inferred conversion, approval or full R7/release acceptance.

### PR-008Q — Own-worker selected-period integration

[Plan and acceptance](../tasks/WOS-04-OWN-WORK-PLANNING.md): bounded R10/WKF007 capacity/assignment/current-work/history integration on fixed PR70. Canonical server account binding, exact R6 daily/period totals, bounded original-unit assignments with R7 version references, saved-versus-retained work states and actual Employee Workspace read-only inspection/work-capture handoff. No migration, defaults, grants, conversion, writer or protected-reopen change. Required production-transport/API/real Employee React/PostgreSQL journeys and retained gates precede dependent Draft publication; exact-head receipts belong to that Draft. Optional independent/formal reviews remain deferred, not passed. R1/R3/R4/R6/R7/R8/R9 and R10's planner/hierarchy/unified utilization/actions, E2/E3 remain finite outstanding outcomes. No merge/deploy or milestone acceptance.


### PR-008Q reviewed integration checkpoint — 2026-11-16

Current owner authorization supersedes historical fixed-Draft/review/merge deferrals. Own-work planning integrates accepted main019aa52cb0e7e1ff35c0a8984672edd1c9bb6d58 and retains the corrected assignment/capacity controls. See the own-work planning task for WOS-WKF-007 and CORE-003/004/005 scope, literal-state regression and acceptance receipts. Final independent/hosted acceptance remains required. No new migration, grants, source writes, unit conversion or financial/approval authority. Rollback preserves all prior ledgers and hides the new view; broader reconciliation, security and buyer/release acceptance remain open.

## Priority security increment — current selected-role authority

The owner's continuing authorization permits the bounded [current-role repair](../tasks/WOS-04-CURRENT-ROLE-AUTHORITY.md) to be integrated independently of the later feature stack. Requirements IAM-003/005/008/010 and NFR-SEC-003/004 require current account/role validation in shared middleware, compatible provider mapping provenance and negative evidence for legacy/versioned cookie/bearer routes. No migration or new permission grant. Independent exact-head review and all applicable local/hosted gates precede merge; other security findings and product/release gates remain open.

## Priority security increment — protected identity administration

After PR162 current-role authority, integrate the bounded [protected identity administration repair](../tasks/WOS-04-PROTECTED-IDENTITY-ADMINISTRATION.md) independently of later Draft feature dependencies. Include the independently reproduced credential-target, username-collision and mapped-only compatibility corrections. All applicable exact-head local/hosted checks and independent review precede merge. No new schema, grants or production fallback; broader security, commercial/reporting and buyer/release gates remain open.


## Protected identity accepted; verified database transport in progress - 2026-11-16

[PR163](https://github.com/APReddy-AutoBotz/WorkOS/pull/163) merged at `134031bf43cf2b934759dcfec629f697bd82d203`. Corrected candidate `01ffda83fe501b95db5a300ebf40fba890c48a86` passed all 75 hosted steps in [CI43801592175](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43801592175), local aggregate, 54-entry migration acceptance, production identity/startup and retained browser journeys. Independent corrected-head review found no remaining introduced findings. The original candidate was rejected after review exposed incomplete legacy unlink; explicit unlink now retains Disabled identity state and prevents concurrent callback recreation. Requirements: IAM-003/005/006/010, CORE-003/005 and NFR-SEC-002/004/005. No migration or dependency change. Post-merge [CI43802724124](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43802724124) also passed all 75 steps, with no skipped or failed steps.

The next bounded repair is shared verified database TLS across API, migration and demo seed connections. Baseline actual-driver testing reproduced acceptance of an untrusted certificate. Candidate tests reject untrusted/wrong-host certificates before startup data, URL transport overrides, duplicate hosts and ambiguous encoded names. Trusted connections and explicit local plaintext remain supported. Full acceptance, exact-head review and hosted CI remain required. Broader security, dependent commercial/reporting integration, buyer UAT and production release gates remain open.


## Verified database TLS accepted; setup reads in review - 2026-11-16

[PR164](https://github.com/APReddy-AutoBotz/WorkOS/pull/164) merged at `a6b1cc249f5266ee41896245927cfe52f5f557cf`. Final candidate `fe8a5dca78de724b8e8dc622c862c6cd6266af27` passed all 76 steps in [CI43804406594](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43804406594). Independent runtime review and final documentation-delta review passed. API, migration/startup and demo seed now share verified certificate trust/hostname policy; private CAs require matching read-only mounts in both application and migration services. No migration/dependency change. Local type/lint/full aggregate, 54-entry migrations, browser journeys, synthetic actual-driver TLS negatives/positive, disposable seed and signed production identity/startup passed. Post-merge [CI43805538159](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43805538159) also passed all 76 steps, with no skips or failures.

The next bounded security increment protects organization-setup reads: administrative configuration requires settings.manage; runtime terminology remains available to signed-in users. Worker lifecycle history requires employees.view plus current row scope in the data query and exposes a minimal status/date projection. Exit-impact dependency details require employees.manage plus current worker scope. Invalid asOf values fail400 and async errors return safe500 responses without terminating the API. Broader security findings, dependent commercial/reporting work and buyer/release acceptance remain open.


## Bounded authentication security increment - 2026-11-16

After accepted setup read security PR165, [bounded authentication throttling](../tasks/WOS-04-BOUNDED-AUTH-THROTTLE.md) repairs the independently reproduced unbounded map and malformed-limit bypass. Explicit proxy peer validation also closes forwarded-IP rotation and audit spoofing at the shared trust boundary. No schema, dependencies, grants or commercial policy changes; fresh review and full applicable checks precede merge. Persistent/distributed production throttling, remaining security findings and dependent work packages remain separate acceptance gates.


## Bounded authentication accepted; durable sessions in verification - 2026-11-16

[PR166](https://github.com/APReddy-AutoBotz/WorkOS/pull/166) merged at `06516367ec9f452032b3d1a65658a22011448147`. Final candidate `b9e82f8e256d5546d974e8fadd11a57d692c63f1` passed all 77 steps in [CI43810482651](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43810482651), followed by all 77 steps in [main CI43811695312](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43811695312), with no skips or failures. Independent runtime/test and final documentation reviews passed. Bounded authentication memory, strict limits, explicit proxy trust and authoritative audit IP are accepted; persistent/distributed throttling remains a separate requirement.

The next security increment makes session logout durable across API processes, refreshed tokens and role switches. Migration057a appends a user-owned revocation ledger after accepted057 without consuming later Draft migration058. Pre-upgrade credentials require a fresh sign-in because old sibling tokens cannot be grouped safely. Current-session logout preserves independent sessions; both presented bearer and cookie families are revoked. Final integrated tests, frozen-head review and hosted acceptance remain required. Broader security, commercial/reporting, operations and buyer/release gates remain open.


## Session security accepted; independent leave decisions in verification - 2026-11-16

Durable session revocation PR167 merged at `b1822ca9f9683c5eeaf40db6db1d6450ca214fb6`. All 79 exact-head steps in CI43814919022 and all 79 post-merge steps in CI43816509128 passed with no skips or failures. Independent frozen-head review covered all 48 changed paths.

This revision adds [independent leave decisions](../tasks/WOS-05-INDEPENDENT-LEAVE-DECISIONS.md): affected-worker and submitting-account separation, current canonical identity and qualified role-specific delegator scope checks, and a Teams source-workspace boundary. Migration057b adds only a scoped submission-evidence index. Missing or conflicting historical submitter evidence requires cancellation/resubmission; historical decisions are not rewritten. Final exact-head review and hosted acceptance are recorded in the PR. PR168 also refreshes canonical worker codes, worker IDs and qualified director scope on every bearer/cookie request, including identity-only routes. Null canonical links do not fall back to legacy codes. Other legacy delegation domains, commercial source eligibility, exports/diagnostics, persistent throttling and buyer/release evidence remain open.


## Independent leave/current identity accepted; operational CSV safety next — 2026-11-16

[PR168](https://github.com/APReddy-AutoBotz/WorkOS/pull/168) merged at `0d65ab6313d4a26bcc2d14702f7ce6d6e7ab88eb`. Final candidate `0e544a7623d5f349d71f8db1d4aab0570a3d66c9` passed all 82 steps in [CI43830710558](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43830710558); [main CI43832282956](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43832282956) also passed all 82, without skips or failures. Independent runtime and final cleanup reviews passed. Leave decisions now enforce submitting-account/affected-worker independence and qualified role-specific delegation; Teams cannot bypass the source transition. Authenticated requests refresh canonical workforce bindings, including null links and changed employee codes.

The next bounded package is [operational CSV literal-text safety](../tasks/WOS-07-OPERATIONAL-CSV-SAFETY.md), covering the shared exporter and Timesheet Approval Ops Export. This safely precedes the invoice-action source correction, whose commercial modules are absent from current main. Preserve existing scope, filters, audit and source records; no dependency or migration changes. Fresh local acceptance, independent exact-head review and hosted gates are required before merge. Other delegation domains, commercial source authorization, diagnostic disclosure, persistent throttling and buyer/release evidence remain open.


## Operational CSV safety accepted; notification diagnostics next — 2026-11-17

[PR169](https://github.com/APReddy-AutoBotz/WorkOS/pull/169) merged at `88262c87a260529c00a680b22d2f021ff7d8cba4`. Candidate `907f02bb897adb4ad962d62d09647b4c67b776c7` passed all 83 steps in [CI43856156210](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43856156210); [main CI43857837218](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43857837218) also passed all 83 with no skips or failures. Independent exact-head review covered all 18 paths with no findings. Shared and Timesheet Approval exports now use consistent literal-text cell encoding; spreadsheet interoperability limitations remain documented.

The next bounded security package is [scoped and sanitized notification diagnostics](../tasks/WOS-05-NOTIFICATION-DIAGNOSTIC-BOUNDARY.md). It restricts delivery attempts to current recipient organization/entity and worker visibility before the result limit, excludes orphan ownership, and sanitizes provider metadata in new writes and historical attempt/integration/audit readers. Preserve delivery outcome, legitimate operational fields and immutable history. Fresh local, browser, independent exact-head and hosted checks remain mandatory before merge. Commercial-source authorization prerequisites, other delegation domains, persistent throttling and buyer/release evidence remain open.

## Legacy approval/delegation security integration - 2026-11-17

Accepted baseline: PR169 CSV safety merged at `88262c87a260529c00a680b22d2f021ff7d8cba4`; candidate CI43856156210 and main CI43857837218 passed all 83 steps. Earlier next-package references above are historical.

[PR170](https://github.com/APReddy-AutoBotz/WorkOS/pull/170) remains unmerged at documentation head `471234b12ee700657aec80a658195f887ccb3a06`: runtime candidate `5ddb26a15970e34af1e2dbdb198ce21397d5ad9c` passed local checks and a 23-path independent review, but CI44132858216 failed the full dependency audit on unpatched picomatch. Eighty steps passed, one failed and four were skipped. The suggested Vite downgrade was evaluated and rejected because it introduces other high-severity vulnerabilities. No audit waiver or production deployment occurred.

This independent revision implements [legacy approval/delegation ownership and selected-entity scope](../tasks/WOS-05-LEGACY-APPROVAL-SCOPE.md) on accepted main. Actual baseline API execution reproduced recipient ownership takeover and cross-entity approval disclosure; the corrected API and real browser regressions pass. New bounded modules preserve original-owner/scoped-administrator editing, revocation after lifecycle changes, On Leave compatibility and immutable audit evidence. Complete local/hosted gates and exact-head independent review remain required. The shared dependency audit blocker remains open; commercial source integration, remaining security reconciliation, persistent throttling and buyer/release evidence are separate work.

## Settings persistence outcomes integration - 2026-11-17

Accepted main remains PR169 merge `88262c87a260529c00a680b22d2f021ff7d8cba4`, with candidate/main CI both passing 83 steps. PR170 notification diagnostics and PR171 legacy delegation are independent drafts. PR171 runtime `16d9694fe6fb91d66161700d989b80c85b6d2edd` passed local functional/production checks and a 21-path independent security review with no reportable findings; hosted CI44139919944 completed with 81 passed, one failed dependency-audit step and four skipped steps (Compose, container build/startup and Node post-step). The shared full dependency audit flags four high entries in the unpatched picomatch chain. No waiver, unsafe downgrade, merge or production deployment is claimed for those drafts.

The next independent package is [settings persistence outcomes](../tasks/WOS-02-SETTINGS-SAVE-OUTCOMES.md). Baseline browser execution reproduced false success before server acknowledgement and missing failed-load recovery. Scope is truthful save status, retained edits, duplicate prevention, newer-edit distinction, unmount suppression and load retry. Current validation remains required before publication/acceptance. Commercial source authorization, remaining security reconciliation, persistent throttling and buyer/release evidence remain separate.

### PR-008R — Native assignment overlap policy end-to-end

[Lineage and acceptance](../tasks/WOS-04-ASSIGNMENT-OVERLAP-POLICY.md): bounded RES003 configurable native-percentage mechanics on unchanged PR71. Empty prospective immutable policy versions, actual source write/import/SQL enforcement, exact simultaneous interval math, accepted warning/error UI and retained decision evidence close this implementation component. Buyer configuration/adoption remains explicit and absent by default; it is distinct from missing implementation. Source coercion, existing upper bounds and approval/financial history remain unchanged. Required focused and retained exact-head tests precede dependent Draft publication; optional independent/formal reviews remain outstanding. R1 category/context implementation, R3 notifications, R4 protected states, partial R6/R7, R8/R9 downstream reconciliation, remaining R10 and E2/E3 stay finite open work. No merge/deploy or milestone acceptance.


### PR-008V — Native forecast through the guarded planner

[Lineage/acceptance](../tasks/WOS-04-NATIVE-PERCENTAGE-FORECAST.md) on fixed PR75 closes an original-unit percentage forecast → existing guarded planner action → refreshed exact checkpoint → immutable source/server CSV/history path. No hours conversion, buyer default, grant, inferred approval or compatibility replacement. Empty migration062 retains scoped evidence and original replay bytes. Require focused plus retained exact-head PostgreSQL/browser/production and original hosted gates before dependent Draft publication. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR75.md) preserves physical parity and remaining dependencies/proof. Optional reviews outstanding; no merge/deploy or milestone acceptance.

### PR-009A — Explicit submitted-work routing through canonical in-app outcomes

Development-only dependent Draft from fixed PR76; [pre-code acceptance](../tasks/WOS-05-STAGED-WORK-APPROVALS.md) and [finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR76.md). Implements a coherent bounded PR009 work path: explicit prospective worker/stage/template configuration, real manual/both-import source pin, current named-stage handoff, atomic terminal original-work/compatibility/history outcome, mandatory canonical in-app recipient/reason persistence and own inbox/read. No default or grant is installed; old pending sources retain old behavior. Optional completion failure is isolated, no external provider invoked. Migration063 is additive with fresh/062 upgrade/replay checks. Real named Employee daily/weekly submission, two actual configured approvers and strict production/late-response tests supplement retained gates; all final source receipts must be exact. PR009 other source kinds, richer criteria/material change, staged delegation/reassignment, SLA/escalation/bulk and eligible protected-state integration remain; PR013 wider delivery/locales remains. Optional reviews deferred/outstanding, never passed; no milestone/stack/UAT/release acceptance.

### PR-009B — R3 configured UTC producer through the canonical in-app path

Continue the approved deadline handoff from PR008K and INT002's explicit due/overdue recipient matrix on fixed PR77. [Pre-code plan](../tasks/WOS-04-DEADLINE-INAPP-NOTICES.md) `8e7e629` selects authenticated on-demand evaluation with explicit prospective worker/timing/owner/template configuration, current source/period authority, complete atomic mandatory in-app recipients/delivery evidence and the existing canonical inbox/read/history. No external delivery, background principal/schedule, buyer default or grant is installed. Current accepted pending-stage and zero manual/both-import submissions suppress missing-source notifications; ambiguous legacy/correction and closed-period authority stay unavailable. Migration064 is additive and neutral with fresh/063 upgrade/replay checks. Require real source races/recipient failures/retry/dedup/role/scope/owner/browser and exact-head retained gates; publish a dependent Draft and observe its original hosted run. The bounded producer/handoff may receive engineering credit from its own receipts; unattended scheduling, wider profiles/delivery, whole R3/PR013/E2/E3/UAT/integration/release and deferred formal reviews remain open. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR77.md) is explicit.
