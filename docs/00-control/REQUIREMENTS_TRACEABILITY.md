# WorkOS Requirements Traceability

**Status:** Blueprint mapping; PR/test/evidence columns are populated as implementation proceeds.  
**Authoritative requirements:** `PRODUCT_REQUIREMENTS.md` and `NON_FUNCTIONAL_REQUIREMENTS.md`

## 1. Traceability rules

Every accepted requirement must link to:

1. Governing requirement ID.
2. Work package and GitHub issue/task.
3. Pull request and exact accepted commit.
4. Automated test(s).
5. Manual/browser/migration/security evidence where applicable.
6. Release containing the accepted capability.

A requirement cannot be marked accepted based only on a PR description or implementation-agent summary.

## 2. Domain-to-workstream mapping

| Requirement range | Primary workstream/PR | Required evidence class | Current state |
|---|---|---|---|
| WOS-CORE-001–008 | WOS-00, PR-003, PR-004, PR-006, PR-011 | Configuration, architecture, authorization, calculation and forbidden-term evidence | Blueprint |
| WOS-ORG-001–010 | PR-004 | Fresh/upgrade migrations, organization-scope negative tests, guided-setup browser evidence | Not started |
| WOS-IAM-001–010 | PR-003, PR-004, PR-006, PR-014 | Identity/session, permission matrix, row-scope and negative security evidence | Not started |
| WOS-WKF-001–002, WOS-WKF-006 | PR-004 | Worker-master/type migration, relationship/lifecycle dependency tests and scoped administration journeys | Not started |
| WOS-WKF-003–005, WOS-WKF-007–008 | PR-008 | Capacity, skills, single-count leave/holiday availability, self-service and scoped workforce browser/API evidence | Not started |
| WOS-CLI-001–002 | PR-007 | Client hierarchy, scope and lifecycle tests | Not started |
| WOS-CTR-001–003 | PR-007, PR-010 | Contract/PO effective-date and lifecycle tests | Not started |
| WOS-ENG-001–005 | PR-007 | Engagement-model validation and migration/browser evidence | Not started |
| WOS-RES-001–009 | PR-004, PR-008, PR-009 | Assignment, capacity, over-allocation, approval and history tests | Not started |
| WOS-TIM-001–012 | PR-008, PR-009 | Daily/weekly work capture, policy, correction, duplicate and locked-period tests | Not started |
| WOS-APR-001–008 | PR-009 | Approval state machine, delegation scope, SLA, bulk decision and period-lock evidence | Not started |
| WOS-COM-001–015 | PR-010, PR-011 | Golden financial vectors, confidentiality negative tests, snapshot/reconciliation evidence | Not started |
| WOS-INV-001–008 | PR-012 | Batch state, source traceability, no-double-billing, reversal and export evidence | Not started |
| WOS-RPT-001–007 | PR-013 | Scoped report, leakage scenario, data-quality and reconciliation tests | Not started |
| WOS-INT-001–006 | PR-013, PR-014 | Adapter contracts, idempotency, failure isolation and integration-health evidence | Not started |
| WOS-GOV-001–005 | PR-002, PR-005, PR-006, PR-016 | Append-only audit, provenance, export and release traceability evidence | Not started |
| WOS-OPS-001–010 | PR-003, PR-005, PR-015, PR-016 | Build/container, startup, migration, backup/restore, monitoring and handover evidence | Not started |
| WOS-NFR-SEC-001–014 | PR-003, PR-005, PR-006, PR-009, PR-010, PR-012, PR-013, PR-014, PR-016 | Threat-boundary, authentication/authorization, secure-configuration, secret/dependency and negative-security evidence | Blueprint |
| WOS-NFR-PRV-001–006 | PR-004, PR-008, PR-010, PR-012, PR-013, PR-014, PR-016 | Data-minimization, sensitive-field scope, retention/anonymization and privacy-export evidence | Blueprint |
| WOS-NFR-REL-001–009 | PR-005, PR-006, PR-008, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Fail-closed startup, transaction/idempotency, recovery and exact-head reliability evidence | Blueprint |
| WOS-NFR-PERF-001–008 | PR-006, PR-008, PR-011, PR-012, PR-013, PR-015, PR-016 | Pagination/query-index review, job/export bounds and Standard-profile performance evidence | Blueprint |
| WOS-NFR-DAT-001–008 | PR-004, PR-007, PR-008, PR-009, PR-010, PR-011, PR-012, PR-013, PR-016 | Ownership, temporal integrity, precision, constraints, snapshot and reconciliation evidence | Blueprint |
| WOS-NFR-MNT-001–008 | PR-002 through PR-016 | Module boundaries, typed contracts, complexity controls, documentation and maintainability evidence in every affected PR | Blueprint |
| WOS-NFR-DPL-001–007 | PR-003, PR-005, PR-015, PR-016 | Container/environment portability, explicit migration and production deployment evidence | Blueprint |
| WOS-NFR-OBS-001–006 | PR-005, PR-006, PR-009, PR-011, PR-012, PR-013, PR-015, PR-016 | Correlation, structured logging, job/integration health, audit-safe monitoring and alert evidence | Blueprint |
| WOS-NFR-UX-001–006 | PR-003, PR-004, PR-008, PR-009, PR-012, PR-013, PR-016 | Accessibility, responsive role journeys, terminology/locale and understandable error evidence | Blueprint |
| WOS-NFR-CMP-001–004 | PR-003, PR-004, PR-006, PR-008, PR-013, PR-014, PR-016 | Browser/API/version compatibility and provider-neutral integration evidence | Blueprint |
| WOS-NFR-RELSE-001–005 | PR-002 through PR-016 | Version, changelog, migration/rollback, exact-artifact and release-evidence controls | Blueprint |

## 3. Work-package traceability

PR identifiers after PR #1 are planned sequence identifiers until the GitHub PR is opened.

| Work package | Requirement groups | GitHub issue | Pull request | Exact accepted commit | Release | Status |
|---|---|---|---|---|---|---|
| WOS-00 | Programme/architecture/NFR/control artifacts | #2 | PR #1 | Pending Gate B/merge | v0.1.0 | In review |
| WOS-01A | Source provenance/bootstrap | #3 | Planned PR-002 | Pending | v0.2.0 | Blocked by Gate B |
| WOS-01B | Neutral branding/configuration | #3 | Planned PR-003 | Pending | v0.2.0 | Not started |
| WOS-02 | Organization/setup | #4 | Planned PR-004 | Pending | v0.4.0 | Not started |
| WOS-03A | CI/migration/deployment foundation | #5 | Planned PR-005 | Pending | v0.4.0 | Not started |
| WOS-03B | Modular/API foundation | #5 | Planned PR-006 | Pending | v0.4.0 | Not started |
| WOS-04A | Contracts/engagements | #6 | Planned PR-007 | Pending | v0.5.0 | Not started |
| WOS-04B | Assignments/work capture | #6 | Planned PR-008 | Pending | v0.5.0 | Not started |
| WOS-05 | Approval/policy engine | #7 | Planned PR-009 | Pending | v0.5.0 | Not started |
| WOS-06A | Rates/costs/terms | #8 | Planned PR-010 | Pending | v0.7.0 | Not started |
| WOS-06B | Commercial engine | #8 | Planned PR-011 | Pending | v0.7.0 | Not started |
| WOS-06C | Invoice readiness | #8 | Planned PR-012 | Pending | v0.7.0 | Not started |
| WOS-07 | Reports/leakage/adapters | #9 | Planned PR-013 | Pending | v0.8.0 | Not started |
| WOS-08A | Security/identity | #10 | Planned PR-014 | Pending | v0.9.0 | Not started |
| WOS-08B | Operations/recovery/performance | #10 | Planned PR-015 | Pending | v0.9.0 | Not started |
| WOS-09 | v1 acceptance/handover | #11 | Planned PR-016 | Pending | v1.0.0 | Not started |

## 4. WOS-00 documentation evidence

| Evidence ID | Evidence | Status |
|---|---|---|
| DOC-WOS-00-001 | Required-file inventory and controller cross-document review | Active in PR #1 |
| DOC-WOS-00-002 | First independent Codex/Sol review and review-resolution mapping | First review complete; corrected-head re-review pending |
| DOC-WOS-00-003 | Owner Gate B decision | Pending |

## 5. Evidence taxonomy

Use stable evidence IDs:

| Prefix | Evidence type |
|---|---|
| `UT-` | Unit/domain test |
| `API-` | API/contract test |
| `AUTH-` | Authorization/negative-scope test |
| `MIG-` | Fresh/upgrade migration evidence |
| `BWR-` | Browser role journey |
| `FIN-` | Financial golden vector/reconciliation |
| `SEC-` | Security scan/review/threat-model evidence |
| `PERF-` | Performance/load evidence |
| `OPS-` | Deployment, monitoring, backup/restore evidence |
| `DOC-` | Documentation/provenance/consistency evidence |
| `UAT-` | Production-like user acceptance evidence |

Evidence files should live under a versioned release-evidence structure once implementation begins, for example:

```text
docs/evidence/
  v0.2.0/
  v0.4.0/
  v0.5.0/
  v0.7.0/
  v0.8.0/
  v0.9.0/
  v1.0.0/
```

Generated evidence containing secrets, personal data or bulky transient artifacts must not be committed. Store a safe summary and reference the controlled external evidence location where needed.

## 6. Requirement acceptance states

| State | Meaning |
|---|---|
| Blueprint | Requirement defined and mapped, no implementation accepted |
| In progress | Active branch/PR exists; no accepted credit |
| Engineering ready | Implementation/tests merged, but environment/UAT/release evidence remains |
| Accepted | All defined evidence and approvals are complete at an exact commit |
| Deferred | Explicitly removed from current release with rationale |
| Rejected | Decision made not to implement; requirement/decision record updated |

## 7. PR traceability template

Every implementation PR body must include:

```markdown
## Requirements
- WOS-...

## Evidence
- UT-...
- API-...
- AUTH-...
- MIG-...
- BWR-...

## Exact-head acceptance
- Head SHA: ...
- Required checks: ...
- Known limitations: ...
```

## 8. v1 acceptance summary

To be completed by PR-016:

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
