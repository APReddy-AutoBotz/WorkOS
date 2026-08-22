# Resource Planning Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005; WOS-WKF-001 through WOS-WKF-008; WOS-RES-001 through WOS-RES-009; WOS-TIM-010.

## Outcome

Authorized planners understand effective capacity, availability, demand, assignments, utilization, bench, overload and roll-off without rewriting historical work or financial results.

## Workforce and capacity

Workers include type/status, organization structure, manager, dates, utilization eligibility and effective capacity profiles. Working calendars, holidays and approved leave reduce availability exactly once; absence is not productive/billable work and is excluded from the actual-utilization numerator. Skills/certifications support deterministic filtering and demand matching.

## Demand and assignment

Demand records define engagement/project, role/skill, date range, required percentage/hours and status. Assignments link worker, demand/project, role, percentage/planned hours, dates, billability, treatment and status.

Assignment dates and overlap are server validated. Warning/block thresholds are configurable. Material changes may create approval records.

## Utilization

- Planned: effective assignment load divided by effective capacity.
- Actual: approved included work divided by effective available capacity.
- Forecast: future approved/planned assignments over configured horizons.

Reports identify bench, underload, overload, unstaffed demand and roll-off using explicit thresholds and as-of dates.

## Lifecycle and history

Worker exit, assignment end and project closure identify dependencies. Ending/editing an assignment does not rewrite approved work, utilization history or commercial snapshots.

## Authorization and confidentiality

Planners receive organization/legal-entity and relationship scope. Worker personal fields, cost rates and margin are excluded unless separately permitted. Employee self-service exposes only own authorized projections.

## Acceptance cases

Positive:

- Calculate part-time/leave-adjusted capacity and overlapping assignments while proving leave is not double counted or treated as productive work.
- Show future roll-off, bench and demand gaps for a scoped manager.
- Approve a material assignment change and preserve prior version.

Negative:

- Out-of-scope worker/project allocation is denied.
- Client-supplied load/capacity cannot override server calculation.
- Assignment outside project dates or over blocking threshold fails without approved exception.
- Governance/non-eligible workers are not silently included in utilization denominator.

## Migration and rollback

Existing workers/allocations migrate to effective capacity/assignment records with reconciled counts and utilization fixtures. Compatibility reports remain until planned/actual/forecast parity is proven.