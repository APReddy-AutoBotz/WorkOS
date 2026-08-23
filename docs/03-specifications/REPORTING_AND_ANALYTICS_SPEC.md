# Reporting and Analytics Specification

**Governing requirements:** WOS-CORE-003, WOS-CORE-005, WOS-CORE-008; WOS-RPT-001 through WOS-RPT-007; WOS-INT-001 through WOS-INT-006; WOS-GOV-001 through WOS-GOV-005.

## Outcome

Scoped operational and commercial read models explain workforce, utilization, delivery, billable value, optional non-statutory operational earned-management revenue, margin, invoice readiness, data quality and leakage with control totals and auditable exports.

## Report groups

- Operational dashboard: active workforce, capacity, staffing risk, pending work/approvals and data confidence.
- Planned, actual and forecast utilization with explicit denominators/inclusion/as-of date.
- Budget versus actual, billable value, operational earned-management revenue only where an authorized effective-dated policy is active, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.
- Billing-eligibility, approved-unbilled and invoice-ready reconciliation for T&M, milestone, fixed-fee, retainer, managed-service and approved-adjustment sources.
- Data-quality and integration-health reports.

## Revenue-leakage controls

Deterministic signals include missing/late timesheets, unapproved work, source evidence that has not produced a required billing-eligibility event, eligible events missing an approved-unbilled item, approved-unbilled items not batched within policy, date-policy exceptions, missing/conflicting rates, PO risk, fixed-fee overrun, retainer expiry/overconsumption, low margin and duplicate/anomalous billing eligibility.

Each signal has entity, severity, reason, owner, suggested action, as-of date and source evidence. Signals do not autonomously create eligibility events, register items, invoice-ready lines or finance/approval state.

## Read models and reconciliation

Reports query authoritative records and versioned commercial evidence. Operational earned-management metrics identify the active policy/version and never claim statutory recognition or billing authority.

Commercial reconciliation follows only this lineage:

```text
versioned source evidence
→ billing-eligibility-event version
→ approved-unbilled-item version
→ invoice-ready line
→ active/finalized batch
→ finance export/confirmation
```

Reports publish separate control totals and exception counts at every boundary. A raw source or calculation snapshot appearing in an invoice-ready total without an event and register item is a blocking data-quality/control failure.

The approved-unbilled register report contains only approved-unbilled-item versions and includes source type/version, event version, organization/legal entity, approval or contractual-due evidence, eligible date, currency, amount, reversal/supersession state and active/final batch state. It does not treat raw T&M snapshots, milestones, schedules, retainer/managed-service events or adjustments as alternative register rows.

Materialized views/jobs may improve performance but retain refresh time/version and cannot become an untraceable alternative source of truth.

## Scope and exports

Server-side permission and organization/entity scope apply before aggregation and drilldown. Export uses the same scoped query, records filters/as-of/version, output hash/reference and audit event. Cost/margin columns require separate permissions.

Initial finance delivery may originate only from an `Approved` invoice-ready batch. The exported lines preserve approved-unbilled-item and billing-eligibility-event lineage and matching control totals. `Exported` and `Billed/Confirmed` batches permit only authorized, idempotent retrieval/redownload of the already accepted immutable artifact or downstream-status confirmation; they cannot initiate a new provider/CSV delivery, create a second accepted export operation or transition to `Exported` again.

## Integration contracts

Versioned worklog-import and finance-export adapters use idempotency, mapping evidence and failure isolation. Health shows provider mode/readiness, mapping gaps, lineage/control-total failures and delivery failures without secrets.

## Acceptance cases

Positive cases include:

- Role-scoped dashboard and drilldown.
- Utilization denominator explanation.
- Source-type-specific billing-eligibility reporting.
- Source → event → register → batch line/batch/export control-total reconciliation.
- Audited initial CSV/API export from `Approved` batch lines and idempotent final-state artifact retrieval/status confirmation without duplicate delivery.
- Reversal/supersession reporting without rewriting prior totals.

Negative cases include:

- Employee cannot infer another worker/client/cost/margin via totals, filters, exports or error messages.
- A raw source/snapshot cannot appear directly in approved-unbilled or invoice-ready totals.
- Duplicate eligibility event/register item or multiple active/final batch inclusion is flagged.
- A reversed/superseded register item is excluded from current eligible totals while history remains visible to authorized roles.
- Stale read-model totals fail reconciliation.
- Initial finance delivery from any state other than `Approved` is rejected.
- `Exported` or `Billed/Confirmed` retrieval/status operations cannot create another delivery or accepted export operation.
- Failed adapter delivery does not claim export confirmation.

## Migration and rollback

Imported legacy reports remain compatibility views until control totals and role journeys match. Compatibility reports must not expose a direct raw-source-to-batch interpretation. Report changes are versioned; rollback restores the prior read model without rewriting authoritative snapshots, eligibility events, register items or finalized batch evidence.