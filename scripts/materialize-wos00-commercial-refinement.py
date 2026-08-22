from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    normalized = content.rstrip() + "\n"
    (ROOT / path).write_text(normalized, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Authoritative product requirements
# ---------------------------------------------------------------------------
product = "docs/00-control/PRODUCT_REQUIREMENTS.md"
replace_once(
    product,
    "WorkOS is a buyer-owned professional-services operations platform for organizations that manage people, clients, engagements, project capacity, work evidence, approvals, utilization, revenue and margin.",
    "WorkOS is a buyer-owned professional-services operations platform for organizations that manage people, clients, engagements, project capacity, work evidence, approvals, utilization, billable value, optional operational earned-management value, cost and project margin.",
)
replace_once(
    product,
    "5. Manage billing rates, cost rates, budgets, purchase orders, fixed-fee/retainer consumption, revenue and gross margin.\n6. Prepare controlled invoice-ready work and identify revenue leakage.",
    "5. Manage billing rates, cost rates, budgets, purchase orders, fixed-fee/retainer consumption, billable value, optional operational earned-management value, cost and gross margin.\n6. Prepare controlled invoice-ready work and identify commercial leakage.",
)
replace_once(
    product,
    "| Finance / Billing Analyst | Review approved-unbilled work, prepare invoice-ready batches, reconcile revenue and export billing data |",
    "| Finance / Billing Analyst | Review approved-unbilled work, prepare invoice-ready batches, reconcile billable and operational commercial values, and export billing data |",
)
replace_once(
    product,
    "| Executive / Practice Leader | Review capacity, utilization, client concentration, revenue, margin, risk and data confidence |",
    "| Executive / Practice Leader | Review capacity, utilization, client concentration, billable value, optional operational earned-management value, cost, margin, risk and data confidence |",
)
replace_once(product, "## 12. Commercial, revenue and margin requirements", "## 12. Commercial value, cost and margin requirements")
replace_once(
    product,
    "Engagements/projects must support budgeted hours/units, revenue, cost and expenses as applicable, with approved change history.",
    "Engagements/projects must support budgeted hours/units, contract or billable value, optional operational earned-management value where enabled, cost and expenses as applicable, with approved change history.",
)
replace_once(
    product,
    "Fixed-fee engagements must track contract value, billing schedule, recognized/earned value policy, consumed effort/cost and margin risk without treating all approved hours as directly invoiceable.",
    "Fixed-fee engagements must track contract value, billing schedule, an explicitly selected operational earned-management policy where that optional management metric is enabled, consumed effort/cost and margin risk without treating all approved hours as directly invoiceable.",
)
old_com_011 = """### WOS-COM-011 — Revenue and cost snapshots

The system must produce versioned period snapshots for approved work, billable value, cost, gross margin and margin percentage. WorkOS may additionally calculate **operational earned-management revenue** for planning and project-control purposes; this is not statutory IFRS/GAAP revenue recognition and is not a general-ledger posting.

The neutral default must fail closed: no non-T&M operational earned-management revenue snapshot may be created until an authorized, effective-dated policy is explicitly selected. Supported policy profiles must cover at least T&M approved eligible value, fixed-fee time-elapsed, fixed-fee progress/effort, milestone acceptance, retainer service-period/base/overage and managed-service accepted-unit/period-charge. Each active policy must define source evidence, timing, inputs, exclusions, effective dates, currency/FX, rounding, version, approval owner and correction behavior. Billing eligibility and invoice readiness remain independent from the earned-management policy.
"""
new_com_011 = """### WOS-COM-011 — Operational value and cost snapshots

The system must produce versioned period snapshots for approved work, billable value, cost, gross margin and margin percentage. WorkOS may additionally calculate an optional **operational earned-management value** for planning and project control. That optional metric is not statutory accounting income, a statutory accounting-recognition result or a general-ledger output.

The neutral default is fail closed: no non-T&M operational earned-management snapshot may be created until an authorized, effective-dated policy is explicitly selected. Billing eligibility and invoice readiness remain independent from that policy.

The configurable management templates are deterministic:

- **T&M approved eligible value:** sum approved eligible T&M source valuations by business/work date after rate, cap, exclusion, currency and rounding rules.
- **Fixed-fee time elapsed:** operational contract value multiplied by eligible elapsed service days divided by total eligible service days. Suspended or policy-excluded days are removed from both the elapsed and total eligible-day populations; the result is capped by the policy's configured value limit.
- **Fixed-fee progress/effort:** operational contract value multiplied by an approved progress percentage. The configured progress source is either an approved manual percentage or an approved cost-to-cost/effort basis. The ordinary range is 0–100 percent; any controlled exception requires explicit authority, reason, audit and a configured cap.
- **Milestone acceptance:** approved milestone operational value is allocated to the configured acceptance period only after the required acceptance/approval evidence exists.
- **Retainer:** approved base or service-period allocation plus separately approved overage events according to the configured rollover and expiry policy.
- **Managed service:** accepted units multiplied by the configured unit rate and/or an approved fixed period charge, according to the selected policy.

Every template must define decimal precision, line-level rounding stage and mode, period aggregation, effective dates, policy version, source evidence, approval owner and append-only correction or supersession behavior. Finalized historical outputs are never silently rewritten.
"""
replace_once(product, old_com_011, new_com_011)
replace_once(
    product,
    "Authorized users must review budget, actuals, remaining forecast and estimate-at-completion for hours, revenue, cost and margin.",
    "Authorized users must review budget, actuals, remaining forecast and estimate-at-completion for hours, contract or billable value, optional operational earned-management value, cost and margin.",
)
replace_once(
    product,
    "Every register row must preserve source type and version, organization/legal entity, client/contract/engagement, approval or eligibility evidence, currency, eligible date, amount, calculation/policy evidence where applicable, and active/final batch state. Operational earned-management revenue does not by itself make a source invoice eligible.",
    "Every eligible item is represented by an immutable, versioned `CommercialEligibilityEvent`. The event preserves source family and source version, organization/legal entity, client/contract/engagement, approval or eligibility evidence, currency, eligible date, amount, calculation or policy evidence where applicable, reversal/supersession lineage, and active/final batch state. Optional operational earned-management value does not by itself make a source invoice eligible.",
)
replace_once(
    product,
    "Every batch line must trace to one versioned eligible source from WOS-INV-001—including T&M snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or approved adjustment—and preserve approval/eligibility and commercial-calculation evidence.",
    "Every batch line must reference exactly one immutable `CommercialEligibilityEvent` version from WOS-INV-001—including T&M snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or approved adjustment—and preserve approval/eligibility and commercial-calculation evidence.",
)
replace_once(
    product,
    "Authorized users may add controlled discounts, credits, write-offs or corrections with reason, approval policy and audit.",
    "Authorized users may add controlled discounts, credits, write-offs or corrections with reason, approval policy and audit. An approved adjustment creates a versioned `CommercialEligibilityEvent`; a correction reverses or supersedes prior evidence rather than mutating it.",
)
replace_once(
    product,
    "The server must prevent the same eligible source line from being included in multiple active/finalized invoice-ready batches unless an authorized reversal/correction exists.",
    "The server must enforce organization/legal-entity-scoped uniqueness so the same `CommercialEligibilityEvent` version cannot be included in multiple active or finalized invoice-ready batches. Authorized reversals or corrections create new event versions and preserve the original evidence.",
)
replace_once(
    product,
    "Reports must provide budget versus actual, approved-unbilled, revenue, cost, gross margin, PO consumption, fixed-fee/retainer consumption and estimate-at-completion.",
    "Reports must distinguish budget versus actual, contract or billable value, optional operational earned-management value with its policy/version, cost, gross margin, approved-unbilled value, invoice readiness, PO consumption, fixed-fee/retainer consumption and estimate-at-completion. The optional management metric must never be presented as statutory accounting output.",
)
replace_once(product, "### WOS-RPT-004 — Revenue-leakage signals", "### WOS-RPT-004 — Commercial-leakage signals")

# ---------------------------------------------------------------------------
# Product positioning
# ---------------------------------------------------------------------------
vision = "docs/01-product/PRODUCT_VISION_AND_POSITIONING.md"
replace_once(
    vision,
    "> WorkOS connects workforce capacity, client engagements, work evidence, approvals, utilization, revenue and project margin in one governed operational layer.",
    "> WorkOS connects workforce capacity, client engagements, work evidence, approvals, utilization, billable value, optional operational earned-management value, cost and project margin in one governed operational layer.",
)
replace_once(
    vision,
    "4. **Control:** rates, costs, budgets, POs, revenue, margin and invoice readiness.",
    "4. **Control:** rates, costs, budgets, POs, billable value, optional operational earned-management value, margin and invoice readiness.",
)
replace_once(
    vision,
    "- Commercial snapshots that preserve historical rate/cost evidence.",
    "- Commercial snapshots and eligibility events that preserve historical rate, cost, policy and billing evidence.",
)
replace_once(
    vision,
    "WorkOS is not a payroll engine, full HRMS, CRM, task tracker, statutory invoice issuer, general ledger or autonomous AI approval/calculation system.",
    "WorkOS is not a payroll engine, full HRMS, CRM, task tracker, statutory invoice issuer, statutory accounting-recognition engine, general ledger or autonomous AI approval/calculation system.",
)

# ---------------------------------------------------------------------------
# Domain and data architecture
# ---------------------------------------------------------------------------
write(
    "docs/02-architecture/DOMAIN_MODEL.md",
    """# WorkOS Domain Model

## Scope

The model supports one isolated buyer deployment while retaining explicit organization and legal-entity ownership. Domain behavior is defined by `PRODUCT_REQUIREMENTS.md`; this document defines aggregate boundaries and relationships.

## Core relationship map

```mermaid
erDiagram
    ORGANIZATION ||--o{ LEGAL_ENTITY : owns
    ORGANIZATION ||--o{ BUSINESS_UNIT : structures
    ORGANIZATION ||--o{ USER : authorizes
    ORGANIZATION ||--o{ WORKER : includes
    ORGANIZATION ||--o{ CLIENT : serves
    CLIENT ||--o{ CONTRACT : signs
    LEGAL_ENTITY ||--o{ CONTRACT : owns
    CONTRACT ||--o{ PURCHASE_ORDER : funds
    CONTRACT ||--o{ ENGAGEMENT : governs
    ENGAGEMENT ||--o{ PROJECT : contains
    ENGAGEMENT ||--o{ MILESTONE : defines
    WORKER ||--o{ ASSIGNMENT : receives
    PROJECT ||--o{ ASSIGNMENT : staffs
    WORKER ||--o{ WORK_ENTRY : records
    PROJECT ||--o{ WORK_ENTRY : receives
    WORK_PERIOD ||--o{ WORK_ENTRY : groups
    WORK_PERIOD ||--o{ APPROVAL : requires
    RATE_CARD ||--o{ CALCULATION_SNAPSHOT : resolves
    COST_RATE ||--o{ CALCULATION_SNAPSHOT : resolves
    WORK_ENTRY ||--o{ CALCULATION_SNAPSHOT : values
    CALCULATION_SNAPSHOT ||--o{ COMMERCIAL_ELIGIBILITY_EVENT : supports_TandM
    MILESTONE ||--o{ COMMERCIAL_ELIGIBILITY_EVENT : supports_acceptance
    ENGAGEMENT ||--o{ COMMERCIAL_ELIGIBILITY_EVENT : supports_schedule_service
    COMMERCIAL_ADJUSTMENT ||--o{ COMMERCIAL_ELIGIBILITY_EVENT : supports_adjustment
    COMMERCIAL_ELIGIBILITY_EVENT ||--o{ INVOICE_READY_LINE : supplies_exact_version
    INVOICE_READY_BATCH ||--o{ INVOICE_READY_LINE : contains
```

## Aggregate roots

- Organization and legal entity.
- User/role/permission configuration.
- Worker and capacity profile.
- Client and contract.
- Engagement and project/workstream.
- Assignment and demand record.
- Work period/work entries.
- Approval policy and approval instance.
- Rate card, cost rate and budget.
- Calculation snapshot.
- Commercial eligibility event.
- Invoice-ready batch.
- Audit and integration operation records.

## Commercial eligibility event

`CommercialEligibilityEvent` is the immutable, versioned bridge between approved commercial evidence and invoice readiness. Its source family is one of approved T&M snapshot, fixed-fee billing schedule, accepted milestone, retainer base/period/overage, managed-service accepted-unit/period-charge, or approved adjustment.

Every event records source ID and source version, organization/legal entity, client/contract/engagement, currency, eligible date, amount, approval/eligibility evidence, calculation or policy evidence where applicable, event version, state, and reversal/supersession lineage. A finalized event is append-only. Corrections create reversing or superseding event versions.

Every invoice-ready line references exactly one event version. A database-backed, organization/legal-entity-scoped uniqueness rule prevents the same active event version from appearing in more than one active or finalized batch.

## Identity and ownership

Primary commercial roots carry `organization_id`. Contracting/reporting entities carry `legal_entity_id` where applicable. Child scope is derived through validated relationships; clients cannot self-select another organization through request data.

Business identifiers are organization/legal-entity scoped according to domain need, for example worker code within organization and contract number within legal entity.

## Effective-dated entities

Capacity profiles, assignments, contracts, POs, rate cards, cost rates, calendars, exchange rates and historically relevant policies use explicit effective dates. Overlap rules are enforced where ambiguity would produce unsafe authorization or calculation.

## Historical truth

Approved work history, approval decisions, calculation snapshots, commercial eligibility events and finalized batch lines are not rewritten by later master-data changes. Corrections produce new versions, reversals or superseding evidence.

## Lifecycle guardrails

Closing or retiring a worker, client, contract, engagement or project checks dependent assignments, work, approvals, approved-unbilled events, ownership and commercial balances. Destructive deletes are avoided for production records.

## Boundary rules

- Work evidence is separate from approval.
- Approval is separate from commercial valuation.
- Optional operational earned-management value is separate from statutory accounting output.
- Commercial valuation is separate from billing eligibility.
- Billing eligibility is represented by a versioned commercial eligibility event.
- Invoice readiness is separate from statutory invoicing and ledger posting.
- Cost-rate confidentiality is separate from ordinary project visibility.
""",
)

write(
    "docs/02-architecture/DATA_ARCHITECTURE.md",
    """# WorkOS Data Architecture

## System of record

PostgreSQL is the authoritative store for operational, authorization, commercial, audit and release-relevant data in WorkOS v1.

## Ownership model

- Primary roots include `organization_id` where applicable.
- Contracting/currency/reporting records include `legal_entity_id` when required.
- Foreign keys establish scope; request-supplied ownership IDs are validated against the authenticated session.
- Uniqueness is scoped to the correct owner, not globally by convenience.

## Data classifications

| Class | Examples | Control |
|---|---|---|
| Public/neutral | Product metadata, neutral defaults | Normal repository/runtime handling |
| Internal operational | Projects, assignments, work categories | Permission and scoped access |
| Personal | Worker identity, employment/capacity | Data minimization and role scope |
| Commercial confidential | Contracts, rates, budgets, POs | Separate permissions and audit |
| Highly confidential | Cost rates, compensation-derived data, margin | Restricted DTOs, logs and exports |
| Security secret | Credentials, signing keys | External secret store; never persisted in normal config responses |

## Temporal model

Effective-dated records use start/end dates and optional version/concurrency fields. Historical references point to the applicable version or snapshot. A new future rate, policy or capacity record must not change prior approved results.

## Financial precision

- PostgreSQL `numeric/decimal` types are authoritative for amounts, rates, percentages and exchange rates.
- Currency precision, calculation scale, line-level rounding stage and rounding mode are explicit configuration.
- Binary floating point is not used for stored authoritative currency.
- Exchange-rate inputs record source, effective date, from/to currencies and precision.
- Period totals aggregate already rounded line values unless the selected, versioned policy explicitly defines another tested method.

## Snapshot model

Commercial snapshots store source record/version, quantity/unit, resolved billing and cost terms, currency/FX, rounding, billable value, optional operational earned-management value, cost/margin outputs, calculation version and timestamp. Non-T&M operational earned-management snapshots fail closed until an authorized effective-dated policy is selected. Recalculation creates a superseding version with audit evidence.

## Commercial eligibility event model

A versioned `CommercialEligibilityEvent` normalizes every invoice-eligible source family: approved T&M snapshot, fixed-fee schedule event, accepted milestone, retainer base/period/overage event, managed-service accepted-unit/period-charge event and approved adjustment.

Each event stores source family, source ID/version, organization/legal entity, client/contract/engagement, eligible date, currency, amount, approval/eligibility evidence, optional calculation/policy references, event state/version and reversal/supersession lineage. Events are immutable after finalization.

Each invoice-ready line references exactly one event version. A partial/conditional unique constraint or equivalent transaction-safe rule prevents the same organization/legal-entity-scoped event version from belonging to multiple active or finalized batches. Reversal and correction create new linked versions rather than editing historical evidence.

## Audit and provenance

Audit records are append-only for normal application identities and capture actor, active role, source, entity, action, timestamp, reason and material before/after values. Imports retain source identifiers, batch, row outcome and duplicate/idempotency keys.

## Retention and deletion

Retention is buyer-configurable within legal/policy constraints. Deactivation, anonymization or purge must protect audit and commercial relationships and produce evidence. Production domain records are not hard-deleted merely to simplify UI behavior.

## Migration expectations

Every migration has an ordered identifier, checksum/ledger posture, fresh-install test, supported upgrade test, data-conversion plan and rollback or roll-forward guidance. Commercial eligibility migrations prove all six source families, event-version uniqueness, reversal lineage and register-to-batch control totals. Application startup is not the only production migration mechanism.

## Backup and recovery

Backups cover database and optional object storage/configuration needed for restoration. Recovery evidence proves schema version, record counts, critical control totals, event-to-batch reconciliation and application readiness after restore.
""",
)

write(
    "docs/02-architecture/API_ARCHITECTURE.md",
    """# WorkOS API Architecture

## Versioning

New productized contracts are introduced under `/api/v1`. Existing imported routes may remain temporarily behind compatibility adapters while behavior is migrated and tested.

## Contract principles

- Request, query and response schemas are explicit and validated.
- Errors contain stable machine code, user-safe message and correlation ID.
- Lists are paginated and filterable for production-scale use.
- High-risk mutations use optimistic concurrency/version checks.
- Imports, finalization and adapter operations use idempotency keys where applicable.
- Cost and margin fields are absent from broad operational DTOs unless separately authorized.

## Request enforcement

```text
authenticated identity
→ active role
→ effective permission
→ organization/legal-entity boundary
→ entity relationship / row scope
→ business policy and current state
→ command execution and audit
```

Authorization runs before data is returned or mutated. UI state and request-supplied ownership fields are not trusted.

## Commands and queries

Commands change state and must enforce validation, policy, concurrency and audit. Queries return scoped read models optimized for workspaces and reports. Long-running imports, exports, calculations or snapshots return operation/batch status rather than holding an unsafe request open.

## State transitions

Work period, approval, contract, project, commercial snapshot, commercial eligibility event and invoice-ready batch transitions use explicit state machines. Invalid or stale transitions return deterministic conflict errors.

## Commercial calculation endpoints

Commercial calculation APIs accept references to authoritative records, not arbitrary client-calculated amounts. Responses identify calculation version, policy version and snapshot IDs. Non-T&M operational earned-management calculation fails closed when no authorized effective-dated policy applies. Preview endpoints are clearly non-final and cannot be used to bypass approval/finalization.

## Commercial eligibility and invoice-readiness endpoints

- Eligibility commands create or supersede immutable `CommercialEligibilityEvent` versions from approved source records only.
- Source-family schemas cover T&M snapshots, fixed-fee schedules, milestones, retainer events, managed-service events and approved adjustments.
- Event responses expose source family/version, eligible date, currency, amount, evidence references, state and reversal/supersession lineage within the caller's scope.
- Batch-line creation accepts an event-version identifier, not a client-supplied amount, and atomically enforces event-version uniqueness across active/finalized batches.
- Approved-unbilled queries and invoice-ready batch queries reconcile by event version and control total.

## Integration contracts

Inbound adapters map external identifiers to controlled domain records and retain source/idempotency evidence. Outbound finance exports use versioned schemas, exact eligibility-event lineage, control totals and export audit. Export confirmation never mutates the originating event version.

## Observability

Every request receives a correlation ID. Structured logs record safe route, status, duration, user/role identifiers and denial/error code without exposing credentials or unrestricted personal/financial payloads.

## Compatibility and deprecation

Compatibility routes have an owner, migration plan, tests and removal release. Breaking changes require versioned contracts and release notes.
""",
)

replace_once(
    "docs/02-architecture/INTEGRATION_ARCHITECTURE.md",
    "Invoice-ready batches produce versioned export payloads with line traceability, currency, totals, adjustments and control totals. Export success does not automatically claim downstream statutory invoicing unless a configured confirmation is received.",
    "Invoice-ready batches produce versioned export payloads whose lines reference exact `CommercialEligibilityEvent` versions. Payloads include source family/version, currency, eligible date, amount, adjustments and control totals across T&M, fixed-fee schedule, milestone, retainer, managed-service and approved-adjustment sources. Export success does not automatically claim downstream statutory invoicing unless a configured confirmation is received, and it never rewrites the originating event version.",
)

# Architecture overview targeted changes.
arch = "docs/02-architecture/ARCHITECTURE_OVERVIEW.md"
replace_once(
    arch,
    "- T&M, fixed-fee, milestone, retainer and managed-service calculations.\n- Revenue, cost, margin and estimate-at-completion snapshots.",
    "- T&M, fixed-fee, milestone, retainer and managed-service calculations.\n- Billable value, optional operational earned-management value, cost, margin and estimate-at-completion snapshots.\n- Effective-dated earned-management policy profiles that fail closed for non-T&M models until selected.",
)
replace_once(
    arch,
    "- Approved-unbilled sources.\n- Invoice-ready batches and lines.\n- Adjustments, credits and write-offs.\n- No-double-billing controls.\n- Billing/accounting export contracts.",
    "- Versioned commercial eligibility events for all six source families.\n- Approved-unbilled event register.\n- Invoice-ready batches and lines that reference exact event versions.\n- Adjustments, credits, write-offs, reversals and supersessions.\n- Organization/legal-entity-scoped no-double-billing controls.\n- Billing/accounting export contracts.",
)
replace_once(
    arch,
    "- Commercial and margin reporting.\n- Data-quality controls.\n- Revenue-leakage signals.",
    "- Billable value, optional operational earned-management value, cost and margin reporting.\n- Approved-unbilled and invoice-readiness reconciliation.\n- Data-quality controls.\n- Commercial-leakage signals.",
)
replace_once(
    arch,
    "    PROJECT ||--o{ WORK_ENTRY : accepts\n```",
    "    PROJECT ||--o{ WORK_ENTRY : accepts\n    ENGAGEMENT ||--o{ COMMERCIAL_ELIGIBILITY_EVENT : produces\n    COMMERCIAL_ELIGIBILITY_EVENT ||--o{ INVOICE_READY_LINE : supplies_version\n```",
)
replace_once(
    arch,
    "- Revenue, cost and margin outputs.\n- Calculation version and timestamp.\n\nChanging a rate card must not rewrite prior snapshots. Controlled recalculation must create a new version and audit evidence.",
    "- Billable value, optional operational earned-management value, cost and margin outputs.\n- Effective policy version where the optional metric is enabled.\n- Calculation version and timestamp.\n\nChanging a rate card or policy must not rewrite prior snapshots. Controlled recalculation must create a new version and audit evidence.\n\n### 7.3 Commercial eligibility events\n\nEvery invoice-eligible source is normalized into an immutable, versioned `CommercialEligibilityEvent`. Source families are approved T&M snapshot, fixed-fee schedule, accepted milestone, retainer event, managed-service event and approved adjustment. Events record source/version, scope, eligible date, currency, amount, evidence and reversal/supersession lineage. Every invoice-ready line references one exact event version, and the same event version cannot appear in multiple active or finalized batches.",
)
old_flow = """```mermaid
flowchart LR
    Source[Approved Work / Milestone / Retainer Schedule]
    Terms[Contract and Engagement Terms]
    Rate[Resolved Billing Rate]
    Cost[Resolved Cost Rate]
    FX[Currency / Exchange Rate]
    Policy[Rounding / Caps / Exclusions]
    Engine[Commercial Calculation Engine]
    Snapshot[Immutable Calculation Snapshot]
    Reporting[Revenue and Margin Reporting]
    Invoice[Invoice-Ready Line]

    Source --> Engine
    Terms --> Engine
    Rate --> Engine
    Cost --> Engine
    FX --> Engine
    Policy --> Engine
    Engine --> Snapshot
    Snapshot --> Reporting
    Snapshot --> Invoice
```
"""
new_flow = """```mermaid
flowchart LR
    Work[Approved T&M Work]
    Schedule[Fixed-Fee Schedule]
    Milestone[Accepted Milestone]
    Retainer[Approved Retainer Event]
    Service[Accepted Managed-Service Event]
    Adjustment[Approved Adjustment]
    Terms[Contract / Rates / Costs / FX]
    Policy[Versioned Calculation and Rounding Policy]
    Engine[Commercial Calculation Engine]
    Snapshot[Immutable Calculation Snapshot]
    Eligibility[Versioned Commercial Eligibility Event]
    Reporting[Commercial Reporting]
    Register[Approved-Unbilled Register]
    Invoice[Invoice-Ready Line]

    Work --> Engine
    Terms --> Engine
    Policy --> Engine
    Engine --> Snapshot
    Snapshot --> Reporting
    Snapshot --> Eligibility
    Schedule --> Eligibility
    Milestone --> Eligibility
    Retainer --> Eligibility
    Service --> Eligibility
    Adjustment --> Eligibility
    Eligibility --> Register
    Register --> Invoice
```

Operational earned-management outputs are optional management metrics and are never the authority for billing eligibility. Non-T&M metrics fail closed until an authorized effective-dated policy applies. Billing eligibility is represented only by the versioned commercial eligibility event.
"""
replace_once(arch, old_flow, new_flow)

# ---------------------------------------------------------------------------
# Derived specifications
# ---------------------------------------------------------------------------
write(
    "docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md",
    """# Commercial Value, Cost, Margin and Invoice-Readiness Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005, WOS-CORE-008; WOS-COM-001 through WOS-COM-015; WOS-INV-001 through WOS-INV-008; WOS-GOV-001 through WOS-GOV-002.

## Outcome

WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports billable value, optional non-statutory operational earned-management value, cost and margin, and prepares traceable invoice-ready exports.

## Commercial terms

- Effective-dated billing rate cards with dimensions such as client, contract, engagement, project, role, worker, location and grade.
- Deterministic precedence and explicit no-rate/conflict outcomes.
- Confidential effective-dated cost rates and optional burden components.
- Currency precision, configured exchange-rate inputs and rounding by amount type.
- Budgets for hours/units, contract or billable value, optional operational earned-management value, cost and expenses with approved change history.
- POs with committed/consumed/remaining value and thresholds.

## Deterministic calculation and management templates

- **T&M billable value:** approved eligible quantity multiplied by the resolved rate, subject to caps, exclusions, currency and line-level rounding.
- **T&M approved eligible management value:** sum approved eligible T&M source valuations by business/work date after the same authoritative term resolution.
- **Fixed-fee time elapsed:** operational contract value × eligible elapsed service days ÷ total eligible service days. Suspended or policy-excluded days are removed from both eligible-day populations; the result is capped by the configured policy limit.
- **Fixed-fee progress/effort:** operational contract value × approved progress percentage. The configured source is an approved manual percentage or an approved cost-to-cost/effort basis. The normal range is 0–100 percent; controlled exceptions require explicit authority, reason, audit and a configured cap.
- **Milestone acceptance:** approved milestone operational value in the configured acceptance period after acceptance evidence exists.
- **Retainer:** approved base/service-period allocation plus separately approved overage events under the configured rollover and expiry policy.
- **Managed service:** accepted units × configured unit rate and/or an approved fixed period charge.

The optional operational earned-management value is a project-control metric, not statutory accounting income, a statutory accounting-recognition result or ledger output. All non-T&M templates fail closed until an authorized effective-dated policy is selected. Billing eligibility remains independent.

Every selected template defines inputs, source evidence, business/acceptance timing, exclusions, decimal precision, line-level rounding stage and mode, period aggregation, currency/FX, effective dates, policy version, approval owner and append-only reversal/supersession behavior. Finalized outputs are never silently recalculated.

## Snapshot

Each versioned snapshot records source ID/version, quantity/unit, term/rate/cost/FX sources, values, currency, rounding, billable value, optional operational earned-management value, cost/margin outputs, calculation version, policy version where applicable, actor/job and timestamp. Later term changes do not mutate prior finalized versions.

## Commercial eligibility event and invoice readiness

A generic immutable `CommercialEligibilityEvent` represents every invoice-eligible source family:

- Approved T&M calculation snapshot.
- Approved or contractually due fixed-fee billing-schedule event.
- Accepted and billing-eligible milestone.
- Approved retainer base, period or overage event.
- Approved managed-service accepted-unit or period-charge event.
- Approved adjustment, credit, discount, write-off or correction.

Each event records source family and exact source version, organization/legal entity, client/contract/engagement, eligible date, currency, amount, approval/eligibility evidence, optional calculation/policy references, event state/version and reversal/supersession lineage.

Finance users review an approved-unbilled event register and create batches by client, legal entity, engagement, period and currency. Every invoice-ready line references exactly one event version. Transaction-safe uniqueness prevents the same scoped event version from appearing in multiple active or finalized batches. Corrections create reversing or superseding event versions rather than modifying history.

WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, event eligibility, batch preparation and final approval are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Independently specified positive vectors cover rate precedence/effective dates, currency precision, line rounding and residual allocation, T&M caps, every enabled management template, fixed-fee suspension/excluded-day handling, progress-source/cap behavior, milestone acceptance timing, retainer rollover/expiry/overage, mixed managed-service unit and period charges, budget/EAC, all six eligibility-event families, register-to-batch totals and export control totals.

Negative vectors cover disabled/non-effective policy, missing/conflicting rate, expired PO, invalid FX, unauthorized cost/margin read, stale term/policy version, locked period, double billing, duplicate adjustment, invalid reversal, out-of-scope event/batch and failed register-to-batch reconciliation.

Expected values and formulas are independently specified in versioned fixtures; implementation code may not generate its own expected results.

## Recalculation, correction and audit

Controlled recalculation creates a new snapshot version and reason. Credits, write-offs, discounts and corrections create approved eligibility-event versions. Finalization and export preserve source lineage, control totals and evidence.

## Migration and rollback

Commercial tables are additive and feature gated. Migrations prove all six event families, event-version uniqueness, reversal lineage and register-to-batch reconciliation. Before finalization use rollback/disable; after snapshots or events exist, use forward corrections and preserve evidence.
""",
)

write(
    "docs/03-specifications/REPORTING_AND_ANALYTICS_SPEC.md",
    """# Reporting and Analytics Specification

**Governing requirements:** WOS-CORE-003, WOS-CORE-005, WOS-CORE-008; WOS-RPT-001 through WOS-RPT-007; WOS-INT-001 through WOS-INT-006; WOS-GOV-001 through WOS-GOV-005.

## Outcome

Scoped operational and commercial read models explain workforce, utilization, delivery, billable value, optional non-statutory operational earned-management value, cost, margin, approved-unbilled value, invoice readiness, data quality and commercial leakage with control totals and auditable exports.

## Report groups

- Operational dashboard: active workforce, capacity, staffing risk, pending work/approvals and data confidence.
- Planned, actual and forecast utilization with explicit denominators, inclusion rules and as-of date.
- Budget versus actual, contract or billable value, optional operational earned-management value only where an authorized effective-dated policy is active, cost, gross margin, PO consumption, fixed-fee/retainer consumption and EAC.
- Approved-unbilled and invoice-ready reconciliation across exact versioned commercial eligibility events for T&M snapshots, milestones, fixed-fee schedules, retainers, managed services and approved adjustments.
- Data-quality and integration-health reports.

## Commercial-leakage controls

Deterministic signals include missing/late timesheets, unapproved work, approved-unbilled events, date-policy exceptions, missing/conflicting rates, PO risk, fixed-fee effort/cost overrun, retainer expiry/overconsumption, low margin and duplicate/anomalous billing eligibility.

Each signal has entity, severity, reason, owner, suggested action, as-of date and source evidence. Signals do not autonomously change commercial or approval state.

## Read models and reconciliation

Reports query authoritative records, snapshots and commercial eligibility events and publish control totals. Optional operational earned-management metrics identify the effective policy/version and never claim statutory accounting authority. Commercial reports reconcile source evidence to eligibility-event versions, the approved-unbilled register and invoice-ready line/batch totals.

Materialized views/jobs may improve performance but retain refresh time/version and cannot become an untraceable alternative source of truth.

## Scope and exports

Server-side permission and organization/entity scope apply before aggregation and drilldown. Export uses the same scoped query, records filters/as-of/version, output hash/reference and audit event. Cost/margin columns require separate permissions.

## Integration contracts

Versioned worklog-import and finance-export adapters use idempotency, mapping evidence and failure isolation. Finance exports retain exact eligibility-event lineage. Health shows provider mode/readiness, mapping gaps and failures without secrets.

## Acceptance cases

Positive: role-scoped dashboard/drilldown, utilization denominator explanation, policy/version-labelled optional management metrics, six-source register-to-batch reconciliation and audited CSV/API export.

Negative: employee cannot infer another worker/client/cost/margin via totals, filters, exports or error messages; disabled/non-effective policy produces no optional metric; stale read-model totals or missing eligibility-event lineage fail reconciliation; failed adapter delivery does not claim export confirmation.

## Migration and rollback

Imported legacy reports remain compatibility views until control totals and role journeys match. Report changes are versioned; rollback restores the prior read model without rewriting authoritative snapshots or eligibility events.
""",
)

# ---------------------------------------------------------------------------
# Test and delivery controls
# ---------------------------------------------------------------------------
write(
    "docs/04-quality/TEST_STRATEGY.md",
    """# WorkOS Test Strategy

## Purpose

Testing proves product requirements, security boundaries, historical integrity and buyer-operable release behavior. Agent statements and code review are not substitutes for executable evidence.

## Evidence classification

Every check is reported as:

- `PASS` — executed successfully against the declared exact head.
- `FAIL` — executed and did not meet acceptance.
- `SKIP` — intentionally skipped under an approved rule with reason.
- `NOT RUN` — not executed; normally blocks acceptance when applicable.

## Test layers

| Layer | Primary evidence |
|---|---|
| Domain/unit | State machines, policy, capacity, rate precedence, currency/rounding and calculation vectors |
| API/contract | Schema validation, stable errors, pagination, concurrency, eligibility-event contracts and idempotency |
| Authorization | Active role, permission, organization/legal-entity and row/data-scope positive/negative cases |
| Database/migration | Constraints, fresh install, supported upgrades, backfills, event uniqueness, control totals and rollback/roll-forward |
| Integration contract | Mock adapters, mapping, idempotency, retries, failure isolation and sanitized events |
| Browser journeys | Real role workflows and protected deep links on production-like configuration |
| Commercial reconciliation | Snapshot lines, eligibility events, reports, approved-unbilled and invoice-ready control totals |
| Performance | Standard buyer profile, high-risk queries/jobs and reviewed regressions |
| Security | Secret/dependency scans, threat cases, headers/session/input/logging checks and finding disposition |
| Recovery/operations | Build/startup, health, backup/restore, monitoring and deployment rollback |

## Required authorization matrix

For every protected module, test:

1. Authorized active role in scope succeeds.
2. Same user with an assigned but inactive role is denied.
3. Role with permission but wrong organization/legal entity is denied.
4. Correct organization but unrelated entity/worker/client/project is denied.
5. UI hiding and direct API/deep-link behavior agree.
6. Export/report totals do not leak restricted rows or cost/margin values.
7. Delegation does not broaden original authority.

## Migration strategy

Each schema PR supplies:

- Empty-database migration.
- Upgrade from the latest supported release fixture.
- Representative legacy/anomalous data cases.
- Pre/post record counts and control totals.
- Constraint/index verification.
- Repeat/ledger behavior.
- Rollback or roll-forward evidence.

Commercial migrations additionally prove all six `CommercialEligibilityEvent` source families, exact source/event-version lineage, organization/legal-entity-scoped active/final uniqueness, reversals/supersessions and register-to-batch control totals.

## Commercial golden vectors

Expected formulas and values are independently specified in versioned fixtures and are never generated by the implementation under test.

The vector pack covers:

- Rate precedence, effective-date boundaries, decimal precision, multi-currency/FX, caps and exclusions.
- T&M approved eligible value by business/work date.
- Fixed-fee time-elapsed calculations with suspended/excluded days and caps.
- Fixed-fee progress/effort calculations for approved manual percentage and approved cost-to-cost/effort sources, ordinary 0–100 percent limits and controlled exceptions.
- Milestone acceptance timing and reversal.
- Retainer base/service-period allocation, rollover, expiry and approved overage.
- Managed-service accepted-unit value, fixed period charge and mixed-charge cases.
- Non-T&M disabled/non-effective-policy fail-closed behavior.
- Line-level rounding stage/mode, period aggregation and residual allocation.
- Policy and term version changes, append-only correction and supersession.
- Budgets, POs, EAC and snapshot stability after later term changes.
- T&M, fixed-fee schedule, milestone, retainer, managed-service and adjustment eligibility events.
- Event-version uniqueness, reversal/correction and approved-unbilled-to-batch-to-export reconciliation.

Availability fixtures prove that approved leave/holidays reduce the denominator exactly once, never enter the productive/billable numerator and do not require a client engagement or project.

## Browser role journeys

At minimum before v1:

- Organization administrator setup/permissions.
- People operations workforce lifecycle.
- Resource manager planning/assignment.
- Engagement manager project/work approval.
- Commercial manager contracts/rates/budgets.
- Finance analyst snapshot, eligibility-event, approved-unbilled and batch flow.
- Approver delegation/decision/lock behavior.
- Worker self-service and correction.
- Auditor read-only evidence.

## Test data

Use synthetic organization, worker, client and commercial data. Fixtures intentionally include multiple legal entities, currencies, worker types, engagement models, overlapping effective dates, out-of-scope relationships and every eligibility-event source family.

## PR and release expectations

Affected tests run in the implementation PR. The release candidate reruns the full matrix at one exact head and immutable artifact. Flaky or skipped high-risk tests are release blockers until disposition is approved and documented.
""",
)

backlog = "docs/05-delivery/IMPLEMENTATION_BACKLOG.md"
old_pr11 = """### PR-011 — WOS-06 Commercial calculation and project margin engine

**Branch:** `codex/wos-06-commercial-engine`  
**Outcome:** Calculate reconciled billable value, cost, margin and explicitly configured operational earned-management revenue across supported engagement models.

**Includes:**

- Calculation engine/version.
- T&M billable value.
- Fixed-fee effort/cost consumption.
- Milestone eligibility/value.
- Retainer consumption/overage.
- Managed-service quantity foundation.
- Revenue/cost/margin snapshots.
- Effective-dated operational earned-management policy profiles that fail closed for non-T&M models until an authorized policy is selected; billing eligibility remains independent.
- Budget versus actual and estimate at completion.
- PO consumption and thresholds.

**Requirements:** WOS-COM-006 through WOS-COM-013.

**Mandatory evidence:**

- Golden financial test vectors for every engagement type, including policy-disabled and each enabled earned-management profile.
- Evidence that operational earned-management metrics are non-statutory and cannot run for non-T&M models without an authorized effective-dated policy.
- Reconciliation to source work/terms/rates.
- Currency and rounding edge cases.
- Snapshot immutability and controlled recalculation evidence.
- Owner Gate C working-product review.
"""
new_pr11 = """### PR-011 — WOS-06 Commercial calculation and project margin engine

**Branch:** `codex/wos-06-commercial-engine`  
**Outcome:** Calculate reconciled billable value, optional operational earned-management value, cost and margin across supported engagement models without implying statutory accounting authority.

**Includes:**

- Versioned calculation engine and independently specified fixture pack.
- T&M billable and approved-eligible management value by business/work date.
- Fixed-fee time-elapsed template with suspension/excluded-day and cap rules.
- Fixed-fee progress/effort template with approved source, ordinary 0–100 percent bounds and controlled exception rules.
- Milestone acceptance-period template.
- Retainer base/service-period, rollover/expiry and approved-overage template.
- Managed-service accepted-unit and fixed-period-charge template.
- Effective-dated policy profiles that fail closed for non-T&M models until authorized; billing eligibility remains independent.
- Decimal precision, line-level rounding stage/mode, period aggregation and residual allocation.
- Versioned billable-value, optional management-value, cost/margin snapshots and append-only correction/supersession.
- Budget versus actual, estimate at completion and PO consumption/thresholds.

**Requirements:** WOS-COM-006 through WOS-COM-013.

**Mandatory evidence:**

- Independently authored golden vectors for every formula/profile; implementation code cannot generate its own expected values.
- Disabled/non-effective-policy, effective-date-boundary, suspension/exclusion, progress-limit, rounding/residual, acceptance-timing, rollover/expiry, mixed managed-service and correction cases.
- Evidence that the optional management metric is non-statutory and cannot run for non-T&M models without an authorized effective-dated policy.
- Reconciliation to source work, terms, rates, costs, policy versions and control totals.
- Snapshot immutability and append-only controlled recalculation/supersession evidence.
- Owner Gate C working-product review.
"""
replace_once(backlog, old_pr11, new_pr11)
old_pr12 = """### PR-012 — WOS-06 Invoice readiness

**Branch:** `codex/wos-06-invoice-readiness`  
**Outcome:** Convert approved eligible work/commercial events into controlled invoice-ready batches without becoming a statutory invoicing system.

**Includes:**

- Approved-unbilled register covering approved T&M snapshots, accepted billing-eligible milestones, approved/due fixed-fee schedule events, approved retainer base/period/overage events, approved managed-service period/unit events and approved adjustments.
- Invoice-ready batch and line model.
- Adjustments, discounts, credits and write-offs.
- Evidence links and control totals.
- State machine and approval integration.
- No-double-billing constraints.
- Versioned CSV/API-ready export.

**Requirements:** WOS-INV-001 through WOS-INV-008.

**Mandatory evidence:**

- Duplicate inclusion prevention across every eligible source type.
- Register-to-batch reconciliation by source version, approval/eligibility evidence, currency, eligible date and amount.
- Batch state/approval tests.
- Export traceability and audit.
- Reversal/correction test paths.
"""
new_pr12 = """### PR-012 — WOS-06 Invoice readiness

**Branch:** `codex/wos-06-invoice-readiness`  
**Outcome:** Normalize approved eligible evidence into versioned commercial eligibility events and controlled invoice-ready batches without becoming a statutory invoicing system.

**Includes:**

- `CommercialEligibilityEvent` aggregate and API contracts for approved T&M snapshots, accepted billing-eligible milestones, approved/due fixed-fee schedule events, approved retainer base/period/overage events, approved managed-service period/unit events and approved adjustments.
- Immutable source family/version, scope, evidence, eligible date, currency, amount, event version/state and reversal/supersession lineage.
- Approved-unbilled event register.
- Invoice-ready batch and line model referencing exact event versions.
- Adjustments, discounts, credits, write-offs, reversals and corrections.
- Organization/legal-entity-scoped active/final event-version uniqueness.
- Evidence links, state machine, approval integration, control totals and versioned CSV/API-ready export.

**Requirements:** WOS-INV-001 through WOS-INV-008.

**Mandatory evidence:**

- Fresh/upgrade migration and API/contract evidence for all six source families.
- Duplicate inclusion prevention across every eligible event version and concurrent batch attempts.
- Register-to-batch-to-export reconciliation by source/event version, approval/eligibility evidence, currency, eligible date and amount.
- Batch state/approval tests and cost/margin field-scope negative tests.
- Reversal/correction/supersession paths that preserve original evidence.
- Report/export control totals matching authoritative eligibility events.
"""
replace_once(backlog, old_pr12, new_pr12)
replace_once(backlog, "- Revenue-leakage signal engine.", "- Commercial-leakage signal engine.")

playbook = "docs/05-delivery/CODEX_EXECUTION_PLAYBOOK.md"
old_section11 = """## 11. Commercial-engine control

Commercial tasks require a golden-vector pack containing, as applicable:

- T&M standard and partial-period cases.
- Role/worker-specific rate precedence.
- Effective-date boundaries.
- Fixed-fee budget and effort overrun.
- Milestone acceptance and reversal.
- Retainer consumption, expiry and overage.
- PO cap/threshold behavior.
- Currency precision and rounding.
- Negative adjustments/credits.
- Snapshot stability after rate changes.
- Report and invoice-ready reconciliation.

The controller must review calculation formulas and stored evidence, not only UI totals.
"""
new_section11 = """## 11. Commercial-engine control

Commercial tasks may not invent formulas, policy timing or expected values. The task packet and independently authored fixture pack must define the applicable template before implementation.

The golden-vector pack contains, as applicable:

- T&M approved eligible value by business/work date and role/worker rate precedence.
- Effective-date boundaries and disabled/non-effective-policy fail-closed cases.
- Fixed-fee time-elapsed formulas, suspension/excluded-day handling and caps.
- Fixed-fee progress/effort formulas, approved progress source, ordinary 0–100 percent limits and controlled exceptions.
- Milestone acceptance timing and reversal.
- Retainer base/service-period allocation, rollover, expiry and approved overage.
- Managed-service accepted-unit, fixed-period-charge and mixed-charge cases.
- PO cap/threshold behavior.
- Decimal precision, line-level rounding stage/mode, period aggregation and residual allocation.
- Negative adjustments/credits and append-only correction/supersession.
- Snapshot stability after rate or policy changes.
- All six `CommercialEligibilityEvent` source families.
- Event-version uniqueness, reversal lineage and approved-unbilled-to-batch-to-export reconciliation.

PR-011 must use the formulas and expected values supplied by the approved fixture pack. PR-012 must implement and test every eligibility-event source family; a work-entry-only invoice path is incomplete. The controller reviews formulas, source/event lineage, stored evidence and control totals, not only UI totals.
"""
replace_once(playbook, old_section11, new_section11)

# ---------------------------------------------------------------------------
# Status and evidence
# ---------------------------------------------------------------------------
status = "docs/00-control/IMPLEMENTATION_STATUS.md"
replace_once(
    status,
    "| State | Controller review and independent-review gate |\n| Current activity | Full product, architecture, ADR, feature-specification, quality, delivery and repository-governance pack assembled |\n| Application source | Not imported; WOS-01 remains blocked |\n| Acceptance blocker | Documentation checks, fresh independent Codex review and owner Gate B approval |",
    "| State | Corrected blueprint awaiting second exact-head independent review |\n| Current activity | First five P1 and two P2 findings are corrected; controller commercial-policy, eligibility-event and evidence refinements are addressed |\n| Application source | Not imported; WOS-01 remains blocked |\n| Acceptance blocker | Fresh independent Codex/Sol review of the moved head, resolution of any new blocking finding and owner Gate B approval |",
)
replace_once(status, "| v0.7.0 | Not started | Commercial/revenue/margin and invoice-readiness engine |", "| v0.7.0 | Not started | Commercial value, cost/margin and invoice-readiness engine |")
replace_once(
    status,
    "1. Materialize and inspect all findings from independent review `5000738492`.\n2. Run a fresh independent Codex/Sol review against the moved correction head.\n3. Resolve any remaining blocking findings and recheck the exact head.\n4. Present the completed blueprint and unresolved external decisions for Gate B approval.\n5. Merge and tag v0.1.0 only after approval and accepted evidence.\n6. Start WOS-01 issue #3 only after the Gate B record exists.",
    "1. Verify the materialized controller refinement at the live PR head and confirm temporary tooling is absent.\n2. Run a fresh independent Codex/Sol review against that exact moved head.\n3. Resolve any remaining blocking findings and recheck the exact head.\n4. Present the completed blueprint and unresolved external decisions for Gate B approval.\n5. Merge and tag v0.1.0 only after approval and accepted evidence.\n6. Start WOS-01 issue #3 only after the Gate B record exists.",
)

write(
    "docs/evidence/v0.1.0/DOC-WOS-00-002-REVIEW-RESOLUTION.md",
    """# DOC-WOS-00-002 — Independent Review and Controller Refinement Resolution

**Workstream:** WOS-00  
**Issue:** #2  
**Pull request:** #1  
**First reviewed head:** `492715dc8a40de6431365b6e52378d317721f617`  
**Independent review ID:** `5000738492`  
**Status:** Five P1 and two P2 findings corrected; controller residual refinements addressed; second exact-head independent review and Gate B pending

## First-review resolution map

| Finding | Severity | Resolution |
|---|---|---|
| Workforce requirements lacked explicit implementation owners | P1 | Split WOS-WKF ownership across PR-004 and PR-008 with concrete evidence |
| NFR wildcard did not assign all quality families | P1 | Mapped all 11 NFR families to accountable PRs and evidence |
| Approved-unbilled excluded several engagement models | P1 | Defined T&M, milestone, fixed-fee, retainer, managed-service and adjustment source eligibility |
| Neutral operational value policy was undefined | P1 | Defined non-statutory, fail-closed operational earned-management profiles, versioning, rounding and golden vectors |
| Owner-only commercialization defaults leaked into product docs | P1 | Removed licence-vs-sale/pricing defaults and retained only a neutral external legal/commercial gate |
| Forbidden-term allowlist was not reproducible | P2 | Neutralized reference-company literals outside approved provenance/control files |
| Gate A was claimed but undefined | P2 | Removed Gate A as a formal gate; programme initiation is contextual and formal gates remain B, C and D |

## Supplemental controller corrections

- Leave/absence is an availability reference, never productive/billable work, and cannot reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs within PR-002 or only the clean stacked PR-003 state merges.

## Controller commercial refinement

After the first-review corrections, controller inspection required these additional implementation-readiness refinements:

1. Removed residual ambiguous statutory-accounting language and qualified the optional management metric.
2. Defined deterministic templates for T&M, fixed-fee time elapsed, fixed-fee progress/effort, milestone, retainer and managed service, including timing, exclusions, caps, precision, rounding, effective dates, versioning and append-only correction.
3. Added the immutable, versioned `CommercialEligibilityEvent` aggregate covering all six invoice-eligible source families.
4. Required every invoice-ready line to reference one exact event version with scoped active/final uniqueness and reversal/supersession lineage.
5. Distinguished billable value, optional operational earned-management value, cost, margin, approved-unbilled value and invoice readiness in reporting.
6. Strengthened PR-011 and PR-012 task, migration, golden-vector and register-to-batch reconciliation gates.
7. Confirmed temporary materializer workflow/script files are not part of the intended final PR state.

## Evidence posture

The branch documents now state the corrected requirements and control model, but this record does not claim merge readiness. Shell-based documentation checks and a fresh independent Codex/Sol review must run against the final live PR head after materialization.

## Open gates

- Fresh independent Codex/Sol review at the exact moved PR head.
- Resolution of any remaining blocking finding.
- Product-owner Gate B approval.
- Exact-head squash merge and v0.1.0 baseline.
""",
)

controller_evidence = "docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md"
replace_once(
    controller_evidence,
    "These corrections require a fresh independent review at the moved head before Gate B.",
    "Controller follow-up also refined deterministic commercial templates, added the six-source `CommercialEligibilityEvent` model, qualified reporting language and strengthened PR-011/PR-012 evidence. These corrections require a fresh independent review at the final moved head before Gate B.",
)

# Final sanity checks performed by this materializer before the workflow commits.
for required in [
    "CommercialEligibilityEvent",
    "Fixed-fee time elapsed",
    "Fixed-fee progress/effort",
    "approved-unbilled-to-batch-to-export reconciliation",
]:
    if required not in "\n".join(read(p) for p in [
        product,
        "docs/02-architecture/DOMAIN_MODEL.md",
        "docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md",
        backlog,
        playbook,
        "docs/04-quality/TEST_STRATEGY.md",
    ]):
        raise RuntimeError(f"Missing required refinement phrase: {required}")

print("WOS-00 commercial blueprint refinement materialized successfully")
