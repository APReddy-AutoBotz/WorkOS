import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error('source and output paths are required');

let s = readFileSync(sourcePath, 'utf8');
const original = s;
const mustReplace = (from, to, count = 1) => {
  const found = s.split(from).length - 1;
  if (found !== count) throw new Error(`expected ${count} occurrences, found ${found}: ${from.slice(0, 120)}`);
  s = s.replace(from, to);
};

mustReplace(
  'TARGET_HEAD: 7b8200a75e75d24f3c2cc114c5ebe74b789c9fba',
  'TARGET_HEAD: 031be9e18b6871594f0cfef25f8b098741dde74c',
);
mustReplace(
  'TARGET_TREE: f2f7a8e5b2c1f8244e6c7d6bfa8dc8f33d219a17',
  'TARGET_TREE: 6f8813a9bb0a4821734ae8cd0a60f935fe1e16e1',
);
mustReplace(
  'Verify exact product controller main and 20-file authority',
  'Verify exact product controller main and 21-file authority',
);
mustReplace(
  "              'server/migrations/025_wos02_timesheet_scope_integrity.sql',\n              'server/migrations/026_wos02_canonical_legal_scope_integrity.sql',",
  "              'server/migrations/025_wos02_timesheet_scope_integrity.sql',\n              'server/migrations/025a_wos02_project_legal_scope_unique_prerequisite.sql',\n              'server/migrations/026_wos02_canonical_legal_scope_integrity.sql',",
);
mustReplace(
  "ids=\"'022_organization_setup_foundation','023_wos02_scope_lifecycle_integrity','024_wos02_final_review_closure','025_wos02_timesheet_scope_integrity','026_wos02_canonical_legal_scope_integrity'\"",
  "ids=\"'022_organization_setup_foundation','023_wos02_scope_lifecycle_integrity','024_wos02_final_review_closure','025_wos02_timesheet_scope_integrity','025a_wos02_project_legal_scope_unique_prerequisite','026_wos02_canonical_legal_scope_integrity'\"",
);

const countLine = '          test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id in ($ids)")" = 5\n';
const countOccurrences = s.split(countLine).length - 1;
if (countOccurrences !== 2) throw new Error(`expected two fresh/replay count assertions, found ${countOccurrences}`);
const enhancedFirst = `          test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id in ($ids)")" = 6
          node -e "const fs=require('fs');const f=fs.readdirSync('server/migrations').filter(x=>x.endsWith('.sql')).sort();const a=f.indexOf('025_wos02_timesheet_scope_integrity.sql'),b=f.indexOf('025a_wos02_project_legal_scope_unique_prerequisite.sql'),c=f.indexOf('026_wos02_canonical_legal_scope_integrity.sql');if(!(a>=0&&a<b&&b<c))throw new Error('invalid migration order '+f.join(','));"
          test "$(psql "$DATABASE_URL" -Atc "select count(*) from pg_indexes where indexname='uq_projects_org_legal_id'")" = 1
          test "$(psql "$DATABASE_URL" -Atc "select count(*) from pg_constraint where conname='project_allocations_project_legal_scope_fk'")" = 1
`;
s = s.replace(countLine, enhancedFirst);
s = s.replace(countLine, '          test "$(psql "$DATABASE_URL" -Atc "select count(*) from schema_migrations where id in ($ids)")" = 6\n');

mustReplace(
  '          test "$(psql "$UPGRADE_URL" -Atc "select count(*) from schema_migrations where id=\'026_wos02_canonical_legal_scope_integrity\'")" = 1\n',
  '          test "$(psql "$UPGRADE_URL" -Atc "select count(*) from schema_migrations where id=\'025a_wos02_project_legal_scope_unique_prerequisite\'")" = 1\n          test "$(psql "$UPGRADE_URL" -Atc "select count(*) from schema_migrations where id=\'026_wos02_canonical_legal_scope_integrity\'")" = 1\n',
);

if (s === original) throw new Error('no changes produced');
for (const required of [
  '031be9e18b6871594f0cfef25f8b098741dde74c',
  '6f8813a9bb0a4821734ae8cd0a60f935fe1e16e1',
  '21-file authority',
  '025a_wos02_project_legal_scope_unique_prerequisite.sql',
  "= 6",
  "uq_projects_org_legal_id",
  "project_allocations_project_legal_scope_fk",
]) {
  if (!s.includes(required)) throw new Error(`missing required rebound token: ${required}`);
}
if (s.includes('TARGET_HEAD: 7b8200a75e75d24f3c2cc114c5ebe74b789c9fba')) throw new Error('old product head remains');
if (s.includes('TARGET_TREE: f2f7a8e5b2c1f8244e6c7d6bfa8dc8f33d219a17')) throw new Error('old product tree remains');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, s);
const bytes = Buffer.from(s);
const digest = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${outputPath}.sha256`, `${digest}  ${outputPath.split('/').pop()}\n`);
writeFileSync(`${outputPath}.bytes`, `${bytes.length}\n`);
console.log(JSON.stringify({ bytes: bytes.length, sha256: digest }, null, 2));
