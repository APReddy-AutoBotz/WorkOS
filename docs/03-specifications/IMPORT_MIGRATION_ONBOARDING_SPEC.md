# Import, Migration and Onboarding Specification

**Governing requirements:** WOS-CORE-001, WOS-CORE-002, WOS-CORE-005, WOS-CORE-007; WOS-ORG-010; WOS-INT-003 through WOS-INT-005; WOS-GOV-003 through WOS-GOV-005; WOS-OPS-001 through WOS-OPS-010.

## Outcome

A buyer installs WorkOS reproducibly, completes guided setup, imports validated data, proves migrations and assumes controlled ownership of credentials, operations and acceptance.

## Source bootstrap

WOS-01 imports only approved files from the pinned commit, excludes history/branded/confidential artifacts, creates a manifest and runs forbidden-term/secret scans plus inherited build/regression checks.

## Buyer onboarding sequence

1. Deploy isolated non-production environment and database.
2. Run controlled migrations and readiness checks.
3. Configure organization, legal entities, locale/currency, terminology and brand.
4. Configure calendars/periods, roles/permissions, identity and named users.
5. Import workforce, clients, contracts, engagements/projects and assignments.
6. Reconcile counts, relationships, utilization and data-quality issues.
7. Configure commercial defaults, providers and release gates.
8. Complete role UAT, operations, backup/restore, security and acceptance.

## Import model

Every import has batch ID, file/source, schema version, idempotency key, dry-run result, row status/error, actor and audit. Validation covers required headers, formats, scoped identifiers, references, duplicates, dates/effective overlaps and policy constraints. Apply is transactional by defined unit and reports partial outcomes explicitly.

## Migration policy

Migrations are ordered, versioned and ledgered. CI proves fresh install and supported upgrade. Data conversions define preconditions, backup, counts/control totals, postchecks and roll-forward/rollback. Startup is not the only production migration mechanism.

## Production readiness

Readiness covers required configuration, safe secrets, database/schema, identity, named admin, demo-disabled state, provider status, backup ownership, monitoring/alerts, support contacts and release version.

## Acceptance cases

Positive: clean install, upgrade from supported prior release, dry-run/apply with valid/invalid rows, idempotent repeat, restore rehearsal and role UAT.

Negative: wrong source SHA, prohibited artifact, unsafe secret, cross-organization identifier, duplicate/conflicting row, impossible date, missing dependency, stale schema or production demo fallback blocks acceptance.

## Rollback and evidence

Each onboarding/import/migration operation retains logs and reconciliation. Failed apply rolls back its defined transaction boundary. Production recovery follows the release runbook and preserves audit/provenance.