import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { disableLinkedWorkerIdentity, initializeNewWorkerLifecycle } from '../server/worker-lifecycle.mjs';

const migration = readFileSync('server/migrations/022_organization_setup_foundation.sql', 'utf8');
const integrityMigration = readFileSync('server/migrations/023_wos02_scope_lifecycle_integrity.sql', 'utf8');
const closureMigration = readFileSync('server/migrations/024_wos02_final_review_closure.sql', 'utf8');
const timesheetScopeMigration = readFileSync('server/migrations/025_wos02_timesheet_scope_integrity.sql', 'utf8');
const projectLegalScopePrerequisite = readFileSync('server/migrations/025a_wos02_project_legal_scope_unique_prerequisite.sql', 'utf8');
const canonicalScopeMigration = readFileSync('server/migrations/026_wos02_canonical_legal_scope_integrity.sql', 'utf8');
const service = readFileSync('server/organization-setup.mjs', 'utf8');
const server = readFileSync('server/index.mjs', 'utf8');
const ui = readFileSync('src/pages/AdminSettings.tsx', 'utf8');
const api = readFileSync('src/services/api.ts', 'utf8');
const runtimeTerminology = readFileSync('src/config/RuntimeTerminology.tsx', 'utf8');
const apiClient = readFileSync('src/services/apiClient.ts', 'utf8');
const productConfig = readFileSync('src/config/productConfig.ts', 'utf8');

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


assert.match(timesheetScopeMigration, /drop constraint if exists timesheets_employee_id_week_ending_key/, 'unsafe global timesheet uniqueness must be removed');
assert.match(timesheetScopeMigration, /uq_timesheets_org_employee_week[\s\S]*organization_id, employee_id, week_ending/, 'timesheet uniqueness must be organization scoped');
const migrationOrder = readdirSync('server/migrations').filter(file => file.endsWith('.sql')).sort();
assert.ok(
  migrationOrder.indexOf('025_wos02_timesheet_scope_integrity.sql') < migrationOrder.indexOf('025a_wos02_project_legal_scope_unique_prerequisite.sql')
    && migrationOrder.indexOf('025a_wos02_project_legal_scope_unique_prerequisite.sql') < migrationOrder.indexOf('026_wos02_canonical_legal_scope_integrity.sql'),
  'project legal-scope unique prerequisite must run after migration 025 and before migration 026',
);
assert.match(projectLegalScopePrerequisite, /create unique index if not exists uq_projects_org_legal_id[\s\S]*projects\(organization_id, legal_entity_id, id\)/, 'project legal-scope prerequisite must be replay-safe and match the referenced key');
assert.match(canonicalScopeMigration, /project_allocations_project_legal_scope_fk[\s\S]*foreign key \(organization_id, legal_entity_id, project_id\)[\s\S]*references projects\(organization_id, legal_entity_id, id\)/, 'allocation project legal-scope FK must reference the prerequisite unique project key');
assert.match(server, /api\/imports\/timesheets\/apply[\s\S]*from employees[\s\S]*organization_id = \$2 and legal_entity_id = \$3[\s\S]*from projects[\s\S]*organization_id = \$2 and legal_entity_id = \$3/, 'timesheet import references must resolve only within authoritative organization and legal scope');
assert.match(server, /api\/imports\/timesheets\/apply[\s\S]*select \* from timesheets where organization_id = \$1 and legal_entity_id = \$2 and employee_id = \$3 and week_ending = \$4 for update/, 'timesheet import prior-row lookup must be organization/legal scoped and locked');
assert.match(server, /api\/imports\/timesheets\/apply[\s\S]*insert into timesheets \(employee_id, week_ending, status, total_hours, billable_hours, rejection_reason, submitted_at, organization_id, legal_entity_id\)[\s\S]*on conflict \(organization_id, employee_id, week_ending\)/, 'timesheet import must persist authoritative ownership and use the scoped arbiter');
assert.match(server, /delete from timesheet_entries where timesheet_id = \$1/, 'timesheet entries must be replaced only through the authorized scoped timesheet');
assert.match(canonicalScopeMigration, /project_allocations add column if not exists legal_entity_id[\s\S]*project_allocations_employee_legal_scope_fk[\s\S]*project_allocations_project_legal_scope_fk/, 'allocation persistence must enforce employee and project legal ownership');
assert.match(canonicalScopeMigration, /timesheets add column if not exists legal_entity_id[\s\S]*timesheets_employee_legal_scope_fk/, 'timesheet persistence must enforce employee legal ownership');
assert.match(server, /api\/imports\/clients\/apply[\s\S]*from clients[\s\S]*organization_id = \$3 and legal_entity_id = \$4[\s\S]*insert into clients \(id, name, industry, account_owner_id, status, organization_id, legal_entity_id\)/, 'client import must resolve and persist authoritative ownership');
assert.match(server, /api\/imports\/employees\/apply[\s\S]*select \* from employees where employee_id = \$1 and organization_id = \$2 and legal_entity_id = \$3/, 'employee import prior-row reuse must be scoped');
assert.match(server, /api\/projects[\s\S]*select \* from projects where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update[\s\S]*Project not found in the authorized organization and legal entity/, 'project ID updates must deny cross-scope rows before upsert');
assert.match(server, /api\/allocations[\s\S]*from project_allocations where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update[\s\S]*insert into project_allocations \(id,[\s\S]*organization_id, legal_entity_id\)/, 'allocation save must scope existing rows and persist legal ownership');
assert.match(server, /const allocationIdExistsOutsideScope = parsed\.data\.id && !previous[\s\S]*select 1 from project_allocations where id = \$1[\s\S]*if \(allocationIdExistsOutsideScope\)/, 'a new explicit allocation ID must create while an existing cross-scope ID is denied');
assert.match(server, /on conflict \(id\) do update set[\s\S]*where project_allocations\.organization_id = excluded\.organization_id[\s\S]*project_allocations\.legal_entity_id = excluded\.legal_entity_id[\s\S]*returning \*/, 'same-scope allocation IDs must update without permitting a cross-scope conflict mutation');
assert.match(server, /values \(coalesce\(\$1, 'a-' \|\| gen_random_uuid\(\)::text\)/, 'allocation save must retain generated IDs when the request omits an ID');
assert.match(server, /if \(result\.rowCount === 0\)[\s\S]*Allocation not found in the authorized organization and legal entity/, 'a racing cross-scope allocation ID collision must fail closed without mutation');
assert.match(server, /api\/timesheets[\s\S]*from employees where id = \$1 and organization_id = \$2 and legal_entity_id = \$3[\s\S]*pa\.organization_id = \$3 and pa\.legal_entity_id = \$4/, 'timesheet save must scope employees and covering allocations by legal entity');

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
assert.match(service, /select h\.\* from worker_history h[\s\S]*h\.legal_entity_id=\$3/, 'worker history rows must be scoped by version ownership');
assert.doesNotMatch(service, /router\.get\('\/workers\/:id\/history'[\s\S]*join worker_profiles/, 'history authorization must not depend on the worker current legal entity');
assert.match(closureMigration, /employee_record_id[\s\S]*uq_users_employee_record/, 'identity must use an unambiguous employee record link');
assert.match(closureMigration, /worker_history add column if not exists legal_entity_id/, 'history versions must persist legal ownership');
assert.match(closureMigration, /working_calendar_versions_no_overlap[\s\S]*exclude using gist/, 'calendar versions must not overlap');
assert.match(service, /FUTURE_TRANSITION_UNSUPPORTED/, 'future lifecycle changes must not mutate current state');
assert.match(service, /router\.post\('\/calendars'/, 'calendars must have governed authoring');
assert.match(service, /Version Calendar'[\s\S]*details:'Created an effective-dated working calendar version'/, 'calendar authoring must satisfy the retained non-null audit detail contract');
assert.match(service, /router\.post\('\/reporting-periods'/, 'reporting periods must have governed authoring');
assert.match(service, /router\.post\('\/terminology'/, 'terminology must have governed authoring');
assert.match(server, /registerOrganizationSetupRoutes/, 'canonical API must register the setup module');
assert.match(ui, /Organization setup readiness/, 'governance UI must expose setup readiness');
assert.match(ui, /setupReadiness\.checks/, 'UI must render server-derived checks');
assert.match(api, /\/api\/organization-setup\/readiness/, 'UI service must call the canonical readiness endpoint');
assert.match(runtimeTerminology, /\/api\/organization-setup\/terminology/, 'runtime must consume effective persisted terminology');
assert.match(productConfig, /new Proxy\(defaultTerminology/, 'covered product labels must resolve through the central runtime terminology layer');
assert.match(apiClient, /workos:organization-scope-changed/, 'terminology must refresh after governed scope selection');
assert.match(server, /result\.rows\.length === 1 \? result\.rows\[0\] : null/, 'ambiguous local login identifiers must fail closed');
assert.match(server, /not exists\(select 1 from direct_users\)[\s\S]*u2\.status='Active'[\s\S]*e2\.status<>'Exited'/, 'employee-code login must be used only for active employee-linked users when no unique username or email matched');
assert.match(server, /insert into project_allocations[\s\S]*organization_id/, 'allocation imports must persist authoritative organization ownership');
assert.match(server, /api\/imports\/allocations\/apply[\s\S]*organization_id=\$2 and legal_entity_id=\$3[\s\S]*p\.legal_entity_id=\$3 and e\.legal_entity_id=\$3/, 'allocation imports must resolve and update references only in the authorized organization and legal entity');

const lifecycleQueries = [];
const lifecycleClient = { query: async (sql, params) => {
  lifecycleQueries.push({ sql, params });
  return { rowCount: 1, rows: [] };
} };
const workerInput = { employeeId: 'employee-record', organizationId: 'org-a', legalEntityId: 'legal-a', actorId: 'actor-a' };
assert.equal(await initializeNewWorkerLifecycle(lifecycleClient, { ...workerInput, isNew: true }), true);
assert.equal(lifecycleQueries.length, 2, 'new employees must receive exactly one profile and one initial history insert');
assert.match(lifecycleQueries[0].sql, /insert into worker_profiles[\s\S]*case e\.status when 'Exited' then 'Exited' when 'On Leave' then 'On Leave' else 'Active' end[\s\S]*coalesce\(e\.joining_date, e\.created_at::date, current_date\)/, 'initial lifecycle state and effective date must match WOS-02 backfill semantics');
assert.match(lifecycleQueries[1].sql, /insert into worker_history[\s\S]*organization_id, legal_entity_id[\s\S]*to_jsonb\(e\)/, 'initial history must retain authoritative legal ownership and the employee snapshot');
assert.deepEqual(lifecycleQueries[1].params, ['employee-record', 'org-a', 'legal-a', 'actor-a']);
assert.equal(await initializeNewWorkerLifecycle(lifecycleClient, { ...workerInput, isNew: false }), false);
assert.equal(lifecycleQueries.length, 2, 'employee updates and import replays must not reset or duplicate worker history');
assert.equal((server.match(/initializeNewWorkerLifecycle\(client,/g) || []).length, 2, 'canonical employee save and import must both initialize new worker state');
assert.match(server, /employee:\$\{req\.organizationScope\.organizationId\}:\$\{req\.organizationScope\.legalEntityId\}:\$\{parsed\.data\.employee_id\}[\s\S]*isNew: !previous/, 'canonical employee save must serialize new-record detection before worker initialization');
assert.match(server, /api\/imports\/employees\/apply[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{req\.organizationScope\.legalEntityId\}:\$\{row\.employeeId\}[\s\S]*isNew: !previous/, 'employee import must serialize new-record detection before worker initialization');

const identityQueries = [];
const identityClient = { query: async (sql, params) => {
  identityQueries.push({ sql, params });
  return sql.includes('update users') ? { rowCount: 1, rows: [{ id: '00000000-0000-0000-0000-000000000001' }] } : { rowCount: 1, rows: [] };
} };
assert.equal(await disableLinkedWorkerIdentity(identityClient, workerInput), 1);
assert.match(identityQueries[0].sql, /update users set status='Disabled'[\s\S]*employee_record_id=\$1/, 'leaver identity synchronization must use the unambiguous employee-record link');
assert.match(identityQueries[1].sql, /update user_organization_scopes set active=false[\s\S]*organization_id=\$2 and legal_entity_id=\$3/, 'leaver scope synchronization must deactivate the applicable persisted scope');
assert.match(identityQueries[1].sql, /returning user_id/, 'scope synchronization must be verifiable before the transition commits');
assert.match(service, /if\(\['Disabled','Exited'\]\.includes\(parsed\.data\.status\)\)[\s\S]*disableLinkedWorkerIdentity/, 'only Disabled and Exited transitions may disable linked identity');
assert.match(service, /if\(deps\.rowCount\)[\s\S]*rollback[\s\S]*WORKER_DEPENDENCY_CONFLICT[\s\S]*disableLinkedWorkerIdentity/, 'dependency conflicts must roll back before identity synchronization');
assert.match(service, /if\(replay\.rowCount\)[\s\S]*replayed:true[\s\S]*disableLinkedWorkerIdentity/, 'idempotent transition replay must return before repeated identity side effects');
await assert.rejects(
  disableLinkedWorkerIdentity({ query: async sql => {
    if (sql.includes('update users')) return { rowCount: 1, rows: [{ id: '00000000-0000-0000-0000-000000000001' }] };
    throw new Error('scope synchronization failed');
  } }, workerInput),
  /scope synchronization failed/,
  'identity/scope synchronization failures must propagate to the route transaction rollback',
);

console.log(JSON.stringify({status:'passed', matrix:{A:true,B:true,C:true,D:true,E:true,F:true,G:true,H:true,I:true}}, null, 2));
