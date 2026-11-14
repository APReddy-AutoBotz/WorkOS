# PR-008B — Effective-dated work capture rules

## Current integration checkpoint — 2026-11-14

Original PR56 head `09e3b446a1d77b036f2b04a96dfafc4158d66b02` is integrated with corrected PR55 candidate `d9ee670cd64881f6c877b42f494f9d2be9ec8eb0` at integration commit `135646d`. PR55 subsequently passed fresh hosted acceptance and merged; its accepted ancestry is recorded below. Later owner instructions authorize verified integration and eligible merges without production deployment; the development-only restrictions below remain historical context.

Manifest conflicts retain every accepted parent script and patched dependency, adding the policy/grid/service aggregate checks. The lockfile remains the accepted parent's lockfile; fresh installation installed338 packages and audited345 with zero reported vulnerabilities. The earlier Vite/advisory observations below do not describe the current integrated dependency baseline.

The overlapping MyTimesheet changes retain exact decimal entry text, civil dates, separate/off-grid work, capture-policy validation, reload and uncertainty handling alongside PR55's keyed identity/week editor ownership. Read and save callbacks additionally require current ownership; navigation cannot revive an old A-view after A-B-A. The parent's delayed-response regression stays in CI, alongside real work-capture acceptance. Local type/lint/aggregate/scanner/PostgreSQL, browser and build verification passed as recorded below. Independent exact-head review and fresh hosted CI remain required; no merge clearance is claimed.

## Independent integration correction

Frozen candidate `3529d065ec25ee5256265f5c6d3299c8c83f1451` passed hosted CI43625076144. Its security diff review covered all22 source inventory entries and supporting files with no new security findings, but found a P2 correctness merge blocker: a failed scope switch during settings preflight or POST could leave MyTimesheet permanently busy. Neither green CI nor that scan grants merge clearance.

The correction separates current-editor busy cleanup from stale-result publication. An abandoned operation invalidates earlier replacement reads, clears assurance and requires explicit reload after settlement before editing resumes. The new browser regression reproduced the disabled Reload timeout before the fix and passed after it, covering held POST and settings-preflight failures with unchanged scope/token. The first browser attempt was denied loopback listening by the sandbox; the authorized retry reached the regression. Two legacy Windows-encoded punctuation bytes in the same component were normalized to UTF-8. Correction validation passed: fresh lockfile installation (338 installed, 345 audited, zero vulnerabilities), type checking, lint, full aggregate, scanner357 plus adversarial fixtures, production build26.36 seconds, expanded ownership browser (replacement reads both before and after settlement), real React/API/PostgreSQL capture journey and fresh/044-upgrade/replay API suite. Independent source/test review approved the correction; final committed-head verification and fresh hosted CI remain required. Accepted documentation-only main `fa85631cc2bd488cc6bb7671bce04b1e6caf68c7` was integrated without changing runtime source.

## Bounded development continuation

Integration validation passed type checking, lint, full aggregate, bootstrap scan (357 files) plus adversarial fixtures, real PostgreSQL/API fresh/044-upgrade/replay and policy/precision/history/period tests, and production build (17.19 seconds). Accepted PR55 merged at `103b08a356e0c76ef69ff3e004a8d80b26fcb032`; its ancestry was integrated at `75788adaa570701af1d072a5077b1fd52cd36514` without source changes.

The first retained ownership browser run failed waiting for the expected assurance. Its synthetic fixture still converted local Friday midnight with `toISOString`, conflicting with this package's deliberate civil-date correction. An actual browser check in Asia/Calcutta showed ISO date2026-11-12 versus civil date2026-11-13 for the same local Friday. The fixture now constructs its calendar date from local year/month/day; all ownership assertions remain unchanged. The corrected timing suite passed every held-read/save, navigation and identity vector. The real React/API/PostgreSQL capture journey also passed quarter-hours, distinct/off-grid preservation, billability/comments, repeated clicks, outage recovery, validation/conflict/uncertain append recovery and scope invalidation. The failed first attempt remains recorded. Independent review and fresh hosted exact-head CI remain pending.

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
