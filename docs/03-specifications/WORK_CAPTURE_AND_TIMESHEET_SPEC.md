# Work Capture and Timesheet Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005; WOS-IAM-003, WOS-IAM-005, WOS-IAM-010; WOS-TIM-001 through WOS-TIM-012; WOS-WKF-005, WOS-WKF-007.

## Outcome

Workers record reviewable daily or weekly work evidence under buyer-configurable assignment, category, timing, comment and evidence policies.

## Records and states

A work entry contains worker, date, engagement/project, optional task/ticket/milestone, category, quantity/hours, billability, comment, evidence link, source and provenance. Entries group into a work period/timesheet with Draft, Submitted, Approved, Rejected/Correction Required, Reopened and Locked states.

## Modes and policy

- Weekly grid and daily entry are v1 modes.
- Configurable increments, daily/weekly limits, overtime, deadlines and grace periods.
- Categories distinguish billable client, non-billable client, internal, pre-sales, training, administration and buyer-defined work. Leave/absence may appear as read-only availability/calendar context but is not a productive work entry, is never billable and needs no client engagement/project.
- Future dates, assignment/contract dates and period states are server validated.
- Imported and manual entries use deterministic duplicate/source keys.

A timer is optional and may only create Draft reviewable entries.

## Submission and correction

Submission validates all entries atomically and creates the required approval. Rejection reasons are visible. Correction preserves prior submissions/decisions; locked-period changes require protected reopen policy and audit.

## Utilization

Actual utilization uses approved productive work and configured inclusion rules divided by effective available capacity. Approved leave/holidays reduce availability exactly once and never enter the numerator; Draft, rejected, absence-reference or otherwise excluded categories do not silently count.

## Authorization and audit

Workers edit only authorized own Draft/Correction records. Managers/approvers view/decide scoped periods through permissions and relationships. Imports identify source/batch. All state, correction and exception transitions are audited.

## Acceptance cases

Positive:

- Enter weekly and daily work across assigned projects and permitted categories.
- Submit, reject with reason, correct and approve while preserving history.
- Import external worklogs idempotently with row results.

Negative:

- Out-of-scope worker/project, future/locked date, invalid increment, excess limit and missing required evidence are rejected.
- A user cannot approve their own work where separation policy forbids it.
- Client-supplied billability/status/organization cannot bypass server policy.
- Duplicate imported or manual/source-linked work is blocked or deterministically flagged.

## Migration and rollback

Historical timesheets remain readable and map to neutral work periods/entries. State and approval evidence are reconciled. Compatibility paths remain until role journeys and utilization totals match; rollback does not delete migrated history.