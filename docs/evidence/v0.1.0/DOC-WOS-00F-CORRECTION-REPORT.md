# WOS-00F correction report

## Outcome and requirements

This documentation-only correction addresses the WOS approval, invoice and integration requirement families. It closes the Round-14 P1/P2 governing defects and subsequent PR #14 P2 convergence findings: invoice-batch approval is final for its batch version, successor correction paths preserve immutable history, and rejection/correction recipients are bounded, authoritative, source-owner aware, deduplicated and fail closed. PR-009, PR-012 and PR-013 retain their respective implementation and evidence ownership.

`main@880b3dc244bf516c4e535fb68e455e6153aec395` remains the historical merged WOS-00 baseline under corrective hold. Draft PR #14 is the active WOS-00F correction. WOS-01A PR #12 remains dependency-blocked and earns no implementation credit until **all** of the following are complete: (1) PR #14 is independently clean-reviewed with no P0/P1/P2 findings; (2) PR #14 is merged under an expected-head guard; (3) the corrected exact `main` SHA is recorded as the accepted WOS-00 baseline; (4) the controller explicitly reauthorizes WOS-01A; and (5) PR #12 is recreated or rebased from that corrected baseline before any source import resumes. Opening or retaining a Draft PR does not confer implementation or merge authority.

## Verification classification

| Check | Outcome | Executable evidence |
|---|---|---|
| Required WOS-00 inventory/substantive content | PASS | Repository Python inventory validator confirmed every task-referenced document exists and has substantive content. |
| Product requirements / NFRs / family mappings | PASS | Python/`rg` identifier validation found exactly 126 unique product IDs, 81 unique NFR IDs, and all product/NFR families mapped. |
| ADR-001–008 structure | PASS | Repository Python ADR validator confirmed all eight ADRs contain status and decision content. |
| Relative Markdown links | PASS | Repository Python relative-link validator resolved documentation-relative targets. |
| Issue-template front matter | PASS | Repository Python validator accepted all three issue templates. |
| Mermaid-aware validation | NOT RUN | Eleven Mermaid blocks were extracted, but `npx --yes -p @mermaid-js/mermaid-cli mmdc` could not obtain the parser because the package registry returned HTTP 403. Markdown fence balancing is not Mermaid validation and no Mermaid PASS is claimed. |
| Forbidden-term allowlist | PASS | Repository-wide allowlist validation found the reference-company term only in approved provenance/control locations; the non-allowlisted status literal was removed. |
| Owner-only strategy / credential-like values | PASS | Added-line scans reported no prohibited introduced value. |
| Documentation-only corrective scope | PASS | The corrective commits introduce no application, dependency, migration, helper or workflow file. |
| Focused lifecycle, notification, atomicity and A–I adversarial assertions | PASS | Focused assertions cover approval finality, occupancy, bounded authorization, atomic zero-partial recipient state, corrected retry, external-channel isolation, event exclusivity, corrective-hold supersession, baseline-recording prerequisite and retained authority/evidence consistency. |
| Whitespace integrity | PASS | `git diff --check` in the writer checkout. |
| Application build/runtime/API/migration/browser | SKIP / NOT RUN | Documentation/control-only diff contains no runnable artifact, schema, dependency or deployment change. |

No CI/status context exists for this documentation-only corrective branch; locally executed documentation-safe commands are the evidence and no nonexistent CI pass is claimed.

## Live issue ownership and post-publication updates

The issue map is authoritative and must not cross-assign later-workstream responsibilities:

- **#2 — WOS-00 governing baseline:** record the WOS-00F corrective hold, PR #14 exact review/merge state, and the corrected baseline SHA only after merge. #2 owns governance/baseline status, not PR-009/012/013 implementation detail.
- **#3 — WOS-01 source bootstrap and neutral product foundation:** record only the dependency block and exact corrected WOS-00 prerequisite. PR #12 remains Draft and blocked until the complete five-part WOS-01A prerequisite is satisfied: clean PR #14 review, guarded merge, corrected-main SHA recording, explicit controller reauthorization, and recreation/rebase of PR #12 from that baseline. #3 does not own approval, invoice-readiness or notification implementation.
- **#7 — WOS-05 / PR-009 approval and policy engine:** record invoice-batch approval finality, no generic reopen after `Approved`, valid pre-approval correction/rejection, stable reopen conflicts, and generic rejection/correction recipient-resolution responsibilities that belong to the approval engine.
- **#8 — WOS-06 / PR-012 commercial and invoice readiness:** record the canonical invoice-batch lifecycle, protected pre-export cancellation/replacement, immutable occupancy/history, failed-export behavior, post-export reversal/supersession and new correction batch/approval evidence.
- **#9 — WOS-07 / PR-013 reporting, notifications and integrations:** record the source-owner-aware canonical `approval.rejected_or_correction_required` recipient matrix, atomic protected-recipient persistence, identity deduplication/reason retention, fail-closed mandatory relationship resolution, caller redirection/omission denial, replay/idempotency and mutual exclusion from the two domain action events.

Issue #13 owns the bounded WOS-00F correction itself. Draft PR #14 may be marked Ready or merged only after a fresh independent exact-head review reports no P0/P1/P2 findings and all blocking threads are resolved. Original PR #1 post-merge threads remain historical evidence and may be resolved only after the corrective content reaches `main`.

## PR #14 review convergence

Review `PRR_kwDOUAv8Lc8AAAABKkn3EA` of head `039789b7860d38115c7dfbd39dd26c0a36314a6a` identified three P2 consistency gaps: stale canonical recipient rows, cross-assigned issue ownership and stale pre-merge implementation status. Those were corrected.

Reviews `PRR_kwDOUAv8Lc8AAAABKlyssg` and `PRR_kwDOUAv8Lc8AAAABKl2Ozw` of exact head `78d89bc3a4cda87354eb3e494ea8c816bd2f5bbf` identified four active P2s: stale primary traceability, atomic protected-recipient persistence, executable verification outcomes and rollback truth. Those were corrected.

Review `PRR_kwDOUAv8Lc8AAAABKnPSiQ` of exact head `c6185a7f5b39dda71c4198c305263e65e85f8264` identified three P2s: stale WOS-01 authorization, a forbidden-term scan contradiction and Mermaid validation overclaim. The Round-18 convergence superseded the historical authorization, removed the non-allowlisted status literal, classified genuine Mermaid validation as `NOT RUN`, required corrected-main baseline recording and extended the retained adversarial pass through matrix A–I.

Reviews `PRR_kwDOUAv8Lc8AAAABKpzHEw` and `PRR_kwDOUAv8Lc8AAAABKp-K9w` of exact head `81f58a01d980031c87415bf5ba5347ec39877eed` then identified three P2 authority inconsistencies: the consolidated controller record retained stale PR #1/Round-13 primary state, this correction report used an incomplete WOS-01A unblock prerequisite, and `DOC-WOS-00-002` retained stale primary PR #1/Round-13 authority. The Round-19 follow-up corrects these authority defects. It does **not** claim a clean final review; a fresh independent exact-head review of the resulting GitHub head remains mandatory.

## WOS-01A dependency law

No governing, evidence, issue or task document may authorize WOS-01A merely because historical PR #1 merged. The only valid resume sequence is:

1. PR #14 receives an independent exact-head clean review with no P0/P1/P2.
2. PR #14 is merged using an expected-head guard against that reviewed SHA.
3. The corrected exact `main` SHA is recorded as the accepted WOS-00 baseline.
4. The controller explicitly reauthorizes WOS-01A.
5. PR #12 is recreated or rebased from that corrected baseline before source import or implementation resumes.

If any one condition is missing, PR #12 remains Draft and dependency-blocked.

## Security and rollback

The server remains authoritative for source state, protected authority, recipient relationships and data scope. The complete mandatory recipient set is resolved and authorized before the canonical event identity, protected in-app records and recipient-reason mappings commit atomically. Any mandatory relationship or protected persistence failure leaves zero successful protected mutation; callers cannot redirect or omit recipients. Identity deduplication retains all applicable recipient reasons or approved deterministic precedence. Corrected retry creates the complete set exactly once. Optional external delivery is downstream and independently retriable. The generic rejection/correction event is mutually exclusive for the same decision with `commercial.approval_required` and `invoice_batch.action_required`.

Rollback must reverse only the defective substantive correction while retaining, or explicitly re-establishing in the same guarded change, the WOS-00F corrective hold, Draft PR #14 review gate and PR #12 dependency block. A plain revert is forbidden because the parent does not contain the corrective hold and therefore cannot restore it. Rollback does not delete or rewrite approval, batch, membership, notification or audit history. No schema, runtime, dependency, deployment or reference-repository change is included.
