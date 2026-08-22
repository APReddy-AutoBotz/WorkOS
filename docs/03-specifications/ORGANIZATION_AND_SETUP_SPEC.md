# Organization and Setup Specification

**Governing requirements:** WOS-CORE-001, WOS-CORE-002, WOS-CORE-005 through WOS-CORE-007; WOS-ORG-001 through WOS-ORG-010; WOS-IAM-004 through WOS-IAM-007; WOS-GOV-005.

## Outcome

A new buyer configures organizational ownership, structure, brand, terminology, calendars, periods, roles and readiness without changing feature code.

## Domain records

- Organization profile and effective configuration version.
- Legal entities with currency, optional legal identifiers, address, dates and status.
- Business units, departments, cost centres, practices, locations and regions.
- Reporting and operational ownership relationships independent of user-facing titles.
- Brand assets/tokens and terminology registry.
- Working calendars and reporting periods.
- Feature release configuration and setup-readiness checklist.

All primary records are organization owned. Dependency-safe retirement replaces destructive deletion.

## Configuration behavior

- Canonical keys remain stable; display labels and help text are configurable.
- Brand/terminology changes are previewed, validated, versioned and audited.
- Calendar precedence is explicit: worker override/group, legal entity, country, organization default.
- Period state supports Open, Submission Closed, Approval Closed and Financially Locked.
- Feature activation records environment, owner, evidence and timestamp.

## Guided setup

Readiness is server-derived from completed records and validated provider/configuration state, not client checkboxes. Sections include organization, legal entity, calendars/periods, roles/initial users, identity, imports, commercial defaults, notifications and production controls.

## Authorization and audit

Organization configuration, legal entities, permission templates and release settings use separate protected permissions. Reads/writes are organization scoped. Audit captures actor, active role, prior/new version and reason for high-risk changes.

## API/data rules

- IDs in commands are verified against session organization.
- Scoped unique constraints apply to codes/names where required.
- Effective configuration used by historical snapshots remains resolvable.
- Assets are size/type validated and never execute active content.

## Acceptance cases

Positive:

- Create a buyer organization with two legal entities and distinct calendars/currencies.
- Rename user-facing worker/project/worklog terms and update covered UI/report/email surfaces.
- Retire an unused catalog node and preserve history.

Negative:

- Cross-organization read/write and request-supplied organization override are denied.
- A catalog with active dependencies cannot be retired without controlled reassignment.
- Invalid color contrast/asset or unknown canonical terminology key is rejected.
- A financially locked period cannot be reopened without protected authority and reason.

## Migration and rollback

WOS-02 migrates imported records to a deterministic default organization/legal entity and reconciles counts/relationships. Rollback before data use may remove the foundation; after dependent data exists, use forward migrations and preserve ownership history.