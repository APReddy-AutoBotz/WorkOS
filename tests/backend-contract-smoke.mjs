import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync('server/index.mjs', 'utf8');
const projectSaveRoute = server.slice(
  server.indexOf("app.post('/api/projects'"),
  server.indexOf("app.patch('/api/projects/:id/status'"),
);
const employeeImportRoute = server.slice(
  server.indexOf("app.post(['/api/imports/employees/apply', '/api/v1/imports/employees/apply']"),
  server.indexOf("app.post(['/api/imports/clients/apply'"),
);
const clientImportRoute = server.slice(
  server.indexOf("app.post(['/api/imports/clients/apply'"),
  server.indexOf("app.post('/api/imports/allocations/apply'"),
);
const projectImportRouter = readFileSync('server/modules/imports/project-import-router.mjs', 'utf8');
const operationalImportRouter = readFileSync('server/modules/imports/operational-import-router.mjs', 'utf8');
const notificationRouter = readFileSync('server/modules/notifications/notification-router.mjs', 'utf8');
const leaveRouter = readFileSync('server/modules/leave/leave-router.mjs', 'utf8');
const availabilityReportRouter = readFileSync('server/modules/reports/availability-report-router.mjs', 'utf8');
const importIdempotency = readFileSync('server/modules/imports/idempotency.mjs', 'utf8');
const importOperationMigration = readFileSync('server/migrations/039_wos03_import_operation_contract.sql', 'utf8');
const allocationImportRoute = operationalImportRouter.slice(
  operationalImportRouter.indexOf("router.post('/imports/allocations/apply'"),
  operationalImportRouter.indexOf("router.post('/imports/timesheets/apply'"),
);
const timesheetImportRoute = operationalImportRouter.slice(
  operationalImportRouter.indexOf("router.post('/imports/timesheets/apply'"),
  operationalImportRouter.indexOf('return router;'),
);
const identityMiddleware = readFileSync('server/modules/identity-access/middleware.mjs', 'utf8');
const identityReadRoutes = readFileSync('server/modules/identity-access/read-router.mjs', 'utf8');
const requestContext = readFileSync('server/api/request-context.mjs', 'utf8');
const versionedErrors = readFileSync('server/api/v1/error-contract.mjs', 'utf8');
const auditRecord = readFileSync('server/modules/audit/audit-record.mjs', 'utf8');
const auditHistoryRouter = readFileSync('server/modules/audit/audit-history-router.mjs', 'utf8');
const importHistoryRouter = readFileSync('server/modules/imports/import-history-router.mjs', 'utf8');
const integrationHistoryRouter = readFileSync('server/modules/integrations/integration-history-router.mjs', 'utf8');
const schema = readFileSync('server/schema.sql', 'utf8');
const leaveMigration = readFileSync('server/migrations/007_workforce_os_leave.sql', 'utf8');
const approvalMigration = readFileSync('server/migrations/008_workforce_os_approvals.sql', 'utf8');
const notificationMigration = readFileSync('server/migrations/009_workforce_os_notifications.sql', 'utf8');
const integrationMigration = readFileSync('server/migrations/010_workforce_os_integrations.sql', 'utf8');
const scopedHistoryMigration = readFileSync('server/migrations/035_wos03_scoped_history.sql', 'utf8');
const seedDemo = readFileSync('server/seed-demo.mjs', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

assert.match(schema, /create table if not exists catalog_items/, 'catalog_items table must exist');
assert.match(schema, /catalog_type text not null check/, 'catalog type guard must exist');
assert.match(schema, /idx_catalog_items_type_active/, 'catalog lookup index must exist');

assert.match(server, /app\.get\('\/api\/catalogs\/:catalogType'/, 'catalog GET route must exist');
assert.match(server, /app\.post\('\/api\/catalogs\/:catalogType'/, 'catalog POST route must exist');
assert.match(server, /app\.delete\('\/api\/catalogs\/:catalogType\/:id'/, 'catalog DELETE route must exist');
assert.match(server, /getCatalogUsage/, 'catalog delete usage guard must exist');

assert.match(server, /loginRateLimit/, 'login rate limiter must exist');
assert.match(server, /getPasswordMinLength/, 'password policy helper must exist');
assert.match(server, /getSessionTtlMs/, 'session TTL helper must exist');
assert.match(server, /API_SESSION_TTL_HOURS/, 'session TTL must be configurable through environment');
assert.match(server, /maxAge: getSessionTtlMs\(\)/, 'session cookie must use configured maxAge');
assert.doesNotMatch(server, /Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000/, 'session expiry must not be hardcoded at token issuance');
assert.match(server, /sessionExpiresAt/, 'login and role switching must expose session expiry metadata');
assert.match(server, /app\.use\('\/api\/auth', createIdentityReadRouter\(/, 'legacy auth read routes must remain mounted through the shared identity router');
assert.match(server, /app\.use\('\/api\/v1\/auth', createIdentityReadRouter\(/, 'versioned auth routes must reuse the shared identity router');
assert.match(identityReadRoutes, /router\.get\('\/me', requireDatabase, requireIdentity, refreshSession\)/, 'auth/me must refresh identity before an organization scope is selected');
assert.match(server, /app\.get\('\/api\/employees', requireDatabase, requireAuth, requirePermission/, 'protected employee data must still require an explicit resolved scope');
assert.match(server, /const refreshIdentitySession = async[\s\S]*getEffectivePermissionsForUser[\s\S]*res\.cookie\?\.\('workos_session'/, 'auth/me must recompute permissions and issue a refreshed token');
assert.match(identityMiddleware, /const requireIdentity =[\s\S]*const requireAuth = async[\s\S]*resolveOrganizationScope\(database, req\)/, 'identity bootstrap and protected scope resolution must remain separate');
assert.match(server, /createRequestContextMiddleware/, 'API requests must receive correlation and operation context');
assert.match(versionedErrors, /versionedApiResponseContract[\s\S]*correlationId[\s\S]*operationId/, 'versioned API failures must use stable machine-readable errors and trace IDs');
assert.match(auditRecord, /correlation_id, operation_id/, 'the shared audit contract must persist request trace IDs');
assert.match(server, /app\.post\('\/api\/auth\/change-password'/, 'self-service password change route must exist');
assert.match(server, /app\.get\('\/api\/auth\/entra\/config'/, 'Entra login config route must exist');
assert.match(server, /app\.get\('\/api\/auth\/entra\/start'/, 'Entra login start route must exist');
assert.match(server, /app\.get\('\/api\/auth\/entra\/callback'/, 'Entra login callback route must exist');
assert.match(server, /openid profile email/, 'Entra login must request OpenID Connect scopes');
assert.match(server, /verifyEntraIdToken/, 'Entra callback must verify ID token signature and claims');
assert.match(server, /entra_group_role_mappings[\s\S]*group_id = any/, 'Entra callback must map group IDs to roles');
assert.match(server, /app\.post\('\/api\/users\/:id\/password-reset'/, 'admin password reset route must exist');
assert.match(server, /must_change_password/, 'user password lifecycle flag must be persisted');
assert.match(server, /Production startup blocked/, 'production env validation must exist');
assert.match(server, /app\.use\(express\.static\(distDir/, 'server must serve built frontend in production');
assert.match(server, /app\.use\('\/assets', express\.static\(join\(distDir, 'assets'\)/, 'server must serve hashed assets with immutable caching');
assert.equal(packageJson.scripts.start, 'node server/start-production.mjs', 'production start script must use the native Node runtime');
assert.equal(packageJson.scripts['api:seed:demo'], 'node --import tsx server/seed-demo.mjs', 'demo seed script must load the canonical TypeScript dataset');
assert.match(seedDemo, /generateDemoDataset/, 'demo seed must reuse canonical demo data generator');
assert.match(seedDemo, /DEMO_ORGANIZATION_ID = 'org-default'/, 'demo seed must use canonical organization ownership');
assert.match(seedDemo, /DEMO_LEGAL_ENTITY_ID = 'legal-default'/, 'demo seed must use canonical legal-entity ownership');
assert.match(seedDemo, /assertDemoAuthority/, 'demo seed must fail closed on missing authority or identifier collisions');
assert.match(seedDemo, /employee_record_id/, 'demo users must use unambiguous employee-record identity');
assert.match(seedDemo, /insert into user_organization_scopes/, 'demo users must receive persisted organization and legal-entity scopes');
assert.match(seedDemo, /insert into worker_profiles/, 'demo employees must receive worker profiles');
assert.match(seedDemo, /insert into worker_history/, 'demo employees must receive initial worker history');
assert.match(seedDemo, /count\(wh\.id\)<>1/, 'demo seed must verify exactly one worker history version');
assert.match(seedDemo, /delete from worker_history where organization_id/, 'demo reset must remove only scoped demo worker history');
assert.doesNotMatch(seedDemo, /truncate table/, 'demo reset must not truncate shared authority tables');
assert.match(seedDemo, /employee\.status !== 'Exited'/, 'exited demo employees must have inactive persisted scopes');
assert.match(seedDemo, /insert into users/, 'demo seed must provision user accounts');
assert.match(seedDemo, /insert into user_roles/, 'demo seed must provision user roles');
assert.match(seedDemo, /insert into timesheets/, 'demo seed must include timesheets');
assert.match(schema, /create table if not exists import_export_logs/, 'import/export history table must exist');
assert.match(server, /app\.post\('\/api\/settings'/, 'settings save route must exist');
assert.match(importHistoryRouter, /router\.post\('\/import-export-logs', requireDatabase, requireAuth, requirePermission\('imports\.manage'\)/,
  'both import/export history POST aliases must retain imports.manage through the shared router');
assert.doesNotMatch(server, /app\.post\('\/api\/import-export-logs'/,
  'the application entry point must not retain a duplicate import-history write handler');
assert.match(server, /app\.post\('\/api\/audit-events'/, 'manual audit event POST route must exist for UI exports');
assert.match(auditRecord, /organizationScope = req\.organizationScope[\s\S]*organizationScope\?\.organizationId[\s\S]*organizationScope\?\.legalEntityId/,
  'new audit rows must default to server-resolved scope while allowing explicit null scope for deployment-level system events');
assert.match(scopedHistoryMigration, /alter table audit_logs add column organization_id text[\s\S]*alter table import_export_logs add column organization_id text[\s\S]*alter table integration_event_logs add column organization_id text/,
  'scoped history migration must add nullable tenant scope without updating historical rows');
assert.doesNotMatch(scopedHistoryMigration, /update\s+audit_logs/i,
  'scoped history migration must not rewrite append-only audit history');
assert.match(server, /const auditHistoryRouter = createAuditHistoryRouter\([\s\S]*app\.use\('\/api', auditHistoryRouter\)[\s\S]*app\.use\('\/api\/v1', auditHistoryRouter\)/,
  'legacy and versioned audit history must mount one shared module router');
assert.match(auditHistoryRouter, /const auditHistoryQuery = `select \* from audit_logs[\s\S]*where organization_id=\$1 and legal_entity_id=\$2/,
  'audit history must filter by the verified selected scope');
assert.match(auditHistoryRouter, /router\.get\('\/audit-logs', requireDatabase, requireAuth, requirePermission\('audit\.view'\)[\s\S]*redactAuditHistoryRows/,
  'both compatibility paths must use the authorized audit view');
assert.equal(packageJson.scripts['test:audit-history-router'], 'node tests/audit-history-router-smoke.mjs',
  'the audit history compatibility route test must be available in the standard suite');
assert.match(server, /const importHistoryRouter = createImportHistoryRouter\([\s\S]*app\.use\('\/api', importHistoryRouter\)[\s\S]*app\.use\('\/api\/v1', importHistoryRouter\)/,
  'legacy and versioned import history must mount one shared module router');
assert.match(importHistoryRouter, /const importHistoryQuery = `select \* from import_export_logs[\s\S]*where organization_id=\$1 and legal_entity_id=\$2[\s\S]*order by created_at desc limit 100/,
  'import history must preserve its exact selected-scope query, limit and ordering');
assert.match(importHistoryRouter, /router\.get\('\/import-export-logs', requireDatabase, requireAuth, requirePermission\('imports\.manage'\)[\s\S]*res\.json\(result\.rows\)/,
  'import history must use the existing import permission and preserve its scoped payload');
assert.equal(packageJson.scripts['test:import-history-router'], 'node tests/import-history-router-smoke.mjs',
  'the import history compatibility route test must run in the standard suite');
assert.match(importHistoryRouter, /where organization_id=\$1 and legal_entity_id=\$2/,
  'import history must filter by the verified selected scope');
assert.match(server, /const integrationHistoryRouter = createIntegrationHistoryRouter\([\s\S]*app\.use\('\/api', integrationHistoryRouter\)[\s\S]*app\.use\('\/api\/v1', integrationHistoryRouter\)/,
  'legacy and versioned integration history must mount one shared module router');
assert.match(integrationHistoryRouter, /const integrationHistoryQuery = `select \* from integration_event_logs[\s\S]*where organization_id=\$1 and legal_entity_id=\$2[\s\S]*order by created_at desc limit 300/,
  'integration event history must preserve its exact selected-scope query, ordering and limit');
assert.match(integrationHistoryRouter, /router\.get\('\/integrations\/events', requireDatabase, requireAuth, requirePermission\('integrations\.identity'\)[\s\S]*redactIntegrationHistoryRows/,
  'both integration-history paths must preserve the identity permission and redacted DTO');
assert.equal(packageJson.scripts['test:integration-history-router'], 'node tests/integration-history-router-smoke.mjs',
  'the integration history compatibility-route test must run in the standard suite');
assert.match(server, /e\.organization_id=\$4 and e\.legal_entity_id=\$5[\s\S]*where status = 'Failed' and organization_id=\$4 and legal_entity_id=\$5/,
  'integration health aggregates over scoped workers and events must use the verified selected scope');
assert.match(server, /app\.post\(\['\/api\/imports\/employees\/apply', '\/api\/v1\/imports\/employees\/apply'\]/, 'legacy and versioned employee import apply routes must share one handler');
assert.match(employeeImportRoute, /requirePermission\('imports\.manage'\)/,
  'Employee Master import apply must retain its existing imports.manage authorization gate');
assert.match(employeeImportRoute, /hashEmployeeImportRequest\([\s\S]*schemaVersion: 'employee-master\/1'/,
  'the versioned Employee Master retry identity must use its explicit schema and password-omitting request hash');
assert.match(importIdempotency, /normalizeEmployeeImportClientErrors[\s\S]*EMPLOYEE_PREFLIGHT_ERROR_MESSAGE[\s\S]*clientErrors\.map\(\(\{rowNumber, field\}\)/,
  'Employee retry identity must use bounded row/field diagnostics and exclude arbitrary credential-echoing metadata');
assert.match(employeeImportRoute, /const fileName = versioned\s+\? 'Employee Master import\.csv'[\s\S]*const redactedClientErrors = redactCredentialEchoes\(parsed\.data\.clientErrors \|\| \[\], credentials\)[\s\S]*normalizeEmployeeImportClientErrors\(redactedClientErrors\)/,
  'versioned Employee batches must use safe server-controlled labels/messages while the legacy alias retains exact echo redaction');
assert.match(employeeImportRoute, /safeResponseErrors = redactCredentialEchoes\(responseErrors, credentials\)[\s\S]*JSON\.stringify\(safeResponseErrors\)/,
  'all Employee Master API aliases must sanitize apply-time diagnostics before persisting or returning them');
assert.match(employeeImportRoute, /IDEMPOTENCY_KEY_REUSED/,
  'changed non-credential Employee Master request fields must conflict under a reused idempotency key');
assert.match(employeeImportRoute, /select \* from import_export_logs[\s\S]*existing\.rows\[0\]\.batch_id[\s\S]*await client\.query\('commit'\)[\s\S]*res\.json\(/,
  'identical Employee Master retries must replay their original scoped batch without reapplying rows');
assert.match(employeeImportRoute, /replayed: true[\s\S]*log: batch/,
  'Employee Master v1 replay responses identify when the previously accepted result was returned');
assert.match(employeeImportRoute, /\.\.\.\(versioned \? \{replayed: false\} : \{\}\)/,
  'only versioned Employee Master apply responses add the initial-result replay marker');
assert.match(employeeImportRoute, /const importBatchId = crypto\.randomUUID\(\)/,
  'employee imports must receive a server-generated batch ID after request validation');
assert.match(employeeImportRoute, /source: 'Employee Master CSV'[\s\S]*importBatchId,[\s\S]*sourceIdentifier: employee\.employee_id,[\s\S]*importProcessingResult: 'Success'/,
  'successful employee row audits must retain source, source identifier, batch and processing result');
assert.match(employeeImportRoute, /insert into import_export_logs \(id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run\)[\s\S]*values \(\$1,'Import','Employee Master'/,
  'employee batch history must use the same ID as row audits, retain the selected scope and record the v1 contract metadata');
assert.match(employeeImportRoute, /\[\s*importBatchId,[\s\S]*fileName,[\s\S]*status,[\s\S]*errors\.length[\s\S]*req\.user\.username/,
  'the employee batch result must preserve aggregate status, counts and existing row errors');
assert.match(employeeImportRoute, /await client\.query\('begin'\)[\s\S]*await audit\(client, req,[\s\S]*insert into import_export_logs[\s\S]*await client\.query\('commit'\)[\s\S]*await client\.query\('rollback'\)/,
  'employee mutations, row audits and the batch result must commit or roll back together');
assert.match(employeeImportRoute, /const status = saved === 0 \? 'Failed' : errors\.length > 0 \? 'Partial' : 'Success'/,
  'employee import success, partial and failed outcomes must retain their existing semantics');
assert.doesNotMatch(employeeImportRoute, /csvContents|rawCsv|parsed\.data\.csv/i,
  'employee import provenance must not persist raw CSV contents');
assert.match(server, /app\.post\(\['\/api\/imports\/clients\/apply', '\/api\/v1\/imports\/clients\/apply'\]/, 'legacy and versioned client import apply routes must share one handler');
assert.match(clientImportRoute, /requirePermission\('imports\.manage'\)/,
  'client import apply must retain its imports.manage authorization gate');
assert.match(clientImportRoute, /const importBatchId = crypto\.randomUUID\(\)/,
  'client imports must receive a server-generated batch ID after request validation');
assert.match(clientImportRoute, /source: 'Client Master CSV'[\s\S]*importBatchId,[\s\S]*sourceIdentifier: row\.id \?\? null,[\s\S]*importProcessingResult: 'Success'/,
  'successful client row audits must retain source, only a supplied source ID, batch and processing result');
assert.match(clientImportRoute, /insert into import_export_logs \(id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run\)[\s\S]*values \(\$1,'Import','Client Master'/,
  'client batch history must use the same ID as row audits, retain the selected scope, and persist the versioned operation result');
assert.match(clientImportRoute, /\[\s*importBatchId,[\s\S]*parsed\.data\.fileName,[\s\S]*status,[\s\S]*errors\.length[\s\S]*req\.user\.username/,
  'the client batch result must preserve aggregate status, counts and existing row errors');
assert.match(clientImportRoute, /await client\.query\('begin'\)[\s\S]*await audit\(client, req,[\s\S]*insert into import_export_logs[\s\S]*await client\.query\('commit'\)[\s\S]*await client\.query\('rollback'\)/,
  'client mutations, row audits and the batch result must commit or roll back together');
assert.match(clientImportRoute, /const status = dryRun \? 'Dry Run' : saved === 0 \? 'Failed' : errors\.length > 0 \? 'Partial' : 'Success'/,
  'client import must distinguish dry-run validation from success, partial and failed outcomes');
assert.match(clientImportRoute, /const versionedSchema = legacySchema\.extend[\s\S]*schemaVersion: z\.literal\('client-master\/1'\)[\s\S]*dryRun: z\.boolean\(\)\.default\(false\)/,
  'versioned client imports must bind a stable schema and explicit dry-run flag');
assert.match(clientImportRoute, /const rowSchema = versioned => z\.object\([\s\S]*id: versioned \? optionalClientImportId : z\.string\(\)\.min\(1\)\.optional\(\)[\s\S]*status: versioned \? optionalClientImportStatus : z\.enum\(\['Active', 'Inactive'\]\)\.optional\(\)/,
  'only versioned Client Master imports may normalize blank optional identifiers and statuses');
assert.match(clientImportRoute, /log: versioned \? logResult\.rows\[0\] : legacyClientImportLog\(logResult\.rows\[0\]\)/,
  'legacy Client Master responses must strip migration-added versioned fields');
assert.match(clientImportRoute, /if \(dryRun\) \{\s*saved \+= 1;\s*continue;\s*\}[\s\S]*insert into clients/,
  'a valid client dry run must stop before any client or association writes');
assert.match(clientImportRoute, /hashImportRequest[\s\S]*createScopedIdempotencyLockKey[\s\S]*import_export_idempotency[\s\S]*IDEMPOTENCY_KEY_REUSED/,
  'versioned client retries must be scoped, replayable and reject changed canonical input');
assert.doesNotMatch(clientImportRoute, /csvContents|rawCsv|parsed\.data\.csv/i,
  'client import provenance must not persist raw CSV contents');
assert.match(server, /const projectImportRouter = createProjectImportRouter\([\s\S]*app\.use\('\/api', projectImportRouter\)[\s\S]*app\.use\('\/api\/v1', projectImportRouter\)/,
  'legacy and versioned project import routes must share the same module router');
assert.match(projectImportRouter, /router\.post\('\/imports\/projects\/apply', requireDatabase, requireAuth, requirePermission\('imports\.manage'\)/,
  'project import apply must retain its imports.manage authorization gate');
assert.match(projectImportRouter, /projectCode: z\.string\(\)\.min\(1\)/,
  'project import provenance must use the existing required source project code');
assert.match(projectImportRouter, /const importBatchId = randomUUID\(\)/,
  'project imports must receive a server-generated batch ID after request validation');
assert.match(projectImportRouter, /const rowSchema = versioned => z\.object\([\s\S]*status: versioned[\s\S]*z\.enum\(\['Proposed', 'Active', 'On Hold', 'Completed'\]\)\.optional\(\)/,
  'only versioned Project Master imports may normalize blank optional statuses');
assert.match(projectImportRouter, /source: 'Project Master CSV'[\s\S]*importBatchId,[\s\S]*sourceIdentifier: row\.projectCode,[\s\S]*importProcessingResult: 'Success'/,
  'successful project row audits must retain source, required source ID, batch and processing result');
assert.match(projectImportRouter, /on conflict \(organization_id,project_code\) do update set[\s\S]*where projects\.organization_id=excluded\.organization_id and projects\.legal_entity_id=excluded\.legal_entity_id returning \*[\s\S]*if \(result\.rowCount === 0\)[\s\S]*PROJECT_SCOPE_CONFLICT/,
  'a racing project-code conflict must update only inside the same organization and legal entity or remain a row-local conflict');
assert.match(projectImportRouter, /insert into import_export_logs \(id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run\)/,
  'project batch history must retain the same batch ID and server-verified scope with schema and dry-run metadata');
assert.match(projectImportRouter, /await client\.query\('begin'\)[\s\S]*await audit\(client, req,[\s\S]*insert into import_export_logs[\s\S]*await client\.query\('commit'\)[\s\S]*await client\.query\('rollback'\)/,
  'project mutations, row audits and the batch result must commit or roll back together');
assert.match(projectImportRouter, /const status = dryRun \? 'Dry Run' : saved === 0 \? 'Failed' : errors\.length > 0 \? 'Partial' : 'Success'/,
  'project import success, partial and failed outcomes must retain their existing semantics');
assert.match(projectImportRouter, /Idempotency-Key[\s\S]*schemaVersion[\s\S]*dryRun[\s\S]*IDEMPOTENCY_KEY_REUSED/,
  'the v1 project import contract must require a schema version and key and protect changed-payload replays');
assert.match(projectImportRouter, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)[\s\S]*import_export_idempotency/,
  'same-key project imports must serialize through a database transaction lock and durable idempotency record');
assert.match(projectImportRouter, /const projectCodeLockKeys[\s\S]*\.sort\(\(left, right\) => left < right \? -1 : left > right \? 1 : 0\)[\s\S]*for \(const projectCodeLockKey of projectCodeLockKeys\)/,
  'overlapping project imports must acquire all org-scoped project-code locks in a stable order');
assert.match(projectSaveRoute, /createProjectCodeLockKey[\s\S]*\.sort\(\(left, right\) => left < right \? -1 : left > right \? 1 : 0\)[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)[\s\S]*select \* from projects[\s\S]*for update/,
  'normal project create/update must share sorted org-scoped project-code locks with import before reading its locked prior value');
assert.match(projectSaveRoute, /Boolean\(observedPrevious\) !== Boolean\(previous\)[\s\S]*status\(409\)/,
  'normal project saves must fail with a stable conflict when the prior row changes before shared-lock acquisition');
assert.match(projectImportRouter, /versioned && row\.clientId[\s\S]*where id=\$1 and organization_id=\$2 and legal_entity_id=\$3/,
  'the versioned contract must treat clientId as authoritative within the server-resolved scope');
assert.match(projectImportRouter, /versioned\s*\?\s*'Project code is not available in the authorized scope\.'/,
  'versioned cross-scope conflicts must not reveal an out-of-scope project-code match');
assert.match(importOperationMigration, /add column if not exists schema_version text[\s\S]*add column if not exists dry_run boolean not null default false[\s\S]*create table if not exists import_export_idempotency[\s\S]*primary key \(organization_id, legal_entity_id, actor_id, channel, idempotency_key\)[\s\S]*on delete cascade/,
  'migration 039 must add scoped operation metadata and idempotency records linked to the batch lifecycle');
assert.match(importIdempotency, /normalizeIdempotencyKey[\s\S]*stableJsonStringify[\s\S]*createHash\('sha256'\)/,
  'idempotency keys and canonical payload hashes must be validated and stable');
assert.doesNotMatch(projectImportRouter, /csvContents|rawCsv|parsed\.data\.csv/i,
  'project import provenance must not persist raw CSV contents');
assert.match(operationalImportRouter, /router\.post\('\/imports\/allocations\/apply'/, 'allocation import apply route must exist');
assert.match(server, /app\.use\('\/api', operationalImportRouter\)[\s\S]*app\.use\('\/api\/v1', operationalImportRouter\)/,
  'allocation and timesheet import routes must share the legacy and versioned router');
assert.match(allocationImportRoute, /requirePermission\('imports\.manage'\)/,
  'allocation import must retain its imports.manage authorization gate');
assert.match(operationalImportRouter, /id: versioned \? optionalBlankId : z\.string\(\)\.min\(1\)\.optional\(\)/,
  'versioned allocation accepts blank optional IDs while the legacy schema preserves its existing validation');
assert.match(allocationImportRoute, /const importBatchId = randomUUID\(\)/,
  'allocation imports must receive a server-generated batch ID after request validation');
assert.match(allocationImportRoute, /source: 'Allocation Control CSV'[\s\S]*importBatchId,[\s\S]*sourceIdentifier: row\.id \?\? null,[\s\S]*importProcessingResult: 'Success'/,
  'successful allocation row audits must retain source, optional source ID, batch and processing result');
assert.match(allocationImportRoute, /insert into import_export_logs \(id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run\)[\s\S]*values \(\$1,'Import','Allocation Control'/,
  'allocation batch history must use the same ID as row audits and retain the selected scope');
assert.match(allocationImportRoute, /await client\.query\('begin'\)[\s\S]*await audit\(client, req,[\s\S]*insert into import_export_logs[\s\S]*await client\.query\('commit'\)[\s\S]*await client\.query\('rollback'\)/,
  'allocation mutations, row audits and the batch result must commit or roll back together');
assert.match(allocationImportRoute, /where project_allocations\.organization_id=excluded\.organization_id and project_allocations\.legal_entity_id=excluded\.legal_entity_id/,
  'allocation upserts must remain restricted to the authorized organization and legal entity');
assert.match(allocationImportRoute, /pg_advisory_xact_lock[\s\S]*Allocation would exceed 100% for overlapping dates/,
  'allocation imports must preserve the existing scoped over-allocation check');
assert.match(allocationImportRoute, /const status = dryRun \? 'Dry Run' : saved === 0 \? 'Failed' : errors\.length > 0 \? 'Partial' : 'Success'/,
  'allocation import success, partial and failed outcomes must retain their existing semantics');
assert.match(allocationImportRoute, /seenAllocationNaturalKeys[\s\S]*const naturalKey = \[employee\.id, project\.id, row\.startDate, row\.endDate\][\s\S]*allocationKey/,
  'the versioned allocation contract must detect duplicate keys after resolving employee/project aliases while legacy only checks supplied IDs');
assert.match(allocationImportRoute, /stagedAllocationChanges[\s\S]*staged\.previous\.employee_id === employee\.id[\s\S]*staged\.employeeId === employee\.id[\s\S]*staged\.next\.percentage/,
  'the no-write allocation dry run must move cumulative load from a reassigned source employee to its destination');
assert.match(operationalImportRouter, /if \(dryRun\) await recordDryRunAudit/,
  'allocation dry runs must write an operation result without row mutations or row audits');
assert.match(operationalImportRouter, /entityType: 'ImportBatch',[\s\S]*importProcessingResult: 'Dry Run'/,
  'operational import dry-run auditing must identify the batch and dry-run result');
assert.doesNotMatch(allocationImportRoute, /csvContents|rawCsv|parsed\.data\.csv/i,
  'allocation import provenance must not persist raw CSV contents');
assert.match(operationalImportRouter, /router\.post\('\/imports\/timesheets\/apply'/, 'timesheet import apply route must exist');
assert.match(timesheetImportRoute, /requirePermission\('imports\.manage'\)/,
  'timesheet import must retain its imports.manage authorization gate');
const timesheetRowSchema = operationalImportRouter.match(/const timesheetRowSchema = versioned => z\.object\(\{([\s\S]*?)\n  \}\);/)?.[1] || '';
assert.doesNotMatch(timesheetRowSchema, /^\s*id\s*:/m,
  'timesheet provenance must not invent an upstream row ID absent from the import contract');
assert.match(timesheetImportRoute, /const importBatchId = randomUUID\(\)/,
  'timesheet imports must receive one server-generated batch ID after request validation');
assert.match(timesheetImportRoute, /for \(const group of groups\.values\(\)\)[\s\S]*await audit\(client, req,[\s\S]*entityType: 'Timesheet'[\s\S]*source: 'Timesheet Import CSV',[\s\S]*importBatchId,[\s\S]*sourceIdentifier: null,[\s\S]*importProcessingResult: 'Success'/,
  'successful timesheet group audits must retain source, null unavailable source ID, batch and result once per group');
assert.match(timesheetImportRoute, /insert into import_export_logs \(id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run, capture_warnings, submission_timing\)[\s\S]*values \(\$1,'Import','Timesheet Import'/,
  'timesheet batch history must use the same ID as group audits and retain the selected scope');
assert.match(timesheetImportRoute, /await client\.query\('begin'\)[\s\S]*for \(const group of groups\.values\(\)\)[\s\S]*await audit\(client, req,[\s\S]*insert into import_export_logs[\s\S]*await client\.query\('commit'\)[\s\S]*await client\.query\('rollback'\)/,
  'timesheet updates, entries, group audits and import history must commit or roll back together');
assert.match(timesheetImportRoute, /assertReportingPeriodAllows[\s\S]*REPORTING_PERIOD_OPERATIONS\.CONTENT[\s\S]*on conflict \(organization_id, employee_id, week_ending\) do update set/,
  'timesheet provenance must preserve authoritative period checks and existing scoped group upserts');
assert.match(timesheetImportRoute, /const status = dryRun \? 'Dry Run' : validEntryRows === 0 \? 'Failed' : errors\.length > 0 \? 'Partial' : 'Success'/,
  'timesheet import success, partial and failed counts must retain their existing row semantics');
assert.match(timesheetImportRoute, /const naturalTarget = row\.workType === 'Project Work' \? project\?\.id : row\.clientName[\s\S]*seenTimesheetEntryKeys/,
  'versioned Timesheet Import must detect duplicate natural keys after resolving employee/project aliases');
assert.match(timesheetImportRoute, /!isWorkDateInsideWeek\(row\.date, row\.weekEnding\)/,
  'versioned Timesheet Import must preserve the existing seven-day work-date rule');
assert.match(timesheetImportRoute, /if \(dryRun\) \{\s*stagedCaptureReplacements\.push\(\{employeeId:group\.employee\.id,timesheetId:previous\?\.id\|\|null,entries:policyEntries\}\);\s*continue;\s*\}\s*const totalHours=/,
  'timesheet dry runs stage only prospective grouped capture state and continue before any timesheet or entry mutation');
assert.match(operationalImportRouter, /ALLOCATION_IMPORT_SCHEMA_VERSION = 'allocation-control\/1'[\s\S]*TIMESHEET_IMPORT_SCHEMA_VERSION = 'timesheet-import\/1'/,
  'the new operational import schemas must be explicit and versioned');
assert.doesNotMatch(timesheetImportRoute, /csvContents|rawCsv|parsed\.data\.csv/i,
  'timesheet import provenance must not persist raw CSV contents');
assert.match(server, /collectDuplicateImportRows/, 'import apply routes must share duplicate-row detection');
assert.match(server, /Duplicate \$\{label \|\| field\} also appears on row/, 'duplicate import rows must return row-level errors');
assert.match(server, /field: 'employeeId'[\s\S]*field: 'email'/, 'employee import must reject duplicate employee IDs and emails within a file');
assert.match(projectImportRouter, /field: 'projectCode'/, 'project import must reject duplicate project codes within a file');
assert.match(server, /field: 'id', value: row\.id, label: 'client ID'[\s\S]*field: 'name', value: row\.name, label: 'client name'/, 'client import must reject duplicate client IDs and names within a file');
assert.match(server, /duplicateImportRows\.duplicateRowNumbers\.has\(rowNumber\)/, 'duplicate import rows must be skipped instead of upserted');
assert.match(server, /action: previous \? 'Update Client' : 'Create Client'/, 'client master changes must be audited with create/update actions');
assert.match(server, /action: 'Deactivate Blocked'[\s\S]*active project\(s\) remain/, 'blocked client deactivation must be audited with dependency reason');
assert.match(server, /action: 'Deactivate Client'[\s\S]*oldValue: previous[\s\S]*newValue: result\.rows\[0\]/, 'client deactivation must be audited with old and new values');
assert.match(server, /json_agg\(json_build_object/, 'timesheet API must include entries');
assert.match(server, /app\.get\('\/api\/reports\/planned-utilization'/, 'planned utilization report route must exist');
assert.match(server, /app\.get\('\/api\/reports\/actual-utilization'/, 'actual utilization report route must exist');
assert.match(server, /app\.get\('\/api\/reports\/forecast-utilization'/, 'forecast utilization report route must exist');
assert.match(server, /app\.use\('\/api', createLeaveRouter\(/, 'leave capability router must be mounted on the existing legacy API prefix');
assert.match(leaveRouter, /router\.get\('\/leave\/requests'/, 'leave request list route must exist');
assert.match(leaveRouter, /router\.post\('\/leave\/requests'/, 'leave request submit route must exist');
assert.match(leaveRouter, /router\.patch\('\/leave\/requests\/:id\/status'/, 'leave approval route must exist');
assert.match(leaveRouter, /router\.get\('\/holiday-calendars'/, 'holiday calendar route must exist');
assert.doesNotMatch(server, /app\.(?:get|post|patch)\('\/api\/(?:leave\/|holiday-calendars)/, 'the entry point must not retain duplicate leave route registrations');
assert.match(server, /app\.use\('\/api', createAvailabilityReportRouter\(\{[\s\S]*?run,[\s\S]*?requireDatabase,[\s\S]*?requireAuth,[\s\S]*?requirePermission,[\s\S]*?buildEmployeeScopeWhere,[\s\S]*?\}\)\)/, 'availability report must use the shared database, identity, permission and scope dependencies');
assert.match(availabilityReportRouter, /router\.get\('\/reports\/availability'/, 'availability report route must exist in its module');
assert.doesNotMatch(server, /app\.get\('\/api\/reports\/availability'/, 'the entry point must not retain a duplicate availability route');
assert.doesNotMatch(server, /app\.use\('\/api\/v1', createAvailabilityReportRouter/, 'availability remains legacy-only');
assert.match(leaveMigration, /create table if not exists leave_requests/, 'leave migration must create leave requests');
assert.match(leaveMigration, /create table if not exists leave_balances/, 'leave migration must create leave balances');
assert.match(server, /app\.get\('\/api\/approvals'/, 'approval inbox route must exist');
assert.match(server, /app\.patch\('\/api\/approvals\/:id\/status'/, 'generic approval decision route must exist');
assert.match(server, /app\.get\('\/api\/approval-delegations'/, 'approval delegation route must exist');
assert.match(server, /app\.get\('\/api\/reports\/approval-sla'/, 'approval SLA report route must exist');
assert.match(approvalMigration, /create table if not exists approval_records/, 'approval migration must create approval records');
assert.match(approvalMigration, /create table if not exists approval_delegations/, 'approval migration must create approval delegations');
assert.match(server, /createNotificationRouter\(/, 'notification capability router must be mounted');
assert.match(notificationRouter, /router\.get\('\/notifications'/, 'notification inbox route must exist');
assert.match(notificationRouter, /router\.patch\('\/notifications\/:id\/read'/, 'notification read route must exist');
assert.match(notificationRouter, /router\.get\('\/notification-templates'/, 'notification template route must exist');
assert.match(notificationRouter, /router\.get\('\/notification-preferences'/, 'notification preference route must exist');
assert.match(notificationRouter, /router\.get\('\/notification-delivery-attempts'/, 'notification delivery monitoring route must exist');
assert.match(notificationRouter, /router\.post\('\/notifications\/test-delivery'/, 'notification test delivery route must exist');
assert.match(server, /https:\/\/graph\.microsoft\.com\/\.default/, 'Graph adapters must use Microsoft identity client credentials scope');
assert.match(server, /\/users\/\$\{encodeURIComponent\(sender\)\}\/sendMail/, 'email adapter must use Microsoft Graph sendMail');
assert.match(server, /\/teamwork\/sendActivityNotification/, 'Teams adapter must use Microsoft Graph activity notifications');
assert.match(server, /TEAMS_ACTIVITY_TYPE/, 'Teams activity type must be environment-configurable');
assert.match(notificationMigration, /create table if not exists notification_events/, 'notification migration must create events');
assert.match(notificationMigration, /create table if not exists notification_delivery_attempts/, 'notification migration must create delivery attempts');
assert.match(server, /app\.get\('\/api\/integrations\/identity-links'/, 'identity provider link route must exist');
assert.match(server, /app\.post\('\/api\/integrations\/identity-links'/, 'identity provider link save route must exist');
assert.match(server, /app\.get\('\/api\/integrations\/entra-role-mappings'/, 'Entra role mapping route must exist');
assert.match(server, /app\.get\('\/api\/integrations\/teams-user-links'/, 'Teams user link route must exist');
assert.match(server, /app\.post\('\/api\/integrations\/teams-action-tokens'/, 'Teams action token creation route must exist');
assert.match(server, /app\.post\('\/api\/integrations\/teams-action-tokens\/:token\/execute'/, 'Teams action token execution route must exist');
assert.match(server, /app\.post\('\/api\/integrations\/teams-action-tokens\/:token\/send'/, 'Teams action notification send route must exist');
assert.match(server, /buildTeamsActionUrl/, 'Teams action tokens must expose portal action links');
assert.match(server, /app\.get\('\/api\/integrations\/health'/, 'integration health route must exist');
assert.match(server, /credentialChecks/, 'integration health must expose non-secret credential readiness checks');
assert.match(server, /ENTRA_REDIRECT_URI/, 'integration readiness must account for Entra redirect URI');
assert.match(readFileSync('vite.config.ts', 'utf8'), /proxy[\s\S]*'\/api'[\s\S]*API_PORT/, 'Vite dev server must proxy /api to the local API for SSO callback testing');
assert.match(integrationMigration, /create table if not exists identity_provider_links/, 'integration migration must create identity provider links');
assert.match(integrationMigration, /create table if not exists teams_action_tokens/, 'integration migration must create Teams action tokens');
assert.match(integrationMigration, /action text not null check \(action in \('approve', 'reject', 'open_portal'\)\)/, 'Teams action tokens must be deterministic action-only');
assert.match(server, /app\.get\('\/api\/reports\/resource-planning'/, 'resource planning report route must exist');
assert.match(server, /app\.get\('\/api\/reports\/workforce-command-center'/, 'workforce command center route must exist');
assert.match(server, /getResourcePlanningPayload/, 'command center must reuse the resource planning payload');
assert.match(server, /buildEmployeeScopeWhere/, 'report endpoints must reuse backend employee scoping');

console.log(JSON.stringify({
  status: 'passed',
  catalogRoutes: true,
  productionStaticServing: true,
  loginRateLimit: true,
  passwordLifecycle: true,
  demoSeed: true,
  reportRoutes: true,
  leaveRoutes: true,
  approvalRoutes: true,
  notificationRoutes: true,
  integrationRoutes: true,
  planningRoutes: true,
  employeeImportApply: true,
  clientImportApply: true,
  projectImportApply: true,
  allocationImportApply: true,
  timesheetImportApply: true,
}, null, 2));
