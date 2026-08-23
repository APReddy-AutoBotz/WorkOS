# Commercials, Revenue, Margin and Invoice-Readiness Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005, WOS-CORE-008; WOS-COM-001 through WOS-COM-015; WOS-INV-001 through WOS-INV-008; WOS-GOV-001 through WOS-GOV-002.

## Outcome

WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports billable value/cost/margin and optional non-statutory operational earned-management revenue, and prepares traceable invoice-ready exports.

## Commercial terms

- Effective-dated billing rate cards with dimensions such as client, contract, engagement, project, role, worker, location and grade.
- Deterministic precedence and explicit no-rate/conflict outcomes.
- Confidential effective-dated cost rates and optional burden components.
- Currency precision, configured exchange-rate inputs and rounding by amount type.
- Budgets for hours/units, revenue, cost and expenses with approved change history.
- POs with committed/consumed/remaining value and thresholds.

## Calculation paths

- T&M: approved eligible quantity × resolved rate, subject to caps/exclusions/rounding.
- Fixed fee: contract/schedule value with consumed effort/cost and an explicitly selected operational earned-management policy; hours are not automatically invoiceable.
- Milestone: accepted/approved milestone value and billing eligibility.
- Retainer: period capacity/value consumption, rollover/expiry and overage.
- Managed service: configured service units/tickets/shifts with optional time/cost evidence.

## Operational earned-management revenue

Operational earned-management revenue is a project-control metric, not statutory accounting recognition. T&M may use the approved-eligible-value profile. For fixed-fee, milestone, retainer and managed-service models the calculation is disabled until an authorized effective-dated profile is selected. Supported profiles include fixed-fee time-elapsed, fixed-fee progress/effort, milestone acceptance, retainer service-period/base/overage and managed-service accepted-unit/period-charge.

Each profile defines source evidence, timing, formula inputs, exclusions, currency/FX, rounding, version, approval owner and correction/recalculation behavior. Billing eligibility is a separate decision and cannot be inferred merely because operational earned-management revenue exists.

## Snapshot

Each versioned snapshot records source, quantity/unit, term/rate/cost/FX sources, values, currency, rounding, outputs, calculation version, actor/job and timestamp. Later term changes do not mutate prior finalized versions.

A calculation snapshot is valuation evidence. It never enters an invoice-ready batch directly and does not become billing authority merely because it contains billable value or operational earned-management revenue.

## Source-specific billing eligibility

The server creates a versioned `billing_eligibility_event` only after one authoritative source version satisfies its source-specific evidence rules:

- **T&M:** an approved eligible T&M calculation snapshot and its underlying approved work evidence.
- **Milestone:** an accepted milestone version and any required client/internal approval evidence.
- **Fixed fee:** an approved or contractually due billing-schedule version; effort or earned-management progress alone is insufficient.
- **Retainer:** an approved base-period, rollover, expiry or overage event version under the applicable contract policy.
- **Managed service:** an approved fixed-period charge or accepted service-unit event version.
- **Adjustment:** an approved commercial adjustment, credit, discount, write-off or correction version.

Every eligibility event records source type and immutable source version, organization/legal entity, client/contract/engagement, approval or contractual-due/acceptance evidence, eligible date, currency, decimal amount, calculation/policy/rounding evidence where applicable, event version/status, and reversal/supersession lineage.

## Approved-unbilled register

The only batchable object is a versioned `approved_unbilled_item`. Exactly one register item is created for one billing-eligibility-event version. The register item retains the complete event lineage and current/historical batch membership state.

A raw work entry, commercial snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or adjustment may be displayed as evidence, but it cannot be selected or submitted directly as an invoice-ready line.

## Invoice readiness

Finance users query the approved-unbilled register and create batches by client, legal entity, engagement, period and currency. Every invoice-ready line references exactly one approved-unbilled-item version and, through it, exactly one billing-eligibility-event version and source version.

### Canonical batch states and occupancy

The canonical states are `Draft`, `Under Review`, `Approved`, `Exported`, `Billed/Confirmed` and `Cancelled`.

- **Open/active occupying:** `Draft`, `Under Review`, `Approved`.
- **Final occupying:** `Exported`, `Billed/Confirmed`.
- **Non-occupying terminal:** `Cancelled`, only for a batch cancelled before any successful export or downstream billing confirmation.

An approved-unbilled item is excluded from the available register while its line belongs to any open/active or final occupying batch. Constraints, transactional locking and idempotency enforce the exclusion under concurrent operations.

Minimum transitions are:

```text
Draft → Under Review | Cancelled
Under Review → Draft | Approved | Cancelled
Approved → Exported | Cancelled
Exported → Billed/Confirmed
```

`Cancelled` and `Billed/Confirmed` are terminal. `Exported` cannot transition to `Cancelled`.

### Export acceptance

An initial export or delivery may originate only from an `Approved` batch. A failed provider delivery or CSV-artifact generation leaves the batch `Approved`, retains occupancy and records the failed operation.

The single `Approved → Exported` transition occurs only when either:

1. A configured provider accepts the exact immutable versioned payload and matching control totals; or
2. WorkOS atomically creates and records an immutable, versioned CSV artifact, validates matching control totals and makes that exact artifact available for controlled retrieval.

The CSV acceptance record contains export-operation ID, idempotency key, immutable artifact ID/version, checksum, schema version, line count, control totals, generated timestamp, authorized actor and source → event → register → line → batch lineage.

Repeated requests with the same idempotency key return the same accepted artifact or provider-operation result. They must not regenerate content, duplicate downstream delivery or reapply the transition. `Exported` and `Billed/Confirmed` batches may support idempotent retrieval/redownload or downstream-status confirmation of the already accepted artifact, but cannot initiate another delivery or become `Exported` again.

A pre-export cancellation from `Draft`, `Under Review` or `Approved` requires reason, authority and audit. The atomic cancellation preserves historical line membership and releases current occupancy. The item returns to the available register only if its eligibility event is still current, unreversed, unsuperseded, in scope and otherwise valid.

After `Exported` or `Billed/Confirmed`, corrections use a versioned reversal or superseding eligibility event, corresponding approved-unbilled item and correction batch. The original source/event/register/line/batch/export lineage remains occupied and immutable. Accepted CSV artifacts and provider payload evidence are never overwritten.

Finalization preserves source → event → register → line → batch → export control totals and immutable evidence.

WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, eligibility-event creation, batch preparation, cancellation, final approval, initial export, final-artifact retrieval and billing confirmation are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Positive vectors cover:

- Rate precedence/effective dates, currency/rounding and T&M caps.
- Every enabled operational earned-management profile and policy-disabled fail-closed cases.
- T&M, milestone, fixed-fee, retainer, managed-service and adjustment eligibility-event creation.
- One-to-one eligibility-event/register-item creation.
- Source → event → register → line → batch/export control-total reconciliation.
- Valid Draft/Under Review/Approved occupancy and pre-export cancellation/release.
- Idempotent failed-provider retry that remains `Approved` until acceptance.
- Successful CSV acceptance with immutable artifact/version/checksum/schema/line-count/control-total evidence.
- Repeated CSV/provider request with the same idempotency identity returning the same accepted result without duplicate delivery or re-transition.
- `Approved → Exported → Billed/Confirmed` final occupancy.
- Idempotent retrieval/redownload or status confirmation from final states without new delivery.
- Versioned reversals/supersessions and valid correction flows after export/confirmation.
- Budget/EAC and finalized batch/export totals.

Negative vectors cover:

- Missing/conflicting rate, expired PO, invalid FX and stale term version.
- Unauthorized cost/margin, eligibility-event, initial-export or final-artifact access.
- Raw source or calculation-snapshot direct-batch bypass.
- Source lacking approval, acceptance or contractual-due evidence.
- Duplicate event/register creation or reuse in another Draft, Under Review, Approved, Exported or Billed/Confirmed batch.
- Initial export request from any state other than `Approved`.
- Duplicate downstream delivery or second `Exported` transition from `Exported` or `Billed/Confirmed`.
- Idempotency-key reuse with different payload/artifact identity.
- CSV artifact missing checksum, schema version, line count, control totals, actor or immutable version.
- Cancellation after Exported or Billed/Confirmed.
- Reversed/superseded/stale register item.
- Locked period, out-of-scope batch, duplicate adjustment, invalid transition and failed control-total reconciliation.

## Recalculation, correction and audit

Controlled recalculation creates a new snapshot version and reason. Credits/write-offs/discounts are approved versioned source records; invoice eligibility then creates their event/register lineage. Cancellation, finalization, provider/CSV export acceptance, retrieval, confirmation and correction preserve control totals and evidence.

## Gate C acceptance boundary

The product-owner Gate C review occurs only after PR-010, PR-011 and PR-012 are merged and PR-012 engineering acceptance is independently proven at an exact head. Evidence must prove commercial terms, deterministic calculations, source-specific eligibility, the approved-unbilled register, complete batch occupancy/release states, provider and CSV export acceptance, immutable export lineage, correction paths, authorization and reconciliation. PR-011 calculation-engine evidence alone cannot satisfy Gate C, and Gate C cannot substitute for PR-012 engineering acceptance.

## Migration and rollback

Commercial tables are additive and feature gated. Seeded vectors and neutral defaults are synthetic. Before export/final occupancy use controlled cancellation/disable where valid; after snapshots, eligibility events, register items, accepted export artifacts, Exported/Billed/Confirmed batches or downstream confirmations exist, use forward corrections and preserve evidence.
