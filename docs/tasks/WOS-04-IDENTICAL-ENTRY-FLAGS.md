# PR-008G: Identical saved-entry content advisories

**Status:** Integration in progress against accepted PR60 `703ed725e689ae133f6d4c375c76fc2829a0dec2`. Original acceptance plan `b7501ee` preceded implementation. Fresh local acceptance, independent exact-head review and hosted gates remain required before merge.
**Authority:** WOS-TIM-012 expressly permits preventing **or flagging** duplicate manual/imported work using deterministic keys. WORK_CAPTURE_AND_TIMESHEET_SPEC.md requires duplicate work to be blocked or deterministically flagged. PR-008 includes duplicate protection. This slice implements an advisory, not a new rejection, approval or financial policy.
**Dependency:** Accepted PR60 `703ed725e689ae133f6d4c375c76fc2829a0dec2`, merged as `2f4712dec4d546438a6f852b1bb4c83d6567c87c`.

## Current integration authority

The owner subsequently authorized enterprise review, corrections, integration and eligible merges. That authorization supersedes the development-only review/merge restrictions recorded below. Keep this package Draft until its own executable acceptance and independent exact-head review pass. No deployment or full TIM012 acceptance is implied.

## Historical ownership and sequencing

Pre-implementation checks on 2026-10-24 found only the sole writer active, no active/queued/waiting/requested/pending Actions runs, and PR60 Draft/unmerged at the fixed dependency. Main remains `b9a57f8a462d8585bb3f73129080d6fae5173343`. Legacy controller342036167 is active; its latest run40067543400 succeeded on unchanged main. Monitoring is not paused or changed. This is the owner's standing approved-plan development continuation, with exact requirement/authorization evidence retained for publication and all actual platform denials respected. No prerequisite/integrated acceptance, merge, deployment or programme credit is claimed. PR30 remains never-merge. Denied cumulative reviews/security repairs remain stopped.

## Deterministic bounded behavior

- Within one saved header only, flag groups of distinct physical entries with identical work date, work type, project/client context, category, exact canonical hours, authoritative billability, comment, evidence URL and work reference. Quantity normalization equates decimal spellings such as 0.25 and 0.2500 without Number rounding. Other text/reference values remain exact; differing contexts, quantities or references are not flagged as identical.
- Check all saved entries, including zero entries, as an informational content check. IDs and input order are not content keys; stable groups contain actual persisted IDs, never caller-supplied flags/identity. The rule is versioned `exact-entry-content/1`. Grouping compares full canonical content rather than relying on hash equality.
- Return the server-derived check on manual save/read. Existing scope, permissions, worker/assignment/date/period/capture requirements, exact quantities, whole-header CAS, source/status and approval behavior stay unchanged. No entries are removed/merged, no hours/billability/counts are adjusted, and no new save/submission/approval block is introduced. Identical content can represent an intentional split, so the UI asks for review rather than declaring certainty.
- Show the last saved header's advisory in existing worker and approver assurance UI. Unsaved edits do not claim to have been checked. Clear owner-bound diagnostics on the worker workspace's existing scope/session/load invalidation. Do not add reads outside existing authorized timesheet rows.
- Persist each new submission's versioned check in nullable immutable submission metadata. Corrections retain prior checks and create a new snapshot/check. Existing submission JSON, decisions, work and grants are not rewritten/backfilled. Old null metadata means no retained historical check, never an inferred clean result. Current saved-header diagnostics are explicitly separate from retained submission checks.
- Keep both import aliases' existing natural duplicate keys, row errors, preview/apply/idempotency and partial-result contracts. Their new successful submissions retain the same content check. No source identifiers are fabricated, no cross-header/source/provider correlation is attempted, and no import matching/merging rule is changed.
- Add only migration050's nullable diagnostic metadata; no work/policy authority function is weakened. Unknown/invalid legacy content yields unavailable diagnostics without breaking historical reads or claiming a clean check.

## Required acceptance plan

1. Unit/contract: canonical exact decimal equality, input-order/ID independence, meaningful field differences, zero entries, valid/empty/unavailable checks, immutable inputs and invalid DTO handling without false clean results.
2. Real PostgreSQL/API: fresh/049 upgrade/replay neutrality; server-only manual save/read flags with actual stored IDs; distinct contexts preserved; source/CAS/period/authorization behavior unchanged; new submission checks immutable through reject/correct/approve and legacy decisions; both import aliases retain their existing partial-result contract (accept the first valid row, report the duplicate row), preview/replay and successful submission behavior.
3. Real React/API/PostgreSQL: worker sees/reloads last-saved warnings, meaningful changes clear them after save, mode/hidden/weekend/zero entries persist, stale saves cannot replace accepted flags, scope invalidation clears diagnostics, and approver sees retained/current flags without changed decision behavior. Escaped text, no external calls and the applicable React implementation checklist remain required.
4. Locked install, type/lint, aggregate unit/contracts, retained migration/PostgreSQL/browser and production build/identity/startup/CI/container gates. Publish an authorized separate dependent Draft only after applicable tests, then follow hosted protected runs to terminal at exact head/tree. Independent exact-head code/security review is required under current authorization.
5. Keep remaining release/buyer acceptance explicit. Full WOS-TIM-012/PR008, cross-header/upstream-source identity semantics, broader work categories/deadlines/overtime/reopen and integrated acceptance remain open.

## Operations and exclusions

Retain additive migration050 and immutable submission checks on rollback; no destructive down migration is provided. Older applications ignore the optional diagnostic metadata; they do not gain historical check claims. No running deployment is changed.

No new hard duplicate key/rejection threshold, automatic deduplication, source/provider lookup, assignment or approval redesign, financial exclusion, categories, deadline/overtime/reopen policy, permission/grant, spending, merge/deployment, protection/monitoring change or destructive cleanup is included. Any need for those semantics is a separate explicit decision.

## Reviewed integration candidate evidence (2026-11-15)

Integrated accepted PR60 at `c5b6890e57bbe9c35b63f8898c88f560e0b4dace`, then its accepted main ancestry at `5ea8b5acc44827a5c33c79a6a8971109752a22f4`. Preserved parent dependencies, parsed lockfile, existing scripts and aggregate test prefix by executable comparison. Timesheet conflict resolution retains owner-keyed mounting, pending-save ownership, blocked-state handling and loaded-only assurance while adding owner-bound duplicate diagnostics. No parent runtime behavior was intentionally removed.

Local locked installation passed (338 packages, 345 audited, zero reported vulnerabilities). Type checking, lint (194 JavaScript modules) and the complete unit/contract aggregate passed. Dedicated real PostgreSQL/API fresh/049 upgrade/replay, legacy neutrality, manual/import scopes and CAS, persisted identifiers, retained submission/correction checks and unchanged totals/approval passed. Production build after aggregate artifact tests passed in 20.04 seconds.

The first browser attempt timed out on initial local fixture navigation before assertions. An unchanged retry passed all four sequential gates: duplicate worker/approver journey, required-evidence journey, timesheet ownership browser and real capture-mode journey. No timeouts or assertions were weakened. This recurring local cold-start limitation is not a product-performance acceptance claim.

Initial source scanning rejected a static revision value in the new unit fixture. Replaced it with the existing ephemeral synthetic digest helper, preserving the revision-projection assertion; focused tests and the 391-file source scan passed. Independent exact-head review and new hosted CI remain required. Existing whole-repository audit findings, broader TIM012 and release/buyer acceptance remain open.
