import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.env.TARGET_ROOT || 'target');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const covered = [
  'src/components/Layout/Header.tsx',
  'src/components/Layout/Sidebar.tsx',
  'src/components/employee/OrgChartView.tsx',
  'src/components/forms/EmployeeForm.tsx',
  'src/components/forms/ProjectForm.tsx',
  'src/pages/EmployeeDetail.tsx',
  'src/pages/EmployeeMaster.tsx',
  'src/pages/ImportExport.tsx',
  'src/pages/ProjectDetail.tsx',
  'src/pages/ProjectManagerWorkspace.tsx',
  'src/pages/ProjectMaster.tsx',
  'src/pages/ReportsCenter.tsx',
  'src/lib/reportExport.ts',
  'src/services/api.ts',
];
const sources = new Map(covered.map((file) => [file, read(file)]));
const combined = [...sources.values()].join('\n');

// Execute the product-owned behavioral contract first; static controller checks
// below supplement it and may not substitute for it.
execFileSync('npm', ['run', 'test:terminology-runtime'], {
  cwd: root,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
});

const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
const registry = read('src/config/productConfig.ts');
for (const key of keys) {
  assert.match(registry, new RegExp(`\\b${key}\\b`), `persisted terminology key missing from authoritative product config: ${key}`);
  assert.match(combined, new RegExp(`(?:terminology|terms|term|\\bt\\b)[^\\n]{0,80}\\b${key}\\b`, 'i'),
    `terminology key is not materially consumed by a covered runtime surface: ${key}`);
}
assert.match(registry, /key in defaultTerminology/, 'persisted terminology does not reject unknown canonical keys');
assert.match(registry, /typeof value === ['"]string['"][^\n]*value\.trim\(\)/,
  'persisted terminology does not reject invalid or blank values');

const surfaceGroups = {
  'navigation/search': ['src/components/Layout/Header.tsx', 'src/components/Layout/Sidebar.tsx'],
  'employee/project forms and headings': ['src/components/forms/EmployeeForm.tsx', 'src/components/forms/ProjectForm.tsx', 'src/pages/EmployeeMaster.tsx', 'src/pages/ProjectMaster.tsx'],
  'org chart/planning/delivery': ['src/components/employee/OrgChartView.tsx', 'src/pages/ProjectManagerWorkspace.tsx'],
  'reports/exports': ['src/pages/ReportsCenter.tsx', 'src/pages/ImportExport.tsx', 'src/lib/reportExport.ts'],
  'notification-facing API copy/templates': ['src/services/api.ts'],
};
for (const [name, files] of Object.entries(surfaceGroups)) {
  const body = files.map((file) => sources.get(file)).join('\n');
  assert.match(body, /useTerminology|terminology|\bterms\b|formatTerminology/i, `${name} bypasses runtime terminology`);
}

const provider = read('src/config/RuntimeTerminology.tsx');
assert.match(provider, /workos:organization-scope-changed/, 'provider does not observe organization scope changes');
assert.match(provider, /addEventListener\(['"]workos:organization-scope-changed['"]\s*,\s*load\)/,
  'provider does not reload terminology on organization scope changes');
assert.match(provider, /removeEventListener\(['"]workos:organization-scope-changed['"]\s*,\s*load\)/,
  'provider does not clean up organization scope listener');
assert.match(provider, /if \(!authenticated\)[\s\S]{0,160}applyPersistedTerminology\(\{\}\)/,
  'unauthenticated terminology loading does not reset to safe defaults');
assert.match(provider, /catch[\s\S]{0,120}applyPersistedTerminology\(\{\}\)/,
  'fetch failure does not reset to safe defaults');

// This is intentionally finite: only JSX display text/label attributes in the
// explicit covered list are scanned. Canonical identifiers are not rewritten.
const forbiddenDisplay = /(?:>\s*|(?:label|title|placeholder|aria-label)\s*=\s*["'])(Employees?|Managers?|Team Leads?|Business Units?|Regions?|Regional Owners?|Engagements?|Projects?|Worklogs?)(?:\s*<|["'])/gi;
const literalAllowList = new Map([
  // Explicit exceptions must identify an exact file and exact literal. Keep empty
  // unless a product specification requires a canonical user-facing literal.
]);
for (const [file, source] of sources) {
  for (const match of source.matchAll(forbiddenDisplay)) {
    const literal = match[1];
    assert(literalAllowList.get(file)?.has(literal), `literal terminology bypass in ${file}: ${literal}`);
  }
}

// Guard durable canonical contracts without assuming that unrelated later
// product fixes preserve the exact number/order of canonical token usages.
// Existing canonical values may not disappear or be renamed; additive exact-scope
// predicates/usages are allowed and are covered by their own acceptance matrices.
const contractFiles = ['server/index.mjs', 'src/App.tsx', 'src/services/api.ts', 'src/services/apiClient.ts', 'src/types.ts'];
const contractSource = contractFiles.map(read).join('\n');
for (const token of ['/employees', '/projects', 'employee_id', 'project_id', 'organization_id', 'legal_entity_id']) {
  assert(contractSource.includes(token), `stable canonical contract token missing: ${token}`);
}
const previousContractSource = contractFiles.map((file) =>
  execFileSync('git', ['show', `HEAD^:${file}`], { cwd: root, encoding: 'utf8' })).join('\n');
const stableContractExtractors = [
  {
    name: 'employee/project route literals',
    pattern: /['"`]\/(?:employees|projects)(?:\/|['"`])/g,
    normalize: (value) => value.replace(/^[`'"]/, '').replace(/[`'"]$/, ''),
  },
  {
    name: 'canonical ownership identifiers',
    pattern: /\b(?:employee_id|project_id|organization_id|legal_entity_id)\b/g,
    normalize: (value) => value,
  },
  {
    name: 'permission/role/event/audit property keys',
    pattern: /\b(?:permission|role|event_type|audit_action|audit_entity)\b\s*[:=]/gi,
    normalize: (value) => value.toLowerCase().replace(/\s*[:=]\s*$/, ''),
  },
  {
    name: 'CSV filenames',
    pattern: /["'`][^"'`\n]+\.csv["'`]/gi,
    normalize: (value) => value.slice(1, -1),
  },
];
for (const { name, pattern, normalize } of stableContractExtractors) {
  const previousValues = new Set((previousContractSource.match(pattern) || []).map(normalize));
  const currentValues = new Set((contractSource.match(pattern) || []).map(normalize));
  for (const value of previousValues) {
    assert(currentValues.has(value), `stable canonical contract removed or renamed (${name}): ${value}`);
  }
}

// Controller-only retrigger after aligning the retained scope-write reporting frequency fixture.
console.log(JSON.stringify({ status: 'passed', keys: keys.length, files: covered.length, bounded: true }));
