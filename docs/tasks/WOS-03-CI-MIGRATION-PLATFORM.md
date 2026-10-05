# WOS-03A — CI, Migration Harness and Production Profiles

## Authority

- **Workstream:** WOS-03
- **Issue:** #5
- **Planned pull request:** PR-005
- **Target branch:** `codex/wos-03-ci-migration-platform`
- **Controller continuation lane:** `product-implementation`
- **Base:** current accepted `main`
- **Lifecycle:** Draft product implementation until exact-head acceptance and independent confirmation are clean.

This task is the first bounded WOS-03 package from `docs/05-delivery/IMPLEMENTATION_BACKLOG.md`. The WOS-01 baseline and WOS-02 schema work are complete. This task does not include PR-006's modular/API extraction or later workstreams.

## Outcome

Give maintainers a repeatable, fail-closed way to install dependencies, validate the application, test fresh and upgraded PostgreSQL schemas, build a production container, and inspect safe runtime health/build metadata.

## Required scope

1. Pull request and main-branch CI for locked dependency install, TypeScript checking, lint/syntax, frontend build and retained automated tests.
2. Disposable PostgreSQL-backed tests for a fresh install, upgrade from the supported WOS-02 migration level, migration replay and concurrent invocations.
3. An ordered migration ledger with advisory-lock serialization and SHA-256 checksums for newly applied schema and migration files. Existing ledger rows without historical checksums remain explicitly unverifiable; do not invent old checksums. Unknown migration IDs fail closed so an older application cannot claim readiness against a newer schema.
4. A documented command and Compose migration service that can run independently of application startup.
5. Runtime environment validation that fails closed on invalid production mode, database URL, session secret, identity-provider configuration, insecure callback URLs, demo seed/reset or test-fallback switches, and local login.
6. A non-root, pinned-major Node.js production image built from the lockfile, plus a production-like PostgreSQL Compose profile with loopback-only default database/application ports.
7. Separate liveness and readiness routes. Readiness reports database/migration status; build metadata includes only version, validated commit SHA and migration level. The existing `/api/health` response remains compatible.
8. Secret scanning over repository history, locked dependency vulnerability audit and container/Compose validation in CI.
9. Operational documentation for local setup, migration execution, health checks, backups before upgrades and the additive ledger change's rollback behavior.

## Requirements

- WOS-OPS-001 through WOS-OPS-009
- WOS-NFR-DPL-001 through WOS-NFR-DPL-007
- Applicable WOS-NFR-SEC, REL, MNT, OBS and RELSE requirements

## Exclusions

- PR-006 modular extraction, `/api/v1` or shared mutation/audit-contract work.
- New product-domain schema or commercial behavior.
- Hosted infrastructure changes, deployment, release/tag creation, real provider calls, production credentials or customer data.
- WOS-04 and later product work.

## Safety and compatibility

1. Use only a disposable PostgreSQL service for migration tests. The test harness accepts only a loopback or local Compose hostname and creates uniquely named temporary databases.
2. Keep all production secrets outside the image, repository, logs and test artifacts. The tracked production environment example contains placeholders only.
3. Use additive migration-ledger metadata; do not rewrite domain rows or claim historical checksums that were never recorded.
4. Preserve production OIDC and session fail-closed behavior. No local/demo identity or browser fallback is enabled in the production profile.
5. Keep CI permissions read-only. The secret scanner must not post pull-request comments or upload secret-bearing scan artifacts.
6. Keep this product PR Draft. Do not mark Ready, merge, deploy or start PR-006 without its separate lifecycle gate.

## Required checks

Classify every check as PASS / FAIL / SKIP / NOT RUN and retain exact commands/evidence:

- `npm ci`, typecheck, lint, build and retained `npm test`.
- Fresh-install, supported-upgrade, replay, checksum and concurrent-lock migration tests on disposable PostgreSQL.
- Production environment validation and startup-negative tests.
- Liveness/readiness/build endpoint tests, including database outage and pending migrations.
- Production container build and Compose configuration validation.
- Secret scan and locked dependency audit.
- `git diff --check`, generated-artifact hygiene and exact changed-file inventory.

## Completion boundary

Construction is complete only after the candidate is published on this branch, every required check is honestly classified against the exact head, and independent review finds no unresolved P0/P1/P2. Keep the PR Draft until the controller's separate exact-head acceptance and independent-confirmation gate completes.
