import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow = readFileSync(new URL('../workflows/wos01a-clean-runtime-acceptance-v2.yml', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('./wos01a-clean-runtime-matrix-v2.sh', import.meta.url), 'utf8');

const acceptanceJob = workflow.match(/\n  acceptance:\n[\s\S]*?\n  browser_acceptance:/)?.[0];
const browserBundleJob = workflow.match(/\n  browser_bundle:\n[\s\S]*?\n  browser_acceptance:/)?.[0];
const acceptanceOnlyJob = workflow.match(/\n  acceptance:\n[\s\S]*?\n  browser_bundle:/)?.[0];
const browserJob = workflow.match(/\n  browser_acceptance:\n[\s\S]*?\n  final_authority:/)?.[0];
const finalAuthorityJob = workflow.match(/\n  final_authority:\n[\s\S]*?\n  aggregate:/)?.[0];
const aggregateJob = workflow.match(/\n  aggregate:\n[\s\S]*$/)?.[0];
assert.ok(acceptanceJob, 'acceptance job must exist');
assert.ok(acceptanceOnlyJob, 'target matrix job must exist');
assert.ok(browserBundleJob, 'pristine browser bundle producer job must exist');
assert.ok(browserJob, 'isolated browser job must exist');
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
assert.doesNotMatch(acceptanceOnlyJob, /browser_bundle_upload|npm ci --ignore-scripts/);

assert.match(browserBundleJob, /needs: acceptance/);
assert.match(browserBundleJob, /runs-on: ubuntu-latest/);
assert.match(browserBundleJob, /ref: \$\{\{ env\.TARGET_HEAD \}\}[\s\S]*path: producer[\s\S]*persist-credentials: false/);
assert.match(browserBundleJob, /npm ci --ignore-scripts/);
assert.match(browserBundleJob, /git reset --hard "\$TARGET_HEAD"/);
assert.match(browserBundleJob, /git clean -ffdx -e node_modules\//);
assert.match(browserBundleJob, /git write-tree/);
assert.match(browserBundleJob, /git rev-parse "\$TARGET_HEAD\^\{tree\}"/);
assert.match(browserBundleJob, /unexpected=.*git status --porcelain=v1 --untracked-files=all/);
assert.match(browserBundleJob, /status=pristine/);
assert.match(browserBundleJob, /tree=%s/);
assert.match(browserBundleJob, /id: browser_bundle_upload[\s\S]*if-no-files-found: error/);
assert.match(browserBundleJob, /test '\$\{\{ steps\.browser_bundle_upload\.outcome \}\}' = success/);
assert.doesNotMatch(browserBundleJob, /npm (?:test|run (?!build))|test:production-identity|vite preview/);

assert.match(browserJob, /needs: \[acceptance, browser_bundle\]/);
assert.match(browserJob, /BUNDLE_RESULT: \$\{\{ needs\.browser_bundle\.result \}\}/);
assert.match(browserJob, /runs-on: ubuntu-latest/);
assert.match(browserJob, /persist-credentials: false/);
assert.match(browserJob, /actions\/download-artifact@v4/);
assert.match(browserJob, /grep -Fx "controller=\$CONTROLLER_HEAD"/);
assert.match(browserJob, /grep -Fx "target=\$TARGET_HEAD"/);
assert.match(browserJob, /grep -Fx "status=pristine"/);
assert.match(browserJob, /sha256sum -c \.\.\/files\.sha256/);
assert.match(browserJob, /--user 101:101/);
assert.match(browserJob, /--read-only --cap-drop ALL --security-opt no-new-privileges/);
assert.match(browserJob, /--pids-limit 64 --memory 128m --network bridge/);
assert.match(browserJob, /--tmpfs \/var\/cache\/nginx:rw,noexec,nosuid,size=16m,uid=101,gid=101,mode=700/);
assert.match(browserJob, /--tmpfs \/var\/run:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700/);
assert.match(browserJob, /--tmpfs \/tmp:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700/);
assert.match(browserJob, /nginx:1\.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10/);
assert.match(browserJob, /pid \/var\/run\/nginx\.pid;/);
assert.match(browserJob, /client_body_temp_path \/var\/cache\/nginx\/client_temp;/);
assert.match(browserJob, /include \/etc\/nginx\/mime\.types;/);
assert.match(browserJob, /default_type application\/octet-stream;/);
assert.match(browserJob, /mapfile -t main_assets/);
assert.match(browserJob, /main-asset-headers\.txt/);
assert.match(browserJob, /grep -Eiq/);
assert.match(browserJob, /javascript\|ecmascript/);
assert.match(browserJob, /\.State\.Running == true/);
assert.match(browserJob, /\.Config\.User == "101:101"/);
assert.match(browserJob, /\.HostConfig\.CapDrop == \["ALL"\]/);
assert.match(browserJob, /\.HostConfig\.Memory == 134217728/);
assert.match(browserJob, /\.HostConfig\.PidsLimit == 64/);
assert.match(browserJob, /\.HostConfig\.NetworkMode == "bridge"/);
assert.match(browserJob, /select\(\.Type == "bind"\)[\s\S]*length == 2/);
assert.match(browserJob, /select\(\.Type == "bind"\) \| \.RW\][\s\S]*all\(\. == false\)/);
assert.match(browserJob, /container-startup\.log/);
assert.match(browserJob, /--read-only --cap-drop ALL --security-opt no-new-privileges/);
assert.match(browserJob, /--pids-limit 64 --memory 128m --network bridge/);
assert.match(browserJob, /type=bind,src=\$PWD\/browser-bundle\/dist,dst=\/srv\/workos,readonly/);
assert.match(browserJob, /timeout 8m node controller\/\.github\/scripts\/wos01a-browser-acceptance-v2\.mjs/);
assert.match(browserJob, /docker rm -f wos01a-static-target/);
assert.doesNotMatch(browserJob, /npm (?:ci|run)|node_modules|vite preview|--privileged|--pid=host|\/var\/run\/docker\.sock/);
assert.match(browserJob, /test '\$\{\{ steps\.browser\.outcome \}\}' = success/);
assert.match(browserJob, /test '\$\{\{ steps\.browser_artifact\.outcome \}\}' = success/);
assert.match(browserJob, /BROWSER_ARTIFACT_DIGEST: \$\{\{ steps\.browser_artifact\.outputs\.artifact-digest \}\}/);

assert.match(finalAuthorityJob, /needs: \[acceptance, browser_acceptance\]/);
assert.match(finalAuthorityJob, /if: always\(\)/);
assert.match(finalAuthorityJob, /runs-on: ubuntu-latest/);
assert.match(finalAuthorityJob, /ACCEPTANCE_RESULT: \$\{\{ needs\.acceptance\.result \}\}/);
assert.match(finalAuthorityJob, /BROWSER_RESULT: \$\{\{ needs\.browser_acceptance\.result \}\}/);
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

assert.match(aggregateJob, /needs: \[acceptance, browser_acceptance, final_authority\]/);
assert.match(aggregateJob, /permissions: \{\}/);
assert.match(aggregateJob, /test "\$ACCEPTANCE_RESULT" = success/);
assert.match(aggregateJob, /test "\$FINAL_AUTHORITY_RESULT" = success/);

const digestPattern = /\^\(\[0-9A-Fa-f\]\{64\}\|sha256:\[0-9A-Fa-f\]\{64\}\)\$/g;
assert.equal((workflow.match(digestPattern) || []).length, 4, 'all evidence and bundle artifacts must require exact SHA-256 digests');

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
assert.doesNotMatch(matrix, /preload_browser_driver|BROWSER_DRIVER_PID|vite preview/);
assert.doesNotMatch(matrix, /browser_bundle|\.browser-bundle/);
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
assert.match(browserJob, /wos01a-browser-acceptance-v2\.mjs/);
const browserDriver = readFileSync(new URL('./wos01a-browser-acceptance-v2.mjs', import.meta.url), 'utf8');
assert.match(browserDriver, /WOS_BROWSER_DRIVER_READY_FILE/);
assert.match(browserDriver, /await writeFile\(driverReadyFile/);
assert.match(browserDriver, /await waitForApplication\(\)/);
assert.match(browserDriver, /--remote-debugging-pipe/);
assert.match(browserDriver, /new PipeCdpClient\(chrome\.stdio\[4\], chrome\.stdio\[3\]/);
assert.match(browserDriver, /status: 'control-ready'/);
assert.doesNotMatch(browserDriver, /remote-debugging-port|WOS_CHROME_DEBUG_PORT|\/json\/version|\/json\/new|webSocketDebuggerUrl/);
assert.ok(browserDriver.indexOf("client.send('Browser.getVersion')") < browserDriver.indexOf('await writeFile(driverReadyFile'));
assert.ok(browserDriver.indexOf("client.send('Target.attachToTarget'") < browserDriver.indexOf('await writeFile(driverReadyFile'));
assert.doesNotMatch(browserJob, /browser-driver-loaded\.json|chromePid|\/proc\//);
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

// Model the producer restoration boundary: both tracked and untracked mutations
// must disappear, while a mismatched expected head must fail provenance.
const producerFixture = mkdtempSync(join(tmpdir(), 'wos01a-producer-'));
const git = (...args) => execFileSync('git', args, {
  cwd: producerFixture,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
try {
  git('init', '-q');
  git('config', 'user.email', 'controller@example.test');
  git('config', 'user.name', 'WOS-01A Controller');
  writeFileSync(join(producerFixture, 'source.txt'), 'authorized\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'authorized producer');
  const authorizedHead = git('rev-parse', 'HEAD');
  const authorizedTree = git('rev-parse', `${authorizedHead}^{tree}`);

  writeFileSync(join(producerFixture, 'source.txt'), 'tracked mutation\n');
  writeFileSync(join(producerFixture, 'stale-input.txt'), 'untracked mutation\n');
  git('reset', '--hard', authorizedHead);
  git('clean', '-ffdx');
  assert.equal(readFileSync(join(producerFixture, 'source.txt'), 'utf8'), 'authorized\n');
  assert.equal(git('write-tree'), authorizedTree);
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.throws(
    () => assert.equal(git('write-tree'), git('rev-parse', `${authorizedHead}^1^{tree}`)),
    /Command failed|unknown revision|ambiguous argument/,
    'unprovable or failed restoration must not authenticate a producer tree',
  );
} finally {
  rmSync(producerFixture, {recursive: true, force: true});
}

console.log('WOS-01A isolated final authority, exact migration ledger and evidence logging assertions passed.');
