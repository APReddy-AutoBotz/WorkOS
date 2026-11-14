# WOS-03 integration acceptance

Status: locally verified integration candidate; hosted acceptance and final integration gates remain open. Existing Draft PR41 starts at `396bd955a3e4df47d91b4f4f31f49f2d9a641b0e`; accepted main is `bbce9753f151c28f54500fa676ebb9fce502b8df`. The owner explicitly authorized eligible GitHub merges. Acceptance gates remain binding.

## Outcome and scope

Reconcile the oldest implementation dependency with current main, preserve accepted product direction and dependency fixes, and verify the modular API/audit foundation before dependency-ordered integration. Requirements: WOS-CORE-003/005, WOS-GOV-001/002/004 and applicable WOS-OPS/MNT/OBS controls under issue5 and PR-006 in the implementation backlog.

The local merge resolves only overlapping package test definitions and CI steps, retaining both WOS03 coverage and main's dependency-security checks. Main's documentation and lockfile changes remain. No migration is added or rewritten by this integration increment.

Existing real import-to-audit acceptance tests are brought forward from the reviewed WorkOS implementation stack at `48f563ca648ead0baa716540b833cc055e75a5e7`: browser journey, isolated harness, harness negatives and tracked PostgreSQL cleanup helper. These tests originated in PR50. No later production module is imported. They run the actual app/API/PostgreSQL with two synthetic named accounts using the existing Admin role, persisted permissions and distinct browser contexts. OIDC is not simulated as accepted production authentication. Provenance, dry-run versus apply, scoped reviewer reads and absence of read-side mutations are asserted.

## Evidence and outstanding gates

Fresh npm ci passed:338 installed,345 audited, zero vulnerabilities. Typecheck, lint and the complete pre-journey unit/contract suite passed after main integration. The imported harness negative tests pass. Real journey execution, migration/API regressions, production build/identity, current-head CI and final review remain pending.

WOS-GOV-003 configurable retention, full buyer acceptance, deployment and broad product release are not completed by this increment. Do not reinterpret earlier partial evidence as completion of those requirements. Known security remediation branches and scanner debt require integration/reconciliation before release.

Rollback of this increment is a code/test/configuration revert preserving existing migrations, audit history and imported source evidence. No destructive conversion, buyer policy default or production deployment is authorized by this task artifact.

## Real journey result

The first local journey failed before business assertions when cold Vite navigation exceeded15 seconds. The harness now permits60 seconds for navigation setup while retaining15-second interaction assertions. The rerun passed: actual CSV validate/apply/reload; PostgreSQL dry-run/project/batch/audit/operation witnesses; a distinct named reviewer inspecting saved producer/role/source/batch/project/correlation provenance; other-legal exclusion and unassigned-scope denial; zero mutations during inspection. No business response or permission was mocked or weakened. This is not production performance or buyer OIDC acceptance.

## Final local checkpoint

PASS: the35-entry migration suite (fresh/concurrent/replay/upgrade/rollback); explicit production build with frontend fallback disabled; all four patched-dependency negative tests; all five existing browser suites (import history, project/import UI, scoped audit, organization audit, deployment audit/integration); isolated migrated production-identity and fail-closed startup suite. The first local browser runner found4177 occupied and terminated before tests; the corrected local-only runner selected an available port without stopping another process. No runner is included in product source.

The configured bootstrap scanner still FAILS with30 raw findings. No scanner rules or exclusions changed, and no clean bootstrap/release claim is made. Current-head GitHub secret scanning and full hosted acceptance are still required. The clean lockfile advisory audit is separate evidence. Controller review preserved both branches' test scripts/CI steps, accepted main documents and dependency repairs; the only test adaptation to the forwarded journey is its cold-navigation allowance. No production-domain behavior or migration changes were introduced by the integration increment.
