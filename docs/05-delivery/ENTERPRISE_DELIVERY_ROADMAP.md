# Enterprise delivery and integration roadmap

Updated 2026-11-15. Owner direction: review the complete code, improve WorkOS into a premium enterprise utilization/operations product, keep vision/plan/README current, and merge eligible changes. This authorizes integration work; it does not waive repository acceptance gates or authorize production deployment. PRODUCT_REQUIREMENTS.md remains authoritative. No new commercial policy or unapproved product category is introduced.

## Delivery priorities

| Priority | Outcome | Evidence required to advance |
|---|---|---|
| 1 | Integrate the verified foundation and security corrections | Inventory exact PR heads/dependencies/reviews; inspect actual diffs; resolve blocking findings; verify applicable CI and database/browser negatives; expected-head merge; main checks |
| 2 | Consistent utilization across workspaces | Explicit shared period, approved inclusion, effective capacity, distinct scoped workers, unknown versus zero, exact arithmetic, drilldown and governed exports; legacy views identified until parity |
| 3 | Reliable enterprise workflows | Recover failed reads, preserve edits, reconcile uncertain saves, accessible interaction and configurable terminology; real role-based browser/API/database journeys |
| 4 | Scale and operational resilience | Standard-profile representative data and75 concurrent sessions; read/mutation/report latency gates, bounded results and reviewed query plans; production-like backup/restore and RPO/RTO evidence |
| 5 | Release and buyer acceptance | Full frozen-source security review and finding disposition, branding/secret/dependency scans, one immutable release-head matrix, production identity/configuration, operations ownership and buyer UAT/handover |

This order preserves the existing backlog's work-package dependencies. It is not a promise of calendar dates or a substitute for the existing milestone definitions. Shared SaaS tenancy, statutory accounting, payroll and autonomous AI decisions remain outside v1.

## Integration procedure

1. Read live GitHub metadata, including all pages of open PRs, exact heads, base branches, review threads and checks. Separate obsolete controller branches from the active implementation dependency chain; do not merge every open PR merely because it exists.
2. Integrate independent documentation without importing unfinished implementation. Refresh README, vision and status from observed main state, and preserve historical records as evidence.
3. Review each implementation package and its prerequisite state. Previously passing checks can support only their exact tested source; later head changes require assessment and affected verification. Scope/security/migration/commercial reviews must inspect actual changed logic.
4. Use the repository's expected-head merge protection and normally squash. Any merge-method exception for a dependent stack must be documented with its ancestry/conflict reason. Do not bypass required reviews, checks or branch rules; do not force-push or directly push implementation to main.
5. Confirm the resulting main SHA and main-branch checks, reconcile dependent bases, and update task/issue traceability. Incomplete or blocking packages remain Draft. A merge does not itself approve release or deployment.

## Current working evidence

The initial refresh observed main at `b9a57f8a462d8585bb3f73129080d6fae5173343` and 104 open PRs, mostly a dependent Draft chain; that count is a dated observation, not a progress metric. Dependency repair PR145, documentation PR144/147–155, modular API/import/audit foundation PR41, utilization recovery PR43–46, organization/terminology editors PR47/48, calendar inspector PR49, import/audit evidence PR50, commercial drafting PR51, governed lifecycle PR52, scoped customer profiles PR53, governed amendments PR54, assignment/work-date convergence PR55, capture policy PR56 and daily/weekly capture with optimistic saves PR57 are merged. The integration checkpoint is `07967fddfe8ae0e6304d338db2f71b9f7e3a2198`; exact-head acceptance and every post-merge check through PR57 passed. Merge commits preserve dependent-stack ancestry. PR58 optional evidence links are next; local integration validation passed, while independent exact-head review and fresh hosted acceptance remain pending. Later work includes approved-work/capacity reporting, further commercial controls and security/recovery corrections. See [current status](../00-control/IMPLEMENTATION_STATUS.md) for exact evidence and limits.

The project-contribution replacement and retained export are published in Draft PR146. Local server, strict-client, immutable export and real React/API/PostgreSQL acceptance passed, as did all three corrected-head hosted jobs. Separately recorded bootstrap scanner debt and prerequisite integration remain open; passing CI does not establish delivery on main. Broader performance, restore, branding and release evidence also remain open.

## Keeping documents current

After each accepted package, record the merge SHA, requirement IDs, applicable exact-head evidence and remaining limitations. Update the current status and README when their user-facing claims change. Preserve historical task and review records; do not rewrite them into a claim that later fixes had already existed. Never publish a readiness percentage without an auditable requirement-by-requirement basis.
