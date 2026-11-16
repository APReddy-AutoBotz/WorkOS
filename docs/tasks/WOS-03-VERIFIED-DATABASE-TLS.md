# Verified database TLS

Requirements: WOS-NFR-SEC-001/007/008/013, WOS-NFR-MNT-005 and WOS-NFR-DPL-003.

The API, migration runner and non-production demo seed previously used rejectUnauthorized=false in require mode. A shared connection policy now validates certificate trust and database hostname in require and verify-full modes. PGSSLROOTCERT optionally provides a mounted CA bundle; otherwise runtime trust applies. Local disable mode remains available and is not proof of production transport compliance.

URL TLS overrides are rejected because the locked driver otherwise replaces explicit policy. Duplicate host parameters and ambiguous percent-encoded or socket hostnames are rejected for verified TLS. Single query-host decoding follows the driver's parsing. Missing/empty CA inputs fail without printing credentials or file paths. Both Compose consumers receive the CA setting; operators must mount the bundle read-only into both services.

## Evidence checkpoint

Locked install passed with zero vulnerabilities. Baseline actual pg transport accepted an untrusted peer (expected rejection missing). Focused corrected transport and environment tests pass: trusted IP handshake under both verified modes, untrusted/wrong-host rejection before startup data, alternate URL controls, duplicate/encoded hostname rejection, missing/empty CA, unsupported modes and explicit plaintext. The synthetic protocol endpoint proves driver transport behavior, not a real production database. Type checking, linting and full unit/contract aggregate passed. All 54 migration entries passed fresh/concurrent/replay/upgrade/rollback acceptance. Both retained import/audit and own-worker browser journeys passed. Actual disposable PostgreSQL migration and demo seed compatibility passed with 122 synthetic workers; the first verification query used a nonexistent table and was corrected without product changes. Hygiene/adversarial scanning passed 488 files after removing unnecessary synthetic URL credentials. Production build passed (20.35 seconds); signed startup/identity acceptance, final frozen-head review and hosted gates are tracked in the PR. Candidate review found missing Compose CA forwarding and CI regression invocation; both are corrected. No checks were relaxed. No migration or dependency change.

## Operations and rollback

Before rollout, provision a CA and matching database name; formerly accepted untrusted/self-signed endpoints will fail. See the operations runbook for both container mounts and certificate rotation. Prefer a forward configuration fix; reverting restores the certificate-validation vulnerability. No buyer deployment or full product security acceptance is claimed.
