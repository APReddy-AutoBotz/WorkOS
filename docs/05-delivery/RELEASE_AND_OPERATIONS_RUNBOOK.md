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
