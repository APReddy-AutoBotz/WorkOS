# DOC-WOS-00-002 — Independent Review Resolution

**Workstream:** WOS-00  
**Issue:** #2  
**Pull request:** #1  
**Status:** Eleven independent review rounds completed; all historical P1/P2 findings corrected; clean final exact-head re-review pending

## 1. Reviewed heads and review IDs

| Round | Reviewed head | Review ID(s) | Findings |
|---:|---|---|---|
| 1 | `492715dc8a40de6431365b6e52378d317721f617` | `PRR_kwDOUAv8Lc8AAAABKhE2vA` | Five P1, two P2 |
| 2 | `c2e3dbb74bc7c78a8f946222497850ac0c49ac78` | `PRR_kwDOUAv8Lc8AAAABKhJrmQ` | Two P1 |
| 3 | `1f36b49461b86516b5855dbf9930a75f234b58e1` | `PRR_kwDOUAv8Lc8AAAABKhMTmA` | One P1 |
| 4 | `9fc70babdf7c4d5c72f9d18a54f8c2318c903b3b` | `PRR_kwDOUAv8Lc8AAAABKhNcnA` | One P1 |
| 5 | `649db270e8d43af152076e1f99e07c7204c575fc` | `PRR_kwDOUAv8Lc8AAAABKhROXA` | Two P1 |
| 6 | `7124709e4f6682ded0321c58d22a6851a5e32b9d` | `PRR_kwDOUAv8Lc8AAAABKhU3Ng`, `PRR_kwDOUAv8Lc8AAAABKhVa0Q` | Four P1, two P2 |
| 7 | `76f05c9da71d21b1f774afc91e13dad4323d6358` | `PRR_kwDOUAv8Lc8AAAABKh3paA` | Two P1 |
| 8 | `b30ec6f921262602edcab9e9d96a2dbb1c8571b2` | `PRR_kwDOUAv8Lc8AAAABKh6Tsg` | Two P1 |
| 9 | `be42c047f6bcf2d4aa3476a7368bea04ebff1e70` | `PRR_kwDOUAv8Lc8AAAABKh-0NA` | One P1, one P2 |
| 10 | `d0e20c82c9ff3e9df4cfd14668024f7a4663c5a8` | `PRR_kwDOUAv8Lc8AAAABKh_5pA` | Three P2 |
| 11 | `cd45de9181858d722e2974e92d6aaa53ba04ec17` | `PRR_kwDOUAv8Lc8AAAABKiBoBw` | Two P1, one P2 |

## 2. Resolution map by review round

### Round 1

| Finding | Severity | Resolution |
|---|---|---|
| Workforce requirements lacked explicit implementation owners | P1 | Split WOS-WKF ownership across PR-004 and PR-008 with concrete evidence |
| NFR families lacked concrete ownership | P1 | Mapped all eleven NFR families to accountable planned PRs/evidence |
| Approved-unbilled omitted non-T&M sources | P1 | Defined T&M, milestone, fixed-fee, retainer, managed-service and adjustment eligibility |
| Neutral revenue policy was undefined | P1 | Defined non-statutory operational earned-management profiles and fail-closed non-T&M default |
| Owner-only transaction strategy appeared in product docs | P1 | Removed pricing/licence/sale defaults; retained only a neutral external legal/commercial gate |
| Forbidden-term allowlist was not reproducible | P2 | Neutralized literals outside approved provenance/control files |
| Gate A was claimed but undefined | P2 | Removed Gate A as a formal acceptance gate; formal gates remain B, C and D |

### Round 2

| Finding | Severity | Resolution |
|---|---|---|
| CORE-004/005/008 lacked explicit work-package ownership | P1 | Added CORE ownership across PR-004 and PR-006 through PR-014 with evidence |
| Architecture allowed unconditional snapshot-to-invoice lineage | P1 | Added source-specific eligibility event and approved-unbilled register boundary |

### Round 3

| Finding | Severity | Resolution |
|---|---|---|
| Domain model retained a direct snapshot-to-line edge | P1 | Replaced it with versioned billing-event → approved-unbilled item → line/batch relationships |

### Round 4

| Finding | Severity | Resolution |
|---|---|---|
| Requirements/derived docs still permitted raw-source/snapshot line traceability | P1 | Made the versioned approved-unbilled item the sole batchable object and added direct-bypass rejection throughout requirements, architecture, specifications, tests and PR-012 |

### Round 5

| Finding | Severity | Resolution |
|---|---|---|
| Gate C appeared before PR-012 | P1 | Moved Gate C after complete PR-010/011/012 delivery and independently proven PR-012 engineering acceptance |
| Invoice-batch state/occupancy semantics were ambiguous | P1 | Defined canonical states, occupying classes, transitions, terminal behavior, failed export, pre-export cancellation and versioned corrections |

### Round 6

| Finding | Severity | Resolution |
|---|---|---|
| Playbook Gate C wording remained incomplete | P1 | Aligned playbook with full WOS-06 and PR-012 prerequisite |
| Initial export could originate from final states | P2 | Made initial provider/CSV delivery `Approved`-only; final states are retrieval/status only |
| Review traceability lagged | P2 | Updated traceability/status/evidence history |
| CSV acceptance had no provider-independent semantics | P1 | Defined immutable CSV artifact, metadata/control totals, atomic transition and idempotency |
| Notification delivery had no implementation owner | P1 | Assigned complete notification scope to PR-013/issue #9 |
| ADR-007 allowed production local-auth fallback | P1 | Production OIDC is fail-closed; local auth remains non-production/demo only |

### Round 7

| Finding | Severity | Resolution |
|---|---|---|
| Release acceptance did not explicitly require independent PR-012 engineering acceptance before Gate C | P1 | `RELEASE_ACCEPTANCE_CRITERIA.md` requires PR-010/011/012 merged and PR-012 engineering acceptance independently proven at an exact head before Gate C. Gate C is additional owner acceptance and cannot substitute for engineering evidence. |
| WOS-INT-002 lacked an executable notification event/template/default-recipient matrix | P1 | Added four policy classes and thirteen canonical event/template keys with triggers, default relationship recipients, preference/mandatory behavior, evidence fields, protected extensions and deterministic tests. |

### Round 8

| Finding | Severity | Resolution |
|---|---|---|
| Reporting specification allowed a new finance export from “approved or finalized” batch lines | P1 | Initial provider/CSV delivery is now `Approved`-only. `Exported` and `Billed/Confirmed` support only idempotent retrieval/redownload of the accepted artifact or downstream-status confirmation and cannot create another delivery. |
| Security architecture made production OIDC optional through “where configured” wording | P1 | `SECURITY_ARCHITECTURE.md` now requires configured OIDC and named accounts for every production deployment; missing, invalid or unavailable OIDC fails closed; local/shared demo authentication is non-production/demo only. |

### Round 9

| Finding | Severity | Resolution |
|---|---|---|
| Security/privacy and NFR quality baselines still made production OIDC optional | P1 | `SECURITY_PRIVACY_COMPLIANCE.md` and `NON_FUNCTIONAL_REQUIREMENTS.md` now require named accounts and configured OIDC for every production deployment. Missing, invalid or unavailable OIDC fails startup/readiness and authentication closed. WorkOS local credentials and shared/demo identities are restricted to approved non-production/demo profiles, must be disabled or absent in production and cannot become a production fallback. Production OIDC is marked mandatory in the environment schema and exact release evidence. |
| Controller evidence still reported only the first review and pending Gate B | P2 | `DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md` became the current consolidated controller record, linked this detailed review authority, recorded the review history and Gate B approval, and left only the moved-head review and merge open. |

### Round 10

| Finding | Severity | Resolution |
|---|---|---|
| Authoritative programme charter still described Gate B as pending | P2 | `PROGRAM_CHARTER.md` records the product owner's 2026-08-23 Gate B approval, links `DOC-WOS-00-003`, and preserves the clean-review, source-import and merge controls. |
| Current controller evidence understated the represented review rounds | P2 | `DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md` now points to this complete review authority and records the current round count. |
| Architecture ADR summary said “move toward OIDC” | P2 | `ARCHITECTURE_OVERVIEW.md` states the adopted ADR-007 decision: configured OIDC, named accounts and revocable sessions are required for every production deployment; WorkOS local/shared demo authentication is non-production/demo only with no fallback. |

### Round 11

| Finding | Severity | Resolution |
|---|---|---|
| WOS-COM-007 used “recognized/earned value” wording that could authorize statutory revenue-recognition behavior | P1 | WOS-COM-007 now requires fixed-fee tracking of contract value, billing schedule, effort/cost and margin risk, permits only explicitly **non-statutory operational earned-management revenue** under an authorized effective-dated WOS-COM-011 policy, fails closed when no policy is active, and keeps approved hours, billing eligibility and invoice readiness independent. PR-011 scope and financial golden vectors carry the same boundary. |
| Commercial and invoice-batch domain events overlapped `approval.action_required`, allowing two action-required notifications for one pending approval transition | P1 | WOS-INT-002 now defines mutually exclusive trigger boundaries. `approval.action_required` is the sole action-request event whenever a valid generic stage is pending. `commercial.approval_required` is only a pre-submission requester/change-owner prompt. `invoice_batch.action_required` is only non-approval batch-owner remediation. One source/version/operation may create at most one action-required event. Integration architecture, approval specification, test strategy, PR-009/013 backlog and issue #9 are aligned with positive/negative exclusivity and replay-idempotency evidence. |
| Accepted OIDC decision retained transitional wording in the decision log | P2 | WOS-DEC-018 now records the adopted requirement for configured OIDC, named production accounts and revocable sessions in every production deployment; missing, invalid or unavailable OIDC fails closed and WorkOS local/shared demo identities remain approved non-production/demo only with no production fallback. |

## 3. Canonical notification policy and exclusivity

Policy classes:

- `ACTION_REQUIRED`
- `CONTROL_MANDATORY`
- `INFORMATIONAL`
- `OPERATIONAL_CRITICAL`

Canonical event/template keys:

1. `work_period.submission_due`
2. `work_period.submission_overdue`
3. `approval.action_required`
4. `approval.rejected_or_correction_required`
5. `approval.completed`
6. `approval.overdue_or_escalated`
7. `assignment.created_or_materially_changed`
8. `commercial.approval_required`
9. `commercial.risk_threshold_breached`
10. `invoice_batch.action_required`
11. `invoice_batch.export_failed`
12. `invoice_batch.exported_or_billed_confirmed`
13. `integration.delivery_failed_or_degraded`

Every event has a canonical/template key, version, source entity/version and operation, organization/legal-entity scope, server-resolved recipient relationship/reason, policy class, channel decision, locale/approved variables, idempotency identity and delivery-attempt/correlation evidence. Client recipients remain out of v1 scope. Protected buyer extensions cannot remove a mandatory recipient or downgrade a mandatory class below the governing requirement.

Approval-event boundaries are authoritative:

- A pending generic stage emits only `approval.action_required` to current-stage approvers.
- `commercial.approval_required` occurs only before generic approval submission and resolves the requester/change owner, never current approvers.
- `invoice_batch.action_required` occurs only for non-approval pre-submission/remediation work and never for pending approval or generic rejection/correction.
- A source entity/version and triggering operation may create at most one action-required notification event.

## 4. Cross-cutting corrections retained

- Leave/absence is availability-only and cannot become productive/billable work or reduce capacity twice.
- PR-002 cannot merge a prohibited company-specific runtime; cleanup occurs in PR-002 or only the combined clean PR-003 state may merge.
- Operational earned-management revenue is non-statutory, policy-gated and never grants billing authority.
- Commercial lineage is source → eligibility event → approved-unbilled item → line/batch → accepted provider/CSV export.
- Initial export is `Approved`-only; failures remain `Approved`; final states are retrieval/status only.
- Production OIDC is mandatory and fail-closed in charter, decision log, architecture, security/privacy and NFR quality baselines; WorkOS local/shared authentication is non-production/demo only.
- Gate B is approved but source import and WOS-01 remain blocked until clean review and blueprint merge.
- PR-013 owns complete notification delivery; PR-014 owns production identity/security evidence.

## 5. Controller verification after Round 11

| Check | Controller result | Limitation |
|---|---|---|
| Gate B state and continuing blockers | PASS | Clean independent rerun required at final head |
| Gate C prerequisite | PASS | Runtime/product acceptance occurs in WOS-06 |
| Fixed-fee earned-management wording | PASS | Runtime vectors/evidence belong to PR-011 |
| Billing eligibility independent from earned-management | PASS | Runtime evidence belongs to PR-011/012 |
| Approval-event exclusivity | PASS | Implementation and replay evidence belongs to PR-009/013 |
| Thirteen canonical event/template rows | PASS | Independent count/consistency rerun required |
| Approved-only initial finance delivery | PASS | Runtime evidence belongs to PR-012/013 |
| Final-state retrieval/status-only semantics | PASS | Runtime idempotency evidence belongs to PR-012/013 |
| Mandatory production OIDC across governing, architecture and quality documents | PASS | Production startup/readiness evidence belongs to PR-014 |
| Current controller evidence and eleven-round history | PASS | Clean final review/merge remain open |
| Requirement/NFR counts | Pending independent rerun | Must confirm 126/81 at exact head |
| Application tests | SKIP | WOS-00 intentionally has no application source |
| Shell/documentation-safe checks | NOT RUN by controller connector | Mandatory in clean final Codex/Sol review |

## 6. Publication note

Codex correction tasks sometimes produced local commits that could not be pushed through their task checkout. The implementation controller materialized the approved corrections through the connected GitHub controller interface. Local Codex SHAs are not acceptance evidence; only the exact live GitHub PR head reviewed in GitHub counts.

## 7. Gate B state

Product-owner Gate B approval is recorded in `DOC-WOS-00-003-GATE-B-APPROVAL.md`. It authorizes the controller to complete non-material review corrections, obtain the clean final exact-head review, squash-merge PR #1, establish `v0.1.0` and begin WOS-01. The approval does not waive the clean-review or exact-head merge controls.

## 8. Open gates

- Fresh clean independent Codex/Sol review at the exact moved GitHub head.
- Resolution of any remaining blocking finding.
- Exact-head squash merge and `v0.1.0` baseline.
