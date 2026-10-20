# PR-008A — Assignment and work-date convergence

## Bounded implementation continuation

Continue the owner's 2026-10-20 direction to build the agreed product without a formal-review development pause. The isolated implementation starts from Draft PR54 head `b0c441bb101106dafe8ba1d17d72659b1257fd82`, tree `6679e8f26b48863ab843680239ed98f69d8c7f04`, with unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`. A fresh pre-write check found no active repository Actions queue or competing writer and a successful terminal controller. The bounded outcome was selected after inspecting the actual resource/work specifications and every runtime writer. Keep this dependent PR Draft, unmerged and undeployed. Development continuation does not grant programme, prerequisite, UAT or release acceptance.

## Outcome and authority

This first PR-008 slice addresses WOS-CORE-003–005, WOS-RES-002/009 and bounded WOS-TIM-004/008/009/011. Assignment and work writers share server-owned scope, worker timeline, project hierarchy, lifecycle and explicit adopted-term authority. Governed project, engagement and applicable contract must each be Active on the relevant date and each independently adopted snapshot must cover it. Parent adoption never implicitly repins a child. A whole assignment interval is divided at worker/lifecycle/amendment boundaries, including interior gaps and holds. New commercial versions alone do not change delivery authority. A shared scope lifecycle lock and worker/row locks serialize writes against existing commercial adoption and project promotion commands.

Ordinary internal/pre-sales projects use the same controlled flow, enforce non-billability and retain null contract references. Legacy projects and unbound work remain explicitly neutral, not inferred commercial models. Existing IDs and historical work are not migrated to invented terms, repriced or billed. Project and assignment policy constrain incoming billability on the server; non-billable work cannot be made billable through a forged client value.

## Runtime writer inventory

- Manual `POST /api/allocations`: validates target dates and both old/new active-role relationships; preserves scoped ID upsert and existing overlap settings.
- `DELETE /api/allocations/:id`: retains authorized soft-ending, never creates an end before a future start and never rewrites retained work.
- Shared legacy/v1 Allocation Control import: identical dated policy in preview/apply, scoped old/new relationships, existing natural-key/idempotency/batch behavior and overlap guard.
- Manual `POST /api/timesheets`: shared entry policy and atomic new submission evidence; only Draft/Rejected periods are editable.
- Shared legacy/v1 Timesheet Import: same work-date and seven-day rule, max 100 entries per period, consistent preview/apply protection, Draft/Submitted only, no overwrite of Submitted/Approved work, and a pending source approval for new submissions. Idempotent replay remains an already-completed result, not a fresh apply or policy exception.
- Direct timesheet and generic approval status commands: every stored entry date and the period end remain subject to the existing reporting-period decision guard. Generic work decisions additionally require the work approval permission. Submitted content must match immutable retained evidence. Existing direct/delegated scope remains authoritative; self-decision is denied.
- Teams evidence-only approval actions: fail closed for timesheets and direct the operator to the source-aware approval workspace. Other entity behavior is unchanged.
- Legacy project completion: the existing governed-project guard remains authoritative, so it cannot cascade a governed assignment change.
- Demo seed/reset: preflight protects governed/retained work across all affected employees, not only demo project IDs. Existing neutral Submitted/Approved periods are skipped by ordinary reseed; reset refuses to delete accepted work rather than silently rewriting IDs/history.

Normal allocation/work/approval commands remain legacy API routes. Only existing shared import aliases have v1 parity; no new v1 command aliases are claimed. Local/demo storage is not commercial authority.

## Immutable evidence and confidentiality

Additive migration044 creates append-only submission evidence and a decision linked to its exact submission sequence. A new submission retains full safe work content, server-derived billability, assignment policy snapshots, opaque project/engagement/contract lifecycle/adoption/version references, policy version, reporting-period references, actor, role, source and correlation/operation identity. Rejection/correction retains the original submitted content and decision while permitting a new sequence. Database triggers prevent rewriting retained submitted/approved headers or entries through an alternate writer. Legacy work is not backfilled and is visibly unpinned.

Broad work APIs expose only submission ID/sequence, policy version and counts, not commercial values, billing terms, financial documents or protected commercial reasons. The operator assurance appears in self-service and submission review. It expressly does not mean billing eligibility or invoice readiness. Allocation save failures are announced in the existing form instead of only being logged to the console.

## Verification and operation

Required gates: focused production policy/transport tests; fresh/043-upgrade/replay preservation; actual PostgreSQL/HTTP scope, lifecycle, adopted-date, internal/non-billable, correction/history, race/idempotency and period-lock negatives; real React allocation → import dry-run/apply → submission assurance → held-state rejection journey; all fourteen retained synthetic browser suites and all previous real journeys; full lint/typecheck/unit/build, migration/concurrency, dependency/secret, container and exact-head hosted CI gates. Positive-offset server-timezone coverage proves current work never inherits a locked prior-day period through PostgreSQL DATE conversion. Missing required PostgreSQL or Chromium services are failures, not successful skips. Local runtime socket restrictions are not bypassed; hosted CI supplies actual database/browser proof when necessary. Failed attempts remain in the execution record.

Operational handling: after an uncertain import result, retry the same existing operation key or read retained batch/history; never invent a duplicate apply. On history/period/lifecycle conflicts, reload the source and correct only an editable Draft/Rejected period. No new exception bypass exists for a locked period, inactive hierarchy or assignment rule. Existing protected period/approval policy must authorize any later exceptional workflow. Do not delete the new ledgers to roll back. Retain migration044 and its database protections; use a forward-compatible binary for rollback, not a pre-044 writer that cannot honor retained evidence. The general operations runbook is unchanged.

## Still open

This is not completion of PR-008. Configurable capture modes/categories, increments/limits/deadlines/evidence rules, protected reopen policy, richer capacity/skills/demand and assignment versions remain subsequent slices. PR-007 PO consumption/balances, milestone acceptance, approved-unbilled evidence and terminal close remain later finance/approval dependencies. Their absence is unknown, never zero. Contractless material amendments remain unsupported by PR54; this slice does not invent them. No new default/live grants, credentials, customer data, deployment, Ready, merge, excluded repository/PR work or blocked security diagnostic is included.
