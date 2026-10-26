# WorkOS Release and Operations Runbook

## Purpose

Provide a repeatable buyer-owned release, deployment, verification, rollback and operating process. Provider-specific commands will be added with implementation artifacts; this document defines mandatory control flow.

## Release preparation

- Freeze the exact candidate SHA and version.
- Confirm changelog, requirements traceability, known limitations and migration notes.
- Run the complete CI/release matrix.
- Build immutable container/artifact and capture checksum/SBOM.
- Verify secret/dependency scan and security finding disposition.
- Validate fresh install and supported upgrade.
- Approve backup, migration and rollback/roll-forward plan.

## Pre-deployment checklist

- Buyer-owned target environment and database identified.
- Required configuration schema passes without exposing secret values.
- Domain/TLS, identity redirect URIs and provider allowlists are correct.
- Current backup and restore access are confirmed.
- Operations owner, alert channel and maintenance window are assigned.
- Production demo seed/fallback/shared accounts are disabled.

## Deployment sequence

```text
maintenance/readiness gate
→ backup and record current version/schema
→ run controlled migration command
→ validate migration ledger/control totals
→ deploy application and job process
→ liveness/readiness
→ authentication and protected-route smoke
→ critical role and financial reconciliation smoke
→ monitor and accept
```

## Post-deployment verification

- Version/build and schema match the release manifest.
- Database, optional storage and providers report safe readiness.
- Named identity, active role and permission/data-scope behavior work.
- Representative work/approval/utilization/report flows pass.
- Commercial snapshots and invoice-ready control totals reconcile when affected.
- No secret or sensitive-value leakage appears in logs/errors.

## Rollback and roll-forward

Prefer roll-forward for migrations that have accepted production data. Application rollback must declare compatible schema versions. If database restore is required, isolate writes, restore buyer-approved backup, verify ledger/control totals and record the incident/change evidence.

## Operations

Monitor startup/readiness, authentication failures, authorization denials, database health, background jobs, integrations, imports/exports, approvals, commercial jobs, batch exports and storage. Define thresholds, owners and response time before production.

## Backup and restore

Buyer policy defines frequency, retention, encryption and RPO/RTO. Restore rehearsal verifies application version, schema, organization/configuration, users/roles, critical counts, audit continuity, commercial control totals and representative role journeys.

## Incident and support evidence

Record release/incident ID, exact version, environment, timestamps, impact, detection, mitigation, data/audit effect, root cause, corrective actions and owner. Never attach raw credentials or unrestricted personal/financial payloads.

## WorkOS production-like container profile

The repository provides a Node 22 production image and a PostgreSQL Compose profile. Start from `.env.production.example`, copy it to the ignored `.env.production` file, and replace every placeholder. Generate a unique session secret of at least 32 characters. URL-encode any special characters in the database password inside `DATABASE_URL`. Configure the Entra tenant, client, HTTPS application origin and exact callback URL before starting the application.

### Production environment reference

The production profile reads the following values from `.env.production`. Secret values stay in the deployment environment and must never be copied into logs or support tickets. Values marked required are enforced by the production startup validator or Compose interpolation. The Entra fields are mandatory for production and must identify a real configured application; format validation cannot prove that the provider will accept its credentials.

| Variable | Purpose | Sensitivity | Required | Allowed values |
|---|---|---|---|---|
| `NODE_ENV` | Selects the Node runtime profile | Public | Yes | `production` |
| `APP_MODE` | Selects the WorkOS application profile | Public | Yes | `production` |
| `APP_URL` | Canonical externally served origin | Public | Yes | Public HTTPS origin with no path, query or fragment; must not be loopback |
| `APP_BIND_ADDRESS` | Host interface published by Compose | Public | No; default `127.0.0.1` | IPv4 bind address; expose beyond loopback only behind a managed HTTPS proxy/firewall |
| `APP_BIND_PORT` | Host port for the API | Public | No; default `4000` | Integer from 1 through 65535 |
| `PORT` / `API_PORT` | Container API listener port and legacy alias | Public | No; default `4000` | Integer from 1 through 65535; if both are set they must match |
| `DATABASE_URL` | PostgreSQL connection for app and migration runner | Secret | Yes | `postgresql://user:password@host:port/database`; URL-encode credentials and replace sample values |
| `POSTGRES_DB` | Database initialized by the local Compose PostgreSQL service | Confidential | Yes for Compose | Non-empty PostgreSQL database name |
| `POSTGRES_USER` | Role initialized by the local Compose PostgreSQL service | Confidential | Yes for Compose | Non-empty PostgreSQL role name |
| `POSTGRES_PASSWORD` | Password initialized for the local Compose role | Secret | Yes for Compose | Unique non-placeholder password; keep it out of source and logs |
| `POSTGRES_BIND_ADDRESS` | Host interface published for PostgreSQL | Public | No; default `127.0.0.1` | IPv4 bind address; keep loopback unless access is explicitly controlled |
| `POSTGRES_BIND_PORT` | Host port for PostgreSQL | Public | No; default `5432` | Integer from 1 through 65535 |
| `PGSSLMODE` | PostgreSQL connection transport mode | Public | No; Compose default `disable` for its private service network | `disable` or `require`; use `require` when the selected PostgreSQL endpoint supports TLS |
| `API_SESSION_SECRET` | Signs production sessions | Secret | Yes | Unique non-placeholder value with at least 32 characters |
| `IDENTITY_PROVIDER` | Selects the production identity provider | Public | Yes | `entra` |
| `ENTRA_TENANT_ID` | Entra tenant identifier | Confidential | Yes | Tenant GUID |
| `ENTRA_CLIENT_ID` | Entra application identifier | Confidential | Yes | Application GUID |
| `ENTRA_CLIENT_SECRET` | Entra application credential | Secret | Yes | Configured non-placeholder value with at least 16 characters |
| `ENTRA_REDIRECT_URI` | Registered Entra sign-in callback | Public | Yes | HTTPS URL at the `APP_URL` origin with path `/api/auth/entra/callback` |
| `AUTO_SEED_DEMO` | Controls automatic demo-data creation | Public | No; defaults to `false` | Must be `false` in production |
| `RESET_DEMO_DATA` | Controls demo-data reset behavior | Public | No; defaults to `false` | Must be `false` in production |
| `ALLOW_TEST_FALLBACK` | Controls server-side test identity fallback | Public | No; defaults to `false` | Must be `false` in production |
| `VITE_ALLOW_TEST_FALLBACK` | Controls build-time browser test fallback | Public | No; defaults to `false` | Must be `false` in production |
| `LOCAL_LOGIN_ENABLED` | Controls local credential login | Public | No; production forces `false` and rejects `true` | Omit or set `false`; `true` is prohibited in production |
| `VITE_APP_MODE` | Selects browser build mode | Public | No; Docker build defaults to `production` | `production` for this image |
| `APP_VERSION` | Safe application version in health metadata | Public | No; defaults to package version | Semantic version; invalid values report as `unknown` |
| `BUILD_SHA` | Safe source commit in health metadata | Public | No; defaults to `GITHUB_SHA` or `unknown` | 7–40 hexadecimal commit characters; invalid values report as `unknown` |

Validate the Compose configuration and build the image before running it:

```sh
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build
```

For a first install or schema upgrade, take and verify the buyer-owned database backup first. The `migrate` service waits for PostgreSQL, takes the advisory migration lock, applies ordered migrations and records checksums for newly applied files. The app starts only after that service succeeds, then performs an idempotent migration check before accepting requests.

```sh
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production up -d app
docker compose --env-file .env.production ps
```

The default application and PostgreSQL host bindings use loopback. Put a buyer-managed HTTPS reverse proxy in front of the application when external access is required. Check process and schema status without exposing configuration values:

```sh
curl --fail http://127.0.0.1:4000/api/health/live
curl --fail http://127.0.0.1:4000/api/health/ready
curl --fail http://127.0.0.1:4000/api/health/build
```

`/api/health/live` reports whether the API process is serving. `/api/health/ready` returns 503 when PostgreSQL is unavailable, migrations are pending, the ledger contains a migration ID this application does not support, or the latest production OIDC discovery probe failed. OIDC readiness returns to available after a later successful probe; liveness remains healthy while the API process is serving. `/api/health/build` reports the safe application version, validated commit SHA and current migration level. The legacy `/api/health` route keeps its existing response contract.

The migration ledger adds a nullable checksum column. Rows from installations created by the earlier runner have no recorded checksum and remain explicitly unverifiable; the upgrade does not fabricate a historical digest. New migrations store SHA-256 digests, and a changed file with a recorded digest stops the transaction. This PR makes only an additive metadata change. If an upgrade fails, keep the application in maintenance, retain the backup, inspect the named migration ID, and use the approved recovery plan instead of editing the ledger by hand.

`docker compose down` stops the services and keeps the named database volume. `docker compose down --volumes` deletes that volume and its database; reserve it for disposable environments only. The full production backup/restore rehearsal and alert-ownership runbook remain assigned to the later operations/recovery package.

## Utilization overview read recovery

The overview distinguishes loading, successful empty data, access-unconfirmed, unavailable and failed reads. A failure hides measurements and exception conclusions until all three reports load successfully. Use Refresh or the keyboard-accessible Retry utilization reports action to read again; retry rechecks frontend availability after a previous cached health failure. For access-unconfirmed guidance, verify the current sign-in and assigned report access. For other failures, check connectivity and retry; contact the administrator if the problem persists. No raw service error or invented zero/no-exceptions result should appear.

The [bounded recovery task](../tasks/UTILIZATION-OVERVIEW-READ-RECOVERY.md) documents the dependent Draft, exact-head verification and limitations. Roll back by reverting this isolated frontend increment; there is no migration, data conversion, grant or credential change. This does not complete broader reporting or WOS-03B/release acceptance.

## Planned Utilization detail read recovery

The planned detail page treats report, director and settings reads as one current snapshot. Loading, genuine empty, filter-empty, access-unconfirmed, unavailable and error presentation must remain distinct. On failure, measurements, charts, no-overload conclusions and exports stay unavailable. Check sign-in/report access for access guidance; otherwise check connectivity and use Retry planned utilization. Refresh/retry rechecks frontend availability after a cached health failure. Escalate persistent failure to the administrator.

Export Plan and CSV require current successfully loaded evidence; a refresh invalidates it immediately. Existing successful output/audit behavior is unchanged. The [bounded task](../tasks/PLANNED-UTILIZATION-READ-RECOVERY.md) records exact-head verification and limitations. Revert the isolated frontend increment for rollback; no database, grant or credential action is required. Broader reporting/export and release acceptance remain open.

## Actual Utilization detail read recovery

The actual detail page loads actual report, timesheets and settings as one current snapshot; timesheet loading includes its existing nested employee lookup. Loading, genuine empty, filter-empty, access-unconfirmed, unavailable and error states remain distinct. Failed reads hide measurements, successful-empty/approval-health conclusions and export availability. Check sign-in/report access for access guidance; otherwise check connectivity, then use Retry actual utilization. Retry rechecks cached frontend availability; escalate persistent failures to the administrator.

Global Report and Audit Trail require current-ready evidence, invalidated immediately by refresh. Existing output and scoped history/audit behavior remain unchanged: Global Report applies month/status scope, while Audit Trail also applies search. Successfully loaded timesheet logs remain usable even if actual report employee rows are empty. The [bounded task](../tasks/ACTUAL-UTILIZATION-READ-RECOVERY.md) records verification and limits. Rollback reverts the isolated frontend increment; no migration, grant or credential action is needed. Broader reporting/export and release acceptance remain open.

## Forecast Utilization detail read recovery

The Forecast detail page requires a complete current employee/project/allocation/settings and selected-horizon report snapshot before presenting measurements, risk conclusions or exports. Loading, access-unconfirmed, unavailable and safe generic error remain distinct from genuine composite and section/filter-empty success. Check sign-in/report access for access guidance; otherwise check connectivity, then use Retry forecast utilization. Retry/refresh rechecks cached frontend health. Persistent failure should be escalated to the administrator.

Horizon changes invalidate old evidence immediately, including retained export callbacks; responses from an older generation or unmounted page cannot restore it. Forecast Report and Forecast preserve the existing current-ready filtered CSV and scoped history/audit behavior. Successful omitted report employees still use the existing nullish allocation-derived fallback; genuine report zero stays zero. Report failure never activates that fallback. Independent roll-offs/charts remain available when successful ledger rows are empty. The [bounded task](../tasks/FORECAST-UTILIZATION-READ-RECOVERY.md) records verification, native horizon/date semantics and limits. Revert this isolated frontend increment for rollback; no migration, grant or credential action is needed. Broader reporting/export and release acceptance remain open.

Retain failed [CI39356847712](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39356847712) as failed evidence. Its global zero-text browser oracle also counted the chart library's offscreen, aria-hidden body sizing helper after chart unmount. The bounded test correction exempts only that verified numeric probe and adds negative mutation witnesses, without changing product results or suppressing ordinary report text. A replacement exact-head full CI pass is required; skipped identity, migration, audit or container stages never count as successful acceptance.

## Organization profile metadata editor

Use Organization Profile in Admin navigation, or Edit organization profile from Governance Settings/readiness. The isolated editor is available without waiting for unrelated governance catalog reads. Settings-management access and a selected organization/legal entity are required. Organization ID/code are read-only; all editable fields are ordinary organization metadata shared across the organization's legal entities. Product display name does not replace environment-configured runtime branding.

Reload profile reads the currently effective server version and separately refreshes authoritative setup readiness. Readiness failure does not block profile editing and saving a profile does not mark other setup areas complete. Same-date saves update that version; an earlier effective date can conflict with the latest saved version. A future-effective save is labelled scheduled, and ordinary Reload continues to show the currently effective profile. No optimistic edit lock, ETag or immutable same-date history is promised.

Changing actor/role/effective permission or organization/legal entity clears draft ownership; reload in the intended context before editing. Pending requests are not falsely cancelled: a dispatched save can finish in its original scope but cannot restore a draft or announce success in a different context. Repeated submission is synchronously locked while a save is pending. Validation/conflict messages contain no raw server details. After an unconfirmed save, reload before trying again and inspect authoritative records as needed; do not blindly retry an uncertain mutation.

The [bounded task](../tasks/ORGANIZATION-PROFILE-EDITOR.md) records exact-tree review/CI evidence and remaining formal gates. Revert this isolated frontend/service/test/docs increment for rollback. No migrations, guard/grant changes, credentials, bank/tax data, legal-entity lifecycle, production identity or deployment action is involved.

Profile effective dates are transported as PostgreSQL date text so server-process timezone cannot shift them. The existing date predicates/transaction are unchanged; three-timezone PostgreSQL profile route acceptance is additive. Legacy non-midnight ISO effective dates are rejected, not silently truncated. The narrow profile SELECT transport correction is included in the same revert; unrelated date handling remains outside this increment.

Retain failed profile [CI39361511572](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/39361511572): all prior nine browser suites and actual three-timezone profile-date routes passed, but the new editor's week-start select lacked its exact accessible name because the implicit label included option text. The correction uses explicit label-for/id association without weakening the browser check. Downstream skipped gates require a new full exact-head pass.


## Terminology administration

Use Terminology in Admin navigation or Edit terminology in Governance Settings. The separate page requires settings.manage and selected organization/legal entity, independently of unrelated governance catalogs. Changes apply organization-wide. Edit singular/plural/help text for the nine read-only canonical keys; representative previews stay local until Save terminology. Existing canonical permissions, routes and CSV filenames do not change. Empty successful configuration starts from centralized environment defaults; failed or malformed reads do not create an editable fallback.

Reload terminology reads the currently effective version. Same-date saves replace that version, with last-writer semantics, not ETag protection or immutable history. Earlier dates may conflict with a newer scheduled version, requiring explicit reload and a suitable effective date. Future saves are scheduled, not immediately active. Runtime reload/navigation on or after the date resolves the then-effective version; no automatic midnight timer is included. The existing runtime refresh/remount after POST preserves owned result feedback and never automatically re-submits.

Actor/role/permission/token/scope changes clear draft ownership. An already submitted save can complete in its original scope but cannot restore a stale draft or report success in a replacement context. Access/validation/conflict/unavailable/unknown outcomes use safe messages; unknown mutation outcomes require reload, not automatic retry. The [bounded task](../tasks/TERMINOLOGY-CONFIGURATION-EDITOR.md) records production-service/browser/runtime/date evidence and local limits. Roll back by reverting the isolated increment; no migrations or authoritative record conversion. Branding, production-email, whole guided setup and release acceptance remain separate.


## Working calendar inspector (bounded Draft increment)

With settings-management access and an authorized selected organization/legal entity, use Admin → Working Calendars or Governance Settings → Inspect working calendars. These entry points do not wait for unrelated catalog loads. The inspector captures the current UTC calendar date once per reload and passes it to both existing GET readers. It shows effective saved calendar versions and lazily loads selected-calendar holiday versions. Active/inactive flags are persisted metadata. A holiday's saved date can be outside the current year; the effective bounds govern inclusion. Worker groups are displayed only as saved version-row IDs. No winning worker calendar, assignment, capacity or legacy utilization integration is implied.

List and holiday failures are independent. Retry resets cached backend availability; holiday retry retains confirmed calendar details and the same snapshot. Reload clears selection and captures a new snapshot. A change of actor/employee/role/effective permissions/token/scope, a pending scope switch, retry, selection replacement or unmount invalidates obsolete callbacks/responses. Raw provider details never appear. Malformed/mismatched data fails closed, without local/test-record fallback in production. A response at 200 rows can omit additional matches and is explicitly labeled non-exhaustive; empty means no records returned, not proven complete absence.

Reproduce with locked `npm ci`; `npm run typecheck`; `npm run lint`; `npm run build`; `npm run test:working-calendar-inspector`; `npm run test:working-calendar-dates`; and the aggregate `npm test` in the documented supported test environment. Hosted acceptance adds `npm run test:working-calendar-browser` as the twelfth browser, preserving all eleven prior suites and all existing gates. `WORKOS_TEST_DATABASE_URL` must point only to disposable local CI PostgreSQL for actual date route tests in UTC, Asia/Kolkata and America/Los_Angeles. Without it, local date checks report driver/SQL witnesses only and actual routes NOT RUN; CI refuses to skip. Local browser/socket restrictions are not bypassed. No skipped/unexecuted gate counts as success.

Rollback is a code-only revert of the viewer/service/navigation/two GET projections/tests/docs. No migration, data conversion, audit or mutation behavior changes. Catalog mutation, calendar edit/retire/import/export/assignment, historical/future exploration, readiness updates, blocked role-removal security repair, grants, credentials and formal review/release acceptance remain outside this increment. Keep the dependent PR Draft and unmerged; successful engineering verification is not Ready/merge/deployment authority.

## Synthetic integrated import-to-audit acceptance

With locked dependencies and Playwright Chromium installed in the hosted test environment, set WORKOS_TEST_DATABASE_URL to disposable local PostgreSQL and run `npm run test:import-audit-journey`. The command owns actual API/Vite listeners, randomized migrated database, synthetic reference records and two short-lived named test sessions, then tears them down. It explicitly configures the loopback API proxy and disables demo seed/reset/fallback and live providers. Never point it at a shared, customer or production database; nonlocal destinations/options fail closed. No credentials or session material should be retained in evidence.

The [bounded journey](../tasks/IMPORT-AUDIT-ACCEPTANCE-JOURNEY.md) covers actual Project Master CSV dry-run/apply, PostgreSQL project/batch/audit/idempotency witnesses, retained history after reload, independent named reviewer saved provenance and other-legal/denied-scope exclusion. Inspection performs no business/audit mutation or export. Both accounts use canonical migrated Admin permissions, with no new role or grants. This is not production OIDC, owner UAT, full WOS-03B or release acceptance. Product defects require separate disposition and are not repaired by this tests-only increment.

`npm run test:import-audit-harness` runs guard/session-format unit checks without database/browser and is part of the aggregate suite. The hosted dedicated journey is additive to the twelve retained browser suites and all existing gates. Local Chromium remains NOT RUN under the established restriction, with no workaround; missing local PostgreSQL also means the integrated journey is NOT RUN locally, not passed. Require full exact-head hosted evidence and independent exact-tree review. Revert this isolated tests/CI/docs increment for rollback; no product/schema conversion is necessary.

## Commercial drafting foundation (PR-007A)

The Commercial Drafting workspace is separately protected by opt-in `commercial.contracts.view` and `commercial.contracts.manage`. No role or user receives these permissions by default; the buyer administrator must decide their intended commercial operators through existing permission administration. Write access also requires view access. This task makes no live grant or account change. Current scoped clients/owners/attribution are server-validated. Contract/PO/budget/milestone amounts remain decimal strings with no cost, margin, consumption, accounting-recognition or invoice authority. All saved objects are drafts.

Create a contract/SOW with terms, then create an engagement against the version applicable at its start. Internal/pre-sales drafts require active scoped business-unit/cost-centre attribution, no contract and enforced nonbillability. Record draft POs and milestones separately. Inspect contract history and append future terms using the returned expected version. Revisions must be later than both the latest term date and today in UTC; model/currency changes require a separate contract. New versions do not modify prior pinned drafts or approved historical work. All capped lists disclose truncation. A failed/unknown save must be reconciled by reload before any repeat, never silently resent.

Detailed commercial event history is append-only and separated from ordinary audit readers. The general audit projection retains actor/role/context and opaque before/after references, never commercial values, entered reasons or document URLs. Controlled document links are HTTPS metadata only and are not fetched by the service.

Migration040 only adds tables, constraints, opt-in permission definitions and neutral snapshots mapping existing projects to `legacy_unclassified` engagements without changing original project/work IDs or values. Later legacy project creation is reported as unmapped rather than silently assigned commercial meaning. Legacy project update paths are not newly governed by this mapping. Preserve this distinction during buyer handover; full PR-007 hierarchy/lifecycle convergence remains open. Roll forward is preferred. A pre-040 binary is not supported for rollback because its manifest correctly rejects unknown migrations. Any validated forward-compatible rollback build must retain migration040 and commercial tables/events/mappings while disabling the route/UI. Never drop evidence, revert the040 manifest or erase its ledger as a rollback shortcut. Backup restoration needs separate approved recovery.

Reproduce locked installation, full aggregate tests/type/lint/build and retained controller/baseline gates. Dedicated `test:commercial-drafting-postgres` requires randomized disposable local PostgreSQL only, while `test:commercial-drafting-browser` covers fixture interactions and `test:commercial-drafting-journey` runs real React/API/PostgreSQL. Existing twelve browser suites and all identity/migration/scan/container gates remain intact. Missing local PostgreSQL/browser execution is NOT RUN, not a pass; require exact-head hosted acceptance. The [task](../tasks/WOS-04-COMMERCIAL-DRAFTING-FOUNDATION.md) records the development sequencing exception. It waives no denied operation, blocked diagnostic, merge, release or production gate.

## Governed commercial lifecycle and project bindings (PR-007B)

The Commercial Drafting workspace includes a separate lifecycle panel. Commercial view access permits scoped history/dependency inspection; opt-in `commercial.lifecycle.manage` additionally permits exact-version activation, Active/On Hold transitions and governed project creation/promotion. Draft-management permission alone does not grant lifecycle authority. No default or live grants are installed.

Activate the contract on its currently effective immutable term version, then the matching engagement. Internal/pre-sales engagements require active scoped attribution and remain non-billable. Create immediately active projects/workstreams within the engagement dates and bounded planned budget. Existing Proposed project promotion is explicit and exact; projects with assignment/work history are not silently converted. Source project IDs and neutral mapping snapshots survive. Lifecycle transitions use returned expected sequences and the server's current UTC date, not user-entered dates. Hold children before parents; resume parents before children. Repinning, future scheduling, amendments and terminal closure are not offered in this increment.

Legacy project save/status/import and indirect client cascade/import operations return stable409 for governed rows; do not route around this guard through old APIs, CSV or demo seed/reset. Mixed attempted imports roll back atomically, including batch/idempotency/audit effects. Neutral-only/unmapped legacy rows retain existing behavior. Commercial lifecycle state is not full assignment/work-date policy convergence, a billing decision or an instruction to rewrite existing allocation/work evidence.

Inspect closure dependencies for actual existing assignment/work/pending-approval/milestone/PO/owner evidence. Missing approved-unbilled/balance/PO-consumption/acceptance modules are labelled unavailable, never zero; closure stays unavailable even when existing counts are zero. Reconcile unknown network outcomes by reload and history before any repeat. Changing identity/role/permission/token/scope clears confidential view/draft ownership; an in-flight old-scope command may finish there but must not restore stale UI state.

Migration041 adds immutable lifecycle/bindings/guards and retains040 untouched. Roll forward preferred; any rollback binary must be validated with040/041 manifest and all evidence/guards retained. Never drop bindings/ledger, erase migration history or re-enable unrestricted legacy writes as rollback. All prior unit/browser/PostgreSQL/identity/scan/container gates remain required, with new lifecycle strict-service, real PostgreSQL and real React/API/PostgreSQL tests additive. Local browser/DB absence is NOT RUN; require exact-head hosted evidence. No credentials, providers, production/customer data, denied repair/diagnostic, Ready/merge/deploy or formal release acceptance is involved.

## PR-008D evidence-link migration and rollback

Migration047 adds nullable work-entry URLs without rewriting accepted work, grants or immutable histories. Run the feature unit, PostgreSQL upgrade/replay and real browser journey gates described in [PR-008D](../tasks/WOS-04-WORK-ENTRY-EVIDENCE.md). Review is deferred, not passed; the dependent Draft is not release acceptance. URLs are references only and are never automatically fetched. Preserve migration047/history on rollback. Pre047 binaries cannot preserve evidence during entry replacement: if restoring one, keep work writes disabled operationally and roll forward to an evidence-aware binary before resuming. No destructive down migration, running-environment change or deployment is authorized.

## PR-008E work-reference migration and rollback

Migration048 adds nullable work-reference text without rewriting old entries, URLs, grants or immutable history. Validate the fresh/047-upgrade/replay and real API/browser gates in [PR-008E](../tasks/WOS-04-WORK-ENTRY-REFERENCE.md). Text is displayed as escaped content and is never looked up or interpreted as financial/source authority. Retain migration048/history on rollback. Pre048 binaries do not understand reference preservation; if restoring one, keep work writes operationally disabled until an aware binary is restored. This guidance grants no deployment/running-system change. Optional code/security reviews remain outstanding; Draft engineering evidence is not integrated or release acceptance.

## PR-008F required-evidence policy migration and rollback

Migration049 adds nullable policy evidence configuration and extends existing append/deferred work guards. Existing policies remain optional; new omitted appends inherit the latest setting. No history, work, grant or default adoption is rewritten. Run [PR-008F's](../tasks/WOS-04-REQUIRED-EVIDENCE-POLICY.md) fresh/048 upgrade/replay, policy inheritance and real API/browser gates. Preserve migration049 and its guards/history on rollback. Pre049 binaries cannot project or prevalidate this option; use a forward-compatible binary before resuming work/policy writes. This grants no deployment or running-system change. Optional formal review remains outstanding; Draft engineering evidence is not release acceptance.

## PR-008G identical-entry diagnostic migration and rollback

Migration050 adds only nullable `work_submission_evidence.duplicate_entry_check` with a version/object/array shape constraint. Existing append-only submission guards protect the metadata. It does not backfill, rewrite work/history, change duplicate rejection rules, adopt policy or add grants. Run [PR-008G's](../tasks/WOS-04-IDENTICAL-ENTRY-FLAGS.md) fresh/049 upgrade/replay, legacy-decision neutrality, manual/import and real worker/approver browser gates. Keep the additive column and retained metadata on rollback; older code ignores these optional checks, so it cannot claim they were displayed or recorded for later submissions. A missing historical check is unchecked, never a clean result. Intentional splits may share content: advisories must not be interpreted as authorization to delete entries or exclude hours/billability. No deployment, destructive down migration or release acceptance is included. Optional independent/formal reviews remain outstanding.

## PR-008H retained work history inspector

The [PR-008H reader](../tasks/WOS-04-WORK-SUBMISSION-HISTORY.md) needs existing submission/decision tables through migration050 and adds no migration/backfill or grant. Open history explicitly for the current authorized work period; use Older/Latest versions to navigate bounded pages. Empty history may mean work predates retained tracking and is not proof that work was never submitted/approved. A history failure must remain an unavailable/error state; retry for the current header/scope rather than treating it as empty. Snapshot content and recorded decisions remain distinct from current Draft/Rejected edits. Evidence links are references opened by the user, never fetched/previewed by the server. Rollback hides the read-only inspector while preserving all immutable ledgers/guards, work and approval state. No cleanup, down migration, running deployment or release acceptance is included; optional formal reviews remain outstanding.

## PR-008J explicit standard-threshold policy migration and rollback

Migration051 adds nullable policy overtime configuration, nullable saved import-warning arrays, strict shape validation and additive deferred SQL guards/bulk reader. It installs no policy, threshold, grant or history/work backfill. Existing nullable rules mean off; older omitted policy writes inherit the latest explicit setting, while explicit off disables prospectively at the existing Weekly boundary. The first buyer must explicitly select values/treatment; this engineering slice does not supply defaults or legal/payroll authority. Current warnings differ from immutable prior approval decisions. Saved batch diagnostics remain stable on replay, even after later work changes. Run [PR-008J's](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md) unit/transport, fresh/050 upgrade/replay, concurrent/manual/both imports/direct-SQL and real browser gates with the retained suite. Keep migration051, history, batch diagnostics and guards on rollback. Use a forward-compatible binary that understands block rules before resuming writes; do not drop controls to run an old binary. No down migration, deployment/running-system change or release acceptance is authorized. Optional formal reviews remain outstanding.

## PR-008K submission deadline/grace migration and rollback

Migration052 adds nullable explicit deadline configuration, nullable immutable submission/import timing arrays, shape checks, legacy omitted-setting inheritance and an additive deferred Submitted-transition guard. It rewrites no old work, rule, grant or history. No deadline or value is installed by default. Select the supported UTC Weekly end-date profile and enter all offset/time/grace/treatment values explicitly; regional/DST/group precedence is not inferred. Current previews are checked-at diagnostics; new submission timing remains immutable and replay retains the original batch instant/results. Old history without timing is unchecked, not inferred timely. Run the [PR-008K](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md) fresh/051 upgrade/replay, exact boundary/grace/year, manual/both imports/SQL, scope/history and real UI gates with retained regression/production/CI. Keep migration052, guards and immutable timing on rollback; resume writes only with a compatible binary that understands enabled block rules. No destructive down migration or live deployment is included. Canonical overdue notification recipient resolution/delivery remains the later specified work package; this feature sends no notification and schedules no monitor. Optional independent/formal reviews remain outstanding; full R3/PR008/integrated/UAT/release acceptance is not claimed.

## PR-008L source identity migration and rollback

Migration053 adds nullable work-entry identity, immutable nullable import source-check evidence, strict shapes and an append-only scoped claim ledger with registration/final-state guards. It installs no identities, source matches, grants, defaults or work/history backfill. Explicitly entered keys select the create/conflict contract: recorded linked content cannot be edited, cleared, deleted or moved through ordinary replacement. Namespace/ID is a self-asserted producer key, not verified provider provenance or actor authority. Preserve original Web/import batch/audit identity separately. Invalid/conflicting source rows must be reviewed; no automatic matching/relinking or claim deletion repairs them. Changed-source amendments require a later explicit versioned contract.

Run [PR-008L's](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md) exact key/Unicode/decimal, fresh/052 upgrade/replay, both imports/CSV/preview/concurrency/SQL, immutable history, real Employee/import/approver and owner/CAS gates plus retained suites. A missing source capture acknowledgement or recorded import check is uncertain, not success: reload authorized work/check Import History before retrying; never assume an older server captured unknown fields. Optional formal reviews remain outstanding. Keep migration053, claims/guards and immutable histories/checks on rollback. Pre053 binaries cannot preserve this metadata; attempted source-linked replacement must remain denied, and compatible code is required before such writes resume. No destructive down migration, live rollout, provider connection, scan/review retry, grant/spend or monitoring/protection change is included. R3 remains explicitly UTC-only with notification/integration delivery outstanding.

### Workforce capability versions (PR-008M)

Migration054 installs an initially empty scoped immutable capability-version store; existing workers, work/source claims, assignments, approvals, catalogs, commercial terms and permissions are unchanged. Buyer-entered skill/proficiency/certification labels are exact and not externally verified; explicit inclusive dates/no-expiry are planning information. Notes do not calculate available capacity. Read-back after uncertain save before any retry; stale409 requires current version reload. Clear records an empty version and retains history. On rollback retain the table, FK/validation/immutability guards and audit, and use a compatible binary to edit capabilities. No destructive down migration, history deletion, live rollout or default/grant activation is included.

### Resource demand versions (PR-008N)

Migration055 installs initially empty scoped demand roots/versions and exact assignment/capability snapshots. It adds no buyer unit/status/quantity defaults, role grants or inferred legacy demand, and leaves prior tables/evidence unchanged. Planning statuses are explicit records, not approval or measured fulfilment. References are documentary/nonexclusive: do not aggregate them as allocation reservations or available capacity. Stale409 requires source refresh/current demand reload; uncertain writes require read-back using the retained client demand UUID before any retry. Scope-limited readers receive withheld worker references and cannot silently drop them through replacement. No reference command edits/ends allocations or protected work. On rollback preserve roots, versions, snapshots, validation/immutability guards and audit; use a compatible binary for edits. No destructive down migration, live rollout or default/grant activation is included.

## Effective worker capacity migration and evidence (PR-008O)

Migration056 adds empty immutable worker_capacity_versions and worker_capacity_evidence plus scoped validation/sequence guards. No existing calendar/worker/leave/work/assignment/approval/financial rows, buyer defaults or grants are rewritten. Read/compute with existing workforce scope; configure with employees.manage/settings.manage and retain operational evidence with reports.export. Explicitly enter baseline, part-time percentage, every weekday quantity, eligibility, nullable group/override reference, prospective date and reason. First-week patterns must fit existing dated calendar authority. The editor never repairs/creates catalogs or silently follows a retired reference. Missing organization-default storage or ambiguous authority produces a precise unavailable result.

Calculate a chosen inclusive period of at most366 business dates, then retain the source-bound server result explicitly. Later source changes require recalculation; stale409 and uncertain writes require read-back before retry. Retained results and prior profile periods remain unchanged. Unknown legacy multiday leave allocation and overlapping partial records stay unavailable; do not spread amounts across dates or add overlaps. Full holidays/full absences reduce scheduled capacity once. Worker On Leave status is not another deduction. Explicit noneligible profiles have zero eligible denominator independent of available hours. No productive numerator or financial amount is calculated. Demand candidates show these totals without ranking/reservation/quantity conversion. Older annual/utilization reports remain labeled compatibility paths pending R9.

Run worker-capacity unit/transport, PostgreSQL fresh/055 upgrade/replay and real React/API/PostgreSQL journey tests with all retained gates. Rollback hides the new reader/editor while preserving migration056, immutable profiles/results/proof, guards and audit. Use a compatible binary before resuming capacity writes; no destructive down migration, data cleanup, rollout or release acceptance is authorized. Optional formal review remains deferred/outstanding.

## Assignment version tracking and rollback (PR-008P)

Migration057 adds an empty immutable assignment_versions ledger and a source trigger; no allocation/worker/work/demand/financial row, setting or grant is backfilled. Future actual Web/manual/CSV/soft-end writes capture the stored exact percentage snapshot/revision with server writer/source/batch metadata. Direct SQL has explicit Database/session-user provenance. An older source's first change retains an ObservedBaseline at observation time; original writer/decision/treatment history stays unknown. This is not an approved effective-date conversion. Both import aliases retain old validation/coercion/partial outcomes; dry run and exact replay append no versions.

Use Allocation Control's Versions / exact edit to load current source/history. Guarded updates require exact percentage fields, full source+ledger CAS and reason. Read back after409/uncertainty; no automatic retry or overwrite. Current/older worker/project scope applies independently; withheld history is not missing history. Chosen-period R6 hours remain separate from percentages, with unavailable authority preserved. New submitted work pins the current assignment version; later source edits/end do not rewrite it. Observed binding/model and old allocation-change approval records do not establish effective rates or configurable assignment approval. No buyer values, conversion, exception or protected reopen is installed.

Run assignment-versions unit/production-transport, fresh/056 upgrade/replay/API/SQL/import parity and real React/Employee journeys plus retained gates. Rollback preserves migration057, immutable ledger, pins, guards and audit. A pre057 binary cannot attribute Web/import writes; the trigger records Database provenance when context is absent. Use a compatible binary before resuming attributed writes, never remove history/triggers to conceal the gap. No destructive down migration, deployment or release acceptance. Optional formal reviews remain outstanding.

## Own-worker period view (PR-008Q)

In canonical ESS overview/work and compatibility Employee Workspace's work section, explicitly choose start/end dates of at most366 days. This section uses the authenticated account's server-linked worker record independently of legacy ESS profile lookup. Missing/out-of-scope binding requires the normal account-linking/scope process; it must not substitute another visible employee. No binding migration, catalog repair, access grant or buyer default is installed. Dates/owner/scope changes clear the view; reload explicitly after unavailable/conflict responses. Legacy overview calculations are labeled compatibility output.

Available/eligible hours use existing R6 authority; approved absence/holidays are counted once. Unknown capacity stays unavailable while assignments/current-work facts remain independently visible. Each assignment/work list is at most20 rows with explicit next/older/first-page actions. Exact source percentages are not added or converted into hours. Read-only assignment versions and retained work history are checked against the canonical worker. Current Draft/Submitted/Approved/Rejected state is distinct from retained submission/decision history. Open ordinary work capture and explicitly select the work period there for changes; this view adds no approval/reopen/edit action.

Run own-work-planning production transport, real PostgreSQL/API and Employee Workspace React/API/PostgreSQL tests plus retained gates. Local test sessions/disposable databases are synthetic harnesses, not production OIDC/UAT. No migration is needed; rollback hides this view/route while preserving all source/history tables and existing writers/routes. No data cleanup, deployment or release acceptance. Optional independent/formal reviews remain outstanding.

## Adopted native percentage overlap policy (PR-008R)

In Allocation Control, use existing settings/manage authority to load current overlap policy, then explicitly enter enabled/off, prospective date, nullable exact warning/block percentages and reason. No values are installed on upgrade and fields are not silently inherited. Only simultaneous Active declared percentages count. Warning≤block when both are selected; equality passes. An incompatible blocking adoption is rejected without source/history edits; remediate through ordinary authorized source commands or enter a compatible explicit threshold. Do not grandfather records, disable existing controls or infer an exception. Explicit off is a later immutable version; the independent legacy guard still applies.

Normal create/edit, guarded exact edit, both CSV apply aliases and SQL enforce the policy in the same lifecycle-lock transaction. Manual accepted warnings, import row diagnostics and retained assignment-version assessments identify exact source quantities and governing policy. Versioned preview stages accepted rows sequentially; blocked rows do not contribute later. Legacy import is apply-only. v1 UI applies validated rows and carries rejected errors; retain the preview batch for full blocked-row assessments and the apply batch for actual accepted writes/replay. Uncertain outcomes require read-back, never blind retry. No percentages are converted into hours or financial/approval authority. Earlier versions with no assessment remain not recorded; unconfigured/off decisions and prior work stay immutable.

Run assignment-overlap unit/production transport, real PostgreSQL fresh/057 upgrade/replay/contention/import and real Allocation Control/import/history journeys plus retained gates. Synthetic test sessions/databases are not production OIDC/owner UAT. Rollback hides the new surface while retaining migration058/policies/evidence/guards and requires a compatible binary before resuming policy-aware writes. No destructive down migration, trigger removal, deployment or release acceptance. Optional independent/formal reviews remain outstanding.

## Configured pending-stage reminder operation

With migration070 installed, an actor holding the existing approval/notification configuration and source-read permissions may explicitly link a retained due-policy version, choose a positive whole-minute pre-due reminder interval, UTC-effective date, locale, plain-text template and reason in Approvals. No rule is seeded. The same interface can append an explicit disabled version for future instances. Only instances created after an eligible adoption bind; original due clocks and earlier notices never change. Old/inherited pending clocks are not adopted retrospectively.

Inspect the current retained stage before recording an on-demand evaluation. Only the interval from reminder instant (inclusive) to due instant (exclusive) sends once to the current named approver and an eligible bound delegate; escalation targets belong to the separate overdue flow. There is no automatic scheduler or external delivery. Existing notification preferences do not suppress this mandatory in-app handoff. Missing recipient authority or delivery failure rolls back the operation.

If a response is uncertain, retain its request identity and use the exact read-only lookup before any explicit original-request retry; a missing result does not prove nonexecution. Account/role/scope changes require explicit reload and stop unsent operations. Read acknowledgements belong to the exact recipient. Inspect immutable evaluation, policy, source and owned inbox history; never reset a clock, rewrite old rows or backdate a policy. Rollback means disabling the new UI/routes while retaining append-only schema/evidence and compatible readers; no destructive down migration or deployment is authorized by this increment.

## Operational control workspace

Open Reports → Operational Control with existing workforce, project, allocation and utilization-report permissions and an explicitly selected organization/legal entity. Enter actual start/end dates and a separate native forecast start/horizon; no threshold, schedule, manager or policy is selected automatically. The roster count is current persisted Active status, independent from each effective capacity date. Ten-worker pages are separate consistent observations and must not be summed as a company utilization total. A roster/context/selection conflict requires refresh from the first page.

Inspect per-worker exact actual/capacity and separate native staffing sources; missing calendar/profile/threshold/project authority remains unavailable. Pending governed stages span current source dates and require existing approval/source reads. A listed item grants no decision authority: opening it prefills only its identifier, then the operator explicitly inspects the retained source and chooses the decision/reason. The original per-item command validates current stage, actor/delegation, source, scope and notification atomicity. Uncertain results retain the original request and use exact read-only reconciliation; never automatically retry writes. Refresh the control snapshot after decisions/source changes.

Actual/export handoff retains the selected period and capacity-source CAS; changed authority requires a fresh snapshot. Forecast/assignment handoff retains original percentage units and existing named approval/version controls. Existing server evidence/export permissions, audit and immutable CSV govern retention/redownload. Scope/role/token changes clear results and unsent handoffs. This route is not a finance report, unattended scheduler, protected reopen or compatibility-report replacement. Rollback reverts the new route/read/workflow surface and optional prefill wiring, preserving all source/approval/evidence records; no migration/down migration or deployment is involved.

## Canonical own-worker workspace

The additive `/my-workspace/current` route uses existing employee-workspace and worker-read permissions, current organization/legal-entity scope and the authenticated server worker binding. Choose explicit dates and load. The profile is current source data, not a historical reconstruction or capacity schedule. Absence, missing entitlement and unavailable access are not converted into zero. Stored leave balances remain separate by type/year; each list is bounded to20rows with source-bound continuation. Refresh from first pages after409 source/binding conflict; never combine old pages or infer another worker from a browser code.

Use **Load my period** for the selected dated capacity/assignments/work view, then explicit governed actual calculation or retained history. Existing original-unit calculations, source-CAS/export permissions and immutable artifacts remain authoritative. A retained message in **My governed work notifications** is an observation, not approval/reopen authority; explicitly inspect the original source in its existing workflow before acting. Existing work and leave capture routes retain their own authorization and guards. A current Friday header may be saved as Draft but cannot be submitted before its date; the workspace does not loosen that rule.

Scope/account/token/role changes clear the new page and child handoffs. Refresh/reconcile original source history after any uncertain existing write; the new reader never issues or retries source writes. No new schema, live grants, default policy, external delivery or scheduler. Rollback removes this additive reader/page/navigation and optional owned-period prefill while retaining sources, approval/calendar/work history and CSV bytes. Old ESS and compatibility workspace remain available. Final review, dependency/main integration, buyer configuration, role UAT and release remain separate unpassed gates.

## Scoped directory and recorded reporting context

Existing `employees.view` holders may open `/workforce/directory` in an explicitly selected organization/legal entity. Load the current server-scoped directory, enter a literal search, or open a worker's recorded reporting context. Each page is bounded to20; counts cover only the visible matching selection/direct reports. A manager absent from that authorized view is not an inferred root or permission to inspect another scope. No hierarchy, manager or operational owner is inferred from a title.

Changing the current roster, relationships or access invalidates old continuation/navigation tokens; reload the first directory page explicitly. Account/active-role/token/scope changes clear results and unsent handoffs. Read failures have no local fallback or automatic retry. Skills and effective capacity open the original workspaces, which independently validate permissions, source versions and worker scope. Directory access grants no edits, export, approval or allocation authority. No schema, dependency, role defaults or permissions are installed by this increment. Rollback is source-only before use; existing capability/capacity versions and history remain in their original modules.

Only authored source, synthetic tests and technical documentation belong in the dependent Draft. Required exact-head checks and final reviews/integration/UAT/release gates remain distinct; no merge or deployment is authorized by this runbook.

## Prospective calendar authoring profile

### Country and worker-group scope profile

Use `/admin/calendar-scope-authoring` with existing settings access in the selected organization/legal entity. Choose applicability explicitly, load the owned scoped catalog, enter a future effective date and load eligible authorities. Inspect and explicitly select the current country authority or exact legal-owned business-unit version. Country authority requires current physical country and the effective legal profile at that date to agree; country transfers, foreign/shared groups and missing/expired references are not guessed. A country calendar participates in the existing organization/country fallback and can affect other legal entities in that country where native authority applies. Group selection is an exact version ID, never an inferred manager or same-code successor.

Enter code, name, IANA timezone, all working-day choices, native daily hours, complete sorted holiday list and reason. Inspect applicability/authority and the full replacement before saving. Later versions retain immutable definitions and authority snapshots; explicit removal of all holidays is a complete clear for the new version. There are no seeded defaults or automatic capacity-profile mutations. Original group → legal → country precedence and explicit override remain authoritative. A second source at one tier can make an automatic profile ambiguous; a retired/expired group can make its pinned reference unavailable. Reload the exact source and use existing explicit capacity adoption rather than assuming a replacement.

Migration072 adds empty scoped lineage/version/command records and guards only these newly governed country/group projections. It preserves071 source records, functions and strict calendar-authoring/1 endpoints. Fresh/071-populated-upgrade/replay must preserve old native/ledger/identity/grant/capacity/leave/audit/history rows. No conversion/backfill, live grants, protected-period change, new provider or schedule conversion is included. Country/group catalog configuration and retired-lineage adoption are separate mechanics.

For an uncertain response, stop editing/new saves and choose **Reconcile original scoped calendar request**. It reads the original actor-owned receipt without repeating the write. A404 may still be an in-flight write; do not invent a new request key or edit native rows. A scope/account/role/token change clears unsent UI state and suppresses late responses. Record and reconcile committed state through normal authorized access before further authoring.

Roll back operation by stopping new authoring while preserving the additive schema and receipts. Roll forward through a later explicit prospective version and separately adopted worker references. Native compatibility/SQL writes cannot retire or rewrite these governed projections; no destructive down migration or history rewrite is supported. Retained results/artifacts remain immutable while fresh source tokens can legitimately change. This is a dependent development Draft, not deployment or whole-calendar/release acceptance; qualified reviews, stack/protection/main integration, UAT and release remain open.

### Legal-entity scope profile (PR94)

Existing settings.manage holders open `/admin/calendar-authoring`, load the scoped authored catalog and explicitly enter a new code, name, timezone, workdays, native daily hours, future UTC effective date, complete holiday list and reason. Empty holidays are an explicit replacement; later versions must inspect the retained source and replace the complete bundle. Existing/retired codes cannot be adopted here. No buyer defaults, country/group mutation, retirement or automatic worker rebinding is added. Use the scoped directory and original capacity editor to adopt each new calendar version reference explicitly. An expired old pin remains unavailable until valid authority is adopted.

Migration071 is additive and empty; install through the normal ordered migration command. Fresh/070-upgrade/replay checks must pass with prior identity/grants, calendars/holidays, capacity/leave/history/audit unchanged. The two append-only authoring tables retain exact commands, actor/role/source/clocks, immutable definitions and projection provenance. Per-source CAS and per-actor request keys serialize commands; native calendar/holiday guards and atomic audit/projection checks refuse incomplete or bypassed governed writes. Legacy unrelated paths retain their compatibility behavior.

For a lost/uncertain save response, keep the original request key and use **Reconcile original calendar request**. This reads the owned receipt; it never repeats a write. A404 does not prove an in-flight write rolled back. Do not invent another key or manually rewrite/delete calendar history. Actor/role/token/scope changes clear unsent UI state and suppress late responses. Reconcile committed state through the original actor's normal authorized session before further authoring.

Operational rollback is to stop new authoring and preserve the additive schema, durable receipts and native projections. Roll forward corrections with a later explicit prospective version and separately adopted capacity profile. No destructive down migration, history rewrite, automatic conversion or current source rebound is supported. This dependent Draft is not deployment authorization; qualified reviews, main/dependency/protection acceptance, UAT and release remain outstanding. See `docs/tasks/WOS-02-CALENDAR-AUTHORING-REMAINDER.md`.
