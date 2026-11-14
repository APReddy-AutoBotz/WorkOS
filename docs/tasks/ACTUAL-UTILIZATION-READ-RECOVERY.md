# Actual Utilization detail read recovery

**Status:** Bounded implementation; dependent Draft, unmerged  
**Requirements:** WOS-NFR-UX-001, WOS-NFR-UX-005, WOS-NFR-OBS-005  
**Scope:** Existing `/utilization/actual` read presentation and current-evidence export availability

## Dependency and safe non-overlap decision, 2026-10-20

The owner's 2026-10-20 autonomous-continuation instruction authorizes plan-aligned work toward the finished product. Following the independently verified overview and Planned detail increments, the implementation controller selects this separate existing Actual detail quality gap. Earlier increments' Actual/Forecast exclusions remain intact; this is a new bounded exception, not a silent scope expansion.

Preflight at 01:29–01:30 UTC confirmed unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`, Draft PR41 `396bd955a3e4df47d91b4f4f31f49f2d9a641b0e`, separate Draft PR42 `f08a8126bf3f2048124bf0c63d013242115613ca`, Draft PR43 `09d35f73ae8546e1693679baff5274a019eef31d`, and Draft PR44 `4aba87d5f34082214dac8d05cc6cb07dcd326e93` (tree `ccf431167238b660848024da7f1570d3396cbeb4`). Latest legacy controller328 [run39342488075](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39342488075) and PR44 [exact-head CI39352940268](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39352940268) are successful. PR44's failed historical browser-oracle receipts remain preserved. No queued, in-progress, waiting or pending repository run, active WorkOS process or competing writer was observed.

Record a safe dependency-order/non-overlap exception under the backlog rules: work in an isolated clean checkout based on PR44's exact tree, publish a separate dependent Draft stacked on unchanged PR44, and coordinate disjoint page/unit, browser-test and documentation/gate ownership. Preserve all earlier PR heads/evidence and other workspaces. Do not interrupt protected acceptance or resume, inspect or reproduce blocked security work or its staged diagnostics. PR30 remains do-not-merge.

This is bounded UX/OBS quality evidence, not full reporting/PR-013, export governance, WOS-03B or product acceptance. Programme credit, prerequisite acceptance and formal current-head review/owner/merge/release gates remain unchanged. No merge ahead of prerequisites and no deployment are included.

## Acceptance and preserved semantics

1. Distinguish announced loading, complete successful snapshot, genuine empty, filter-empty, access-unconfirmed, unavailable and fixed safe generic error. Failed reads cannot display successful-empty or approval-health conclusions. Retry is keyboard-accessible and never exposes raw diagnostic text.
2. Retry the existing actual-report, timesheets and settings readers atomically, resetting existing frontend backend availability so a cached failed health read cannot permanently block recovery. Immediately invalidate current evidence on reload; ignore obsolete success/rejection and unmounted responses.
3. Both Global Report and Audit Trail controls plus the shared action-time exporter require current-ready, mounted and request-generation evidence, including captured old callbacks before rerender. Preserve current-ready empty-export behavior and all CSV/helper/scoped history/audit semantics.
4. Real production-reader tests cover report, timesheets, the nested employee lookup and settings GET failures/recovery. Three logical readers reach four business endpoints plus health; tests must not assume only three HTTP requests.
5. Synthetic full-page hosted-browser evidence covers keyboard retry, every logical reader failure, success/empty/filter-empty, successful figures and both CSV/audit paths, refresh races, stale handlers, unmount and narrow recovery. Keep all previous gates additive.

Preserve month selection/fallback, All Periods, Consolidated/Approved Only/Pending Review, approved-only utilization, expected-hours/fallback calculations, KPIs, reconciliation/watchlist ordering and formatting. Search affects visible logs and Audit Trail; Global Report intentionally uses month/status scope independently of search. Successful timesheet logs must remain visible when report employee rows are empty. Genuine composite empty means both returned employee and timesheet arrays are empty, never a failed read.

## Verification boundaries

Run locked installation, typecheck, lint, build, full supported-mode tests, focused real-service checks, final diff hygiene and unchanged high-threshold dependency audit. The eighth synthetic browser suite is additive to all seven existing suites. Keep the actual CSV helper and saveImportExportLog service, replacing only their controlled synthetic network boundary in the fixture.

Local browser execution is unavailable under the authoring sandbox's networking/socket restrictions; do not claim a local browser pass. Exact-head hosted CI must establish browser, PostgreSQL migration/API, production identity/fail-closed startup, dependency audit, container and secret-scan evidence. Source review is separate from formal GitHub approval and full production-role/destination-page UAT. Preserve any failed receipts and record actual final results in the Draft PR.

## Exclusions and rollback

No Forecast, Planned/overview behavior, reporting/denominator/as-of redesign, backend, authentication/authorization, permission, calculation, normalizer, schema, dependency, export-helper/audit semantic, diagnostic or blocked security change is included. Revert this isolated frontend/test/documentation increment for rollback; no database conversion, authoritative-record, grant or credential action is involved.

## Integration checkpoint, 2026-11-14

Reconciled with planned-detail candidate `a5f5269ac68384fd56683bc2b389db7e03ec0174`, subsequently accepted in PR44 at main `a25d08be9309f3d8aa502c2c3459dab0fdbb38fa`. The package-script conflict retains every accepted test and adds both Actual suites. No product code was changed during reconciliation.

Current local evidence passed: fresh lockfile installation (338 installed, 345 audited, zero vulnerabilities), typecheck, lint (109 modules), full supported-mode unit/contracts, bootstrap scan (252 files) and adversarial fixtures, and production build with frontend fallback disabled. The unchanged Chromium suite passed after explicit local Vite fixture-compilation warm-up: all reader failures, keyboard retry, atomic completion, composite/mixed/filter empty states, approved-metric and period/status/search parity, stale/unmounted responses, both real CSV/history/audit paths and narrow recovery. No timeout or assertion was changed. This supersedes only the historical local-browser availability limitation above.

Controller review inspected the complete component, reader/browser tests, fixture and additive gate changes. Historical independent review and hosted CI apply to the old head only; exact-head hosted checks and applicable current-head review remain necessary before merge. No buyer UAT, full reporting/export-governance or release completion is claimed.
