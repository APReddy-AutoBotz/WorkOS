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

`/api/health/live` reports whether the API process is serving. `/api/health/ready` returns 503 when PostgreSQL is unavailable, migrations are pending, or the ledger contains a migration ID this application does not support. `/api/health/build` reports the safe application version, validated commit SHA and current migration level. The legacy `/api/health` route keeps its existing response contract.

The migration ledger adds a nullable checksum column. Rows from installations created by the earlier runner have no recorded checksum and remain explicitly unverifiable; the upgrade does not fabricate a historical digest. New migrations store SHA-256 digests, and a changed file with a recorded digest stops the transaction. This PR makes only an additive metadata change. If an upgrade fails, keep the application in maintenance, retain the backup, inspect the named migration ID, and use the approved recovery plan instead of editing the ledger by hand.

`docker compose down` stops the services and keeps the named database volume. `docker compose down --volumes` deletes that volume and its database; reserve it for disposable environments only. The full production backup/restore rehearsal and alert-ownership runbook remain assigned to the later operations/recovery package.
