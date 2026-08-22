# Pull Request Review and Merge Policy

## Principles

Pull requests are the unit of controlled change. Agent completion messages, commit counts and green superficial checks are not acceptance evidence.

## PR lifecycle

1. Create an outcome-based branch and Draft PR.
2. Link governing issue, requirement IDs, ADR/specification and exclusions.
3. Implement schema/backend/frontend/tests/docs/evidence as applicable.
4. Run and classify checks at the exact head.
5. Controller reviews actual changed files and high-risk logic.
6. Resolve all blocking findings and rerun affected evidence.
7. Request an independent Codex review where appropriate.
8. Mark ready only after the acceptance checklist is complete.
9. Merge with expected-head protection, normally by squash.
10. Update/close issue and release traceability.

## Review depth

Always inspect:

- Scope drift and accidental files/artifacts.
- Authorization and row/data scope.
- Effective dating, history and audit.
- Migration fresh/upgrade/rollback behavior.
- Financial precision, rate resolution and reconciliation.
- Error/idempotency/concurrency behavior.
- Sensitive response/log/export exposure.
- Tests that prove failure paths rather than mirror implementation.

## Exact-head rule

The reviewed SHA must equal the merge head. If the branch moves after review or evidence, the controller assesses and reruns required checks. Merge uses `expected_head_sha` where available.

## Codex usage

Use the strongest appropriate Sol model for architecture, security, migrations and commercial calculations. Codex may implement or review, but a fresh controller inspection is mandatory. Reviews should identify severity, evidence and required correction rather than generic approval language.

## Merge method

Squash merge is the default so a work package becomes one coherent main-branch change. Merge/rebase exceptions require a reason. Direct pushes to `main` are prohibited for implementation work.

## Draft and dependency rules

PRs remain Draft while incomplete or blocked. Dependent PRs do not merge ahead of prerequisites. Schema/security/commercial PRs are normally serialized; independent documentation or adapter tasks may run in parallel.

## Review outcomes

- `APPROVE` only when all required gates pass.
- `REQUEST_CHANGES` for blocking correctness, security, migration, scope or evidence issues.
- `COMMENT` for non-blocking observations or questions.

## Post-merge

Verify main-branch checks, update implementation status and traceability, create/tag releases at planned milestones, and record any production/buyer gate that remains open.