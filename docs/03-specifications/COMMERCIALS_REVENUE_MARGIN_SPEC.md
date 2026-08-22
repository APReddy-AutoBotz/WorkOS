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

## Invoice readiness

Finance users review an approved-unbilled register and create batches by client, legal entity, engagement, period and currency. The register includes approved T&M snapshots, accepted billing-eligible milestones, approved/due fixed-fee schedule events, approved retainer base/period/overage events, approved managed-service period/unit events and approved invoice-eligible adjustments.

Each register and batch line retains source type/version, approval or eligibility evidence, currency, eligible date, amount and commercial/policy evidence, and is excluded once it belongs to an active or finalized batch except through an authorized reversal/correction. States are Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled.

No-double-billing constraints prevent one eligible source from appearing in multiple active/final batches unless a controlled reversal/correction exists. WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, batch preparation and final approval are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Positive vectors cover rate precedence/effective dates, currency/rounding, T&M caps, every enabled operational earned-management policy profile, policy-disabled fail-closed cases, fixed-fee consumption, milestone acceptance, retainer rollover/overage, managed-service units, budget/EAC, approved-unbilled by source type and invoice-batch totals.

Negative vectors cover missing/conflicting rate, expired PO, invalid FX, unauthorized cost/margin read, stale term version, locked period, double billing, duplicate adjustment, out-of-scope batch and failed control-total reconciliation.

## Recalculation, correction and audit

Controlled recalculation creates a new version and reason. Credits/write-offs/discounts are explicit lines with approval/audit. Finalization and export preserve control totals and evidence.

## Migration and rollback

Commercial tables are additive and feature gated. Seeded vectors and neutral defaults are synthetic. Before finalization use rollback/disable; after snapshots/batches exist, use forward corrections and preserve evidence.