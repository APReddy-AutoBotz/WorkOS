# PR-008D: Optional work-entry evidence links

**Status:** Integration candidate with local acceptance passed; independent exact-head review, hosted acceptance, merge and release acceptance remain outstanding.
**Requirements:** Bounded WOS-TIM-003 evidence-link dimension; preserves WOS-TIM-001/004/008/009/011/012 and WOS-NFR-DAT-002/004/005/006/008, UX-001/003/005.
**Original development source:** Issue #6 and PRODUCT_REQUIREMENTS.md §10. Exact unchanged PR57 dependency `02c024d45621fe516e0a46f21657a37f2a1e4532`, tree `dae711a60a422d7129c28f1dae47d949258b8021`.

## Current integration checkpoint - 2026-11-15

The owner subsequently authorized reviewed integration and eligible merges without routine approval requests; the development-only sequencing narrative below is historical context, not the current merge policy. Original PR58 `39cf7e10537972e232498a6a99a1f89df05c765b` is integrated with corrected PR57 candidate `01bb4fa6de46ddf210915a85f94381b81c6be5b9` at `dea0f694ebb8ee6a6b0abd10eda550f702a54fed`. PR57 fresh hosted acceptance remains pending at this preparation checkpoint; no prerequisite acceptance is inferred.

PR57 subsequently passed every corrected-head step in CI43629036849 and merged at `07967fddfe8ae0e6304d338db2f71b9f7e3a2198`; every step of its resulting main CI43629890280 also passed. This does not accept PR58.

The merge retains all parent scripts, patched dependencies, strict mode/history response validation, keyed editor ownership, abandoned-save recovery and synchronized timing assertions. An executable comparison confirmed every parent script and complete parsed dependency/lockfile content; an initial raw-text comparison differed only because the Windows checkout uses CRLF. New evidence tests and migration047 expectations are additive. Fresh local integration tests, independent exact-head review and hosted gates remain required before acceptance. No deployment or historical evidence rewrite is included.

Fresh locked installation audited 345 packages with zero reported vulnerabilities. The initial bootstrap scan rejected two literal credential-bearing URLs used as negative fixtures. Both fixtures now construct their rejected URL with the existing ephemeral synthetic credential generator, retaining the embedded-credential rejection assertions. The corrected bootstrap and adversarial fixture scan passed; no scanner rule or allowlist changed. Full integration acceptance is still in progress.

Local integration receipts: `npx tsc --noEmit`, `npm run lint` and the full `npm test` aggregate passed. `test:work-evidence-postgres` passed real PostgreSQL fresh/046-upgrade/replay, unchanged grants and historical snapshots, manual save/read/clear, omitted-field preservation/conflicts, evidence-only stale revision rejection, scope negatives, immutable correction/approval history and both import aliases. The final production frontend build passed in 19.57 seconds. Accepted main ancestry was merged at `3dd7d86b40738e76a3ab31fe30d907e5f523088a` without runtime changes. The first browser attempt timed out at initial page navigation before feature assertions; retained suites did not run in that attempt. The unchanged retry passed the real evidence journey, retained timesheet ownership timing journey and real capture-mode journey, with zero page errors or evidence URL dereferencing. No timeout or assertion was weakened. Independent review and hosted acceptance remain outstanding.

## Development-only sequencing exception

The owner instructed continued ordinary product development on 2026-10-24 and deferred optional code/security reviews until the end. This authorizes only this separate dependent Draft slice on unchanged PR57. It does not accept or integrate the preceding stack, retry the stopped cumulative review or denied security repair, authorize merge, change protections or monitoring, or earn programme/release credit. Required engineering tests remain applicable; deferred reviews must be recorded as outstanding. PR30 remains never-merge.

Before implementation the sole writer checked that no peer agents or implementation processes were active, GitHub Actions had no queued/in-progress runs, PR57 retained the exact source above, and the legacy controller's latest run `40047943605` succeeded on unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`. The new branch is isolated from the original source/worktree and integration alias. Monitoring is not paused or altered.

## Bounded behavior

- An individual daily/weekly work entry supports one optional absolute HTTP/HTTPS URL, up to 2048 characters. Blank/null explicitly clears; surrounding whitespace is trimmed. Relative URLs, other schemes, embedded credentials, whitespace/control characters and backslashes are rejected. The field is a reference, not an uploaded file or an assertion about the destination.
- Entry remarks editing also edits that date's optional evidence URL. Valid links render as ordinary escaped anchors with `noopener noreferrer`; no URL fetching, preview, crawling or external integration is introduced. Submitted/read-only entries retain visible links.
- Migration047 adds only nullable `timesheet_entries.evidence_url` with a bounded shape constraint. Existing work, permissions, immutable submission/decision JSON and migration files are not rewritten. The existing complete-row revision automatically includes evidence-only changes.
- `POST /api/timesheets` accepts optional entry `evidence_url`; reads return it. Both `/api/imports/timesheets/apply` and `/api/v1/imports/timesheets/apply` accept optional row `evidenceUrl` under their existing schema/version, grouping, duplicate, idempotency and transaction rules. No CSV template or new upstream row identity is required by this slice.
- Omission preserves the link when the prior and incoming work context match uniquely: date, work type, project/client and category. Hours, comments and effective billability may change without losing the link. If an omitted-field replacement would remove linked context or cannot match it uniquely, reject with `WORK_EVIDENCE_REPLACEMENT_CONFLICT`; do not infer, duplicate or erase links. Old clients with no prior links retain their existing replacement contract. Complete explicit evidence fields acknowledge a full replacement, including intentional context removal. This compatibility rule is shared by manual saves and both import aliases, including versioned previews.
- The current UI sends explicit URL/null values for every retained entry. Mode switching, hidden/weekend/context splitting, exact decimals and zero-entry preservation remain lossless. No new mandatory-evidence policy is adopted.
- Existing scope, permissions, worker/assignment/work-date/period rules, status transitions and concurrency checks remain authoritative. No grant or approval behavior changes. New immutable submission snapshots include `evidenceUrl`; corrections create a new snapshot, leaving earlier URLs and decisions unchanged. Historical snapshots without this additive key remain comparable only when current evidence is null. Work audit events include before/after entry evidence references.

## Executable evidence

- `test:work-evidence`: URL and contract validation, omitted/null/explicit replacement behavior, ambiguous contexts, and exact hidden/context/zero grid preservation.
- `test:work-capture-modes-service`: actual production transport includes omission versus explicit null/link without changing the owner-bound context or mode/CAS trio.
- `test:work-evidence-postgres`: fresh install, 046 upgrade, replay and neutral history/grants; real manual save/read/clear; legacy replacement conflicts; evidence-only stale token; scope rejection; immutable Submitted/Rejected/correction/Approved history; both import aliases, dry-run and replay.
- `test:work-evidence-journey`: real React/API/PostgreSQL save/reload/clear, validation/rendering, daily/weekly switching, hidden/weekend/zero/context preservation and evidence-only stale tabs. Observes requests to prove displaying evidence causes no external request.
- Required retained install, type/lint, unit/contracts, migrations/PostgreSQL, affected browser journeys and production build/startup gates remain applicable. CI includes the new dependent base and feature gates without weakening existing gates. Receipts must identify the exact tested/published source; prior PR57 results are not this feature's acceptance.
- Independent code and security review remain outstanding acceptance gates for this integration candidate. The earlier deferral is historical; neither successful review of PR58 nor closure of inherited security findings is claimed.

## Operations, rollback and exclusions

Keep additive migration047 and immutable histories on rollback; no destructive down migration or URL/history deletion is supplied. A pre047 application does not understand preservation on replacement: keep work writes disabled operationally if such a binary must be restored, then roll forward to an evidence-aware application before resuming writes. This is rollback guidance, not authorization to change any running deployment.

No uploads, URL dereferencing, mandatory-evidence policy, task/ticket/milestone model, categories, deadlines, overtime, approval redesign, protected reopen, assignment-versioning, financial behavior, external provider or deployment is included. Full WOS-TIM-003, PR008 and programme acceptance remain open.

## Separate PR-008E continuation

The task/ticket/milestone model exclusion above is addressed only as descriptive optional reference text by separate [PR-008E](WOS-04-WORK-ENTRY-REFERENCE.md), based on unchanged PR58 `39cf7e10537972e232498a6a99a1f89df05c765b`. It supplies no authoritative task/milestone relationship. PR-008D's URL behavior remains bounded and the preceding stack is not accepted/integrated.
