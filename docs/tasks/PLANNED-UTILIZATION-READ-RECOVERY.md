# Planned Utilization detail read recovery

**Status:** Bounded implementation; dependent Draft, unmerged  
**Requirements:** WOS-NFR-UX-001, WOS-NFR-UX-005, WOS-NFR-OBS-005  
**Scope:** Existing `/utilization/planned` detail presentation and current-evidence export availability

## Dependency and safe non-overlap decision, 2026-10-20

The owner's 2026-10-20 autonomous-continuation instruction authorizes plan-aligned implementation toward the finished product. The implementation controller selects this existing quality gap as the next bounded independent slice after the overview increment, without treating unfinished platform/reporting work as accepted.

Before writing at 00:53 UTC, live reads confirmed unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`, Draft PR41 `396bd955a3e4df47d91b4f4f31f49f2d9a641b0e`, separate Draft PR42 `f08a8126bf3f2048124bf0c63d013242115613ca`, and Draft PR43 `09d35f73ae8546e1693679baff5274a019eef31d` (tree `fc5fcc0b7ce8b2509bdc0994fdaf85fc25c98557`). Latest legacy controller328 [run39342488075](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39342488075) and PR43 [exact-head CI39349487315](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39349487315) were successful. No queued, in-progress, waiting or pending repository run, active WorkOS process or competing writer was observed.

Under the backlog's safe non-overlap rule, use an isolated clean checkout based on the exact PR43 tree and a separate dependent Draft stacked on PR43. Existing PR41/42/43 heads and evidence remain untouched. Do not interrupt protected acceptance or modify other workspaces. Blocked security work and staged diagnostics are excluded. Coordinated page/unit, browser-test and documentation/gate changes have disjoint file ownership within this increment.

This is bounded UX-001/005 and OBS-005 remediation, not full PR-013 reporting or WOS-03B acceptance. No programme credit is earned before exact-head acceptance and merge; do not merge ahead of prerequisites. PR30 stays do-not-merge. Formal independent current-head review, owner, merge and release gates remain unchanged.

## Acceptance

1. Announced loading, genuine successful empty, successful filter-empty, access-unconfirmed, unavailable and error conditions are distinct. A rejected read never claims no overload or no matching resources.
2. Fixed corrective guidance and keyboard retry reload the existing planned-report, directors and settings readers. The existing frontend health-cache reset permits recovery after a cached availability failure.
3. Only a complete current three-read snapshot is committed. Reload immediately invalidates current evidence; obsolete successes/rejections and unmounted responses cannot restore rows, charts, settings or success conclusions.
4. Preserve successful figures, existing calculation/filter/chart/order behavior and employee links.
5. Both export controls and the action-time handler require a current ready snapshot, including an immediate request-generation check. Existing successful rows, filename, CSV/helper and audit behavior remain unchanged.
6. Add real-service failure/recovery tests and synthetic full-page browser cases for keyboard retry, each read's failure, successful/empty/filter-empty presentation, races/unmount, export guards and narrow recovery. Keep all prior gates additive.

## Evidence boundaries

Run locked installation, typecheck, lint, build, full supported-mode tests and unchanged high-threshold dependency audit. The focused unit/read suite must exercise the actual production service path. The synthetic browser suite must exercise the real component and existing export helper with controlled synthetic read data and audit observations.

Local browser execution is unavailable under the authoring sandbox's networking/socket restrictions; no local browser pass is implied. Exact-head hosted CI must prove the new browser suite alongside every earlier suite, production identity/fail-closed startup, PostgreSQL migration/API, container and secret-scan gates. Independent engineering source review is separate from formal GitHub approval and full production-role UAT. Record actual results in the Draft PR.

## Exclusions and rollback

No Actual/Forecast remediation, new report feature, denominator/as-of redesign, backend, authentication/authorization, permission, calculation, normalizer, schema, dependency, export-helper/audit semantic, diagnostic or blocked security change is included. Page-level export availability is deliberately guarded; broader export governance acceptance remains open.

Rollback reverts this isolated frontend/test/documentation increment. No migration, authoritative record conversion, grant or credential action is involved. Existing prerequisite acceptance work remains separate.
