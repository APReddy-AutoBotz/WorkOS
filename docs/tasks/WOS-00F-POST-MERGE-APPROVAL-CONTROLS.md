# WOS-00F — Post-merge approval-control correction

## Objective

Correct the post-merge governing defects identified after WOS-00 PR #1 was merged into `main@880b3dc244bf516c4e535fb68e455e6153aec395` and close the resulting authority/evidence inconsistencies before WOS-01A can resume.

This task is documentation/control-only. It must not import application source or access/modify `APReddy-AutoBotz/Boundaryless-WorkOS`.

## Starting authority

- Repository: `APReddy-AutoBotz/WorkOS`
- Historical base: `main@880b3dc244bf516c4e535fb68e455e6153aec395`
- Active branch: `controller/wos-00f-approval-controls`
- Corrective issue: #13
- Governing issue: #2
- Historical merged PR: #1
- Active corrective PR: #14
- Source WOS-00 reviewed head that triggered WOS-00F: `e8e05e0f17e78e7ef19a35c078601ebda5881a45`
- Original P1 thread: `PRRT_kwDOUAv8Lc6beCXL`
- Original P2 thread: `PRRT_kwDOUAv8Lc6beCXQ`
- WOS-01A PR #12 is Draft and dependency-blocked under the complete five-part dependency law below.

## WOS-01A dependency law

Historical PR #1 having merged does **not** authorize WOS-01A. WOS-01A may resume only after all five conditions are complete:

1. PR #14 receives a fresh independent exact-head Codex/Sol review with no P0/P1/P2 findings.
2. PR #14 is merged under an expected-head guard against that reviewed SHA.
3. The corrected exact `main` SHA is recorded as the accepted WOS-00 baseline.
4. The implementation controller explicitly reauthorizes WOS-01A.
5. PR #12 is recreated or rebased from the corrected baseline before any source import or implementation resumes.

If any condition is incomplete, PR #12 remains Draft and blocked. Opening or retaining a Draft PR confers no implementation, source-import or merge authority.

## Parallel-agent policy

A single root controller may use up to three parallel subagents with `max_depth=1` and disjoint write ownership. The root alone integrates, verifies, commits and pushes. Read-only convergence subagents may inspect overlapping authorities, but no child may create a branch, PR or commit independently.

## Finding 1 — invoice-batch approval reopening

The generic approval specification previously permitted protected reopen after an invoice-ready batch reached `Approved`, while the canonical batch lifecycle permitted `Approved → Exported | Cancelled` only. WorkOS must never have a pending approval attached to an exportable or final batch.

### Authoritative resolution

1. Invoice-batch approval instances may be corrected/rejected while the batch is `Draft` or `Under Review`.
2. Once an invoice batch reaches `Approved`, its approval instance is final for that batch version and cannot be generically reopened.
3. A material correction after `Approved` but before successful export requires an authorized `Approved → Cancelled` transition with protected authority, reason, audit and atomic occupancy release. A replacement batch/version and new approval instance are created from still-current eligible items; the original approval and membership history remain immutable.
4. `Exported` and `Billed/Confirmed` batches cannot be reopened or cancelled. Corrections use authorized versioned reversal/superseding eligibility events, approved-unbilled items and a new correction batch with its own approval instance.
5. `Cancelled` is terminal and cannot have a pending approval.
6. No invoice-batch approval may be pending when its batch is `Approved`, `Exported`, `Billed/Confirmed` or `Cancelled`.
7. Generic reopen remains available only for source types whose governing state machine defines a valid atomic transition back to a correctable state. Invoice-ready batches do not have such a rollback transition.
8. A stale or replayed reopen command is rejected with a stable conflict and cannot change batch state, approval state, occupancy or export eligibility.

### Required evidence

Positive and negative vectors cover correction/rejection while `Draft` or `Under Review`; final approval atomically entering `Approved`; forbidden reopen states; authorized pre-export cancellation/replacement; failed export remaining `Approved`; post-export reversal/supersession; concurrency/replay; and consistent API/database/browser-role behavior.

## Finding 2 — source-owner recipients for rejection/correction

The canonical generic `approval.rejected_or_correction_required` event must reach the people responsible for correcting the source even when they differ from the requester.

### Authoritative recipient policy

The event is one canonical action-required notification with deduplicated server-resolved relationship recipients:

- requester;
- affected worker where applicable;
- commercial change owner for commercial-source approvals;
- invoice-batch owner and finance preparer where applicable;
- another source-owner relationship only when explicitly defined for that source type.

The complete mandatory scoped recipient set is resolved before persistence. The canonical protected event identity, protected in-app recipient records and retained recipient-reason mappings commit atomically or leave zero successful protected-recipient mutation. Corrected retry uses the same decision/idempotency identity and creates the complete set exactly once. External email/collaboration delivery is downstream and separately retriable.

The event remains mutually exclusive with domain action events:

- `commercial.approval_required` is pre-submission only;
- `invoice_batch.action_required` is non-approval remediation only;
- neither fires for the same generic rejection/correction decision.

### Required evidence

Positive/negative vectors cover distinct requester/source owners, deduplication/reason retention, stale/out-of-scope mandatory relationship failure, caller redirection/omission denial, zero partial protected state, corrected retry, external-channel retry isolation, replay/idempotency and same-decision event exclusivity.

## Document and issue convergence

Review and align at minimum:

- `docs/00-control/PRODUCT_REQUIREMENTS.md`
- `docs/00-control/PROGRAM_CHARTER.md`
- `docs/00-control/REQUIREMENTS_TRACEABILITY.md`
- `docs/00-control/IMPLEMENTATION_STATUS.md`
- `docs/02-architecture/API_ARCHITECTURE.md`
- `docs/02-architecture/INTEGRATION_ARCHITECTURE.md`
- `docs/03-specifications/APPROVAL_AND_POLICY_ENGINE_SPEC.md`
- `docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md`
- `docs/04-quality/TEST_STRATEGY.md`
- `docs/04-quality/RELEASE_ACCEPTANCE_CRITERIA.md`
- `docs/05-delivery/IMPLEMENTATION_BACKLOG.md`
- `docs/evidence/v0.1.0/DOC-WOS-00-002-REVIEW-RESOLUTION.md`
- `docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md`
- `docs/evidence/v0.1.0/DOC-WOS-00F-CORRECTION-REPORT.md`
- `CHANGELOG.md`
- issues #2, #3, #7, #8, #9 and #13 where authority/status wording requires it.

Do not create a competing batch state machine, approval state machine or notification event.

## Review/evidence history

The post-merge review of WOS-00 head `e8e05e0f17e78e7ef19a35c078601ebda5881a45`, review `PRR_kwDOUAv8Lc8AAAABKiPf2w`, found one P1 invoice-batch reopen conflict and one P2 missing-source-owner-recipient defect after PR #1 had already merged. Subsequent PR #14 exact-head reviews and their corrections are recorded in `DOC-WOS-00-002-REVIEW-RESOLUTION.md`.

`main@880b3dc244bf516c4e535fb68e455e6153aec395` remains a merged baseline under corrective hold, not the final clean WOS-00 baseline. PR #12 remains Draft and blocked under the five-part dependency law.

After a clean correction merge, establish and record the new exact `main` baseline. Do not move, overwrite or falsely claim an existing release ref. Recording the baseline does not itself resume WOS-01A; controller reauthorization and PR #12 recreation/rebase are still required.

## Documentation-safe verification

Run and classify each item as `PASS`, `FAIL`, `SKIP` or `NOT RUN`:

1. Required WOS-00/WOS-00F file inventory and substantive-content check.
2. Exactly 126 unique product requirements.
3. Exactly 81 unique NFRs.
4. Product/NFR mapping completeness.
5. ADR-001 through ADR-008 structure.
6. Relative Markdown links.
7. Issue-template front matter.
8. Mermaid-aware validation using an actual parser; if unavailable, `NOT RUN` with exact reason. Markdown-fence balancing is not Mermaid validation.
9. Forbidden-term allowlist scan.
10. Owner-only transaction-strategy scan.
11. Credential-like value scan.
12. No application source, dependency manifest, migration or helper/materializer workflow introduced.
13. Focused lifecycle, notification, protected-recipient atomicity, event-exclusivity and WOS-01A dependency-law consistency scan.
14. Review-history/current-authority consistency across controller evidence, review resolution, status, traceability, backlog, release criteria and this task.
15. `git diff --check` and clean post-commit status.

Application build/runtime/API/migration/browser execution is `SKIP` or `NOT RUN` because this correction is documentation/control-only.

## Completion contract

The root controller must:

1. Integrate the bounded correction on the existing PR #14 branch.
2. Run all documentation-safe checks and record honest classifications.
3. Push the exact result.
4. Update the Draft PR body and issue #13.
5. Align live issues #2/#3/#7/#8/#9 only after the GitHub branch is published.
6. Reply to current review threads with exact correction evidence; do not resolve historical PR #1 post-merge threads until the correction reaches `main`.
7. Request a fresh independent Codex/Sol review of the exact current corrective-PR head.
8. Keep PR #14 Draft and do not merge, mark Ready, tag, resume PR #12 or begin another workstream in the writer task.

Only after a later independent clean review may the controller run the guarded Ready/merge sequence. Even after merge, WOS-01A remains blocked until corrected-main baseline recording, explicit controller reauthorization and PR #12 recreation/rebase are complete.

Report the exact resulting GitHub head, changed files, every check result and any remaining limitation.
