# Legacy approval scope and immutable delegation ownership

Requirements: WOS-CORE-003/005, WOS-IAM-003/005/010, WOS-APR-004/005 and WOS-NFR-SEC-004/008/012. Governing feature contract: APPROVAL_AND_POLICY_ENGINE_SPEC.md.

## Current baseline and confirmed boundary

This package starts independently from accepted main `88262c87a260529c00a680b22d2f021ff7d8cba4`; it does not import later commercial modules or the unmerged PR170 notification changes. Historical Draft PR136 is reference material, not acceptance evidence for this revision.

A real disposable PostgreSQL/API regression on this baseline returned 200 when a delegation recipient submitted the retained ID with themselves as its owner. The same regression showed another legal entity's approval in an administrator's selected-entity inbox. The self-service check trusted submitted ownership and the shared approval scope returned unrestricted authority for administrative roles.

## Implementation

Extract legacy delegation routes and shared approval scope into bounded modules. Authorize and lock retained ownership, keep delegator identity immutable even for administrators, scope retained and proposed participants, and serialize supplied IDs and overlapping owner writes. Validate calendar dates and keep mutation/audit atomic. Activation requires current participant accounts, persisted assigned role, selected membership and approval permission. The existing persisted-role delegation precedent remains; mapped-only provider role assignment is not new delegation authority.

Inbox, generic decisions, SLA, Teams approval-token scope and command-center counts share selected organization/entity ownership outside direct/delegated branches. Delegated reads revalidate role, owner account/permission/membership, non-exited participants and current TeamLead/project/director relationships; director qualification uses the existing shared SQL helper. Stronger leave/timesheet decision rules remain in place.

Original owner and scoped administration can edit or revoke without transferring ownership. On Leave participants remain supported. Revocation stays available after participant lifecycle/authority loss, subject to retained entity ownership and caller authority. No grants, migrations or dependencies are added; historical cross-entity or unresolved-owner rows are hidden rather than adopted or deleted.

The production form omits an empty creation ID, catches server refusals, retains failed input, prevents duplicate submissions and distinguishes acknowledged save from failed list refresh. Accessible labels/status support the real browser journey.

## Evidence and acceptance

The original takeover and cross-entity reproduction failed before the fix and passes afterward. Real PostgreSQL/API tests cover immutable owner under ordinary/admin callers, valid owner/admin edits, retained foreign participants, active-entity switching, foreign organization and orphan exclusion, direct-report cross-entity denial, invalid dates, concurrent overlap and same-ID ownership conflicts, audit rollback, On Leave compatibility, exit revocation, role/account/permission/membership/relationship loss, current director/project scope, Teams refusal without token consumption and command-center counts. Real production React/API/PostgreSQL browser checks pass visible invalid-role refusal with zero writes followed by corrected save exactly once.

Backend/phase7 contracts and typecheck passed. Broader aggregate, migrations, production/startup, scans, candidate/frozen review and hosted gates remain required; final exact results belong in the PR. Locked installation succeeded with the known four high audit entries from the unpatched picomatch dependency chain. That inherited audit blocker is not waived by this package.

## Operations and rollback

Keep source-specific approval decisions authoritative. Existing retained delegation rows do not grant access when current ownership or authority cannot be established. Prefer forward correction: reverting application code restores ownership takeover and cross-entity disclosure. Preserve delegation/audit history. No production deployment or full approval/release acceptance is claimed.

## Candidate review corrections

Fresh candidate review identified two surviving delegated timesheet paths: owner source-permission revocation did not remove recipient decision authority, and delegation could approve the owner's own work. A real API regression reproduced both with 200 responses after adding the required Open reporting-period fixture (the initial409 was a fixture prerequisite failure, not security evidence). The source decision now additionally checks current delegator timesheets.approve, excludes owner self-work, validates the approval/worker source match and requires project-manager authority over actual timesheet projects. Regression checks pass both denials with complete unchanged source/audit snapshots, restored-permission legitimate approval, actual-project denial and legitimate delegated project work. No change is made to independent direct authority. These changes are within the same delegation boundary; the first candidate was never published or merged.
