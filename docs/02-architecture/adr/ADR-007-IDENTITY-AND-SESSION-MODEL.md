# ADR-007 — Identity and Session Model

**Status:** Accepted  
**Date:** 2026-08-22

## Context

Buyer environments require enterprise identity while demonstrations and controlled setup may need local accounts. Production must support revocation, active-role selection and account lifecycle without provider-specific authorization shortcuts.

## Decision

Adopt provider-neutral OIDC as the production identity model, with Microsoft Entra supported by configuration. Keep local accounts for non-production or explicitly controlled fallback only. Maintain server-side user links, assigned roles, active role, effective permissions and revocable session state.

## Alternatives considered

1. Microsoft-only identity — rejected because it narrows buyers unnecessarily.
2. Permanent custom password/session-only model — rejected for enterprise production.
3. Provider groups directly authorize APIs — rejected because WorkOS data scope and policy remain necessary.

## Consequences

- Named production accounts and joiner/mover/leaver controls.
- Group mappings feed role assignment but do not bypass permissions.
- Session expiry, revocation and security events are auditable.
- OIDC claims and signing keys are validated according to provider standards.

## Verification and rollback

OIDC contract tests, disabled-user/session-revocation tests and active-role negative tests are mandatory. Rollback may switch a non-production environment to local provider; production fallback requires explicit owner approval.