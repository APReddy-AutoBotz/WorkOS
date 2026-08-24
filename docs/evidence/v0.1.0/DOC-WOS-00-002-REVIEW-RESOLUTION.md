# DOC-WOS-00-002 — Independent Review Resolution

**Workstream:** WOS-00 / WOS-00F corrective closure  
**Governing issue:** #2  
**Corrective issue:** #13  
**Historical merged pull request:** #1  
**Active corrective pull request:** #14  
**Active branch:** `controller/wos-00f-approval-controls`  
**Historical merged baseline:** `main@880b3dc244bf516c4e535fb68e455e6153aec395`  
**Status:** Original blueprint reviews and subsequent WOS-00F corrective reviews are recorded below. WOS-00 remains under corrective hold; the current corrective head must receive a fresh independent review with no P0/P1/P2 before Ready/merge. No review summarized in this writer task is itself a clean-final acceptance.

## 1. Reviewed heads and review IDs

Rounds 1–13 are the original PR #1 blueprint review sequence. Round 14 is the post-merge review that triggered WOS-00F. Rounds 15 onward are PR #14 corrective exact-head reviews. Same-head re-reviews are recorded separately because they produced distinct findings.

| Round | Reviewed head | Review ID(s) | Findings / disposition |
|---:|---|---|---|
| 1 | `492715dc8a40de6431365b6e52378d317721f617` | `PRR_kwDOUAv8Lc8AAAABKhE2vA` | Five P1, two P2; corrected |
| 2 | `c2e3dbb74bc7c78a8f946222497850ac0c49ac78` | `PRR_kwDOUAv8Lc8AAAABKhJrmQ` | Two P1; corrected |
| 3 | `1f36b49461b86516b5855dbf9930a75f234b58e1` | `PRR_kwDOUAv8Lc8AAAABKhMTmA` | One P1; corrected |
| 4 | `9fc70babdf7c4d5c72f9d18a54f8c2318c903b3b` | `PRR_kwDOUAv8Lc8AAAABKhNcnA` | One P1; corrected |
| 5 | `649db270e8d43af152076e1f99e07c7204c575fc` | `PRR_kwDOUAv8Lc8AAAABKhROXA` | Two P1; corrected |
| 6 | `7124709e4f6682ded0321c58d22a6851a5e32b9d` | `PRR_kwDOUAv8Lc8AAAABKhU3Ng`, `PRR_kwDOUAv8Lc8AAAABKhVa0Q` | Four P1, two P2; corrected |
| 7 | `76f05c9da71d21b1f774afc91e13dad4323d6358` | `PRR_kwDOUAv8Lc8AAAABKh3paA` | Two P1; corrected |
| 8 | `b30ec6f921262602edcab9e9d96a2dbb1c8571b2` | `PRR_kwDOUAv8Lc8AAAABKh6Tsg` | Two P1; corrected |
| 9 | `be42c047f6bcf2d4aa3476a7368bea04ebff1e70` | `PRR_kwDOUAv8Lc8AAAABKh-0NA` | One P1, one P2; corrected |
| 10 | `d0e20c82c9ff3e9df4cfd14668024f7a4663c5a8` | `PRR_kwDOUAv8Lc8AAAABKh_5pA` | Three P2; corrected |
| 11 | `cd45de9181858d722e2974e92d6aaa53ba04ec17` | `PRR_kwDOUAv8Lc8AAAABKiBoBw` | Two P1, one P2; corrected |
| 12 | `a023ebef80fad7aea354f3759801a430de18cb6e` | Review/timeline `PRR_kwDOUAv8Lc8AAAABKiJB1g`; actionable thread `PRRT_kwDOUAv8Lc6bdgWF` | One P1; corrected |
| 13 | `86484cde78f1350a4a0a3f55f368f2e919353663` | `PRR_kwDOUAv8Lc8AAAABKiIDxA` | One P1, one P2; corrected |
| 14 | `e8e05e0f17e78e7ef19a35c078601ebda5881a45` | `PRR_kwDOUAv8Lc8AAAABKiPf2w` | Post-merge one P1 + one P2; triggered WOS-00F |
| 15 | `039789b7860d38115c7dfbd39dd26c0a36314a6a` | `PRR_kwDOUAv8Lc8AAAABKkn3EA` | Three P2; corrected |
| 16 | `78d89bc3a4cda87354eb3e494ea8c816bd2f5bbf` | `PRR_kwDOUAv8Lc8AAAABKlyssg` | Two P2; corrected |
| 17 | `78d89bc3a4cda87354eb3e494ea8c816bd2f5bbf` | `PRR_kwDOUAv8Lc8AAAABKl2Ozw` | Two P2; corrected |
| 18 | `c6185a7f5b39dda71c4198c305263e65e85f8264` | `PRR_kwDOUAv8Lc8AAAABKnPSiQ` | Three P2; corrected |
| 19 | `c6185a7f5b39dda71c4198c305263e65e85f8264` | `PRR_kwDOUAv8Lc8AAAABKnm5YA` | Two P2; corrected |
| 20 | `81f58a01d980031c87415bf5ba5347ec39877eed` | `PRR_kwDOUAv8Lc8AAAABKpzHEw` | Two P2; Round-19 authority follow-up in progress |
| 21 | `81f58a01d980031c87415bf5ba5347ec39877eed` | `PRR_kwDOUAv8Lc8AAAABKp-K9w` | One P2; Round-19 authority follow-up in progress |

## 2. Resolution summary by review round

### Rounds 1–5 — blueprint product/commercial/billing foundations

- Assigned workforce, CORE and every NFR family to implementation/evidence owners.
- Defined all approved-unbilled source families and exclusive source → eligibility event → approved-unbilled item → line/batch lineage.
- Made operational earned-management explicitly non-statutory and fail-closed without an authorized effective-dated policy.
- Removed owner-only transaction strategy and undefined Gate A language.
- Replaced direct source/snapshot-to-invoice lineage with the versioned billing-eligibility/register boundary.
- Moved Gate C after complete PR-010/011/012 delivery and independently proven PR-012 engineering acceptance.
- Defined canonical invoice-batch state, occupancy, failed-export, cancellation and correction semantics.

### Rounds 6–10 — export, identity, notification and governing consistency

- Made initial provider/CSV delivery `Approved`-only and final states retrieval/status-only.
- Defined immutable provider-independent CSV acceptance and control totals.
- Assigned complete notification delivery to PR-013 and identity hardening to PR-014.
- Required production OIDC/named accounts universally with fail-closed behavior and no local/shared production fallback.
- Added four notification policy classes and thirteen canonical event/template/default-recipient rows.
- Required independent PR-012 engineering acceptance before Gate C.
- Aligned reporting/export behavior and current Gate B state.
- Replaced transitional OIDC wording across architecture/decision/security/NFR authorities.

### Rounds 11–13 — terminology, event exclusivity and no-double-billing hardening

- Removed statutory-recognition ambiguity from fixed-fee operational earned-management wording.
- Made `approval.action_required`, `commercial.approval_required` and `invoice_batch.action_required` mutually exclusive by trigger boundary.
- Established database-enforced unique current occupancy for each approved-unbilled-item ID/version.
- Required same-batch, cross-batch, concurrent, idempotency, route-bypass, split-line, cancellation/re-batching and final-occupancy vectors in PR-012 evidence.
- Brought review/status/traceability evidence through Round 13.

### Round 14 — post-merge WOS-00F trigger

Review `PRR_kwDOUAv8Lc8AAAABKiPf2w` occurred after PR #1 had already merged. It identified:

- **P1:** generic invoice-batch approval reopen conflicted with the canonical invoice-batch lifecycle;
- **P2:** generic rejection/correction notification omitted applicable source owners.

WOS-00F PR #14 was created as the bounded corrective vehicle. The historical `main@880b3dc244bf516c4e535fb68e455e6153aec395` baseline was placed under corrective hold and WOS-01A PR #12 was dependency-blocked.

### Round 15 — canonical recipient/status convergence

Review `PRR_kwDOUAv8Lc8AAAABKkn3EA` found three P2s: stale canonical recipient matrices, incorrect proposed live-issue ownership and stale pre-merge implementation status. The authoritative matrices, issue map and primary status were aligned to PR #14 corrective authority.

### Rounds 16–17 — traceability, atomic recipient state, evidence and rollback

Reviews `PRR_kwDOUAv8Lc8AAAABKlyssg` and `PRR_kwDOUAv8Lc8AAAABKl2Ozw` found four P2s:

- stale WOS-00/WOS-01A primary traceability;
- protected recipient enqueue could leave partial internal state;
- verification outcomes were described prospectively rather than recorded;
- rollback wording could remove the corrective hold.

Corrections made protected event/in-app recipient state all-or-nothing, kept external delivery separately retriable, made status/traceability current, recorded executable evidence truthfully and required rollback to retain/re-establish the corrective hold.

### Rounds 18–19 — hold authority and verification truth

Review `PRR_kwDOUAv8Lc8AAAABKnPSiQ` found three P2s: residual WOS-01 authorization, forbidden-term scan contradiction and unsupported Mermaid PASS evidence. Review `PRR_kwDOUAv8Lc8AAAABKnm5YA` then found two P2s: authoritative backlog did not require corrected-main baseline recording before WOS-01A resume, and the retained adversarial evidence pass stopped at matrix H instead of A–I.

The correction superseded historical WOS-01-after-PR1-merge authorization, removed the non-allowlisted literal, classified Mermaid-aware validation as `NOT RUN` after registry HTTP 403, required corrected-main baseline recording and extended retained adversarial evidence through A–I.

### Rounds 20–21 — current-authority convergence

Reviews `PRR_kwDOUAv8Lc8AAAABKpzHEw` and `PRR_kwDOUAv8Lc8AAAABKp-K9w` of exact head `81f58a01d980031c87415bf5ba5347ec39877eed` identified three P2s:

1. `DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md` primary metadata/open gates still followed the historical PR #1/Round-13 workflow.
2. `DOC-WOS-00F-CORRECTION-REPORT.md` used an incomplete WOS-01A unblock prerequisite.
3. This `DOC-WOS-00-002` file itself retained stale PR #1/Round-13 primary metadata/table/open gates.

The bounded Round-19 writer aligns all three current authorities and the downstream release/task gates to the complete WOS-01A prerequisite. **This correction does not claim a clean review.**

## 3. Canonical notification policy and exclusivity

Policy classes remain:

- `ACTION_REQUIRED`
- `CONTROL_MANDATORY`
- `INFORMATIONAL`
- `OPERATIONAL_CRITICAL`

The thirteen canonical event/template keys remain:

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

A pending generic stage emits only `approval.action_required`; `commercial.approval_required` is pre-submission only; `invoice_batch.action_required` is non-approval remediation only; generic rejection/correction uses the single shared `approval.rejected_or_correction_required` event. One source entity/version/triggering operation may create at most one action-required event.

For `approval.rejected_or_correction_required`, the complete mandatory scoped recipient set is resolved before persistence. The canonical protected event identity, protected in-app recipient records and retained reason mappings commit atomically or leave zero successful protected-recipient mutation. Optional external email/collaboration delivery is downstream and separately retriable.

## 4. Cross-cutting corrections retained

- Leave/absence is availability-only and cannot become productive/billable work or reduce capacity twice.
- Operational earned-management revenue is non-statutory, policy-gated and never grants billing authority.
- Commercial lineage is source → eligibility event → approved-unbilled item → database-unique current occupancy → line/batch → accepted provider/CSV export.
- Initial export is `Approved`-only; failures remain `Approved`; final states are retrieval/status only.
- Production OIDC is mandatory and fail-closed; local/shared authentication is non-production/demo only.
- Gate B remains approved for the bounded WOS-00F correction but does not waive review, merge, baseline-recording or WOS-01A reauthorization controls.
- PR-013 owns complete notification delivery; PR-014 owns production identity/security evidence.

## 5. WOS-01A dependency law

Historical PR #1 having merged does not authorize WOS-01A. WOS-01A may resume only after **all five** conditions are satisfied:

1. PR #14 receives a fresh independent exact-head clean review with no P0/P1/P2 findings.
2. PR #14 is merged under an expected-head guard against that reviewed SHA.
3. The corrected exact `main` SHA is recorded as the accepted WOS-00 baseline.
4. The controller explicitly reauthorizes WOS-01A.
5. PR #12 is recreated or rebased from that corrected baseline before any source import resumes.

Until then PR #12 remains Draft, dependency-blocked and earns no implementation or acceptance credit.

## 6. Verification posture

| Check | Current result | Limitation |
|---|---|---|
| Gate B state and continuing blockers | PASS | Gate B remains valid only for bounded correction; fresh clean review still required |
| Gate C prerequisite | PASS | Runtime/product acceptance occurs in WOS-06 |
| Fixed-fee earned-management wording | PASS | Runtime vectors/evidence belong to PR-011 |
| Billing eligibility independent from earned-management | PASS | Runtime evidence belongs to PR-011/012 |
| Database-unique current occupancy and PR-012 vectors | PASS | Runtime/migration/concurrency evidence belongs to PR-012 |
| Approval-event exclusivity and protected-recipient atomicity | PASS | Implementation/replay evidence belongs to PR-009/013 |
| Thirteen canonical event/template rows | PASS | Runtime delivery evidence belongs to PR-013 |
| Approved-only initial finance delivery | PASS | Runtime evidence belongs to PR-012/013 |
| Mandatory production OIDC | PASS | Production startup/readiness evidence belongs to PR-014 |
| Requirement/NFR counts | PASS in latest documentation-safe writer evidence | Must be independently revalidated at the new exact head |
| Mermaid-aware validation | NOT RUN | Parser acquisition blocked by registry HTTP 403; no PASS claimed |
| Application build/runtime/API/migration/browser | SKIP / NOT RUN | WOS-00F is documentation/control-only |

Only the exact live GitHub head reviewed in GitHub counts as acceptance evidence. Local unpublished Codex commits are never acceptance evidence.

## 7. Gate B state

Product-owner Gate B approval is recorded in `DOC-WOS-00-003-GATE-B-APPROVAL.md`. Any historical authorization to begin WOS-01 after PR #1 merged is superseded by the WOS-00F corrective hold and the five-part WOS-01A dependency law above.

## 8. Open gates

- Publish the bounded Round-19 authority correction on PR #14.
- Run a **fresh independent Codex/Sol review of the exact resulting PR #14 GitHub head**.
- Any P0/P1/P2 finding blocks Ready/merge and requires another bounded correction plus re-review.
- Resolve or demonstrate obsolescence of all blocking review threads against the exact clean-reviewed head.
- Mark PR #14 Ready only after the repository-defined clean-review gate is satisfied.
- Squash-merge PR #14 using an expected-head guard.
- Record the corrected exact `main` SHA as the accepted WOS-00 baseline.
- Close issue #13 and return issue #2 to completed only after merge verification.
- Explicitly reauthorize WOS-01A and recreate or rebase PR #12 from the corrected baseline before source import resumes.
