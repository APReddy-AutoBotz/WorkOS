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
- Batch membership version/state and audit identity.

`approved_unbilled_items` has a one-to-one relationship with the applicable billing-eligibility-event version. `invoice_ready_lines` reference `approved_unbilled_item_id` and its immutable version; they do not reference a raw work entry, milestone, schedule, retainer event, managed-service event, adjustment or calculation snapshot as the batchable source.

WorkOS v1 does not split one approved-unbilled-item version across multiple invoice-ready lines. A separately billable portion must originate upstream as a distinct authorized/versioned billing-eligibility event and approved-unbilled item, and all portions must reconcile to the source and control totals.

## Current line-occupancy invariant

PostgreSQL enforces at most one current occupying invoice-ready line/membership for each `(approved_unbilled_item_id, approved_unbilled_item_version)`.

The `invoice_ready_current_occupancy` control contains:

- `approved_unbilled_item_id` and immutable item version as the database-unique key.
- Current invoice-ready line ID/version and batch ID/version.
- Acquisition operation/idempotency identity, actor and timestamp.
- Current occupying class and audit/correlation identity.

The occupancy row is acquired in the same transaction that inserts the invoice-ready line and batch membership. Database uniqueness, not a parent-batch query alone, rejects a second insertion into the same batch, another occupying batch or a concurrent transaction. Historical invoice-ready lines and memberships are append-only evidence and are not the uniqueness mechanism.

An identical retry using the same idempotency key and canonical payload returns the already-created line/membership and occupancy result. Reuse of the key with changed input is rejected. A different key or concurrent request for the same item version while occupancy exists returns a stable conflict and cannot create another line.

A valid pre-export cancellation deletes/releases the current occupancy row only within the same transaction that records the authorized cancellation, reason, actor and immutable membership history. The item can be re-batched through a new line/membership version only when its eligibility event remains current, unreversed, unsuperseded, in scope and otherwise eligible. `Exported` and `Billed/Confirmed` occupancy rows are permanent and cannot be released. Corrections use new reversal/superseding events, approved-unbilled items and correction lines/batches.

## Invoice-ready batch occupancy semantics

The canonical batch states are:

- `Draft`
- `Under Review`
- `Approved`
- `Exported`
- `Billed/Confirmed`
- `Cancelled`

For no-double-billing control, the exact state sets are:

- **Open/active occupying states:** `Draft`, `Under Review`, `Approved`.
- **Final occupying states:** `Exported`, `Billed/Confirmed`.
- **Non-occupying terminal state:** `Cancelled`, but only when cancellation occurred before any successful export or downstream billed confirmation.

A versioned approved-unbilled item is unavailable for any additional invoice-ready line while its database current-occupancy row exists. This covers duplicate membership twice in one batch as well as membership in another occupying batch.

The minimum valid transition set is:

```text
Draft → Under Review | Cancelled
Under Review → Draft | Approved | Cancelled
Approved → Exported | Cancelled
Exported → Billed/Confirmed
```

`Cancelled` and `Billed/Confirmed` are terminal batch states. `Exported` cannot transition to `Cancelled`; an exported or billed/confirmed item remains historically and currently occupied, and any correction must use an authorized versioned reversal or superseding billing-eligibility event, approved-unbilled item and correction batch. A failed external export does not set `Exported`; the batch remains `Approved` and retries use the same idempotency identity.

Cancellation from `Draft`, `Under Review` or pre-export `Approved` releases current occupancy only after an atomic cancellation transaction records reason, actor, approval policy where required and preserved membership history. The approved-unbilled item may then return to the available register only if its eligibility event remains current, unreversed, unsuperseded, in scope and otherwise eligible. Cancellation never deletes or rewrites event/register/line history.

An authorized correction creates a versioned reversal or superseding eligibility event and a corresponding register item; it never rewrites or reuses the prior event/register lineage.

Batch and export control totals reconcile source evidence to billing-eligibility events, approved-unbilled items, unique current occupancy, invoice-ready lines and final occupying batches.

## Audit and provenance

Audit records are append-only for normal application identities and capture actor, active role, source, entity, action, timestamp, reason and material before/after values. Imports retain source identifiers, batch, row outcome and duplicate/idempotency keys.

Billing-eligibility creation, register insertion, occupancy acquisition/release, batch reservation, cancellation, reversal/supersession, finalization and export are production-relevant mutations and retain complete source-to-event-to-register-to-line audit evidence.

## Retention and deletion

Retention is buyer-configurable within legal/policy constraints. Deactivation, anonymization or purge must protect accounting/audit relationships and produce evidence. Production domain records are not hard-deleted merely to simplify UI behavior.

## Migration expectations

Every migration has an ordered identifier, checksum/ledger posture, fresh-install test, supported upgrade test, data-conversion plan and rollback or roll-forward guidance. Application startup is not the only production migration mechanism.

The invoice-readiness migration creates the database-unique current-occupancy control, backfills it only from valid occupying memberships, rejects ambiguous duplicates for controlled remediation and proves the constraint before enabling line creation.

## Backup and recovery

Backups cover database and optional object storage/configuration needed for restoration. Recovery evidence proves schema version, record counts, critical control totals and application readiness after restore.
