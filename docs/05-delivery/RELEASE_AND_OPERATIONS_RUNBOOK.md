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
