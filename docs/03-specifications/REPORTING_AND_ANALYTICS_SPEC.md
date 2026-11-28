# Reporting and Analytics Specification

The overview reports the arithmetic mean of the measured worker percentages and discloses both measured and total eligible worker counts. Measurement requires a qualifying approved week and positive expected weekly hours. With no measured workers the average and current exception count are unavailable.

Weekly actuals in the planning and utilization report APIs use the most recent currently approved timesheet with a week ending on or before the source date. Forecast allocation uses the horizon end independently. This cutoff compares work dates. Historical approval status at the time of the report is outside this calculation.

The compatibility forecast counts projects below 100% allocated using eligible workers and projects in term at the horizon end. Peak pressure requires positive workforce capacity.

Forecast checkpoints and roll-offs use the UTC source date returned by the report. The chart labels individual checkpoint dates and the audited CSV includes the source and horizon end dates.

The compatibility utilization report distinguishes approved zero billable hours from unapproved work or unavailable weekly capacity. Its global CSV uses the same inclusion rule. Weekly plan gaps require matching worker coverage. The missing-worker list uses the scoped eligible roster and all timesheets in the selected period. Weekly submission coverage counts each eligible worker once, independently of the review filter.

**Governing requirements:** WOS-CORE-003, WOS-CORE-005, WOS-CORE-008; WOS-RPT-001 through WOS-RPT-007; WOS-INT-001 through WOS-INT-006; WOS-GOV-001 through WOS-GOV-005.

## Outcome

Scoped operational and commercial read models explain workforce, utilization, delivery, billable value, optional non-statutory operational earned-management revenue, margin, invoice readiness, data quality and leakage with control totals and auditable exports.

## Report groups

- Operational dashboard: active workforce, capacity, staffing risk, pending work/approvals and data confidence.
- Planned, actual and forecast utilization with explicit denominators/inclusion/as-of date.
- Budget versus actual, billable value, operational earned-management revenue only where an authorized effective-dated policy is active, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.
- Billing-eligibility, approved-unbilled, unique current invoice-line occupancy and invoice-ready reconciliation for T&M, milestone, fixed-fee, retainer, managed-service and approved-adjustment sources.
- Data-quality and integration-health reports.

## Revenue-leakage controls

Deterministic signals include missing/late timesheets, unapproved work, source evidence that has not produced a required billing-eligibility event, eligible events missing an approved-unbilled item, approved-unbilled items not batched within policy, date-policy exceptions, missing/conflicting rates, PO risk, fixed-fee overrun, retainer expiry/overconsumption, low margin, duplicate/anomalous billing eligibility and any duplicate or inconsistent current invoice-line occupancy.

Each signal has entity, severity, reason, owner, suggested action, as-of date and source evidence. Signals do not autonomously create eligibility events, register items, invoice-ready lines, occupancy records or finance/approval state.

## Read models and reconciliation

Reports query authoritative records and versioned commercial evidence. Operational earned-management metrics identify the active policy/version and never claim statutory recognition or billing authority.

Commercial reconciliation follows only this lineage:

```text
versioned source evidence
→ billing-eligibility-event version
→ approved-unbilled-item version
→ database-unique current line occupancy
→ invoice-ready line
→ active/final batch
→ accepted finance export/confirmation
```

Reports publish separate control totals and exception counts at every boundary. A raw source or calculation snapshot appearing in an invoice-ready total without an event and register item is a blocking data-quality/control failure. So is any approved-unbilled-item version with more than one current occupying line/membership, whether duplicated inside one batch or across batches.

The approved-unbilled register report contains only approved-unbilled-item versions and includes source type/version, event version, organization/legal entity, approval or contractual-due evidence, eligible date, currency, amount, reversal/supersession state, current-occupancy identity and active/final batch state. It does not treat raw T&M snapshots, milestones, schedules, retainer/managed-service events or adjustments as alternative register rows.

The current-occupancy report is derived from the database-enforced occupancy control keyed by approved-unbilled-item ID/version. It identifies the current line and batch, acquisition operation/idempotency identity, occupying class and any valid cancellation release. Historical line/membership records remain separately visible to authorized audit users and are never mistaken for a second current line.

WorkOS v1 does not split one approved-unbilled-item version across multiple invoice-ready lines. Reports reject or flag any partial/presentation split that reuses the item version. Separately billable portions must be represented by distinct authorized/versioned eligibility events and approved-unbilled items and must reconcile to the original source/control totals.

Materialized views/jobs may improve performance but retain refresh time/version and cannot become an untraceable alternative source of truth.

## Scope and exports

Server-side permission and organization/entity scope apply before aggregation and drilldown. Report export uses the same scoped query, records filters/as-of/version, output hash/reference and audit event. Cost/margin columns require separate permissions.

Initial finance delivery originates only from an `Approved` invoice-ready batch and preserves approved-unbilled-item, database current-occupancy, billing-eligibility-event lineage and control totals. `Exported` and `Billed/Confirmed` support only authorized idempotent retrieval/redownload of the already accepted immutable artifact or downstream-status confirmation; they cannot initiate another delivery, create a second accepted export operation or transition again.

## Integration contracts

Versioned worklog-import and finance-export adapters use idempotency, mapping evidence and failure isolation. Health shows provider mode/readiness, mapping gaps, lineage/control-total failures, duplicate-occupancy conflicts and delivery failures without secrets.

## Acceptance cases

Positive cases include:

- Role-scoped dashboard and drilldown.
- Utilization denominator explanation.
- Source-type-specific billing-eligibility reporting.
- One approved-unbilled-item version mapping to exactly one current occupancy and line/membership.
- Same-key idempotent line retry reporting the existing result without a new line.
- Source → event → register → occupancy → batch line/batch/export control-total reconciliation.
- Valid pre-export cancellation release and controlled re-batching through a new line/membership version while history remains visible.
- Audited CSV/API initial delivery from `Approved` batch lines.
- Authorized idempotent final-state artifact retrieval/status confirmation without new delivery.
- Reversal/supersession reporting without rewriting prior totals.

Negative cases include:

- Employee cannot infer another worker/client/cost/margin via totals, filters, exports or error messages.
- A raw source/snapshot cannot appear directly in approved-unbilled or invoice-ready totals.
- Duplicate eligibility event/register item is flagged.
- The same approved-unbilled-item version appearing twice in one batch is a blocking control failure.
- The same item version appearing in two occupying batches is a blocking control failure.
- Concurrent/different-key duplicate occupancy is rejected and reportable while same-key retry remains idempotent.
- A partial/presentation split that reuses the same item version is rejected.
- A reversed/superseded register item is excluded from current eligible totals while history remains visible to authorized roles.
- Final occupying evidence cannot be released or reused.
- Stale read-model totals fail reconciliation.
- Failed adapter delivery does not claim export confirmation.
- `Exported` or `Billed/Confirmed` cannot trigger a second finance delivery.

## Migration and rollback

Imported legacy reports remain compatibility views until control totals and role journeys match. Compatibility reports must not expose a direct raw-source-to-batch interpretation, duplicate current line occupancy or split one approved-unbilled item across lines. Report changes are versioned; rollback restores the prior read model without rewriting authoritative snapshots, eligibility events, register items, line/membership history, current occupancy or finalized batch evidence.
