import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../workflows/wos01a-clean-runtime-acceptance-v2.yml', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('./wos01a-clean-runtime-matrix-v2.sh', import.meta.url), 'utf8');

assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
assert.doesNotMatch(workflow, /GH_TOKEN:/);
assert.doesNotMatch(matrix, /GH_TOKEN|Authorization: Bearer/);
assert.match(workflow, /CONTROLLER_PR: '26'/);
assert.match(workflow, /CONTROLLER_BRANCH: controller\/wos01a-clean-runtime-acceptance-v2/);
assert.match(workflow, /TARGET_PR: '27'[\s\S]*TARGET_HEAD: 17ac76595ec8bfe58564fa899bf0425816575a87/);
assert.match(workflow, /PARENT_PR: '16'[\s\S]*PARENT_HEAD: 590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60/);
assert.match(workflow, /EXPECTED_MAIN_HEAD: 44aeaa8eb5ba67692cbcb7fef48239dbbfc77a42/);
assert.match(workflow, /ACCEPTED_WOS00_BASE: 1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea/);
assert.match(workflow, /parent\.base\.ref !== 'main'/);
assert.match(workflow, /image: postgres:16/);
assert.match(workflow, /persist-credentials: false/g);
assert.match(workflow, /wos01a-clean-runtime-matrix-v2\.sh/);
assert.match(workflow, /id: final_authority[\s\S]*uses: actions\/github-script@v7/);
assert.match(workflow, /controller\.head\.ref !== process\.env\.CONTROLLER_BRANCH/);
assert.match(workflow, /controller\.head\.sha !== process\.env\.CONTROLLER_HEAD/);
assert.match(workflow, /final-controller-pr\.json/);
assert.match(workflow, /final-target-pr\.json/);
assert.match(workflow, /final-parent-pr\.json/);
assert.match(workflow, /final-main\.json/);
assert.match(workflow, /gate-outcomes\.txt/);
assert.match(workflow, /include-hidden-files: true/);
assert.match(workflow, /if-no-files-found: error/);
assert.match(workflow, /test -n "\$ARTIFACT_ID"/);
assert.match(workflow, /test -n "\$ARTIFACT_DIGEST"/);
assert.ok(
  workflow.includes('[[ ! "$ARTIFACT_DIGEST" =~ ^([0-9A-Fa-f]{64}|sha256:[0-9A-Fa-f]{64})$ ]]'),
  'artifact digest verifier must accept exactly bare or sha256-prefixed 64-hex evidence',
);
assert.doesNotMatch(workflow, /sha256:\*\) ;;/);
assert.match(workflow, /test '\$\{\{ steps\.authority\.outcome \}\}' = success/);
assert.match(workflow, /test '\$\{\{ steps\.matrix\.outcome \}\}' = success/);
assert.match(workflow, /test '\$\{\{ steps\.final_authority\.outcome \}\}' = success/);
assert.match(workflow, /test '\$\{\{ steps\.evidence_upload\.outcome \}\}' = success/);

for (const gate of [
  'repository_boundary',
  'controller_regression',
  'browser_lifecycle_regression',
  'locked_install',
  'engineering_controls',
  'dependency_classification',
  'build_acceptance',
  'postgres_client',
  'migration_acceptance',
  'production_acceptance',
  'browser_acceptance',
]) {
  assert.match(matrix, new RegExp(`run_gate ${gate} ${gate}`), `matrix must retain ${gate}`);
}
assert.doesNotMatch(matrix, /run_gate final_authority|final_authority\(\)/);
assert.match(matrix, /npm audit --omit=dev --json/);
assert.match(matrix, /runtime\.counts\.high > 0 \|\| runtime\.counts\.critical > 0/);
assert.match(matrix, /node scripts\/scan-bootstrap\.mjs --self-test/);
assert.match(matrix, /npm run test:bootstrap-scan/);
assert.match(matrix, /<title>Configured WorkOS<\/title>/);
assert.match(matrix, /href=\"\/configured-workos\.svg\"/);
assert.match(matrix, /migrate-fresh\.log/);

const migration = matrix.match(/migration_acceptance\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(migration, 'migration acceptance function must exist');
assert.match(migration, /test "\$fresh_first" = "\$expected"/);
assert.match(migration, /test "\$fresh_replay" = "\$expected"/);
assert.match(migration, /test "\$fresh_replay" = "\$fresh_first"/);
const firstUpgradeRun = migration.indexOf('migrate-upgrade.log');
const firstUpgradeCount = migration.indexOf('upgrade_first=');
const firstUpgradeAssert = migration.indexOf('test "$upgrade_first" = "$expected"');
const replayUpgradeRun = migration.indexOf('migrate-upgrade-replay.log');
assert.ok(firstUpgradeRun >= 0, 'first upgrade command must exist');
assert.ok(firstUpgradeRun < firstUpgradeCount, 'first upgrade count must follow the first command');
assert.ok(firstUpgradeCount < firstUpgradeAssert, 'first upgrade count must be asserted immediately');
assert.ok(firstUpgradeAssert < replayUpgradeRun, 'first upgrade must be complete before replay starts');
assert.match(migration, /test "\$upgrade_replay" = "\$expected"/);
assert.match(migration, /test "\$upgrade_replay" = "\$upgrade_first"/);

assert.match(matrix, /npm run test:production-identity/);
assert.match(matrix, /WOS_PRODUCTION_IDENTITY_EVIDENCE/);
assert.match(matrix, /production-identity-summary\.json/);
assert.match(matrix, /configured-provider-ready-then-unavailable/);
assert.match(matrix, /\.localLogin[\s\S]*= 404/);
assert.match(matrix, /\.protectedApi[\s\S]*= 401/);
assert.match(matrix, /\.outageReadiness[\s\S]*= closed/);
assert.match(matrix, /wos01a-browser-acceptance-v2\.mjs/);
assert.match(matrix, /WOS-01A exact-head acceptance failed closed/);

const production = matrix.match(/production_acceptance\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(production, 'production acceptance function must exist');
assert.doesNotMatch(production, /VITE_APP_MODE=test|VITE_ALLOW_TEST_FALLBACK=true/);
assert.match(production, /test:production-identity/);
assert.match(production, /readiness == \"closed\"/);

console.log('WOS-01A token isolation, final authority, identity and evidence assertions passed.');
