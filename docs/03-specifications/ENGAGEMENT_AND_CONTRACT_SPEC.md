# Engagement and Contract Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005; WOS-CLI-001 through WOS-CLI-002; WOS-CTR-001 through WOS-CTR-003; WOS-ENG-001 through WOS-ENG-005.

## Outcome

Buyers model client and internal delivery through controlled contracts, engagements, projects/workstreams, POs and milestones across multiple commercial models.

## Domain model

- Client and optional parent/billing hierarchy.
- Contract/SOW owned by client and buyer legal entity.
- Purchase orders with value, currency, dates, status and thresholds.
- Engagement with commercial model, owner, dates, currency, budget and contract.
- Projects/workstreams and milestones under engagement.
- Internal/pre-sales engagement with business-unit/cost-centre ownership and non-billable policy.

## Supported engagement models

Time and materials, fixed fee, milestone, retainer, managed service, internal initiative and pre-sales/non-billable initiative. Shared entities do not assume approved hours are directly invoiceable.

## Lifecycle and versioning

Contracts and material terms use versions/effective dates. Engagement/project status transitions validate dates and dependencies. Closing checks assignments, draft/submitted work, approvals, approved-unbilled lines, milestones, POs, balances and ownership.

## Authorization and confidentiality

Client/engagement access is scoped by organization, legal entity and configured ownership/assignment relationships. Contract value, billing terms and POs require commercial permissions; cost/margin remains separately protected.

## API and audit

Commands use optimistic concurrency for high-risk terms. Audit captures before/after, effective date, reason and approval reference. Documents are metadata/controlled links in v1 unless object storage is enabled.

## Acceptance cases

Positive:

- Create a T&M engagement with contract, PO and two projects.
- Create fixed-fee/milestone and retainer engagements without converting every approved hour to an invoice line.
- Create internal and pre-sales engagements with non-billable cost attribution.

Negative:

- Cross-organization/client access is denied.
- Assignment/work dates outside active engagement terms are blocked unless policy exception is approved.
- A contract/project with open work or approved-unbilled value cannot be silently closed/deleted.
- Editing future terms does not change historical approved work/commercial snapshots.

## Migration and rollback

Existing clients/projects migrate to neutral default engagements with preserved IDs/mappings where practical. The migration reconciles counts and dates. Rollback retains compatibility views until migrated records are proven; destructive removal waits for a later release.