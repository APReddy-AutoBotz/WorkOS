import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../workflows/wos01a-clean-runtime-acceptance-v2.yml', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('./wos01a-clean-runtime-matrix-v2.sh', import.meta.url), 'utf8');

const acceptanceJob = workflow.match(/\n  acceptance:\n[\s\S]*?\n  final_authority:/)?.[0];
const finalAuthorityJob = workflow.match(/\n  final_authority:\n[\s\S]*?\n  aggregate:/)?.[0];
const aggregateJob = workflow.match(/\n  aggregate:\n[\s\S]*$/)?.[0];
assert.ok(acceptanceJob, 'acceptance job must exist');
assert.ok(finalAuthorityJob, 'isolated final-authority job must exist');
assert.ok(aggregateJob, 'aggregate job must exist');

assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
assert.doesNotMatch(workflow, /GH_TOKEN:/);
assert.doesNotMatch(matrix, /GH_TOKEN|Authorization: Bearer/);

assert.match(acceptanceJob, /CONTROLLER_PR: '26'/);
assert.match(acceptanceJob, /CONTROLLER_BRANCH: controller\/wos01a-clean-runtime-acceptance-v2/);
assert.match(acceptanceJob, /TARGET_PR: '27'[\s\S]*TARGET_HEAD: 60a6a8da861f505c17f043c7439bdd40df992b50/);
assert.match(acceptanceJob, /PARENT_PR: '16'[\s\S]*PARENT_HEAD: 590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60/);
assert.match(acceptanceJob, /EXPECTED_MAIN_HEAD: 44aeaa8eb5ba67692cbcb7fef48239dbbfc77a42/);
assert.match(acceptanceJob, /ACCEPTED_WOS00_BASE: 1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea/);
assert.match(acceptanceJob, /image: postgres:16/);
assert.match(acceptanceJob, /persist-credentials: false/g);
assert.match(acceptanceJob, /wos01a-clean-runtime-matrix-v2\.sh/);
assert.doesNotMatch(acceptanceJob, /id: final_authority|final-controller-pr\.json|final-target-pr\.json/);
assert.match(acceptanceJob, /id: artifact_upload[\s\S]*include-hidden-files: true[\s\S]*if-no-files-found: error/);
assert.match(acceptanceJob, /test '\$\{\{ steps\.authority\.outcome \}\}' = success/);
assert.match(acceptanceJob, /test '\$\{\{ steps\.matrix\.outcome \}\}' = success/);
assert.match(acceptanceJob, /test '\$\{\{ steps\.evidence_upload\.outcome \}\}' = success/);

assert.match(finalAuthorityJob, /needs: acceptance/);
assert.match(finalAuthorityJob, /if: always\(\)/);
assert.match(finalAuthorityJob, /runs-on: ubuntu-latest/);
assert.match(finalAuthorityJob, /ACCEPTANCE_RESULT: \$\{\{ needs\.acceptance\.result \}\}/);
assert.match(finalAuthorityJob, /CONTROLLER_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
for (const required of [
  "CONTROLLER_PR: '26'",
  'CONTROLLER_BRANCH: controller/wos01a-clean-runtime-acceptance-v2',
  "TARGET_PR: '27'",
  'TARGET_BRANCH: codex/wos01a-acceptance-closure',
  'TARGET_HEAD: 60a6a8da861f505c17f043c7439bdd40df992b50',
  "PARENT_PR: '16'",
  'PARENT_BRANCH: codex/wos-01-authorized-source-bootstrap-v2',
  'PARENT_HEAD: 590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60',
  'EXPECTED_MAIN_HEAD: 44aeaa8eb5ba67692cbcb7fef48239dbbfc77a42',
  'ACCEPTED_WOS00_BASE: 1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea',
]) {
  assert.ok(finalAuthorityJob.includes(required), `final authority must pin ${required}`);
}
assert.match(finalAuthorityJob, /id: final_authority[\s\S]*uses: actions\/github-script@v7/);
assert.match(finalAuthorityJob, /process\.env\.ACCEPTANCE_RESULT !== 'success'/);
assert.match(finalAuthorityJob, /controller\.head\.ref !== process\.env\.CONTROLLER_BRANCH/);
assert.match(finalAuthorityJob, /controller\.head\.sha !== process\.env\.CONTROLLER_HEAD/);
assert.match(finalAuthorityJob, /target\.head\.sha !== process\.env\.TARGET_HEAD/);
assert.match(finalAuthorityJob, /parent\.head\.sha !== process\.env\.PARENT_HEAD/);
assert.match(finalAuthorityJob, /main\.commit\.sha !== process\.env\.EXPECTED_MAIN_HEAD/);
assert.match(finalAuthorityJob, /process\.env\.RUNNER_TEMP/);
assert.match(finalAuthorityJob, /final-controller-pr\.json/);
assert.match(finalAuthorityJob, /final-target-pr\.json/);
assert.match(finalAuthorityJob, /final-parent-pr\.json/);
assert.match(finalAuthorityJob, /final-main\.json/);
assert.match(finalAuthorityJob, /final-authority-result\.json/);
assert.match(finalAuthorityJob, /id: final_artifact_upload[\s\S]*include-hidden-files: true[\s\S]*if-no-files-found: error/);
assert.doesNotMatch(finalAuthorityJob, /actions\/checkout|npm (?:ci|run)|target\//);
assert.match(finalAuthorityJob, /test "\$ACCEPTANCE_RESULT" = success/);
assert.match(finalAuthorityJob, /test '\$\{\{ steps\.final_authority\.outcome \}\}' = success/);
assert.match(finalAuthorityJob, /test '\$\{\{ steps\.final_evidence_upload\.outcome \}\}' = success/);

assert.match(aggregateJob, /needs: \[acceptance, final_authority\]/);
assert.match(aggregateJob, /permissions: \{\}/);
assert.match(aggregateJob, /test "\$ACCEPTANCE_RESULT" = success/);
assert.match(aggregateJob, /test "\$FINAL_AUTHORITY_RESULT" = success/);

const digestPattern = /\^\(\[0-9A-Fa-f\]\{64\}\|sha256:\[0-9A-Fa-f\]\{64\}\)\$/g;
assert.equal((workflow.match(digestPattern) || []).length, 2, 'both evidence artifacts must require exact SHA-256 digests');

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
]) {
  assert.match(matrix, new RegExp(`run_gate ${gate} ${gate}`), `matrix must retain ${gate}`);
}
assert.doesNotMatch(matrix, /run_gate final_authority|final_authority\(\)/);
assert.match(matrix, /run_gate_parent browser_driver_preload preload_browser_driver/);
assert.match(matrix, /run_gate_parent browser_acceptance browser_acceptance/);
assert.match(matrix, /rev-parse "\$CONTROLLER_HEAD:\$driver_rel"/);
assert.match(matrix, /hash-object "\$CONTROLLER_ROOT\/\$driver_rel"/);
assert.match(matrix, /wait "\$BROWSER_DRIVER_PID"/);
assert.match(matrix, /browser-driver-loaded\.json/);
assert.match(matrix, /pipeline_status=\("\$\{PIPESTATUS\[@\]\}"\)/);
assert.match(matrix, /command_rc="\$\{pipeline_status\[0\]:-1\}"/);
assert.match(matrix, /tee_rc="\$\{pipeline_status\[1\]:-1\}"/);
assert.match(matrix, /command_rc=\$command_rc tee_rc=\$tee_rc/);
assert.match(matrix, /summary_status=\("\$\{PIPESTATUS\[@\]\}"\)/);
assert.match(matrix, /Failed to retain gate outcome evidence/);

assert.match(matrix, /npm audit --omit=dev --json/);
assert.match(matrix, /runtime\.counts\.high > 0 \|\| runtime\.counts\.critical > 0/);
assert.match(matrix, /node scripts\/scan-bootstrap\.mjs --self-test/);
assert.match(matrix, /npm run test:bootstrap-scan/);
assert.match(matrix, /<title>Configured WorkOS<\/title>/);
assert.ok(matrix.includes("grep -q 'href=\"/configured-workos.svg\"' dist/index.html"));

const migration = matrix.match(/migration_acceptance\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(migration, 'migration acceptance function must exist');
assert.match(migration, /expected-migration-ids\.txt/);
assert.match(migration, /printf '%s\\n' '005_auth_lifecycle'/);
assert.match(migration, /find server\/migrations[\s\S]*sed 's\/\\\.sql\$\/\/'/);
assert.match(migration, /select id, applied_at, xmin::text::bigint, ctid from schema_migrations order by applied_at asc, xmin::text::bigint asc, ctid asc/);
assert.match(migration, /migration-order\.txt/);
assert.match(migration, /cmp -s "\$expected_ids" "\$actual"/);
assert.match(migration, /printf '%s\\n' '005_auth_lifecycle' > "\$expected_ids"/);
assert.match(migration, /LC_ALL=C sort >> "\$expected_ids"/);
for (const ledger of ['fresh-first', 'fresh-replay', 'upgrade-first', 'upgrade-replay', 'production-fixture']) {
  assert.ok(migration.includes(`verify_ledger "$${ledger.startsWith('fresh') ? 'fresh_url' : ledger.startsWith('upgrade') ? 'upgrade_url' : 'prod_url'}" ${ledger}`));
}
const firstUpgradeRun = migration.indexOf('migrate-upgrade.log');
const firstUpgradeLedger = migration.indexOf('verify_ledger "$upgrade_url" upgrade-first');
const replayUpgradeRun = migration.indexOf('migrate-upgrade-replay.log');
assert.ok(firstUpgradeRun >= 0, 'first upgrade command must exist');
assert.ok(firstUpgradeRun < firstUpgradeLedger, 'first upgrade ledger must follow the first command');
assert.ok(firstUpgradeLedger < replayUpgradeRun, 'first upgrade ledger must be exact before replay starts');
assert.match(migration, /test "\$fresh_first" = "\$expected"/);
assert.match(migration, /test "\$fresh_replay" = "\$fresh_first"/);
assert.match(migration, /test "\$upgrade_first" = "\$expected"/);
assert.match(migration, /test "\$upgrade_replay" = "\$upgrade_first"/);

assert.match(matrix, /npm run test:production-identity/);
assert.match(matrix, /WOS_PRODUCTION_IDENTITY_EVIDENCE/);
assert.match(matrix, /production-identity-summary\.json/);
assert.match(matrix, /configured-provider-ready-then-unavailable/);
assert.match(matrix, /\.localLogin[\s\S]*== 404/);
assert.match(matrix, /\.protectedApi[\s\S]*== 401/);
assert.match(matrix, /\.outageReadiness[\s\S]*== "closed"/);
assert.match(matrix, /wos01a-browser-acceptance-v2\.mjs/);
const browserDriver = readFileSync(new URL('./wos01a-browser-acceptance-v2.mjs', import.meta.url), 'utf8');
assert.match(browserDriver, /WOS_BROWSER_DRIVER_READY_FILE/);
assert.match(browserDriver, /await writeFile\(driverReadyFile/);
assert.match(browserDriver, /await waitForApplication\(\)/);
assert.match(matrix, /WOS-01A exact-head acceptance failed closed/);

const production = matrix.match(/production_acceptance\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(production, 'production acceptance function must exist');
assert.doesNotMatch(production, /VITE_APP_MODE=test|VITE_ALLOW_TEST_FALLBACK=true/);
assert.match(production, /test:production-identity/);
assert.match(production, /readiness == "closed"/);
assert.doesNotMatch(production, /readiness == "closed"[^\n]*length[^\n]*-eq 4/);
assert.doesNotMatch(production, /length >=/);
assert.match(production, /length == \(unique \| length\)/);
assert.match(production, /length == 1/);
assert.match(production, /all\(\.readiness == "closed"\)/);
for (const key of ['database', 'usersBefore', 'usersAfter', 'employeesBefore', 'employeesAfter']) {
  assert.match(production, new RegExp(`\\.${key} ==`), `runtime contract must consume producer field ${key}`);
}
assert.doesNotMatch(production, /seededUsers|seededEmployees|\/\/ \.users|\/\/ \.employees/);
assert.match(production, /\.callbackRejections \| type == "array"/);
assert.match(production, /\[\.callbackRejections\[\]\.name\]/);
assert.match(production, /email-only-unlinked-identity/);
assert.match(production, /\.status == 302/);
assert.match(production, /\.location == "\/login\?error=entra_unlinked_user"/);
assert.match(production, /\.sessionCookie == false/);

const positive = {name: 'configured-provider-ready-then-unavailable', startup: 'ready', database: 'connected', localLogin: 404, protectedApi: 401, usersBefore: 0, usersAfter: 0, employeesBefore: 0, employeesAfter: 0, outageReadiness: 'closed'};
const mandatoryNegativeNames = ['missing-app-url', 'http-app-url', 'loopback-callback', 'wrong-callback-route', 'missing-identity-setting', 'local-provider-prohibited', 'unavailable-discovery', 'invalid-discovery-document'];
const negatives = mandatoryNegativeNames.map((name) => ({name, readiness: 'closed'}));
const identityContract = (cases) => {
  if (!Array.isArray(cases) || cases.length === 0 || cases.some((entry) => !entry || typeof entry.name !== 'string' || entry.name.length === 0)) return false;
  const names = cases.map(({name}) => name);
  const configured = cases.filter(({name}) => name === positive.name);
  const closed = cases.filter(({name}) => name !== positive.name);
  return new Set(names).size === names.length && configured.length === 1
    && mandatoryNegativeNames.every((name) => closed.filter((entry) => entry.name === name).length === 1)
    && closed.every(({readiness}) => readiness === 'closed')
    && ['startup', 'database', 'localLogin', 'protectedApi', 'usersBefore', 'usersAfter', 'employeesBefore', 'employeesAfter', 'outageReadiness'].every((key) => configured[0][key] === positive[key]);
};
assert.ok(identityContract([...negatives, positive]));
assert.ok(identityContract([...negatives, {name: 'new-negative', readiness: 'closed'}, positive]));
for (let index = 0; index < negatives.length; index += 1) {
  assert.equal(identityContract([...negatives.slice(0, index), ...negatives.slice(index + 1), positive]), false);
}
assert.equal(identityContract([negatives[0], negatives[0], ...negatives.slice(1), positive]), false);
assert.equal(identityContract([{...negatives[0], readiness: 'ready'}, ...negatives.slice(1), positive]), false);
assert.equal(identityContract(/** @type {any} */ (undefined)), false);
assert.equal(identityContract(/** @type {any} */ ({})), false);
assert.equal(identityContract([]), false);
assert.equal(identityContract([...negatives]), false);
assert.equal(identityContract([...negatives, positive, {...positive}]), false);
for (const [key, value] of [['startup', 'closed'], ['database', 'disconnected'], ['localLogin', 200], ['protectedApi', 200], ['usersBefore', 1], ['usersAfter', 1], ['employeesBefore', 1], ['employeesAfter', 1], ['outageReadiness', 'ready']]) {
  assert.equal(identityContract([...negatives, {...positive, [key]: value}]), false);
}

const emailOnlyRejection = {name: 'email-only-unlinked-identity', status: 302, location: '/login?error=entra_unlinked_user', sessionCookie: false};
const callbackRejectionContract = (callbackRejections) => {
  if (!Array.isArray(callbackRejections)
    || callbackRejections.some((entry) => !entry || typeof entry.name !== 'string' || entry.name.length === 0)) return false;
  const names = callbackRejections.map(({name}) => name);
  const emailOnly = callbackRejections.filter(({name}) => name === emailOnlyRejection.name);
  return new Set(names).size === names.length
    && emailOnly.length === 1
    && ['status', 'location', 'sessionCookie'].every((key) => emailOnly[0][key] === emailOnlyRejection[key]);
};
assert.ok(callbackRejectionContract([emailOnlyRejection]));
assert.ok(callbackRejectionContract([
  emailOnlyRejection,
  {name: 'future-governed-rejection', status: 302, location: '/login?error=future', sessionCookie: false},
]));
assert.equal(callbackRejectionContract(undefined), false);
assert.equal(callbackRejectionContract({}), false);
assert.equal(callbackRejectionContract([]), false);
assert.equal(callbackRejectionContract([{status: 302}]), false);
assert.equal(callbackRejectionContract([{name: ''}, emailOnlyRejection]), false);
assert.equal(callbackRejectionContract([
  emailOnlyRejection,
  {...emailOnlyRejection},
]), false);
for (const [key, value] of [
  ['status', 401],
  ['location', '/login?error=wrong'],
  ['sessionCookie', true],
]) {
  assert.equal(callbackRejectionContract([{...emailOnlyRejection, [key]: value}]), false);
}

console.log('WOS-01A isolated final authority, exact migration ledger and evidence logging assertions passed.');
