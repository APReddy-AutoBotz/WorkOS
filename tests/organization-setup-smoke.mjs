import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { disableLinkedWorkerIdentity, initializeNewWorkerLifecycle } from '../server/worker-lifecycle.mjs';
import { assertReportingPeriodAllows, canTransitionReportingPeriod, REPORTING_PERIOD_OPERATIONS, ReportingPeriodError } from '../server/reporting-periods.mjs';
import { buildSetupReadiness, identityReadinessFromEnvironment, productionReadinessFromEnvironment, REQUIRED_SETUP_CHECKS } from '../server/setup-readiness.mjs';
import { validateLegalEntity, validateOrganizationProfile } from '../server/organization-setup.mjs';
import { calendarScopeValues, validateWorkingCalendar, validateWorkingCalendarHoliday } from '../server/working-calendars.mjs';

const migration = readFileSync('server/migrations/022_organization_setup_foundation.sql', 'utf8');
const integrityMigration = readFileSync('server/migrations/023_wos02_scope_lifecycle_integrity.sql', 'utf8');
const closureMigration = readFileSync('server/migrations/024_wos02_final_review_closure.sql', 'utf8');
const timesheetScopeMigration = readFileSync('server/migrations/025_wos02_timesheet_scope_integrity.sql', 'utf8');
const projectLegalScopePrerequisite = readFileSync('server/migrations/025a_wos02_project_legal_scope_unique_prerequisite.sql', 'utf8');
const canonicalScopeMigration = readFileSync('server/migrations/026_wos02_canonical_legal_scope_integrity.sql', 'utf8');
const reportingPeriodMigration = readFileSync('server/migrations/027_wos02_reporting_period_authority.sql', 'utf8');
const organizationProfileMigration = readFileSync('server/migrations/028_wos02_organization_legal_entity_profiles.sql', 'utf8');
const calendarAuthorityMigration = readFileSync('server/migrations/029_wos02_working_calendar_authority.sql', 'utf8');
const service = readFileSync('server/organization-setup.mjs', 'utf8');
const server = readFileSync('server/index.mjs', 'utf8');
const ui = readFileSync('src/pages/AdminSettings.tsx', 'utf8');
const api = readFileSync('src/services/api.ts', 'utf8');
const runtimeTerminology = readFileSync('src/config/RuntimeTerminology.tsx', 'utf8');
const apiClient = readFileSync('src/services/apiClient.ts', 'utf8');
const productConfig = readFileSync('src/config/productConfig.ts', 'utf8');

const validCalendar = { code:'US-WORK',name:'US Standard',timezone:'America/New_York',workingDays:[1,2,3,4,5],
  hoursPerDay:8,effectiveFrom:'2026-01-01',applicability:{type:'legal_entity'} };
assert.equal(validateWorkingCalendar(validCalendar).success,true,'legal-entity calendar compatibility must remain valid');
assert.equal(validateWorkingCalendar({...validCalendar,applicability:{type:'country',countryCode:'US'}}).success,true,'country applicability must validate');
assert.equal(validateWorkingCalendar({...validCalendar,applicability:{type:'worker_group',workerGroupId:'business-unit-a'}}).success,true,'canonical worker-group applicability must validate');
for (const invalid of [
  {workingDays:[1,1,2]}, {workingDays:[1,7]}, {hoursPerDay:0}, {hoursPerDay:24.01},
  {applicability:{type:'country',countryCode:'USA'}}, {applicability:{type:'worker_group',workerGroupId:''}},
]) assert.equal(validateWorkingCalendar({...validCalendar,...invalid}).success,false,`${Object.keys(invalid)[0]} must fail calendar validation without a write`);
assert.deepEqual(calendarScopeValues({type:'legal_entity'},'legal-a'),{applicabilityType:'legal_entity',legalEntityId:'legal-a',countryCode:null,countryAuthorityLegalEntityId:null,workerGroupId:null});
assert.equal(validateWorkingCalendarHoliday({holidayDate:'2026-07-04',label:'Public Holiday',holidayType:'Public',effectiveFrom:'2026-01-01'}).success,true);
assert.equal(validateWorkingCalendarHoliday({holidayDate:'2026-12-24',label:'Company Holiday',holidayType:'Company',effectiveFrom:'2026-01-01'}).success,true);
assert.equal(validateWorkingCalendarHoliday({holidayDate:'2026-12-24',label:'Invalid',holidayType:'Optional',effectiveFrom:'2026-01-01'}).success,false);
assert.match(calendarAuthorityMigration,/update working_calendars set applicability_type='legal_entity'[\s\S]*working_calendars_applicability_check/,'migration 029 must deterministically retain existing legal-entity calendars');
assert.match(calendarAuthorityMigration,/country_authority_legal_entity_id[\s\S]*working_calendars_country_authority_fk[\s\S]*working_calendars_worker_group_fk/,'country and canonical worker-group references must be database-owned');
assert.match(calendarAuthorityMigration,/enforce_working_calendar_worker_group[\s\S]*catalog_type='business_unit'[\s\S]*working_calendars_worker_group_authority/,'alternate database writes must not attach a noncanonical worker-group reference');
assert.match(calendarAuthorityMigration,/working_calendar_versions_no_overlap[\s\S]*applicability_type with =[\s\S]*daterange/,'calendar versions must remain non-overlapping per applicability scope');
assert.match(calendarAuthorityMigration,/working_calendar_holidays[\s\S]*holiday_type in \('Public','Company'\)[\s\S]*working_calendar_holiday_date_authority_no_overlap/,'public/company holiday authority must prevent ambiguous same-date versions');
assert.match(service,/CALENDAR_COUNTRY_NOT_FOUND[\s\S]*catalog_type='business_unit'[\s\S]*CALENDAR_WORKER_GROUP_NOT_FOUND/,'calendar applicability must fail closed against persisted country and worker-group authority');
assert.match(service,/if\(latest&&parsed\.data\.effectiveFrom<=dateOnly\(latest\.effective_from\)\)[\s\S]*CALENDAR_VERSION_CONFLICT/,'stale and same-date calendar versions must remain fail-closed');
assert.match(service,/if\(latest&&latest\.effective_to==null\)await client\.query\('update working_calendars set effective_to=\$2::date-1 where id=\$1',[\s\S]*insert into working_calendars[\s\S]*await audit\(client,req,/,'an open prior calendar must close before insert and first calendar authoring must safely reach insert and audit without a prior row');
assert.doesNotMatch(service,/if\(latest\?\.effective_to==null\)/,'calendar authoring must not dereference an absent prior version');
assert.match(service,/router\.post\('\/calendars\/:calendarId\/holidays'[\s\S]*router\.put\('\/calendars\/:calendarId\/holidays\/:holidayId'[\s\S]*Retire Calendar Holiday/,'holidays must support governed create, update, and retirement');
assert.match(service,/CALENDAR_HOLIDAY_CONFLICT[\s\S]*Retire Calendar Holiday[\s\S]*oldValue:previous,newValue:/,'holiday conflicts and changes must be stable and audited with before/after values');
assert.match(service,/Active dependencies prevent calendar retirement[\s\S]*CALENDAR_IN_USE/,'active worker or holiday dependencies must block calendar retirement');

const validProfile = { name:'Synthetic Organization',legalName:'Synthetic Organization LLC',productDisplayName:'Synthetic Work',
  supportContact:'support@example.test',defaultLocale:'en-US',defaultTimeZone:'America/New_York',baseCurrency:'USD',
  fiscalYearStart:'04-01',defaultWeekStart:1,effectiveFrom:'2026-01-01' };
assert.equal(validateOrganizationProfile(validProfile).success,true,'the complete bounded organization profile must validate');
for (const invalid of [
  {defaultLocale:'not_a_locale'}, {defaultTimeZone:'Mars/Olympus'}, {baseCurrency:'usd'}, {fiscalYearStart:'02-31'},
  {defaultWeekStart:7}, {supportContact:'not a contact'},
]) assert.equal(validateOrganizationProfile({...validProfile,...invalid}).success,false,`${Object.keys(invalid)[0]} must fail stable validation`);
const validLegalEntity={code:'LEGAL-A',legalName:'Synthetic Legal Entity',reportingCurrency:'EUR',status:'Active',effectiveFrom:'2026-01-01',
  address:{line1:'1 Test Street',city:'Test City',countryCode:'US'}};
assert.equal(validateLegalEntity(validLegalEntity).success,true,'required legal-entity administration values must validate');
assert.equal(validateLegalEntity({...validLegalEntity,reportingCurrency:'EU'}).success,false,'reporting currency must use an ISO-style code');
assert.match(organizationProfileMigration,/organization_profile_versions[\s\S]*legal_name[\s\S]*product_display_name[\s\S]*support_contact[\s\S]*default_locale[\s\S]*default_time_zone[\s\S]*base_currency[\s\S]*fiscal_year_start[\s\S]*default_week_start/,'migration must persist every WOS-ORG-001 field');
assert.match(organizationProfileMigration,/legal_entity_profile_versions[\s\S]*registration_identifier[\s\S]*tax_identifier[\s\S]*reporting_currency[\s\S]*address/,'migration must persist every WOS-ORG-002 profile field');
assert.match(organizationProfileMigration,/organization_profile_versions_no_overlap[\s\S]*legal_entity_profile_versions_no_overlap/,'profile histories must be database non-overlapping');
assert.match(organizationProfileMigration,/uq_legal_entity_registration_identity[\s\S]*uq_legal_entity_tax_identity/,'current legal registration and tax identities must be scoped uniquely');
assert.match(service,/router\.put\('\/profile'[\s\S]*ORGANIZATION_PROFILE_VALIDATION_FAILED[\s\S]*Update Organization Profile/,'organization profile updates must validate, scope, and audit');
assert.match(service,/organizationId&&parsed\.data\.organizationId!==req\.organizationScope\.organizationId[\s\S]*ORG_SCOPE_DENIED/,'caller-supplied organization spoofing must fail closed');
assert.match(service,/router\.post\('\/legal-entities'[\s\S]*router\.put\('\/legal-entities\/:id'/,'legal entities must have governed create and update surfaces');
assert.match(service,/targetId&&targetId!==req\.organizationScope\.legalEntityId[\s\S]*Legal entity not found/,'same-organization cross-legal mutation must fail closed');
assert.match(service,/LEGAL_ENTITY_IN_USE[\s\S]*Update Legal Entity':'Create Legal Entity'[\s\S]*oldValue:/,'unsafe legal-entity deactivation must fail before audited mutation');
assert.match(service,/insert into user_organization_scopes\(user_id,organization_id,legal_entity_id,active\)/,'a creator must receive explicit persisted scope for a newly created legal entity');
assert.match(service,/join lateral \(select \* from organization_profile_versions[\s\S]*join lateral \(select \* from legal_entity_profile_versions/,'context must expose deterministic profile values without breaking existing identity fields');

const sessionSecretKey = ['API', 'SESSION', 'SECRET'].join('_');
const identitySecretKey = ['ENTRA', 'CLIENT', 'SECRET'].join('_');
const secureTestOrigin = ['https:/', '/setup.test'].join('');
const productionEnvironment = {
  NODE_ENV: 'production', APP_MODE: 'production', LOCAL_LOGIN_ENABLED: 'false',
  DATABASE_URL: 'postgresql://localhost/workos_test', APP_URL: secureTestOrigin,
  IDENTITY_PROVIDER: 'entra', ENTRA_TENANT_ID: 'synthetic-tenant', ENTRA_CLIENT_ID: 'synthetic-client',
  ENTRA_REDIRECT_URI: `${secureTestOrigin}/api/auth/entra/callback`,
  [sessionSecretKey]: 'synthetic-non-default-value', [identitySecretKey]: 'synthetic-value',
};
const completeSetupFacts = Object.fromEntries(REQUIRED_SETUP_CHECKS.map(key => [key, true]));
assert.equal(productionReadinessFromEnvironment(productionEnvironment), true, 'safe production controls must satisfy production readiness');
assert.equal(buildSetupReadiness(completeSetupFacts, productionEnvironment).ready, true, 'all server facts can make a synthetic scope ready');
for (const key of REQUIRED_SETUP_CHECKS) {
  const facts = { ...completeSetupFacts, [key]: false, ready: true, complete: true, completed: true, checks: completeSetupFacts };
  const environment = key === 'production_readiness' ? { ...productionEnvironment, ALLOW_TEST_FALLBACK: 'true' } : productionEnvironment;
  const readiness = buildSetupReadiness(facts, environment);
  assert.equal(readiness.checks[key], false, `${key} must fail closed independently`);
  assert.equal(readiness.ready, false, `${key} must keep overall readiness false`);
}
assert.equal(productionReadinessFromEnvironment({ ...productionEnvironment, NODE_ENV: 'test', ALLOW_TEST_FALLBACK: 'true' }), false, 'test fallback must never count as production readiness');
assert.equal(productionReadinessFromEnvironment({ ...productionEnvironment, [sessionSecretKey]: '' }), false, 'missing production controls must fail closed');
assert.equal(identityReadinessFromEnvironment({ ...productionEnvironment, ENTRA_TENANT_ID: '' }), false, 'missing production identity configuration must fail its own readiness area');
assert.deepEqual(Object.keys(buildSetupReadiness(completeSetupFacts, productionEnvironment).checks), REQUIRED_SETUP_CHECKS, 'readiness payload keys must remain stable and complete');
assert.match(service, /user_organization_scopes[\s\S]*where s\.organization_id=\$1 and s\.legal_entity_id=\$2/, 'user, role, and identity readiness evidence must remain in the selected organization/legal scope');
assert.match(service, /notification_preferences[\s\S]*e\.organization_id=\$1 and e\.legal_entity_id=\$2/, 'notification readiness evidence must remain in the selected organization/legal scope');
assert.match(service, /new_value->>'organization_id'=\$1 and a\.new_value->>'legal_entity_id'=\$2/, 'imports from another scope must not satisfy readiness');
assert.match(ui, /Object\.entries\(setupReadiness\.checks\)/, 'AdminSettings must dynamically expose every server readiness area');

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
  migrationOrder.indexOf('028_wos02_organization_legal_entity_profiles.sql') < migrationOrder.indexOf('029_wos02_working_calendar_authority.sql'),
  'calendar authority migration must append after the accepted WOS-02 profile migration',
);
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
assert.match(reportingPeriodMigration, /drop constraint if exists reporting_periods_status_check[\s\S]*status='Financially Locked' where status='Locked'/, 'legacy Locked periods must be deterministically reconciled before the new state constraint');
assert.match(reportingPeriodMigration, /Submission Closed[\s\S]*Approval Closed[\s\S]*Financially Locked/, 'reporting periods must persist distinct closure stages');
assert.match(reportingPeriodMigration, /reporting_period_ranges_no_overlap[\s\S]*exclude using gist[\s\S]*organization_id with =, legal_entity_id with =/, 'same-scope reporting-period ranges must be database non-overlapping while legal entities remain isolated');
assert.match(server, /api\/imports\/clients\/apply[\s\S]*from clients[\s\S]*organization_id = \$3 and legal_entity_id = \$4[\s\S]*insert into clients \(id, name, industry, account_owner_id, status, organization_id, legal_entity_id\)/, 'client import must resolve and persist authoritative ownership');
assert.match(server, /api\/clients[\s\S]*select \* from clients where id = \$1 and organization_id=\$2 and legal_entity_id=\$3 for update[\s\S]*select 1 from clients where id=\$1[\s\S]*Client not found in the authorized organization and legal entity/, 'direct client IDs must be authorized before any mutation');
assert.match(server, /api\/clients[\s\S]*select id from employees where id=\$1 and organization_id=\$2 and legal_entity_id=\$3 and status='Active'[\s\S]*Account owner must reference an active employee/, 'direct clients must validate an active same-scope account owner');
assert.match(server, /update projects set client_id = \$1, client = \$2, updated_at = now\(\) where organization_id=\$4 and legal_entity_id=\$5/, 'direct client project synchronization must remain in the authorized scope');
assert.match(server, /api\/imports\/employees\/apply[\s\S]*select \* from employees where employee_id = \$1 and organization_id = \$2 and legal_entity_id = \$3/, 'employee import prior-row reuse must be scoped');
assert.match(server, /workerExitDependencies[\s\S]*WORKER_DEPENDENCY_CONFLICT[\s\S]*synchronizeWorkerExit[\s\S]*insert into worker_history[\s\S]*disableLinkedWorkerIdentity/, 'canonical terminal changes must share dependency-safe lifecycle and identity synchronization');
assert.match(server, /employee\.status === 'Exited'[\s\S]*worker_history[\s\S]*status='Exited'[\s\S]*for update[\s\S]*authoritativeExitDate[\s\S]*effectiveFrom != null[\s\S]*WORKER_VERSION_CONFLICT[\s\S]*return authoritativeExitDate/, 'already-exited workers must preserve the locked authoritative terminal date while allowing same-date or omitted-date replay');
assert.match(server, /api\/employees[\s\S]*assertWorkerMayExit[\s\S]*initializeNewWorkerLifecycle[\s\S]*active=excluded\.active[\s\S]*synchronizeWorkerExit/, 'direct existing employee exits must validate before mutation and converge lifecycle and scope state');
assert.match(server, /let effectiveExitDate = parsed\.data\.exit_date[\s\S]*previous\.status === 'Exited' \? parsed\.data\.exit_date[\s\S]*effectiveExitDate \|\| null/, 'direct already-exited replay must compare explicit dates and preserve authoritative dates when omitted');
assert.match(server, /api\/imports\/employees\/apply[\s\S]*assertWorkerMayExit[\s\S]*errors\.push\(\{ rowNumber, field: 'status'[\s\S]*active=excluded\.active[\s\S]*synchronizeWorkerExit/, 'employee import exits must retain row-level errors and use the canonical lifecycle synchronization');
assert.match(server, /let effectiveExitDate = row\.exitDate[\s\S]*previous\.status === 'Exited' \? row\.exitDate[\s\S]*code: error\.code[\s\S]*continue;[\s\S]*effectiveExitDate \|\| previous\?\.exit_date/, 'employee import must preserve same-date or omitted terminal authority and keep different-date conflicts row-local');
assert.match(server, /app\.delete\('\/api\/employees\/:id'[\s\S]*assertWorkerMayExit[\s\S]*synchronizeWorkerExit[\s\S]*Deactivate Employee/, 'DELETE employee must preserve dependency denial and synchronize terminal lifecycle atomically');
assert.match(server, /api\/projects[\s\S]*select \* from projects where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update[\s\S]*Project not found in the authorized organization and legal entity/, 'project ID updates must deny cross-scope rows before upsert');
assert.match(server, /api\/imports\/projects\/apply[\s\S]*from clients[\s\S]*organization_id=\$3 and legal_entity_id=\$4[\s\S]*from employees[\s\S]*organization_id=\$2 and legal_entity_id=\$3/, 'project imports must resolve clients and managers in the exact request scope');
assert.match(server, /select \* from projects where project_code=\$1 and organization_id=\$2 and legal_entity_id=\$3[\s\S]*legal_entity_id<>\$3[\s\S]*PROJECT_SCOPE_CONFLICT/, 'project imports must not adopt foreign primary keys and must reject same-organization cross-legal code collisions');
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
assert.match(service, /reporting-period:\$\{req\.organizationScope\.organizationId\}:\$\{req\.organizationScope\.legalEntityId\}[\s\S]*for update[\s\S]*REPORTING_PERIOD_OVERLAP/, 'reporting-period authoring must serialize and reject overlapping same-scope authority');
assert.match(service, /Submission Closed','Approval Closed','Financially Locked','Closed'[\s\S]*REPORTING_PERIOD_IMMUTABLE/, 'closed reporting-period identity and boundaries must not be rewritten');
assert.match(service, /Update Reporting Period':'Create Reporting Period'[\s\S]*oldValue:previous,newValue:result\.rows\[0\]/, 'reporting-period mutations must audit material before and after values in their transaction');
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
assert.match(server, /api\/timesheets[\s\S]*REPORTING_PERIOD_OPERATIONS\.CONTENT[\s\S]*api\/timesheets\/:id\/status[\s\S]*REPORTING_PERIOD_OPERATIONS\.DECISION/, 'canonical save and direct decision paths must use the shared reporting-period guard');
assert.match(server, /api\/approvals\/:id\/status[\s\S]*approval\.entity_type === 'Timesheet'[\s\S]*REPORTING_PERIOD_OPERATIONS\.DECISION/, 'generic timesheet approval decisions must use the shared reporting-period guard');
assert.match(server, /api\/approvals\/:id\/status[\s\S]*select \* from approval_records where id = \$1 for update/, 'generic approval decisions must lock the authoritative approval row directly');
assert.doesNotMatch(server, /approvalSelect} where ar\.id = \$1 for update/, 'generic approval locking must not apply FOR UPDATE to the nullable side of an outer join');
assert.match(server, /select e\.name as subject_employee_name[\s\S]*buildApprovalScopeWhere\(req, scopeParams\)/, 'generic approval scope and display data must be derived separately after locking');
assert.match(server, /approval\.entity_type === 'Timesheet'[\s\S]*timesheets where id=\$1 and organization_id=\$2 and legal_entity_id=\$3 for update[\s\S]*REPORTING_PERIOD_OPERATIONS\.DECISION/, 'generic timesheet approval must retain linked row scope, locking, and reporting-period authority');
assert.match(server, /approval\.entity_type === 'LeaveRequest'[\s\S]*leave_requests where id = \$1 for update[\s\S]*decideApprovalRecord/, 'non-timesheet generic approval behavior must remain retained');
assert.match(server, /api\/imports\/timesheets\/apply[\s\S]*REPORTING_PERIOD_OPERATIONS\.CONTENT/, 'all timesheet import statuses must use the shared content-mutation guard');

const periodQuery = status => ({ query: async () => ({ rows: status === null ? [] : Array.isArray(status) ? status : [{ id:'period-1', code:'P1', status }] }) });
for (const state of ['Planned','Submission Closed','Approval Closed','Financially Locked','Closed']) {
  await assert.rejects(assertReportingPeriodAllows(periodQuery(state), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }),
    error => error instanceof ReportingPeriodError && error.code === 'REPORTING_PERIOD_CLOSED', `${state} must block timesheet content mutation`);
}
await assert.doesNotReject(assertReportingPeriodAllows(periodQuery('Open'), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }));
await assert.doesNotReject(assertReportingPeriodAllows(periodQuery('Submission Closed'), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.DECISION }));
for (const state of ['Planned','Approval Closed','Financially Locked','Closed']) {
  await assert.rejects(assertReportingPeriodAllows(periodQuery(state), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.DECISION }),
    error => error.code === 'REPORTING_PERIOD_CLOSED', `${state} must block timesheet decisions`);
}
await assert.rejects(assertReportingPeriodAllows(periodQuery(null), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }), error => error.code === 'REPORTING_PERIOD_MISSING');
await assert.rejects(assertReportingPeriodAllows(periodQuery([{status:'Open'},{status:'Open'}]), { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }), error => error.code === 'REPORTING_PERIOD_AMBIGUOUS');
assert.equal(canTransitionReportingPeriod('Open','Submission Closed'),true);
assert.equal(canTransitionReportingPeriod('Approval Closed','Open'),false, 'closed approval authority must not silently reopen');

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
