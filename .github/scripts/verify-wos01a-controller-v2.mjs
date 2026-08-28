import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../workflows/wos01a-clean-runtime-acceptance-v2.yml', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('./wos01a-clean-runtime-matrix-v2.sh', import.meta.url), 'utf8');

assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
assert.match(workflow, /CONTROLLER_PR: '26'/);
assert.match(workflow, /TARGET_PR: '27'[\s\S]*TARGET_HEAD: 0935424a52b57cc3a51adeef737e6eaec2946a88/);
assert.match(workflow, /PARENT_PR: '16'[\s\S]*PARENT_HEAD: 590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60/);
assert.match(workflow, /EXPECTED_MAIN_HEAD: 44aeaa8eb5ba67692cbcb7fef48239dbbfc77a42/);
assert.match(workflow, /ACCEPTED_WOS00_BASE: 1aa8d1fb7ea1a013b07cb282a9bf3941bf851dea/);
assert.match(workflow, /parent\.base\.ref !== 'main'/);
assert.match(workflow, /image: postgres:16/);
assert.match(workflow, /persist-credentials: false/g);
assert.match(workflow, /wos01a-clean-runtime-matrix-v2\.sh/);
assert.match(workflow, /include-hidden-files: true/);
assert.match(workflow, /if-no-files-found: error/);
assert.match(workflow, /test '\$\{\{ steps\.matrix\.outcome \}\}' = success/);
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
  'final_authority',
]) {
  assert.match(matrix, new RegExp(`run_gate ${gate} ${gate}`), `matrix must retain ${gate}`);
}
assert.match(matrix, /npm audit --omit=dev --json/);
assert.match(matrix, /runtime\.counts\.high > 0 \|\| runtime\.counts\.critical > 0/);
assert.match(matrix, /node scripts\/scan-bootstrap\.mjs --self-test/);
assert.match(matrix, /npm run test:bootstrap-scan/);
assert.match(matrix, /<title>Configured WorkOS<\/title>/);
assert.match(matrix, /href=\"\/configured-workos\.svg\"/);
assert.match(matrix, /migrate-fresh\.log/);
assert.match(matrix, /npm run test:production-identity/);
assert.match(matrix, /WOS_PRODUCTION_IDENTITY_EVIDENCE/);
assert.match(matrix, /production-identity-summary\.json/);
assert.match(matrix, /missing-provider-ready-then-unavailable|configured-provider-ready-then-unavailable/);
assert.match(matrix, /\.localLogin[\s\S]*= 404/);
assert.match(matrix, /\.protectedApi[\s\S]*= 401/);
assert.match(matrix, /\.outageReadiness[\s\S]*= closed/);
assert.match(matrix, /wos01a-browser-acceptance-v2\.mjs/);
assert.match(matrix, /final-controller-pr\.json[\s\S]*\.base\.ref[\s\S]*EXPECTED_MAIN_HEAD/);
assert.match(matrix, /final-parent-pr\.json[\s\S]*\.base\.ref[\s\S]*ACCEPTED_WOS00_BASE/);
assert.match(matrix, /WOS-01A exact-head acceptance failed closed/);

const production = matrix.match(/production_acceptance\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(production, 'production acceptance function must exist');
assert.doesNotMatch(production, /VITE_APP_MODE=test|VITE_ALLOW_TEST_FALLBACK=true/);
assert.match(production, /test:production-identity/);
assert.match(production, /readiness == \"closed\"/);

console.log('WOS-01A controller authority, identity fail-closed and evidence assertions passed.');
