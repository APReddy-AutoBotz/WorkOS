# WorkOS Domain Model

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
    CALCULATION_SNAPSHOT ||--o{ BILLING_ELIGIBILITY_EVENT : supports_TandM
    MILESTONE ||--o{ BILLING_ELIGIBILITY_EVENT : accepts
    ENGAGEMENT ||--o{ BILLING_ELIGIBILITY_EVENT : schedules
    APPROVED_ADJUSTMENT ||--|| BILLING_ELIGIBILITY_EVENT : authorizes
    BILLING_ELIGIBILITY_EVENT ||--o| APPROVED_UNBILLED_ITEM : registers
    APPROVED_UNBILLED_ITEM ||--o{ INVOICE_READY_LINE : supplies
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
- Versioned billing-eligibility event and approved-unbilled register.
- Invoice-ready batch.
- Audit and integration operation records.

## Identity and ownership

Primary commercial roots carry `organization_id`. Contracting/reporting entities carry `legal_entity_id` where applicable. Child scope is derived through validated relationships; clients cannot self-select another organization through request data.

Business identifiers are organization/legal-entity scoped according to domain need, for example worker code within organization and contract number within legal entity.

## Effective-dated entities

Capacity profiles, assignments, contracts, POs, rate cards, cost rates, calendars, exchange rates and historically relevant policies use explicit effective dates. Overlap rules are enforced where ambiguity would produce unsafe authorization or calculation.

## Commercial valuation and billing eligibility

A calculation snapshot is valuation evidence; it is not billing authority. A versioned `BILLING_ELIGIBILITY_EVENT` is the only source permitted to enter the approved-unbilled register. The event records its source type and source version, approval or contractual-due evidence, eligible date, currency, amount, organization/legal entity, reversal or supersession relationship, and audit identity.

Supported event sources are:

- An approved eligible T&M calculation snapshot.
- An accepted milestone version.
- A fixed-fee schedule or other approved contractual eligibility event.
- A retainer base-period, rollover, expiry or approved overage event.
- A managed-service accepted-unit or approved fixed-period charge event.
- An approved commercial adjustment.

Each approved-unbilled item references exactly one eligibility-event version. Every invoice-ready line traces through that register item to the same event version. An event version cannot be included in more than one active or finalized invoice-ready batch; corrections use explicit reversal or superseding event versions rather than rewriting prior evidence. Operational earned-management snapshots remain separate and never create billing eligibility by themselves.

## Historical truth

Approved work history, approval decisions, calculation snapshots, billing-eligibility events, approved-unbilled records and finalized batch lines are not rewritten by later master-data changes. Corrections produce new versions, reversals or superseding evidence.

## Lifecycle guardrails

Closing or retiring a worker, client, contract, engagement or project checks dependent assignments, work, approvals, unbilled value, ownership and commercial balances. Destructive deletes are avoided for production records.

## Boundary rules

- Work evidence is separate from approval.
- Approval is separate from commercial valuation.
- Commercial valuation is separate from billing eligibility.
- Billing eligibility is separate from approved-unbilled registration and invoice-ready batching.
- Invoice readiness is separate from statutory invoicing/ledger posting.
- Cost-rate confidentiality is separate from ordinary project visibility.
