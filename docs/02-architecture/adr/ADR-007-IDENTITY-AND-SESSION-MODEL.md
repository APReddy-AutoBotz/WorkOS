# ADR-007 — Identity and Session Model

**Status:** Accepted  
**Date:** 2026-08-22

## Context

Buyer environments require enterprise identity while demonstrations and controlled setup may need local accounts. Production must support revocation, active-role selection and account lifecycle without provider-specific authorization shortcuts or an unsafe authentication fallback.

## Decision

Adopt provider-neutral OIDC as the production identity model, with Microsoft Entra supported by configuration. Local accounts are permitted only in non-production/demo profiles and must be disabled or absent in production. Maintain server-side user links, assigned roles, active role, effective permissions and revocable session state.

Production OIDC unavailability fails closed. Product-owner approval alone cannot switch a production deployment to WorkOS local authentication. Any emergency identity recovery must be an externally controlled infrastructure or identity-provider break-glass procedure using a named identity, separate approval and audit evidence; it must not activate WorkOS local accounts or bypass WorkOS authorization, active-role, data-scope or session controls.

## Alternatives considered

1. Microsoft-only identity — rejected because it narrows buyers unnecessarily.
2. Permanent custom password/session-only model — rejected for enterprise production.
3. Provider groups directly authorize APIs — rejected because WorkOS data scope and policy remain necessary.
4. Local-auth production fallback — rejected because it conflicts with fail-closed production identity, named-account and session-governance requirements.

## Consequences

- Named production accounts and joiner/mover/leaver controls.
- Group mappings feed role assignment but do not bypass permissions.
- Session expiry, revocation and security events are auditable.
- OIDC claims and signing keys are validated according to provider standards.
- Production readiness fails while the required OIDC provider is unavailable or unsafe.
- Break-glass recovery remains external to WorkOS local authentication and is separately governed and audited.

## Verification and rollback

OIDC contract tests, disabled-user/session-revocation tests and active-role negative tests are mandatory. Production negative tests prove local-account login and automatic/manual local-provider fallback are rejected when OIDC is unavailable. Break-glass evidence proves named external identity, approval, audit and preserved WorkOS permission/data-scope checks.

Rollback may switch a non-production environment to the local provider. A production rollback must restore a previously accepted OIDC configuration or keep the deployment unavailable; it must not enable WorkOS local authentication.
