# PR-008C: Explicit Daily and Weekly Work Presentation

**Status:** New dependent implementation candidate; exact-head engineering acceptance and formal PR-008 acceptance remain open.
**Requirements:** WOS-TIM-001, WOS-TIM-004–006, WOS-TIM-008–009, WOS-TIM-011–012; WOS-CORE-003–005; WOS-NFR-DAT-002/004/005/006/008; WOS-NFR-UX-001/003/005.
**Source:** Accepted Draft PR56 head `09e3b446a1d77b036f2b04a96dfafc4158d66b02`, tree `5d5faa2a6cf84f7507828ba0a71989bac9fd6dd0`.

## Integration checkpoint - 2026-11-15

Original PR57 `02c024d45621fe516e0a46f21657a37f2a1e4532` is reconciled with corrected PR56 candidate `88bf1636d3361e64afe347a4ea44944229f73ee2` at `af0885b327fc37d2fe82f67d79c155d5502157bb`. PR56 remains pending fresh hosted acceptance at this preparation checkpoint. Later owner instructions authorize verified integration and eligible merges, not deployment or waived gates.

The accepted parent's scripts, dependency versions and lockfile are retained; new mode and dependency-input regression commands are additive. Both dependency patches described historically below already exist in the accepted parent. The editor retains keyed identity/week ownership, stale-response guards and settlement-before-reload for abandoned saves. Scope invalidation now uses the mode package's explicit reload boundary: no automatic replacement read may certify work before an in-flight command settles. Server-date alignment is held across keyed week editors so navigation does not reset to the current week.

The controlled ownership fixture follows the new workspace service and explicitly enables synthetic modes; it freezes browser time to a Friday so timing assertions do not depend on whether the real current header may be submitted. Week/identity, A-B-A, save/preflight invalidation and late-read suppression assertions remain required. Real React/API/PostgreSQL mode journeys separately verify actual server date, permission, revision and mode enforcement. Local integration, independent review and exact-head hosted validation remain pending; no acceptance is inferred from older Draft checks.

The integration review also found missing runtime validation of capture-mode settings/history responses. The client now rejects malformed records, mode lists, versions, noncontiguous or inconsistent histories and impossible server dates before publishing them to the editor; malformed append acknowledgements remain uncertain and do not retry. The focused service regression passes invalid-response vectors plus valid empty and 50-version truncated histories. Final type/build/browser checks include this correction.

PR56 subsequently merged at `b6d1f760265aefc21e073a071a0eb2740ca61227` and its post-merge CI43627395475 passed every step. Accepted main ancestry was integrated at `7fa717ccb654d212fae1f7a344f390762f3c16b6` without source changes.

Current local evidence: lockfile installation audited345 packages with zero vulnerabilities; type checking and lint passed. The first aggregate reached the newly strict service with an older synthetic append response missing its timestamp and failed; the fixture was completed and the full aggregate rerun passed. The unchanged bootstrap scanner then rejected five static test-token assignments in two mode tests. They now use the existing generated synthetic digest helper, retaining malformed-token and stale-token negatives; both affected suites and scanner369/adversarial fixtures passed. Real PostgreSQL/API fresh/045-upgrade/replay, explicit scoped settings, CAS/create races, SQL/import/status revision invalidation, legacy parity and old/new period controls passed. Production build passed in18.54 seconds. Final browser validation passed: retained week/identity/scope ownership timing, real React/API/PostgreSQL daily/weekly configuration and work capture (exact/unseen/zero/context preservation, stale tabs/modes, metadata/modal cleanup and genuine in-flight scope invalidation), plus the retained capture-policy journey. Independent exact-head review and fresh hosted acceptance remain pending; earlier failed attempts remain part of the evidence.

## Provenance and bounded outcome

This is a fresh PR56-based implementation. The unpublished earlier local candidate and its raw execution receipts were unavailable after the stopped task resumed. Their historical test/review statements are not acceptance evidence for this new source tree. The two surviving standalone GitHub blobs are historical fragments, not acceptance proof.

- Append explicit scoped buyer enablement of weekly grid and/or daily entry. No modes, permissions or adoption are installed by default. Mode changes do not rewrite work or submission history.
- Both views edit the same retained weekly header and submit one whole header for approval. Daily entry is not daily approval. Existing Friday header identity and rolling seven-day containment are retained; organization calendars and authoritative reporting periods are not re-keyed.
- Weekly view displays Monday–Friday; daily view reaches all seven Saturday–Friday dates. Unseen dates, distinct same-day contexts, zero/off-grid entries, exact decimals, comments, category and billability remain in the full save. Context/removal affects only visible dates; mixed unsaved rows split without losing hidden raw input.
- All work dates, including zero entries, must be no later than UTC today. Draft may retain an unfinished header; Submitted header must itself end no later than today. Existing worker/assignment, OLD/NEW reporting-period, capture-rule, immutable evidence and approval controls remain authoritative.

## API compatibility and concurrency

- `GET /api/v1/work-capture-modes` requires the existing `timesheets.submit` permission and returns only scoped current modes and UTC server date.
- `GET/POST /api/v1/work-capture-modes/settings` requires existing `settings.manage`. Appends use `expectedLatestId`, shared scope locks and immutable sequential versions.
- Mode-aware manual saves require `capture_mode`, `expected_mode_policy_id` and `expected_write_token` together. Explicit null write token means create-only. Complete physical header and entry values form the revision, preserving SQL decimal precision.
- Full omission deliberately retains the unconditional legacy manual contract. A write token alone opts a legacy caller into CAS without mode adoption. Modes are presentation settings, not a new authorization grant. Both import aliases retain their existing contracts and do not adopt a presentation mode.
- SQL, import, status and other accepted physical work changes invalidate stale manual tokens. Stale/disabled mode, stale revision and create races reject without replacing work, evidence, approvals or successful-work audit records.
- Frontend requests capture identity, permissions, token and scope before awaiting. Repeated writes are guarded synchronously. Conflict or uncertain outcomes require reload; stale responses/401s do not publish into or clear replacement sessions. Scope/load invalidation clears work and owner-bound metadata and dismisses remark editing.

## Required executable evidence

- Lockfile installation, typecheck, lint, aggregate unit/contracts, frontend and production-mode builds, configured dependency and secret gates.
- `test:work-capture-modes` and `test:work-capture-modes-service`: strict contracts, intentional legacy behavior, exact/invalid drafts, civil dates, scope/session leases and stale transport.
- `test:work-capture-modes-postgres`: fresh/045 upgrade/replay neutrality; scoped immutable settings/races; complete revisions and create races; SQL/import/status invalidation; manual and both import aliases; explicit/omitted Submitted timing, future zero dates and OLD/NEW closed periods.
- `test:work-capture-modes-journey`: actual production React/API/PostgreSQL configuration, current Draft daily entry, lossless mode switching and whole-header saves, stale tabs, disabled mode, modal/metadata cleanup and genuine in-flight database-lock scope invalidation.
- All retained migration, API, authorization, browser, identity, Compose and container gates remain required. Unit or source review is not PostgreSQL/browser acceptance. Hosted results must identify the exact new remote head.

## Recovery and bounded dependency maintenance — 2026-10-24

The recovered source-only archive was verified as 460 files with tree `6e5a391d95b5942bd388091cbbb0b3124865217c` and SHA-256 `89817847a836e9c9074ce330b20024c645b35dff9ab5ca48cbb451dc3639e1c9`. The retained client-profile browser fixture now expects additive migration046; its preservation assertions remain unchanged.

Required PostgreSQL/browser reruns exposed a disposable-fixture teardown race: pg-pool can resolve `end()` while client sockets are still closing, allowing immediate database cleanup to terminate an idle client. The test harness now waits for tracked public client-end events before database cleanup. Application database behavior and assertions are unchanged.

Owner-authorized standard dependency maintenance updates only locked body-parser 1.20.8 to 1.20.9 (`GHSA-27r3-jxmh-p828`) and Zod 4.3.6 to 4.6.7 (`GHSA-mrhx-c7xc-m3w5`), within existing manifest ranges. Express stays at 4.22.1. The focused `test:dependency-input-safety` gate covers isolated compressed-parser survival and legitimate JSON/size-limit behavior, plus early rejection through existing bounded profile/calendar schemas. This supports WOS-NFR-SEC-008/011 and WOS-NFR-RELSE-001; it does not impose new limits on unbounded collection contracts. No middleware, authentication, grants or unrelated security repair changes are included. Full exact-head validation, hosted scans, formal review, prerequisite integration and protection gates remain required; Draft publication is not acceptance.

## Rollback and deliberate exclusions

Rollback is application rollback with retained additive migration046 and immutable mode history; no destructive down migration or work/evidence deletion is supplied. Older callers continue the documented legacy contract. This adds no grants, default adoption, daily approval, timer, calendar re-keying, categories/non-client contexts, evidence links, overtime, deadlines/grace, reopen policy, planning or financial/reporting redesign. PR008A/B evidence remains bounded, and full PR008/formal product acceptance is not claimed.
