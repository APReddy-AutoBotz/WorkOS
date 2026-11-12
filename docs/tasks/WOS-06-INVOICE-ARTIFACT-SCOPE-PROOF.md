# Retained invoice artifact scope proof

Test-only dependent follow-up to PR #120 (source tree `12d65076ab787705c6c95f156e9ca46cec7d4e9b`).

## Existing policy and scope

WOS-IAM-003/005 require active permission and data scope; WOS-RPT-006 requires server-scoped exports. The invoice artifact router already authorizes invoice-export viewing and checks the batch worker scope. No product policy, role grant, runtime, schema or migration changes.

The existing synthetic Employee lacks invoice export permission; the existing synthetic TeamLead has export permissions but lacks the invoice worker relationship. Assert 403 and 404 respectively against the exact retained artifact URL, no artifact/payload/checksum/total/currency fields in error responses, and unchanged authorized retrieval afterward. This does not establish a full two-project project-manager UAT scenario or concurrent revocation safety.

## Verification

Local syntax, lint and relevant client contract results are recorded in the draft PR. The real PostgreSQL driver requires WORKOS_TEST_DATABASE_URL and is blocked locally without a disposable database. Hosted verification must execute the changed invoice-billing-confirmation-postgres-smoke.mjs driver; a client-contract pass is not that evidence. Existing CI gates remain unchanged; only the dependency base branch is added to its trigger filter.

## Operations and rollback

No runtime rollout or data migration. Reverting these test/documentation/CI-trigger changes removes only regression coverage. No secrets or real customer data were added. Main integration, formal review and release remain separate.
