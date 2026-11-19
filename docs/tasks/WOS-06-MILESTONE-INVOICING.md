# Invoicing accepted milestones

A finance preparer selects an accepted, approved-unbilled milestone for its engagement, currency and eligibility-date period. Each invoice batch has one billing source type. Reservation pins the eligibility event, item version, accepted amount and retained evidence to a line. Competing drafts cannot reserve the same item. Cancelling an eligible draft releases its reservation and retains its cancellation record.

The batch follows its named approval stages. A reviewer can inspect milestone and T&M batches in the same queue. Each decision uses its own transaction and original receipt. Approval pins the lines, source, currency and total. Finance can export an approved milestone batch using the milestone CSV schema and record manual downstream confirmation against the exact artifact version, SHA-256 digest and total. Source changes and stale decisions require a new inspection. Confirmation retains occupancy and the export bytes.

## Permissions and recovery

Milestone invoice operations require the existing permissions for the invoice operation and scoped milestone visibility. The server checks current access on saved policy and artifact receipts and on approval and export inbox entries. An operator can suspend milestone invoicing by withdrawing milestone visibility from the affected finance roles and individual grants. Preserve the ledger, reservations, export bytes and confirmations. Once milestone invoices exist, use a source-aware application for recovery. A full database rollback requires a consistent pre-upgrade backup and reconciliation of subsequent transactions.

Migrations `065n` through `065r` extend source lineage, review, CSV, cancellation, notice handling and confirmation. Existing T&M line values, artifact bytes and occupancy remain intact across upgrade and replay. Contract amendments, governed credits and corrections, provider confirmation and operational earned-management valuation are separate capabilities. Under the [v1 product requirements](../00-control/PRODUCT_REQUIREMENTS.md), statutory invoice issuance belongs to the downstream invoicing system.

## Portfolio billing reconciliation

Finance can reconcile visible T&M and milestone billing across engagements for an inclusive eligibility-date range. The portfolio report shows current register states and source, reservation, export and confirmation control totals by currency. Select the source models and eligibility dates in Billing reconciliation. State and occupancy reflect the read transaction. Combined reports require milestone access. Read the engagement report for item-level evidence and audited CSV export. The portfolio view performs no writes. Revert the application change to roll back.

## Portfolio CSV export

Load the portfolio report, enter the business reason and select **Download audited portfolio CSV**. The server checks current report and export access, including milestone permission for combined or milestone reports. It recomputes the report in one database transaction. A changed report or unresolved control exception requires review. The CSV contains the selected dates, source models, organization and legal entity, timestamp, report token, native-currency totals and register states. An empty report includes its filter metadata. Audit history records the request, actor, reason, filters, report token, byte count and SHA-256. After an uncertain response, check audit history before requesting another export. Revert the application to remove the download while retaining its audit records.
