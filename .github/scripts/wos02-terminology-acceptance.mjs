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

// Execute the product-owned behavioral contract first. The independent checks below
// additionally bind VE/VF semantics and may not be weakened or substituted by it.
execFileSync('npm', ['run', 'test:terminology-runtime'], {
  cwd: root,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
});

const keys = ['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'];
const registry = read('src/config/productConfig.ts');
const terminology = read('src/config/terminology.ts');
const service = read('server/organization-setup.mjs');
const productSmoke = read('tests/terminology-runtime-smoke.mjs');
const setupSmoke = read('tests/organization-setup-smoke.mjs');

for (const key of keys) {
  assert.match(registry, new RegExp(`\\b${key}\\b`), `terminology key missing from authoritative product config: ${key}`);
  assert.match(combined, new RegExp(`(?:terminology|terms|term|\\bt\\b)[^\\n]{0,80}\\b${key}\\b`, 'i'),
    `terminology key is not materially consumed by a covered runtime surface: ${key}`);
}

// VE: independently configurable singular/plural/help-text values must be authoritative.
assert.match(registry, /TerminologyValue[^\n]*singular:\s*string[^\n]*plural:\s*string[^\n]*helpText:\s*string/,
  'runtime terminology does not expose independent singular/plural/help-text authority');
assert.match(registry, /typeof candidate\.singular[^\n]*string[\s\S]{0,180}typeof candidate\.plural[^\n]*string[\s\S]{0,180}typeof candidate\.helpText[^\n]*string/,
  'structured runtime terminology does not validate all three configured fields');
assert.match(registry, /getTerminologyValue[\s\S]{0,200}persistedTerminology\[key\]\s*\|\|\s*defaultTerminology\[key\]/,
  'persisted structured terminology is not authoritative over defaults');
assert.match(terminology, /termPlural[^\n]*getTerminologyValue\(key\)\.plural/,
  'plural display helper does not consume the independently configured plural');
assert.match(terminology, /termHelpText[^\n]*getTerminologyValue\(key\)\.helpText/,
  'help-text display helper does not expose independently configured help text');
assert.match(productSmoke, /singular:'person',\s*plural:'people'/,
  'behavioral evidence does not cover an irregular configured plural');
assert.match(productSmoke, /singular:'staff',\s*plural:'staff'/,
  'behavioral evidence does not cover an uncountable configured plural');
assert.match(productSmoke, /People who perform work\./,
  'behavioral evidence does not cover configured help text');

// Backward compatibility is exact: legacy scalar persisted values and legacy scalar
// environment overrides retain the pre-change pluralization behavior.
assert.match(registry, /typeof value === 'string' && value\.trim\(\)[\s\S]{0,180}plural:\s*legacyPluralize\(singular\)/,
  'legacy persisted scalar terminology does not retain scalar-derived plural behavior');
assert.match(registry, /explicitPlural\s*\|\|\s*\(envValue\s*\?\s*legacyPluralize\(singular\)\s*:\s*fallbackPlural\)/,
  'legacy scalar environment override does not retain pre-change plural behavior');
assert.match(productSmoke, /legacy persisted scalar uses the exact pre-change plural rule/,
  'behavioral evidence does not exercise legacy persisted scalar compatibility');
assert.match(productSmoke, /legacy scalar environment override derives its plural/,
  'behavioral evidence does not exercise legacy scalar environment compatibility');
assert.match(productSmoke, /explicit plural and help environment overrides are authoritative/,
  'behavioral evidence does not exercise explicit plural/help environment authority');

// VF: governed terminology writes require a complete bounded contract, serialization,
// deterministic effective dating, current actor attribution, and transactional audit.
assert.match(service, /terminologyTermsSchema\s*=\s*z\.object\([\s\S]{0,180}terminologyValueSchema[\s\S]{0,80}\.strict\(\)/,
  'terminology write contract is not strict and complete');
assert.match(service, /singular:z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)[\s\S]{0,180}plural:z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)[\s\S]{0,180}helpText:z\.string\(\)\.trim\(\)\.max\(500\)/,
  'terminology fields are not independently bounded');
assert.match(service, /router\.post\('\/terminology'[\s\S]{0,500}client\.query\('begin'\)[\s\S]{0,300}pg_advisory_xact_lock/,
  'terminology mutation is not transactionally serialized');
assert.match(service, /TERMINOLOGY_VERSION_CONFLICT/,
  'terminology stale/concurrent version conflicts lack stable authority');
assert.match(service, /update terminology_versions set terms=\$3,created_by=\$4[\s\S]{0,240}req\.user\.sub/,
  'same-effective terminology replay does not attribute the current actor');
assert.match(service, /await audit\(client,req,\{module:'Organization Setup',action:exact\?'Update Terminology':'Version Terminology'[\s\S]{0,420}oldValue:exact\|\|null,newValue:result\.rows\[0\]/,
  'terminology mutation lacks transactional before/after audit evidence');
assert.match(setupSmoke, /invalid terminology must fail closed/,
  'setup contract does not exercise malformed/missing/unknown/bounded terminology rejection');
assert.match(setupSmoke, /legacy persisted scalar rows must preserve scalar-derived plural behavior/,
  'setup contract does not preserve legacy persisted scalar compatibility');
assert.match(setupSmoke, /terminology audit must contain material before and after values/,
  'setup contract does not bind terminology audit before/after evidence');
assert.match(setupSmoke, /same-effective terminology updates must record the current actor/,
  'setup contract does not bind terminology actor attribution');

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

// Finite display scan: canonical identifiers are not rewritten by terminology.
const forbiddenDisplay = /(?:>\s*|(?:label|title|placeholder|aria-label)\s*=\s*["'])(Employees?|Managers?|Team Leads?|Business Units?|Regions?|Regional Owners?|Engagements?|Projects?|Worklogs?)(?:\s*<|["'])/gi;
const literalAllowList = new Map([]);
for (const [file, source] of sources) {
  for (const match of source.matchAll(forbiddenDisplay)) {
    const literal = match[1];
    assert(literalAllowList.get(file)?.has(literal), `literal terminology bypass in ${file}: ${literal}`);
  }
}

const contractFiles = ['server/index.mjs', 'src/App.tsx', 'src/services/api.ts', 'src/services/apiClient.ts', 'src/types.ts'];
const contractSource = contractFiles.map(read).join('\n');
for (const token of ['/employees', '/projects', 'employee_id', 'project_id', 'organization_id', 'legal_entity_id']) {
  assert(contractSource.includes(token), `stable canonical contract token missing: ${token}`);
}
const previousContractSource = contractFiles.map((file) =>
  execFileSync('git', ['show', `HEAD^:${file}`], { cwd: root, encoding: 'utf8' })).join('\n');
const stableContractExtractors = [
  { name: 'employee/project route literals', pattern: /['"`]\/(?:employees|projects)(?:\/|['"`])/g, normalize: (value) => value.replace(/^[`'"]/, '').replace(/[`'"]$/, '') },
  { name: 'canonical ownership identifiers', pattern: /\b(?:employee_id|project_id|organization_id|legal_entity_id)\b/g, normalize: (value) => value },
  { name: 'permission/role/event/audit property keys', pattern: /\b(?:permission|role|event_type|audit_action|audit_entity)\b\s*[:=]/gi, normalize: (value) => value.toLowerCase().replace(/\s*[:=]\s*$/, '') },
  { name: 'CSV filenames', pattern: /["'`][^"'`\n]+\.csv["'`]/gi, normalize: (value) => value.slice(1, -1) },
];
for (const { name, pattern, normalize } of stableContractExtractors) {
  const previousValues = new Set((previousContractSource.match(pattern) || []).map(normalize));
  const currentValues = new Set((contractSource.match(pattern) || []).map(normalize));
  for (const value of previousValues) assert(currentValues.has(value), `stable canonical contract removed or renamed (${name}): ${value}`);
}

console.log(JSON.stringify({ status: 'passed', family: 'VE/VF', keys: keys.length, files: covered.length, bounded: true }));
