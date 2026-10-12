# WorkOS Security Architecture

## Trust boundaries

```mermaid
flowchart LR
    User[User Browser] -->|TLS| App[WorkOS Web/API]
    App --> DB[(Buyer PostgreSQL)]
    App --> IdP[OIDC Identity Provider]
    App --> Providers[Notification / Worklog / Finance Providers]
    App --> Secrets[Buyer Secret Store]
    App --> Logs[Monitoring / Logs]
```

The browser and all external providers are untrusted inputs. The API and database enforce authoritative policy.

## Authorization model

Every protected action combines identity, active role, permission, organization/legal entity, row/data relationship and current business policy. Delegation grants only the delegator's valid authority for the permitted entity/time range.

## Identity and sessions

- Every production deployment requires named accounts and configured OIDC. Missing, invalid or unavailable required OIDC configuration fails startup/readiness and authentication closed.
- WorkOS local authentication and shared/demo identities are limited to approved non-production/demo profiles, are disabled or absent in production and cannot be activated as a production fallback.
- Sessions are time limited, securely cookie/token managed and revocable in the target state.
- Disabled/leaver identities lose new access immediately and active sessions are revoked according to policy.
- Authentication and role-switch events are audited.

## Application protections

- Server-side schema validation and safe error contracts.
- Explicit CORS, CSRF and security-header posture.
- Persistent/distributed login throttling strategy for production.
- Parameterized database access and least-privilege database identities.
- Sensitive DTO/log filtering for personal, cost and margin data.
- Secure defaults and fail-closed production configuration.

## Data protection

Encryption in transit is mandatory. Managed database/storage encryption at rest is expected from the buyer platform. Secrets remain outside source and normal database configuration. Retention, anonymization and exports are governed and audited.

## Audit and monitoring

Security-relevant events include login failures, session/role changes, permission changes, denials, exports, commercial changes, integration failures and administrative configuration changes. Logs use correlation IDs and avoid secret/full-payload exposure.

Organization/legal-entity audit reads remain restricted to the exact server-resolved pair. Null-scope deployment records use a separate read-only view that requires an active account, an active role still assigned to that account, and an explicit per-user `audit.deployment.view` grant. The permission is protected, denied to every role by default, and cannot be enabled role-wide. The existing permission-management path can assign it to a different active user of any role; no user can grant it to themself. The deployment query selects only rows with both scope columns null and applies the shared audit-history redaction. No auditor grant is provisioned by the application or migration.

## Verification

Each protected module includes positive and negative authorization tests, cross-organization scope tests, direct API tests and browser journeys. Production-mode tests prove that missing, invalid or unavailable required OIDC configuration fails closed and never enables local authentication. Security review and vulnerability disposition are release gates; buyer-specific penetration testing remains part of deployment acceptance.
