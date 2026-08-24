# WOS-00F correction report

## Outcome and requirements

This documentation-only correction addresses the WOS approval, invoice and integration requirement families. It closes the Round-14 P1/P2 governing defects and the subsequent PR #14 P2 convergence findings: invoice-batch approval is final for its batch version, successor correction paths preserve immutable history, and rejection/correction recipients are bounded, authoritative, source-owner aware, deduplicated and fail closed. PR-009, PR-012 and PR-013 retain their respective implementation and evidence ownership.

`main@880b3dc244bf516c4e535fb68e455e6153aec395` remains the historical merged WOS-00 baseline under corrective hold. Draft PR #14 is the active WOS-00F correction. WOS-01A PR #12 remains dependency-blocked and earns no implementation credit until WOS-00F is independently clean-reviewed, merged and the corrected exact `main` baseline is recorded.

## Verification classification

Documentation inventory, requirement/NFR counts and mappings, ADR structure, relative links, issue-template front matter, Mermaid structure, forbidden-term/transaction/credential scans, changed-file scope, focused consistency, adversarial P1/P2 review and diff checks are required PASS evidence. Application build, runtime, API, migration and browser execution are SKIP/NOT RUN because this work changes no runnable artifact; implementation PRs must execute those gates.

## Live issue ownership and post-publication updates

The issue map is authoritative and must not cross-assign later-workstream responsibilities:

- **#2 — WOS-00 governing baseline:** record the WOS-00F corrective hold, PR #14 exact review/merge state, and the corrected baseline SHA only after merge. #2 owns governance/baseline status, not PR-009/012/013 implementation detail.
- **#3 — WOS-01 source bootstrap and neutral product foundation:** record only the dependency block and the exact corrected WOS-00 prerequisite. PR #12 remains Draft and blocked until PR #14 is clean-reviewed, merged and the corrected `main` SHA is recorded. #3 does not own approval, invoice-readiness or notification implementation.
- **#7 — WOS-05 / PR-009 approval and policy engine:** record invoice-batch approval finality, no generic reopen after `Approved`, valid pre-approval correction/rejection, stable reopen conflicts, and generic rejection/correction recipient-resolution responsibilities that belong to the approval engine.
- **#8 — WOS-06 / PR-012 commercial and invoice readiness:** record the canonical invoice-batch lifecycle, protected pre-export cancellation/replacement, immutable occupancy/history, failed-export behavior, post-export reversal/supersession and new correction batch/approval evidence.
- **#9 — WOS-07 / PR-013 reporting, notifications and integrations:** record the source-owner-aware canonical `approval.rejected_or_correction_required` recipient matrix, identity deduplication/reason retention, fail-closed mandatory relationship resolution, caller redirection/omission denial, replay/idempotency and mutual exclusion from the two domain action events.

Issue #13 owns the bounded WOS-00F correction itself. Draft PR #14 may be marked ready or merged only after a fresh independent exact-head review reports no P0/P1/P2 findings and all blocking threads are resolved. Original PR #1 post-merge threads remain historical evidence and may be resolved only after the corrective content reaches `main`.

## PR #14 P2 convergence

Review `PRR_kwDOUAv8Lc8AAAABKkn3EA` of head `039789b7860d38115c7dfbd39dd26c0a36314a6a` identified three P2 consistency gaps:

1. Canonical/default-recipient rows for `approval.rejected_or_correction_required` lagged the source-owner-aware WOS-00F clarification.
2. The proposed issue-update map cross-assigned #2/#3/#7/#8/#9 responsibilities.
3. `IMPLEMENTATION_STATUS.md` retained stale pre-merge PR #1 actions and WOS-01 authorization language.

The convergence pass directly updates the canonical product, integration, approval and test matrices; fixes this issue ownership map; and replaces the primary status authority with the actual PR #14 corrective-hold state. No clean final review is claimed by these edits themselves.

## Security and rollback

The server remains authoritative for source state, protected authority, recipient relationships and data scope. Stale/out-of-scope mandatory relationships and partial protected delivery fail closed; callers cannot redirect or omit recipients. Identity deduplication retains all applicable recipient reasons or approved deterministic precedence. The generic rejection/correction event is mutually exclusive for the same decision with `commercial.approval_required` and `invoice_batch.action_required`.

Rollback reverts the WOS-00F documentation correction only, restores the corrective hold, and does not delete or rewrite approval, batch, membership, notification or audit history. No schema, runtime, dependency, deployment or reference-repository change is included.