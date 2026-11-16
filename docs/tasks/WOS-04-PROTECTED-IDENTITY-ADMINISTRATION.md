# Protected identity administration

## Boundary and requirements

WOS-IAM-003/005/006/010, WOS-CORE-003/005 and WOS-NFR-SEC-002/004/005 require workforce editing to remain separate from security administration. Profile saves and both Employee Master import aliases must not grant privilege from employee codes or caller-supplied roles. Explicit role changes require the current active Admin role and effective `permissions.manage` inside the transaction. New accounts default to Employee; omitted roles preserve existing assignments. Before/after role audit evidence accompanies changes. The final assigned administrator cannot be removed through these role-edit paths.

Identity links, group-role mappings and profile/import Entra binding changes additionally require `integrations.identity`. Explicit Disabled or Pending Entra links override legacy subject columns at callback. Employee locking serializes the callback's binding check against binding writers; a legacy subject may bootstrap a link only when no explicit link exists.

Existing-account `initial_password` is rejected by profile saves; imports retain existing password hashes. New credentials use the existing configured password policy. Workforce reset authority remains sufficient for ordinary unbound Employee accounts. Non-Employee roles, individual permission grants, organization-audit grants and Entra-bound accounts require protected security administration. Provider groups are session claims, so local assigned roles alone cannot reliably classify a federated target. Explicit Entra links in any state and both legacy Entra subject columns count as bindings; this is not a claim that local login inherits provider group roles.

## Evidence and scope

This package ports the bounded later Draft PR125 repair onto accepted main without importing its unrelated dependencies. Parent-source regression showed an `ADMIN-` employee received Admin instead of Employee. Investigation of the proposed repair identified missing organization-audit target protection; the real API returned 200 instead of expected 403 for that reset. The corrected focused suite passes these triggers, unchanged-hash negatives, ordinary/admin positive resets, direct/legacy provider binding protection, omitted-role preservation and both import aliases with atomic rollback.

Real production identity tests retain signed issuer/audience/nonce/replay checks and add Disabled/Pending link negatives. The test-only callback allowance changes from nine to eleven for the two new cases; the production default remains eight. Provider mapping alternatives and role-revocation tests from PR162 remain intact. Exact-head full suite, production/browser/migration evidence, independent review and hosted checks are required before acceptance and recorded in the PR/checkpoint.

No dependency, schema migration, grant default or production identity fallback is introduced. Requirements remain bounded: last-administrator protection here covers profile/import role removal, not every account disable or external identity lifecycle. Per-session logout revocation, live group membership, broader permission administration, other audit findings and buyer/release acceptance remain separate.

Independent candidate review found a surviving username-conflict overwrite and a mapped-only maintenance regression. Real API tests reproduced HTTP 200 instead of 409 for the collision and 422 instead of 200 for mapped-only maintenance. Both account upserts now permit a username conflict update only for the exact existing user and employee binding previously resolved by the server; otherwise they return `LOGIN_BINDING_CONFLICT` and roll back. Across profile and both import routes the regression preserves victim credentials, worker binding, Admin/Employee roles, organization-audit grant and scope. Omitted roles on an existing mapped-only account now perform no role mutation; explicit empty profile assignments remain invalid.

Focused corrected PostgreSQL tests and scanner/adversarial fixtures pass (486 scanned files). Test credentials are generated per run. The first scanner invocation rejected static/template credential declarations; fixtures were corrected without changing scanner rules. The initial aggregate was interrupted after review identified needed corrections and is not acceptance evidence; the corrected aggregate and production/browser/hosted checks are tracked separately.

The corrected typecheck, lint and complete unit/contract aggregate passed with exit 0. Migration acceptance passed all 54 entries across fresh/concurrent/replay/upgrade/rollback paths. UTF-8 review covers all 15 changed paths and 127 local documentation links resolve. Production identity/browser, final frozen-head security review and hosted acceptance remain tracked in the PR; these earlier checks alone do not authorize merge.

## Operations and rollback

Provisioning operators must request an authorized security administrator for protected role, credential or identity-binding operations. Ordinary profile editing and unbound Employee reset continue with their existing workforce permissions. Existing privileged roles are preserved when omitted; employee codes no longer confer authority. A rejected import security change rolls back the batch's earlier writes.

No conversion is needed. Reverting this package reopens the documented privilege/binding weaknesses; prefer a tested forward correction or temporarily unavailable affected administration. Preserve audit/history and production OIDC enforcement. No production deployment or buyer-data mutation is performed.
