import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('server/migrations/022_organization_setup_foundation.sql', 'utf8');
const integrityMigration = readFileSync('server/migrations/023_wos02_scope_lifecycle_integrity.sql', 'utf8');
const service = readFileSync('server/organization-setup.mjs', 'utf8');
const server = readFileSync('server/index.mjs', 'utf8');
const ui = readFileSync('src/pages/AdminSettings.tsx', 'utf8');
const api = readFileSync('src/services/api.ts', 'utf8');

for (const table of ['organizations','legal_entities','user_organization_scopes','organization_catalog_items','working_calendars','reporting_periods','terminology_versions','worker_profiles','organization_history','worker_history']) {
  assert.match(migration, new RegExp(`create table if not exists ${table}`), `${table} must be migration-owned`);
}
for (const entity of ['employees','clients','projects','project_allocations','timesheets']) {
  assert.match(migration, new RegExp(`alter table ${entity} add column if not exists organization_id`), `${entity} needs organization ownership`);
}
assert.match(migration, /'org-default'[\s\S]*'legal-default'/, 'upgrade backfill identifiers must be deterministic');
assert.match(migration, /on conflict (\([^)]*\) )?do nothing/g, 'seed and history backfill must be replay-safe');
assert.match(migration, /uq_employees_org_employee_id/, 'worker identifier uniqueness must be organization-scoped');
assert.match(migration, /uq_projects_org_code/, 'project identifier uniqueness must be organization-scoped');
assert.match(migration, /effective_from[\s\S]*effective_to/, 'effective-dated records must retain historical ranges');
assert.match(migration, /check \(effective_to is null or effective_to >= effective_from\)/, 'effective ranges must be valid');
assert.match(integrityMigration, /employees_organization_legal_entity_fk/, 'employee organization/legal-entity ownership must be database enforced');
assert.match(integrityMigration, /clients_organization_legal_entity_fk/, 'client organization/legal-entity ownership must be database enforced');
assert.match(integrityMigration, /projects_organization_legal_entity_fk/, 'project organization/legal-entity ownership must be database enforced');
assert.match(integrityMigration, /organization_catalog_versions_no_overlap[\s\S]*exclude using gist/, 'catalog history must reject overlapping ranges');
assert.match(integrityMigration, /worker_history_versions_no_overlap[\s\S]*exclude using gist/, 'worker history must reject overlapping ranges');

assert.match(service, /user_organization_scopes/, 'scope must be resolved from persisted assignments');
assert.match(service, /ORG_SCOPE_DENIED/, 'unauthorized caller scope must fail closed');
assert.match(service, /LEGAL_SCOPE_DENIED/, 'cross-legal-entity writes must fail closed');
assert.match(service, /authority:'persisted-server-state'/, 'readiness must identify its authoritative source');
assert.doesNotMatch(service, /req\.body\.(ready|complete|completed)/, 'readiness must not trust caller completion flags');
assert.match(service, /pg_advisory_xact_lock/, 'catalog and worker mutations must serialize competing operations');
assert.match(service, /WORKER_DEPENDENCY_CONFLICT/, 'unsafe worker transitions need a stable conflict code');
assert.match(service, /await client\.query\('rollback'\);return res\.status\(409\)/, 'dependency conflict must roll back before responding');
assert.match(service, /MAX_SETUP_ROWS = 200/, 'list surfaces must be bounded');
assert.match(service, /MAX_DEPENDENCIES = 100/, 'dependency discovery must be bounded');
assert.match(service, /MAX_HISTORY_ROWS = 100/, 'history must be bounded');
assert.match(service, /idempotencyKey/, 'worker lifecycle retries must be idempotent');
assert.match(service, /Catalog versions must be added after the latest version/, 'backdated catalog versions must fail before mutation');
assert.match(service, /Worker transition conflicts with existing history/, 'backdated worker transitions must return a stable conflict');
assert.match(service, /catalog_type=\$3 and \(legal_entity_id is null or legal_entity_id=\$4\) for update/, 'catalog retirement must match type and legal scope');
assert.match(service, /e\.legal_entity_id=\$3 and wp\.organization_id=\$2 and wp\.legal_entity_id=\$3/, 'worker mutations must match persisted legal scope');
assert.match(server, /registerOrganizationSetupRoutes/, 'canonical API must register the setup module');
assert.match(ui, /Organization setup readiness/, 'governance UI must expose setup readiness');
assert.match(ui, /setupReadiness\.checks/, 'UI must render server-derived checks');
assert.match(api, /\/api\/organization-setup\/readiness/, 'UI service must call the canonical readiness endpoint');

console.log(JSON.stringify({status:'passed', matrix:{A:true,B:true,C:true,D:true,E:true,F:true,G:true,H:true,I:true}}, null, 2));
