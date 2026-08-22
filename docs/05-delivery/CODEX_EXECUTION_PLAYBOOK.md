# WorkOS Codex Execution Playbook

**Purpose:** Define how Codex Cloud is used as an implementation agent while GitHub evidence and controller review remain the source of delivery truth.

## 1. Control model

WorkOS uses four distinct responsibilities:

| Responsibility | Owner |
|---|---|
| Product decisions and material approvals | Product owner |
| Task definition, sequencing, review and merge control | Implementation controller |
| Bounded code/document implementation and automated validation | Codex Cloud |
| Authoritative history, PR evidence and release record | GitHub |

Codex is an implementation agent, not the programme authority. A Codex summary does not prove that a requirement is complete.

## 2. Environment

All WorkOS tasks must use:

```text
Environment: WorkOS Implementation
Repository: APReddy-AutoBotz/WorkOS
Default base branch: main
```

The reference source repository is read-only and may be accessed only through the approved pinned-source bootstrap process. WorkOS tasks must never write to or open a PR against the reference repository.

### 2.1 Internet and secrets

- Agent internet access remains off unless a specific approved task requires allowlisted external access.
- Do not add GitHub personal access tokens or SSH keys to the Codex environment.
- Product/provider secrets are introduced only when the relevant environment and test plan require them.
- Secrets must never appear in task prompts, generated files, logs or evidence.

## 3. Model policy

When the Codex interface exposes model choice:

| Task class | Preferred model policy |
|---|---|
| Architecture, threat modelling, authorization, migrations, financial calculations | Strongest available Sol reasoning model |
| Large end-to-end implementation | High-reasoning Sol model |
| Focused tests, documentation consistency, bounded refactor | Appropriate Sol model with sufficient reasoning |
| Independent review | Fresh Sol review pass; do not reuse only the implementation self-review |

Speed is secondary to correctness for security, data migration and commercial calculation work.

## 4. Task sizing

A Codex task must deliver a meaningful end-to-end outcome. Avoid isolated cosmetic or file-by-file tasks that create coordination overhead.

A good task normally includes:

- Required schema/migration.
- Server behavior.
- UI behavior where applicable.
- Authorization and audit.
- Automated tests.
- Documentation/evidence.

A task may be split when:

- The migration can be independently reviewed and safely feature-gated.
- The resulting diff would otherwise be too large to review reliably.
- Independent modules can proceed without touching shared schema/security/financial areas.

Do not run concurrent tasks against overlapping database, authentication, permission, approval or financial-engine areas.

## 5. Standard task packet

Every implementation task must use the following structure.

```markdown
# <Task ID> — <Outcome>

## Repository and base
- Repository: APReddy-AutoBotz/WorkOS
- Base branch/commit: <exact ref>
- Branch: <expected branch>

## Objective
<One business outcome, not a list of unrelated edits.>

## Requirements
- WOS-...

## In scope
- ...

## Explicitly out of scope
- ...

## Existing behavior to preserve
- ...

## Architecture constraints
- ...

## Data and migration requirements
- ...

## Authorization, security and audit requirements
- ...

## UX and accessibility requirements
- ...

## Acceptance criteria
1. ...

## Mandatory tests
- ...

## Required evidence and documentation
- ...

## Completion report
Report outcome, requirement IDs, changed files/migrations, exact tests/results,
limitations, security/rollback notes and exact head.
```

## 6. Codex start procedure

1. Controller verifies `main`, open PRs, dependencies and exact base commit.
2. Controller creates the task file or places the complete task packet in the Draft PR.
3. Controller creates the branch and Draft PR when GitHub flow requires it.
4. Codex is launched against the exact WorkOS environment and task.
5. The task must first inspect governing documents and state any material conflict before editing.
6. Codex implements only the approved scope and runs mandatory tests.
7. Codex updates the branch/PR and provides a completion report.

When using a GitHub PR comment to invoke Codex, use a bounded instruction similar to:

```text
@codex Implement the task specification in docs/tasks/<TASK>.md end to end.
Use the WorkOS Implementation environment and the strongest appropriate Sol model.
Do not broaden scope. Run every mandatory test and update required evidence.
```

The ability to request a model through a comment may depend on the Codex interface. If the comment flow does not expose model selection, the controller records the preference and uses the available repository automation without treating model choice as acceptance evidence.

## 7. Implementation behavior

Codex must:

- Read `AGENTS.md` and relevant governing documents.
- Inspect existing implementation and tests before proposing change.
- Avoid replacing stable behavior with placeholders.
- Use synthetic production-like fixtures only.
- Preserve compatibility or document an approved breaking migration.
- Implement server-side validation even when UI validation exists.
- Add negative authorization/security tests.
- Update operational and traceability documents in the same change.
- Inspect the final diff for secrets, company-specific terms, generated noise and unrelated edits.

Codex must not:

- Modify `main` directly.
- Modify the reference repository.
- Introduce microservices without an approved ADR.
- Use AI as the authoritative financial calculator or approver.
- Weaken tests or controls to obtain green results.
- Claim a skipped environment-dependent test passed.
- silently invent commercial policy where requirements are materially ambiguous.

## 8. Pull-request lifecycle

### 8.1 Draft creation

Every implementation PR starts as Draft and includes:

- Outcome and requirement IDs.
- Scope and exclusions.
- Architecture/data/security summary.
- Migration and rollback notes.
- Test plan.
- Known limitations.

### 8.2 Controller first review

The controller reviews:

- Actual changed files and diff.
- Scope discipline.
- Data model and migration safety.
- Authorization and audit completeness.
- Financial calculation correctness where applicable.
- Tests and whether they test the real failure modes.
- Documentation/evidence consistency.
- Accidental company branding, credentials or demo artifacts.

### 8.3 Correction loop

Findings are classified:

| Severity | Meaning | Merge effect |
|---|---|---|
| P0 | Security/data loss/financial integrity or wrong repository risk | Immediate block |
| P1 | Material requirement, authorization, migration or core workflow defect | Block |
| P2 | Important quality, maintainability or edge-case defect | Normally block until resolved or explicitly deferred |
| P3 | Minor wording/cosmetic/non-risk issue | May be follow-up if documented |

Codex receives precise evidence-based correction instructions. The same exact PR branch should be updated unless the design is rejected and the PR is closed.

### 8.4 Independent review

After implementation findings are resolved:

- Request a fresh Codex review where available.
- Review new findings against governing requirements.
- Do not accept “looks good” without checking the changed head.

### 8.5 Exact-head gate

Before merge, record:

- PR number.
- Exact head SHA.
- CI/check status for that SHA.
- Review status.
- Required manual/browser/migration evidence.
- Remaining accepted limitations.

If the head changes after evidence is captured, rerun/recheck affected gates.

### 8.6 Merge

- Mark ready only after blocking findings are closed.
- Use squash merge by default.
- Verify the merged main commit.
- Update implementation status and traceability.
- Run stable-main acceptance checks when defined by the work package.

## 9. Test evidence rules

A completion report must distinguish:

```text
PASS — command ran and passed.
FAIL — command ran and failed.
SKIP — command intentionally did not run and why.
NOT RUN — command was not executed.
```

Do not report a conditional skip as a pass.

At minimum, applicable tasks report:

- Locked dependency install.
- Type/lint.
- Build.
- Unit/domain tests.
- API/contract tests.
- Authorization negative tests.
- Fresh and upgrade migration tests.
- Browser journeys.
- Production-mode startup/container checks.
- Security/secret/dependency scan.

## 10. Database and migration control

For every migration PR:

1. Identify prior supported schema/version.
2. Prove fresh install.
3. Prove upgrade with representative existing data.
4. Prove constraints and organization/data-scope behavior.
5. State rollback/recovery method.
6. Confirm no historical financial/work evidence is silently rewritten.
7. Confirm migration ordering and ledger behavior.

Destructive operations require explicit owner/controller approval.

## 11. Commercial-engine control

Commercial tasks require a golden-vector pack containing, as applicable:

- T&M standard and partial-period cases.
- Role/worker-specific rate precedence.
- Effective-date boundaries.
- Fixed-fee budget and effort overrun.
- Milestone acceptance and reversal.
- Retainer consumption, expiry and overage.
- PO cap/threshold behavior.
- Currency precision and rounding.
- Negative adjustments/credits.
- Snapshot stability after rate changes.
- Report and invoice-ready reconciliation.

The controller must review calculation formulas and stored evidence, not only UI totals.

## 12. Security control

Security-sensitive work requires:

- Threat scenario or finding reference.
- Positive and negative tests.
- Active-role and row-scope checks.
- Session/account lifecycle checks.
- Secret/log review.
- Dependency/security scan disposition.
- No acceptance based solely on client-side controls.

## 13. Progress reporting

The controller reports weighted accepted progress using:

```text
Overall WorkOS readiness: XX%
Product capability: XX%
Commercial capability: XX%
Enterprise platform: XX%
Quality and evidence: XX%
Buyer handover: XX%

Current workstream:
Current PR:
Exact head:
CI:
Review:
Blocking findings:
Owner decision required:
Next controller action:
```

A workstream remains incomplete until its defined evidence is merged.

## 14. Owner involvement

Routine implementation proceeds from approved requirements without repeated owner input.

Owner review is mandatory at:

- Gate B — blueprint acceptance before source import/product implementation.
- Gate C — working commercial calculation/margin milestone.
- Gate D — v1 release and buyer handover.

Additional escalation occurs only for material product, legal, security, destructive-data or financial-policy decisions.

## 15. Failure and recovery handling

If a Codex task fails or produces unsafe work:

1. Preserve the PR/task evidence.
2. Do not merge partial unsafe implementation.
3. Classify whether the failure is environment, specification, architecture or code related.
4. Correct the task packet or environment rather than repeatedly retrying an ambiguous prompt.
5. Use a fresh task/review when independent reasoning is needed.
6. Close superseded PRs with a clear reason and maintain traceability.

## 16. Definition of a controlled Codex delivery

A Codex delivery is controlled only when:

- It ran against the correct repository and base.
- It followed the governing documents.
- The diff is bounded and reviewable.
- Required tests actually executed.
- Blocking review findings are resolved.
- Exact-head evidence exists.
- GitHub records the final accepted change.
