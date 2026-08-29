import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../workflows/wos01a-final-integration-acceptance.yml', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('./wos01a-clean-runtime-matrix-v2.sh', import.meta.url), 'utf8');
const browserDriver = readFileSync(new URL('./wos01a-browser-acceptance-v2.mjs', import.meta.url), 'utf8');
const browserLifecycle = readFileSync(new URL('./wos01a-browser-lifecycle-v2.mjs', import.meta.url), 'utf8');

const job = (start, end) => workflow.match(new RegExp(`\\n  ${start}:\\n[\\s\\S]*?\\n  ${end}:`))?.[0];
const acceptance = job('acceptance', 'browser_bundle');
const producer = job('browser_bundle', 'browser_acceptance');
const browser = job('browser_acceptance', 'final_authority');
const finalAuthority = job('final_authority', 'aggregate');
const aggregate = workflow.match(/\n  aggregate:\n[\s\S]*$/)?.[0];

assert.ok(acceptance, 'integrated acceptance job must exist');
assert.ok(producer, 'pristine producer job must exist');
assert.ok(browser, 'isolated browser job must exist');
assert.ok(finalAuthority, 'final live-authority job must exist');
assert.ok(aggregate, 'aggregate job must exist');

assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
assert.doesNotMatch(workflow, /contents: write|pull-requests: write|GH_TOKEN:/);
assert.match(workflow, /concurrency:\n  group: wos01a-final-integration-acceptance\n  cancel-in-progress: true/);
assert.match(workflow, /CONTROLLER_BRANCH: controller\/wos01a-final-integration-acceptance/);
assert.match(workflow, /TARGET_PR: '16'/);
assert.match(workflow, /TARGET_BRANCH: codex\/wos-01-authorized-source-bootstrap-v2/);
assert.match(workflow, /TARGET_HEAD: 60a6a8da861f505c17f043c7439bdd40df992b50/g);
assert.match(workflow, /EXPECTED_MAIN_HEAD: 44aeaa8eb5ba67692cbcb7fef48239dbbfc77a42/g);
assert.match(workflow, /ACCEPTED_WOS00_BASE: 1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea/g);
assert.match(workflow, /image: postgres:16/);

assert.match(acceptance, /controller\?\.state !== 'open'/);
assert.match(acceptance, /!controller\?\.draft/);
assert.match(acceptance, /target\.state !== 'open'/);
assert.match(acceptance, /!target\.draft/);
assert.match(acceptance, /targetComparison\.merge_base_commit\.sha !== accepted/);
assert.match(acceptance, /targetComparison\.behind_by !== 0/);
assert.match(acceptance, /github\.paginate\(github\.rest\.pulls\.listFiles/);
assert.match(acceptance, /\.github\/workflows\/wos01a-final-integration-acceptance\.yml/);
assert.doesNotMatch(acceptance, /wos01a-clean-runtime-acceptance-v2\.yml/);
assert.equal((acceptance.match(/persist-credentials: false/g) || []).length, 3);
assert.match(acceptance, /fetch-depth: 0/g);
assert.match(acceptance, /wos01a-clean-runtime-matrix-v2\.sh/);
assert.match(acceptance, /include-hidden-files: true/);
assert.match(acceptance, /test '\$\{\{ steps\.authority\.outcome \}\}' = success/);
assert.match(acceptance, /test '\$\{\{ steps\.matrix\.outcome \}\}' = success/);
assert.match(acceptance, /test '\$\{\{ steps\.matrix_evidence\.outcome \}\}' = success/);

assert.match(producer, /needs: acceptance/);
assert.match(producer, /npm ci --ignore-scripts/);
assert.match(producer, /git reset --hard "\$TARGET_HEAD"/);
assert.match(producer, /git clean -ffdx -e node_modules\//);
assert.match(producer, /git write-tree/);
assert.match(producer, /status=pristine/);
assert.match(producer, /find \. -type f -print0[\s\S]*sha256sum/);
assert.match(producer, /bundle\.sha256/);
assert.doesNotMatch(producer, /npm test|npm run lint|server\/migrate|vite preview/);

assert.match(browser, /needs: \[acceptance, browser_bundle\]/);
assert.match(browser, /actions\/download-artifact@v4/);
assert.match(browser, /grep -Fx "status=pristine"/);
assert.match(browser, /--user 101:101/);
assert.match(browser, /--read-only --cap-drop ALL --security-opt no-new-privileges/);
assert.match(browser, /--pids-limit 64 --memory 128m --network bridge/);
assert.match(browser, /include \/etc\/nginx\/mime\.types;/);
assert.match(browser, /content-type:[^\n]*javascript/);
assert.match(browser, /timeout 8m node controller\/\.github\/scripts\/wos01a-browser-acceptance-v2\.mjs/);
assert.match(browser, /docker rm -f wos01a-final-static-target/);
assert.doesNotMatch(browser, /--privileged|--pid=host|\/var\/run\/docker\.sock|npm (?:ci|test|run)/);

assert.match(finalAuthority, /needs: \[acceptance, browser_bundle, browser_acceptance\]/);
assert.match(finalAuthority, /CONTROLLER_PR: \$\{\{ github\.event\.pull_request\.number \}\}/);
assert.match(finalAuthority, /github\.rest\.pulls\.get/);
assert.match(finalAuthority, /github\.rest\.repos\.getBranch/);
assert.match(finalAuthority, /github\.rest\.repos\.compareCommits/);
assert.match(finalAuthority, /controller\.head\.sha !== process\.env\.CONTROLLER_HEAD/);
assert.match(finalAuthority, /target\.head\.sha !== process\.env\.TARGET_HEAD/);
assert.match(finalAuthority, /main\.commit\.sha !== process\.env\.EXPECTED_MAIN_HEAD/);
assert.match(finalAuthority, /targetComparison\.merge_base_commit\.sha !== process\.env\.ACCEPTED_WOS00_BASE/);
assert.doesNotMatch(finalAuthority, /actions\/checkout|npm (?:ci|test|run)|target\//);
assert.match(finalAuthority, /include-hidden-files: true/);

assert.match(aggregate, /needs: \[acceptance, browser_bundle, browser_acceptance, final_authority\]/);
assert.match(aggregate, /permissions: \{\}/);
for (const result of ['ACCEPTANCE_RESULT', 'BUNDLE_RESULT', 'BROWSER_RESULT', 'FINAL_AUTHORITY_RESULT']) {
  assert.match(aggregate, new RegExp(`test "\\$${result}" = success`));
}

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
assert.match(matrix, /npm audit --omit=dev --json/);
assert.match(matrix, /runtime\.counts\.high > 0 \|\| runtime\.counts\.critical > 0/);
assert.match(matrix, /git -C "\$MAIN_ROOT" diff --name-only "\$ACCEPTED_WOS00_BASE\.\.HEAD" \| grep -Ev '\^\\\.github\/'/);
assert.match(matrix, /select id, applied_at, xmin::text::bigint, ctid from schema_migrations order by applied_at asc, xmin::text::bigint asc, ctid asc/);
assert.match(matrix, /email-only-unlinked-identity/);
assert.match(matrix, /WOS-01A exact-head acceptance passed\./);

assert.match(browserDriver, /resolveChromeExecutable/);
assert.match(browserDriver, /readChromeProcessDiagnostics/);
assert.match(browserDriver, /--remote-debugging-pipe/);
assert.doesNotMatch(browserDriver, /remote-debugging-port|WOS_CHROME_DEBUG_PORT|webSocketDebuggerUrl/);
for (const [role, route] of [
  ['Admin', '/admin'],
  ['HR', '/employees'],
  ['CountryDirector', '/'],
  ['ProjectManager', '/pm-workspace'],
  ['TeamLead', '/timesheets/approval'],
  ['Employee', '/ess'],
]) {
  assert.ok(browserDriver.includes(`['${role}', '${route}']`), `browser driver must retain ${role} ${route}`);
}
assert.match(browserDriver, /Employee was not denied \/admin/);
assert.match(browserDriver, /snapshot\.path !== '\/ess'/);
assert.match(browserDriver, /WOS-01A bounded browser acceptance passed\./);

assert.match(browserLifecycle, /class PipeCdpClient/);
assert.match(browserLifecycle, /maxBufferBytes = 1_048_576/);
assert.match(browserLifecycle, /timed out after/);
assert.match(browserLifecycle, /terminateProcessTree/);
assert.match(browserLifecycle, /SIGTERM/);
assert.match(browserLifecycle, /SIGKILL/);

console.log('WOS-01A final integrated controller verification passed.');