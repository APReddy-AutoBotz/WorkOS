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

The only batchable object is a versioned `approved_unbilled_item`. Exactly one register item is created for one billing-eligibility-event version. The register item retains the complete event lineage and active/final batch state.

A raw work entry, commercial snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or adjustment may be displayed as evidence, but it cannot be selected or submitted directly as an invoice-ready line.

## Invoice readiness

Finance users query the approved-unbilled register and create batches by client, legal entity, engagement, period and currency. Every invoice-ready line references exactly one approved-unbilled-item version and, through it, exactly one billing-eligibility-event version and source version.

States are Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled. Finalization preserves source → event → register → line → batch control totals and immutable evidence.

Database constraints, transactional locking and idempotency prevent an eligibility-event version or approved-unbilled item from appearing in more than one active or finalized batch. An authorized correction creates a versioned reversal or superseding eligibility event/register item and never reuses or mutates the prior lineage.

WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, eligibility-event creation, batch preparation and final approval are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Positive vectors cover:

- Rate precedence/effective dates, currency/rounding and T&M caps.
- Every enabled operational earned-management profile and policy-disabled fail-closed cases.
- T&M, milestone, fixed-fee, retainer, managed-service and adjustment eligibility-event creation.
- One-to-one eligibility-event/register-item creation.
- Source → event → register → line → batch control-total reconciliation.
- Versioned reversals/supersessions and valid correction flows.
- Budget/EAC and finalized batch/export totals.

Negative vectors cover:

- Missing/conflicting rate, expired PO, invalid FX and stale term version.
- Unauthorized cost/margin or eligibility-event access.
- Raw source or calculation-snapshot direct-batch bypass.
- Source lacking approval, acceptance or contractual-due evidence.
- Duplicate event/register creation or reuse in another active/final batch.
- Reversed/superseded/stale register item.
- Locked period, out-of-scope batch, duplicate adjustment and failed control-total reconciliation.

## Recalculation, correction and audit

Controlled recalculation creates a new snapshot version and reason. Credits/write-offs/discounts are approved versioned source records; invoice eligibility then creates their event/register lineage. Finalization and export preserve control totals and evidence.

## Migration and rollback

Commercial tables are additive and feature gated. Seeded vectors and neutral defaults are synthetic. Before finalization use rollback/disable; after snapshots, eligibility events, register items or batches exist, use forward corrections and preserve evidence.