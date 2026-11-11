# Operational attention workspace

## Outcome and lineage

This independent product slice turns the existing operational-control snapshot into a searchable, prioritized attention queue. It builds on the exact published PR113 source (`f34d91ef866e423ab0e320f6a710ca082f6e3f79`, tree `c901fcaa90da41ff5de187590cf4035d951627c9`), not on the inaccessible Admin candidate. All 1,134 baseline files were verified against the published Git blob hashes. The local snapshot commit has reconstructed history only; it is not the original remote commit and must not replace its ancestry when publishing a dependent patch.

Requirements addressed: bounded WOS-RPT-001/002/005, WOS-WKF-008, WOS-CORE-003/005 and WOS-NFR-UX-001/005. Existing IAM-003/005/010 and APR-003/006/008 authority is retained, not extended. This adds useful presentation and handoff capability, not full reporting, Admin, PR013 or product completion.

## Operator workflow

1. Open Reports → Operational control and explicitly choose actual dates and the existing native forecast horizon.
2. Load the scoped snapshot. **What needs attention** summarizes only the workers on the current returned page. The full roster count elsewhere is not a queue denominator or a company-wide signal total.
3. Filter pending reviews, staffing signals or data gaps. Search names, worker codes and visible source details. The queue initially shows eight items; **Show more** reveals additional matches without fetching or combining other pages.
4. Open the original actual, forecast or approval source. The handoff keeps its original worker, period or pending-source identity. Opening does not automatically read a fresh source, approve, save, export or retry. Existing source controls still require deliberate inspection and independently authorized commands.
5. Refresh the snapshot after a source change. A new source page resets the queue filters. Scope/account/role/token changes and late responses continue to clear the entire snapshot and handoff.

Data gaps appear first, then pending reviews oldest first, then staffing signals. Pending age is whole elapsed days at the observation timestamp, never an overdue/SLA assessment. Visible source IDs and stages distinguish review items. Search and filtering are ephemeral and never persist worker or source data to browser storage.

## Meaning and safeguards

- Summary counts cover the current page's returned sources. Categories overlap. Limited, unavailable and restricted review sets remain explicit; no hidden count is inferred from them.
- Actual/forecast `unavailable` produces a data gap. `not_applicable` is not a missing-data failure and is never converted to zero utilization.
- Staffing bands reuse already-decoded, available dated native forecast points and existing configured thresholds. No default threshold, new quantity calculation, demand fulfillment, physical percentage-to-hours conversion or aggregate utilization is introduced.
- Recorded future/today assignment endings are signals only, not claims that the worker will be unstaffed.
- All exact source rows/items pass through the existing `owned()` guard and original independently authorized handoff components. No backend, permission, migration, grant, financial rule, policy default or database write changes.
- Search is labelled, category selection exposes pressed state, live results have status text, long source text wraps, source handoffs receive focus and Close returns it to the opener. Runtime keyboard/mobile verification remains required where browser execution is available.

## Tests and verification boundary

`npm run test:operational-attention` runs ten pure-model cases, the actual production decoder plus projector against synthetic responses, and React server-render checks. It is appended to the existing `npm test` gate without removing any tests. The existing operational-control browser journey also imports the new synthetic attention journey; it supplements, not replaces, its real PostgreSQL journey.

`npm run test:operational-attention-browser` runs the standalone real React/production transport journey with intercepted synthetic API responses. It covers page-only/limited/restricted controls, search and ordering, bounded reveal, exact source handoffs without automatic API actions, focus return, mobile fit, paging reset, stale context/late-response suppression and failed-source isolation. Optional `WORKOS_CHROMIUM_PATH` selects a browser executable; optional `WORKOS_ATTENTION_SCREENSHOT_DIR` writes synthetic screenshots.

Local execution on 2026-11-11 established locked dependency installation, model/decoder/render checks, type checking, syntax linting and frontend build. Chromium launch was attempted but the environment refused its local socket (`Operation not permitted`) before browser assertions ran, including under the normal reviewed escalation. The environment restriction was not changed. Thus browser interaction and visual validation are **not passed**. PostgreSQL, fresh/upgrade migrations, real API/role decisions, hosted CI, formal review, UAT and release were not validated in this slice. The full unit command also stopped at the pre-existing `tsx` CLI IPC-socket restriction. Its assignment-approval service module passed separately via the repository's normal `node --import tsx` module loader; this is not a full `npm test` pass. An initial invocation without the documented CI test-mode variables stopped at the expected fail-closed backend requirement. Preserve the exact validation receipt with the eventual patch rather than reusing older PR evidence.

## Recovery and rollback

The inaccessible Admin candidate `ea9619448524fff5085e9e80e850213e1d0e5282` is neither overwritten nor represented as recovered. Existing published Drafts and main remain unchanged. Revert this additive UI, presentation model and tests to roll back; no stored data conversion or database rollback is needed. Do not merge or release based on this local receipt. Resolve remaining browser/hosted/dependency gates separately without weakening them.
