# WorkOS API Architecture

## Versioning

New productized contracts are introduced under `/api/v1`. Existing imported routes may remain temporarily behind compatibility adapters while behavior is migrated and tested.

## Contract principles

- Request, query and response schemas are explicit and validated.
- Errors contain stable machine code, user-safe message and correlation ID.
- Lists are paginated and filterable for production-scale use.
- High-risk mutations use optimistic concurrency/version checks.
- Imports, finalization and adapter operations use idempotency keys where applicable.
- Cost and margin fields are absent from broad operational DTOs unless separately authorized.

## Request enforcement

```text
authenticated identity
→ active role
→ effective permission
→ organization/legal-entity boundary
→ entity relationship / row scope
→ business policy and current state
→ command execution and audit
```

Authorization runs before data is returned or mutated. UI state and request-supplied ownership fields are not trusted.

## Commands and queries

Commands change state and must enforce validation, policy, concurrency and audit. Queries return scoped read models optimized for workspaces and reports. Long-running imports, exports or snapshots return operation/batch status rather than holding an unsafe request open.

## State transitions

Work period, approval, contract, project, commercial snapshot, billing-eligibility event, approved-unbilled item and invoice-ready batch transitions use explicit state machines. Invalid or stale transitions return deterministic conflict errors.

## Financial endpoints

Financial calculation APIs accept references to authoritative records, not arbitrary client-calculated amounts. Responses identify calculation version and snapshot IDs. Preview endpoints are clearly non-final and cannot be used to bypass approval, billing eligibility or finalization.

A calculation snapshot remains valuation evidence. It cannot be submitted directly as an invoice-ready line.

## Billing eligibility and invoice readiness endpoints

The server exposes distinct commands and queries for:

1. Evaluating an authoritative source version against source-specific approval, contractual-due, acceptance and commercial policy.
2. Creating a versioned `billing_eligibility_event` from exactly one supported source version.
3. Creating or querying the corresponding one-to-one `approved_unbilled_item`.
4. Adding that approved-unbilled item to an invoice-ready batch.
5. Reviewing, approving, cancelling before export, exporting, confirming billing and creating reversal/superseding correction evidence.

A batch-line command accepts only a server-resolved `approvedUnbilledItemId` plus allowed presentation metadata. It must reject requests that try to supply a raw work-entry ID, calculation-snapshot ID, milestone ID, fixed-fee schedule ID, retainer/managed-service event ID, adjustment ID, client-calculated amount, currency, organization or approval status as the direct batch source.

Every accepted command revalidates:

- Active identity, role, permission and organization/legal-entity scope.
- The approved-unbilled item's current version and eligibility-event lineage.
- Source-specific approval or contractual-due/acceptance evidence.
- Eligible date, currency, amount, calculation/policy and rounding evidence.
- Reversal/supersession state.
- Absence from every other occupying batch membership.
- Optimistic concurrency and idempotency key.

## Invoice-ready batch state contract

Canonical states are `Draft`, `Under Review`, `Approved`, `Exported`, `Billed/Confirmed` and `Cancelled`.

The API and database use these exact occupancy classes:

- **Open/active occupying:** `Draft`, `Under Review`, `Approved`.
- **Final occupying:** `Exported`, `Billed/Confirmed`.
- **Non-occupying terminal:** `Cancelled`, only when cancelled before a successful export or billing confirmation.

Minimum accepted transitions are:

```text
Draft → Under Review | Cancelled
Under Review → Draft | Approved | Cancelled
Approved → Exported | Cancelled
Exported → Billed/Confirmed
```

`Cancelled` and `Billed/Confirmed` are terminal. `Exported` cannot transition to `Cancelled`. Export/billing corrections create versioned reversal or superseding billing-eligibility events, approved-unbilled items and correction batch lines rather than releasing or reusing the original lineage.

A failed export leaves the batch in `Approved` and records a failed integration attempt; an idempotent retry may continue. The state becomes `Exported` only after the configured provider accepts the exact versioned export payload and control totals.

A cancellation command is accepted only from `Draft`, `Under Review` or pre-export `Approved`, requires reason and applicable approval authority, and atomically records cancellation plus occupancy release. It returns an item to the available approved-unbilled register only when the underlying eligibility event remains current, unreversed, unsuperseded, in scope and otherwise eligible. Historical line/membership evidence remains immutable.

The API returns stable conflict codes for:

- Direct-source/snapshot bypass.
- Stale event/register/batch version.
- Already occupied by another open/active or final batch.
- Cancellation after export or billing confirmation.
- Reversed/superseded source or register item.
- Invalid transition.
- Invalid batch scope/currency.
- Control-total mismatch.

Invoice-ready lines expose traceability to exactly one approved-unbilled item and through it exactly one billing-eligibility-event version. Raw source evidence may be included as read-only lineage; it is never accepted as an alternative batchable object.

## Integration contracts

Inbound adapters map external identifiers to controlled domain records and retain source/idempotency evidence. Outbound finance exports use versioned schemas, `Approved` batches, event/register lineage, control totals and export audit; only accepted exports transition to `Exported`.

## Observability

Every request receives a correlation ID. Structured logs record safe route, status, duration, user/role identifiers and denial/error code without exposing credentials or unrestricted personal/financial payloads.

## Compatibility and deprecation

Compatibility routes have an owner, migration plan, tests and removal release. A compatibility endpoint must not recreate a raw-source-to-batch shortcut or weaken occupancy state semantics. Breaking changes require versioned contracts and release notes.