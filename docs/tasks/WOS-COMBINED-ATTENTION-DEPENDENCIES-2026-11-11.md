# Combined attention and dependency integration candidate

## Scope and provenance

This separate draft composes PR #117's dependency repair (`218e6a61d8e60c89db3ba0c3480b372c8c1072ac`) onto the exact PR #118 attention workspace head (`6bbd30e456f79ccd8320a897fc88f29eb3c0e697`, tree `cea01fc4c6a9b3afc96fb6127168e8e3f515f78f`). PR #118 depends on PR #113 (`f34d91ef866e423ab0e320f6a710ca082f6e3f79`) and its open predecessor stack. No existing PR is merged, deployed or granted release acceptance. The held Admin prototype is not included or represented as recovered.

Requirements: WOS-NFR-SEC-011 / WOS-OPS-007, preserving PR #118's bounded operational reporting and workflow requirements. The earlier dependency-repair note is historical PR #117 evidence, not evidence for this combined tree.

## Reconciliation

- Preserve all PR #118 feature files, every existing test command and the complete attention suite. Append the four unchanged PR #117 dependency regressions to `npm test`.
- Keep Playwright 1.57.0 and its lockfile entries. Update PR #118's exact Vite pin from 6.4.4 to 6.4.6; do not replace its manifest with main's older manifest.
- Regenerate the lockfile with npm targeted updates, preserving existing dependency ranges other than that Vite patch pin. Express 4.22.3, tsx 4.23.15 and its esbuild 0.28.2, qs 6.16.2 and Vite 6.4.6 align with the repaired graph. Existing patched body-parser, proxy-addr, source-map-js and Zod versions remain.
- Add the PR #118 base branch to the CI allowlist, and explicitly invoke the existing attention browser script after Chromium installation. PR #118 exposed that script but did not invoke it in its workflow. Preserve all other jobs, permissions and checks.
- No schema, identity, permission, financial calculation, production data or deployment configuration changes.

## Verification and limits

Local validation uses Node 24.22.1 and npm 11.9.0. The published draft and its exact-head hosted run are the source of final combined status; the two predecessors' green runs do not establish combined acceptance.

- Clean `npm ci` passed; point-in-time `npm audit --audit-level=low --json` found zero vulnerabilities at every severity.
- Typecheck, syntax lint (513 JavaScript modules) and frontend build passed. The four dependency regressions passed unchanged. The build retains its existing large-chunk warning.
- An initial aggregate invocation without the repository's test-mode environment failed closed at the required-backend boundary. Validation is repeated using the workflow's synthetic test environment, not by changing application safeguards.
- The configured aggregate passed its preceding suites but stopped at the existing `tsx` CLI assignment-approval service suite because the sandbox denied its IPC Unix socket (`EPERM`). The command and sandbox policy remain unchanged; full aggregate success is a hosted gate, not a local claim.
- The local attention browser attempt could not start Chromium: the sandbox disallowed its process-singleton Unix socket. No sandbox restriction is bypassed. The explicit hosted workflow step uses the existing approved disposable CI runner and its normal browser setup.
- The attention browser fixture uses synthetic API responses through the real React transport/decoder. It does not prove each attention case against PostgreSQL. Existing real React/API/PostgreSQL journeys remain separate evidence; they are not replaced by this fixture.
- Real PostgreSQL/migration/container/production-identity and supported Node 22 validation remain hosted checks. No local disposable database or denied Docker fixture was attempted.
- Independent review, stack integration, visual/product UAT and release approval remain required even after CI passes.

## Security and rollback

Do not roll dependencies back to known vulnerable resolutions. Prefer a validated forward repair and retain both existing and new negative tests. No data migration requires reversal. This is a draft-only candidate; reverting the composition must not imply that the earlier dependency findings have been accepted.
