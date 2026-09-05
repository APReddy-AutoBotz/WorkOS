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
const registry = read('src/config/terminology.ts');
for (const key of keys) {
  assert.match(registry, new RegExp(`\\b${key}\\b`), `persisted terminology key missing: ${key}`);
  assert.match(combined, new RegExp(`(?:terminology|terms|term|\\bt\\b)[^\\n]{0,80}\\b${key}\\b`, 'i'),
    `terminology key is not materially consumed by a covered runtime surface: ${key}`);
}

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
assert.match(provider, /organization|organizationId|activeOrganization/i, 'provider is not organization scoped');
assert.match(provider, /useEffect[\s\S]*\[[^\]]*(?:organization|organizationId|activeOrganization)/i,
  'provider does not reload when organization scope changes');
assert.match(provider, /defaultTerminology|DEFAULT_TERMINOLOGY|fallback/i, 'provider has no deterministic fallback');
assert.match(provider, /catch|\.catch\s*\(/, 'fetch failure is not handled');
assert.match(provider, /valid|sanitize|parse|normalize/i, 'invalid terminology is not validated/normalized');

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

// Guard the product terminology commit from renaming durable contracts. These
// tokens are canonical implementation vocabulary, not user-facing copy.
const contractFiles = ['src/App.tsx', 'src/services/api.ts', 'src/services/apiClient.ts', 'src/types.ts'];
const contractSource = contractFiles.map(read).join('\n');
for (const token of ['/employees', '/projects', 'employee_id', 'project_id', 'organization_id', 'legal_entity_id']) {
  assert(contractSource.includes(token), `stable canonical contract token missing: ${token}`);
}
const previousContractSource = contractFiles.map((file) =>
  execFileSync('git', ['show', `HEAD^:${file}`], { cwd: root, encoding: 'utf8' })).join('\n');
for (const pattern of [
  /['"`]\/(?:employees|projects)(?:\/|['"`])/g,
  /\b(?:employee_id|project_id|organization_id|legal_entity_id)\b/g,
  /\b(?:permission|role|event_type|audit_action|audit_entity)\b\s*[:=]/gi,
  /["'`][^"'`\n]+\.csv["'`]/gi,
]) {
  assert.deepEqual(contractSource.match(pattern) || [], previousContractSource.match(pattern) || [],
    `terminology delta changed stable contract sequence: ${pattern}`);
}

console.log(JSON.stringify({ status: 'passed', keys: keys.length, files: covered.length, bounded: true }));
