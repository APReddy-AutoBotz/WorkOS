# Organization profile editor: bounded WOS-02 completion increment

## Authority and reconciliation

This separate dependent Draft closes the existing WOS-ORG-001 organization metadata editor gap and a bounded WOS-ORG-010 guided-setup entry point. It is stacked on unchanged PR46, `7a2d7142d706ca486ddb1925162774a65f8feaad`, tree `4a7b96fbd4c288919ac39f310a7addf00186af03`. The WOS-02 foundation is already part of the accepted baseline; this increment exposes existing server capabilities, not a new dependency-blocked workstream.

Read-only reconciliation on 2026-10-20 at 02:38 UTC confirmed unchanged `main@b9a57f8a462d8585bb3f73129080d6fae5173343`, unchanged PR46, successful exact-head CI39358758334, successful latest controller329 CI39356845274, zero queued/in-progress/waiting/requested/pending repository runs, and no active local WorkOS process. The prior writer explicitly released ownership. The new isolated snapshot matches the accepted tree; prior snapshots, heads, receipts and diagnostic work remain untouched. This explicit bounded non-overlap exception was recorded before product writes. No protected acceptance run is interrupted.

## Scope and safety

Read-only organization ID/code; editable name, legal name, product display name, support contact, locale, timezone, currency, fiscal-year start, week-start day and effective date. A separate editor linked from Governance Settings/readiness must not depend on unrelated catalog readers. Draft, read and mutation ownership binds actor, active role/effective permission, organization/legal-entity scope and request generation. Stale callbacks cannot dispatch into a new scope. Already dispatched requests may complete their original scope without a cross-scope success message or false cancellation claim.

Preserve the existing profile GET/PUT, `settings.manage` guard, resolved server scope, effective-version transaction and audit. No backend behavior expansion, schema, dependency, permission/grant, security repair, legal-entity lifecycle, credentials, bank/tax information, runtime-branding configuration or whole-setup completion work. The blocked role-removal repair, PR30, EmailMonitor and reference repository remain excluded. No merge, Ready transition, deployment or programme acceptance.

## Acceptance and completion boundary

Exercise every field through edit/save/reload; server validation and 409 conflicts; permission loss; health/scope races; stale completions and retained callbacks; unmount; duplicate submits; exact scoped headers/body; future-effective messaging and separately authoritative readiness; keyboard/narrow layout. Existing same-date updates and earlier-date conflicts are not ETag protection or immutable history. Future saves are scheduled; product display name does not change environment-backed runtime branding.

Require locked installation, typecheck/lint/build, aggregate and production-service checks, additive hosted browser coverage, independent exact-tree engineering review and full exact-head hosted CI receipt/readback. Local browser socket restrictions remain a disclosed limit, not a bypass target. Formal review, prerequisites, owner/UAT and release gates remain open. Rollback is a revert of the isolated frontend/service/test/docs increment; no migration or authoritative-record conversion.

## Bounded date-transport correction

Implementation verified that node-postgres parses DATE as process-local midnight: in Asia/Kolkata, `2026-10-20` serializes as `2026-10-19T18:30:00.000Z`. The profile SELECT now casts its effective dates to PostgreSQL text, and the latest locked-profile SELECT casts the same date columns before existing date comparisons/audit. This narrowly approved transport correction preserves SQL date predicates, ordering, version transaction and guards, including same-date updates in non-UTC processes. Client normalization accepts canonical dates and unambiguous legacy UTC-midnight ISO only; shifted/non-midnight ISO fails closed rather than being silently truncated. Unrelated date hardening is excluded.

The additive date suite requires actual PostgreSQL route GET/PUT/current/future/asOf/conflict/audit checks in UTC, Asia/Kolkata and America/Los_Angeles on hosted CI. Its local driver/SQL witnesses are separate from those database checks, which are NOT RUN without the disposable database.

## Reproducible evidence commands

- Locked installation: `npm ci --cache /tmp/workos-utilization-npm-cache --offline` in the authoring environment; hosted CI uses ordinary locked `npm ci`.
- Static/build: `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`.
- Production contracts: `npm run test:organization-profile`; date witnesses and PostgreSQL routes: `npm run test:organization-profile-dates`.
- Aggregate local supported mode: `NODE_ENV=test APP_MODE=test VITE_APP_MODE=test ALLOW_TEST_FALLBACK=true VITE_ALLOW_TEST_FALLBACK=true npm test`.
- Hosted full CI additionally runs all ten additive synthetic browser suites, actual disposable PostgreSQL tests, production identity/fail-closed startup, fresh/upgrade/concurrent migrations, dependency audit, Compose/container checks and full-history secret scan. No skipped or unexecuted stage counts as a pass.

The dependent Draft body records the final exact head/tree, independent engineering review and hosted receipts, including any failed attempts. Formal GitHub approval remains separate. Local authoring has no disposable database for the three-timezone route checks and no accepted local browser execution; those gates require hosted evidence.

## First hosted receipt and accessible-label correction

Retain failed [CI39361511572](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39361511572) for original head `a6c88f39b64cf1128169a209511ad691e2f223ca`, tree `1cb72a6034b982119d74c18faf301e7b44b846d2`. All 49 unit/API commands passed, including actual PostgreSQL profile-date route cases in all three timezones. All nine retained browser suites passed. The new profile suite stopped at its first complete-field assertion because the implicit select label included option text; Week start day did not have the required exact accessible name. Later identity/migration/audit/container gates were skipped and are not accepted evidence.

The bounded correction makes the existing label/control relationship explicit with `htmlFor` and `id`, leaving the exact-label browser assertion and every downstream gate intact. A new independent exact-tree engineering review and full exact-head CI receipt are required; no local browser pass is claimed.
