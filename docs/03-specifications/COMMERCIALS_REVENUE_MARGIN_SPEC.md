# Commercials, Revenue, Margin and Invoice-Readiness Specification

**Governing requirements:** WOS-CORE-003 through WOS-CORE-005, WOS-CORE-008; WOS-COM-001 through WOS-COM-015; WOS-INV-001 through WOS-INV-008; WOS-GOV-001 through WOS-GOV-002.

## Outcome

WorkOS deterministically resolves commercial terms, values approved evidence across supported engagement models, preserves snapshots, reports billable value/cost/margin and optional non-statutory operational earned-management revenue, and prepares traceable invoice-ready exports.

## Commercial terms

- Effective-dated billing rate cards with dimensions such as client, contract, engagement, project, role, worker, location and grade.
- Deterministic precedence and explicit no-rate/conflict outcomes.
- Confidential effective-dated cost rates and optional burden components.
- Currency precision, configured exchange-rate inputs and rounding by amount type.
- Budgets for hours/units, revenue, cost and expenses with approved change history.
- POs with committed/consumed/remaining value and thresholds.

## Calculation paths

- T&M: approved eligible quantity × resolved rate, subject to caps/exclusions/rounding.
- Fixed fee: contract/schedule value with consumed effort/cost and an explicitly selected operational earned-management policy; hours are not automatically invoiceable.
- Milestone: accepted/approved milestone value and billing eligibility.
- Retainer: period capacity/value consumption, rollover/expiry and overage.
- Managed service: configured service units/tickets/shifts with optional time/cost evidence.

### Fixed-fee contract schedules

In Commercial Drafting, add installments to a fixed-fee contract or its next version. Enter due dates within the contract term in chronological order. Amounts use contract currency and support four decimal places. A populated schedule must reconcile to the full contract value. An empty schedule represents terms still to be scheduled. Inspect the contract version history to recover earlier due dates and amounts. Contract read and manage permissions govern inspection and revision. Each saved version retains its own schedule in the protected commercial audit history.

Migration 079 adds the installment list to immutable contract versions. Existing versions have an empty schedule. A revision that omits the schedule inherits the earlier version’s installments and must still reconcile to the revised contract value. An explicit empty list clears the schedule on the new version. During an application rollback, retain the column and constraint and suspend contract revisions until the restored API can preserve installment history. Under WOS-COM-007 and WOS-INV-001, migration 080 allows an independent authorized reviewer to approve a due installment against an active fixed-fee engagement with the same adopted terms. Open the version history, inspect the installment register, choose the installment and engagement, and record the reason. The approved-unbilled receipt retains the eligibility date in UTC, contract version, installment position, due date, exact amount, lifecycle and amendment references, and reviewer identity. The financial calendar must allow the approval.

Installment positions identify previously issued charges across versions and engagements. A revised schedule must retain the due date and amount at every issued position before additional positions can be approved. Changes affecting an issued position require reconciliation before further issuance. A matching retry retrieves the original receipt. Withdraw the fixed-fee issuance permission to suspend approvals, retaining events, register membership and audit records. Migration 081 supports fixed-fee reservations in Invoice-ready draft batches under WOS-INV-002 and WOS-INV-003. Select a fixed-fee engagement, eligibility-date period, invoice owner and role. Inspect the draft to find available installments. The server checks the register item, originating event, contract terms, date, amount and tenant scope before reserving each whole item. One active reservation can hold an item. Inspect a retained line for the contract version, due date and original approval reason. Cancelling the draft releases its reservations and preserves the historical line totals.

Both the owner and preparer require fixed-fee access in addition to their invoice permissions. To suspend new reservations, withdraw preparation authority while retaining authorized cancellation access. During rollback preserve the migration, historical lines and occupancy records. Fixed-fee batch approval, export, downstream billing confirmation and earned-management policy adoption remain separate delivery gates.

## Operational earned-management revenue

Operational earned-management revenue is a project-control metric, not statutory accounting recognition. T&M may use the approved-eligible-value profile. For fixed-fee, milestone, retainer and managed-service models the calculation is disabled until an authorized effective-dated profile is selected. Supported profiles include fixed-fee time-elapsed, fixed-fee progress/effort, milestone acceptance, retainer service-period/base/overage and managed-service accepted-unit/period-charge.

Each profile defines source evidence, timing, formula inputs, exclusions, currency/FX, rounding, version, approval owner and correction/recalculation behavior. Billing eligibility is a separate decision and cannot be inferred merely because operational earned-management revenue exists.

## Snapshot

Each versioned snapshot records source, quantity/unit, term/rate/cost/FX sources, values, currency, rounding, outputs, calculation version, actor/job and timestamp. Later term changes do not mutate prior finalized versions.

A calculation snapshot is valuation evidence. It never enters an invoice-ready batch directly and does not become billing authority merely because it contains billable value or operational earned-management revenue.

## Source-specific billing eligibility

The server creates a versioned `billing_eligibility_event` only after one authoritative source version satisfies its source-specific evidence rules:

- **T&M:** an approved eligible T&M calculation snapshot and its underlying approved work evidence.
- **Milestone:** an accepted milestone version and any required client/internal approval evidence.
- **Fixed fee:** an approved or contractually due billing-schedule version; effort or earned-management progress alone is insufficient.
- **Retainer:** an approved base-period, rollover, expiry or overage event version under the applicable contract policy.
- **Managed service:** an approved fixed-period charge or accepted service-unit event version.
- **Adjustment:** an approved commercial adjustment, credit, discount, write-off or correction version.

Every eligibility event records source type and immutable source version, organization/legal entity, client/contract/engagement, approval or contractual-due/acceptance evidence, eligible date, currency, decimal amount, calculation/policy/rounding evidence where applicable, event version/status, and reversal/supersession lineage.

## Approved-unbilled register

The only batchable object is a versioned `approved_unbilled_item`. Exactly one register item is created for one billing-eligibility-event version. The register item retains the complete event lineage and current/historical batch membership state.

A raw work entry, commercial snapshot, milestone, fixed-fee schedule, retainer event, managed-service event or adjustment may be displayed as evidence, but it cannot be selected or submitted directly as an invoice-ready line.

## Invoice readiness

Finance users query the approved-unbilled register and create batches by client, legal entity, engagement, period and currency. Every invoice-ready line references exactly one approved-unbilled-item version and, through it, exactly one billing-eligibility-event version and source version.

WorkOS v1 does not split one approved-unbilled-item version across multiple invoice-ready lines. A separately billable portion must originate upstream as a distinct authorized/versioned eligibility event and approved-unbilled item with reconciled source and control totals.

### Unique current line occupancy

For each approved-unbilled-item ID/version, PostgreSQL permits at most one current occupying invoice-ready line/membership. A database-unique current-occupancy record is acquired in the same transaction as line/membership creation and points to the current line and batch.

The control rejects:

- A duplicate line inserted twice into the same batch.
- The same item version inserted into another open/active or final batch.
- Concurrent duplicate acquisition under different requests.
- Presentation splitting or partial billing that reuses the same item version.

An identical retry with the same idempotency key and canonical request returns the existing line/membership result. Reusing that key with changed input, using a different key while occupancy exists or racing a concurrent request returns a stable conflict.

Historical line/membership records are immutable and remain available for audit and reconciliation. They do not replace the current-occupancy control.

### Canonical batch states and occupancy

The canonical states are `Draft`, `Under Review`, `Approved`, `Exported`, `Billed/Confirmed` and `Cancelled`.

- **Open/active occupying:** `Draft`, `Under Review`, `Approved`.
- **Final occupying:** `Exported`, `Billed/Confirmed`.
- **Non-occupying terminal:** `Cancelled`, only for a batch cancelled before any successful export or downstream billing confirmation.

An approved-unbilled item is excluded from the available register while its database current-occupancy record exists. Database uniqueness, transactional locking and idempotency enforce the exclusion under same-batch, cross-batch and concurrent operations.

Minimum transitions are:

```text
Draft → Under Review | Cancelled
Under Review → Draft | Approved | Cancelled
Approved → Exported | Cancelled
Exported → Billed/Confirmed
```

`Cancelled` and `Billed/Confirmed` are terminal. `Exported` cannot transition to `Cancelled`.

### Export acceptance

An initial export or delivery may originate only from an `Approved` batch. A failed provider delivery or CSV-artifact generation leaves the batch `Approved`, retains current occupancy and records the failed operation.

The single `Approved → Exported` transition occurs only when either:

1. A configured provider accepts the exact immutable versioned payload and matching control totals; or
2. WorkOS atomically creates and records an immutable, versioned CSV artifact, validates matching control totals and makes that exact artifact available for controlled retrieval.

The CSV acceptance record contains export-operation ID, idempotency key, immutable artifact ID/version, checksum, schema version, line count, control totals, generated timestamp, authorized actor and source → event → register → line → batch lineage.

Repeated requests with the same idempotency key return the same accepted artifact or provider-operation result. They must not regenerate content, duplicate downstream delivery or reapply the transition. `Exported` and `Billed/Confirmed` batches may support idempotent retrieval/redownload or downstream-status confirmation of the already accepted artifact, but cannot initiate another delivery or become `Exported` again.

A pre-export cancellation from `Draft`, `Under Review` or `Approved` requires reason, authority and audit. The atomic cancellation preserves historical line/membership evidence and releases the database current-occupancy record. The item returns to the available register only if its eligibility event is still current, unreversed, unsuperseded, in scope and otherwise valid. Re-batching creates a new line/membership version and reacquires occupancy; it never rewrites or reactivates the cancelled line.

After `Exported` or `Billed/Confirmed`, occupancy remains permanent. Corrections use a versioned reversal or superseding eligibility event, corresponding approved-unbilled item and correction batch. The original source/event/register/line/batch/export lineage remains occupied and immutable. Accepted CSV artifacts and provider payload evidence are never overwritten.

Finalization preserves source → event → register → unique current occupancy → line → batch → export control totals and immutable evidence.

WorkOS exports invoice-ready data; it does not issue statutory invoices or post a ledger.

## Authorization and confidentiality

Billing access, cost-rate access, margin access, commercial-term maintenance, eligibility-event creation, batch preparation, cancellation, final approval, initial export, final-artifact retrieval and billing confirmation are distinct permissions. Every query and export is scoped. Sensitive values are excluded from logs and broad DTOs.

## Acceptance and golden vectors

Positive vectors cover:

- Rate precedence/effective dates, currency/rounding and T&M caps.
- Every enabled operational earned-management profile and policy-disabled fail-closed cases.
- T&M, milestone, fixed-fee, retainer, managed-service and adjustment eligibility-event creation.
- One-to-one eligibility-event/register-item creation.
- One approved-unbilled-item version producing exactly one current line/membership.
- Same-key identical retry returning the existing line/membership result.
- Source → event → register → occupancy → line → batch/export control-total reconciliation.
- Valid Draft/Under Review/Approved occupancy and pre-export cancellation/release followed by controlled re-batching through a new line version.
- Idempotent failed-provider retry that remains `Approved` until acceptance.
- Successful CSV acceptance with immutable artifact/version/checksum/schema/line-count/control-total evidence.
- Repeated CSV/provider request with the same idempotency identity returning the same accepted result without duplicate delivery or re-transition.
- `Approved → Exported → Billed/Confirmed` permanent occupancy.
- Idempotent retrieval/redownload or status confirmation from final states without new delivery.
- Versioned reversals/supersessions and valid correction flows after export/confirmation.
- Budget/EAC and finalized batch/export totals.

Negative vectors cover:

- Missing/conflicting rate, expired PO, invalid FX and stale term version.
- Unauthorized cost/margin, eligibility-event, initial-export or final-artifact access.
- Raw source or calculation-snapshot direct-batch bypass.
- Source lacking approval, acceptance or contractual-due evidence.
- Duplicate event/register creation.
- Duplicate item insertion twice into the same batch.
- Duplicate item insertion across two occupying batches.
- Concurrent duplicate current-occupancy acquisition.
- Different-key duplicate request while occupancy exists.
- Idempotency-key reuse with a changed line request.
- Partial-billing or presentation-splitting attempt that reuses one approved-unbilled-item version.
- Initial export request from any state other than `Approved`.
- Duplicate downstream delivery or second `Exported` transition from `Exported` or `Billed/Confirmed`.
- Idempotency-key reuse with different payload/artifact identity.
- CSV artifact missing checksum, schema version, line count, control totals, actor or immutable version.
- Cancellation after Exported or Billed/Confirmed.
- Reversed/superseded/stale register item.
- Locked period, out-of-scope batch, duplicate adjustment, invalid transition and failed control-total reconciliation.

## Recalculation, correction and audit

Controlled recalculation creates a new snapshot version and reason. Credits/write-offs/discounts are approved versioned source records; invoice eligibility then creates their event/register lineage. Occupancy acquisition/release, cancellation, finalization, provider/CSV export acceptance, retrieval, confirmation and correction preserve control totals and evidence.

## Gate C acceptance boundary

The product-owner Gate C review occurs only after PR-010, PR-011 and PR-012 are merged and PR-012 engineering acceptance is independently proven at an exact head. Evidence must prove commercial terms, deterministic calculations, source-specific eligibility, the approved-unbilled register, database-enforced unique current line occupancy, complete batch occupancy/release states, provider and CSV export acceptance, immutable export lineage, correction paths, authorization and reconciliation. PR-011 calculation-engine evidence alone cannot satisfy Gate C, and Gate C cannot substitute for PR-012 engineering acceptance.

## Migration and rollback

Commercial tables are additive and feature gated. Seeded vectors and neutral defaults are synthetic. The invoice-readiness migration creates and validates the database-unique current-occupancy control and detects ambiguous duplicates before enabling line creation. Before export/final occupancy use controlled cancellation/disable where valid; after snapshots, eligibility events, register items, accepted export artifacts, Exported/Billed/Confirmed batches or downstream confirmations exist, use forward corrections and preserve evidence.

## Invoice-batch correction boundary

An approved batch is never returned to review. Before export, protected cancellation releases current occupancy atomically and a replacement/new approval is built only from currently eligible items. Failed export retains approved occupancy and final approval. Exported or billed/confirmed history is immutable; correction is forward-only through reversal/supersession eligibility and a new correction batch and approval. This specialization extends the canonical invoice lifecycle and does not create a competing state machine.

### Retainer contract periods

Each immutable retainer contract version may define up to 120 ordered, non-overlapping service periods within the term. Each period records inclusive dates, positive included hours and a nonnegative base fee in contract currency, each with up to four decimal places. Gaps are allowed. An empty list represents unspecified periods. Operational valuation and billing eligibility require their own approved policy and evidence.

The approved-hours view aggregates positive governed project hours against the contract version retained at submission and the inclusive service period containing the work date. The final approval and approved timesheet must agree. Billable and non-billable hours appear separately within the viewer’s worker scope. These figures represent operational work evidence. Capacity deductions, rollover, earned valuation and billing eligibility require separate policy decisions.

Each contract version can select billable hours or all approved hours for consumption and either expiry or full carry-forward to the next scheduled service period on that version. The final period expires unused capacity. The inclusive end date closes at midnight UTC entering the next day. Gaps preserve carry-forward until the next scheduled period starts. The report recomputes from currently approved evidence and shows balances only for started periods, an explicit policy and entity-wide worker visibility. Capacity in excess of the allowance is reported in hours. Charging it requires separate commercial approval.

A version with a capacity policy may waive overage or select a contract hourly rate effective on the inclusive service-period end date. The latter policy applies only to adopted billing candidates bound to that contract in the contract currency and HOUR unit. A unique highest priority is required. The preview gives the exact unrounded extension of currently approved excess hours, with candidate, adoption, approval and effective dates. An open period can change as work is approved. Later adoptions can change a fresh preview. A retained billing decision must freeze its source and apply an approved monetary rounding rule.

Retainer monetary terms may select half-up, half-even or round-down with zero to four decimal places in contract currency. Round the base fee and excess-hour extension separately and sum the rounded components. A missing rounding policy or unresolved rate leaves the monetary period total unavailable. Only full service periods starting on or after the contract version’s effective date can contribute capacity, carry-forward or a period price. Partial periods require explicit revised coverage. Approved work hours remain visible.

An authorized preparer may inspect current period evidence and retain a statement after its inclusive UTC end date. The statement freezes the applicable terms, capacity and pricing policy, approved entry/submission/decision references, source quantities and rate approval, plus rounded monetary components. Carry-forward statements include contributing prior service periods on that version. Each revision pins its predecessor and reviewed evidence hash. Append-only statement preparation grants no billing eligibility. Independent approval remains required.

A separately authorized, entity-wide reviewer can approve or reject the latest prepared statement once, with a reason, while its current source hash matches. The reviewer and preparer must be distinct accounts with different active worker identities in the selected entity. A changed preparer link invalidates its identity witness even if restored. A reviewer who changed worker links after preparation must review a later preparation or leave the decision to another authorized reviewer. Rejected statements and statements with an obsolete preparer identity can be prepared again with a predecessor reference. A pending statement can also be renewed with a different reason to establish a fresh review window. Concurrent preparation and review serialize before the reviewer reads its version. Review decisions are immutable and audited.

An authorized billing operator may issue a whole closed-period charge from the latest independently approved statement with current evidence. The operator selects a billable retainer engagement covering the period under the adopted terms. Every contributing work entry must belong to that engagement. A prior charge covering any of the same service dates blocks issuance anywhere on the contract. The eligibility event pins the period price, statement, review, contract version, engagement and lifecycle evidence. The open financial period check applies on the UTC issue date.

Retainer drafts use the eligibility date, buyer scope, engagement, currency and contract from the register. Both preparer and owner need current invoice authority and the retainer registration grant. The server reserves a whole current item, checks the retained statement revision and period price, and keeps one active occupancy across batches. A cancelled draft retains its line history and releases the item for a new draft.

A retainer invoice review pins the effective engagement approval policy, line count, exact currency total and ordered register-to-statement evidence. Each stage requires a distinct active worker independent of requester, preparer and owner. A changed worker link invalidates the pending review even if restored. Withdrawal or rejection returns the batch to Draft with its occupied items and retained decision history.

Approved retainer invoice batches use CSV schema workos.invoice-retainer-csv/1. Each row retains the statement ID, item and event versions, encoded billing evidence including the review ID and rounded components, eligible date, batch period, currency and native amount. WorkOS checks the final approval, identity pins, exact total, byte content and SHA-256 before recording acceptance.

Retainer billing confirmation records a scoped manual attestation against the accepted retainer CSV. The receipt pins the artifact ID, version, checksum, currency, total and downstream reference. The transaction preserves occupancy and records audit and notification evidence. An identical request recovers the receipt. Conflicting reuse is rejected.

Retainer full-line reversal reviews pin the requester, owner, preparer and each named stage to their workforce identities at submission. Reviewers must represent distinct active workers independent of those parties. Each decision rechecks the retained generations, actor authority and source scope. The original artifact, billing receipt and occupied item remain available throughout review.

After final independent reversal approval, a full retainer credit takes its currency and signed amount from the retained original line. The credit references the original billing event, item, line, accepted artifact and confirmation. Its own item reservation and correction batch approval precede credit export. An accepted credit artifact retains the original checksum and original line identifier.

Managed-service contract versions retain up to 50 quantity dimensions. Each has a unique uppercase code, a display label and zero to four decimal places. The empty list represents unconfigured terms. Omitting the dimensions from a revision carries them forward. An explicit empty list clears the new version. Service evidence must refer to the applicable contract version and dimension.

A delivered quantity identifies its engagement, service date, adopted version, configured dimension and source reference. References are unique per engagement and dimension. Retrying an identical capture by the same actor and role returns its receipt. Capture has no approval or invoice effect.

Each managed-service receipt may have one immutable acceptance or rejection with a reason. Both parties require distinct active worker identities in the entity. The recorder link must still match its retained generation, and the reviewer link must predate capture. Historical decisions remain visible.

Managed-service unit terms may include an exact non-negative decimal price in contract currency, with up to 14 integer and four fractional digits. The price is optional for each dimension. Omitting the dimension list on revision carries prices forward. Replacing a dimension without its price clears that price on the new version. Configuring a price alone creates no financial snapshot or billing event.

The accepted-unit operational profile applies by UTC service date. An authorized engagement policy owner explicitly selects accepted units or disabled, a prospective effective date, a reason and zero to four output decimal places. Each snapshot multiplies the immutable accepted quantity by its pinned contract-version price in contract currency, with no FX conversion, and rounds once half up. A missing price, effective policy, current review identity or open financial authority prevents creation. Explicitly priced zero is valid. The snapshot pins its receipt, acceptance, contract version and policy. Later changes cannot recalculate it. Historical corrections require a separately governed correction flow. This non-statutory management measure confers no billing eligibility.

A managed-service dimension opts into accepted-unit billing by specifying a pinned price and billing precision (zero through four decimal places). The eligible charge is accepted quantity times contract unit price, rounded once half up to the billing precision. Only positive representable charges on a billable engagement qualify. The decision checks service-date adopted terms, current evidence identities, explicit issuer authority and the issue-date financial period. The event pins the source, acceptance, terms, price, quantity, rounding and lifecycle references. Each acceptance has at most one immutable event and approved-unbilled item. Operational valuation is an independent workflow.

Managed-service drafts select approved-unbilled items by eligibility date. The preparer and owner need their invoice permissions and managed-service billing access. Reservation verifies the accepted unit, retained terms, current source identities and unique occupancy, then records a whole line with source evidence. An authorized cancellation releases occupancy and preserves line history.

Managed-service batch approval pins the exact reserved lines, eligibility events, source evidence and total. Named reviewers require current billing access, active worker identities and independence from the requester, preparer and owner. An approval decision revalidates the retained identities, source evidence and item reservations under the configured policy.

## Exporting approved service units

Use schema `workos.invoice-service-unit-csv/1` for approved managed-service unit batches. Each line identifies its register item, eligibility event and retained service evidence. The verifier reconciles quantity and unit price to the rounded line amount. The downstream confirmation pins the retained artifact digest, currency and total.

A managed-service full-line reversal retains the original eligibility event, register item, export checksum and any downstream confirmation. The approved credit equals the negative of the original line in its currency. Review and issuance require current participant identities and source scope. The correction batch follows its own approval and delivery workflow.

## Fixed-period managed-service terms

A managed-service contract version may retain up to 120 fixed-period charges in date order. Dates must be inclusive, non-overlapping and within the contract term. Each positive amount uses contract currency with up to four decimal places. Gaps are allowed. Omitting the schedule on revision carries it forward. An explicit empty list clears it for that version. Approval, management valuation and billing eligibility require their own decisions.

## Independent fixed-period charge review

A scoped reviewer may approve or reject one closed period on its contract version when the version was adopted and the contract stayed active throughout the period. A lifecycle transition or amendment inside the period requires reconciliation. Reviewer and version author must be distinct accounts and workers with current entity membership and stable links since version creation. The decision retains the effective lifecycle and amendment references, exact amount, currency and reason. Operational valuation and issuance each require separate controls.

## Approved-period valuation

At most one engagement may value a given approved contract-period review. The engagement must cover the whole period under the reviewed terms in contract currency. PostgreSQL checks the retained author and reviewer worker links and the financial reporting period at the period end date. The approved-period profile effective on that date rounds the retained positive charge half up to its configured precision. The immutable snapshot pins the source amount, rounded amount, review, policy, contract version and engagement adoption evidence. Billing eligibility is independent.

## Fixed-period charge eligibility

An authorized finance operator can issue an independently approved period for a billable engagement with matching client, currency, contract and adopted terms throughout that period. The charge uses the exact contractual amount. The issue date must be open for financial activity. A single transaction retains the eligibility event, original decision and dates, contract and engagement lifecycle evidence, register item, operator reason and audit. A second engagement cannot register the same charge.

## Reserve registered service-period charges

Fixed-period drafts use a dedicated source and eligibility-date range. The preparer and owner require invoice and scoped period billing permissions. Each line must reference a whole, unoccupied approved-unbilled item with current approved-period evidence, matching engagement, contract, currency and eligibility date. Cancellation preserves the line and releases its occupancy.

### Fixed-period invoice batch approval

The invoice approval policy applies to the engagement. Its manager and every configured reviewer must share authority over at least one managed-service charge type. Each review request and decision then checks the specific batch source, active participants, independence, item reservations, retained evidence and total. An approval for a fixed-period charge preserves the dates and contract version from the original period decision.

### Fixed-period CSV and manual confirmation

Schema `workos.invoice-service-period-csv/1` links each exported line to its register item, eligibility event and period review. Encoded evidence includes the original contractual amount and currency, period dates, contract version and engagement. The download verifier reconciles these values with the line and batch totals. Manual downstream confirmation records the external reference and checksum of the accepted artifact.

### Managed-service credit authority

Correction review and credit issuance require current permission for the original charge type. Each named reviewer must remain independent of the requester, preparer and owner through their linked worker identities. A fixed-period full-line credit retains the original event, register item, review, export digest, native amount and downstream confirmation where present. The correction batch goes through independent approval before export.

### Supporting effort on a service receipt

A recorder may report their own effort on the service date, up to 24 hours with four decimal places. Omitted effort stays unknown. The receipt retains the hours with the verified recorder and worker identity. In receipt history, the active recorder with capture permission and scoped service reviewers can read the effort. A retry must match the original effort, including whether it was supplied. Approved timesheet hours, service valuation and billing keep their existing independent evidence sources.

### Worker cost on accepted service effort

The source rule `worker-hourly-priority/1` selects a single highest-priority adopted hourly cost for the recorded worker, the service date and the engagement currency. An accepted receipt with recorded effort and current recorder/reviewer identities is required for a new snapshot. The snapshot retains the candidate, adoption, review, rate, priority, effective dates, currency, hours and their exact product. No rounding is applied to this supporting input. Financial statements and period reports can apply their own governed presentation rules. The financial period must permit a new snapshot. A later adoption or rate tie preserves the original cost.

For WOS-COM-010, a service reviewer with utilization reporting and worker scope may compare an accepted receipt with approved timesheet entries. The comparison requires an exact work reference, worker, service date, engagement, immutable version pin and matching submission evidence. A second unrejected receipt with effort for the same reference in this scope makes the result ambiguous. Missing evidence, unverifiable work and more than 100 candidate entries yield no approved total. The comparison is read-only and has no effect on costs, valuation or invoice eligibility.

### Managed-service calendar-month margin (WOS-COM-011)

One engagement, legal entity and calendar month define a reporting period across contract versions. The unit service date and fixed-period charge end date determine the reporting month. An issued full-line credit revises its original delivery month on the next inspection. Registered billable value is distinct from operational earned-management revenue. The latter still requires its own effective policy. Supporting worker costs come from immutable accepted-effort cost records. Approved hours come from the engagement’s approved project timesheets.

A gross margin requires accepted evidence, retained cost for every accepted receipt, no pending receipts, and full reconciliation between recorded effort and approved entries. Report coverage includes unpriced or otherwise unregistered units. With complete coverage, subtract exact retained worker cost from registered billable value. Divide by positive net billable value for the percentage and round half away from zero to two decimal places. With zero or negative net billable value, the percentage is unavailable. With incomplete coverage, show known billable value, retained cost and coverage counts and leave both margin fields empty.

Month retention requires current engagement-wide worker visibility and dedicated financial viewing and recording grants. A preview token binds the submitted command to the inspected sources and amounts. Repeated retention of the same current evidence returns the existing version. Later evidence can produce another immutable version. Each version retains charge and credit IDs, receipt, review and cost IDs, and timesheet entry, submission and decision IDs.

### Fixed-fee installment approval identities

At issuance, the schedule author and approver must be separate active accounts linked to distinct active workers in the selected organization and legal entity. The author’s link must be continuous since the contract version was written. Retain the accounts, workers and link generations against the immutable eligibility event. Recheck that evidence on approval retries, invoice item discovery, reservation and reservation retries. Relinking an account away and back invalidates continuity. The register retains the original amount, event and item when verification fails.

Migration 095 classifies existing approvals using observed worker-link history. It can retain an upgrade receipt when the original contract version and event were recorded under link monitoring and both account links are independently verifiable. Other historical items stay readable and unavailable for new reservations.

### Fixed-fee invoice-batch approval

A fixed-fee invoice batch uses the engagement’s effective named-review policy and eligible-date basis. Policy managers, submitters, preparers, owners and named reviewers need authority over fixed-fee installments in the selected legal entity and the permissions for their respective invoice roles. Every reviewer represents an active worker independent from the requester, preparer, owner and other review stages. Submission pins the policy, line count, lineage, currency and total. Approval and rejection revalidate current worker identities and source reservations, including the author and approver of the underlying installments. Rejection preserves occupancy while returning the batch to Draft. Final approval advances the batch to Approved.

### Fixed-fee installment export and confirmation

Only a currently approved batch with occupied, verified installment lines may produce a fixed-fee artifact. The versioned schema `workos.invoice-fixed-fee-csv/2` carries the original contract version and full installment evidence in encoded text columns, the eligibility event and version, register item and version, batch line, eligible date, currency and amount. The exporter checks the pinned approval, reviewer identities, retained lines and total at commit. The download verifier checks the SHA-256 checksum, row order, schema, installment reference, due date, currency and exact amount against the control total.

Creating and retrieving an artifact require their respective export permissions and current fixed-fee source access. A manual downstream confirmation requires the retained artifact ID, version, checksum, currency, total and the external billing reference. Successful export and confirmation keep each installment occupied.

WOS-INV-004/006/007/008. A full reversal of an exported fixed-fee installment retains the original line, eligibility event, occupancy, artifact and any downstream confirmation. Independent named reviewers must hold current fixed-fee issue authority. Credit issuance creates an equal and opposite eligibility event in the original currency. The correction batch requires separate approval, export and downstream confirmation.

WOS-COM-007 approved effort uses the work date and engagement’s governed project bindings. The report checks the latest submission, final approval decision, retained entry fields and contract references. Unverified approved entries are counted separately and contribute no hours. Employee and utilization-report access apply in the selected legal entity. The report reads work evidence independently of installment issuance and earned-management policy.

Fixed-fee cost uses both billable and non-billable approved hours. Resolve adopted hourly cost candidates for the worker, engagement currency, and work date. Require a unique highest-priority candidate. Multiply hours by the hourly rate in PostgreSQL numeric arithmetic and retain the exact product without intermediate monetary rounding. Migration 099 pins the work entry, submission, final decision, contract version, candidate, adoption, effective dates, rate, priority, amount, actor and operation. Subsequent adoptions affect only uncosted entries. A month with missing or unresolved work displays a partial subtotal.

WOS-COM-007 / WOS-RPT-004. Fixed-fee allocation exposure uses the engagement’s activated contract allocation or its latest effective engagement amendment at the selected date. Sum retained labor costs by work date from inception through that date, using evidence available at report time. Report the contract version, engagement amendment, approved entry count, retained cost count and exact allocation less retained cost. Incomplete coverage suppresses a favorable assessment. An already exceeded allocation remains visible. This labor-cost comparison excludes expenses, future work, earned-management valuation and invoice state.

The labor-cost budget is optional for fixed-fee engagement amendments. Amounts use engagement currency and up to four decimal places. Omitting the field carries forward the last effective amount. Zero is an explicit budget. The amendment retains the before/after terms, effective date, actor, approval reference and reason. An unset budget has no monetary variance. The risk report compares the effective budget with retained labor cost using the same coverage and work-date rules as the engagement allocation.

Fixed-fee engagement amendments may retain a decimal hours budget with their approval reference and effective date. Omitting hours on a subsequent amendment preserves the effective value. Zero is explicit. The effort variance deducts verified approved work through the report date regardless of worker cost adoption. Missing approval evidence suppresses a favorable status, while verified hours alone can establish an overrun.

Fixed-fee hours and labor-cost forecasts are versioned independently for each engagement and work-through date. A scoped operator records assumptions for remaining work. For each measure the server adds the proposed remaining quantity to verified actuals only when evidence coverage is complete. Native decimal arithmetic preserves exact hours and costs without intermediate rounding. Each version records the currency, effective terms, budgets, actuals, assumptions, source fingerprint, actor, operation and estimates. Financial billing and earned-management decisions remain independent.

A finance operator with forecast recording authority may enter expected total engagement revenue at completion in engagement currency. A blank value means unspecified. The operator supplies the assumption and rationale for each version. Recording it has no earned-management or invoice effect.

For each retained fixed-fee forecast, calculate the forecast margin after labor cost from that version’s expected total revenue less estimated labor cost at completion. Show the exact signed currency amount and, for positive revenue, the amount divided by forecast revenue as a percentage rounded half away from zero to two places. Missing revenue or incomplete cost evidence leaves both measures unavailable. The measure excludes other costs and has no billing or earned-management effect.

For each fixed-fee forecast version, calculate separate hours and labor-cost variances as retained estimate at completion minus the budget retained with that version. Use exact signed decimals in hours or engagement currency. Positive values indicate overruns and negative values indicate headroom. A missing input suppresses its own comparison.

### Fixed-fee elapsed-time revenue basis (WOS-COM-011)

The product owner selected the engagement’s approved monetary allocation and approved service dates as the basis for the elapsed-time profile. Each engagement in a multi-engagement contract uses its own allocation and dates. Both must be explicit and belong to the same effective approved engagement terms. Missing allocation, missing dates or an unavailable approval reference makes the valuation unavailable.

A buyer must still authorize and select the effective-dated policy before WorkOS can retain any earned-management valuation. Each retained version must identify the applicable engagement terms, allocation, service dates, currency, rounding policy and policy approval. Changing the engagement terms must preserve earlier versions. Work capture, billing eligibility and invoice readiness retain their independent approval paths.

The elapsed-service-days profile uses inclusive UTC calendar dates. The approved amendment selects half-up rounding and zero to four decimal places. For service day d of D, subtract the rounded cumulative allocation through day d−1 from the rounded cumulative allocation through day d. This assigns rounding residuals deterministically. Only the policy effective on the selected day contributes. Dates before adoption, dates outside the approved term, future days and days on hold are ineligible. Calendar days through the current UTC date may be inspected. The report uses the engagement currency without FX. Changing terms requires another approved amendment and a reviewed policy choice. Corrections append a daily version when the governing evidence changes. Retained history remains available to authorized finance users. The daily amount has no effect on billing, forecasts or statutory accounting.

The elapsed-time period report accepts up to 366 inclusive UTC dates ending on or before today. For each day it compares the latest retained version with the full current approved source report. A changed approval with the same amount still requires reconciliation. Days without a policy or retained record are outside policy. Missing or stale evidence withholds the period total. When all applicable days match, sum their latest retained amounts exactly once in engagement currency. The report is read-only and uses the daily finance scope.

For a selected fixed-fee forecast version, the revenue comparison uses all applicable elapsed service days from policy inception through the forecast date. Count eligible days across effective engagement terms, inclusive service dates, and engagement and parent lifecycle changes. Compare the latest retained version of each service day with its current approved source. Require at least one applicable day and complete reconciliation. Subtract earned revenue from the selected expected total in engagement currency with exact signed decimal arithmetic. An unspecified forecast leaves only the remaining amount unavailable. This live comparison is independent of the immutable forecast report and invoice eligibility.

Fixed-fee margin reads require the opt-in commercial.fixed_fee_margin.view permission in addition to scoped financial access. The actual labor margin subtracts verified labor cost through the selected date from reconciled elapsed-time revenue. Require complete work and cost evidence. For remaining margin, require a forecast version matching the current evidence fingerprint and subtract its remaining cost from remaining revenue. Preserve a signed amount even when remaining revenue is negative. Calculate a percentage only on positive revenue, rounding half away from zero to two decimals. Historical forecast margin remains available from the immutable forecast version.

### Fixed-fee earned-management value from delivery effort

The product owner approved cumulative verified delivery hours divided by the approved engagement effort budget as the progress measure. Include both billable and non-billable delivery hours. Cap progress at 100% before multiplying by the approved engagement allocation. Require a positive effort budget, effective approved terms and explicit policy adoption. Unresolved approval evidence withholds valuation. Calculate in engagement currency with the selected precision. Preserve the source hours, budget, allocation and approval references with each retained version. A progress value is cumulative. Never sum it with earlier cumulative values or elapsed-day earnings for the same work.

An amendment selects one active fixed-fee valuation profile and half-up precision from zero to four decimals. The precision must represent the allocation exactly. WorkOS counts verified engagement delivery entries dated from the approved service start through the selected date, including earlier verified effort within the engagement term when a policy is adopted midterm. The valuation date must fall in the approved service term on or after policy adoption, and both engagement and parent contract must be active. Round once after applying the capped ratio in the engagement currency. Each snapshot pins its amendment, lifecycle approvals, entry IDs, worker IDs, work dates, hours, submission IDs and decision IDs. Source changes create a new version. Billing authority remains independent.
