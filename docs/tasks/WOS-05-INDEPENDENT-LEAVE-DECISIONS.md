# Independent leave decisions and Teams source integrity

Requirements: WOS-IAM-003/005/010; WOS-APR-001/002/004/006; WOS-CORE-005; WOS-NFR-SEC-004/012.

## Boundary

The actual baseline API allowed an affected worker to approve their own submitted leave (HTTP200 rather than403). A separate source trace found Teams actions could decide a leave approval record without the source leave transition. The correction checks both legacy leave-status and generic workspace decisions inside their source transaction. Current database account/worker identity and retained scoped submission audit determine independence; token worker claims and requester display fields are insufficient. The generic route also requires leave.approve and matching source/approval worker identity.

Teams leave approval/rejection fails closed with LEAVE_SOURCE_DECISION_REQUIRED before token consumption or approval mutation. Users decide through the source workspace. Owner/manager cancellation remains a separate workflow. Existing successful historical decisions are preserved. Missing or conflicting historical submission provenance returns LEAVE_SUBMITTER_UNCONFIRMED; cancellation and resubmission provide an attributable new request without rewriting the old one.

An independent candidate review identified that an ordinary hierarchy-only check rejected legitimate delegated approvals. Actual PostgreSQL reproduction confirmed403 where200 was required. The corrected generic boundary supports active, in-date, same-entity delegation using current delegate/delegator identity, role assignment, permission and reporting relationship. It rejects a submitting delegator's attempt to pass on otherwise forbidden decision authority. Other legacy delegation domains remain outside this increment.

## Schema and compatibility

Migration057b adds a scoped partial index for immutable submission-actor lookup after accepted057a, preserving later Draft058 numbering. No historical row, financial value, default grant or dependency changes. Existing migration checksums remain unchanged. Upgrade manifests append one index migration. Source decision and audit/notification/balance changes remain transactional; denial must commit none of them.

## Evidence

Locked installation passed with zero dependency vulnerabilities. The original self-approval reproduction failed as expected before the fix and passed after it. Actual PostgreSQL/API negatives cover own and on-behalf approval/rejection, stale worker claims, Teams bypass, entity selection, missing permission, unconfirmed/conflicting historical evidence, revoked/expired/mismatched delegation and duplicate concurrent decisions. Legitimate independent and delegated decisions and cancellation are positive controls. Complete protected-state snapshots verify refusal atomicity.

The real Team Leave Calendar browser journey shows owner denial with Submitted state retained, followed by another actor's successful approval. The full unit/contract aggregate and 56-entry fresh/concurrent/replay/upgrade/rollback migration suite passed. Final static, retained browser, production, frozen-head review and exact-head hosted results are recorded in the PR before merge. A fixture-only conflicting-audit insert initially omitted required fields; a delegation fixture omitted its required director reference. Both were corrected before their behavioral assertions ran. These were test setup failures, not passing evidence.

The retained own-planning browser initially failed because its capacity fixture used one manager for both submission and approval. The shared capacity fixture and every caller now use the named affected Employee as submitter and a separate manager as approver; capacity/assignment assertions are unchanged. The dedicated leave and import/audit browser journeys passed before that fixture correction; affected planning regressions are rerun before acceptance.

## Release and rollback

Preserve audit evidence and the index. Prefer forward correction; older application code restores the vulnerabilities. No production deployment, buyer UAT, full-repository security clearance or completion of all delegated-approval domains is claimed. Current relationship authority, remaining commercial/export/diagnostic findings, persistent production throttling and release acceptance remain separate work.
