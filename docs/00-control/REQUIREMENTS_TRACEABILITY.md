# WorkOS Requirements Traceability

**Status:** Blueprint mapping; PR/test/evidence columns are populated as implementation proceeds.  
**Authoritative requirements:** `PRODUCT_REQUIREMENTS.md` and `NON_FUNCTIONAL_REQUIREMENTS.md`

## 1. Traceability rules

Every accepted requirement must link to:

1. Governing requirement ID.
2. Work package and GitHub issue/task.
3. Pull request and exact accepted commit.
4. Automated tests.
5. Manual/browser/migration/security evidence where applicable.
6. Release containing the accepted capability.

A requirement cannot be marked accepted from a PR description or implementation-agent summary alone.

## 2. Domain-to-workstream mapping

| Requirement range | Primary planned PRs | Required evidence class | State |
|---|---|---|---|
| WOS-CORE-001, 006–007 | PR-003 | Configurable branding/terminology, demo-production separation and forbidden-term evidence | Blueprint |
| WOS-CORE-002 | PR-004 | Organization/legal-entity ownership, setup and cross-scope evidence | Blueprint |
| WOS-CORE-003 | PR-006 | Modular-monolith, versioned API and compatibility evidence | Partial; WOS-03B pilot in progress; completion evidence pending |
| WOS-CORE-004 | PR-004, 007–012 | Effective dates, historical versions, immutable history and controlled corrections | Blueprint |
| WOS-CORE-005 | PR-006 through PR-014 | Common and module-specific production-mutation/audit evidence | Partial; WOS-03B shared writer and authoritative organization/legal-entity/deployment mutation ownership are in progress; module coverage remains open |
| WOS-CORE-008 | PR-010 through PR-013 | Decimal-safe deterministic calculations, immutable evidence and reconciliation | Blueprint |
| WOS-ORG-001–010 | PR-004 | Fresh/upgrade migrations, organization-scoped uniqueness across effective identifier ranges (including concurrency), scope negatives and guided-setup journeys | Not started |
| WOS-IAM-001–010 | PR-003, 004, 006, 014 | Mandatory configured production OIDC/named accounts, fail-closed startup/authentication for missing/invalid/unavailable identity configuration, non-production/demo-only local/shared identities, session and authorization evidence | Not started |
| WOS-WKF-001–002, 006 | PR-004 | Worker migration, relationship/lifecycle dependencies and scoped administration | Not started |
| WOS-WKF-003–005, 007–008 | PR-008 | Capacity, skills, single-count leave, self-service and scoped workforce views | Not started |
| WOS-CLI-001–002 | PR-007 | Client hierarchy, scope and lifecycle | Not started |
| WOS-CTR-001–003 | PR-007, 010 | Contract/PO effective-date and lifecycle | Not started |
| WOS-ENG-001–005 | PR-007 | Engagement validation, migration and browser evidence | Not started |
| WOS-RES-001–009 | PR-004, 008, 009 | Assignment, capacity, over-allocation, approval and history | Not started |
| WOS-TIM-001–012 | PR-008, 009 | Daily/weekly capture, policy, correction, duplicate and lock evidence | Not started |
| WOS-APR-001–008 | PR-009 | State machine, delegation, SLA, bulk decisions, locks, shared approval notification events and one-action-event-per-transition evidence | Not started |
| WOS-COM-001–015 | PR-010, 011 | Financial vectors, confidentiality, snapshots, fixed-fee non-statutory earned-management fail-closed behavior and reconciliation | Not started |
| WOS-INV-001–008 | PR-012 | Source eligibility, one-to-one approved-unbilled register, direct-bypass rejection, database-unique current occupancy with same-batch/cross-batch/concurrent/idempotency/route/split-line vectors, cancellation/re-batching, permanent final occupancy, Approved-only provider/CSV acceptance, corrections and source-to-export reconciliation | Not started |
| WOS-RPT-001–007 | PR-013 | Scoped reports, leakage/data quality, Approved-only initial finance export, final-state retrieval/status controls and snapshot/event/register/batch/export reconciliation | Not started |
| WOS-INT-001–006 | PR-013, 014 | Thirteen canonical notification events/templates, four policy classes, mutually exclusive generic-pending versus pre-submission/domain-remediation triggers, default relationship recipients, preferences/mandatory decisions, in-app/email/collaboration delivery evidence, idempotency/failure isolation/health, worklog/finance adapters and production identity evidence | Not started |
| WOS-GOV-001–005 | PR-002, 005, 006, 016 | Append-only audit, provenance, export and release traceability | Partial; PR-005 release traceability merged; PR-006 shared audit/provenance seams are in progress; remaining controls stay open |
| WOS-OPS-001–010 | PR-003, 005, 015, 016 | Build/container, mandatory production OIDC environment/startup validation, migration, recovery, monitoring and handover | Partial; PR-005 CI/migration/profile controls merged; recovery and handover remain open |
| WOS-NFR-SEC-001–014 | PR-003, 005, 006, 009, 010, 012, 013, 014, 016 | Threat, mandatory configured production OIDC, no production local/shared fallback, authorization, secure configuration and scan evidence | Partial; PR-005 production configuration and scan controls merged; remaining security controls stay open |
| WOS-NFR-PRV-001–006 | PR-004, 008, 010, 012, 013, 014, 016 | Minimization, sensitive-field scope, retention/anonymization and privacy export | Blueprint |
| WOS-NFR-REL-001–009 | PR-005, 006, 008, 009, 011, 012, 013, 015, 016 | Fail-closed, transaction/idempotency, recovery and exact-head reliability | Partial; PR-005 migration lock/health controls merged; recovery and remaining controls stay open |
| WOS-NFR-PERF-001–008 | PR-006, 008, 011, 012, 013, 015, 016 | Pagination/query review, bounded jobs/exports and Standard-profile performance | Blueprint |
| WOS-NFR-DAT-001–008 | PR-004, 007–013, 016 | Ownership, temporal integrity, precision, constraints, lineage and reconciliation | Blueprint |
| WOS-NFR-MNT-001–008 | PR-002 through PR-016 | Modules, typed contracts, complexity, documentation and maintainability | Partial; WOS-03B conventions and first seams in progress; remaining controls stay open |
| WOS-NFR-DPL-001–007 | PR-003, 005, 015, 016 | Container/environment portability, mandatory production identity configuration, migration and deployment | Partial; PR-005 image/profile/environment controls merged; rollback/recovery remain open |
| WOS-NFR-OBS-001–006 | PR-005, 006, 009, 011, 012, 013, 015, 016 | Correlation, logs, job/integration/notification health and alerts | Partial; PR-005 health/build metadata merged; PR-006 request IDs are in the initial API pilot; broader observability remains open |
| WOS-NFR-UX-001–006 | PR-003, 004, 008, 009, 012, 013, 016 | Accessibility, responsive journeys, terminology/locale and errors | Blueprint |
| WOS-NFR-CMP-001–004 | PR-003, 004, 006, 008, 013, 014, 016 | Browser/API/version compatibility and provider-neutral contracts | Partial; initial v1 compatibility path is in progress; wider browser/provider evidence remains open |
| WOS-NFR-RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, artifact and release evidence | Blueprint |

## 3. Work-package traceability

PR identifiers after PR #1 are planned sequence identifiers until opened.

| Work package | Requirement groups | Issue | PR | Accepted commit | Release | Status |
|---|---|---|---|---|---|---|
| WOS-00 | Programme/architecture/NFR/control | #2 / corrective #13 | Historical PR #1 merged; Draft PR #14 active | Historical `main@880b3dc244bf516c4e535fb68e455e6153aec395`; corrected baseline pending | v0.1.0 | Corrective hold; accepted weight 0/suspended until PR #14 receives a clean exact-head review, guarded merge and corrected-baseline recording |
| WOS-01A | Source provenance/bootstrap | #3 | Draft PR #12 | Pending | v0.2.0 | Dependency-blocked; no resume, rebase, source import or implementation until PR #14 is clean exact-head reviewed, guarded-merged, the corrected exact `main` SHA is recorded, the controller explicitly reauthorizes WOS-01A, and PR #12 is recreated or rebased from that corrected baseline |
| WOS-01B | Neutral branding/configuration | #3 | Planned PR-003 | Pending | v0.2.0 | Not started |
| WOS-02 | Organization/setup | #4 | Planned PR-004 | Pending | v0.4.0 | Not started |
| WOS-03A | CI/migration/deployment | #5 | PR-005 / #40 | PR head `f704dde68ac7d11ac00c082786a9f96474e2b665`; merge commit `b9a57f8a462d8585bb3f73129080d6fae5173343` | v0.4.0 | Merged; exact-head CI and controller acceptance passed. Production-configured container/Compose startup remains untested |
| WOS-03B | Modular/API foundation | #5 | Draft PR-006 / #41 | Evidence recorded on PR #41 | v0.4.0 | In progress; PR #41 remains Draft, its description tracks exact-head CI/review evidence, and full WOS-03B acceptance remains open |
| WOS-04A | Contracts/engagements | #6 | Planned PR-007 | Pending | v0.5.0 | Not started |
| WOS-04B | Assignments/work capture | #6 | Planned PR-008 | Pending | v0.5.0 | Not started |
| WOS-05 | Approval/policy engine | #7 | Planned PR-009 | Pending | v0.5.0 | Not started |
| WOS-06A | Rates/costs/terms | #8 | Planned PR-010 | Pending | v0.7.0 | Not started |
| WOS-06B | Commercial engine | #8 | Planned PR-011 | Pending | v0.7.0 | Not started |
| WOS-06C | Billing eligibility, approved-unbilled and invoice readiness | #8 | Planned PR-012 | Pending | v0.7.0 | Not started |
| WOS-07 | Reports, leakage, notifications and adapters | #9 | Planned PR-013 | Pending | v0.8.0 | Not started |
| WOS-08A | Security/identity | #10 | Planned PR-014 | Pending | v0.9.0 | Not started |
| WOS-08B | Operations/recovery/performance | #10 | Planned PR-015 | Pending | v0.9.0 | Not started |
| WOS-09 | v1 acceptance/handover | #11 | Planned PR-016 | Pending | v1.0.0 | Not started |

## 4. WOS-00 documentation evidence

| Evidence ID | Evidence | Status |
|---|---|---|
| DOC-WOS-00-001 | Historical consolidated controller cross-document review | Historical PR #1 evidence; PR #1 merged at `main@880b3dc244bf516c4e535fb68e455e6153aec395`, now under WOS-00F corrective hold |
| DOC-WOS-00-002 | Independent Codex/Sol reviews and resolution mapping | Historical PR #1 Rounds 1–14 plus active WOS-00F PR #14 follow-up evidence; no clean final WOS-00F review claimed |
| DOC-WOS-00-003 | Product-owner Gate B decision | Approved 2026-08-23; exact final head binds after clean review |
| DOC-WOS-00F-001 | Active WOS-00F correction and verification evidence | Draft PR #14 active; latest independent review `PRR_kwDOUAv8Lc8AAAABKqRg4w` of `1efca7ad2dcc4c7d2b8a0cb298a829e98fd385c6` found two P2 authority/traceability inconsistencies; this convergence addresses them, but a fresh clean exact-head review remains mandatory |

### Review history represented by DOC-WOS-00-002

1. `492715dc8a40de6431365b6e52378d317721f617` — five P1, two P2.
2. `c2e3dbb74bc7c78a8f946222497850ac0c49ac78` — two P1.
3. `1f36b49461b86516b5855dbf9930a75f234b58e1` — one P1.
4. `9fc70babdf7c4d5c72f9d18a54f8c2318c903b3b` — one P1.
5. `649db270e8d43af152076e1f99e07c7204c575fc` — two P1.
6. `7124709e4f6682ded0321c58d22a6851a5e32b9d` — four P1, two P2.
7. `76f05c9da71d21b1f774afc91e13dad4323d6358` / review `PRR_kwDOUAv8Lc8AAAABKh3paA` — two P1: Gate C prerequisite and mandatory notification matrix.
8. `b30ec6f921262602edcab9e9d96a2dbb1c8571b2` / review `PRR_kwDOUAv8Lc8AAAABKh6Tsg` — two P1: Approved-only reporting/export semantics and mandatory production OIDC architecture wording.
9. `be42c047f6bcf2d4aa3476a7368bea04ebff1e70` / review `PRR_kwDOUAv8Lc8AAAABKh-0NA` — one P1 and one P2: mandatory production OIDC in quality baselines and stale controller evidence.
10. `d0e20c82c9ff3e9df4cfd14668024f7a4663c5a8` / review `PRR_kwDOUAv8Lc8AAAABKh_5pA` — three P2: authoritative Gate B state, complete review evidence representation and mandatory production OIDC in the architecture ADR summary.
11. `cd45de9181858d722e2974e92d6aaa53ba04ec17` / review `PRR_kwDOUAv8Lc8AAAABKiBoBw` — two P1 and one P2: fixed-fee statutory-recognition ambiguity, overlapping approval action events and accepted OIDC decision wording.
12. `a023ebef80fad7aea354f3759801a430de18cb6e` / review/timeline `PRR_kwDOUAv8Lc8AAAABKiJB1g`, actionable thread `PRRT_kwDOUAv8Lc6bdgWF` — one P1: unique current line occupancy for each approved-unbilled-item version.
13. `86484cde78f1350a4a0a3f55f368f2e919353663` / review `PRR_kwDOUAv8Lc8AAAABKiIDxA` — one P1 and one P2: explicit PR-012 occupancy vectors/ownership and stale Round-12 evidence.

14. Post-merge review of PR #1 head `e8e05e0f17e78e7ef19a35c078601ebda5881a45` — P1 `PRRT_kwDOUAv8Lc6beCXL` and P2 `PRRT_kwDOUAv8Lc6beCXQ`, triggering WOS-00F after PR #1 had merged.
15. Review `PRR_kwDOUAv8Lc8AAAABKkn3EA` of WOS-00F head `039789b7860d38115c7dfbd39dd26c0a36314a6a` — three P2 consistency findings, subsequently corrected and resolved.
16. Review `PRR_kwDOUAv8Lc8AAAABKlyssg` of exact head `78d89bc3a4cda87354eb3e494ea8c816bd2f5bbf` — P2 `PRRT_kwDOUAv8Lc6bneWi` (stale primary traceability) and P2 `PRRT_kwDOUAv8Lc6bneWu` (atomic protected-recipient creation), corrected.
17. Review `PRR_kwDOUAv8Lc8AAAABKl2Ozw` of the same exact head — P2 `PRRT_kwDOUAv8Lc6bnl_f` (actual verification outcomes) and P2 `PRRT_kwDOUAv8Lc6bnl_i` (rollback must preserve the corrective hold), corrected.
18. Review `PRR_kwDOUAv8Lc8AAAABKnPSiQ` of exact head `c6185a7f5b39dda71c4198c305263e65e85f8264` — three P2 findings: stale WOS-01 authorization, forbidden-term scan contradiction and Mermaid-validation overclaim, corrected.
19. Review `PRR_kwDOUAv8Lc8AAAABKnm5YA` of exact head `c6185a7f5b39dda71c4198c305263e65e85f8264` — two P2 findings: missing corrected-main baseline recording in backlog authority and incomplete A–I adversarial evidence, corrected.
20. Review `PRR_kwDOUAv8Lc8AAAABKpzHEw` of exact head `81f58a01d980031c87415bf5ba5347ec39877eed` — two P2 current-authority findings, corrected.
21. Review `PRR_kwDOUAv8Lc8AAAABKp-K9w` of exact head `81f58a01d980031c87415bf5ba5347ec39877eed` — one P2 current-authority finding, corrected.
22. Review `PRR_kwDOUAv8Lc8AAAABKqRg4w` of exact head `1efca7ad2dcc4c7d2b8a0cb298a829e98fd385c6` — two P2 findings: the WOS-01A traceability row omitted explicit controller reauthorization plus PR #12 recreate/rebase, and implementation status retained stale prior-review scope; this convergence corrects both without claiming a clean final review.

The WOS-00F corrective hold supersedes every historical authorization to begin WOS-01 after PR #1 merged. PR #12 remains blocked until PR #14 is clean-reviewed and merged, the corrected exact `main` SHA is recorded, the controller explicitly reauthorizes WOS-01A, and PR #12 is recreated or rebased from that corrected baseline before source import resumes. This correction addresses the active findings but does not claim a clean final review; the next acceptance evidence must be a fresh clean independent review of the exact moved PR #14 head.

## 5. Evidence taxonomy

| Prefix | Evidence type |
|---|---|
| `UT-` | Unit/domain test |
| `API-` | API/contract test |
| `AUTH-` | Authorization/negative-scope test |
| `MIG-` | Fresh/upgrade migration evidence |
| `BWR-` | Browser role journey |
| `FIN-` | Financial vector/reconciliation |
| `SEC-` | Security/threat/scan evidence |
| `PERF-` | Performance/load evidence |
| `OPS-` | Deployment/monitoring/recovery evidence |
| `DOC-` | Documentation/provenance/consistency evidence |
| `UAT-` | Production-like acceptance evidence |

Evidence lives under versioned `docs/evidence/v<release>/` paths. Secrets, personal data and bulky transient artifacts are stored externally with only safe summaries/references committed.

## 6. Requirement acceptance states

| State | Meaning |
|---|---|
| Blueprint | Defined and mapped; no implementation accepted |
| In progress | Active branch/PR; no accepted credit |
| Engineering ready | Implementation/tests merged; environment/UAT/release gates remain |
| Accepted | All evidence and approvals complete at an exact commit |
| Deferred | Explicitly removed from current release with rationale |
| Rejected | Decision made not to implement; authority updated |

## 7. Implementation PR traceability requirements

Every implementation PR includes requirement IDs, evidence IDs, exact head, required checks and limitations.

### PR-011 evidence minimum

- Fixed-fee and every non-T&M operational earned-management policy profile is explicitly non-statutory, effective-dated and fail-closed when no authorized policy is selected.
- Operational earned-management results never create billing eligibility or invoice readiness and do not treat approved hours as automatically invoiceable.
- Deterministic financial golden vectors independently specify policy inputs, timing, currency/FX, rounding, version and correction behavior.

### PR-012 evidence minimum

- Source-family eligibility vectors and direct raw-source bypass rejection.
- One-to-one event/register creation and database-unique current occupancy: same-batch, cross-batch and concurrent duplicate rejection with no orphan line, duplicate amount or control-total drift.
- Same-key identical retry returns the existing membership; same-key changed-input and different-key duplicates conflict; bulk, import and compatibility routes cannot bypass occupancy.
- Partial-billing/presentation-splitting reuse is rejected; separately billable portions require distinct authorized/versioned event/item versions and reconciled source totals.
- Valid pre-export cancellation releases only current occupancy atomically; controlled re-batching creates a new immutable membership version; final occupancy is permanent and corrections use reversal/superseding lineage.
- Provider and immutable CSV-artifact acceptance; failed-operation and final-state retrieval semantics.
- Reversals/supersessions and source → event → register → line → batch/export reconciliation.

### PR-013 evidence minimum

- One positive and one negative deterministic vector for each of the thirteen canonical WOS-INT-002 event/template keys.
- Event/template/source versions, trigger, default relationship recipients and one of four policy classes.
- In-app mandatory behavior; preference rules; mandatory override/no-opt-out; visible no-recipient failure.
- Recipient scope/redirection negatives and no v1 client recipient.
- Shared `approval.*` event reuse across work, leave, assignment, commercial and batch approvals.
- Transition evidence that `commercial.approval_required` fires only before generic submission to requester/change owner and that a pending generic stage fires only `approval.action_required`.
- Transition evidence that `invoice_batch.action_required` fires only for non-approval batch-owner remediation and never for pending approval or generic rejection/correction.
- One source entity/version/operation cannot create more than one action-required notification; replay remains idempotent across event, in-app and channel delivery.
- Versioned locale/template-variable safety and sanitized provider/health evidence.
- Email/collaboration/worklog/finance adapter contracts, including Approved-only initial finance export and final-state retrieval/status-only behavior.

### PR-014 evidence minimum

- Production startup/readiness rejects missing, invalid or unavailable required OIDC configuration.
- Production authentication remains fail-closed and cannot enable WorkOS local authentication.
- Local credentials and shared/demo identities operate only in approved non-production/demo profiles and are disabled or absent in production.
- Disabled users and revoked sessions lose access through the mandatory production identity path.

## 8. v1 acceptance summary

Completed by PR-016:

```text
Total v1 requirements:
Accepted:
Deferred by approved scope:
Open blocking:
Open non-blocking:
Exact release commit:
Release tag:
Security disposition:
Migration evidence:
Commercial reconciliation:
Restore rehearsal:
Buyer UAT:
Owner Gate D approval:
```

## WOS-00F corrective traceability

## WOS-02 organization and setup foundation traceability

| Requirement | Implementation evidence | Executable evidence |
|---|---|---|
| WOS-CORE-001, WOS-CORE-002, WOS-CORE-004, WOS-CORE-006 | Ordered organization ownership migration, modular server setup boundary, persisted setup facts and centrally consumed effective-dated runtime terminology across navigation, forms, organization/planning views, report/export labels and notification-facing copy, with canonical contracts preserved | `npm run test:organization-setup`; `npm run test:terminology-runtime`; retained `npm test` |
| WOS-ORG-001–WOS-ORG-010 | Effective-dated, audited organization profiles whose base-name compatibility projection remains current until a scheduled version is effective; governed legal-entity administration, including future-effective legal-entity display and lifecycle authority that cannot alter current scope; scoped organizational catalogs; country/legal-entity/canonical-worker-group working calendars with deterministic work weeks, standard hours and public/company holiday authority; governed periods/terminology; deterministic backfill; database-enforced composite ownership, effective-range identifier uniqueness and non-overlapping versions; row-locked Weekly/Monthly/Fiscal reporting-period authority over every timesheet work date; dependency-safe retirement; and complete fail-closed guided readiness across every WOS-ORG-010 area | `server/migrations/022_organization_setup_foundation.sql`; `server/migrations/023_wos02_scope_lifecycle_integrity.sql`; `server/migrations/024_wos02_final_review_closure.sql`; `server/migrations/025_wos02_timesheet_scope_integrity.sql`; `server/migrations/026_wos02_canonical_legal_scope_integrity.sql`; `server/migrations/027_wos02_reporting_period_authority.sql`; `server/migrations/028_wos02_organization_legal_entity_profiles.sql`; `server/migrations/029_wos02_working_calendar_authority.sql`; `server/migrations/030_wos02_reporting_period_frequency.sql`; `server/migrations/031_wos02_legal_entity_effective_authority.sql`; `server/migrations/032_wos02_legal_identifier_effective_ranges.sql`; `server/organization-setup.mjs`; `server/reporting-periods.mjs`; `server/working-calendars.mjs`; `server/setup-readiness.mjs`; `tests/organization-setup-smoke.mjs`; `.github/scripts/wos02-org-profile-acceptance.mjs` |
| WOS-IAM-005 | Persisted user organization/legal-entity assignments, effective-date-aware current-scope discovery and server validation, exact employee-record identity, fail-closed ambiguous employee-code login, identity-only session bootstrap before scope selection, a full-page authorized browser scope gate before protected data loads, explicit selected-scope headers on protected calls and role switches, atomic leaver account/scope disablement, and deterministic demo identity/scope provisioning | Cross-scope, ambiguous-identity, no-scope protected-data denial, identity-only refresh and row-lifecycle contracts in `tests/organization-setup-smoke.mjs` and `.github/scripts/wos02-final-review-live-acceptance-core.mjs`; real-Chrome multi-scope callback/selection evidence in controller `.github/scripts/wos02-multiscope-scope-selection-browser-acceptance.mjs`; demo identity/scope contracts in `tests/backend-contract-smoke.mjs` |
| WOS-WKF-001, WOS-WKF-002, WOS-WKF-006 | Worker ownership/type/profile/history, atomic initial worker state for canonical save/import, version-owned legal history access, scoped allocation and timesheet imports, organization-scoped timesheet identity, dependency-aware disable/exit/reactivation transitions, and replay-safe demo worker lifecycle initialization | Lifecycle initialization/reactivation, idempotency, identity synchronization, bounds, row-scope and no-write conflict contracts in `tests/organization-setup-smoke.mjs`; demo lifecycle contracts in `tests/backend-contract-smoke.mjs` |

The WOS approval, invoice and integration requirement families are clarified by WOS-00F. PR-009 owns generic approval finality, stable conflicts and authorization evidence; PR-012 owns invoice-batch cancellation/replacement, reversal/supersession, occupancy and export evidence; PR-013 owns bounded server-side recipient resolution, atomic all-or-nothing protected event/in-app recipient and reason-mapping persistence, zero-partial-state negatives, corrected exactly-once retry, downstream external-channel isolation, delivery idempotency and event exclusivity. Historical PR #1 evidence remains distinct from active PR #14 evidence. PR #12 remains blocked while the merged baseline is under corrective hold and until the complete five-part WOS-01A dependency law is satisfied.

## WOS-03A — PR-005 CI, migrations and production profiles (merged)

PR #40 merged the accepted PR-005 head `f704dde68ac7d11ac00c082786a9f96474e2b665` as main commit `b9a57f8a462d8585bb3f73129080d6fae5173343`. Exact-head CI [run #37307197672](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/37307197672), configured review and controller acceptance passed. The PR record retains the complete check matrix and acceptance details.

| Requirement group | Merged implementation/evidence | Acceptance status |
|---|---|---|
| WOS-OPS-001–004, WOS-OPS-007, WOS-OPS-009; WOS-NFR-DPL-001–006 | `.github/workflows/workos-ci.yml`, `Dockerfile`, `compose.yaml`, `server/environment.mjs`, `server/health.mjs`, `server/migration-runner.mjs`, `server/migrate.mjs`, and exact-head CI | Passed at PR #40 head |
| WOS-NFR-SEC-006, WOS-NFR-SEC-011 | Full-history Gitleaks step with comments/artifact upload disabled; locked dependency audit; production fallback/secret validation | Passed at PR #40 head; five low and two moderate dependency advisories remain |
| WOS-NFR-REL-002, WOS-NFR-MNT-004–007 | Separate liveness/readiness/build metadata, ordered migration ledger, transaction advisory lock, new-file checksums and migration operations documentation | Passed at PR #40 head |
| WOS-GOV-005 | PR-005 task authority and traceability documentation linked to Issue #5 | Merged with PR #40 |

CI built the production image and verified its fail-closed startup path, but did not start the image or Compose stack with valid production configuration. The positive identity/readiness smoke used Node, disposable PostgreSQL and a local identity fixture; no production credentials, customer data or external identity provider were used. Full backup/restore rehearsal, monitoring ownership, broader structured logging and v1 handover remain with later operations/recovery packages.

## WOS-03B — PR-006 modular and API foundation (in progress)

This bounded candidate is based on the merged PR-005 main commit. It introduces shared identity, API request-context, versioned error and audit seams while preserving existing route behavior. It does not claim completion of all WOS-CORE-003, WOS-CORE-005 or WOS-GOV-001–004 requirements; additional domain extraction, audit/provenance coverage and retention work remain in this and later packages.

| Requirement group | Candidate implementation/evidence | Current acceptance status |
|---|---|---|
| WOS-CORE-003; WOS-NFR-MNT-001–008 | `server/modules/identity-access/`, `server/modules/audit/`, `server/modules/imports/`, `server/modules/integrations/`, `server/api/`, this API architecture contract, shared identity/organization/audit/import/integration-history router mounts, legacy/v1 route parity tests and bounded extraction from `server/index.mjs` | Draft PR #41 records local gates and exact-head CI/review for this incremental pilot; full WOS-CORE-003 acceptance remains open |
| WOS-CORE-005; WOS-GOV-001–004; WOS-IAM-005; WOS-NFR-PRV-002 | Shared `recordAuditEvent` writer, additive migrations `033_wos03_audit_operation_context.sql`, `034_wos03_employee_import_provenance.sql`, `035_wos03_scoped_history.sql`, and `036_wos03_identity_link_provenance_reference.sql`; imported employee, client, project, Allocation Control and timesheet CSV records retain source, a supplied source identifier where available, server-generated batch reference and successful processing result; identity-link API upserts retain provider source, a unique immutable opaque server-generated provenance reference, request operation context and successful processing result without copying external subject/UPN into those mutation entries; the Entra callback retains the same reference and server-generated callback operation ID on its login success audit/event when it synchronizes an employee link; legacy import readiness compatibility checks exact saved organization/legal-entity fields without assigning scope to or exposing null-scope audit rows; deployment-level Entra role-mapping audit/event records remain unscoped; audit, import/export, integration histories and Teams action tokens carry nullable server-owned organization/legal-entity scope. Wider-scope producers now pass their authoritative owner explicitly: legal-entity creation is organization-owned, its later updates retain exact legal-entity ownership, and deployment-global catalog, country-director, and notification-template audit events plus role-definition deactivation audit events remain null-scope, including blocked deactivations | PostgreSQL/API tests cover CSV and identity-link create/update provenance, stable opaque references and upgrade backfill without changing legacy identity values, exact-pair history reads and readiness compatibility, generic-import-marker rejection, Admin scope denial, authorized multi-scope selection, fail-closed execution/send of cross-scope and legacy null-scope tokens, unscoped legacy-row exclusion, deployment-level role mapping exclusion from scoped audit/event reads, identity-field and bearer-action-URL redaction, scoped integration health aggregates, migration upgrade without changing historical history, and append-only audit preservation. Real API/PostgreSQL route tests verify organization-owned legal-entity creation is visible only to the organization reader, later edits remain visible only in that legal entity’s exact-pair history, and deployment catalog/country-director outcomes, notification-template create/update and blocked/successful role deactivations are null-scope, visible to the designated deployment reader and excluded from selected-scope history. Existing Entra login audit/event payloads still store current subject/UPN values, which ordinary scoped history views redact. The agreed foundation limit is that identity-link mutation history retains only an opaque reference, resulting status and changed-field flags; prior subject/UPN values are not retained. Future versioned external-identifier history remains outside this bounded foundation. WOS-GOV-003 remains open: PR-006 adds no deletion/anonymization behavior, and such operations remain disabled pending a buyer-defined retention period and approval owners. Rejected-row source IDs, schema-version/idempotency/dry-run evidence, remaining import/integration provenance paths and provider configuration ownership also remain open |
| WOS-CORE-005; WOS-GOV-002; WOS-IAM-004, 006; WOS-NFR-SEC-004, 005 | Additive migration `037_wos03_deployment_audit_permission.sql` registers protected `audit.deployment.view` with every role disabled and creates no user grants. Legacy and v1 `/deployment-audit-logs` readers require an authenticated active account, an active role still assigned to that account, effective permission and a matching explicit per-user grant; the final data query repeats these checks while selecting only rows with both organization and legal-entity scope null through the shared redaction. Ordinary audit readers keep their exact-pair filter. Role-wide enablement is rejected. The existing `permissions.manage` path may designate a different active user with an assigned role; self-grants, roleless and inactive targets are rejected, and stale grantor roles cannot assign or revoke this exception. Grant/revoke audit events for this capability remain null-scope. The Audit Trail page exposes deployment-wide history to explicitly designated users, including users without ordinary scoped audit permission. A designated user can reach this page without a selected scope, even if they also hold `audit.view`; without a validated scope the page defaults to deployment history and does not fetch or expose the selected-organization tab. After the gate validates a selected pair, the existing scoped audit view remains available under its exact-pair API filter. Login sends a designated auditor without a valid selected scope to this reader | Migration/API tests cover default-deny role rows, absence of seeded grants, denied readers without a grant, inactive targets/accounts and stale active-role claims, rejection of role-wide enablement, self-grants and stale grantor roles, an explicit non-Admin user designation and revocation, both legacy/v1 aliases without selected scope, exact-null selection, and shared sensitive-field redaction. Routing/permission tests cover a designated user with both audit permissions and the no-scope login path; scoped history is withheld until the gate validates a selected pair. No live auditor grant is created; final-candidate CI and independent review remain required before readiness |
| WOS-CORE-005; WOS-GOV-002; WOS-IAM-004, 006; WOS-NFR-SEC-004, 005 | Additive migration `038_wos03_organization_audit_access.sql` allows organization-owned audit rows with `organization_id` set and `legal_entity_id` null, adds organization referential integrity, and registers protected `audit.organization.view` with every role disabled and no seeded designation. Profile and terminology writers explicitly record their organization-level ownership, leaving historical rows unchanged. Legacy and v1 organization-audit readers require an active account, active assigned role, effective permission derived from a user-specific organization grant, and a matching designation rechecked in the final query; they return only the requested organization's rows with null legal-entity scope through shared redaction. Ordinary `/audit-logs` remains an exact selected-pair read, and deployment/null-scope history remains in its separate reader. Existing `permissions.manage` authority can designate and revoke organization access only from a verified active scope in that organization; self-grants, role-wide enablement, generic user grants, inactive targets and targets without active membership in that organization are rejected. Grant/revoke events are appended at organization scope. The Audit Trail exposes only organizations designated to the signed-in user, including when no legal entity is selected, and does not use that permission to load scoped workspace data | Disposable PostgreSQL/HTTP tests cover all roles denied and no seeded grants, migration compatibility, organization-owned profile/terminology writes, designated positive access without selected scope, exact organization-only filtering, cross-organization and legal-entity exclusion, default-deny, stale-role and disabled-account denial, self/foreign-organization grant rejection, role-wide and generic-grant rejection, append-only grant/revoke events, legacy/v1 parity, ordinary exact-pair non-disclosure, and no live grants. Routing tests cover scope-free navigation and no demo workspace fallback. No production grants or deployment are created; exact-tree independent review and exact-head CI remain required before readiness |
| WOS-CORE-003; WOS-NFR-OBS-001–006; WOS-NFR-CMP-001–004 | Validated correlation IDs, generated state-changing operation IDs, `/api/v1` stable errors and legacy-compatible error parsing; shared identity/organization-setup routers mounted on legacy and v1 prefixes | Draft PR #41 records targeted API and route-parity tests plus full `npm test`; broader browser/controller acceptance remains open |

The ordinary scoped and v1 `/api/integrations/events` readers exclude null-scope system events, including unmatched Entra login failures. The legacy and v1 `/api/deployment-integration-events` readers expose only records with both scope columns null to an active account with its current role still assigned and an explicit `audit.deployment.view` user grant; role defaults remain disabled and no live grant is seeded. The reader repeats those predicates in its bounded final query, returns the existing integration-event shape through shared provider-identity and bearer-URL redaction, and requires no selected organization scope. UI access is available only under the same deployment permission and does not export these events. Migration/API coverage includes a scope-free non-Admin designated user, denied ungranted and role-default-only users, stale/revoked authorization, exact-null/null results, legacy/v1 parity, identity and bearer-URL redaction, and continued exclusion from selected-scope history. No separate integration-event role, grant model, schema change, or production auditor assignment is introduced.

Local migration-runner execution is unavailable because the authoring container has no PostgreSQL server or Docker. The current candidate includes route probes that run in the required workflow's disposable PostgreSQL service. PR #41's description records migration/import outcomes for published code heads; this section tracks scope and coverage rather than per-head run status.
