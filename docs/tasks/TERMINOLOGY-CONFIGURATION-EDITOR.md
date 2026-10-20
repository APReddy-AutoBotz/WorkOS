# Terminology configuration editor: bounded WOS-02 increment

## Authority and reconciliation

This separate dependent Draft closes the existing WOS-ORG-006 terminology administration gap and only the terminology entry-point portion of WOS-ORG-010. It is stacked on unchanged PR47, `8a72ad9ed0af825e4d6984ca486b5b55bed00561`, tree `b1329a052d16efddb8a11caf2a906ce467e024ee`. The WOS-02 foundation is already accepted; this exposes its existing server-authoritative terminology capability, not a new dependency-blocked workstream.

Before product writes, read-only reconciliation on 2026-10-20 at 03:17 UTC confirmed unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`, unchanged PR47, successful exact-head CI39362296609, successful latest controller329 CI39356845274, zero queued/in-progress/waiting/requested/pending repository runs, and no active local WorkOS process. The prior writer explicitly released ownership. This isolated snapshot exactly matches the accepted PR47 tree; prior snapshots and evidence remain untouched. This records the bounded WOS-02 non-overlap decision before implementation. No protected acceptance run is interrupted.

## Scope and exclusions

One settings-management administration page edits singular/plural/help text for the nine immutable established canonical terminology keys, with representative previews and explicit effective-dated save. Preserve existing strict nine-key validation, resolved scope, settings.manage, version transaction and audit. Capture actor, active role/effective permissions, token, organization/legal entity and request generation for reads and saves. Prevent stale pre-send callbacks, stale completions, duplicate submits and unmounted updates. Successful terminology POST retains the existing runtime refresh/remount, with owned result feedback and no automatic re-submission.

A minimal runtime read ownership guard and narrow terminology DATE-as-text transport/comparison correction are included only as needed for this flow. No schema, grants, auth expansion, role-removal security repair retry, branding controls, readiness writes, production-email coverage claim or broad wrapper refactor. PR30, EmailMonitor, reference repository writes, merge/Ready/deployment and programme/release acceptance are excluded.

## Semantics and evidence

Same-date replacement remains last-writer behavior, not ETag protection or immutable history. Earlier non-exact dates can conflict with latest scheduled versions. Future saves remain scheduled; runtime reload/navigation is not a midnight activation timer. Preview does not apply unsaved terms globally. Existing covered consumers remain unchanged.

Require locked install, typecheck/lint/build, aggregate and production-service contracts, additive hosted browser journeys with actual production service/API methods, and actual PostgreSQL current/same-date/conflict/future/asOf/audit date cases in UTC, Asia/Kolkata and America/Los_Angeles. All ten prior browser suites and all existing CI gates remain required. Local browser/socket restrictions are not bypassed. Require independent exact-tree engineering review and complete exact-head hosted CI receipt/readback. Formal review, prerequisite/owner/UAT and release gates stay open. Rollback is a revert of this isolated frontend/service/runtime/narrow date transport/test/docs increment; no data conversion or migration.


## Bounded calendar-date correction

Terminology GET and locked-version SELECT now cast effective_from/effective_to to text; the two POST RETURNING projections do the same for response and audit. Node-postgres DATE otherwise becomes process-local midnight and shifts calendar dates through UTC serialization in Asia/Kolkata. Qualified date-column ordering preserves the existing predicates, version transaction and conflict rules. No schema, permission, guard, lifecycle or other date-domain change is included. Actual three-timezone route acceptance is separate from local driver/SQL witnesses.

## Reproduction commands

Locked install: npm ci --cache /tmp/workos-utilization-npm-cache --offline. Static/build: npm run typecheck; npm run lint; npm run build; git diff --check. Production-service contracts: npm run test:terminology-configuration. Runtime ownership: npm run test:terminology-runtime. Calendar dates: npm run test:terminology-dates. Aggregate supported local mode: NODE_ENV=test APP_MODE=test VITE_APP_MODE=test ALLOW_TEST_FALLBACK=true VITE_ALLOW_TEST_FALLBACK=true npm test. Hosted CI additionally executes all eleven browsers, real disposable PostgreSQL routes, production identity/startup, fresh/upgrade/concurrent migrations, dependency audit, Compose/container and full-history secret scan. No skipped or unexecuted gate counts as a pass.
