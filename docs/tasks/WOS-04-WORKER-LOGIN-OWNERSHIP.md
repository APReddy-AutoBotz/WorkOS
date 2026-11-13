# Worker login ownership

Addresses WOS-IAM-003/005/006/010 and WOS-NFR-SEC-003/004/008. Profile saves and employee imports previously treated a fallback username collision as permission to overwrite the existing account. The shared provisioning service now creates accounts without updating a conflicting username. Existing accounts are updated only by their locked ID, bound employee and active organization/legal-entity scope; username, binding and password remain unchanged.

New account name selection checks case-insensitive occupancy, tries the worker code and scoped code, then bounded random-suffix alternatives. A transaction advisory lock serializes account creation across this deployment. Database uniqueness remains authoritative for writers outside this service. Conflicts return sanitized HTTP 409 WORKER_LOGIN_CONFLICT and roll back the employee transaction. No migration or dependency change is required.

## Verification and operations

The new real PostgreSQL/API regression reproduces the baseline overwrite and passes after repair. It covers occupied base and scoped usernames, profile and legacy import creation, unchanged victim account/roles/scopes/direct grants, existing-account edits, simultaneous same-code creation across organizations, and duplicate login email rollback. The protected identity administration PostgreSQL regression also passes.

Type checking passes and syntax checking passes for 523 modules. The complete aggregate unit/contract suite passes (127 top-level commands), including branding build checks. The existing project import-to-audit browser journey passes through both importer and distinct reviewer phases. This journey is project-import evidence; employee provisioning is verified by the focused API/database test. Dependencies reuse the verified parent lockfile installation. An initial concurrent build failed from host memory exhaustion and a concurrent browser attempt was terminated after stalling; both full checks subsequently passed when run sequentially. Hosted exact-head CI remains required.

No production data or deployment is changed. Existing historical case-variant usernames are not migrated. Creation serialization favors correctness over provisioning throughput; this does not lock routine account edits. General duplicate employee-email validation is outside this repair. Rollback reopens cross-account overwrite behavior, so prefer a forward correction. This package does not close the separate session-revocation or login-throttling findings.
