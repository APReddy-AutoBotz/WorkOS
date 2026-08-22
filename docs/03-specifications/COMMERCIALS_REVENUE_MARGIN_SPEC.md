# Commercials, Revenue, Margin and Invoice-Readiness Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005, WOS-CORE-008; WOS-COM-001 through WOS-COM-015; WOS-INV-001 through WOS-INV-008; WOS-GOV-001 through WOS-GOV-002.

## Outcome

WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports revenue/cost/margin and prepares traceable invoice-ready exports.

## Commercial terms

- Effective-dated billing rate cards with dimensions such as client, contract, engagement, project, role, worker, location and grade.
- Deterministic precedence and explicit no-rate/conflict outcomes.
- Confidential effective-dated cost rates and optional burden components.
- Currency precision, configured exchange-rate inputs and rounding by amount type.
- Budgets for hours/units, revenue, cost and expenses with approved change history.
- POs with committed/consumed/remaining value and thresholds.

## Calculation paths

- T&M: approved eligible quantity × resolved rate, subject to caps/exclusions/rounding.
- Fixed fee: contract/schedule value with consumed effort/cost and earned/recognized policy; hours are not automatically invoiceable.
- Milestone: accepted/approved milestone value and billing eligibility.
- Retainer: period capacity/value consumption, rollover/expiry and overage.
- Managed service: configured service units/tickets/shifts with optional time/cost evidence.

## Snapshot

Each versioned snapshot records source, quantity/unit, term/rate/cost/FX sources, values, currency, rounding, outputs, calculation version, actor/job and timestamp. Later term changes do not mutate prior finalized versions.

## Invoice readiness

Finance users review approved-unbilled sources and create batches by client, legal entity, engagement, period and currency. Lines trace to snapshots/milestones/retainer schedules or controlled adjustments. States are Draft, Under Review, Approved, Exported, Billed/Confirmed and Cancelled.

No-double-billing constraints prevent one eligible source from appearing in multiple active/final batches unless a controlled reversal/correction exists. WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, batch preparation and final approval are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Positive vectors cover rate precedence/effective dates, currency/rounding, T&M caps, fixed-fee consumption, milestone acceptance, retainer rollover/overage, managed-service units, budget/EAC and invoice batch totals.

Negative vectors cover missing/conflicting rate, expired PO, invalid FX, unauthorized cost/margin read, stale term version, locked period, double billing, duplicate adjustment, out-of-scope batch and failed control-total reconciliation.

## Recalculation, correction and audit

Controlled recalculation creates a new version and reason. Credits/write-offs/discounts are explicit lines with approval/audit. Finalization and export preserve control totals and evidence.

## Migration and rollback

Commercial tables are additive and feature gated. Seeded vectors and neutral defaults are synthetic. Before finalization use rollback/disable; after snapshots/batches exist, use forward corrections and preserve evidence.