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

A commercial snapshot is valuation evidence only. It is not itself an approved-unbilled item, an invoice-ready line or billing authority.

## Billing-eligibility and approved-unbilled model

The only path into invoice readiness is:

```text
versioned source evidence
→ versioned billing_eligibility_event
→ one approved_unbilled_item
→ invoice_ready_line
→ invoice_ready_batch
```

A `billing_eligibility_event` represents exactly one versioned source and one approved or contractually due eligibility decision. Supported source types are:

- Approved eligible T&M calculation snapshot.
- Accepted milestone version.
- Approved or contractually due fixed-fee schedule version.
- Approved retainer base-period, rollover, expiry or overage event version.
- Approved managed-service accepted-unit or fixed-period-charge event version.
- Approved commercial adjustment version.

Every event and register item retains:

- Source type, source identifier and immutable source version.
- Organization and legal entity.
- Client, contract and engagement scope where applicable.
- Approval identifier or contractual-due/acceptance evidence.
- Eligible date, currency and decimal amount.
- Calculation, rate, policy and rounding evidence where applicable.
- Event version and status.
- Reversal-of or supersedes relationship where applicable.
- Active/final batch inclusion state and audit identity.

`approved_unbilled_items` has a one-to-one relationship with the applicable billing-eligibility-event version. `invoice_ready_lines` reference `approved_unbilled_item_id`; they do not reference a raw work entry, milestone, schedule, retainer event, managed-service event, adjustment or calculation snapshot as the batchable source.

Database constraints, transactional locking and idempotency prevent one eligibility-event version or approved-unbilled item from belonging to more than one active or finalized batch. An authorized correction creates a versioned reversal or superseding eligibility event and a corresponding register item; it never rewrites or reuses the prior event/register lineage.

Batch and export control totals reconcile source evidence to billing-eligibility events, approved-unbilled items, invoice-ready lines and finalized batches.

## Audit and provenance

Audit records are append-only for normal application identities and capture actor, active role, source, entity, action, timestamp, reason and material before/after values. Imports retain source identifiers, batch, row outcome and duplicate/idempotency keys.

Billing-eligibility creation, register insertion/removal state, reversal/supersession, batch inclusion, finalization and export are production-relevant mutations and retain complete source-to-event-to-register-to-line audit evidence.

## Retention and deletion

Retention is buyer-configurable within legal/policy constraints. Deactivation, anonymization or purge must protect accounting/audit relationships and produce evidence. Production domain records are not hard-deleted merely to simplify UI behavior.

## Migration expectations

Every migration has an ordered identifier, checksum/ledger posture, fresh-install test, supported upgrade test, data-conversion plan and rollback or roll-forward guidance. Application startup is not the only production migration mechanism.

## Backup and recovery

Backups cover database and optional object storage/configuration needed for restoration. Recovery evidence proves schema version, record counts, critical control totals and application readiness after restore.