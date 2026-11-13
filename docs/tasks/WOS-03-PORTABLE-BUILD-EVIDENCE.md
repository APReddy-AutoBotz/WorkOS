# Portable branding-build verification

## Outcome and scope

The 2026-11-14 enterprise review reproduced a Windows failure in `test:document-metadata`: Node cannot execute npm's Windows command shim through `execFileSync('npm', ...)`. Consequently the aggregate suite stops before its later contracts, despite successful type and syntax checks.

This bounded WOS-OPS-007 / WOS-NFR-RELSE-001 / WOS-NFR-MNT-005 change starts from PR #121 head `57db202e3ad60587c1c242071a9316ad2dfc9d76`. It invokes the installed Vite CLI through the current Node executable without a shell. Both real default and configured-brand builds retain their existing output assertions and cleanup. A Windows CI job exercises this regression; existing Linux application, PostgreSQL, browser, container and secret checks remain mandatory.

The review discovered that the shared root folder reflects older main `b9a57f8a462d8585bb3f73129080d6fae5173343`, while substantial product work exists in dependent Draft PRs. Work continues in a separate checkout of that feature stack. The dependency repair already present in PR #117 and composed into PR #119 is reused rather than duplicated. No runtime, schema, permission, policy, dependency or production change is included here.

## Verification

Local Windows / Node 24.22.1 / npm 11.5.2:

- Original main test: failed with `spawnSync npm ENOENT`.
- Latest stack: clean locked `npm ci` passed with zero dependency advisories.
- Type checking and syntax lint passed (513 JavaScript modules).
- Default and configured-brand real builds passed after the invocation fix.
- Aggregate `npm test` passed all 126 top-level commands, including default/configured-brand builds and the four dependency-security regressions (exit 0).
- `npm audit --audit-level=low` passed with zero findings on 2026-11-14.
- Operational-attention Chromium journey passed with synthetic API responses: scoped page coverage, filtering, keyboard focus, mobile fit, handoffs and stale-context clearing. Its initial cold-load attempt exceeded the existing ten-second navigation timeout; a repeat passed without changing the test or timeout. This is not database-backed browser evidence.
- `git diff --check` passed. Exact published-head hosted CI remains pending and is reported separately in the Draft PR.

This document is engineering evidence for the bounded test repair, not acceptance of the full Draft stack or completion of the enterprise review. Main integration, independent review, buyer UAT and release gates remain open.

Hosted run `43491562590` passed Windows branding and full-history Gitleaks, plus the Linux install, typecheck, lint, build, aggregate unit/contract suite and all database checks preceding browser installation. Browser installation then failed because `ubuntu-latest` resolved to Ubuntu 26.04, for which the locked Playwright registry has no Chromium artifact. The validation job now explicitly uses Ubuntu 24.04, which is present in the installed browser registry. No browser or assertion is skipped; the corrected head must pass the complete hosted pipeline.

## Operations and rollback

Run `npm ci`, then `npm run test:document-metadata` on Windows or Linux. The test builds twice and removes `dist` afterward; run `npm run build` before starting the application. It uses the installed, lockfile-resolved Vite executable and inherits each test's explicit environment. No shell interpolation or global npm executable lookup is needed.

There are no data migrations or deployment changes. Reverting restores the Windows verification failure but does not change product behavior. Preserve output assertions and existing security gates when adapting the build tool in future.
