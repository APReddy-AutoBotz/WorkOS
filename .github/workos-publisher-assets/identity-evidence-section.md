## WOS-01A clean-runtime product closure

### Authority and bounded outcome

- Parent PR #16 head/base: `590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60`.
- Identity convergence input head: `0935424a52b57cc3a51adeef737e6eaec2946a88`.
- Accepted WOS-00 merge base: `1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea`.
- The closure retains the dependency, lint and emitted-metadata corrections and adds governed production identity discovery shared by startup/readiness, authentication initiation, token exchange and JWKS retrieval.
- Changed identity paths are `server/identity-discovery.mjs`, `server/start-production.mjs`, `server/index.mjs`, `tests/identity-discovery-smoke.mjs`, `tests/production-identity-smoke.mjs`, `package.json` and this evidence record.
- No migration, customer data, real-provider call, credential, deployment, hosted mutation, reference-repository write or local-production fallback is introduced.

### Product construction check matrix

| Check | Result | Evidence |
|---|---|---|
| Locked dependency installation | PASS | Guarded publisher executes `npm ci` before publication. |
| WOS-00 baseline verifier | PASS | Exactly 126 product requirements, 81 NFRs and ADR-001..008 remain intact. |
| Bootstrap scanner and adversarial self-test | PASS | New identity files and fixtures remain within the credential/domain/provenance boundary. |
| JavaScript lint and TypeScript type check | PASS | The governed modules and existing product compile gates execute before publication. |
| Retained safe suite | PASS | Includes direct identity-discovery redirect/downgrade/wrong-tenant/response-bound negatives and emitted metadata builds. |
| Discovery authority | PASS | One loader validates the exact configured discovery URL with redirects disabled, effective-URL equality, bounded response size and tenant-bound issuer/endpoints. |
| Authentication authority | PASS | `/api/auth/entra/start`, token exchange and JWKS retrieval reuse the same governed loader/fetch boundary. |
| Production startup negatives | PASS | Missing setting, unsupported provider, unavailable discovery and invalid discovery document fail startup/readiness closed. |
| Production positive/outage | PASS | Entra startup reaches connected health, local login stays 404, anonymous protected API stays 401, no users/employees are seeded, authentication initiation uses configured discovery, and later discovery outage terminates readiness. |
| Exact published-head full controller matrix | PENDING | Must be rerun after guarded publication and may not be inferred from construction checks. |
| Independent exact-head review | PENDING | Required after executable published-head acceptance. |

### Frozen A–I adversarial assessment

- **A — Application path:** canonical server startup and Entra routes remain; discovery logic is centralized rather than duplicated.
- **B — Authorization/security:** production supports only the implemented Entra contract, local login remains disabled, redirects/effective downgrade are rejected, and issuer/endpoints are tenant-bound.
- **C — Concurrency:** publication must use the exact old head above; later controller acceptance revalidates every head/base lease.
- **D — Replay/idempotency:** no migration changes are made; startup and periodic readiness call the same deterministic loader.
- **E — Lifecycle:** PR #27 and parent PR #16 remain Draft; this record authorizes no merge or deployment.
- **F — Partial failure:** invalid, unavailable, redirected, oversized or wrong-tenant discovery evidence remains visible and fails closed.
- **G — Bounds:** discovery time and response size are finite; no generated cache, build output or unbounded fixture is committed.
- **H — Fallback:** loopback HTTP discovery requires explicit opt-in and a loopback application URL for disposable tests; production local authentication remains prohibited.
- **I — Evidence:** accepted WOS-00 requirements, NFRs, ADRs and source provenance remain unchanged; exact published-head acceptance and review remain separate gates.

Security impact includes production identity startup/readiness and authentication-path convergence. Rollback is a reviewed revert of this bounded identity convergence; migrations and persisted data are unaffected.
