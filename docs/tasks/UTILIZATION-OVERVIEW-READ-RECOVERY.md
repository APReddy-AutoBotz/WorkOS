# Utilization overview read recovery

**Status:** Bounded implementation; Draft, dependent and unmerged  
**Requirements:** WOS-NFR-UX-001, WOS-NFR-UX-005, WOS-NFR-OBS-005  
**Scope:** Existing Utilization Reports overview presentation only

## Dependency and safe non-overlap decision, 2026-10-20

The owner requested autonomous continuation toward the finished product on 2026-10-20. Before this increment, live repository reads confirmed:

- Main `b9a57f8a462d8585bb3f73129080d6fae5173343`.
- Draft PR41 `396bd955a3e4df47d91b4f4f31f49f2d9a641b0e`, tree `abfa68fc866f6bc76c140606ae544856225e687b`.
- Separate controller-only Draft PR42 `f08a8126bf3f2048124bf0c63d013242115613ca`.
- Latest legacy controller328 [run39342488075](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39342488075) completed successfully. No queued/running repository workflow or active WorkOS writer was observed at 00:37 UTC.

The implementation controller records a safe dependency-order exception under the backlog control rules: complete only the inherited overview's inaccurate failed/empty presentation, in an isolated clean checkout and separate UI-only Draft PR stacked on PR41. PR41's published head and evidence remain untouched. Its unfinished WOS-03B/security work is not resumed, inspected or reproduced. Other workspaces and their staged changes remain intact. No protected acceptance run is interrupted, no competing writer is started, and no dependency is merged ahead of its prerequisite.

This is existing cross-cutting quality remediation, not a new reporting work package or full PR-013 acceptance. It earns no programme completion credit before exact-head acceptance and merge. PR30 remains do-not-merge. Independent engineering review, formal current-head review, owner gates, merge and release controls remain unchanged.

## Presentation behavior

- Initial load and refresh show an announced loading state, without prior measurements.
- A failed read clears the entire combined overview. A partially completed three-lens request cannot be presented as a complete snapshot.
- 401/403 have fixed access guidance; 404/502/503/504 have fixed unavailable guidance; other failures have fixed error guidance. No raw error body, message, diagnostic or stack is rendered.
- Keyboard-operable retry reloads all three existing report services. It uses the existing frontend backend-check reset so a cached failed health read cannot permanently defeat recovery.
- A genuine successfully returned empty selected lens has an explicit no-data state. It does not claim no exceptions or measured zero utilization.
- Each load replaces the previous generation immediately. Late successes/failures, repeated refreshes and unmounted results cannot replace current data.
- Successful nonempty metrics, exception calculations and report/profile links retain their existing behavior. No backend, authorization, report calculation, normalization, export, schema, dependency or diagnostic file is changed.

## Executable evidence

- `npm run test:utilization-overview`: real existing production-service path, propagated 401/403/404/500/503/network failures, recovery after a cached failed health read, actual empty reports, unchanged normalized figures, GET-only calls and safe announced status presentation.
- `npm run test:utilization-overview-browser`: full-page controlled synthetic planned/current/forecast reads, failure versus empty versus nonempty/no-exceptions, keyboard retry, successful figures/navigation, repeated-refresh stale results, unmount, narrow layout and no writes/downloads/unexpected API calls.
- The unit suite is included in `npm test`; the browser suite is additive to every prior CI browser suite. The existing WorkOS CI pull-request base filter additionally includes PR41's branch to validate this dependent Draft without changing the main/deployment/merge boundary.

Run locked installation, typecheck, lint, build, full supported-environment unit/contracts, browser suites and the unchanged high-threshold dependency audit. Exact-head hosted CI must also prove PostgreSQL/migrations, production identity/container and secret-scan stages. Record actual passed/failed/blocked stages in the Draft PR; source review is not formal GitHub approval or product acceptance.

## Operations and rollback

When reads fail, check connection and retry; for access failures, check sign-in and report access first. Escalate persistent failures to the administrator. No export, grant or data repair is offered by this overview.

Rollback is a revert of this isolated frontend/test/documentation increment. No database conversion, migration, authoritative-record change or operational credential action is involved. The prerequisite PR41 and its unresolved acceptance work remain separate.
