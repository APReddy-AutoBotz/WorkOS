# Reporting and Analytics Specification

**Governing requirements:** WOS-CORE-003, WOS-CORE-005, WOS-CORE-008; WOS-RPT-001 through WOS-RPT-007; WOS-INT-001 through WOS-INT-006; WOS-GOV-001 through WOS-GOV-005.

## Outcome

Scoped operational and commercial read models explain workforce, utilization, delivery, revenue, margin, invoice readiness, data quality and leakage with control totals and auditable exports.

## Report groups

- Operational dashboard: active workforce, capacity, staffing risk, pending work/approvals and data confidence.
- Planned, actual and forecast utilization with explicit denominators/inclusion/as-of date.
- Budget versus actual, revenue, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.
- Approved-unbilled and invoice-ready reconciliation.
- Data-quality and integration-health reports.

## Revenue-leakage controls

Deterministic signals include missing/late timesheets, unapproved work, approved-unbilled work, date-policy exceptions, missing/conflicting rates, PO risk, fixed-fee overrun, retainer expiry/overconsumption, low margin and duplicate/anomalous billing eligibility.

Each signal has entity, severity, reason, owner, suggested action, as-of date and source evidence. Signals do not autonomously change finance or approval state.

## Read models and reconciliation

Reports query authoritative records/snapshots and publish control totals. Commercial reports reconcile to snapshot and invoice-ready line/batch totals. Materialized views/jobs may improve performance but retain refresh time/version and cannot become an untraceable alternative source of truth.

## Scope and exports

Server-side permission and organization/entity scope apply before aggregation and drilldown. Export uses the same scoped query, records filters/as-of/version, output hash/reference and audit event. Cost/margin columns require separate permissions.

## Integration contracts

Versioned worklog-import and finance-export adapters use idempotency, mapping evidence and failure isolation. Health shows provider mode/readiness, mapping gaps and failures without secrets.

## Acceptance cases

Positive: role-scoped dashboard/drilldown, utilization denominator explanation, commercial reconciliation and audited CSV/API export.

Negative: employee cannot infer another worker/client/cost/margin via totals, filters, exports or error messages; stale read-model totals fail reconciliation; failed adapter delivery does not claim export confirmation.

## Migration and rollback

Imported legacy reports remain compatibility views until control totals and role journeys match. Report changes are versioned; rollback restores prior read model without rewriting authoritative snapshots.