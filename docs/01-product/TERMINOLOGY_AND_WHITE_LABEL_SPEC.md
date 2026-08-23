# Terminology and White-Label Specification

**Governing requirements:** WOS-CORE-001, WOS-CORE-006, WOS-CORE-007, WOS-ORG-001, WOS-ORG-005 through WOS-ORG-007.

## Objectives

- A buyer changes branding and approved labels without editing feature code.
- Canonical domain/API keys remain stable when user-facing labels change.
- Configuration is validated, versioned and auditable.
- Production assets never depend on reference-company names or files.

## Brand configuration

At minimum:

- Product display name and optional short name.
- Organization display/legal name.
- Primary logo, compact mark and favicon.
- Primary and secondary accent tokens with accessible contrast validation.
- Support name, email and help URL.
- Email/report header and footer identity.

Assets must use controlled storage or packaged neutral defaults. Missing assets fall back to neutral text/mark, not a reference brand.

## Terminology registry

Configurable singular/plural labels include:

| Canonical key | Neutral default |
|---|---|
| `worker` | Resource / Resources |
| `manager` | Manager / Managers |
| `team_lead` | Team Lead / Team Leads |
| `business_unit` | Business Unit / Business Units |
| `region` | Region / Regions |
| `engagement` | Engagement / Engagements |
| `project` | Project / Projects |
| `worklog` | Timesheet / Timesheets |

The registry may also include short help text. Canonical permission keys, database columns, audit entity types and API contract fields do not change.

## Application rules

- UI navigation, page headings, form labels, notifications and generated reports consume the registry where specified.
- Security messages may use canonical descriptions when necessary for unambiguous audit/support.
- Search and deep links use stable routes/IDs, not configured labels.
- Configuration changes are versioned and identify actor, time and prior/new values.
- A preview surface shows logo, colors and terminology before activation.

## Environment and release controls

Feature enablement records environment, owner, activation time, evidence and rollback. Branding/terminology changes cannot enable unaccepted modules.

## Acceptance

Positive: replacing neutral labels and assets updates covered surfaces without code changes.

Negative: invalid assets, unsafe colors, missing support identity, unknown canonical keys or an attempt to rename API/permission keys are rejected; no old brand appears in production build, seed, notification or deployment output.