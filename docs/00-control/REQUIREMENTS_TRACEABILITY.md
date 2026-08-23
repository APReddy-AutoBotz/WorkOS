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
| WOS-CORE-003 | PR-006 | Modular-monolith, versioned API and compatibility evidence | Blueprint |
| WOS-CORE-004 | PR-004, 007–012 | Effective dates, historical versions, immutable history and controlled corrections | Blueprint |
| WOS-CORE-005 | PR-006 through PR-014 | Common and module-specific production-mutation/audit evidence | Blueprint |
| WOS-CORE-008 | PR-010 through PR-013 | Decimal-safe deterministic calculations, immutable evidence and reconciliation | Blueprint |
| WOS-ORG-001–010 | PR-004 | Fresh/upgrade migrations, organization-scope negatives and guided-setup journeys | Not started |
| WOS-IAM-001–010 | PR-003, 004, 006, 014 | Mandatory production OIDC, fail-closed startup/authentication, no-local-fallback, identity/session and authorization evidence | Not started |
| WOS-WKF-001–002, 006 | PR-004 | Worker migration, relationship/lifecycle dependencies and scoped administration | Not started |
| WOS-WKF-003–005, 007–008 | PR-008 | Capacity, skills, single-count leave, self-service and scoped workforce views | Not started |
| WOS-CLI-001–002 | PR-007 | Client hierarchy, scope and lifecycle | Not started |
| WOS-CTR-001–003 | PR-007, 010 | Contract/PO effective-date and lifecycle | Not started |
| WOS-ENG-001–005 | PR-007 | Engagement validation, migration and browser evidence | Not started |
| WOS-RES-001–009 | PR-004, 008, 009 | Assignment, capacity, over-allocation, approval and history | Not started |
| WOS-TIM-001–012 | PR-008, 009 | Daily/weekly capture, policy, correction, duplicate and lock evidence | Not started |
| WOS-APR-001–008 | PR-009 | State machine, delegation, SLA, bulk decisions, locks and shared approval notification events | Not started |
| WOS-COM-001–015 | PR-010, 011 | Financial vectors, confidentiality, snapshots and reconciliation | Not started |
| WOS-INV-001–008 | PR-012 | Source eligibility, one-to-one approved-unbilled register, direct-bypass rejection, occupancy, Approved-only provider/CSV acceptance, final-state retrieval/status idempotency, corrections and source-to-export reconciliation | Not started |
| WOS-RPT-001–007 | PR-013 | Scoped reports, leakage/data quality, Approved-only initial finance export, final-state retrieval/status controls and snapshot/event/register/batch/export reconciliation | Not started |
| WOS-INT-001–006 | PR-013, 014 | Thirteen canonical notification events/templates, four policy classes, default relationship recipients, preferences/mandatory decisions, in-app/email/collaboration delivery evidence, idempotency/failure isolation/health, worklog/finance adapters and production identity evidence | Not started |
| WOS-GOV-001–005 | PR-002, 005, 006, 016 | Append-only audit, provenance, export and release traceability | Not started |
| WOS-OPS-001–010 | PR-003, 005, 015, 016 | Build/container, mandatory production OIDC startup validation, migration, recovery, monitoring and handover | Not started |
| WOS-NFR-SEC-001–014 | PR-003, 005, 006, 009, 010, 012, 013, 014, 016 | Threat, mandatory production identity, authorization, secure configuration and scan evidence | Blueprint |
| WOS-NFR-PRV-001–006 | PR-004, 008, 010, 012, 013, 014, 016 | Minimization, sensitive-field scope, retention/anonymization and privacy export | Blueprint |
| WOS-NFR-REL-001–009 | PR-005, 006, 008, 009, 011, 012, 013, 015, 016 | Fail-closed, transaction/idempotency, recovery and exact-head reliability | Blueprint |
| WOS-NFR-PERF-001–008 | PR-006, 008, 011, 012, 013, 015, 016 | Pagination/query review, bounded jobs/exports and Standard-profile performance | Blueprint |
| WOS-NFR-DAT-001–008 | PR-004, 007–013, 016 | Ownership, temporal integrity, precision, constraints, lineage and reconciliation | Blueprint |
| WOS-NFR-MNT-001–008 | PR-002 through PR-016 | Modules, typed contracts, complexity, documentation and maintainability | Blueprint |
| WOS-NFR-DPL-001–007 | PR-003, 005, 015, 016 | Container/environment portability, migration and deployment | Blueprint |
| WOS-NFR-OBS-001–006 | PR-005, 006, 009, 011, 012, 013, 015, 016 | Correlation, logs, job/integration/notification health and alerts | Blueprint |
| WOS-NFR-UX-001–006 | PR-003, 004, 008, 009, 012, 013, 016 | Accessibility, responsive journeys, terminology/locale and errors | Blueprint |
| WOS-NFR-CMP-001–004 | PR-003, 004, 006, 008, 013, 014, 016 | Browser/API/version compatibility and provider-neutral contracts | Blueprint |
| WOS-NFR-RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, artifact and release evidence | Blueprint |

## 3. Work-package traceability

PR identifiers after PR #1 are planned sequence identifiers until opened.

| Work package | Requirement groups | Issue | PR | Accepted commit | Release | Status |
|---|---|---|---|---|---|---|
| WOS-00 | Programme/architecture/NFR/control | #2 | #1 | Pending clean review/merge | v0.1.0 | Eight review rounds corrected; Gate B approved; clean exact-head review pending |
| WOS-01A | Source provenance/bootstrap | #3 | Planned PR-002 | Pending | v0.2.0 | Authorized after WOS-00 merge |
| WOS-01B | Neutral branding/configuration | #3 | Planned PR-003 | Pending | v0.2.0 | Not started |
| WOS-02 | Organization/setup | #4 | Planned PR-004 | Pending | v0.4.0 | Not started |
| WOS-03A | CI/migration/deployment | #5 | Planned PR-005 | Pending | v0.4.0 | Not started |
| WOS-03B | Modular/API foundation | #5 | Planned PR-006 | Pending | v0.4.0 | Not started |
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
| DOC-WOS-00-001 | Required-file inventory and controller cross-document review | Complete in PR #1 |
| DOC-WOS-00-002 | Independent Codex/Sol reviews and resolution mapping | Eight review rounds completed/corrected; clean exact-head re-review pending |
| DOC-WOS-00-003 | Product-owner Gate B decision | Approved 2026-08-23; exact final head binds after clean review |

### Review history represented by DOC-WOS-00-002

1. `492715dc8a40de6431365b6e52378d317721f617` — five P1, two P2.
2. `c2e3dbb74bc7c78a8f946222497850ac0c49ac78` — two P1.
3. `1f36b49461b86516b5855dbf9930a75f234b58e1` — one P1.
4. `9fc70babdf7c4d5c72f9d18a54f8c2318c903b3b` — one P1.
5. `649db270e8d43af152076e1f99e07c7204c575fc` — two P1.
6. `7124709e4f6682ded0321c58d22a6851a5e32b9d` — four P1, two P2.
7. `76f05c9da71d21b1f774afc91e13dad4323d6358` / review `PRR_kwDOUAv8Lc8AAAABKh3paA` — two P1: Gate C prerequisite and mandatory notification matrix.
8. `b30ec6f921262602edcab9e9d96a2dbb1c8571b2` / review `PRR_kwDOUAv8Lc8AAAABKh6Tsg` — two P1: Approved-only reporting/export semantics and mandatory production OIDC.

All listed findings are corrected in the active branch. The next evidence must be a clean independent review of the exact moved head.

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

### PR-012 evidence minimum

- Source-family eligibility vectors and direct raw-source bypass rejection.
- One-to-one event/register creation, idempotency and active/final concurrency.
- Provider and immutable CSV-artifact acceptance; failed-operation and final-state retrieval semantics.
- Reversals/supersessions and source → event → register → line → batch/export reconciliation.

### PR-013 evidence minimum

- One positive and one negative deterministic vector for each of the thirteen canonical WOS-INT-002 event/template keys.
- Event/template/source versions, trigger, default relationship recipients and one of four policy classes.
- In-app mandatory behavior; preference rules; mandatory override/no-opt-out; visible no-recipient failure.
- Recipient scope/redirection negatives and no v1 client recipient.
- Shared `approval.*` event reuse across work, leave, assignment, commercial and batch approvals.
- Domain-event, in-app and channel idempotency with no duplicate delivery.
- Versioned locale/template-variable safety and sanitized provider/health evidence.
- Email/collaboration/worklog/finance adapter contracts, including Approved-only initial finance export and final-state retrieval/status-only behavior.

### PR-014 evidence minimum

- Production startup/readiness rejects missing, invalid or unavailable required OIDC configuration.
- Production authentication remains fail-closed and cannot enable WorkOS local authentication.
- Local/shared demo identities operate only in approved non-production/demo profiles.
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
