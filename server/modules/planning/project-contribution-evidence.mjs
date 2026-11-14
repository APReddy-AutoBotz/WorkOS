import {randomUUID} from 'node:crypto';
import {resolveOrganizationScope} from '../../organization-setup.mjs';
import {capacityCanonical, capacityHash, capacityFailure} from './worker-capacity-service.mjs';
import {calculateScopedProjectContribution} from './project-contribution-service.mjs';
import {projectContributionCsv} from './project-contribution-artifact.mjs';

const scope = req => [req.organizationScope.organizationId, req.organizationScope.legalEntityId, req.params.id];
const unavailable = () => capacityFailure('PROJECT_EVIDENCE_NOT_FOUND', 'Retained project evidence is unavailable in this scope.', 404);

export const authorizeProjectEvidence = async (client, req, options) => {
  const current = await resolveOrganizationScope(client, req);
  if (current.organizationId !== req.organizationScope.organizationId || current.legalEntityId !== req.organizationScope.legalEntityId) unavailable();
  // Lock the identity and existing permission rows before retaining or returning
  // an artifact. Bind relationship predicates to current database identifiers.
  const user = (await client.query(`select u.employee_id,e.id employee_record_id,cd.id country_director_id from users u
    left join employees e on e.id=u.employee_record_id
    left join country_directors cd on cd.id=e.primary_country_director_id
      and (lower(e.designation) in ('country director','regional lead','director') or lower(e.department)='regional leadership')
    join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
    where u.id=$1 and u.status='Active' and r.name=$2 for share of u,ur,r`, [req.user.sub, req.user.activeRole])).rows[0];
  if (!user) capacityFailure('PROJECT_EVIDENCE_DENIED', 'Current report authority is required.', 403);
  req = {...req, user: {...req.user, employeeId: user.employee_id, employeeRecordId: user.employee_record_id, countryDirectorId: user.country_director_id}};
  const permissions = ['employees.view', 'projects.view', 'reports.export', 'reports.view_utilization'];
  const heldScope = await client.query(`select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active for share`, [req.user.sub, ...scope(req).slice(0, 2)]);
  const role = await client.query('select permission_key,enabled from role_permissions where role_name=$1 and permission_key=any($2::text[]) order by permission_key for share', [req.user.activeRole, permissions]);
  const grants = await client.query('select permission_key from user_permission_grants where user_id=$1 and permission_key=any($2::text[]) order by permission_key for share', [req.user.sub, permissions]);
  const keys = new Set([...role.rows.filter(row => row.enabled), ...grants.rows].map(row => row.permission_key));
  if (!heldScope.rowCount || permissions.some(key => !keys.has(key))) capacityFailure('PROJECT_EVIDENCE_DENIED', 'Current report export authority is required.', 403);
  const params = [], where = options.buildProjectScopeWhere(req, params, 'p');
  params.push(req.params.id);
  if (!(await client.query(`select 1 from projects p where (${where}) and p.id=$${params.length}`, params)).rowCount) unavailable();
  return req;
};

const validateRetainedScope = async (client, req, evidence, options) => {
  if (!evidence) unavailable();
  const params = [], where = options.buildEmployeeScopeWhere(req, params, 'e');
  params.push(evidence.worker_ids);
  const found = await client.query(`select e.id from employees e where (${where}) and e.id=any($${params.length}::text[])`, params);
  if (found.rowCount !== evidence.worker_ids.length) unavailable();
  const csv = projectContributionCsv(req.organizationScope, evidence.result);
  if (csv !== evidence.artifact_csv || capacityHash(csv) !== evidence.artifact_sha256 || Buffer.byteLength(csv, 'utf8') !== evidence.artifact_bytes) {
    capacityFailure('PROJECT_EVIDENCE_INTEGRITY', 'Retained project evidence could not be verified.', 503);
  }
  return evidence;
};
export const projectEvidenceView = row => ({id: row.id, requestId: row.request_id, createdAt: row.created_at,
  activeRole: row.active_role, source: row.source, reason: row.reason, result: row.result,
  artifact: {fileName: `project-contribution-${row.id}.csv`, sha256: row.artifact_sha256, bytes: row.artifact_bytes}});

const ownedRequest = async (client, req, requestId) => (await client.query(`select * from project_contribution_evidence
  where organization_id=$1 and legal_entity_id=$2 and project_id=$3 and actor_id=$4 and active_role=$5 and request_id=$6`,
[...scope(req), req.user.sub, req.user.activeRole, requestId])).rows[0];

export const readProjectEvidenceRequest = async (client, req, requestId, options) => {
  req = await authorizeProjectEvidence(client, req, options);
  return validateRetainedScope(client, req, await ownedRequest(client, req, requestId), options);
};

export const listProjectEvidence = async (client, req, input, options) => {
  req = await authorizeProjectEvidence(client, req, options);
  const params = [...scope(req), input.startsOn, input.endsOn];
  const workerWhere = options.buildEmployeeScopeWhere(req, params, 'e');
  // Filter the complete retained cohort before pagination. Neither hidden rows
  // nor a count of hidden artifacts is returned to a partially scoped viewer.
  const visible = `not exists(select 1 from unnest(h.worker_ids) worker(id)
    where not exists(select 1 from employees e where e.id=worker.id and (${workerWhere})))`;
  const period = 'h.organization_id=$1 and h.legal_entity_id=$2 and h.project_id=$3 and h.starts_on=$4 and h.ends_on=$5';
  let cursor = '';
  if (input.before) {
    const cursorParams = [...params, input.before];
    const row = (await client.query(`select h.created_at::text cursor_time,h.id from project_contribution_evidence h
      where ${period} and ${visible} and h.id=$${cursorParams.length}`, cursorParams)).rows[0];
    if (!row) unavailable();
    const dateIndex = params.push(row.cursor_time), idIndex = params.push(row.id);
    cursor = `and (h.created_at,h.id)<($${dateIndex}::timestamptz,$${idIndex}::uuid)`;
  }
  const rows = (await client.query(`select h.* from project_contribution_evidence h where ${period} and ${visible}
    ${cursor} order by h.created_at desc,h.id desc limit 11`, params)).rows;
  for (const row of rows.slice(0, 10)) await validateRetainedScope(client, req, row, options);
  return {evidence: rows.slice(0, 10).map(projectEvidenceView), nextBefore: rows.length > 10 ? rows[9].id : null};
};

export const retainProjectEvidence = async (client, req, input, options) => {
  req = await authorizeProjectEvidence(client, req, options);
  const fingerprint = capacityHash(capacityCanonical({...input, actorId: req.user.sub, activeRole: req.user.activeRole}));
  const prior = await ownedRequest(client, req, input.requestId);
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) capacityFailure('PROJECT_EVIDENCE_REQUEST_CONFLICT', 'The original request has different content. Reconcile it before another save.', 409);
    return {row: await validateRetainedScope(client, req, prior, options), replayed: true};
  }
  const report = await calculateScopedProjectContribution(client, req, req.params.id, input.startsOn, input.endsOn, options);
  if (report.result.sourceToken !== input.expectedSourceToken) capacityFailure('PROJECT_EVIDENCE_SOURCE_CHANGED', 'Report sources changed. Calculate again before retaining.', 409);
  const csv = projectContributionCsv(req.organizationScope, report.result), id = randomUUID();
  await client.query("select set_config('workos.project_contribution_context',$1,true)", [JSON.stringify({recordId: id, actorId: req.user.sub, activeRole: req.user.activeRole, ...req.organizationScope})]);
  const row = (await client.query(`insert into project_contribution_evidence
    (id,organization_id,legal_entity_id,project_id,actor_id,active_role,request_id,request_fingerprint,starts_on,ends_on,
     calculation_version,input_canonical,source_token,result,worker_ids,artifact_csv,artifact_sha256,artifact_bytes,source,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'project-contribution/1',$11,$12,$13,$14,$15,$16,$17,'Web',$18) returning *`,
  [id, ...scope(req), req.user.sub, req.user.activeRole, input.requestId, fingerprint, input.startsOn, input.endsOn,
    report.inputCanonical, report.result.sourceToken, JSON.stringify(report.result), (report.result.rows ?? []).map(item => item.employeeId),
    csv, capacityHash(csv), Buffer.byteLength(csv, 'utf8'), input.reason])).rows[0];
  await options.audit(client, req, {module: 'Reports', action: 'Retain Project Contribution Evidence', entityType: 'ProjectContributionEvidence', entityId: id,
    newValue: {id, projectId: req.params.id, startsOn: input.startsOn, endsOn: input.endsOn, calculationVersion: report.result.calculationVersion,
      sourceToken: row.source_token, artifactSha256: row.artifact_sha256, artifactBytes: row.artifact_bytes}, reason: input.reason,
    details: 'Retained immutable server-calculated operational report and CSV; no work, approval or financial mutation.'});
  return {row, replayed: false};
};

export const retrieveProjectArtifact = async (client, req, id, options) => {
  req = await authorizeProjectEvidence(client, req, options);
  const row = await validateRetainedScope(client, req, (await client.query(`select * from project_contribution_evidence
    where organization_id=$1 and legal_entity_id=$2 and project_id=$3 and id=$4`, [...scope(req), id])).rows[0], options);
  await options.audit(client, req, {module: 'Reports', action: 'Retrieve Project Contribution Artifact', entityType: 'ProjectContributionEvidence', entityId: id,
    newValue: {id, projectId: req.params.id, sourceToken: row.source_token, artifactSha256: row.artifact_sha256, artifactBytes: row.artifact_bytes},
    details: 'Retrieved the existing immutable artifact under current project and complete retained-worker scope.'});
  return row;
};
