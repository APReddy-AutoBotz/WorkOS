# Bounded authentication throttling and explicit proxy trust

Requirements: WOS-IAM-001; WOS-CORE-003/005; WOS-NFR-SEC-001/002/008/013, MNT-005 and DPL-003.

## Scope

Baseline execution of the original middleware retained 10,002 expired/distinct keys and accepted 100 attempts with an invalid numeric limit. The limiter now caps live hashed state at 10,000 entries, reclaims expired fixed windows, bounds aggregate IP attempts and fails closed at capacity without evicting active protections. Default per-input/callback limit remains 8; aggregate IP limit is 64. Values must be positive integers up to 1,000,000. Callback flow is selected by its route middleware, not caller body/path casing. Disabled or production local login returns404 before database/limiter work.

Default direct-peer trust rejects forged forwarding headers. Optional explicit IP/CIDR proxy trust is validated centrally, forwarded by Compose and documented operationally. Audit IP uses the same Express-resolved address. No schema/dependency/grant or identity-selection change. Different accepted account aliases keep separate input buckets, bounded by the shared IP budget.

## Evidence

Fresh investigation reproduced expiry retention, malformed-limit bypass and forwarded-IP/callback-body bypasses in the earlier candidate. The revised candidate passed nine actual HTTP/unit tests for bounds, expiry, normalization, malformed/large names, callback bodies, path casing, disabled routes, direct-peer spoofing and trusted multi-hop chains. Runtime environment, audit record and authorization convergence checks passed. Independent candidate review found no concrete introduced bypass; its production test could not resolve an inherited database hostname and is not counted passing. Integrated disposable-database production validation is required separately.

Locked installation passed with zero vulnerabilities; hygiene and adversarial fixtures passed 493 files. Type checking, lint and the full unit/contract aggregate passed, including all nine actual PostgreSQL configuration timezone suites. Setup read, current-role and protected-identity PostgreSQL negatives, actual-driver TLS checks and all 54 fresh/concurrent/replay/upgrade/rollback migration entries passed. Both real PostgreSQL browser journeys (import/audit and Employee own-work planning) passed. Production identity/startup, exact frozen-head security review and hosted CI are tracked in the PR and must pass before merge. Persistent/distributed throttling, per-session logout revocation and other repository findings remain open; no production readiness or deployment is claimed.

## Security and rollback

Process-local counters reset on restart and are not shared across replicas. At capacity new clients may receive429 until expiry; buyer proxy/NAT topology and rate limits require deployment acceptance. Trust only the real ingress peers and sanitize forwarding headers. Do not treat this incremental correction as completion of persistent production throttling requirements. Prefer a forward fix; reverting restores retention, malformed-limit and forwarded-IP risks. No rollback SQL or record rewrite is required.
