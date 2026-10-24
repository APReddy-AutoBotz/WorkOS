# PR-008E: Optional task, ticket or milestone reference text

**Status:** Acceptance plan recorded before implementation; dependent development only. Optional independent/formal code and security reviews are deferred and outstanding.
**Authority:** PRODUCT_REQUIREMENTS.md §10, WOS-TIM-003: a work entry supports an "optional task/ticket/milestone reference"; IMPLEMENTATION_BACKLOG.md PR-008 explicitly includes work references; WOS-04 issue #6.
**Dependency:** Unchanged Draft PR58 head `39cf7e10537972e232498a6a99a1f89df05c765b`, tree `f042e173de542dc54845a2f73677072f87d35a05`.

## Selection, ownership and sequencing

This slice follows the evidence-link dimension already delivered in PR58. It is selected directly from the approved requirements/backlog and PR-008B's explicit task-reference deferral, not from a security or gap review. The owner authorized sequential ordinary development with optional reviews deferred to the end. This is a narrow development-sequencing exception only: no prerequisite acceptance, stack integration, merge, release/programme credit or deployment is claimed.

Pre-implementation checks on 2026-10-24 found no peer writer or active implementation process; all five queried Actions activity states were empty. PR58 remained Draft/unmerged at the exact dependency above. Main remained `b9a57f8a462d8585bb3f73129080d6fae5173343`; the legacy controller's latest run `40047943605` succeeded on that main. Monitoring and controller settings are unchanged. PR30 remains never-merge. The denied cumulative review and separately denied security repair remain stopped; no review, scan or security repair is part of this feature.

## Bounded implementation contract

- Add one optional plain-text task/ticket/milestone reference to an individual existing work entry. Use the common label "Task / ticket / milestone reference (optional)" in daily/weekly entry editing and display it as escaped text for retained/read-only entries.
- The reference is descriptive text, not a foreign key, source identity, duplicate key, billability signal, milestone acceptance, financial allocation or external integration. Examples are a task ID, ticket ID or milestone label. No lookup, fetching, preview or provider mapping is introduced. Authoritative milestone/entity relationships remain outside this bounded text-reference dimension.
- Support up to 200 characters of Unicode text; trim surrounding whitespace; reject control characters, multi-line values and invalid Unicode. Explicit null/blank clears it. This is a routine transport bound, not a new business policy.
- Manual entry API/read uses `work_reference`; both existing import aliases use `workReference` within their unchanged versions and duplicate/group/idempotency rules. No CSV template change is included.
- Preserve omission independently for evidence URLs and the new reference. A uniquely matched existing context retains omitted metadata; an ambiguous or context-removing replacement with omitted prior nonempty metadata conflicts before work writes. Complete explicit values/nulls acknowledge full replacement. A caller that only understands evidence links must not erase newer reference text.
- Preserve mode switching, full-header saves, hidden/weekend/context/zero entries, exact quantities, existing scope/worker/assignment/period/CAS/approval rules and immutable submitted/correction history. New snapshots/audit include the reference. Historical snapshots without it remain unchanged and comparable when the current reference is null.
- Add only nullable migration048 and a bounded shape constraint; do not rewrite previous migrations, work, grants, snapshots or financial data. Existing complete-row write revisions must notice reference-only changes.

## Required acceptance plan

1. Unit/contract tests: valid Unicode, limits/invalid controls, omission versus clear, mixed metadata independence and duplicate/context conflicts; grid/service save transport and hidden/context/zero preservation.
2. Real PostgreSQL/API: fresh install, 047 upgrade/replay, neutral existing work/grants/immutable JSON; manual save/reload/clear and reference-only stale conflicts; old evidence-aware client omission; both import aliases, preview/replay and explicit replacement; existing scope/status/period denials; Submitted/Rejected/correction snapshots and legacy approval compatibility.
3. Real React/API/PostgreSQL journey: daily/weekly editing, reload/clear, escaped rendering, mode/hidden/weekend/zero/context preservation and stale tabs. No external request caused by displaying the reference.
4. Locked install, type/lint, aggregate unit/contracts, applicable retained PostgreSQL/migration/browser and production build/startup checks. Publish only a separate dependent Draft with exact head/tree and executable receipts. Existing CI gates remain enabled; no scan/review is manually requested or substituted for engineering tests.
5. Record optional independent/formal reviews as outstanding. Do not declare full WOS-TIM-003, PR008, prerequisite or integrated acceptance.

## Operations, rollback and exclusions

Keep additive migration048 and immutable history on rollback; supply no destructive down migration. Pre048 applications do not understand reference preservation, so restoring one requires work writes to remain operationally disabled until an aware binary is restored. This is guidance, not permission to alter any running system.

No authoritative task/milestone catalog or binding, new categories/deadlines/evidence policy, approval redesign, protected reopen, resource/financial logic, uploads, providers, grants, spending, deployment, merge, force push, protection or monitoring change is included. If the feature needs any such semantics, stop that expansion and report the precise decision.
