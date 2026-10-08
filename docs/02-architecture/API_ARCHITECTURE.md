# WorkOS API Architecture

## Versioning

New productized contracts are introduced under `/api/v1`. Existing imported routes may remain temporarily behind compatibility adapters while behavior is migrated and tested.

The WOS-03 API foundation begins with an incremental pilot: identity reads (`/api/auth/me` and `/api/auth/organization-scopes`), organization setup, and scoped audit, import, and integration-event history (`/api/audit-logs`, `/api/import-export-logs`, `/api/integrations/events`, and their `/api/v1/...` aliases) are mounted through shared handlers. A `/api/v1` route must preserve the legacy authorization and business rules while returning the versioned error contract below. New routes should be added under `/api/v1`; legacy routes remain available until an explicit deprecation plan removes them. This pilot does not claim that every existing API route has already been migrated.

## Module boundaries

The server remains a modular monolith. New seams belong under `server/modules/<capability>/` for domain/application behavior and under `server/api/` for transport concerns. A module may depend on shared domain services and injected infrastructure, but should not import the Express application entry point or register routes as a side effect. Route registration stays explicit in `server/index.mjs` or a capability router factory; compatibility prefixes mount the same router/handler so they cannot drift. Transport middleware validates and translates requests, while authorization, organization scope and business rules remain server-owned.

The initial identity-access and audit modules extract reusable seams from the existing application entry point. Further extraction is incremental and tied to a concrete boundary; it does not authorize a broad rewrite or service split.

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

Commands change state and must enforce validation, policy, concurrency and audit. Queries return scoped read models optimized for workspaces and reports. Long-running imports, exports, notifications or snapshots return operation/batch status rather than holding an unsafe request open.

## State transitions

Work period, approval, contract, project, commercial snapshot, billing-eligibility event, approved-unbilled item and invoice-ready batch transitions use explicit state machines. Invalid or stale transitions return deterministic conflict errors.

## Financial endpoints

Financial calculation APIs accept references to authoritative records, not arbitrary client-calculated amounts. Responses identify calculation version and snapshot IDs. Preview endpoints are clearly non-final and cannot be used to bypass approval, billing eligibility or finalization.

A calculation snapshot remains valuation evidence. It cannot be submitted directly as an invoice-ready line.

## Billing eligibility and invoice readiness endpoints

The server exposes distinct commands and queries for:

1. Evaluating an authoritative source version against source-specific approval, contractual-due, acceptance and commercial policy.
2. Creating a versioned `billing_eligibility_event` from exactly one supported source version.
3. Creating or querying the corresponding one-to-one `approved_unbilled_item`.
4. Transactionally acquiring current occupancy and creating exactly one current invoice-ready line/membership for that approved-unbilled-item version.
5. Reviewing, approving, cancelling before export, exporting, confirming billing and creating reversal/superseding correction evidence.

A batch-line command accepts only a server-resolved `approvedUnbilledItemId` and immutable item version plus allowed presentation metadata. It must reject requests that try to supply a raw work-entry ID, calculation-snapshot ID, milestone ID, fixed-fee schedule ID, retainer/managed-service event ID, adjustment ID, client-calculated amount, currency, organization or approval status as the direct batch source.

WorkOS v1 does not split one approved-unbilled-item version across multiple invoice-ready lines. The command inserts the immutable line/membership and the database-unique current-occupancy record for `(approvedUnbilledItemId, approvedUnbilledItemVersion)` in one transaction. A separately billable portion requires its own upstream authorized/versioned eligibility event and approved-unbilled item with reconciled totals.

Every accepted command revalidates:

- Active identity, role, permission and organization/legal-entity scope.
- The approved-unbilled item's current version and eligibility-event lineage.
- Source-specific approval or contractual-due/acceptance evidence.
- Eligible date, currency, amount, calculation/policy and rounding evidence.
- Reversal/supersession state.
- Absence of any existing database current-occupancy record for the same item ID/version, whether in the requested batch or another batch.
- Optimistic concurrency and idempotency key.

The current-occupancy database uniqueness constraint is authoritative under concurrent requests; a pre-check or parent-batch-state query is not sufficient on its own.

### Batch-line idempotency and duplicate behavior

- The first valid request creates one line/membership and acquires one current-occupancy record atomically.
- An identical retry using the same idempotency key and canonical request identity returns the existing line/membership and does not create another record.
- Reusing that key with different input is rejected.
- A different idempotency key or concurrent request for the same approved-unbilled-item version while occupancy exists returns a stable conflict, including when the requested batch is the same batch.
- A compatibility or bulk endpoint cannot bypass this behavior; each selected item independently acquires occupancy or returns its own conflict.

## Invoice-ready batch state contract

Canonical states are `Draft`, `Under Review`, `Approved`, `Exported`, `Billed/Confirmed` and `Cancelled`.

The API and database use these exact occupancy classes:

- **Open/active occupying:** `Draft`, `Under Review`, `Approved`.
- **Final occupying:** `Exported`, `Billed/Confirmed`.
- **Non-occupying terminal:** `Cancelled`, only when cancelled before a successful export or billing confirmation.

Minimum accepted transitions are:

```text
Draft → Under Review | Cancelled
Under Review → Draft | Approved | Cancelled
Approved → Exported | Cancelled
Exported → Billed/Confirmed
```

`Cancelled` and `Billed/Confirmed` are terminal. `Exported` cannot transition to `Cancelled`. Export/billing corrections create versioned reversal or superseding billing-eligibility events, approved-unbilled items and correction batch lines rather than releasing or reusing the original lineage.

A failed export or artifact-generation attempt leaves the batch in `Approved`, keeps its current-occupancy records and register items occupied and records a failed operation. The state becomes `Exported` only through one of these accepted paths:

1. A configured finance provider accepts the exact immutable versioned payload and matching control totals.
2. WorkOS atomically creates and records an immutable versioned CSV export artifact, validates its control totals, and makes that exact artifact available for controlled retrieval.

A CSV acceptance record contains export-operation ID, idempotency key, immutable artifact ID/version, checksum, schema version, line count, control totals, generated timestamp and authorized actor. Repeating the same idempotency key returns the same accepted artifact and operation result; it does not regenerate content or reapply `Approved → Exported`. Corrected content requires versioned reversal/supersession lineage and a new correction batch or export artifact.

An initial delivery/export command is accepted only for an `Approved` batch. `Exported` and `Billed/Confirmed` batches may expose idempotent retrieval/redownload of their already accepted artifact and status confirmation, but they cannot initiate a second downstream delivery or transition to `Exported` again.

A cancellation command is accepted only from `Draft`, `Under Review` or pre-export `Approved`, requires reason and applicable approval authority, and atomically records cancellation plus deletion/release of each current-occupancy record. It returns an item to the available approved-unbilled register only when the underlying eligibility event remains current, unreversed, unsuperseded, in scope and otherwise eligible. Historical line/membership evidence remains immutable. Re-batching creates a new line/membership version and reacquires current occupancy; it never reactivates or rewrites the cancelled line.

`Exported` and `Billed/Confirmed` occupancy is permanent. There is no API command to release it.

The API returns stable conflict codes for:

- Direct-source/snapshot bypass.
- Stale event/register/batch version.
- Current line already exists for the approved-unbilled-item version in the same batch.
- Current occupancy already belongs to another open/active or final batch.
- Concurrent duplicate occupancy acquisition.
- Partial-billing or presentation-splitting attempt using the same approved-unbilled-item version.
- Initial export from any state other than `Approved`.
- Duplicate downstream delivery from `Exported` or `Billed/Confirmed`.
- Cancellation after export or billing confirmation.
- Reversed/superseded source or register item.
- Invalid transition.
- Invalid batch scope/currency.
- Control-total mismatch.
- Idempotency-key reuse with a different line, payload or artifact version.

Invoice-ready lines expose traceability to exactly one approved-unbilled item and through it exactly one billing-eligibility-event version. Raw source evidence may be included as read-only lineage; it is never accepted as an alternative batchable object.

## Integration and notification contracts

Inbound adapters map external identifiers to controlled domain records and retain source/idempotency evidence. Initial outbound finance delivery originates only from an `Approved` batch. Provider acceptance or atomic CSV-artifact acceptance performs the single `Approved → Exported` transition. Final-state endpoints support only idempotent retrieval/redownload and status confirmation of the already accepted artifact.

Notification commands create scoped notification records and delivery attempts separately from the core transaction. Requests resolve recipient scope, template version, preferences, channel eligibility and sanitized payload server-side. Provider retries use idempotency keys and cannot create duplicate in-app, email or collaboration delivery evidence.

## Observability

Every API request receives a correlation ID. A caller-provided `X-Correlation-ID` is accepted only when it matches the bounded safe-character format; otherwise the server generates one. State-changing HTTP methods also receive a server-generated operation ID. Both are returned as response headers and are exposed through CORS for browser clients. These identifiers are tracing aids, not authentication, idempotency or authorization tokens.

Failures served under `/api/v1` use `{ "error": { "code", "message", "correlationId", "operationId?" } }`. Codes are stable uppercase identifiers, messages are user-safe, and unexpected 5xx details are not returned. Legacy paths preserve their existing response shapes during the adapter period. The frontend error type retains HTTP status and available trace IDs for support diagnostics.

Production mutation code uses the shared audit writer. It records actor identity, active role, source, module/action, entity identity, before/after values, reason/details and request correlation/operation IDs when present. System operations may omit request IDs. New audit fields are nullable and added with additive migrations so historical rows are not assigned fabricated context. The existing append-only database guard remains in force.

The employee master CSV apply path also records each successfully applied row's source identifier, server-generated import batch ID and successful processing result on its audit event. The same batch ID keys the import-history result; row audits and batch history commit or roll back together. The nullable batch reference has no foreign key to the operational log so audit retention can outlive import-history retention; both records are written in one transaction.

The client master CSV apply path follows the same successful-row provenance contract. It stores the source-row `id` when supplied, leaves the audit source identifier null when that optional input field is absent, and uses one server-generated batch ID for the row audits and import-history result. The project master CSV apply path stores the required `projectCode` as its source identifier and uses the same batch linkage. The Allocation Control CSV apply path stores its optional source-row `id` when supplied, leaves that audit source identifier null when absent, and uses the same server-generated batch ID for row audits and import history. The timesheet CSV apply path preserves its existing grouping of rows into one timesheet per authorized employee/week and one audit event per persisted group. Its current input contract has no upstream row ID, so the group audit retains a null source identifier and uses the same server-generated batch ID as import history. Successful group audits record `Success`; aggregate Partial/Failed history continues to count source entries. Existing client/project/allocation/timesheet matching and upsert behavior, row errors, partial outcomes, scoped over-allocation checks, reporting-period checks and transaction boundaries remain unchanged. A concurrent project-code conflict is rechecked in the atomic upsert and rejected row-locally if it belongs to another legal entity. Allocation updates cannot use a source row ID to overwrite a record in another organization or legal entity. Raw CSV contents are not stored. Rejected-row source IDs, schema-version/idempotency/dry-run evidence, other import/integration paths, and configurable retention remain open.

Identity-link API create/update operations retain the provider as the audit source, a separate server-generated opaque `provenance_reference` as the history entity/source identifier, `Success` as the processing result, and the request's operation/correlation IDs. Migration `036_wos03_identity_link_provenance_reference.sql` backfills this reference without rewriting identity-link primary keys, external subjects/UPNs, or audit history, then enforces non-null uniqueness, immutability and a random default for new rows. A single identity-link upsert has no import batch. Audit before/after values and integration event payloads record the opaque reference, resulting status and whether the provider identifier/account address changed; they do not duplicate the external subject or UPN. The Entra callback can also upsert the employee's identity link after a legacy identity match; it retains the same opaque reference on its existing login success event and audit entry without changing the login event's user entity key. General history removes legacy row references when the same row shows that a reference duplicates a provider subject/UPN. The raw mapping remains in the existing protected identity-link table and its selected-scope integration endpoint, which preserve the current identity-link contract. Existing Entra login events still store subject/UPN values in their raw audit/event payloads; ordinary scoped history views redact those fields. Because the mapping table upserts in place, the opaque reference does not preserve previous external subjects across identifier changes. Retaining versioned external identifiers or changing login-event storage/retention remains a separate privacy decision and is open.

Audit, import/export history, integration-event history and open Teams action-token aggregates carry nullable organization/legal-entity scope. API writers derive scope only from the resolved server request context; the general history read routes always filter on the exact selected pair, including for Admin. Integration-health counts over employees, links, events and open action tokens use that same pair. Teams action-token execute/send operations require the token's stored pair to match the verified selected pair; legacy null-scope tokens fail closed. Legacy/system history rows without a verified scope remain null, are left unchanged, and are omitted from ordinary scoped history reads; no actor-name or entity-ID backfill is inferred. General audit/integration history DTOs redact Entra/Teams provider subjects, UPNs, provider tenant IDs, external provider user IDs, and bearer action URLs. Unmatched Entra login attempts remain unscoped system events. Provider group-role mappings remain deployment-level configuration; this slice does not add tenant ownership to that configuration.

Structured logs record safe route, status, duration, user/role identifiers and denial/error code without exposing credentials or unrestricted personal/financial payloads.

## Compatibility and deprecation

Compatibility routes have an owner, migration plan, tests and removal release. A compatibility endpoint must not recreate a raw-source-to-batch shortcut, duplicate current line occupancy, split one approved-unbilled item, duplicate final-state export or weaken occupancy state semantics. Breaking changes require versioned contracts and release notes.

## Invoice-batch approval correction contract

The server atomically finalizes an invoice-batch approval and moves the batch to `Approved`; no pending approval may coexist with `Approved`, `Exported`, `Billed/Confirmed` or `Cancelled`. Generic reopen requests for those states, including stale or replayed requests, return a stable conflict and perform no writes. Pre-export correction is a protected cancellation command that verifies authority and version, records reason/audit, releases occupancy atomically, and creates no implicit approval; a replacement batch and approval use current eligible items. Failed export retains `Approved`. Post-export correction uses versioned reversal/supersession and a separately approved correction batch. API, persistence and role navigation expose the same state machine.
