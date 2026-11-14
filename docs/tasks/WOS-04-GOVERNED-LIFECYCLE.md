# PR-007B — Exact-version activation and governed projects

## Development sequencing and baseline

The owner's 2026-10-20 direction is to continue the agreed product implementation without a formal-review development hold. This is a development-only sequencing exception, not acceptance of open prerequisites, programme credit or release/merge/production authority. This isolated dependent Draft starts from accepted PR51 head `78aeb15ebace7bb598f09f06e7f306efaafef4e7`, tree `8460c3d60710dcdc907740976a3cc96fe1a94259`. Before edits at 09:54 UTC, remote PR51/PR50/main were unchanged, controller39386666444 and CI39402523856 were successful and all five active Actions queues were empty. The sole WorkOS product lane is owned by this task; test/UI helpers have disjoint file ownership.

## Bounded product outcome

Addresses additional WOS-CTR-001/003 and WOS-ENG-001–005 portions through actual PostgreSQL/API/React workflows:

- Activate a contract on the immutable version effective on the server's current UTC date. Activate a manual engagement only against that exact active contract pin, validated dates, active scoped owner/client/model/currency; internal/pre-sales attribution remains required and non-billable.
- Append `Active` / `On Hold` transitions using an expected lifecycle sequence, reason and optional approval-reference metadata. The server supplies the effective UTC date, actor, active role, correlation and operation. Approval-reference metadata is not an approval decision or proof of one. No backdating or scheduling is implemented in this increment. First transition must activate; subsequent states alternate. Pinned terms cannot be replaced by a lifecycle command. A separate future amendment workflow is required for repinning/rollover.
- Hold governed children before their parent; resume parents before children. No child, allocation, work or commercial record is implicitly closed, paused, rewritten or recalculated.
- Create and immediately activate one or more real projects/workstreams under an active engagement. Derive model/currency/client/attribution and exact contract pin server-side. Scoped managers must cover dates; project dates fit engagement dates and cover today. Commercial budget allocations use PostgreSQL numeric addition and cannot exceed engagement budget. These are planned allocations, not consumption, cost or invoice valuation. Internal/pre-sales project commercial allocation is zero and billability is false.
- Explicitly promote an existing Proposed project only when code, name, manager, client, dates and billability match the selected immutable engagement binding command exactly, with no assignment or work history. Preserve the original project ID, neutral migration mapping/source snapshot and all histories. Previously active/completed or used legacy projects need a later governed conversion; this task does not silently reinterpret them.
- Inspect append-only lifecycle history and actual existing closure dependencies. Terminal close/delete remains unavailable. Count open assignments, draft/submitted work, pending timesheet approvals, unaccepted milestones, related draft POs and owner availability. Approved-unbilled registration, commercial balances/PO consumption and milestone acceptance/settlement are explicitly unavailable, never assumed zero. Even all existing counts at zero do not authorize closure.

Immutable PR-007A Draft tables, contract terms, POs, milestones and neutral mappings are unchanged. Lifecycle status is separate, not a rewrite of Draft snapshots. The project status alone is transactionally projected to the operational projects row so existing operational readers see Active/On Hold.

## Common mutation boundary and legacy preservation

The complete legacy writer inventory was inspected before implementation: project POST/upsert, PATCH status (including allocation completion side effects), both aliases of Project Master CSV dry-run/apply, client POST's indirect project-name/identity cascade, both aliases of client CSV dry-run/apply and explicit non-production demo seed/reset. No runtime project-delete or separate workstream table exists.

All these application writers acquire the same scope lifecycle lock before existing code/row locks. Governed rows are rejected with stable409 `GOVERNED_PROJECT_MUTATION_REQUIRED`; mixed imports roll back the whole attempted command, including any earlier row, batch/audit/idempotency changes, rather than silently changing governed rows. Dry-run reports the same conflict before claiming applicability. The database trigger independently rejects arbitrary governed project update/delete; its only nested allowance is exact status/updated_at synchronization to the latest lifecycle event, with every other field invariant. No caller-settable session bypass exists. Explicit demo seeding fails closed on governed IDs before reset work.

Unmapped and neutral-only legacy projects keep their existing CRUD/import behavior. Existing immutable neutral mappings measure migration-snapshot coverage, not the existence of new governed bindings. Local/demo frontend storage is not a second commercial authority. Existing allocation/work-capture writers are not converged to every engagement/work-date policy by this task; PR-008 integration remains necessary. Active/On Hold must not be advertised as a completed work-capture or financial lifecycle.

## Permission, confidentiality and integrity

Add opt-in `commercial.lifecycle.manage`, with no role/user/default grant. Lifecycle mutations require commercial view plus this separate permission, independently of draft-management privilege. All references and current assigned role/scope are server checked; no live identity/provider/customer/grant/credential change occurs.

Detailed before/after/root snapshots, reasons and audit context are retained in append-only commercial lifecycle events. The shared Audit Trail receives opaque references and generic text only, never budgets, terms, documents, entered reasons or confidential snapshots. History/dependency readers require commercial view. No general audit/identity handler or denied role-removal repair/diagnostic is changed, inspected or retried.

The ledger enforces scoped roots/pins, sequential bounded history, valid alternating states, current server date and immutable entries in PostgreSQL. Scope-level serialization also protects parent/child transitions, creation/budget races and explicit legacy promotion. Every mutation and opaque shared audit pointer commit together; a failed audit rolls back the business command and operational projection.

## Validation and remaining work

Dedicated strict schema/router/service tests, actual fresh/upgrade/replay PostgreSQL/API/concurrency/legacy-path evidence and real React/API/PostgreSQL journey are required in addition to every retained gate. Local Chromium is NOT RUN under the existing restriction, with no workaround/retry. No local disposable PostgreSQL is present; required database tests must fail without configuration rather than skip successfully. Full exact-head hosted CI, final tree/readback and receipt are required before closing this bounded engineering increment. Record actual executed results, failures and limitations in the Draft PR.

Remaining PR-007 includes client legal/billing hierarchy, governed material engagement/project amendments, broader legacy-history conversion, future scheduling/term rollover, PO/milestone lifecycle and complete dependency-safe closure. PR-008/010–012 retain work capture, calculations, consumption/balances, milestone acceptance and invoice authority. Full PR-007/WOS-04, open prerequisites, production OIDC/UAT and formal release gates are not completed by this slice. No PR30/reference-repository write, merge, Ready transition or deployment.

## Migration and rollback

Migration041 is additive: one opt-in permission, immutable project bindings, immutable lifecycle events and integrity/projection guards. Fresh and upgrade paths preserve existing IDs/rows/mappings/events; migration040 is not edited. Roll forward is preferred. A pre-041 binary is not a supported rollback because its manifest correctly rejects unknown041. A separately validated forward-compatible rollback build must retain migrations040/041, bindings, ledger and project guards, disabling UI/routes as necessary. Never drop evidence, remove migration records or weaken guarded legacy paths to make rollback work. Backup restoration is separately approved recovery, not a casual code revert.

## Integration receipt — 2026-11-14

The owner now authorizes eligible merges after review and executable acceptance. Historical development-only, unavailable-local-environment and no-merge statements above describe the original package, not current authorization or tooling. PR51 is accepted at `cc44a12c08ba7c3b3ec03d1d458baaa76a1744bb`; its exact-head CI43612214189 and main CI43612745307 passed every step. Documentation PR151 is accepted at `73210c55458ae0d6be0ff0f566396284349e9665`. This isolated lifecycle integration preserves their dependency repairs, scanner, recovery correction and all accepted aggregate/hosted tests. Two conflicts in package/workflow configuration were resolved by retaining every accepted test and adding lifecycle gates; the dependency lockfile is unchanged relative to accepted main.

Local evidence at integration checkpoint `0464dd894c51ae07ac6c5048a149e0b0006aaf7b` (subsequent merge changes three documentation files only):

- Locked installation passed: 338 packages installed, 345 audited, zero vulnerabilities reported. Typecheck passed; lint syntax-checked 140 modules.
- The aggregate suite passed through organization-profile service, then failed its required PostgreSQL date check because localhost port55432 was unavailable. A separate lifecycle PostgreSQL attempt failed with the same connection refusal. The existing synthetic cluster was confirmed stopped and restarted. Every remaining aggregate command was then executed successfully, starting with organization-profile dates and continuing through terminology, calendar, commercial drafting and lifecycle contracts/services. Profile/terminology/calendar PostgreSQL date cases passed in UTC, Asia/Kolkata and America/Los_Angeles. Neither failed attempt is counted as a pass or acceptable skip.
- Bootstrap scan passed across 303 files; adversarial scanner fixtures also passed without relaxing scanner rules.
- Actual lifecycle PostgreSQL acceptance passed fresh install, populated040 upgrade, replay, all seven models, permission/scope negatives, immutable pins, atomic legacy promotion, concurrent sequence/budget protection, legacy writer/import rollback, audit integrity and database tamper guards.
- Production frontend build with fallback disabled passed (35.74 seconds).
- The first real browser journey failed its 15-second initial navigation while the production build was running concurrently. The unchanged complete journey passed sequentially after the build: React/API/disposable PostgreSQL activation, two projects including same-ID promotion, hold/resume dependencies, history/readiness/reload, audit confidentiality, reader/denied/context-invalidated behavior and preserved legacy history. No deadline or business assertion was weakened.

Independent exact-candidate review, hosted integration checks and final merge eligibility remain pending. This is local engineering evidence, not whole WOS-04 completion, deployment or release acceptance. The frozen full-audit findings remain open.
