# PR-008I: Named worker/approver correction-cycle evidence

**Status:** Fresh integration acceptance in progress. Original plan `abe2260` preceded test implementation. This remains a test/documentation package; no runtime, permission, schema, dependency or business-policy change is proposed.
**Integration dependency:** Frozen PR62 candidate `0f7f1eab7286cd9dc20e6d79879573ac1340539b`. Parent acceptance and this package's exact-head checks/review are required before merge.
**Authority:** WORK_CAPTURE_AND_TIMESHEET_SPEC.md positive cases (enter daily/weekly work across assigned projects; submit, reject with reason, correct and approve preserving history), WOS-TIM-001/003/004/008/009 and WOS-WKF-007. This is finite evidence gate E1 in [the28-requirement checklist](WOS-04-PR008-ACCEPTANCE-CHECKLIST.md), not another policy feature or full PR008 acceptance.

## Current integration authority

The owner subsequently authorized enterprise review, fixes, integration and eligible merges. This supersedes historical development-only review/merge restrictions below. Preserve the original completeness map as a dated snapshot, not current progress. No deployment or full PR008 acceptance is implied.

## Historical pre-write reconciliation and boundary

On2026-10-24 only this writer was active, all five repository Actions queue states were empty, PR62 was Draft/unmerged at the fixed head, and active controller342036167's latest run40083556930 succeeded on unchanged main `b9a57f8a462d8585bb3f73129080d6fae5173343`. Prior heads/integration alias stay fixed. No monitor/automation change, scan, denied review/repair retry, merge/deploy, spend/grant, force push or cleanup is included. Optional independent/formal reviews remain deferred and outstanding.

## Acceptance plan before implementation

1. Use distinct synthetic named Employee and approver accounts in disposable PostgreSQL, with only the existing authorized work/approval roles. No Admin self-submission demo override and no production grants/identity changes. Seed a neutral legacy Active project (no fabricated commercial pin) and create its dated assignment through the actual API; existing governed-project lifecycle/term tests remain separate.
2. Drive production MyTimesheet as Employee and TimesheetApproval as the distinct approver over real HTTP/PostgreSQL, without business interception or local fallback. Daily save/reload and Weekly submission must use the existing header and preserve exact hours, comment, evidence URL and descriptive task reference.
3. Reject through actual approver UI with required reason, prove that reason in the worker UI, correct/resubmit as Employee, then approve through the distinct approver UI. Assert snapshots/sequences/decisions/approval actors and old content remain exact; inspect both retained versions through the actual worker history panel. The new test does not substitute API submission for the Employee's UI button.
4. Prove the worker's decision request is denied without mutation, Submitted/Approved content cannot be overwritten, and ordinary future work is denied with no historical drift. Retain existing broader source/scope/import/CAS/period negatives rather than invent a new exception policy.
5. Add the single required hosted real-browser gate; locked install, type/lint, unit/contracts, retained13 PostgreSQL/migration suites, existing13 journeys plus this one, production build/identity/Compose/container/configured CI remain required. Record exact head/tree and terminal hosted results. Publish a separate dependent Draft only after local gates.

If the cycle needs new permissions, changed approval/period/assignment semantics, blocked security code or missing buyer policy, stop that expansion and report the exact failed action and useful retained evidence. Routine fixture setup and nonsemantic test corrections are in scope. No claim of complete milestone or review acceptance.

## Integration evidence (2026-11-15)

Merged the frozen PR62 candidate through `44a157e` while keeping parent acceptance separate. Executable comparison confirms `src/`, `server/`, `shared/`, existing package scripts, dependency versions and parsed lockfile match that parent exactly. The only executable additions are the named-role test and its script/CI gate.

Own locked installation passed (338 packages, 345 audited, zero reported vulnerabilities). Typecheck, lint, source/adversarial scanning and production build (22.25 seconds) passed. The first local browser attempt timed out at initial cold fixture navigation before assertions. An unchanged retry passed the named Employee/distinct approver correction cycle, retained history journey and ownership browser. No assertions or timeouts were weakened; the failure remains recorded. Runtime acceptance from the parent is not relabelled as new local execution. Fresh hosted retained gates and independent exact-head review remain required for this package; parent integration is also required before merge.

The October completeness checklist is explicitly historical. Its original matrix and decision questions remain preserved, without presenting old Draft status or review restrictions as current authority. This evidence does not establish full PR008, production readiness or buyer UAT.
