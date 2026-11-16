# Independent leave decisions and Teams source integrity

Requirements: WOS-IAM-003/005/009/010; WOS-APR-001/002/004/006; WOS-CORE-003/005; WOS-NFR-SEC-004/012.

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

The frozen first candidate `f92bd127546f6d0b040aafdad2563b0287af7ad1` received one medium-severity finding in scan85726d08-d920-4b3e-9641-9a3629b47716: ProjectManager direct approval returned403, but creating a delegation and approving through it returned200 without managed-project worker authority. The correction checks the delegator through the shared current role-specific employee-scope predicate. A regression proves denial before an actual managed-project allocation and successful delegated approval after it; TeamLead delegation remains valid. The frozen original tree and proof are retained. Its production identity attempt failed local discovery readiness and is not passing evidence; the corrected revision must pass fresh production and exact-head checks.

## Current identity and director qualification correction

The next frozen candidate `0141c2aeb80bb64e9582b5f7ff58e400cf6aea2e` received a medium-severity director-qualification finding in scan bb34c925-2e4d-494d-9bf7-5899fe7308c7. The actual API denied an unqualified director's direct decision but allowed the delegated equivalent. The current correction applies the existing designation/department qualification to both current actor and delegator; negative tests retain every protected-state snapshot, and a qualified delegator remains a positive control. Frozen candidates and evidence remain unchanged.

The owner's expanded PR168 scope also corrects stale workforce claims at the shared identity guard. Both bearer and cookie requests replace worker ID, employee code, director ID and the legacy director alias with current canonical database values, including null. Identity-only, legacy and versioned routes share this guard. Issuance and refresh read the canonical worker's employee code. Unlinked Admin/HR account authority remains supported; a legacy employee-code copy alone cannot infer a canonical worker. Existing role, verified provider mapping, organization selection and durable session-revocation checks remain enforced.

The stale-session trigger was reproduced before correction using an actual issued token and supported worker reassignment. PostgreSQL API regression now verifies reassignment, qualification removal, null linkage, legacy-code-only denial, current Employee/TeamLead/ProjectManager access, canonical code changes, mapped-role qualification denial and unlinked Admin compatibility. Unit checks cover both guards, all historical aliases, null replacement and unavailable authority. Setup and availability fixtures now establish real canonical links and qualifications instead of relying on signed historical claims. A fresh independent candidate review found no concrete surviving bypass or introduced regression. The final full checks, immutable-head review and hosted acceptance are required before merge and recorded in PR168.

## Release and rollback

Preserve audit evidence and the index. Prefer forward correction; older application code restores the vulnerabilities. No production deployment, buyer UAT, full-repository security clearance or completion of all delegated-approval domains is claimed. Remaining legacy delegation domains, commercial/export/diagnostic findings, persistent production throttling and release acceptance remain separate work.

## Final integration evidence

Runtime candidate `0156d7b7357eadd6392ca92a01305bd16ee6fb26` passed independent review of all 51 changed paths in scan `96af60c5-317c-4809-b29f-48daca5c462b`, with no security candidates or correctness blockers. Local typecheck, 259-module lint, aggregate unit/contracts, 56-entry migration suite, focused PostgreSQL negatives/positive controls, leave/own-planning/import-audit browser journeys and 505-file hygiene/adversarial scan passed. A separate final revision removes one nonfunctional trailing blank line from the new identity regression and records this evidence; application and migration code remain byte-identical. The production build and signed-provider/fail-closed startup suite also passed. Final exact-head hosted results are recorded in PR168 before merge.
