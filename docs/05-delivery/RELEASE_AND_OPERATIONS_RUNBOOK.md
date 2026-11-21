# WorkOS Release and Operations Runbook

## WOS03 integration verification

Run `node scripts/scan-bootstrap.mjs --self-test` as a required gate. It scans the candidate and checks adversarial fixtures; passing dependency audit alone does not satisfy it. Test credentials must remain ephemeral or explicitly approved placeholders. Keep the validation runner on Ubuntu24.04 while using the current Playwright lock; Ubuntu26.04 browser installation failed before tests in run43557067008. Changing the runner or browser version requires fresh browser acceptance.

Before accepting PR41 against updated main, run its existing browser, migration, identity and API checks plus `npm run test:import-audit-journey` with a disposable local PostgreSQL service and installed Chromium. The journey uses two synthetic named accounts and the actual UI/API/database; it must not reach external providers. See [integration acceptance](../tasks/WOS-03-INTEGRATION-ACCEPTANCE.md). This increment adds no migration. A code rollback must preserve existing audit/import evidence and migration history; do not erase evidence to restore an older UI. Passing this journey does not establish retention-policy or buyer OIDC acceptance.

## Purpose

Provide a repeatable buyer-owned release, deployment, verification, rollback and operating process. Provider-specific commands will be added with implementation artifacts; this document defines mandatory control flow.

## Release preparation

The [main dependency repair](../tasks/WOS-03-MAIN-DEPENDENCY-REPAIR.md) documents the locked versions and negative regression checks required after the 2026-11-14 audit failure. Install with `npm ci`, run `npm run test:dependency-security` and the existing application/production/migration gates, and retain a current `npm audit` result. Do not disable the high/critical audit gate to merge documentation or reuse passing checks from an unmerged feature branch. Reverting the repaired lockfile reintroduces known advisory exposure; prefer a tested forward repair.

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

## Standard-profile API performance

Set `WORKOS_TEST_DATABASE_URL` to a disposable loopback PostgreSQL service with database creation rights and run `npm run test:standard-profile`. The test creates and removes its own database. It seeds 250 workforce accounts, 25 clients, 50 projects, 250 assignments, eight weeks of approved work (10,000 entries), 2,000 submission audit rows and 50 commercial milestones.

Each of four phases runs six rounds of 75 simultaneous requests. Throughout, 55 employees read their own histories and five administrators read the planned utilization report. In the first phase 15 employees save drafts. The same employees submit those drafts with their retained write tokens in the second phase. In the third, 15 team leads retrieve their current direct reports’ submitted versions under the 2,000 ms read target. In the fourth, they approve using the exact tokens returned to their own reviewer sessions. The fixture checks that employees cannot open the review list, team leads cannot see draft work there, and revoking approval access closes that route. The test verifies the 90 hours and 90 timesheets at each transition, then checks retained submitter and reviewer identities. Times include local HTTP transport, authorization, database access and response decoding. The first round counts. The nearest-rank 95th percentile must stay within 2,000 ms for reads and 3,000 ms for each mutation type. Each report must complete within 5,000 ms. The job summary records sample counts, p95 and maximum durations. Migration 082c indexes entry lookups by timesheet and work date. The rehearsal checks the PostgreSQL execution plan after analyzing the populated database. Schedule the index build in the migration window because PostgreSQL can block entry writes while building it. For application rollback, retain the index and migration ledger. Repeat on buyer-equivalent infrastructure and record the machine, PostgreSQL version and release commit for deployment sign-off.

## Reviewing corrected work

For direct timesheet status integrations, retain the `write_token` from the reviewed timesheet and send it as `expected_write_token` with the approval or rejection. A 409 with `WORK_REVIEW_VERSION_CHANGED` requires reading the revised entries and making a fresh decision. Never fetch a new token solely to retry an old decision. The web desk supplies the token for every connected decision. The legacy API continues to accept calls that omit it.

## Bulk timesheet approval recovery

Review the selected employees and weeks before confirming. Expand **View individual outcomes** to see the current recorded status and whether each command was acknowledged. A missing acknowledgement can accompany a committed approval. Review any timesheet still submitted, including its pending approval stage, before retrying. If the status refresh fails, use **Reload approvals** to retrieve current records before another decision.

## Direct-report review access

The team-lead approval desk requires timesheet submission and approval permissions plus a current direct reporting relationship in the selected legal entity. A reassignment removes the former manager’s access on the next list or history request. Draft work stays in the employee’s personal workspace. If expected submissions are missing, verify the employee’s manager, legal entity, status and the reviewer’s active role and permissions.

## Approval scope changes

Switching the organization scope closes the approval workspace, including any unsent correction reason. If the application did not reload automatically, select **Reload approvals**. If a switch interrupted a submitted decision, reopen its original scope to verify the recorded status before retrying.

## Timesheet approval CSV performance

Run `npm run test:timesheet-export-browser` with the locked Chromium version and the disposable PostgreSQL service. The test exercises the approval page and verifies focus, row order, formula escaping, audit and cancellation. Its large-file check expands a scoped API response to 10,000 entries in the browser fixture. For buyer acceptance, repeat an export on representative devices and measure time to download with the buyer’s actual volume.

## Backup and restore

1. Record the application commit, database version, migration ledger, backup timestamp and approved reconciliation totals. Configure buyer-controlled encrypted storage, access, retention and an off-site copy. Provision cluster roles, extension binaries, deployment secrets and external document storage through their respective recovery procedures.
2. Use the matching PostgreSQL client tools. Supply connection details via a protected service file and password file. Run `pg_dump --format=custom --no-password --file=workos.dump --dbname=service=workos_backup` into a restricted directory. Verify the stored archive checksum against the digest recorded at backup time.
3. Provision a fresh isolated recovery database with the expected owners. Verify the target service points to it, then run `pg_restore --single-transaction --exit-on-error --no-password --dbname=service=workos_recovery workos.dump`. Keep outbound integrations disabled. If restoration fails, investigate before retrying in a new recovery database.
4. Start the matching release in isolation. Check the ledger, audit continuity, financial totals, authorized and denied role journeys, and an audited write. Record elapsed recovery time and the latest recovered transaction against the buyer’s RTO and RPO before authorizing cutover.
5. For synthetic release evidence, point `WORKOS_TEST_DATABASE_URL` at a disposable loopback PostgreSQL instance with database creation rights and run `npm run test:restore`. The test creates two temporary databases and compares row counts and fingerprints for every public table before starting the recovered API.

Buyer policy defines frequency, retention, encryption and RPO/RTO. Restore rehearsal verifies application version, schema, organization/configuration, users/roles, critical counts, audit continuity, commercial control totals and representative role journeys.

## Delivery monitoring

Run `npm run --silent ops:delivery-health` once per buyer database from the application runtime with its normal database TLS settings. Use a dedicated monitoring identity with CONNECT on the buyer database, USAGE on schema public and only these column grants (substitute the buyer's role name).

```sql
GRANT SELECT (status, created_at) ON public.invoice_export_alert_outbox TO delivery_monitor;
GRANT SELECT (status, created_at) ON public.integration_event_logs TO delivery_monitor;
GRANT SELECT (status, attempted_at) ON public.notification_delivery_attempts TO delivery_monitor;
GRANT SELECT (created_at) ON public.invoice_export_notice_producer_failures TO delivery_monitor;
GRANT SELECT (created_at) ON public.invoice_export_notice_failures TO delivery_monitor;
```

Each invocation returns one JSON sample. `sampledAt` uses database time. `pendingInvoiceAlerts` counts persisted pending alerts. `oldestPendingSeconds` measures the oldest one's age and is null for an empty queue. External alert dispatch is pending implementation. The four failure counts cover occurrences in the preceding 15 minutes, including failures subsequently recovered. Some signals can describe the same incident. Compare consecutive samples individually because their windows overlap.

Buyer operations owns the sampling schedule and thresholds. Route growing queue age or invoice-notice failures to the billing integration owner and other integration failures to the relevant provider owner. A nonzero exit with `DELIVERY_HEALTH_UNAVAILABLE` means the reading failed. Alert operations on a missing reading. To roll back monitoring, stop the scheduled command and revoke the reader grants.

## API traffic monitoring

Collect JSON stdout from each production API replica and select records with `operation=http.traffic`. Each process emits a window about every 60 seconds, including idle windows. Identify replicas using the log collector’s deployment labels. Records contain aggregate counts only. Use existing failure events and their correlation IDs for individual incident investigation.

- **Error rate.** Sum all replicas’ `responses["5xx"]` over the alert period and divide by the sum of all completed response counts. Track 4xx and `interrupted` (connection closed before response completion) separately. A zero denominator means no completed traffic. Probe traffic contributes to the totals.
- **Latency.** Sum `latencyCounts` by index across windows and replicas. The first seven bins have inclusive upper bounds of 100, 250, 500, 1,000, 2,000, 3,000 and 5,000 ms. The last bin counts slower requests. Use the first bin whose cumulative count reaches 95% to bound p95. Durations run from API middleware admission until the server finishes writing the response. Interrupted requests have no latency sample.
- **Traffic and saturation.** Divide completed responses by the measured window duration in seconds per replica, then sum those rates. `inFlight` is a gauge at the window boundary. A long request contributes to the window in which it finishes. An abruptly stopped replica can lose its last partial window.
- **Ownership.** Before cutover the buyer operations lead assigns an on-call responder, alert destination, thresholds and escalation interval. Page the responder for sustained 5xx or latency increases and missing summaries from a serving replica. Check readiness, database and identity-provider health, then examine correlated failure logs. Exercise alert delivery and recovery on the buyer installation.

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

`npm run test:import-audit-harness` runs guard/session-format unit checks without database/browser and is part of the aggregate suite. The hosted dedicated journey is additive to the twelve retained browser suites and all existing gates. The original October local browser/database execution was NOT RUN; preserve that historical receipt. The journey was subsequently forwardported into accepted PR41 and passed real PostgreSQL/browser hosted execution. Current CI continues to run it; require exact-head evidence for each integration. PR50 now changes documentation only and preserves the newer accepted harness unchanged. Reverting this documentation reconciliation does not remove the accepted journey or require data conversion.

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

Explicit Proposed promotion additionally requires one scoped creation event from a transactional project writer and exclusively Proposed status history. Resetting an Active/On Hold/Completed project to Proposed does not make it eligible. Retained pre-scope history, missing/malformed/ambiguous creation evidence or a non-Proposed neutral migration snapshot require separately governed conversion. Client-reported audit events cannot establish creation provenance. Do not fabricate history to enable promotion; ordinary legacy operation remains available for ungoverned records.

Inspect closure dependencies for actual existing assignment/work/pending-approval/milestone/PO/owner evidence. Missing approved-unbilled/balance/PO-consumption/acceptance modules are labelled unavailable, never zero; closure stays unavailable even when existing counts are zero. Reconcile unknown network outcomes by reload and history before any repeat. Changing identity/role/permission/token/scope clears confidential view/draft ownership; an in-flight old-scope command may finish there but must not restore stale UI state.

Migration041 adds immutable lifecycle/bindings/guards and retains040 untouched. Roll forward preferred; any rollback binary must be validated with040/041 manifest and all evidence/guards retained. Never drop bindings/ledger, erase migration history or re-enable unrestricted legacy writes as rollback. All prior unit/browser/PostgreSQL/identity/scan/container gates remain required, with new lifecycle strict-service, real PostgreSQL and real React/API/PostgreSQL tests additive. Local browser/DB absence is NOT RUN; require exact-head hosted evidence. No credentials, providers, production/customer data, denied repair/diagnostic, Ready/merge/deploy or formal release acceptance is involved.

## Assignment and work-date authority (PR-008A)

Allocation and work writers validate the worker timeline, selected scope, assignment policy and each governed hierarchy member's active state and independently adopted terms on the relevant dates. Parent amendments do not authorize a child implicitly. Non-billable policy cannot be overridden by an incoming billability value. Legacy unpinned work remains visibly unpinned; do not manufacture historical commercial evidence.

New submissions retain immutable work/policy evidence under migration044. Correct only editable Draft/Rejected periods through the authorized workflow, preserving earlier submissions and decisions. On a period, history or lifecycle conflict, reload the source before correcting it. Source-aware approval controls remain authoritative; a Teams evidence-only action cannot decide a timesheet. For an uncertain import, reconcile the retained batch/history or reuse its existing operation key; do not create a second apply with a new key.

Submission assurance describes retained operational evidence, not billing eligibility or invoice readiness. Do not bypass a locked period or inactive hierarchy through imports, demo reseeding or direct data edits. Rollback requires a forward-compatible binary retaining migration044, submission/decision ledgers and database immutability guards. A pre044 writer is unsupported. Configurable work capture, richer capacity policy and later financial controls remain separate work packages.

MyTimesheet displays assurance only after the selected worker/week loads. Changing week or identity abandons the old view's presentation; an already-dispatched save can still complete on its original period. Return to that period and reload to reconcile its history before repeating an uncertain submission. A failed load keeps submission disabled; reload the current view to recover.

## Daily and weekly work capture (PR-008C)

An authorized scoped settings manager must explicitly enable weekly grid, daily entry or both; no default mode or permission is installed. Both presentations save the same complete weekly header. Daily entry reaches all seven Saturday-Friday dates and does not create daily approval. Hidden dates, distinct contexts and preserved entries remain part of the complete save.

A stale work revision or changed mode policy rejects the command. Reload authoritative work before reconciling another edit; never manufacture a write token or retry an uncertain save as an unconditional legacy command. If scope changes during an in-flight operation, wait for settlement before using Reload work. Existing period locks, capture rules, approval and retained evidence still govern the whole header.

Retain migration046 and immutable mode history on rollback, with the documented legacy API compatibility contract. This package does not add categories, evidence, overtime, deadline or reopen policy. Buyer configuration and full release acceptance remain separate.

## Effective-dated capture policy (PR-008B)

Authorized scoped settings managers append capture rules at a configured current or future UTC Weekly reporting-period boundary. Select an actual available boundary; do not infer a start date, backdate a policy or install a default. Rules govern exact time increments, optional daily/weekly totals and positive-entry comments across all of a worker's work headers in the period. Existing work and submission evidence are not silently rewritten.

After an uncertain policy append or an expected-version conflict, reload current policy history before making another decision. Do not manufacture a replacement expected version or bypass old/new period protections through imports or direct data edits. Correct invalid quantities/comments only in editable work. The compatibility grid retains distinct contexts, comments, billability, weekends and off-grid entries; preserved read-only entries still count toward authoritative limits.

If an organization switch fails while a timesheet save is pending, wait for the operation to settle, then select Reload work. Earlier replacement reads cannot establish its final outcome; editing stays disabled until this explicit reload succeeds. Do not repeat an uncertain command before reconciliation.

Migration045 and its immutable policies, capture references and database guards must remain on rollback. Use a forward-compatible binary honoring both assignment and capture authority. Capture rules do not confer billing eligibility or approval authority. Daily-entry modes, full categories, evidence requirements, overtime exceptions, deadlines and protected reopen workflows remain separate packages.

## Governed commercial amendments (PR-007D)

Amendment operators need explicit `commercial.amendments.manage` enrollment through Permission Settings, plus commercial view and lifecycle management permissions and the applicable organization/legal-entity scope. Permission managers may grant or revoke amendment authority for eligible roles or individual accounts. No role, including Admin, receives this permission by default. Retain permission-change history; granting authority or requesting a preview does not adopt terms.

Preview and explicitly adopt a selected immutable contract version for each governed entity separately. Parent adoption does not cascade to children. Reconcile uncertain command outcomes against current state and amendment history before resubmitting. Current terms are operational evidence, not authority to reprice historical work or determine billing eligibility. Migration043 and its append-only amendment ledger must survive rollback; use a forward-compatible binary and do not erase audit, historical pins or amendments.

## Scoped client profiles (PR-007C)

Migration042 adds customer profile and billing-unit histories without changing operational client identity, contractual pins or existing work. Buyer organization/legal-entity ownership is separate from customer billing entities. Missing legacy legal/display names, codes and currency defaults remain explicitly incomplete; enter verified commercial profile values rather than inferring them from operational labels.

An authorized permission manager can explicitly grant `commercial.clients.view` and `commercial.clients.manage` to eligible roles or individual accounts through Permission Settings. These permissions have no default grants, including for Admin. They are not Admin-only recipient capabilities. Managing profiles also requires view access; ordinary client, contract or lifecycle permissions do not substitute. Existing organization/legal-entity scope enforcement still applies. Revoke grants through the same controls; recorded permission changes and audit evidence must be retained.

Inspect current/as-of history before appending a version with a reason. New defaults do not rewrite earlier contracts, work or financial evidence. After an uncertain save, reload to reconcile before retrying; Cancel does not remove that requirement. Malformed response data must remain unavailable rather than being displayed as another customer-unit kind. No invoice routing, billing eligibility, tax/payment identifiers, retirement or cross-legal consolidation is supplied by this package.

Rollback requires a validated forward-compatible binary retaining migration042 and immutable profile/version evidence. Disable affected UI/routes if needed; do not delete evidence or migration ledger entries. A pre042 binary is unsupported. Production OIDC, buyer-scale performance, role UAT and formal release acceptance remain separate gates.

## PR-008D evidence-link migration and rollback

Migration047 adds nullable work-entry URLs without rewriting accepted work, grants or immutable histories. Run the feature unit, PostgreSQL upgrade/replay and real browser journey gates described in [PR-008D](../tasks/WOS-04-WORK-ENTRY-EVIDENCE.md). Independent exact-head review and executable acceptance are required; the dependent Draft is not release acceptance. URLs are references only and are never automatically fetched. Preserve migration047/history on rollback. Pre047 binaries cannot preserve evidence during entry replacement: if restoring one, keep work writes disabled operationally and roll forward to an evidence-aware binary before resuming. No destructive down migration, running-environment change or deployment is authorized.

## PR-008E work-reference migration and rollback

Migration048 adds nullable work-reference text without rewriting old entries, URLs, grants or immutable history. Validate the fresh/047-upgrade/replay and real API/browser gates in [PR-008E](../tasks/WOS-04-WORK-ENTRY-REFERENCE.md). Text is displayed as escaped content and is never looked up or interpreted as financial/source authority. Retain migration048/history on rollback. Pre048 binaries do not understand reference preservation; if restoring one, keep work writes operationally disabled until an aware binary is restored. This guidance grants no deployment/running-system change. Independent exact-head code/security review and executable acceptance remain required; Draft engineering evidence is not release acceptance.

## PR-008F required-evidence policy migration and rollback

Migration049 adds nullable policy evidence configuration and extends existing append/deferred work guards. Existing policies remain optional; new omitted appends inherit the latest setting. No history, work, grant or default adoption is rewritten. Run [PR-008F's](../tasks/WOS-04-REQUIRED-EVIDENCE-POLICY.md) fresh/048 upgrade/replay, policy inheritance and real API/browser gates. Preserve migration049 and its guards/history on rollback. Pre049 binaries cannot project or prevalidate this option; use a forward-compatible binary before resuming work/policy writes. This grants no deployment or running-system change. Independent exact-head review and executable acceptance remain required; Draft engineering evidence is not release acceptance.

## PR-008G identical-entry diagnostic migration and rollback

Migration050 adds only nullable `work_submission_evidence.duplicate_entry_check` with a version/object/array shape constraint. Existing append-only submission guards protect the metadata. It does not backfill, rewrite work/history, change duplicate rejection rules, adopt policy or add grants. Run [PR-008G's](../tasks/WOS-04-IDENTICAL-ENTRY-FLAGS.md) fresh/049 upgrade/replay, legacy-decision neutrality, manual/import and real worker/approver browser gates. Keep the additive column and retained metadata on rollback; older code ignores these optional checks, so it cannot claim they were displayed or recorded for later submissions. A missing historical check is unchecked, never a clean result. Intentional splits may share content: advisories must not be interpreted as authorization to delete entries or exclude hours/billability. No deployment, destructive down migration or release acceptance is included. Independent exact-head review remains required.

Current owner authorization supersedes the historical review/merge deferral above. Fresh local acceptance, independent exact-head review and hosted gates are required before integration; release and buyer acceptance remain open.

## PR-008H retained work history inspector

The [PR-008H reader](../tasks/WOS-04-WORK-SUBMISSION-HISTORY.md) needs existing submission/decision tables through migration050 and adds no migration/backfill or grant. Open history explicitly for the current authorized work period; use Older/Latest versions to navigate bounded pages. Empty history may mean work predates retained tracking and is not proof that work was never submitted/approved. A history failure must remain an unavailable/error state; retry for the current header/scope rather than treating it as empty. Snapshot content and recorded decisions remain distinct from current Draft/Rejected edits. Evidence links are references opened by the user, never fetched/previewed by the server. Rollback hides the read-only inspector while preserving all immutable ledgers/guards, work and approval state. No cleanup, down migration, running deployment or release acceptance is included; optional formal reviews remain outstanding.

Current owner authorization supersedes PR-008H historical development-only review/merge deferrals. Integration uses accepted PR61 correction `e7439e3f8e57e39b925c10e316c5b7ce18fb2d40`; fresh local evidence, independent exact-head review and hosted checks remain required. Full TIM008/PR008 and release acceptance remain open.

## PR-008J explicit standard-threshold policy migration and rollback

Migration051 adds nullable policy overtime configuration, nullable saved import-warning arrays, strict shape validation and additive deferred SQL guards/bulk reader. It installs no policy, threshold, grant or history/work backfill. Existing nullable rules mean off; older omitted policy writes inherit the latest explicit setting, while explicit off disables prospectively at the existing Weekly boundary. The first buyer must explicitly select values/treatment; this engineering slice does not supply defaults or legal/payroll authority. Current warnings differ from immutable prior approval decisions. Saved batch diagnostics remain stable on replay, even after later work changes. Run [PR-008J's](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md) unit/transport, fresh/050 upgrade/replay, concurrent/manual/both imports/direct-SQL and real browser gates with the retained suite. Keep migration051, history, batch diagnostics and guards on rollback. Use a forward-compatible binary that understands block rules before resuming writes; do not drop controls to run an old binary. No down migration, deployment/running-system change or release acceptance is authorized. Optional formal reviews remain outstanding.

### PR-008J reviewed integration checkpoint — 2026-11-15

The owner's subsequent authorization supersedes this package's historical review/scan/merge deferral and original fixed-Draft dependency. Current integration includes accepted PR63/main `68d292a77730194ef428b42695aaefe33d429b72`. Bounded WOS-TIM-005 and WOS-CORE-003–005 evidence, response-validation corrections, exact executed gates and pending review/browser/hosted gates are recorded in [the package task](../tasks/WOS-04-OVERTIME-CAPTURE-POLICY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until those gates pass. Retain migration051 and all history/guards on rollback; no deployment, whole PR008 acceptance or earlier security-finding closure is implied.

## PR-008K submission deadline/grace migration and rollback

Migration052 adds nullable explicit deadline configuration, nullable immutable submission/import timing arrays, shape checks, legacy omitted-setting inheritance and an additive deferred Submitted-transition guard. It rewrites no old work, rule, grant or history. No deadline or value is installed by default. Select the supported UTC Weekly end-date profile and enter all offset/time/grace/treatment values explicitly; regional/DST/group precedence is not inferred. Current previews are checked-at diagnostics; new submission timing remains immutable and replay retains the original batch instant/results. Old history without timing is unchecked, not inferred timely. Run the [PR-008K](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md) fresh/051 upgrade/replay, exact boundary/grace/year, manual/both imports/SQL, scope/history and real UI gates with retained regression/production/CI. Keep migration052, guards and immutable timing on rollback; resume writes only with a compatible binary that understands enabled block rules. No destructive down migration or live deployment is included. Canonical overdue notification recipient resolution/delivery remains the later specified work package; this feature sends no notification and schedules no monitor. Optional independent/formal reviews remain outstanding; full R3/PR008/integrated/UAT/release acceptance is not claimed.

### PR-008K reviewed integration checkpoint — 2026-11-15

The owner's subsequent authorization supersedes this package's original fixed-Draft and review/scan/merge restrictions. Current integration includes accepted PR64/main `99bb7249d1f8ff4d2a223b293d2e72699afc4f79`. Bounded WOS-TIM-007 and retained CORE003–005/TIM008/011 evidence, response-validation corrections and pending gates are recorded in [the package task](../tasks/WOS-04-SUBMISSION-DEADLINE-POLICY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. Retain migration052 and immutable history/guards on rollback; notification delivery, full R3/PR008, buyer UAT and deployment remain separate.

## PR-008L source identity migration and rollback

Migration053 adds nullable work-entry identity, immutable nullable import source-check evidence, strict shapes and an append-only scoped claim ledger with registration/final-state guards. It installs no identities, source matches, grants, defaults or work/history backfill. Explicitly entered keys select the create/conflict contract: recorded linked content cannot be edited, cleared, deleted or moved through ordinary replacement. Namespace/ID is a self-asserted producer key, not verified provider provenance or actor authority. Preserve original Web/import batch/audit identity separately. Invalid/conflicting source rows must be reviewed; no automatic matching/relinking or claim deletion repairs them. Changed-source amendments require a later explicit versioned contract.

Run [PR-008L's](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md) exact key/Unicode/decimal, fresh/052 upgrade/replay, both imports/CSV/preview/concurrency/SQL, immutable history, real Employee/import/approver and owner/CAS gates plus retained suites. A missing source capture acknowledgement or recorded import check is uncertain, not success: reload authorized work/check Import History before retrying; never assume an older server captured unknown fields. Optional formal reviews remain outstanding. Keep migration053, claims/guards and immutable histories/checks on rollback. Pre053 binaries cannot preserve this metadata; attempted source-linked replacement must remain denied, and compatible code is required before such writes resume. No destructive down migration, live rollout, provider connection, scan/review retry, grant/spend or monitoring/protection change is included. R3 remains explicitly UTC-only with notification/integration delivery outstanding.

### PR-008L reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR65/main `956eb09cc88869a17793b3e862c4d45d596e8786`; bounded WOS-TIM-003/011/012 and retained CORE004/005/TIM008 evidence, lockfile reconciliation and remaining gates are recorded in [the package task](../tasks/WOS-04-WORK-SOURCE-IDENTITY.md#integration-evidence--2026-11-15-in-progress). Keep Draft until fresh local acceptance, independent exact-head review and hosted gates pass. Retain migration053, immutable claims/history/checks and guards on rollback. No provider verification, inferred links, changed-source amendment, financial authority, full milestone or deployment acceptance is implied.

### Workforce capability versions (PR-008M)

Migration054 installs an initially empty scoped immutable capability-version store; existing workers, work/source claims, assignments, approvals, catalogs, commercial terms and permissions are unchanged. Buyer-entered skill/proficiency/certification labels are exact and not externally verified; explicit inclusive dates/no-expiry are planning information. Notes do not calculate available capacity. Read-back after uncertain save before any retry; stale409 requires current version reload. Clear records an empty version and retains history. On rollback retain the table, FK/validation/immutability guards and audit, and use a compatible binary to edit capabilities. No destructive down migration, history deletion, live rollout or default/grant activation is included.

### PR-008M reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes the package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR66/main `2a8828f9b0762cef514ab670882d12e6dffd2c0f`. Bounded WOS-WKF-004/008, WOS-CORE-004/005 and WOS-NFR-DAT-005 evidence and remaining gates are recorded in [the package task](../tasks/WOS-04-WORKFORCE-CAPABILITIES.md#reviewed-integration-checkpoint--2026-11-15). Keep Draft until local acceptance, independent exact-head review and hosted gates pass. Retain migration054, capability versions and audit on rollback; a compatible binary is required for edits. No new grants, verified certification, inferred rank/capacity, full R8 or enterprise release acceptance is implied.

### Resource demand versions (PR-008N)

Migration055 installs initially empty scoped demand roots/versions and exact assignment/capability snapshots. It adds no buyer unit/status/quantity defaults, role grants or inferred legacy demand, and leaves prior tables/evidence unchanged. Planning statuses are explicit records, not approval or measured fulfilment. References are documentary/nonexclusive: do not aggregate them as allocation reservations or available capacity. Stale409 requires source refresh/current demand reload; uncertain writes require read-back using the retained client demand UUID before any retry. Scope-limited readers receive withheld worker references and cannot silently drop them through replacement. No reference command edits/ends allocations or protected work. On rollback preserve roots, versions, snapshots, validation/immutability guards and audit; use a compatible binary for edits. No destructive down migration, live rollout or default/grant activation is included.

### PR-008N reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR67/main `3d83653f54200ba7394c8cf7ea6fa00ec33c5f6b`; local acceptance, independent exact-head review and hosted gates remain required before merge. See [the package evidence](../tasks/WOS-04-RESOURCE-DEMAND.md#reviewed-integration-checkpoint--2026-11-15) for WOS-RES-007 and retained RES-001/006/009, WKF-004/008 and CORE-004/005. Preserve migration055 roots/versions/source snapshots/guards/audit on rollback. No inferred capacity, fulfilment, approval or full R8/release acceptance is implied.

## Effective worker capacity migration and evidence (PR-008O)

Migration056 adds empty immutable worker_capacity_versions and worker_capacity_evidence plus scoped validation/sequence guards. No existing calendar/worker/leave/work/assignment/approval/financial rows, buyer defaults or grants are rewritten. Read/compute with existing workforce scope; configure with employees.manage/settings.manage and retain operational evidence with reports.export. Explicitly enter baseline, part-time percentage, every weekday quantity, eligibility, nullable group/override reference, prospective date and reason. First-week patterns must fit existing dated calendar authority. The editor never repairs/creates catalogs or silently follows a retired reference. Missing organization-default storage or ambiguous authority produces a precise unavailable result.

Calculate a chosen inclusive period of at most366 business dates, then retain the source-bound server result explicitly. Later source changes require recalculation; stale409 and uncertain writes require read-back before retry. Retained results and prior profile periods remain unchanged. Unknown legacy multiday leave allocation and overlapping partial records stay unavailable; do not spread amounts across dates or add overlaps. Full holidays/full absences reduce scheduled capacity once. Worker On Leave status is not another deduction. Explicit noneligible profiles have zero eligible denominator independent of available hours. No productive numerator or financial amount is calculated. Demand candidates show these totals without ranking/reservation/quantity conversion. Older annual/utilization reports remain labeled compatibility paths pending R9.

Run worker-capacity unit/transport, PostgreSQL fresh/055 upgrade/replay and real React/API/PostgreSQL journey tests with all retained gates. Rollback hides the new reader/editor while preserving migration056, immutable profiles/results/proof, guards and audit. Use a compatible binary before resuming capacity writes; no destructive down migration, data cleanup, rollout or release acceptance is authorized. Optional formal review remains deferred/outstanding.

### PR-008O reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes this package's historical fixed-Draft and review/scan/merge restrictions. Integration includes accepted PR68/main `b4beea218d5bd46c0396f5149dd05531420523ac`; local acceptance, independent exact-head review and hosted gates remain required. See [the package evidence](../tasks/WOS-04-EFFECTIVE-WORKER-CAPACITY.md#reviewed-integration-checkpoint--2026-11-15) for bounded WKF-003/005/007/008, ORG-008, RES-003/004/005, TIM-010 and CORE-004/005. Preserve migration056 profiles, result/source evidence, guards and audit on rollback. Unavailable legacy authority, broader reconciliation and buyer/release acceptance remain open.


### Capacity integration corrections — 2026-11-15

Independent review of frozen candidate `a7a8c40e58df2d8352b67b28930be3e03e49ee69` found three correctness gaps despite its passing hosted checks. The correction preserves that reviewed tree and migration056 unchanged. Additive migration056a replaces numeric division with exact multiplication by 0.01 in the capacity-profile consistency constraint. PostgreSQL regression first reproduced rejection of a valid 20-decimal schedule; exact-positive and rounded-negative cases now pass on fresh, 055-upgrade and original056-upgrade/replay paths. No existing profile, evidence or audit row is rewritten.

Profile-save and evidence-retention uncertainty now have separate recovery states. Loading profiles or recalculating cannot unlock an uncertain evidence save; an owned latest evidence-history read is required and clears the reason so any subsequent write is deliberate. Status and calendar-tier DTOs require literal strings instead of coercing arrays. Regression coverage includes malformed enumeration values and a real committed evidence write whose acknowledgement is replaced with an invalid response, followed by unrelated reads and explicit evidence read-back. Broader corrected-head acceptance and independent review remain pending until recorded in the PR.

Rollback must retain migrations056/056a, exact validation, immutable profiles/results/source proof and audit. Do not restore the rounding constraint or drop historical records. Buyer UAT, remaining utilization reconciliation and prior full-repository security findings remain open.

## Assignment version tracking and rollback (PR-008P)

Migration057 adds an empty immutable assignment_versions ledger and a source trigger; no allocation/worker/work/demand/financial row, setting or grant is backfilled. Future actual Web/manual/CSV/soft-end writes capture the stored exact percentage snapshot/revision with server writer/source/batch metadata. Direct SQL has explicit Database/session-user provenance. An older source's first change retains an ObservedBaseline at observation time; original writer/decision/treatment history stays unknown. This is not an approved effective-date conversion. Both import aliases retain old validation/coercion/partial outcomes; dry run and exact replay append no versions.

Use Allocation Control's Versions / exact edit to load current source/history. Guarded updates require exact percentage fields, full source+ledger CAS and reason. Read back after409/uncertainty; no automatic retry or overwrite. Current/older worker/project scope applies independently; withheld history is not missing history. Chosen-period R6 hours remain separate from percentages, with unavailable authority preserved. New submitted work pins the current assignment version; later source edits/end do not rewrite it. Observed binding/model and old allocation-change approval records do not establish effective rates or configurable assignment approval. No buyer values, conversion, exception or protected reopen is installed.

Run assignment-versions unit/production-transport, fresh/056 upgrade/replay/API/SQL/import parity and real React/Employee journeys plus retained gates. Rollback preserves migration057, immutable ledger, pins, guards and audit. A pre057 binary cannot attribute Web/import writes; the trigger records Database provenance when context is absent. Use a compatible binary before resuming attributed writes, never remove history/triggers to conceal the gap. No destructive down migration, deployment or release acceptance. Optional formal reviews remain outstanding.


### PR-008P reviewed integration checkpoint — 2026-11-15

Current owner authorization supersedes historical fixed-Draft and review/scan/merge restrictions. Integration retains accepted capacity/main `f68d605d364941893836060f541ae021c70d654f`, including exact056a validation and owned evidence recovery. See [the assignment package evidence](../tasks/WOS-04-ASSIGNMENT-VERSION-AUTHORITY.md#reviewed-integration-checkpoint--2026-11-15) for bounded WOS-RES-001/002/003/009 and CORE-004/005. Local acceptance, independent exact-head review and hosted gates remain required. Preserve057 versions/pins/guards/audit on rollback; no inferred conversion, approval or full R7/release acceptance.


PR-008P correction for WOS-RES-003/009 and CORE-004/005: allocation approval/audit writers exclude private commercial query enrichment, and work capture reads the ledger after obtaining source locks so concurrent SQL updates cannot mismatch quantity and version. Real scoped API disclosure negatives and blocked-writer work-submission regression pass. See the assignment task's correction checkpoint for retained evidence and pending acceptance. Preserve migration057 and historical ledger/work/audit records on rollback; no new migration, conversion or broader release acceptance.

## Own-worker period view (PR-008Q)

In canonical ESS overview/work and compatibility Employee Workspace's work section, explicitly choose start/end dates of at most366 days. This section uses the authenticated account's server-linked worker record independently of legacy ESS profile lookup. Missing/out-of-scope binding requires the normal account-linking/scope process; it must not substitute another visible employee. No binding migration, catalog repair, access grant or buyer default is installed. Dates/owner/scope changes clear the view; reload explicitly after unavailable/conflict responses. Legacy overview calculations are labeled compatibility output.

Available/eligible hours use existing R6 authority; approved absence/holidays are counted once. Unknown capacity stays unavailable while assignments/current-work facts remain independently visible. Each assignment/work list is at most20 rows with explicit next/older/first-page actions. Exact source percentages are not added or converted into hours. Read-only assignment versions and retained work history are checked against the canonical worker. Current Draft/Submitted/Approved/Rejected state is distinct from retained submission/decision history. Open ordinary work capture and explicitly select the work period there for changes; this view adds no approval/reopen/edit action.

Run own-work-planning production transport, real PostgreSQL/API and Employee Workspace React/API/PostgreSQL tests plus retained gates. Local test sessions/disposable databases are synthetic harnesses, not production OIDC/UAT. No migration is needed; rollback hides this view/route while preserving all source/history tables and existing writers/routes. No data cleanup, deployment or release acceptance. Optional independent/formal reviews remain outstanding.


### PR-008Q reviewed integration checkpoint — 2026-11-16

Current owner authorization supersedes historical fixed-Draft/review/merge deferrals. Own-work planning integrates accepted main019aa52cb0e7e1ff35c0a8984672edd1c9bb6d58 and retains the corrected assignment/capacity controls. See the own-work planning task for WOS-WKF-007 and CORE-003/004/005 scope, literal-state regression and acceptance receipts. Final independent/hosted acceptance remains required. No new migration, grants, source writes, unit conversion or financial/approval authority. Rollback preserves all prior ledgers and hides the new view; broader reconciliation, security and buyer/release acceptance remain open.

## Current role validation operations — 2026-11-16

See [current selected-role authority](../tasks/WOS-04-CURRENT-ROLE-AUTHORITY.md). Every authenticated request checks an active account and current selected-role assignment/mapping. A removed role returns 403 SESSION_ROLE_REVOKED; authority storage failure returns 503 IDENTITY_AUTHORITY_UNAVAILABLE without fallback. Older mapped-only provider sessions require fresh authentication. Multiple verified groups mapping to one role remain valid until no granting mapping remains; directory membership itself remains the authenticated provider snapshot. No migration or new grant is required. Reverting the guard reopens stale-role access, so use a tested forward correction or keep affected access unavailable. This does not implement per-session logout revocation or close release acceptance.

## Protected identity administration operations

See [protected identity administration](../tasks/WOS-04-PROTECTED-IDENTITY-ADMINISTRATION.md). Workforce operators retain ordinary profile maintenance and unbound Employee resets. Current Admin plus permissions.manage is required for protected role/credential operations; identity bindings/mappings also require integrations.identity. Existing-account initial passwords are rejected. Login-name collisions return 409 LOGIN_BINDING_CONFLICT with transactional rollback: resolve the conflicting account mapping through authorized administration; do not retry using credential replacement. Explicit Disabled/Pending Entra links cannot bootstrap through legacy subjects. No migration; rollback reopens the security boundaries, so prefer a tested forward correction or unavailable affected administration.

Legacy identity unlink correction: clearing an explicitly supplied binding revokes employee/user fallback subjects and persists a Disabled link, with safe audit state. Omitting the field preserves identity. A callback revalidates current legacy state after its worker lock. Preserve Disabled records on rollback/recovery; do not delete them as cleanup, because their absence can restore legacy bootstrap semantics. The initial protected-identity candidate was blocked by review despite passing CI; require the separately corrected exact head.


## Verified PostgreSQL transport

Set PGSSLMODE=require or verify-full for verified TLS. Both validate trust and hostname; neither accepts arbitrary certificates. Remove all ssl-prefixed or uselibpqcompat query parameters from DATABASE_URL and configure PGSSLMODE/PGSSLROOTCERT separately. Duplicate host parameters and ambiguous encoded/socket TLS hosts are rejected. Use the certificate's DNS name or IP SAN as the database hostname.

For a private CA, set PGSSLROOTCERT to the **container** path of the public CA bundle. Compose forwards it to app and migrate; add a buyer-owned Compose override mounting the bundle read-only at the same path in **both** services. For example, each service can mount `./certificates/database-ca.pem:/run/certs/database-ca.pem:ro` and use PGSSLROOTCERT=/run/certs/database-ca.pem. Keep private keys outside the app; never commit buyer certificates or credentials. Runtime/system trust is used if PGSSLROOTCERT is omitted. Empty or unreadable bundles fail closed.

Rotate trust by mounting a bundle containing the current and replacement issuer, restart migration/application processes to reload it, rotate the server certificate, verify connectivity and only then remove the retired issuer. Test in the buyer's staging deployment. The bundled local PostgreSQL/Compose profile defaults to disable; it is a local compatibility profile, not evidence that a plaintext buyer deployment satisfies production encryption. A configured TLS endpoint is required for verified operation. Rollback to previous code reopens certificate impersonation; prefer correcting the CA/name configuration or keeping service unavailable.


## Setup read security operations

Setup configuration inspection now requires settings.manage; do not broadly grant it to restore ordinary runtime terminology (which remains independently readable). Worker lifecycle history uses employees.view plus current worker scope and returns minimal status/date evidence; private legacy snapshots remain retained in storage. Exit-impact identifiers require employees.manage and worker scope. Unexpected database failures return ORGANIZATION_SETUP_FAILED without internal details; investigate infrastructure through protected operations logs. Invalid explicit asOf values return400. No migration is required. Rollback restores disclosure and unhandled-failure risks; prefer forward correction.


## Authentication limits and trusted proxies

`LOGIN_RATE_LIMIT` defaults to 8 attempts per normalized local-login input and trusted client IP per fixed 15-minute window; callbacks use one fixed bucket per IP, ignoring GET bodies. `LOGIN_IP_RATE_LIMIT` defaults to 64 attempts across both flows per IP/window. Both settings accept integers from 1 through 1,000,000; invalid settings fail startup. Compose forwards both. The process holds at most 10,000 live hashed entries and returns 429 with a positive Retry-After when a bucket or capacity is exhausted. Active buckets are never evicted to admit another caller. Different login aliases remain separate inputs but share the IP budget. A full map can temporarily deny new clients; do not restart repeatedly to evade limits. Tune limits for buyer NAT usage only after testing expected concurrent sign-in and abuse resistance.

`TRUSTED_PROXY_CIDRS` defaults empty (no proxy trust). Set a comma-separated list of the actual immediate reverse-proxy IPs or CIDRs only when deploying behind a proxy. At most 64 entries and 4096 characters are accepted. Host aliases, boolean/hop-count shortcuts, universal /0 ranges, scoped IPv6 and malformed prefixes fail startup. The proxy must strip/replace untrusted forwarding headers; firewall application access so only approved proxies connect. Express walks the chain from the socket to the first untrusted hop. Throttling and audit records use this same resolved IP, not a raw forwarded-header value. An omitted proxy configuration groups proxied users by the proxy's socket address; verify the buyer topology before enabling external traffic. Compose forwards this setting to the application.

From migration 057c onward, login counters are shared across replicas. See Shared login throttling below for rollout and rollback.


### Authentication environment reference

| Setting | Purpose | Sensitivity | Required / default | Allowed values |
|---|---|---|---|---|
| `LOGIN_RATE_LIMIT` | Per-input local-login and per-IP callback attempt budget | Public configuration | Optional; 8 | Integer 1 through 1,000,000 |
| `LOGIN_IP_RATE_LIMIT` | Shared client-IP budget across authentication flows | Public configuration | Optional; 64 | Integer 1 through 1,000,000 |
| `TRUSTED_PROXY_CIDRS` | Explicit ingress peers trusted to supply forwarding addresses | Public configuration; topology-sensitive operational access | Optional; empty means direct peer only | Up to 64 comma-separated IP/CIDR entries, 4096 characters; no /0, aliases or hop counts |

Changing these settings requires application restart. Test proxy-chain resolution and NAT sign-in behavior before buyer rollout. Roll out matching limits to every replica.


## Durable session rollout and recovery

Apply ordered migration `057a_wos04_session_revocations.sql` before serving the new API. It appends after accepted057 and retains the later Draft migration058 number. All pre-upgrade sessions must sign in again; announce this intentional reauthentication boundary. New sign-ins keep a single unpredictable family through refresh and role switching. `API_SESSION_TTL_HOURS` remains the configured lifetime, but refresh no longer extends that lifetime indefinitely. This package does not add an audited configuration-change interface.

Successful logout records durable revocation and audit atomically. Presented bearer and cookie credentials can differ across tabs, so both are revoked; independent sessions not presented remain active. Missing storage returns SESSION_AUTHORITY_UNAVAILABLE for protected reads; failed logout persistence/audit returns SESSION_REVOCATION_UNCONFIRMED. The browser immediately clears local credentials/scope, suppresses late responses and warns when server sign-out cannot be confirmed. A delivery failure may leave the server session active until expiry. Monitor these failures; preserve the revocation and audit ledgers in backups.

Do not delete or rewrite the ledger during rollback. An older binary can ignore revocation and may reject the newer migration ledger at startup. Prefer forward correction or keep the service unavailable. Any controlled older-code recovery requires compatible migration handling and signing-secret rotation to expire all credentials, while preserving revocation/audit evidence and required production OIDC. No such production recovery or deployment is authorized by this package.


## Independent leave decision rollout

Apply ordered migration057b before rollout; its partial audit index changes no historical rows or grants. Decisions require current worker/account identity and one attributable scoped Submit Leave actor. Historical missing/conflicting provenance fails closed with LEAVE_SUBMITTER_UNCONFIRMED; use authorized cancellation and a new submission, preserving original evidence. Approved/Rejected decisions cannot be made by the affected worker or submitting account. Valid in-date same-entity delegation requires current role, permission and role-specific delegator worker authority; a submitting delegator cannot pass that authority onward. Teams approve/reject actions for leave return LEAVE_SOURCE_DECISION_REQUIRED and retain unused tokens; use the scoped leave workspace.

Cancellation is separate from independence and retains authorized owner/manager workflows. Preserve audit records and the additive index on rollback; older code restores the self-decision and Teams defects, so prefer forward correction. No destructive conversion, historical recalculation, production deployment or buyer acceptance is included.

PR168 also refreshes canonical workforce bindings on each authenticated request. An account with no `users.employee_record_id` no longer receives workforce access from a legacy employee code or signed historical claim; repair its binding through authorized identity administration. Unlinked Admin/HR organization authority remains available. Director scope requires the existing qualifying designation or department; a primary-director reference alone is insufficient, including delegated leave decisions. Requests already admitted before a concurrent identity change may finish; transactional leave decisions additionally recheck and lock current authority. Preserve canonical identity links and audit evidence; reverting the guard restores stale-session access.

## Operational CSV format compatibility

Shared and Timesheet Approval exports quote every field and apply the existing apostrophe literal-text marker to dangerous control/whitespace/formula prefixes. Headers receive the same encoding. Source records, field order, filters, empty header-only Ops exports and audit behavior remain unchanged. Machine consumers must account for literal markers; spreadsheet saving/reopening and external transformations can alter interpretation. No universal spreadsheet execution guarantee is claimed. No migration is required; reverting the serializer reopens unsafe-prefix paths, so prefer forward correction.
## Revoking all sessions for an account

Apply migration 082b and drain API versions predating it before relying on account-wide revocation. All current replicas verify the account generation on authenticated requests. Active sessions created before this upgrade start at generation zero. Existing logout revocations continue to apply.

The action covers the target account across every organization and legal entity. Use a named buyer incident-response database login. A database owner grants that role EXECUTE on `public.revoke_account_sessions(uuid,integer,text)`; responders who look up targets also need SELECT on the ID and username columns of public.users and access to the account’s generation. Count committed rows for its UUID in public.session_revocations where reason = 'AccountRevocation'. An account without events is at zero. Keep those grants restricted to deployment-wide incident responders.

1. Confirm the target account’s immutable UUID and current generation using the buyer’s identity directory and database. Record an incident or change reference.
2. Bind that UUID, the observed generation and the reference as parameters to `select public.revoke_account_sessions($1,$2,$3)`. Commit the transaction. A stale generation fails. Inspect the deployment audit event before retrying so a retry cannot revoke a later sign-in unintentionally.
3. Verify the deployment audit event `RevokeAccountSessions` identifies the expected account, actor, previous and new generations and reference. Existing bearer and cookie sessions are refused on their next authenticated request, including after account reactivation. Requests already admitted may finish. Fresh sign-in remains possible for an active account; disable the account and address identity-provider access separately if the incident requires blocking new sign-ins.

Retain the migration, generation and audit history during recovery. Reverting to a server that ignores account generations can make revoked credentials usable again. Restore access by fresh authentication on a generation-aware release.

## Configuring session lifetime

Set `API_SESSION_TTL_HOURS` in the production Compose environment before recreating the API replicas. For example, `0.25` configures a 15-minute lifetime. Omission uses eight hours. Startup checks that the duration resolves to at least one millisecond and a representable expiry. A configuration error names the setting. Correct the value and recreate the API services. Existing signed sessions retain their original expiry.

Apply migrations with `npm run api:migrate` before starting the new API. Using a named PostgreSQL login, record the actual deployed duration in milliseconds. For an existing eight-hour deployment the baseline is:

```sql
insert into deployment_session_policy (lifetime_ms) values (28800000);
```

For a scheduled change, drain sign-in traffic and use a conditional update. For example, changing eight hours to fifteen minutes requires the following statement to return exactly one row:

```sql
update deployment_session_policy set lifetime_ms = 900000
where singleton and lifetime_ms = 28800000 returning lifetime_ms;
```

Set `API_SESSION_TTL_HOURS=0.25`, recreate all replicas and verify readiness before restoring sign-in traffic. A stale replica refuses new production logins. To roll back the duration, reverse the conditional update and the environment change together. Preserve migration 082a and its audit history. Initial registration has a null previous value because pre-upgrade changes cannot be reconstructed.

Keep policy write grants with named deployment operators. A delegated operator needs SELECT and column INSERT/UPDATE on `lifetime_ms`. The database records the authenticated login, active role, timestamp and previous/new milliseconds in the deployment audit log; the operator does not need direct audit-table write access. Protect database owner credentials under the buyer’s deployment controls.

### Shared login throttling candidate

Migration `057c_wos04_shared_auth_throttle` stores expiring login counters in the buyer database. API replicas share the per-IP and per-input limits, including the Entra callback limit. Apply migrations before switching traffic, drain old API processes, and configure identical limits and trusted proxy settings on all replicas. Counters start empty on first upgrade. Storage failure returns HTTP 503 before authentication. Reverting to the previous application restores process-local counters and its readiness check rejects the newer migration ledger. Prefer forward correction and retain the migration.


## Notification diagnostic visibility

Delivery history uses current recipient organization/entity and worker visibility; events without a recipient cannot establish scoped ownership and remain hidden. Metadata is an allowlist of typed mode, deterministic flag, valid HTTP status code and fixed failure code. Provider response bodies, arbitrary nested errors and recipient addresses are not public diagnostic fields. Historical notification integration/audit copies are projected safely without rewriting evidence. Use NOTIFICATION_DELIVERY_FAILED plus channel/provider/time/status for triage. No migration is required. Preserve history and prefer forward correction; older readers can disclose retained raw metadata.

## Legacy approval delegation boundary

Legacy delegation IDs cannot transfer ownership, including under administrative edits. Both retained and submitted participants must belong to the selected entity. Active delegation requires current participant account/assigned-role/membership/approval authority; reads revalidate the delegator's current relationship. On Leave remains supported; scoped revocation is permitted after authority or lifecycle loss. Historical orphan/cross-entity rows remain stored and unavailable. Malformed calendar dates return400, unauthorized ownership403, invalid activation/overlap422; failed audit leaves no mutation. No migration is required. Prefer a forward fix because older code restores the disclosure/takeover path.

## Settings save acknowledgement

A save success refers only to the submitted settings snapshot acknowledged by the service. Newer edits remain unsaved. After a refused or uncertain save, retain input and review/retry; do not assume that a network error proves the server did not commit. Failed initialization offers retry. The alternate utilization action saves configuration and does not claim a server recalculation. Preserve server permissions/audit and prefer forward correction of misleading outcomes; no migration is required.

## Adopted native percentage overlap policy (PR-008R)

In Allocation Control, use existing settings/manage authority to load current overlap policy, then explicitly enter enabled/off, prospective date, nullable exact warning/block percentages and reason. No values are installed on upgrade and fields are not silently inherited. Only simultaneous Active declared percentages count. Warning≤block when both are selected; equality passes. An incompatible blocking adoption is rejected without source/history edits; remediate through ordinary authorized source commands or enter a compatible explicit threshold. Do not grandfather records, disable existing controls or infer an exception. Explicit off is a later immutable version; the independent legacy guard still applies.

Normal create/edit, guarded exact edit, both CSV apply aliases and SQL enforce the policy in the same lifecycle-lock transaction. Manual accepted warnings, import row diagnostics and retained assignment-version assessments identify exact source quantities and governing policy. Versioned preview stages accepted rows sequentially; blocked rows do not contribute later. Legacy import is apply-only. v1 UI applies validated rows and carries rejected errors; retain the preview batch for full blocked-row assessments and the apply batch for actual accepted writes/replay. Uncertain outcomes require read-back, never blind retry. No percentages are converted into hours or financial/approval authority. Earlier versions with no assessment remain not recorded; unconfigured/off decisions and prior work stay immutable.

Run assignment-overlap unit/production transport, real PostgreSQL fresh/057 upgrade/replay/contention/import and real Allocation Control/import/history journeys plus retained gates. Synthetic test sessions/databases are not production OIDC/owner UAT. Rollback hides the new surface while retaining migration058/policies/evidence/guards and requires a compatible binary before resuming policy-aware writes. No destructive down migration, trigger removal, deployment or release acceptance. Optional independent/formal reviews remain outstanding.

Migration 058a serializes source and policy writes per organization and legal entity. A repeatable-read writer with an outdated snapshot receives PostgreSQL serialization failure 40001. Retry the complete transaction against fresh data. Preserve migrations 058 and 058a and their evidence on rollback.

Apply migration 059 before enabling the work category editor. Existing entries retain their original classification. Adopt a catalog explicitly for each participating legal entity. Preserve the catalog versions and retained entry references on rollback. Resume category-aware writes with a compatible application.

Apply migration 060 before exposing actual work evidence exports. Preserve the immutable evidence rows, request identities and artifact checksums on rollback. Use a compatible reader to retrieve existing evidence. A missing capacity or classification source leaves the percentage unavailable.

Apply migration 061 before serving calendar-backed full-day leave. Retain the immutable request evidence and its date allocations on rollback. Use a compatible application for subsequent edits and decisions. If the schedule changes before approval, review the dates and submit an updated request.

## Native percentage forecasts

Run migration 062 before enabling the updated Forecast page. The migration creates an empty forecast evidence table. To recover from an application regression, keep the migration and retained exports and roll forward with a corrected application. Older applications can reject the newer migration ledger.

## Staged timesheet approvals

Apply migration 063 before deploying the application. Existing submissions keep their original decision path. To retire a staged policy prospectively, publish an empty worker selection. Finish pending instances against their retained policy and preserve the migration, event records and read acknowledgements during recovery.

## Weekly submission notices

Apply migration 064 before adopting a notice policy. Configure the weekly deadline, worker selection, reminder timing, escalation owner and templates. Evaluate the worker and period explicitly. Check the recorded evaluation before retrying an uncertain result. For recovery, retain the notice ledger and use a forward correction.

## Material assignment approvals

Apply migration 065 before configuring material fields and approvers. Leave the policy unconfigured until the buyer selects the fields, workers and eligible reviewers. Keep pending proposals and the decision ledger on recovery. Publish a prospective policy change to retire routing and reconcile pending proposals against their original source versions.

## Commercial draft reconciliation

After a commercial save returns an uncertain outcome, discarding the local draft leaves creation locked. Reload the workspace. If that read fails, retry the workspace read, inspect the records for the original submission, then decide whether a new draft is necessary.

## Scoped workforce directory

Open Workforce directory with the employee viewing permission. Search and paging return workers in the current role and legal entity. Reload the directory after a roster change before paging or opening another relationship. This read-only feature has no migration or commercial permission grant.

## Commercial rate candidates

Apply migration 065a after 065. It creates an empty, append-only candidate table and defines four opt-in permissions. Grant billing and confidential cost access separately. After an uncertain write, read its original receipt before attempting another save. Retain the ledger on recovery. Authoritative rate adoption and invoice workflows still require separate release gates.
