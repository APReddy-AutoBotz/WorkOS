import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { disableLinkedWorkerIdentity, initializeNewWorkerLifecycle, synchronizeWorkerReactivation } from '../server/worker-lifecycle.mjs';
import { assertReportingPeriodAllows, canTransitionReportingPeriod, normalizeReportingDate, REPORTING_PERIOD_OPERATIONS, ReportingPeriodError } from '../server/reporting-periods.mjs';
import { buildSetupReadiness, identityReadinessFromEnvironment, productionReadinessFromEnvironment, REQUIRED_SETUP_CHECKS } from '../server/setup-readiness.mjs';
import { normalizePersistedTerminology, validateLegalEntity, validateOrganizationProfile, validateTerminology } from '../server/organization-setup.mjs';
import { calendarScopeValues, validateWorkingCalendar, validateWorkingCalendarHoliday } from '../server/working-calendars.mjs';

const migration = readFileSync('server/migrations/022_organization_setup_foundation.sql', 'utf8');
const integrityMigration = readFileSync('server/migrations/023_wos02_scope_lifecycle_integrity.sql', 'utf8');
const closureMigration = readFileSync('server/migrations/024_wos02_final_review_closure.sql', 'utf8');
const timesheetScopeMigration = readFileSync('server/migrations/025_wos02_timesheet_scope_integrity.sql', 'utf8');
const projectLegalScopePrerequisite = readFileSync('server/migrations/025a_wos02_project_legal_scope_unique_prerequisite.sql', 'utf8');
const canonicalScopeMigration = readFileSync('server/migrations/026_wos02_canonical_legal_scope_integrity.sql', 'utf8');
const reportingPeriodMigration = readFileSync('server/migrations/027_wos02_reporting_period_authority.sql', 'utf8');
const reportingPeriodFrequencyMigration = readFileSync('server/migrations/030_wos02_reporting_period_frequency.sql', 'utf8');
const organizationProfileMigration = readFileSync('server/migrations/028_wos02_organization_legal_entity_profiles.sql', 'utf8');
const calendarAuthorityMigration = readFileSync('server/migrations/029_wos02_working_calendar_authority.sql', 'utf8');
const legalEntityAuthorityMigration = readFileSync('server/migrations/031_wos02_legal_entity_effective_authority.sql', 'utf8');
const service = readFileSync('server/organization-setup.mjs', 'utf8');
const workerLifecycle = readFileSync('server/worker-lifecycle.mjs', 'utf8');
const terminologyKeys = ['employee','manager','teamLead','businessUnit','region','regionalOwner','engagement','project','worklog'];
const terminologyTerms = Object.fromEntries(terminologyKeys.map(key => [key,{singular:key,plural:`${key}s`,helpText:''}]));
assert(validateTerminology({terms:terminologyTerms,effectiveFrom:'2026-01-01'}).success);
for (const invalidTerms of [
  {...terminologyTerms,employee:'person'},
  Object.fromEntries(Object.entries(terminologyTerms).slice(1)),
  {...terminologyTerms,unknown:{singular:'x',plural:'xs',helpText:''}},
  {...terminologyTerms,employee:{singular:'',plural:'people',helpText:''}},
  {...terminologyTerms,employee:{singular:'x'.repeat(101),plural:'people',helpText:''}},
  {...terminologyTerms,employee:{singular:'person',plural:'x'.repeat(101),helpText:''}},
  {...terminologyTerms,employee:{singular:'person',plural:'people',helpText:'x'.repeat(501)}},
]) assert(!validateTerminology({terms:invalidTerms,effectiveFrom:'2026-01-01'}).success, 'invalid terminology must fail closed');
assert.deepEqual(normalizePersistedTerminology({employee:'person'}).employee,{singular:'person',plural:'persons',helpText:''});
const server = readFileSync('server/index.mjs', 'utf8');
const ui = readFileSync('src/pages/AdminSettings.tsx', 'utf8');
const api = readFileSync('src/services/api.ts', 'utf8');
const runtimeTerminology = readFileSync('src/config/RuntimeTerminology.tsx', 'utf8');
const apiClient = readFileSync('src/services/apiClient.ts', 'utf8');
const productConfig = readFileSync('src/config/productConfig.ts', 'utf8');

const routeSource = (start, end) => {
  const startIndex = server.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} route must exist`);
  const endIndex = server.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${start} route must have a stable boundary`);
  return server.slice(startIndex, endIndex);
};
const passwordResetRoute = routeSource("app.post('/api/users/:id/password-reset'", "app.get('/api/employees'");
assert.match(passwordResetRoute, /join employees e on e\.id = u\.employee_record_id[\s\S]*e\.organization_id = \$2 and e\.legal_entity_id = \$3[\s\S]*for update/, 'password reset must lock only an identity in the exact selected scope');
assert.match(passwordResetRoute, /update users u[\s\S]*from employees e[\s\S]*e\.organization_id = \$4 and e\.legal_entity_id = \$5[\s\S]*await audit/, 'password reset write and audit must remain behind the exact scope predicate');

const projectStatusRoute = routeSource("app.patch('/api/projects/:id/status'", "app.get('/api/clients'");
assert.match(projectStatusRoute, /select \* from projects where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update/, 'project status target lookup must fail closed across organization or legal entity');
assert.match(projectStatusRoute, /where id = \$1 and organization_id = \$3 and legal_entity_id = \$4[\s\S]*where project_id = \$1 and organization_id = \$2 and legal_entity_id = \$3/, 'project and allocation status writes must remain in the exact selected scope');

const clientDeactivateRoute = routeSource("app.delete('/api/clients/:id'", "app.get('/api/allocations'");
assert.match(clientDeactivateRoute, /select \* from clients where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update/, 'client deactivation target lookup must fail closed across organization or legal entity');
assert.match(clientDeactivateRoute, /projects[\s\S]*client_id = \$1 and organization_id = \$2 and legal_entity_id = \$3[\s\S]*update clients[\s\S]*where id = \$1 and organization_id = \$2 and legal_entity_id = \$3/, 'client dependency checks and deactivation must share the exact selected scope');

const identityLinkRoutes = routeSource("app.get('/api/integrations/identity-links'", "app.get('/api/integrations/entra-role-mappings'");
assert.match(identityLinkRoutes, /where e\.organization_id = \$1 and e\.legal_entity_id = \$2/, 'identity-link reads must disclose only the selected scope');
assert.match(identityLinkRoutes, /select id from employees where id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update[\s\S]*select ipl\.\*[\s\S]*e\.organization_id = \$3 and e\.legal_entity_id = \$4/, 'identity-link targets and existing links must be authorized through exact employee ownership');
assert.match(identityLinkRoutes, /update employees set entra_object_id[\s\S]*organization_id = \$3 and legal_entity_id = \$4[\s\S]*await logIntegrationEvent[\s\S]*await audit/, 'identity metadata, integration evidence, and audit must follow the exact scoped mutation');

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
assert.match(legalEntityAuthorityMigration,/add column if not exists country_code[\s\S]*add column if not exists status[\s\S]*add column if not exists authority_effective_to/,'migration 031 must persist effective-dated legal-entity display and lifecycle authority');
assert.match(legalEntityAuthorityMigration,/update legal_entity_profile_versions p[\s\S]*from legal_entities le[\s\S]*alter column country_code set not null[\s\S]*alter column status set not null/,'existing legal-entity profiles must upgrade deterministically without losing base authority');
assert.match(service,/join legal_entity_profile_versions lp[\s\S]*lp\.status='Active'[\s\S]*coalesce\(lp\.authority_effective_to,'infinity'::date\)/,'scope authorization must resolve current effective profile authority rather than future base-table facts');
assert.match(service,/lp\.legal_name legal_entity_name,lp\.status legal_entity_status[\s\S]*lp\.authority_effective_to legal_entity_effective_to/,'context must expose only the selected as-of legal-entity version');
assert.match(service,/select le\.id,le\.organization_id,le\.code,p\.legal_name name,p\.country_code,p\.status[\s\S]*p\.authority_effective_to effective_to/,'legal-entity reads must resolve profile, country, status, and lifecycle end as of the requested date');
assert.match(service,/LEGAL_ENTITY_CODE_IMMUTABLE[\s\S]*select \* from legal_entity_profile_versions[\s\S]*LEGAL_ENTITY_VERSION_CONFLICT[\s\S]*with changed as \(update legal_entities set[\s\S]*where id=\$1 and \$6::date<=current_date/,'stale legal-entity versions must fail before mutation and future versions must not rewrite the base projection');
assert.match(service,/insert into legal_entity_profile_versions\(legal_entity_id,organization_id,legal_name,country_code,status,authority_effective_to[\s\S]*on conflict\(legal_entity_id,effective_from\) do update/,'same-date legal-entity replay must update one effective-dated authority version deterministically');
assert.match(service,/exists\(select 1 from legal_entities le join legal_entity_profile_versions lp[\s\S]*lp\.status='Active'[\s\S]*lp\.authority_effective_to/,'setup readiness must use current-effective legal-entity lifecycle authority');

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
assert.match(reportingPeriodFrequencyMigration, /frequency text[\s\S]*set frequency='Weekly'[\s\S]*Weekly','Monthly','Fiscal/, 'existing periods must receive deterministic validated Weekly frequency authority');
assert.match(reportingPeriodFrequencyMigration, /drop constraint if exists reporting_period_ranges_no_overlap[\s\S]*frequency with =[\s\S]*daterange/, 'period overlap authority must be isolated by frequency');
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
const employeeSaveRoute = routeSource("app.post('/api/employees'", "app.delete('/api/employees/:id'");
const employeeImportRoute = routeSource("app.post('/api/imports/employees/apply'", "app.post('/api/imports/clients/apply'");
const employeeDeleteRoute = routeSource("app.delete('/api/employees/:id'", "app.get('/api/projects'");
assert.match(employeeSaveRoute, /previous\?\.status === 'Exited' && employee\.status !== 'Exited'[\s\S]*await synchronizeWorkerReactivation/, 'direct employee reactivation must synchronize canonical history, profile, and login');
assert.match(employeeImportRoute, /previous\?\.status === 'Exited' && employee\.status !== 'Exited'[\s\S]*await synchronizeWorkerReactivation/, 'employee-import reactivation must synchronize canonical history, profile, and login');
assert.match(employeeSaveRoute, /previous\?\.status === 'Exited' && parsed\.data\.status !== 'Exited'\) effectiveExitDate = null/, 'direct reactivation must not retain an exited-only current exit date');
assert.match(employeeImportRoute, /previous\?\.status === 'Exited' && targetStatus !== 'Exited'[\s\S]*\? null[\s\S]*effectiveExitDate \|\| previous\?\.exit_date/, 'employee-import reactivation must not retain an exited-only current exit date');
assert.match(employeeSaveRoute, /pg_advisory_xact_lock\(hashtext\(\$1\)\)[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{parsed\.data\.employee_id\}[\s\S]*select \* from employees where employee_id = \$1 and organization_id = \$2 and legal_entity_id = \$3 for update/, 'employee save must serialize the organization-scoped unique key and re-read locked employee state');
assert.match(employeeImportRoute, /pg_advisory_xact_lock\(hashtext\(\$1\)\)[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{row\.employeeId\}[\s\S]*select \* from employees where employee_id = \$1 and organization_id = \$2 and legal_entity_id = \$3 limit 1 for update/, 'employee import must serialize the organization-scoped unique key and re-read locked employee state');
assert.match(employeeDeleteRoute, /select employee_id from employees[\s\S]*pg_advisory_xact_lock[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{employeeKey\.employee_id\}[\s\S]*select \* from employees where id=\$1 and organization_id=\$2 and legal_entity_id=\$3 for update/, 'employee deactivation must share the lifecycle lock before its locked status read');
assert.match(service, /const employeeKey=\(await client\.query[\s\S]*select employee_id from employees[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{employeeKey\.employee_id\}[\s\S]*select e\.\*,wp\.lifecycle_status[\s\S]*for update/, 'canonical worker transitions must share the organization-scoped employee-code lock before their locked status read');
assert.match(employeeSaveRoute, /legal_entity_id is distinct from \$3[\s\S]*EMPLOYEE_SCOPE_CONFLICT/, 'employee save must fail with a stable conflict when its organization-scoped code belongs to another legal entity');
assert.match(employeeImportRoute, /legal_entity_id is distinct from \$3[\s\S]*EMPLOYEE_SCOPE_CONFLICT[\s\S]*continue/, 'employee import must report a cross-legal code collision as a row error');
assert.match(employeeImportRoute, /const reactivationSavepoint = previous\?\.status === 'Exited' && targetStatus !== 'Exited'[\s\S]*savepoint \$\{reactivationSavepoint\}[\s\S]*const employeeResult/, 'employee import must savepoint a reactivation row before its first write');
assert.match(employeeImportRoute, /rollback to savepoint \$\{reactivationSavepoint\}[\s\S]*release savepoint \$\{reactivationSavepoint\}[\s\S]*errors\.push\(\{ rowNumber, field: 'status'[\s\S]*continue;/, 'a rejected reactivation must roll back only its import row and continue with valid rows');
for (const [name, route] of [['direct employee save', employeeSaveRoute], ['employee import', employeeImportRoute]]) {
  const begin = route.indexOf("await client.query('begin')");
  const scopeWrite = route.indexOf('insert into user_organization_scopes');
  const lifecycleWrite = route.indexOf('await synchronizeWorkerReactivation');
  const auditWrite = route.indexOf('await audit');
  const commit = route.indexOf("await client.query('commit')");
  assert.ok(begin >= 0 && scopeWrite > begin && lifecycleWrite > scopeWrite && auditWrite > lifecycleWrite && commit > auditWrite,
    `${name} must keep employee, identity scope, lifecycle history/profile, and audit in one transaction`);
  assert.match(route, /catch \(error\)[\s\S]*await client\.query\('rollback'\)/, `${name} must roll back the whole operation if reactivation synchronization fails`);
}
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
assert.match(service, /terminologyTermsSchema[\s\S]*\.strict\(\)/, 'terminology writes must require the complete structured key contract');
assert.match(service, /singular:z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)[\s\S]*plural:z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)[\s\S]*helpText:z\.string\(\)\.trim\(\)\.max\(500\)/, 'terminology labels and help text must be bounded');
assert.match(service, /normalizeTerminologyTerms[\s\S]*legacyPluralize\(singular\)[\s\S]*helpText:''/, 'legacy persisted scalar rows must preserve scalar-derived plural behavior');
assert.match(service, /terminology:\$\{req\.organizationScope\.organizationId\}[\s\S]*for update[\s\S]*TERMINOLOGY_VERSION_CONFLICT/, 'terminology mutation must serialize and reject stale versions');
assert.match(service, /Update Terminology':'Version Terminology'[\s\S]*oldValue:exact\|\|null,newValue:result\.rows\[0\]/, 'terminology audit must contain material before and after values');
assert.match(service, /created_by=\$4[\s\S]*req\.user\.sub/, 'same-effective terminology updates must record the current actor');
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

const periodQuery = status => ({ query: async (_sql, params) => ({ rows: status === null ? [] : (Array.isArray(status) ? status : [{ id:'period-1', code:'P1', status }]).map((period, index) => ({
  id:`period-${index}`,code:'P1',frequency:'Weekly',relevant_date:params[2][0],...period,
})) }) });
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
const multiFrequency = periodQuery([
  { status:'Open', frequency:'Weekly' },
  { status:'Financially Locked', frequency:'Monthly' },
  { status:'Open', frequency:'Fiscal' },
]);
await assert.rejects(assertReportingPeriodAllows(multiFrequency, { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-01-07',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }), error => error.code === 'REPORTING_PERIOD_CLOSED', 'an Open Weekly period must not bypass an applicable Monthly lock');
let lockedQuery = '';
await assert.doesNotReject(assertReportingPeriodAllows({ query: async (sql, params) => {
  lockedQuery = sql;
  return { rows: params[2].map(date => ({ id:`weekly-${date}`,code:'W',frequency:'Weekly',status:'Open',relevant_date:date })) };
} }, { organizationId:'org-a',legalEntityId:'legal-a',relevantDates:['2026-01-01','2026-01-07'],operation:REPORTING_PERIOD_OPERATIONS.CONTENT }));
assert.match(lockedQuery, /join reporting_periods p[\s\S]*for share of p/, 'every matched reporting authority row must be locked in the caller transaction');
assert.equal(normalizeReportingDate(new Date('2026-08-30T23:59:59.999Z')), '2026-08-30', 'database Date values must normalize to their UTC date');
assert.equal(normalizeReportingDate('2026-08-30'), '2026-08-30', 'canonical date strings must retain exact semantics');
for (const invalidDate of [new Date(Number.NaN), '2026-02-29', '2026-8-30', 'not-a-date']) {
  assert.throws(() => normalizeReportingDate(invalidDate), error => error.code === 'REPORTING_PERIOD_INVALID_DATE');
}
let normalizedDates;
await assert.doesNotReject(assertReportingPeriodAllows({ query: async (_sql, params) => {
  normalizedDates = params[2];
  return { rows: [{ id:'weekly-1',code:'W',frequency:'Weekly',status:'Open',relevant_date:'2026-08-30' }] };
} }, { organizationId:'org-a',legalEntityId:'legal-a',relevantDates:[new Date('2026-08-30T00:00:00Z'),'2026-08-30'],operation:REPORTING_PERIOD_OPERATIONS.CONTENT }));
assert.deepEqual(normalizedDates, ['2026-08-30'], 'equivalent Date and string values must deduplicate before query binding');
let invalidQueryReached = false;
await assert.rejects(assertReportingPeriodAllows({ query: async () => { invalidQueryReached = true; return { rows: [] }; } }, { organizationId:'org-a',legalEntityId:'legal-a',relevantDate:'2026-02-30',operation:REPORTING_PERIOD_OPERATIONS.CONTENT }), error => error.code === 'REPORTING_PERIOD_INVALID_DATE');
assert.equal(invalidQueryReached, false, 'invalid reporting dates must fail before database access');
const boundedDates = Array.from({length:101}, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
await assert.doesNotReject(assertReportingPeriodAllows({ query: async (_sql, params) => ({ rows: params[2].map(date => ({ id:`weekly-${date}`,code:'W',frequency:'Weekly',status:'Open',relevant_date:date })) }) }, { organizationId:'org-a',legalEntityId:'legal-a',relevantDates:boundedDates.slice(0,100),operation:REPORTING_PERIOD_OPERATIONS.CONTENT }));
await assert.rejects(assertReportingPeriodAllows(periodQuery('Open'), { organizationId:'org-a',legalEntityId:'legal-a',relevantDates:boundedDates,operation:REPORTING_PERIOD_OPERATIONS.CONTENT }), error => error.code === 'REPORTING_PERIOD_DATE_LIMIT');
assert.match(server, /relevantDates: \[parsed\.data\.week_ending, \.\.\.parsed\.data\.entries\.map\(entry => entry\.work_date\)\]/, 'direct timesheets must validate every unique entry date with the week ending');
assert.match(server, /relevantDates: \[group\.weekEnding, \.\.\.group\.entries\.map\(entry => entry\.workDate\)\][\s\S]*error instanceof ReportingPeriodError[\s\S]*continue/, 'imports must skip blocked groups while preserving partial processing');
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
assert.match(server, /employee:\$\{req\.organizationScope\.organizationId\}:\$\{parsed\.data\.employee_id\}[\s\S]*isNew: !previous/, 'canonical employee save must serialize organization-scoped new-record detection before worker initialization');
assert.match(server, /api\/imports\/employees\/apply[\s\S]*employee:\$\{req\.organizationScope\.organizationId\}:\$\{row\.employeeId\}[\s\S]*isNew: !previous/, 'employee import must serialize organization-scoped new-record detection before worker initialization');
assert.match(workerLifecycle, /select e\.id, \$2, \$3, \$4::date, \$5::text,[\s\S]*jsonb_build_object\('status', \$5::text, 'reason', \$6::text, 'source', \$7::text, 'previousStatus', \$8::text[\s\S]*e\.status=\$5::text/, 'reactivation insert parameters used by polymorphic JSON and INSERT SELECT must have explicit PostgreSQL types');

const makeReactivationClient = ({
  lifecycleStatus = 'Exited',
  effectiveFrom = '2026-09-01',
  profileEffectiveFrom = effectiveFrom,
  historyStatus = lifecycleStatus,
  historyEffectiveFrom = effectiveFrom,
  historyEffectiveTo = null,
  profileMissing = false,
  historyMissing = false,
  scopeRowCount = 1,
} = {}) => {
  const queries = [];
  return {
    queries,
    client: { query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('select lifecycle_status, effective_from')) {
        return profileMissing ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ lifecycle_status: lifecycleStatus, effective_from: profileEffectiveFrom }] };
      }
      if (sql.includes('select status, effective_from, effective_to')) {
        return historyMissing ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ status: historyStatus, effective_from: historyEffectiveFrom, effective_to: historyEffectiveTo }] };
      }
      if (sql.includes('update user_organization_scopes')) return { rowCount: scopeRowCount, rows: [] };
      if (sql.includes('update users')) return { rowCount: 1, rows: [{ id: 'user-a' }] };
      return { rowCount: 1, rows: [{ employee_id: workerInput.employeeId }] };
    } },
  };
};
for (const [previousStatus, nextStatus] of [['Exited', 'Active'], ['Disabled', 'On Leave']]) {
  const { client: reactivationClient, queries: reactivationQueries } = makeReactivationClient({ lifecycleStatus: previousStatus });
  assert.equal(await synchronizeWorkerReactivation(reactivationClient, {
    ...workerInput,
    effectiveFrom: '2026-10-03',
    status: nextStatus,
    reason: 'Reactivation regression test',
    source: 'Employee save',
  }), true);
  assert.equal(reactivationQueries.length, 7, 'reactivation must close history, append a version, update profile, and restore identity/scope');
  assert.match(reactivationQueries[0].sql, /worker_profiles[\s\S]*for update/);
  assert.match(reactivationQueries[1].sql, /worker_history[\s\S]*for update/);
  assert.deepEqual(reactivationQueries[2].params, [workerInput.employeeId, workerInput.organizationId, workerInput.legalEntityId, '2026-10-03', '2026-09-01', previousStatus]);
  assert.match(reactivationQueries[2].sql, /set effective_to=\$4::date - 1[\s\S]*effective_to is null/);
  assert.deepEqual(reactivationQueries[3].params, [workerInput.employeeId, workerInput.organizationId, workerInput.legalEntityId, '2026-10-03', nextStatus, 'Reactivation regression test', 'Employee save', previousStatus, workerInput.actorId]);
  assert.match(reactivationQueries[3].sql, /jsonb_build_object[\s\S]*to_jsonb\(e\)/);
  assert.equal(reactivationQueries[4].params[3], nextStatus, 'the profile must converge to the reactivated status');
  assert.match(reactivationQueries[5].sql, /update users set status='Active'[\s\S]*employee_record_id=\$1/);
  assert.match(reactivationQueries[6].sql, /update user_organization_scopes set active=true[\s\S]*organization_id=\$2 and legal_entity_id=\$3/);
}

const sameDayReactivation = makeReactivationClient({ effectiveFrom: '2026-10-03' });
await assert.rejects(synchronizeWorkerReactivation(sameDayReactivation.client, {
  ...workerInput,
  effectiveFrom: '2026-10-03',
  status: 'Active',
  reason: 'Same-day reactivation',
  source: 'Employee save',
}), error => error.code === 'WORKER_VERSION_CONFLICT', 'same-day reactivation must fail closed instead of overlapping lifecycle history');
assert.equal(sameDayReactivation.queries.length, 2, 'a lifecycle conflict must be detected before any history/profile/identity write');

for (const [label, options] of [
  ['missing profile', { profileMissing: true }],
  ['missing history', { historyMissing: true }],
  ['mismatched profile/history status', { historyStatus: 'Active' }],
  ['mismatched profile/history date', { profileEffectiveFrom: '2026-08-31' }],
  ['closed terminal history', { historyEffectiveTo: '2026-09-02' }],
]) {
  const invalidReactivation = makeReactivationClient(options);
  await assert.rejects(synchronizeWorkerReactivation(invalidReactivation.client, {
    ...workerInput,
    effectiveFrom: '2026-10-03',
    status: 'Active',
    reason: `Reject ${label}`,
    source: 'Employee save',
  }), error => error.code === 'WORKER_VERSION_CONFLICT', `${label} must fail closed`);
  assert.equal(invalidReactivation.queries.length, 2, `${label} must be rejected before writes`);
}

const scopeMismatchReactivation = makeReactivationClient({ scopeRowCount: 0 });
await assert.rejects(synchronizeWorkerReactivation(scopeMismatchReactivation.client, {
  ...workerInput,
  effectiveFrom: '2026-10-03',
  status: 'Active',
  reason: 'Identity mismatch reactivation',
  source: 'Employee import',
}), error => error.code === 'WORKER_IDENTITY_SYNC_CONFLICT', 'identity scope mismatch must abort the enclosing reactivation transaction');

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
