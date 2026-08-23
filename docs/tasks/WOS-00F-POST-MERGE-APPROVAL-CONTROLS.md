# WOS-00F — Post-merge approval-control correction

## Objective

Correct the two post-merge governing defects identified after WOS-00 PR #1 was merged into `main@880b3dc244bf516c4e535fb68e455e6153aec395`.

This task is documentation/control-only. It must not import application source or access/modify `APReddy-AutoBotz/Boundaryless-WorkOS`.

## Starting authority

- Repository: `APReddy-AutoBotz/WorkOS`
- Base: `main@880b3dc244bf516c4e535fb68e455e6153aec395`
- Branch: `controller/wos-00f-approval-controls`
- Issue: #13
- Source WOS-00 reviewed head: `e8e05e0f17e78e7ef19a35c078601ebda5881a45`
- P1 thread: `PRRT_kwDOUAv8Lc6beCXL`
- P2 thread: `PRRT_kwDOUAv8Lc6beCXQ`
- WOS-01A PR #12 is dependency-blocked until this correction is clean-reviewed and merged.

## Parallel-agent policy

A single root controller may use up to three parallel subagents with `max_depth=1` and disjoint write ownership. The root agent alone integrates, verifies, commits and pushes.

Suggested split:

1. **Batch/approval lifecycle subagent**
   - `docs/02-architecture/API_ARCHITECTURE.md`
   - `docs/03-specifications/APPROVAL_AND_POLICY_ENGINE_SPEC.md`
   - `docs/03-specifications/COMMERCIALS_REVENUE_MARGIN_SPEC.md`
   - relevant approval/batch vectors in `docs/04-quality/TEST_STRATEGY.md`

2. **Notification/source-owner subagent**
   - `docs/00-control/PRODUCT_REQUIREMENTS.md`
   - `docs/02-architecture/INTEGRATION_ARCHITECTURE.md`
   - notification vectors in `docs/04-quality/TEST_STRATEGY.md`
   - PR-009/PR-013 evidence in `docs/05-delivery/IMPLEMENTATION_BACKLOG.md`

3. **Evidence/status subagent**
   - `docs/00-control/REQUIREMENTS_TRACEABILITY.md`
   - `docs/00-control/IMPLEMENTATION_STATUS.md`
   - `docs/04-quality/RELEASE_ACCEPTANCE_CRITERIA.md`
   - `docs/evidence/v0.1.0/DOC-WOS-00-002-REVIEW-RESOLUTION.md`
   - `docs/evidence/v0.1.0/DOC-WOS-00-BLUEPRINT-CONTROLLER-REVIEW.md`
   - `CHANGELOG.md`

A read-only convergence pass must inspect all governing documents and live issues before publication. No subagent may create a branch, PR or commit independently.

## Finding 1 — P1 invoice-batch approval reopening

The generic approval specification permits protected reopen after an invoice-ready batch reaches `Approved`, but the canonical batch lifecycle permits `Approved → Exported | Cancelled` only. WorkOS must never have a pending approval attached to an exportable or final batch.

### Authoritative resolution

1. Invoice-batch approval instances may be corrected/rejected while the batch is `Draft` or `Under Review`.
2. Once an invoice batch reaches `Approved`, its approval instance is final for that batch version and **cannot be generically reopened**.
3. A material correction after `Approved` but before successful export requires an authorized `Approved → Cancelled` transition with protected authority, reason, audit and atomic occupancy release. A replacement batch/version and new approval instance are created from still-current eligible items; the original approval and membership history remain immutable.
4. `Exported` and `Billed/Confirmed` batches cannot be reopened or cancelled. Corrections use authorized versioned reversal/superseding eligibility events, approved-unbilled items and a new correction batch with its own approval instance.
5. `Cancelled` is terminal and cannot have a pending approval.
6. No invoice-batch approval may be pending when its batch is `Approved`, `Exported`, `Billed/Confirmed` or `Cancelled`.
7. Generic reopen remains available only for source types whose governing state machine defines a valid atomic source transition back to a correctable state. Invoice-ready batches do not have such a rollback transition.
8. A stale or replayed reopen command for an invoice batch is rejected with a stable conflict and cannot change batch state, approval state, occupancy or export eligibility.

### Required evidence

Positive and negative vectors must cover:

- correction/rejection while `Draft` or `Under Review`;
- final approval atomically entering `Approved` with no pending stage;
- generic reopen rejected for `Approved`, `Exported`, `Billed/Confirmed` and `Cancelled` batches;
- authorized pre-export cancellation of an `Approved` batch, immutable history and creation of a replacement batch/new approval;
- failed export leaving the batch `Approved` but not reopening approval;
- post-export correction through reversal/supersession and a new correction batch/approval;
- concurrency/replay cannot create a pending approval on an exportable/final batch;
- API, database and browser-role behavior agree.

## Finding 2 — P2 source-owner recipients for rejection/correction

The canonical generic `approval.rejected_or_correction_required` event must reach the people responsible for correcting the source even when they differ from the requester.

### Authoritative recipient policy

The event is one canonical action-required notification with deduplicated server-resolved relationship recipients:

- requester;
- affected worker where applicable;
- commercial change owner for commercial-source approvals;
- invoice-batch owner and finance preparer where applicable;
- assignment/resource owner, engagement/project owner or other source-owner relationship only when explicitly defined for that source type.

Every created notification records the source ID/version, generic approval decision/operation, recipient identity, relationship, recipient reason, organization/legal-entity/data scope, template version, policy class and idempotency identity.

The event remains mutually exclusive with domain action events:

- `commercial.approval_required` remains pre-submission only;
- `invoice_batch.action_required` remains non-approval remediation only;
- neither may fire for the same generic rejection/correction decision.

### Required evidence

Positive and negative vectors must cover:

- requester and commercial change owner are different;
- requester, invoice-batch owner and finance preparer are different;
- one person holding multiple relationships receives one deduplicated record with all applicable reasons or deterministic precedence;
- affected worker remains included for worker-related sources;
- out-of-scope or stale relationship recipients are denied and visible as a control failure where mandatory;
- caller cannot redirect or omit protected recipients;
- replay/idempotent retry creates no duplicate event or delivery evidence;
- no `commercial.approval_required` or `invoice_batch.action_required` event is emitted for the same generic rejection/correction operation.

## Document and issue convergence

Review and align at minimum:

- `docs/00-control/PRODUCT_REQUIREMENTS.md`
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
- `CHANGELOG.md`
- issues #2, #3, #7, #8, #9 and #13 where current authority/status wording requires it.

Do not create a competing batch state machine, approval state machine or notification event.

## Review/evidence history

Record the post-merge review of WOS-00 head `e8e05e0f17e78e7ef19a35c078601ebda5881a45` as the next independent review round, with:

- one P1: invoice-batch approval reopen conflict;
- one P2: missing source-owner recipients for generic rejection/correction;
- exact thread/comment identifiers;
- exact correction location and evidence;
- honest statement that PR #1 had already been merged when these findings were published.

`main@880b3dc244bf516c4e535fb68e455e6153aec395` is a merged baseline under corrective hold, not the final clean WOS-00 baseline. WOS-01A PR #12 remains Draft and blocked.

After a clean correction merge, establish a new exact baseline. Do not move, overwrite or falsely claim an existing tag.

## Documentation-safe verification

Run and classify as `PASS`, `FAIL`, `SKIP` or `NOT RUN`:

1. Required WOS-00 file inventory and substantive-content check.
2. Exactly 126 unique product requirements.
3. Exactly 81 unique NFRs.
4. Product/NFR mapping completeness.
5. ADR-001 through ADR-008 structure.
6. Relative Markdown links.
7. Issue-template front matter.
8. Mermaid validation.
9. Forbidden-term allowlist scan.
10. Owner-only transaction-strategy scan.
11. Credential-like value scan.
12. No application source, dependency manifest, migration or helper/materializer workflow introduced.
13. Focused consistency scan for `reopen`, invoice-batch states, `approval.rejected_or_correction_required`, source-owner recipients and mutually exclusive domain events.
14. `git diff --check` and clean post-commit status.

Application build/runtime/migration/browser execution is `SKIP` or `NOT RUN` because this correction is documentation-only; say so explicitly.

## Completion contract

The root controller must:

1. Integrate the bounded correction on this branch.
2. Run all documentation-safe checks.
3. Push the exact result.
4. Update the Draft PR body and issue #13.
5. Update live issues #2, #3, #7, #8 and #9 only after the GitHub branch is published.
6. Reply to the two original PR #1 review threads with the corrective PR and exact head; do not resolve them until the correction is merged into `main`.
7. Request a fresh independent Codex/Sol review of the exact current corrective-PR head.
8. Do not merge, mark Ready, tag, resume PR #12 or begin another workstream.

Report the exact resulting GitHub head, changed files, every check result and any remaining limitation.