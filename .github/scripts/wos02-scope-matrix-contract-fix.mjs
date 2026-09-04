import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('target path is required');
let s = readFileSync(path, 'utf8');
const original = s;
const one = (oldValue, newValue, label) => {
  const count = s.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  s = s.replace(oldValue, newValue);
};

one(
  "await pool.query(`insert into organizations(id,code,name,effective_from) values('org-scope','ORG-SCOPE','Scope Org','2026-01-01') on conflict(id) do nothing`);",
  "await pool.query(`insert into organizations(id,code,name,effective_from) values\n ('org-scope','ORG-SCOPE','Scope Org','2026-01-01'),\n ('org-duplicate','ORG-DUPLICATE','Duplicate Org','2026-01-01')\n on conflict(id) do nothing`);",
  'organizations fixture',
);
one(
  " ('legal-scope-b','org-scope','LEGAL-SCOPE-B','Scope Legal B','2026-01-01')\n on conflict(id) do nothing`);",
  " ('legal-scope-b','org-scope','LEGAL-SCOPE-B','Scope Legal B','2026-01-01'),\n ('legal-duplicate','org-duplicate','LEGAL-DUPLICATE','Duplicate Legal','2026-01-01')\n on conflict(id) do nothing`);",
  'legal entities fixture',
);

const adminFixture = "await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)\n values('admin-scope','ADMIN-SCOPE','Scope Admin','scope-admin@example.test','System Administrator','Administration','Synthetic','cd-scope','Active','org-scope','legal-scope-a')\n on conflict(id) do nothing`);";
one(
  adminFixture,
  "await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)\n values('legal-b-employee','E-LEGAL-B','Legal B Employee','legal-b-employee@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-scope','legal-scope-b')\n on conflict(id) do nothing`);\n" + adminFixture,
  'legal-B employee fixture',
);

one(
  "values('dup-canon-b','E-DUP-CANON','Duplicate Canon B','dup-canon-b@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-scope','legal-scope-b')`);",
  "values('dup-canon-other','E-DUP-CANON','Duplicate Canon Other','dup-canon-other@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-duplicate','legal-duplicate')`);",
  'canonical duplicate preseed',
);
one(
  "await check('canonical employee save supports duplicate employee code in another legal entity without ID reuse', async () => {",
  "await check('canonical employee save supports organization-scoped duplicate employee code without ID reuse', async () => {",
  'canonical duplicate title',
);
one(
  "    const rows = (await pool.query(`select id,legal_entity_id from employees where organization_id='org-scope' and employee_id='E-DUP-CANON' order by legal_entity_id`)).rows;\n    assert.equal(rows.length, 2, JSON.stringify(rows));\n    assert.deepEqual(rows.map(row => row.legal_entity_id), ['legal-scope-a','legal-scope-b']);\n    assert.notEqual(rows[0].id, rows[1].id);\n    employeeA = rows.find(row => row.legal_entity_id === 'legal-scope-a').id;",
  "    const rows = (await pool.query(`select id,organization_id,legal_entity_id from employees where employee_id='E-DUP-CANON' order by organization_id`)).rows;\n    assert.equal(rows.length, 2, JSON.stringify(rows));\n    assert.deepEqual(rows.map(row => row.organization_id), ['org-duplicate','org-scope']);\n    assert.notEqual(rows[0].id, rows[1].id);\n    employeeA = rows.find(row => row.organization_id === 'org-scope' && row.legal_entity_id === 'legal-scope-a').id;",
  'canonical duplicate assertion',
);

one(
  "values('dup-import-b','E-DUP-IMPORT','Duplicate Import B','dup-import-b@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-scope','legal-scope-b')`);",
  "values('dup-import-other','E-DUP-IMPORT','Duplicate Import Other','dup-import-other@example.test','Engineer','Delivery','Synthetic','cd-scope','Active','org-duplicate','legal-duplicate')`);",
  'import duplicate preseed',
);
one(
  "await check('employee import supports duplicate employee code in another legal entity without ID reuse', async () => {",
  "await check('employee import supports organization-scoped duplicate employee code without ID reuse', async () => {",
  'import duplicate title',
);
one(
  "    const rows = (await pool.query(`select id,legal_entity_id from employees where organization_id='org-scope' and employee_id='E-DUP-IMPORT' order by legal_entity_id`)).rows;\n    assert.equal(rows.length, 2, JSON.stringify(rows));\n    assert.notEqual(rows[0].id, rows[1].id);\n    importedEmployeeA = rows.find(row => row.legal_entity_id === 'legal-scope-a').id;",
  "    const rows = (await pool.query(`select id,organization_id,legal_entity_id from employees where employee_id='E-DUP-IMPORT' order by organization_id`)).rows;\n    assert.equal(rows.length, 2, JSON.stringify(rows));\n    assert.deepEqual(rows.map(row => row.organization_id), ['org-duplicate','org-scope']);\n    assert.notEqual(rows[0].id, rows[1].id);\n    importedEmployeeA = rows.find(row => row.organization_id === 'org-scope' && row.legal_entity_id === 'legal-scope-a').id;",
  'import duplicate assertion',
);

s = s.replaceAll("'dup-canon-b'", "'legal-b-employee'");
s = s.replaceAll("'Duplicate Canon B'", "'Legal B Employee'");

if (s === original) throw new Error('no controller contract change produced');
for (const required of [
  'org-duplicate',
  'legal-duplicate',
  "values('legal-b-employee','E-LEGAL-B'",
  'canonical employee save supports organization-scoped duplicate employee code',
  'employee import supports organization-scoped duplicate employee code',
]) {
  if (!s.includes(required)) throw new Error(`missing required token: ${required}`);
}
if (s.includes("'dup-canon-b'")) throw new Error('stale legal-B employee id remains');
writeFileSync(path, s);
console.log('scope-write controller contract corrected');
