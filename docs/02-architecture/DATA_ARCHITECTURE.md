# WorkOS Data Architecture

## System of record

PostgreSQL is the authoritative store for operational, authorization, commercial, audit and release-relevant data in WorkOS v1.

## Ownership model

- Primary roots include `organization_id` where applicable.
- Contracting/currency/reporting records include `legal_entity_id` when required.
- Foreign keys establish scope; request-supplied ownership IDs are validated against the authenticated session.
- Uniqueness is scoped to the correct owner, not globally by convenience.

## Data classifications

| Class | Examples | Control |
|---|---|---|
| Public/neutral | Product metadata, neutral defaults | Normal repository/runtime handling |
| Internal operational | Projects, assignments, work categories | Permission and scoped access |
| Personal | Worker identity, employment/capacity | Data minimization and role scope |
| Commercial confidential | Contracts, rates, budgets, POs | Separate permissions and audit |
| Highly confidential | Cost rates, compensation-derived data, margin | Restricted DTOs, logs and exports |
| Security secret | Credentials, signing keys | External secret store; never persisted in normal config responses |

## Temporal model

Effective-dated records use start/end dates and optional version/concurrency fields. Historical references point to the applicable version or snapshot. A new future rate or capacity record must not change prior approved results.

## Financial precision

- PostgreSQL `numeric/decimal` types are authoritative for amounts, rates and percentages.
- Currency precision and rounding mode are explicit configuration.
- Binary floating point is not used for stored authoritative currency.
- Exchange-rate inputs record source, effective date, from/to currencies and precision.

## Snapshot model

Commercial snapshots store source record, quantity/unit, resolved billing and cost terms, currency/FX, rounding, outputs, calculation version and timestamp. Recalculation creates a superseding version with audit evidence.

## Audit and provenance

Audit records are append-only for normal application identities and capture actor, active role, source, entity, action, timestamp, reason and material before/after values. Imports retain source identifiers, batch, row outcome and duplicate/idempotency keys.

## Retention and deletion

Retention is buyer-configurable within legal/policy constraints. Deactivation, anonymization or purge must protect accounting/audit relationships and produce evidence. Production domain records are not hard-deleted merely to simplify UI behavior.

## Migration expectations

Every migration has an ordered identifier, checksum/ledger posture, fresh-install test, supported upgrade test, data-conversion plan and rollback or roll-forward guidance. Application startup is not the only production migration mechanism.

## Backup and recovery

Backups cover database and optional object storage/configuration needed for restoration. Recovery evidence proves schema version, record counts, critical control totals and application readiness after restore.