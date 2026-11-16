# Enterprise delivery and integration roadmap

Updated 2026-11-16. Owner direction: review the complete code, improve WorkOS into a premium enterprise utilization/operations product, keep vision/plan/README current, and merge eligible changes. This authorizes integration work; it does not waive repository acceptance gates or authorize production deployment. PRODUCT_REQUIREMENTS.md remains authoritative. No new commercial policy or unapproved product category is introduced.

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

The initial refresh observed main at `b9a57f8a462d8585bb3f73129080d6fae5173343` and 104 open PRs, mostly a dependent Draft chain; that count is a dated observation, not a progress metric. Dependency repair PR145, documentation PR144/147–159, modular API/import/audit foundation PR41, utilization recovery PR43–46, organization/terminology editors PR47/48, calendar inspector PR49, import/audit evidence PR50, commercial drafting PR51, governed lifecycle PR52, scoped customer profiles PR53, governed amendments PR54, assignment/work-date convergence PR55, capture policy PR56 daily/weekly capture with optimistic saves PR57 optional evidence links PR58, descriptive work references PR59 buyer-configurable required evidence PR60, identical-entry advisories PR61, retained submission-history inspection PR62 named-role capture evidence PR63, explicit overtime capture policy PR64, submission deadlines/grace PR65 source-linked capture protection PR66, workforce capabilities PR67 and demand/assignment-reference planning PR68 are merged. That historical integration checkpoint was `b4beea218d5bd46c0396f5149dd05531420523ac`; exact-head acceptance passed, PR67 main checks passed all 60 application and 5 secret-scan steps, and PR68 main checks passed all 62 application and 5 secret-scan steps. Merge commits preserve dependent-stack ancestry. Effective worker capacity PR69 and assignment-version authority PR70 have since merged; the latest checkpoint is `0709097bcf72f0be8c03654398f64f719a10bc8e`. PR69 exact-head/main checks passed all 69 steps; PR70 corrected-head checks passed all 71 steps and independent review passed. PR70 main verification also passed all 71 steps. Capacity and percentage assignment history remain separate; legacy capacity/report reconciliation, hours distribution/conversion and configurable approval remain open. Later work includes approved-work/capacity reporting, further commercial controls and security/recovery corrections. See [current status](../00-control/IMPLEMENTATION_STATUS.md) for exact evidence and limits.

The project-contribution replacement and retained export are published in Draft PR146. Local server, strict-client, immutable export and real React/API/PostgreSQL acceptance passed, as did all three corrected-head hosted jobs. Separately recorded bootstrap scanner debt and prerequisite integration remain open; passing CI does not establish delivery on main. Broader performance, restore, branding and release evidence also remain open.

## Keeping documents current

After each accepted package, record the merge SHA, requirement IDs, applicable exact-head evidence and remaining limitations. Update the current status and README when their user-facing claims change. Preserve historical task and review records; do not rewrite them into a claim that later fixes had already existed. Never publish a readiness percentage without an auditable requirement-by-requirement basis.


## Own-work and role-security checkpoint — 2026-11-16

[PR71](https://github.com/APReddy-AutoBotz/WorkOS/pull/71) merged at `bcb48656e589c2520693a0cbf41eedb9c4956307`. Its exact candidate `4db36ec326ad91064d810a22ff35b3cae3a06580` passed all 68 application/migration/container and 5 full-history secret steps in [CI43794841837](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43794841837), plus independent exact-head security review with no introduced findings. The own-worker period view connects canonical account identity, effective capacity, original-unit assignments and retained work history. No migration, grant, unit conversion, source writer or financial/approval authority was added. Resulting [main CI43796753871](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/43796753871) is tracked separately; merge alone is not evidence of its completion.

The next independent security increment is [current selected-role authority](../tasks/WOS-04-CURRENT-ROLE-AUTHORITY.md), ported from the later Draft stack without importing unrelated packages. It rejects removed roles and disabled accounts through shared identity guards while retaining legitimate direct roles and all verified group-mapping alternatives. Focused database/provider/migration regressions pass; final integrated checks and independent exact-head review remain prerequisites to acceptance. Other security findings, protected identity administration, session revocation, TLS, remaining commercial/reporting integration, buyer UAT and release acceptance remain open. No deployment is authorized by this checkpoint.
