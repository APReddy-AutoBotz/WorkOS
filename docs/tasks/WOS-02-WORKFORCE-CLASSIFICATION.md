# Explicit catalog-to-workforce classification

## Authority and established contracts

WOS-WKF-001 requires organization structure/location in workforce master; WOS-ORG-003 supplies six configurable catalog families. WOS-CORE-004/005 require historical stability/audit. WOS-IAM-003/005/010 and WKF008 retain active-role employee scope. RESOURCE_PLANNING_SPEC.md sections Workforce and capacity/Lifecycle and history require preserved historical results; ORGANIZATION_AND_SETUP_SPEC.md requires organization-owned verified IDs, resolvable configuration and dependency-safe retirement.

The existing employee POST in server/index.mjs writes mutable department/region/business_unit text. Employee imports use the same legacy shape. WorkforceDirectory reads that current text. Neither writer defines a historical string-to-catalog conversion or an automatic worker-capacity group projection. EmployeeForm already edits reporting managers; this change adds no duplicate manager editor. New catalog versions create new native IDs and close earlier intervals; exact consumers are never rebound by code.

## Supported implementation boundary

Add an empty append-only, prospective workforce classification ledger for existing scoped workers. An explicit complete six-family selection (each exact owned active source or explicit null) is independently recorded with current/future UTC date, latest-event CAS, worker observation token, source observation tokens and reason. Later versions must have strictly later effective dates; same-date correction, future cancellation, legacy/shared adoption and identity reassignment are not inferred. Read current/as-of classification plus original history in the existing directory's selected-worker handoff. Current selection shows retained source snapshots and whether those exact IDs remain available for that date. A future catalog version may expire an exact reference; it never substitutes the later ID or rewrites earlier classification.

Legacy text remains explicitly labeled recorded legacy profile. Omitted classification in existing employee/manual/import commands does not clear or mutate the ledger. Explicit null clears only the new classification field in a new dated version. No legacy string matching or automatic capacity/calendar, manager, permission, recipient, commercial or financial projection occurs. Existing employees.view/manage permissions and existing worker relationship scope apply independently; catalog options expose only owned effective minimal catalog fields after worker authorization. No new permissions, grants, defaults or scheduler.

## Acceptance before publication

- Real React → API → PostgreSQL: directory worker selection, all six explicit choices, save/reload/read and later explicit clear; current versus planned/as-of distinction and paged retained history.
- Exact owned type-matched source selection, unavailable foreign/shared/retired/expired/wrong-family sources, worker/source CAS, held-role/permission/scope refusal, literal Unicode IDs, no trust in request ownership.
- Current UTC/strictly increasing dates; pending future versions do not become current early. Expired native IDs are unavailable, never rebound; earlier snapshots/audits remain byte-equivalent.
- Atomic event/reference/audit transaction, SQL bypass/immutability refusal, concurrent identical replay and competing CAS, original actor/role GET reconciliation and changed-key refusal. Lost responses stop writes; actor/token/role/scope/generation changes suppress responses and unsent writes.
- Retained classification references prevent unused catalog retirement, including concurrent reference/retirement. Legacy employee writes/import omission retain both text compatibility and classification history. Existing work/capacity/leave/commercial/export history regressions remain required.
- Additive074 migration: fresh install, populated073 upgrade, replay and no identity/grant/native consumer/history backfill; roll-forward guidance.
- Independent fresh checkout, locked install and full applicable67 commands on a frozen exact head, privacy/scope inspection, dependent Draft against unchanged PR96, exact-head hosted acceptance. Formal reviews remain deferred, not passed; no main integration, merge, deployment or release acceptance.

## Operations / limitations

Suspend new authoring to roll back operationally; retain ledger, referenced sources and audit. Roll forward using an explicit later version; do not drop retained data or rewrite earlier migrations. Buyer choices are explicit configuration. Broader legacy catalog adoption, same-date amendments, dated identity transfer and authority changes require their existing governing contracts, not inferred business policy. Preserve all prior unexplained failure evidence, disabled hourly automation, controller and denied-operation boundaries.

Confirmed400/409/422 refusals clear the unsent request lock and require explicit reload; an uncertain transport/server/response-validation result keeps original-key GET reconciliation and blocks replacement writes. A real UI/API/PostgreSQL stale-worker409 test proves zero event persistence and usable reload, followed by a fresh deliberate save. The earlier frozen candidate and ongoing acceptance receipts are preserved before revalidation of this correction.
