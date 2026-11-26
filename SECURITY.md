# WorkOS Security Policy

## Supported versions

Security fixes are applied to the current supported release line and the active release-candidate branch. Support policy will be versioned before `v1.0.0`.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue or pull request. Report them privately to the repository owner through an agreed private channel. Include:

- Affected version or commit.
- Reproduction steps and required role.
- Expected and actual behavior.
- Impacted data or trust boundary.
- Suggested mitigation, if known.

Do not include real customer data, production credentials or exploit data beyond what is necessary to validate the issue.

## Security properties

WorkOS must preserve these properties:

1. Every protected request requires authenticated identity, active role, permission, organization/legal-entity boundary, row/data scope and applicable business policy.
2. UI hiding is never the security boundary.
3. Cost rates, compensation-derived information and margin are separately permission controlled.
4. Production uses named accounts and fail-closed configuration.
5. Sessions are time limited and revocable in the production target state.
6. Approval, financial, period-lock and audit behavior is server authoritative.
7. Audit evidence is append-only for normal users.
8. Secrets are never returned by configuration or health endpoints.
9. Integration failures do not silently corrupt or undo valid core transactions.
10. Historical financial results are protected from silent recalculation.

## Secure development gates

Security-sensitive PRs require:

- Threat-boundary analysis.
- Negative authorization and cross-scope tests.
- Input/output schema validation.
- Secret and dependency scanning.
- Migration and rollback review.
- Logging review for sensitive-data exposure.
- Exact-head independent review before merge.

## Historical scanner findings

The five entries in `.gitleaksignore` identify individual historical occurrences by commit, file, rule and line. Three are the session fixture used by the local WOS-02 acceptance service. The project owner reported using no secrets. Repository inspection traced the other two values to a synthetic request idempotency key and a published file-verification checksum. WorkOS issue #10 holds the provenance and scan evidence. A finding at a different commit or location requires its own disposition.

## Exclusions

This policy is not a guarantee of vulnerability-free software and does not replace buyer-specific penetration testing, identity configuration, infrastructure security or operational monitoring.