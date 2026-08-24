# WOS-00F correction report

## Outcome and requirements

This documentation-only correction addresses the WOS approval, invoice and integration requirement families. It closes Round-14 P1/P2 in governing text: invoice-batch approval is final, successor correction paths preserve immutable history, and rejection/correction recipients are bounded, authoritative and fail closed. PR-009, PR-012 and PR-013 retain implementation and evidence ownership. `main@880b3dc244bf516c4e535fb68e455e6153aec395` remains under corrective hold and WOS-01A PR #12 remains blocked until clean review and merge.

## Verification classification

Documentation inventory, requirement/NFR counts and mappings, ADR structure, relative links, issue-template front matter, Mermaid structure, forbidden-term/transaction/credential scans, changed-file scope, focused consistency, adversarial P1/P2 review and diff checks are required PASS evidence. Application build, runtime, API, migration and browser execution are SKIP/NOT RUN because this work changes no runnable artifact; implementation PRs must execute those gates.

## Proposed post-publication issue updates

- **#2:** record final invoice-batch approval and no generic reopen; retain PR-009 negative/replay evidence.
- **#3:** record protected cancellation/replacement and reversal/supersession; retain PR-012 occupancy/export evidence.
- **#7:** record bounded authoritative rejection/correction recipients and source-owner scope.
- **#8:** record PR-013 deduplication, idempotency, partial-failure and event-exclusivity evidence.
- **#9:** record the exact corrected baseline only after merge and keep WOS-01A blocked beforehand.

Issue #13 and Draft PR #14 may be updated only after branch publication. Original PR #1 threads remain open until the correction reaches `main`.

## Security and rollback

The server remains authoritative for source state, protected authority, recipient relationships and data scope. Stale/out-of-scope mandatory relationships and partial protected delivery fail closed; callers cannot redirect or omit recipients. Rollback reverts this documentation commit only, restores the corrective hold, and does not delete or rewrite approval, batch, membership, notification or audit history. No schema, runtime, dependency, deployment or reference-repository change is included.
