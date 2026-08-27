# WOS-01A — Clean-Runtime Acceptance Closure

## Authority

- **Workstream:** WOS-01A
- **Governing issue:** #3
- **Parent implementation PR:** #16
- **Stacked closure branch:** `codex/wos01a-acceptance-closure`
- **Stacked base branch:** `codex/wos-01-authorized-source-bootstrap-v2`
- **Required parent head at construction start:** `590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60`
- **Accepted WOS-00 merge base:** `1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea`
- **Authorized source:** `APReddy-AutoBotz/Boundaryless-WorkOS@f2de1d85126f5d64f0e2e21b085b0303ca1d8417`, read-only

This task closes only blockers proven after the authorized source bootstrap was published. It must not add WOS-02+ capability, rewrite accepted WOS-00 authority, deploy, use live providers or customer data, or modify the source repository.

## Proven blocker inputs

Read-only exact-head acceptance run `33094613638` against parent PR #16 reported:

- **P1:** the production dependency graph contained high-severity advisories requiring exact runtime reachability and supported-version remediation.
- **P2:** the default build left `%VITE_PRODUCT_NAME%` and `%VITE_PRODUCT_LOGO_URL%` unresolved in `dist/index.html`.
- PostgreSQL fresh/replay/upgrade-shaped migrations and production startup/health/local-login/no-seed checks passed in that run.
- Browser evidence was non-terminal and remains an acceptance gate, not a completed claim.

The first committed correction replaces unresolved HTML placeholders with neutral WorkOS defaults while retaining configurable document title/favicon behavior through `import.meta.env`.

## Required outcome

Produce one cohesive, reviewable clean-runtime correction that:

1. leaves a default production build with no unresolved `%VITE_*%` tokens and neutral WorkOS title/favicon;
2. preserves configured `VITE_PRODUCT_NAME` and `VITE_PRODUCT_LOGO_URL` behavior;
3. remediates every reachable production high/critical advisory through supported direct/transitive dependency and lockfile updates;
4. does not use `npm audit fix --force`, blanket overrides, ignored advisories or suppressed audit exits;
5. preserves the exact WOS-00 requirements/NFR/ADR/provenance baseline and WOS-01A source manifest;
6. reruns locked install, typecheck, lint, build, retained tests, bootstrap scan and WOS-00 verifier;
7. reruns runtime-only and full dependency audits and records both truthfully;
8. reruns disposable fresh/replay/upgrade-shaped migrations, production health/auth/no-seed and bounded browser route evidence through the accepted controller;
9. keeps the parent PR Draft and does not merge or deploy.

## Dependency-remediation rules

- Inspect `npm audit --omit=dev --json` and the lockfile before changing versions.
- Identify each high/critical advisory path and whether it is runtime reachable.
- Prefer current supported releases within the existing architecture and framework major where safe.
- A major upgrade is allowed only when required to remove a reachable blocker and when all affected code/tests are updated coherently.
- Regenerate the lockfile with the repository package manager and run `npm ci` from a clean state.
- Do not add unreviewed resolutions/overrides solely to hide the advisory.
- Full/dev-only advisories must be recorded even when they do not block runtime acceptance.

## Default and configured branding tests

The closure must prove:

1. `npm run build` with no branding environment succeeds and `dist/index.html` contains `WorkOS` and `/workos-mark.svg` with no `%VITE_*%` token.
2. A configured build with a synthetic product name/logo succeeds and the document metadata reflects those values.
3. Runtime application branding remains sourced from `src/config/productConfig.ts`.

## Frozen A–I closure matrix

A. **Application path:** canonical build/start and route paths remain intact; no later workstream is introduced.
B. **Authorization/security:** production identity remains fail closed; local fallback stays test-only; no credential or real data is added.
C. **Concurrency:** no accepted lock, uniqueness, transaction or scope guard is weakened.
D. **Replay/idempotency:** install, migrations and accepted stateful operations remain replay safe.
E. **Lifecycle:** approval, notification, timesheet, leave and project states continue to follow accepted authorities.
F. **Partial failure:** audit/build/test/migration/startup/browser failures remain visible and block acceptance.
G. **Scale/bounds:** no dependency cache, generated build output or unbounded fixture is committed.
H. **Fallback hierarchy:** neutral defaults are safe; governed configuration overrides them; production never falls back to demo/local identity.
I. **Retained evidence:** exact heads, manifests, hashes, audits and check outcomes are reproducible and no accepted history is overwritten.

## Required evidence

Report every item as `PASS`, `FAIL`, `SKIP` or `NOT RUN`:

- exact parent/base/head and changed paths;
- `npm ci`;
- typecheck, lint and retained tests;
- default and configured builds;
- runtime and full audit summaries plus advisory paths;
- WOS-00 verifier and bootstrap scanner;
- fresh/replay/upgrade-shaped migrations;
- production startup, connected health, local-login 404, protected API 401 and zero auto-seeding;
- bounded role-route browser evidence;
- `git diff --check` and clean worktree after generated artifacts are removed;
- independent exact-head review.

Construction completion does not authorize Ready, merge, deployment, live-provider use, WOS-02+ work or reference-repository mutation.
