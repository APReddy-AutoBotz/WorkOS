# Invoicing accepted milestones

A finance preparer selects an accepted, approved-unbilled milestone for its engagement, currency and eligibility-date period. Each invoice batch has one billing source type. Reservation pins the eligibility event, item version, accepted amount and retained evidence to a line. Competing drafts cannot reserve the same item. Cancelling an eligible draft releases its reservation and retains its cancellation record.

The batch follows its named approval stages. A reviewer can inspect milestone and T&M batches in the same queue. Each decision uses its own transaction and original receipt. Approval pins the lines, source, currency and total. Finance can export an approved milestone batch using the milestone CSV schema and record manual downstream confirmation against the exact artifact version, SHA-256 digest and total. Source changes and stale decisions require a new inspection. Confirmation retains occupancy and the export bytes.

## Permissions and recovery

Milestone invoice operations require the existing permissions for the invoice operation and scoped milestone visibility. The server checks current access on saved policy and artifact receipts and on approval and export inbox entries. An operator can suspend milestone invoicing by withdrawing milestone visibility from the affected finance roles and individual grants. Preserve the ledger, reservations, export bytes and confirmations. Once milestone invoices exist, use a source-aware application for recovery. A full database rollback requires a consistent pre-upgrade backup and reconciliation of subsequent transactions.

Migrations `065n` through `065r` extend source lineage, review, CSV, cancellation, notice handling and confirmation. Existing T&M line values, artifact bytes and occupancy remain intact across upgrade and replay. Contract amendments, credit notes, invoice issuance, provider confirmation and operational earned-management valuation are separate capabilities.
