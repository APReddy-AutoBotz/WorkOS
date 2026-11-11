# Dependency audit repair, 2026-11-11

## Scope and status

Candidate for WOS-NFR-SEC-011 and WOS-OPS-007. This is a separate dependency-only repair based on published main `b9a57f8a462d8585bb3f73129080d6fae5173343` (tree `a05708da043df0c96a15f2d521887adde0b6bd5e`), not integration of the held Admin prototype in Draft PR #116.

[PR #116 CI run 42964093546](https://github.com/APReddy-AutoBotz/WorkOS/actions/runs/42964093546) failed its unchanged dependency audit with seven findings: one critical, four high, one moderate and one low. This repair changes resolved packages and adds regression tests. It does not change authentication, proxy configuration, authorization, routes, database schema, CI permissions, audit thresholds or the secret scanner. No override, forced update or major Express/Vite upgrade is used.

## Resolved dependency changes

| Package | Before | After | Reason |
|---|---|---|---|
| body-parser | 1.20.8 | 1.20.9 | Compressed-body error lifecycle fix |
| proxy-addr | 2.0.7 | 2.0.8 | Correct IPv4-mapped IPv6 trust boundaries |
| qs | 6.14.2 / 6.16.0 | 6.16.2 | Query parsing/stringification fixes; duplicate removed |
| source-map-js | 1.2.1 | 1.2.2 | Indexed-map offset validation |
| vite | 6.4.3 | 6.4.6 | Patched Vite 6 maintenance release |
| zod | 4.3.6 | 4.6.7 | Patched validation release |
| express | 4.22.1 | 4.22.3 | Upstream compatible qs dependency range |
| tsx | 4.21.0 | 4.23.15 | Upstream compatible esbuild dependency range |
| esbuild (tsx) | 0.27.7 | 0.28.2 | Patched Windows development-server handling |

All esbuild platform packages move together. Vite's separate 0.25.12 copy is outside GHSA-g7r4-m6w7-qqqr's affected interval and remains unchanged. Upstream tsx no longer needs get-tsconfig/resolve-pkg-maps, so those are removed. Root dependency ranges remain unchanged and `npm ci` continues to use the exact lockfile.

Primary references: [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828), [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [qs](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw), [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [Vite](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [esbuild](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).

## Regression coverage

`npm run test:dependency-security` is part of the existing aggregate `npm test` gate. Its four tests cover:

- Every affected lockfile instance retains a patched version, including nested esbuild instances.
- Invalid short IPv4-mapped IPv6 trust ranges do not trust unrelated IPv4 clients; a correctly expressed mapped range still accepts only its intended subnet. The application's `trust proxy = 1` is unchanged.
- Real working-calendar validators accept a valid synthetic calendar and reject oversized/duplicate weekday arrays and invalid/caller-supplied scope fields.
- An isolated Express process accepts valid gzip, handles trailing deflate bytes sent only after decompression completes, survives a malformed gzip tail, and serves subsequent health/valid requests. It binds only loopback, uses bounded payloads and a process timeout, and neither reads nor writes business data.

The HTTP regression was also run against an existing unmodified installation of body-parser 1.20.8 and failed with the expected uncaught decoder error. The prior proxy-addr 2.0.7 trusted the unrelated test address; 2.0.8 rejects it. These controls establish that the targeted tests detect the relevant baseline behavior, not merely that the new versions start.

## Verification and remaining gates

Local verification uses Node v24.22.1 and npm 11.9.0:

- PASS: clean `npm ci` from the updated lockfile.
- PASS: `npm audit --audit-level=low --json`, zero findings at all severities as of 2026-11-11. This is a point-in-time registry result, not a guarantee of no vulnerabilities.
- PASS: typecheck, syntax lint, frontend build, aggregate tests including the four new tests, organization-setup smoke and authorization-convergence smoke.
- PASS: original vulnerable HTTP/proxy behavior was detected in isolated negative controls.
- NOT RUN locally: real PostgreSQL migrations/production identity, Docker/Compose and browser journeys. Supported Node 22 and existing database/container/security gates must pass on the exact published head in hosted CI. No UI change is included.
- Independent review, merge and deployment remain separate gates. This patch does not resolve or waive PR #116's Admin transaction-authorization acceptance requirements.

## Rollback

There is no data or schema migration. Reverting the dependency changes would restore known findings and must not be treated as a safe release rollback without security disposition. Prefer a validated forward fix; keep the existing audit and secret-scan gates enabled. Retain the regression tests when moving this repair to another active work branch and regenerate the lockfile through npm rather than manually changing integrity values.
