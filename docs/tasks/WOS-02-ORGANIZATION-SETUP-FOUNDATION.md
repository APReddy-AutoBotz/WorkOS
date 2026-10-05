# WOS-02 — Organization, Legal Entity, Terminology and Guided Setup

## Authority

- **Workstream:** WOS-02
- **Issue:** #4
- **Target branch:** `codex/wos-02-organization-setup-foundation`
- **Controller continuation lane:** `product-implementation`
- **Base:** accepted WOS-01A `main@3070c80a71640fa4275477d0d2f1538cc8d2a819`
- **Lifecycle:** Draft product implementation only until exact-head acceptance and independent confirmation are clean.

WOS-01A is merged and the WOS-02 dependency is satisfied. This task authorizes implementation inside `APReddy-AutoBotz/WorkOS` only. It does not authorize deployment, hosted-infrastructure mutation, real credentials/providers/customer data, another repository, WOS-03+, or merge without a later controller lifecycle gate.

## Outcome

Make WorkOS reusable across buyers by introducing server-authoritative organization and legal-entity ownership, configurable organizational structures and terminology, working calendars/reporting periods, worker-master ownership/lifecycle foundations, and a guided setup/readiness experience derived from persisted server state.

## Required scope

Implement the WOS-02 acceptance surface from issue #4 as one coherent product package:

1. Organization and legal-entity schema with safe ownership boundaries.
2. Configurable business units, departments, cost centres, practices, locations and regions.
3. Upgrade/backfill of all imported WOS-01A records to a deterministic default organization/legal-entity context without data loss.
4. Organization-scoped identifiers, uniqueness constraints, foreign keys, query scope and authorization boundaries.
5. Working-calendar and reporting-period foundations with effective dating/history.
6. Central terminology configuration applied to covered navigation, forms, reports and notifications without creating a full translation system.
7. Guided setup/readiness calculated from authoritative server state, not caller-supplied completion flags.
8. Worker master organization ownership, configurable worker type and dependency-aware status/lifecycle controls.
9. Preservation of imported worker identity, reporting relationships and required status history.
10. Worker exit/disable impact analysis for active assignments, approvals, work items and ownership dependencies; unsafe transitions fail closed.
11. Effective-dated organization, worker and calendar history with deterministic historical resolution.
12. Dependency-safe retirement/deactivation for organizational/workforce catalogue records.
13. Fresh-install and supported-upgrade migration tests.
14. Cross-organization and cross-legal-entity negative authorization tests.

## Governing requirements

- WOS-CORE-001, WOS-CORE-002, WOS-CORE-004, WOS-CORE-006
- WOS-ORG-001 through WOS-ORG-010
- WOS-IAM-005
- WOS-WKF-001, WOS-WKF-002, WOS-WKF-006
- Applicable WOS-NFR-PRV, DAT, UX, CMP and RELSE requirements

## Explicit exclusions

- Shared multi-tenant SaaS control plane.
- Full localization/translation system.
- Skills, effective capacity, leave-adjusted availability and worker self-service implementation owned by WOS-04 / PR-008.
- WOS-03+ platform/commercial/reporting expansion except minimal compatibility changes strictly required by WOS-02.
- Buyer-specific production credentials or customer data.
- Deployment, tag/release, hosted infrastructure mutation or real provider calls.

## Implementation principles

1. Preserve existing WOS-01A production fail-closed identity/session/authorization behaviour.
2. Server-side organization/legal-entity scope is authoritative; do not trust caller-supplied organization identifiers without validating active-role/data-scope authority.
3. Every schema change must have ordered fresh-install and upgrade/replay evidence.
4. Backfill must be deterministic, transactional where required and idempotent/replay-safe.
5. Existing records must remain readable and their identity/history must not be silently rewritten or lost.
6. Effective-dated records must prevent ambiguous overlapping current versions and must resolve prior versions correctly after later changes.
7. Retirement/deactivation must detect dependencies and produce stable no-write conflicts where removal would orphan active records.
8. Setup readiness must be derived from persisted facts and cannot be advanced by a client-side flag.
9. Keep finite bounds on hierarchy traversal, bulk updates, history resolution and dependency discovery.
10. Never weaken retained WOS-01A tests or authorization contracts to obtain green results; inspect and classify real failures first.

## Mandatory adversarial closure matrix

Before reporting construction complete, run an internal P0/P1/P2 pass across:

A. **Canonical application path:** current app/startup/browser paths remain valid with the new organization/setup model.
B. **Identity/authorization/row scope:** active identity, active role, organization and legal-entity scope are server-authoritative; cross-org/legal-entity access is denied; production has no fallback.
C. **Concurrency/migrations:** concurrent create/update/backfill/retire/worker-transition operations preserve uniqueness, history and transaction boundaries.
D. **Replay/idempotency:** migration/backfill/setup mutations and retried lifecycle operations are replay-safe; same-key retries do not duplicate versions or relationships.
E. **Lifecycle transitions:** organization, catalogue, worker, calendar and reporting-period transitions are explicit, dependency-aware and historically stable.
F. **Partial failure:** multi-record setup/backfill/lifecycle operations fail closed without partial authoritative state where atomicity is required.
G. **Finite bounds:** hierarchy/history/dependency resolution and list/query surfaces remain bounded and paginated/limited as appropriate.
H. **Fallback hierarchy:** local/test-only defaults are explicit; production organization/identity/configuration absence fails closed rather than silently inventing scope.
I. **Retained evidence:** WOS-00/WOS-01A provenance, migrations, security, runtime and browser acceptance remain intact and WOS-02 evidence is exact-head reproducible.

## Required checks

Classify every check as PASS / FAIL / SKIP / NOT RUN and retain exact commands/evidence:

- Locked install and dependency integrity.
- Typecheck and lint.
- Production/default and configured builds.
- Existing retained unit/integration/browser tests.
- Fresh PostgreSQL migration ledger.
- Upgrade from accepted WOS-01A schema/data fixture.
- Migration replay/idempotency.
- Default-organization/legal-entity backfill reconciliation with no lost records.
- Organization-scoped uniqueness/foreign-key tests.
- Cross-org/legal-entity positive and negative API tests.
- Effective-dated organization/worker/calendar historical resolution tests.
- Dependency-safe organization/catalogue retirement tests.
- Worker disable/exit dependency tests including no-write conflict cases.
- Guided setup readiness server-state tests including caller-spoof negatives.
- Terminology configuration coverage tests for the surfaces changed in this package.
- Production startup/security/fail-closed regressions.
- Real browser role/scope journeys where safely runnable.
- `git diff --check`, generated-artifact hygiene and exact changed-file inventory.

## Completion boundary

Construction is complete only when the implementation is published on this existing branch, the exact GitHub head is reported, all mandatory checks are honestly classified, and the internal A–I pass has no unresolved current P0/P1/P2. Keep the product PR Draft after construction. Do not mark Ready or merge until the controller separately completes exact-head acceptance and independent confirmation.
