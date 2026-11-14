# PR-007A — Commercial drafting foundation

## Development sequencing decision — 2026-10-20

The owner explicitly directed continued substantive WorkOS implementation toward the agreed product plan, without pausing development for formal review; review may occur at the end. The controller records this development-only exception to the open WOS-03 prerequisite. This dependent Draft builds on unchanged PR50 `9d2202c1fc2f73acc5d7ad3da691224e432dd42e`, tree `9cd8367c83c43893fef48376859a696025e93ffd`. It does not claim prerequisite acceptance, programme credit, review clearance, merge authority, production readiness or release acceptance.

Before edits, the isolated snapshot matched that exact tree. At 08:58 UTC, all five repository Actions active queues were empty; latest controller `39386666444` and PR50 CI `39370575941` were terminal success. Main remained `b9a57f8a462d8585bb3f73129080d6fae5173343`. Prior writers released ownership. This work owns the sole product schema/service lane.

## Outcome and requirements

Deliver an actual PostgreSQL/API/React drafting workflow: create a contract/SOW, create an engagement in any of the seven required models, record a PO and a draft milestone, inspect immutable contract terms, and append a future-effective contract revision using optimistic concurrency. This addresses bounded portions of WOS-CORE-003–005, WOS-CTR-001–003 and WOS-ENG-001–002/005. Existing projects receive neutral compatibility mappings without changing their IDs, work, clients, allocations, commercial assumptions or historical dates. The mapping is a migration snapshot, not a claim that legacy project lifecycle is now governed by the new module.

## Integrity and confidentiality

- Scope derives from authenticated current organization/legal-entity ownership. Scoped references are validated server-side. New commercial reads/writes independently require the currently assigned active role and explicit commercial permission; existing audit/identity handlers are unchanged.
- Separate opt-in `commercial.contracts.view` and `commercial.contracts.manage` definitions have no default role or user grants. Buyer administrators can configure them through existing permission administration. No live grants or credentials are created.
- Strict commands reject supplied actor, scope, status and billing authority. Every successful command and its full before/after record share a transaction. Full material evidence, actor/role/reason/correlation/operation live in immutable commercial events. The existing shared audit contract receives only opaque event/snapshot references and generic text, so ordinary audit access cannot leak values, terms, document URLs or entered reasons. Existing audit handlers are unchanged.
- Values use validated decimal strings and PostgreSQL numeric(18,4). The module performs no valuation, PO-consumption, cost/margin or invoicing calculation.
- Contract numbers/clients are stable roots. Append-only terms resolve by effective date; an expected-version token serializes revisions. Revisions must be later than the latest version and later than the current UTC date. References pin immutable term versions; later terms cannot rewrite those drafts or historical work.
- Manual commercial engagements require matching client/model/currency and contract-date containment. Internal/pre-sales engagements require active scoped business-unit/cost-centre attribution, no contract and enforced nonbillability.
- POs and milestones are immutable drafts, never acceptance or billing evidence. Documents are bounded HTTPS metadata only, never fetched or executed.
- New models/lists disclose capped results. Loading/error/empty/denied states and in-flight context ownership are distinct.

## Deliberate remaining PR-007 work

Client legal/billing hierarchy enrichment; manual project/workstream creation/linking and legacy mutation convergence; controlled engagement/PO/milestone revisions and activation/closure; assignment/work/approval/balance closure checks; milestone acceptance and commercial policy all remain open. New legacy projects created after migration are not silently assigned commercial meaning; reconciliation reports unmapped projects. No new close/delete/accept endpoint exists. PR-008 and PR-010–012 own work capture, calculations and billing authority.

Existing reporting-period/catalog upserts are not reused or repaired. The service-safeguard-blocked role-removal audit-access defect and its diagnostic remain unresolved and unchanged. No retry, reroute, security-service clearance, PR30/reference-repository write, live provider, customer write, deployment, merge or Ready transition is included.

## Migration and rollback

Append-only migration 040 adds commercial roots/immutable versions/drafts and neutral project mappings. Fresh and upgrade tests reconcile existing project IDs/counts/history and all scoped constraints. There are no destructive changes to existing tables. Roll forward is preferred. An older pre-040 application is not a supported rollback binary: its migration manifest deliberately rejects unknown040. A validated forward-compatible rollback build may remove the new route/UI while retaining migration040, all tables, mappings and events. Do not drop records, remove migration-ledger entries or deploy an old manifest. Historical version/audit evidence must be retained; backup restoration is a separately approved recovery operation.

## Engineering evidence

Record exact local/hosted results and exact published head/tree in the Draft PR. All existing suites, real PostgreSQL migration tests, browser journeys, identity/fail-closed startup, scans and container gates remain required and unweakened. Local browser/PostgreSQL execution limits must be disclosed, never represented as passes. Formal review can occur at the end, but release/merge/production safeguards remain.


## Current integration checkpoint — 2026-11-14

The owner now authorizes eligible integration and merges. PR50 was accepted at main `9f429fa9753ac2fc77c66b07cad313d82617b7a4`; this candidate integrates its reviewed head `4c4e198baad0024eb1804c5d7cbafaeee4059875`, preserving current dependencies, scanner, import journey cleanup and every accepted CI gate. Historical October local restrictions and no-merge statements above describe that original checkpoint, not current infrastructure or owner authorization. No production deployment or buyer release acceptance is implied.

Current local evidence: fresh npm ci installed 338 packages, audited 345 and reported zero vulnerabilities. Type checking passed; lint checked 133 JavaScript modules. The complete supported-mode aggregate suite passed, including actual PostgreSQL calendar and terminology date coverage. The unchanged hygiene scanner passed 291 files and its adversarial fixtures. Commercial PostgreSQL acceptance passed fresh/upgrade/replay, all seven models, scoped API negatives, immutable/pinned terms, concurrent revisions, decimal/date integrity and transactional audit. Production frontend build passed with fallback disabled.

The actual React/API/disposable-PostgreSQL journey passed sequentially with original assertions and timeouts, after an initial navigation timeout during concurrent startup. The separate fixture browser check is not yet accepted: its first compilation warm-up timed out; a sequential run warmed successfully and progressed to the ownership-race loop, then timed out navigating at test line 123. Preserve these failed receipts; do not represent partial interactions as a full pass. Remaining source review, exact-head security review, fixture-browser resolution and fresh hosted gates are pending. No assertion, scanner or permission control has been weakened.

Follow-up browser evidence: the full fixture regression passed after separating document navigation setup (60 seconds, matching the accepted import journey) from the unchanged 10-second business interaction deadline. No assertions were removed; scope/token/generation/selection/unmount races, duplicate submissions, access denial, malformed responses, keyboard and 390px checks all passed. The earlier navigation failures remain recorded above. PR50 post-merge CI43568347843 passed both jobs and every step. Independent security review and fresh hosted candidate checks remain pending.


## Recovery correction after exact-head review

The immutable integration head `bf84cad00666dd05734af14bc640d3c0b43c2a09` received complete security diff review (scan `79272ec5-68b7-4949-a849-76f19fbcbae6`) with no introduced security candidates. Independent frontend review separately identified a P2 correctness blocker: discarding after an uncertain save cleared the operation lock before the required reload. The correction preserves `uncertain` after discarding, clears only the form and error, and provides an explicit reload message. Existing generation and draft leases still reject obsolete callbacks. Browser regression coverage now checks conflict, 503, network and malformed-response discard/reload behavior, all creation controls, retained discard callbacks and GET-only recovery before creation is re-enabled.

Hosted run43569495393 failed at the initial contract-detail text assertion before React rendered the resolved response. The correction waits for the exact billing-term text before retaining the original content and inert-markup assertions. Downstream skipped checks in that run remain unexecuted, not passes. The initial local correction process handle was lost; no passing result is inferred from it.

Correction validation so far: locked npm ci (338 installed/345 audited/zero vulnerabilities), typecheck, lint133, production build with fallback disabled, scanner291 and diff checks passed. Full corrected browser regression is running; independent correction review and fresh hosted checks are required before merge. No server, schema, permission, financial or audit behavior changes in this correction. It supports the existing WOS-CORE-003/005 drafting recovery contract and has code-only rollback implications; the package migration040 retention requirements above remain binding.
