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

On 2026-10-20, the controller recorded the separate [Actual Utilization detail read-recovery exception](../tasks/ACTUAL-UTILIZATION-READ-RECOVERY.md), dependent on unchanged PR44. Its atomic three-reader/four-business-endpoint recovery and current-evidence export guards preserve existing month/status/search, calculations and CSV/helper/audit semantics, including logs with empty report employee rows. Forecast, broader reporting, backend/security/schema/dependency work and blocked diagnostics remain excluded; all programme/dependency/review/merge/release boundaries remain unchanged.

On 2026-10-20, the controller recorded a separate [Forecast Utilization detail read-recovery exception](../tasks/FORECAST-UTILIZATION-READ-RECOVERY.md), dependent on unchanged PR45. Its five existing readers form a current horizon-keyed frontend snapshot, preserving ten nested/duplicate business GET contracts and every successful horizon/date/calculation/omission-or-zero fallback semantic. Safe failure recovery and current-evidence export guards do not alter backend, auth, normalizers, schema, dependencies or export-helper/audit behavior. Independent roll-offs/charts survive section-empty success. Blocked security work remains excluded; all programme/dependency/review/merge/release gates stay unchanged.

On 2026-10-20, a separate [organization profile editor increment](../tasks/ORGANIZATION-PROFILE-EDITOR.md) was recorded as a bounded WOS-02 non-overlap exception, stacked on unchanged PR46. It closes the existing WOS-ORG-001 ordinary metadata UI gap and adds a WOS-ORG-010 profile entry point, preserving the existing server permission, resolved scope, version transaction and audit. Captured identity/permission/scope and generation guards protect pending reads/drafts/mutations. Existing security repairs, legal-entity lifecycle, schema, credentials and whole-setup completion remain excluded; all prerequisite/review/owner/UAT/merge/release boundaries remain unchanged.


On 2026-10-20, the controller recorded a separate [terminology configuration editor increment](../tasks/TERMINOLOGY-CONFIGURATION-EDITOR.md), stacked on unchanged PR47, as a bounded existing WOS-02 non-overlap exception. It closes the existing WOS-ORG-006 buyer-facing editor gap and only a WOS-ORG-010 entry point. Canonical keys, server guards/scope/version transaction/audit and existing consumer coverage remain unchanged. Scope-owned drafts/saves, a minimal runtime stale-response guard and terminology-only date transport are included; branding, readiness writes, security repairs, schema and grants are excluded. All formal prerequisites/review/owner/UAT/merge/release gates remain unchanged.


On 2026-10-20, a separate [working calendar inspector increment](../tasks/WORKING-CALENDAR-INSPECTOR.md), stacked on unchanged PR48, was recorded as a bounded existing WOS-02 non-overlap exception before product writes. It adds only a read-only WOS-ORG-008 calendar inspector and WOS-ORG-010 calendar entry point. Existing GET scope/permission/ownership/predicate/order/limit contracts stay intact with narrowly scoped DATE-as-text transport. Catalog mutations remain NO-GO pending retired-lineage reactivation and reference-semantics decisions. No calendar mutations, worker assignments, capacity integration, grants, security repairs, schema or credentials are included. All formal prerequisites/review/owner/UAT/merge/release boundaries remain unchanged.

On 2026-10-20, the separate [integrated import-to-audit acceptance journey](../tasks/IMPORT-AUDIT-ACCEPTANCE-JOURNEY.md) was recorded before edits as a bounded WOS-03 tests/CI/docs-only non-overlap increment stacked on unchanged PR49. It closes the evidence gap between mocked component browser fixtures and separate real API/PostgreSQL tests for one Project Master validate/apply/reload/reviewer-provenance flow. No production/schema/permissions/grants/dependencies or export scope changes. Product defects are separate-scope findings, not fix authority. All twelve existing browser suites, prerequisite chains, blocked security exclusions and formal review/owner/UAT/merge/deployment/release gates remain unchanged.

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

### PR-008D development-only continuation: optional evidence references

Under the owner's 2026-10-24 instruction to continue permitted development and defer optional reviews, implement [work-entry evidence links](../tasks/WOS-04-WORK-ENTRY-EVIDENCE.md) on unchanged PR57 `02c024d45621fe516e0a46f21657a37f2a1e4532`. Preserve existing scope/assignment/period/immutability/CAS semantics, add shared omission-versus-clear preservation for manual and both import writers, retain links across full-header UI saves and immutable correction history, and prove fresh/upgrade/replay plus real React/API/PostgreSQL journeys. Keep the dependent PR Draft/unmerged. The cumulative review remains stopped; no stack integration, protection/monitor changes or programme acceptance is authorized by this slice.

### PR-008E development-only continuation: task/ticket/milestone reference text

After PR58's exact-head engineering receipt, continue the explicitly approved WOS-TIM-003 reference dimension under [PR-008E](../tasks/WOS-04-WORK-ENTRY-REFERENCE.md), on unchanged PR58 `39cf7e10537972e232498a6a99a1f89df05c765b`. The acceptance plan was committed before product edits as `040e02b`. Deliver optional descriptive per-entry text without provider/entity lookup or business authority, independent evidence/reference preservation, existing history/CAS controls and fresh/upgrade/replay plus real React/API/PostgreSQL proof. Keep the separate dependent Draft unmerged. Optional reviews are deferred; no cumulative review/scan/security repair, new business-policy scope, integration, protection/monitoring change or programme acceptance is authorized.

### PR-008F development-only continuation: required evidence URL option

Follow PR59 with [the approved TIM005 evidence requirement](../tasks/WOS-04-REQUIRED-EVIDENCE-POLICY.md), based on unchanged PR59 `c8fcafd6b61c7e9407aaf623a23001ad144b6ef1`. The acceptance plan was committed before implementation as `680088e`. Extend existing legal-entity/Weekly capture policy with a buyer-selected positive-entry URL requirement; preserve omissions for older API/SQL editors, work-date authority, zero exemption, metadata/history and all existing controls. Do not install a requirement by default or invent category/group exceptions, overtime, deadlines or reopen policy. Require exact-source engineering tests and terminal hosted runs; keep the new dependent Draft unmerged. Optional formal reviews and broader milestone acceptance remain outstanding, without retrying denied reviews/repairs or changing monitoring/protections.

### PR-008G development-only continuation: identical saved-entry content advisories

Continue WOS-TIM-012's permitted flagging behavior under [PR-008G](../tasks/WOS-04-IDENTICAL-ENTRY-FLAGS.md), based on unchanged Draft PR60 `a283b7d9e0fc5ac23536e12f1b914a9a91a78fad`. Plan commit `b7501ee` precedes implementation. Add deterministic within-header exact-content groups, server-derived last-saved worker/approver advisories and nullable immutable new-submission checks. Preserve distinct context, comments/references, exact quantities, hidden/weekend/zero rows, existing CAS/scope/period and approval rules, and both import aliases' partial/natural-key contracts. No automatic deduplication, hard rejection or financial effect is introduced. Full cross-header/upstream identity semantics, TIM012/PR008 acceptance and optional formal reviews remain open. Require real API/PostgreSQL/browser and retained engineering gates, then keep the dependent Draft unmerged without altering the stack or monitoring.

### PR-008H development-only continuation: retained work history inspector

Continue WOS-TIM-008 and the work-capture specification's prior submission/decision history under [PR-008H](../tasks/WOS-04-WORK-SUBMISSION-HISTORY.md), based on unchanged Draft PR61 `5b301346688b324af6913ae2ef4d66d2be31b7de`. Plan commit `2b4d596` precedes implementation. Add explicit on-demand worker/approver inspection of the existing immutable snapshots,10-version cursor pages, prior reasons/content/source and honest legacy gaps. Share existing header-read scope verbatim, preserve owner isolation and exact quantities, and keep all writers/workflows/policies/financial behavior unchanged. Require real role/API/PostgreSQL/browser proof and retained engineering gates, then publish a separate dependent Draft and observe hosted CI to terminal. No grants, schema/backfill, reopen/deadline/overtime/category rules, stack integration or monitoring changes; broader acceptance and optional formal reviews remain outstanding.

### PR-008I bounded evidence continuation and defined finish

Before further implementation, reconcile approved PR008 through PR62 using [the finite28-requirement matrix and R1–R10 remainder](../tasks/WOS-04-PR008-ACCEPTANCE-CHECKLIST.md). Preserve its distinction between implemented/partial/missing engineering evidence and formal acceptance, eight missing business-policy decision groups and excluded optional extensions. Continue one safe existing specification outcome as [E1 named worker/approver capture-cycle evidence](../tasks/WOS-04-CAPTURE-ROLE-ACCEPTANCE.md) on unchanged PR62 `0eaf501b4988af107d1a503fe93ccab96b2eb96f`; the checklist/acceptance plan commit precedes test implementation. Actual Employee UI submission/correction and distinct approver rejection/approval must pass without Admin demo overrides or changed product rules. Keep this test/documentation dependent Draft unmerged; R1–R10 and final integration/review/UAT gates remain finite outstanding work, not authority for an open-ended sequence or invented policy.

### PR-008J: R2 configurable standard-threshold capture treatment

Resolve D1–D8 against [approved sources and accepted decisions](../tasks/WOS-04-POLICY-DECISION-RESOLUTION.md), rather than requesting eight blanket policy approvals. Continue [R2 / PR-008J](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md) on unchanged Draft PR63 `b40712739d613d5fef9f8b4926d70f1e691e9b08`; plan commit `c60292ad5bcc5faceff37cd7282a42ecba19c995` precedes implementation. Add explicit buyer-configured daily/Weekly thresholds and warn/block in existing scoped immutable prospective capture policy, with no installed thresholds/default adoption. Preserve exact manual/import totals, hard maxima, owner/session/data scope, replay, submission history and prior decisions. Require focused fresh/upgrade/replay, negative/concurrent SQL/API and actual React/API/PostgreSQL evidence plus all retained gates. Publish one dependent Draft and observe hosted CI to terminal. No payroll/legal determination, financial change, exception authority, merge/deploy, denied review/repair retry or monitoring/protection change. Optional formal reviews and full milestone/integrated acceptance remain outstanding.

### PR-008K: R3 explicit submission deadline/grace mechanics

Continue the well-specified WOS-TIM-007 legal-entity option under [PR-008K](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md) on fixed Draft PR64 `e80fdc634277ffd05648117f98ff345c4e60054f`, with the plan committed before implementation. Require explicit supported UTC anchor, period-relative date/time, grace and warn/block inputs; never infer a browser/worker timezone or install a buyer value. Preserve immutable prospective policy/CAS, Draft editing, accepted decision history, manual/import controls and exact replay diagnostics. Validate real PostgreSQL migration/API/direct-SQL boundaries, real settings/worker/import/approver UI journeys, owner isolation and retained suites, then publish a dependent Draft and follow CI to terminal. This closes the bounded configuration/enforcement/evidence outcome; specified canonical overdue notification handoff/delivery remains a later dependency, not a new scheduler/recipient grant or full R3/milestone acceptance. Optional formal reviews remain deferred/outstanding. Prior Drafts/main and monitoring remain fixed; denied reviews/repairs stay stopped.

### PR-008L: R5 explicit source-linked work identity

Continue [R5 / PR-008L](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md) from fixed Draft PR65 `4b34af26ea2400c9b81af8d909ced6edbd4755be`, under TIM003/011/012 and D5's already specified create/conflict discipline. Commit `42b68e2fa7223134ec4122e5cea9260fd1ed172b` records lineage/acceptance before implementation. Add explicit optional case-sensitive namespace/worklog IDs, scoped append-only source claims, cross-header collision rejection, source-preserving manual/both import/CSV/full-header UI/history, retained batch check acknowledgement and exact replay. Newly tagged work opts into fixed captured content; untagged work and old controls remain unchanged. No provider lookup, inferred legacy match/default, changed-source relinking, approval/financial authority or live connector is created. Require focused real PostgreSQL/API/UI and all retained engineering gates, publish only the dependent Draft with exact receipts, observe CI to terminal. Optional formal reviews, R3 notification dependency/UTC limits, finite R1/R4/R6–R10 and integrated/UAT/release gates remain open. No merge/deploy or monitoring/access/protection changes.

### PR-008M — Structured workforce capabilities continuation

From fixed PR66, [PR-008M](../tasks/WOS-04-WORKFORCE-CAPABILITIES.md) delivers WKF004's structured worker skills/proficiency, explicit certification validity/no-expiry, availability notes and deterministic exact scoped planner search, with append-only versions/CAS/audit and actual HR/Employee browser/API/database evidence. Plan precedes implementation; no buyer vocabulary/rank/default, provider verification, new grant or capacity/assignment effect is inferred. Keep this dependent Draft unmerged. This closes only the capability-record/filtering boundary within R8; demand/assignment integration and other finite outcomes/reviews/integration/UAT/release remain outstanding. PR66 source provenance/amendment and R3 UTC/notification limits remain unchanged.

### PR-008N — Demand-to-recorded-assignment acceptance continuation

From unchanged PR67, [PR-008N](../tasks/WOS-04-RESOURCE-DEMAND.md) closes the coherent RES007/R8 recording path: explicit demand, exact scoped capability candidates, actual existing Allocation Control assignment creation, explicit source-revision reference/planning status, reload/history and visible source staleness. Migration055 preserves all earlier work/assignment/capability/approval/financial evidence, permissions and buyer defaults. This delivers bounded engineering acceptance of the capture/match/reference path, not quantitative fulfilment or full R8/PR008 integration acceptance. Nonexclusive documentary links do not reserve capacity, convert percentage/hours or grant approval; R6/R7/R9 and the finite checklist's remaining outcomes/gates remain open. Keep dependent Draft unmerged and all prior heads fixed.

### PR-008O — Effective capacity authority through demand planning

From fixed PR68, [PR-008O](../tasks/WOS-04-EFFECTIVE-WORKER-CAPACITY.md) implements R6's coherent explicit prospective schedule/calendar/eligible-denominator/approved-absence authority and consumes actual period totals in the existing demand journey. Pre-code plan `785f5d98cbd1cad82f83eb439172525c94ac88fe` establishes prerequisite ordering: R7 quantitative overlap/assignment and R9 reconciliation depend on this authority. Explicit baseline/part-time/seven-day schedule, eligibility and calendar references activate no buyer defaults; migration056 creates empty immutable scoped stores. Require exact math/calendar precedence, fresh/055 upgrade/replay neutrality, real leave approval/owned worker/demand UI/API/database, stale source/CAS/history/scope, retained engineering and exact-head hosted gates. Unambiguous per-date approved absence and full-date overlaps are resolved; ambiguous legacy multiday/partial allocation and missing/retired calendar source cases remain specifically unavailable without conversion/repair. R6/PR008 acceptance is still partial. Existing reports are not relabeled, assignments/demand quantities are not converted, and no approval/protected-reopen/financial authority is invented. Preserve prior Drafts/main/integration; optional formal reviews and integration/UAT/release gates remain outstanding.

### PR-008P — Existing percentage assignment version authority

From fixed PR69, [PR-008P](../tasks/WOS-04-ASSIGNMENT-VERSION-AUTHORITY.md) closes the bounded R7 source-version boundary through actual Allocation Control creation, exact guarded update with separate R6 context, named Employee UI work submission/version pins, and later manual/import/end history preservation. Plan `9f497ca486d3bcb7ff2e7c23289d0a253055062a` precedes code. Empty migration057 captures future source writes without migration backfill, buyer policy/default/grant or historical reconstruction. Existing permission/relationship/date/billability/selected legacy overlap and approval-record behavior remain; no percentage↔hours conversion or generic financial/approval authority. Unspecified range-hours distribution/denominator, cost/revenue rates, capacity-derived overlap policies and configurable material approval remain exact R7 dependencies rather than reasons to halt source versioning. R6 remains partial for its legacy/reference/conversion/report/composite cases; other finite outcomes and deferred formal/integration/UAT/release gates remain open. Require fresh/056 upgrade/replay, real SQL/API/import/history/scope/transport and actual React/Employee journeys plus retained exact-source gates; dependent Draft only, prior heads/main/integration fixed.

### PR-008Q — Own-worker selected-period integration

[Plan and acceptance](../tasks/WOS-04-OWN-WORK-PLANNING.md): bounded R10/WKF007 capacity/assignment/current-work/history integration on fixed PR70. Canonical server account binding, exact R6 daily/period totals, bounded original-unit assignments with R7 version references, saved-versus-retained work states and actual Employee Workspace read-only inspection/work-capture handoff. No migration, defaults, grants, conversion, writer or protected-reopen change. Required production-transport/API/real Employee React/PostgreSQL journeys and retained gates precede dependent Draft publication; exact-head receipts belong to that Draft. Optional independent/formal reviews remain deferred, not passed. R1/R3/R4/R6/R7/R8/R9 and R10's planner/hierarchy/unified utilization/actions, E2/E3 remain finite outstanding outcomes. No merge/deploy or milestone acceptance.

### PR-008R — Native assignment overlap policy end-to-end

[Lineage and acceptance](../tasks/WOS-04-ASSIGNMENT-OVERLAP-POLICY.md): bounded RES003 configurable native-percentage mechanics on unchanged PR71. Empty prospective immutable policy versions, actual source write/import/SQL enforcement, exact simultaneous interval math, accepted warning/error UI and retained decision evidence close this implementation component. Buyer configuration/adoption remains explicit and absent by default; it is distinct from missing implementation. Source coercion, existing upper bounds and approval/financial history remain unchanged. Required focused and retained exact-head tests precede dependent Draft publication; optional independent/formal reviews remain outstanding. R1 category/context implementation, R3 notifications, R4 protected states, partial R6/R7, R8/R9 downstream reconciliation, remaining R10 and E2/E3 stay finite open work. No merge/deploy or milestone acceptance.


### PR-008V — Native forecast through the guarded planner

[Lineage/acceptance](../tasks/WOS-04-NATIVE-PERCENTAGE-FORECAST.md) on fixed PR75 closes an original-unit percentage forecast → existing guarded planner action → refreshed exact checkpoint → immutable source/server CSV/history path. No hours conversion, buyer default, grant, inferred approval or compatibility replacement. Empty migration062 retains scoped evidence and original replay bytes. Require focused plus retained exact-head PostgreSQL/browser/production and original hosted gates before dependent Draft publication. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR75.md) preserves physical parity and remaining dependencies/proof. Optional reviews outstanding; no merge/deploy or milestone acceptance.

### PR-009A — Explicit submitted-work routing through canonical in-app outcomes

Development-only dependent Draft from fixed PR76; [pre-code acceptance](../tasks/WOS-05-STAGED-WORK-APPROVALS.md) and [finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR76.md). Implements a coherent bounded PR009 work path: explicit prospective worker/stage/template configuration, real manual/both-import source pin, current named-stage handoff, atomic terminal original-work/compatibility/history outcome, mandatory canonical in-app recipient/reason persistence and own inbox/read. No default or grant is installed; old pending sources retain old behavior. Optional completion failure is isolated, no external provider invoked. Migration063 is additive with fresh/062 upgrade/replay checks. Real named Employee daily/weekly submission, two actual configured approvers and strict production/late-response tests supplement retained gates; all final source receipts must be exact. PR009 other source kinds, richer criteria/material change, staged delegation/reassignment, SLA/escalation/bulk and eligible protected-state integration remain; PR013 wider delivery/locales remains. Optional reviews deferred/outstanding, never passed; no milestone/stack/UAT/release acceptance.

### PR-009B — R3 configured UTC producer through the canonical in-app path

Continue the approved deadline handoff from PR008K and INT002's explicit due/overdue recipient matrix on fixed PR77. [Pre-code plan](../tasks/WOS-04-DEADLINE-INAPP-NOTICES.md) `8e7e629` selects authenticated on-demand evaluation with explicit prospective worker/timing/owner/template configuration, current source/period authority, complete atomic mandatory in-app recipients/delivery evidence and the existing canonical inbox/read/history. No external delivery, background principal/schedule, buyer default or grant is installed. Current accepted pending-stage and zero manual/both-import submissions suppress missing-source notifications; ambiguous legacy/correction and closed-period authority stay unavailable. Migration064 is additive and neutral with fresh/063 upgrade/replay checks. Require real source races/recipient failures/retry/dedup/role/scope/owner/browser and exact-head retained gates; publish a dependent Draft and observe its original hosted run. The bounded producer/handoff may receive engineering credit from its own receipts; unattended scheduling, wider profiles/delivery, whole R3/PR013/E2/E3/UAT/integration/release and deferred formal reviews remain open. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR77.md) is explicit.


### PR009C — Local-only material assignment approval candidate

From unchanged PR78, [pre-code plan](../tasks/WOS-05-MATERIAL-ASSIGNMENT-APPROVALS.md) selects RES008/009 and APR001/002/003/006: explicit prospective workers/material fields/named held-role stages, exact existing-percentage-assignment before/after proposals, unchanged effective source while pending/rejected, current-source/permission/scope/date/overlap revalidation and atomic final source/version/compatibility outcome. Canonical approval in-app recipients/reasons/accepted delivery/read persist atomically; optional completion failure is isolated. Migration065 is empty/additive, with no defaults/grants/backfill. Manual/strict/end/both-import/SQL paths cannot bypass configured material approval; nonmaterial changes preserve earlier behavior and stale older proposals. Creation gating, identity transfers, conversions, financial treatment and protected reopen are unavailable. This is authorized local implementation/testing only: parent publication continuation was rejected for insufficient specific authorization, so no push, PR creation, hosted run or alternate publication route. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR78.md); optional reviews remain deferred/outstanding. No integration/merge/deploy/UAT/release acceptance.


### Local PR009D — Configured assignment-creation approval

From fixed PR80, [plan](../tasks/WOS-05-ASSIGNMENT-CREATION-APPROVALS.md)3b03bdd precedes code for the remaining RES008 creation branch and APR001/002/003/006. Explicit prospective worker/creation option/named stages/templates use the existing engine. Pending/intermediate/rejected requests create no allocation/version/reservation; final current source scope/relationship/date/billability/overlap validation atomically creates exact assignment/V1/history and terminal compatibility outcome. Mandatory canonical in-app handoff/rejection is atomic; optional completion is isolated. Both import aliases retain row-error/dry-run/replay behavior and all source writers/SQL deny bypass. Additive066 retains old policy/material/work/history, with no buyer values, grants or destructive conversion. Real configuration/demand/candidate/Allocation Control request -> approvals -> effective demand reference/own/native projections/inbox and late-owner journeys plus fresh/065-upgrade/replay, negative/current/concurrent contracts and full frozen local gates are required. This phase is local implementation/testing only: no push/new Draft/hosted action, integration, merge or deployment. Return exact head/tree/tests and a dependent Draft proposal for a separate authorized publication phase. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR80.md); optional reviews remain deferred/outstanding, never passed. No transfers, conversions, financial/reopen authority, external delivery or controller/monitoring/protection changes.

### Local PR009E — Reviewed bulk decisions

On fixed PR81, [plan](../tasks/WOS-05-REVIEWED-BULK-DECISIONS.md) eabbad2 precedes APR008 implementation for the existing governed work/material/creation paths. Explicit retained-source inspection, per-item decisions/reasons and immutable request snapshots feed unchanged strict production/server commands, independently retaining current authority, source/stage/period checks, atomic effects and canonical notification history. Mixed results are shown per item; uncertainty/owner changes stop unsent writes and require explicit read-only exact-request reconciliation before any same-key retry. Real React/API/PostgreSQL and production coordinator negatives supplement all retained local gates. No new batch authority, grant/default/migration, external delivery, conversion/transfer/reopen/delegation/SLA or manager mapping. LOCAL ONLY: return exact frozen head/tree/tests and a separately authorized dependent Draft proposal. Prior published heads/main/alias and monitoring stay fixed; optional reviews outstanding and integration/UAT/release remain separate. [Finite remainder](../tasks/WOS-04-REMAINDER-AFTER-PR81.md).


Subsequent bounded delivery update: dependent Draft publication of this configured creation feature is authorized after all frozen local gates pass. Earlier local-only statements record the initial development phase, not a publication result. Publish against unchanged PR80 with expected-head/absent safeguards, inspect only source/synthetic tests/technical documentation for the outgoing patch, and observe exact-head hosted gates. This adds no merge/deploy, policy/default/grant expansion, review/security retry or monitoring/protection authority. No private conversation belongs in repository or action payloads.

PR009F local increment: [explicit prospective current-stage due/overdue in-app plan](../tasks/WOS-05-APPROVAL-DUE-INAPP.md), grounded in APR005/INT002. Only explicitly selected new-instance, elapsed-UTC stage timing is supported; no buyer duration/default, scheduler, retrospective adoption, recipient authority grant or external delivery. Additive067 and required unit/client/PostgreSQL/React integration proofs preserve earlier decision/source/history contracts. [Finite remainder after PR82](../tasks/WOS-04-REMAINDER-AFTER-PR82.md) keeps wider SLA/routing/domain/period authority and integration/review/UAT/release open. This is local implementation, not publication or milestone acceptance.

Independent local PR008/009 E2 acceptance component: [staged-work/calendar-leave proof](../tasks/WOS-04-STAGED-WORK-LEAVE-PROOF.md) connects existing WKF003/005/007, TIM010, APR003/006 and RPT002/006 through real named stages, leave approval/cancel, exact own/report capacity/numerator and retained CSV/history. Tests/fixtures/traceability and normal test wiring only; no new feature semantics, runtime/migration/default/grant or release/integration acceptance. It remains a separate local candidate based on PR82 and does not replace or publish the frozen PR009F candidate.

PR009G bounded configured canonical leave: [committed plan and implementation contract](../tasks/WOS-05-CANONICAL-LEAVE-APPROVAL.md), [composition provenance](../tasks/WOS-05-LEAVE-COMPOSITION-PROVENANCE.json) and [finite remainder](../tasks/WOS-05-LEAVE-REMAINDER.md). Explicit prospective named leave routing, immutable edit/stage/cancel history, exact final calendar/balance/source effect, canonical atomic in-app handoff and native optional due clocks use existing leave authority only. Required real React/API/PostgreSQL zero-capacity/cancel/immutable-export proof supplements the preserved unconfigured sibling proof. Final exact-source gates and dependent Draft hosted validation are required; no main integration/review/UAT/release acceptance is implied. Published PR83/84 remain fixed, optional formal reviews outstanding, release and main integration remain outstanding.


PR009H reviewed bulk Leave: [committed acceptance plan](../tasks/WOS-05-BULK-LEAVE-DECISIONS.md) extends PR009E to the governed leave path delivered by PR009G, based on unchanged PR85. Existing per-item commands/transactions and named permissions govern all four currently supported kinds; no batch authority, default, grant, migration or external delivery. Exact frozen checks and a dependent Draft's hosted acceptance are required. Wider APR coverage and integration/reviews/UAT/release remain separate.

PR009I local component: prospective canonical delegation for the four existing governed domains, scoped by explicit workers, original held role, named delegate and UTC interval. [Acceptance plan and limits](../tasks/WOS-05-CANONICAL-DELEGATION.md). Both existing accounts retain their own source authority; empty migration069 adds no live policy, role or grant and never backfills legacy/old stages. Required gates include actual React/API/PostgreSQL direct/delegate/revocation races, exact receipts, owned in-app handoff, lifecycle/stale refusal, real UTC expiry, nonempty068 upgrade/replay and immutable capacity/export history. This local component has no publication/integration/release acceptance yet; formal reviews remain deferred and outstanding.

Bounded E2 import/approval/export proof from preserved PR86: [plan](../tasks/WOS-04-IMPORT-APPROVAL-EXPORT-PROOF.md). Existing modern import UI and both authenticated aliases connect to named work approval, actual/own/report/export and protected historical evidence. This is tests/synthetic fixture/traceability and necessary test wiring only; no new feature or business policy. Independent of frozen local delegation4124cd1; no composition or main integration. Require fresh exact-head locked install plus all67 commands, with distinct receipts/proposal and no local-task publication.


Local E2 imported-work/delegated-approval composite: [plan and limits](../tasks/WOS-05-IMPORT-DELEGATION-PROOF.md), [pinned composition](../tasks/WOS-05-IMPORT-DELEGATION-COMPOSITION.json). Existing TIM import/evidence, APR prospective delegation and scoped actual/export contracts are connected without runtime/schema/default/grant changes. Real modern CSV UI and legacy API, original/delegate inbox, reviewed per-item lost ACK/revocation/reconciliation and exact retained history/CSV proof must pass new combined-source local gates. Publication is a separate proposal against preserved PR87 declaring PR88's proof dependency. Main/alias and published sibling heads remain fixed; no review/integration/UAT/release acceptance is implied.

### PR009 configured pending-stage reminder completion

[Requirement lineage and acceptance](../tasks/WOS-05-CONFIGURED-APPROVAL-REMINDERS.md): implement APR005's explicit prospective pre-due reminder mechanism on preserved PR89, with unchanged pinned PR87/88 proof lineage. Use an empty additive migration, separate immutable reminder policy linked to an exact due version, current named-stage/delegate recipients, atomic mandatory canonical in-app handoff and exact-request read-only reconciliation. Actual UTC timing, complete-recipient failure/replay, old-cohort exclusion, all four domains, production React and retained full gates must pass on its own frozen source. Only the PR89 base branch filter is added to CI; no permissions, jobs, protections or controller changes. [Finite limits](../tasks/WOS-05-REMINDER-REMAINDER.md) distinguish the bounded implementation from buyer adoption, unattended/external delivery, wider approval domains and final review/integration/UAT/release.

### PR013 operational control workflow development boundary

[Operational control plan](../tasks/WOS-07-OPERATIONAL-CONTROL-WORKSPACE.md), committed a5c23be before runtime changes, selects the existing RPT001 dashboard and R10 connected operational gap on preserved PR90. This is an operational development sequencing exception while commercial/finance modules remain incomplete, not an integration/acceptance waiver. Use existing exact work/capacity/native sources and current scoped approval readers; server scope precedes counts/drilldown, bounded pagination is roster/selection/context bound, and independent source commands remain authoritative. New React manager/report workflow reaches retained review, named-stage decisions, refreshed actual/native results and immutable governed CSV without policy/default/permission expansion. Require new exact-source full local and hosted gates, preserve all prior Draft heads/main/alias/controller and disabled automation, and publish only the dependent Draft against PR90. Optional final formal reviews, wider reporting/finance, protected-state/unknown conversion work, integration/UAT/release remain outstanding.

### PR008 canonical own-worker workspace forward development

The WKF007 current owned profile/leave/work/actual/canonical-inbox workflow is developed as a bounded direct dependent of fixed PR91. [Lineage and acceptance](../tasks/WOS-04-CANONICAL-OWN-WORKSPACE.md) are committed before code; [finite remainder](../tasks/WOS-04-CANONICAL-OWN-REMAINDER.md) separates missing financial/hierarchy implementation, genuine authority/configuration questions, deferred reviews, main integration, UAT and release. This is development sequencing only: no prior stack acceptance, main integration, financial prerequisite waiver or merge is implied. Existing Friday-header and future-work guards remain, and API/React/SQL source provenance is disclosed rather than treating different work records as one submission. Final exact-head local and hosted receipts remain mandatory before delivery; optional final formal reviews are deferred, not passed.

### PR008 scoped directory continuation

The bounded WOS-WKF-008 recorded directory/hierarchy navigation workflow follows PR92 directly, as described in `docs/tasks/WOS-04-SCOPED-WORKFORCE-DIRECTORY.md`. This ordinary development sequencing continues already-approved PR008 read/relationship behavior and consumes no sibling composition. Scope, roles and original capability/capacity commands remain authoritative. New engineering evidence is reported separately from prior Draft receipts, merged programme credit, qualified final reviews, UAT and release.
