import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowPath = new URL('../workflows/wos01a-clean-runtime-acceptance-v2.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');

const occurrences = (pattern) => workflow.match(pattern)?.length ?? 0;

assert.equal(
  occurrences(/VITE_APP_MODE='test'/g),
  2,
  'test app mode must be scoped only to the retained-test command and browser build',
);
assert.equal(
  occurrences(/VITE_ALLOW_TEST_FALLBACK='true'/g),
  2,
  'test fallback must be scoped only to the retained-test command and browser build',
);
assert.match(
  workflow,
  /VITE_APP_MODE='test' VITE_ALLOW_TEST_FALLBACK='true' \\\n+\s+npm test 2>&1 \| tee \.acceptance-evidence\/tests\.log/,
  'retained tests must opt into their synthetic DataStorage fallback explicitly',
);
assert.doesNotMatch(
  workflow,
  /^\s{0,8}(?:VITE_APP_MODE|VITE_ALLOW_TEST_FALLBACK):/m,
  'test-only fallback variables must not be inherited through workflow, job, or step env',
);

const productionStep = workflow.match(
  /- name: Configured production build[\s\S]*?(?=\n\s{6}- name:)/,
)?.[0];
assert.ok(productionStep, 'configured production build step must exist');
assert.doesNotMatch(
  productionStep,
  /VITE_(?:APP_MODE|ALLOW_TEST_FALLBACK)/,
  'configured production build must not receive test fallback settings',
);

const uploadStep = workflow.match(
  /- name: Upload exact-head acceptance evidence[\s\S]*?(?=\n\s{6}- name:)/,
)?.[0];
assert.ok(uploadStep, 'acceptance evidence upload step must exist');
assert.match(uploadStep, /path: target\/\.acceptance-evidence/);
assert.match(uploadStep, /include-hidden-files: true/);
assert.match(uploadStep, /if-no-files-found: error/);
assert.match(
  workflow,
  /check evidence_upload '\$\{\{ steps\.evidence_upload\.outcome \}\}'/,
  'aggregate acceptance must fail closed when evidence upload is unsuccessful',
);
assert.match(workflow, /TARGET_PR: '27'[\s\S]*TARGET_HEAD: 4415eb15aee8ce8f07d2b83d586241653f1c949d/);
assert.match(workflow, /PARENT_PR: '16'[\s\S]*PARENT_HEAD: 590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60/);
assert.match(workflow, /test "\$\(jq -r \.base\.sha \/tmp\/target-pr\.json\)" = "\$\{PARENT_HEAD\}"/);
assert.match(workflow, /check browser_lifecycle_regression '\$\{\{ steps\.browser_lifecycle_regression\.outcome \}\}'/);
assert.match(workflow, /check final_authority '\$\{\{ steps\.final_authority\.outcome \}\}'/);

console.log('WOS-01A controller fallback and evidence isolation assertions passed.');
