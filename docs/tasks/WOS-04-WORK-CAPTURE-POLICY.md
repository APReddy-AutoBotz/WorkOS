# PR-008B — Effective-dated work capture rules

## Bounded development continuation

Continue the owner's approved product development after Draft PR55 head `18d32e869e2b19530a3bba2b416b11c565ea0a5c`, tree `7117471d9ae30f4f4942459b6e58e68ea8a5b7a2`, passed all configured exact-head engineering gates. This changes development sequencing only. Formal prerequisite, programme, product-owner, review, UAT and release acceptance remain separate. Keep the new dependent PR Draft, unmerged and undeployed; do not mark Ready.

The prepared source is reconciled onto that exact content, including its immutable-import fixture correction and minimal Vite patch. The original source snapshot remains preserved. No competing writer or active hosted run was present before continuation. This is the next bounded slice of PR-008, not completion of PR-008 or WorkOS v1.

## Requirements and outcome

Address bounded WOS-CORE-003–005, WOS-TIM-005, WOS-TIM-008/009/011/012 and UX-001/005 portions:

- Append scoped, immutable `work-capture-rules/1` policy versions for minimum increment, optional daily/Weekly maximums and required positive-entry comments.
- Activate prospectively at configured authoritative Weekly reporting-period starts, with expected-latest conflict checks. Never infer or install a default policy or backfill historical work.
- Apply exact decimal rules to manual and legacy/v1 import paths. Accept compatible numeric values and exact decimal strings; CSV strings remain text until decimal validation rather than passing through binary Number coercion. Typed grid text and untouched server decimal values are retained separately from numeric display previews, including positive quantities that underflow a Number preview. JavaScript-number-only clients can express only their serialized numeric precision.
- Calculate limits over all stored worker work in the authoritative Weekly period, across every header and state. Replacement excludes its prior content once; import preview stages earlier prospective replacements and apply reads its transaction's corresponding state.
- Preserve assignment/worker/parent/period authority, non-billability and `assignment-work-date/1` evidence. Capture references are separate nullable evidence, never a replacement assignment-policy version or commercial/billing authority.
- Protect OLD and NEW content dates, including last-entry deletion and header cascades, under explicit effective policy. Decision-only updates retain their existing submission and period-decision rules rather than being revalidated against a later policy.
- Expose a scoped settings editor and preserve distinct entries, comments, billability, weekends, off-grid dates and zero entries through the existing five-day compatibility grid. Civil dates remain local calendar dates; invalid typed quantities cannot crash rendering or be saved.

## Server and database boundary

Migration045 is additive: immutable policy ledger, capture-reference column and index, prospective append and Weekly-boundary guards, sorted scope/worker locks, and deferred entry/header aggregate checks. No default grants, real identities, credentials or existing work changes are introduced.

The server is authoritative. Required comments use the same whitespace definition in SQL and JavaScript. Direct SQL content writers are subject to old/new period and aggregate guards; ordinary API writers take shared scope locks before worker/row access. Arbitrary raw SQL can still acquire row locks before trigger scope locks, so a database deadlock abort is a failed transaction, not permission to retry blindly or evidence of corruption. New and old work remain intact on rejection.

The policy API is `/api/v1/work-capture-policy`, under existing `settings.manage` and resolved organization/legal-entity scope. Writes append, not update or delete. Audit records actor, active role, source, scope, before/after, correlation and operation IDs. Reporting-period boundary edits cannot silently move installed policy authority.

## Frontend behavior

The editor uses captured token/scope requests and ownership checks; stale outcomes cannot clear a replacement session or publish another scope's success. Repeat saves are blocked until reload. Validation errors retain the draft; conflict or uncertain results require reload, never automatic resubmission. No activation date is invented when a future Weekly boundary is absent.

The existing work grid is not a new daily-entry or category system. It renders separate retained contexts and visibly preserves entries it cannot edit. Reload explicitly refreshes cached backend detection so a transient outage can recover. Existing server controls continue to govern saves and submissions.

## Required evidence

- `test:work-capture-policy`: exact decimals, effective resolution, increments/comments, all-header aggregates, replacement and staged-preview vectors, old-period rejection and neutral behavior.
- `test:work-capture-grid`: distinct/off-grid/weekend/zero preservation, invalid quantities, civil dates and quarter-hour normalizers.
- `test:work-capture-service`: production transport allowlist, scope/token ownership, stale-401 isolation, health recovery and validation/conflict errors.
- `test:work-capture-postgres`: fresh/044 upgrade/replay preservation, no default grants/policy, actual scoped HTTP/manual/import parity, immutable append/race, direct SQL comment/period/aggregate guards, old-date deletion/cascade/reparent negatives and retained evidence.
- `test:work-capture-journey`: actual React/API/PostgreSQL save/reload, quarter-hours and distinct/off-grid/comments/billability preservation, invalid-input rejection, repeated clicks, policy append/reload and in-flight scope invalidation.
- All existing aggregate tests, fourteen retained synthetic browser suites and real PostgreSQL/browser journeys, migration fresh/upgrade/concurrency tests, production identity/build/startup, dependency/secret and container gates remain required.

Local socket restrictions are not bypassed. Source review and unit checks are not PostgreSQL/browser acceptance. Missing required hosted services fail rather than skip. Record failed attempts and exact-head results in the Draft PR and execution receipts. Additional mocked timing vectors must not be described as real database acceptance.

## Rollback and operations

Keep migration045, its immutable ledger and retained capture references. Do not delete policies or evidence to roll back; use a forward-compatible binary that honors both capture and assignment protections. After an uncertain append, reload latest history before any new decision. A duplicate/stale append returns conflict; never manufacture a new expected-latest value or backdate a policy. Resolve invalid quantities/comments in editable work; do not bypass a closed period.

## Deliberate follow-ons

Full configurable categories and nonclient contexts, evidence links/task references, full daily/weekly modes, overtime exceptions, submission deadlines/grace, protected reopen/corrections, capacity/skills/demand and finance/report redesign remain later slices. Existing categories are preserved, not newly governed. No billing eligibility, financial calculation, default/live grant, credentials, customer data, new integration, deployment, Ready or merge is included. The excluded reference repository and separately denied application audit/security repair remain untouched. General blocked runbook changes are not part of this task.
