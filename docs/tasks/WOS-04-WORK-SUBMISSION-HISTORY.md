# PR-008H: Read-only work submission and correction history

**Status:** Acceptance plan recorded before implementation. Dependent ordinary development only; optional independent/formal reviews remain deferred and outstanding.
**Requirement authority:** WOS-TIM-008 requires preserved prior submitted/approved history and visible rejection reasons; WORK_CAPTURE_AND_TIMESHEET_SPEC.md's Submission and correction/Acceptance cases require preserved submission/decision history. Architecture section5.7 assigns correction/reopen history to work capture. This slice makes already retained evidence inspectable in the existing worker/approver workspaces; it creates no new workflow or buyer policy.
**Fixed dependency:** Draft PR61 `5b301346688b324af6913ae2ef4d66d2be31b7de`, tree `1c88c1b5c92c6957245215d46caaea877740c4ac`.

## Ownership and sequencing

Before development on2026-10-24, only this writer was active, all five Actions queue states were empty, PR61 remained Draft/unmerged at the fixed head, and active controller342036167's latest run40083556930 succeeded on unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`. No monitoring or automation was paused/changed. Continue the approved plan under the owner's standing dependent-Draft development direction; this is not prerequisite, integrated, formal-review or release acceptance. Existing Drafts, main and integration alias remain fixed. PR30 never-merge; denied cumulative reviews/security repairs remain stopped.

## Bounded contract

- Add an on-demand, read-only, paginated retained-submission reader for one existing header. Reuse exactly the existing timesheet-list permission and header visibility predicates, extracted without policy changes. Scope/header authorization applies in the final history query, not a client-side filter. Missing and inaccessible headers share a safe unavailable result. No grant, user/role lookup, new editor or decision authority.
- Return only stored snapshot work dimensions, exact quantities, submission sequence/time/role/source and retained decision time/status/reason/role/source. No rates/costs, raw assignment/commercial policy JSON, external lookups or invented actor display names. Preserve absent legacy evidence/reference metadata and never assign historical checks or decisions that were not retained.
- Descending sequence pages use a bounded numeric before-sequence cursor; expose explicit more/next cursor. No unbounded download of all snapshots. Current Draft/Rejected edits remain separate from immutable submitted content. New submissions/decisions use the unchanged existing writers and immutable tables; no migration/backfill or write-token/work/approval changes are needed.
- A shared worker/approver component opens explicitly, distinguishes loading/empty/denied/unavailable/error states, supports retry and bounded older-page navigation, renders text safely and validated evidence links without fetching. Scope/session/header changes clear old rows/details and suppress late responses; an owner-bound current request is required before displaying results. Current status and history are explicitly distinct. Show historical project reference when no historical project label exists; do not substitute today's renamed project as historical truth.
- Legacy work with no snapshots is explicitly untracked, not inferred Draft/Submitted/Approved history. Reopen policy, state additions, deadlines/grace, overtime, categories/nonclient contexts, import/provider identity and financial/utilization rules remain outside this slice. Their buyer-policy decisions are not invented.

## Acceptance plan

1. Unit/contracts: exact scope-query equivalence, bounded cursor validation, allowlisted DTOs, exact decimals, missing legacy fields and malformed data rejection; owner-bound strict transport without local/demo fallback.
2. Actual PostgreSQL/API: own/scoped role visibility and cross-worker/entity/header negatives; source/decision history through submit/reject/correct/resubmit/approve; original snapshots unchanged, imports retained, legacy empty, cursor pages, safe failures and read neutrality (tokens/work/approvals/audit unchanged). Fresh schema uses existing migrations; no schema change is claimed.
3. Real React/API/PostgreSQL worker/approver journey: explicit load, historical rejection and prior content after correction, reload, legacy empty, retry, pagination, current-vs-retained clarity, narrow/keyboard/text/link behavior and owner/header invalidation with late responses suppressed.
4. Locked install, type/lint, aggregate tests, retained PostgreSQL/migration/browser and production build/identity/container/CI gates. Publish only a tested authorized separate dependent Draft; follow hosted protected runs to terminal at exact head/tree. Optional independent/formal reviews remain recorded as debt, never passed.

## Operations and rollback

Read-only application rollback hides the inspector; existing append-only submission/decision ledgers and their guards remain intact. No destructive migration, data cleanup, deployment, merge, protection/monitoring change, grants, spend, force push, scan or denied operation retry is included.
