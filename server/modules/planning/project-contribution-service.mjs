import {calculateProjectContribution, PROJECT_CONTRIBUTION_VERSION} from '../../../shared/project-contribution.mjs';
import {validCapacityRange} from '../../../shared/worker-capacity.mjs';
import {canonicalHours} from '../../../shared/work-hours.mjs';
import {loadCapacitySourcesBatch, capacityCanonical, capacityHash, capacityFailure} from './worker-capacity-service.mjs';
import {calculateWorkerCapacity} from './capacity-resolver.mjs';
import {approvedWorkDisposition} from './actual-work-service.mjs';

const maxWorkers = 500;
const maxEntries = 10000;

// The router owns a repeatable-read transaction. Both project and worker scope
// are applied before cohort formation, work reads, capacity or aggregation.
export const calculateScopedProjectContribution = async (client, req, projectId, startsOn, endsOn, {buildProjectScopeWhere, buildEmployeeScopeWhere}) => {
  if (!validCapacityRange(startsOn, endsOn)) capacityFailure('PROJECT_CONTRIBUTION_RANGE', 'Choose at most366 valid business dates.', 400);
  const projectParams = [], projectWhere = buildProjectScopeWhere(req, projectParams, 'p');
  projectParams.push(projectId);
  const project = (await client.query(`select p.id,p.name from projects p where ${projectWhere} and p.id=$${projectParams.length}`, projectParams)).rows[0];
  if (!project) capacityFailure('PROJECT_CONTRIBUTION_NOT_FOUND', 'Project reporting is unavailable in this scope.', 404);
  const {organizationId, legalEntityId} = req.organizationScope;
  const params = [], workerWhere = buildEmployeeScopeWhere(req, params, 'e');
  const projectParam = params.push(projectId), fromParam = params.push(startsOn), toParam = params.push(endsOn);
  const workers = (await client.query(`select e.id,e.employee_id code,e.name,e.status,e.legal_entity_id "legalEntityId",to_char(e.joining_date,'YYYY-MM-DD') "joiningDate",to_char(e.exit_date,'YYYY-MM-DD') "exitDate"
    from employees e where (${workerWhere}) and (
      exists(select 1 from project_allocations a where a.employee_id=e.id and a.organization_id=e.organization_id and a.legal_entity_id=e.legal_entity_id and a.project_id=$${projectParam} and a.start_date<=$${toParam}::date and a.end_date>=$${fromParam}::date)
      or exists(select 1 from timesheets t join timesheet_entries x on x.timesheet_id=t.id where t.employee_id=e.id and t.organization_id=e.organization_id and t.legal_entity_id=e.legal_entity_id and x.project_id=$${projectParam} and x.work_date between $${fromParam}::date and $${toParam}::date))
    order by e.id collate "C" limit ${maxWorkers + 1}`, params)).rows;
  const clock = (await client.query(`with observation as materialized (select clock_timestamp() at time zone 'UTC' instant) select to_char(instant::date,'YYYY-MM-DD') today,to_char(instant,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed from observation`)).rows[0];
  const periodIsActual = endsOn <= clock.today;
  if (workers.length > maxWorkers) {
    const result = calculateProjectContribution({projectId, startsOn, endsOn, workers: [], periodIsActual, sourceLimited: true});
    const inputCanonical = capacityCanonical({calculationVersion: PROJECT_CONTRIBUTION_VERSION, organizationId, legalEntityId, projectId, startsOn, endsOn, periodIsActual, sourceLimited: true});
    return {project, inputCanonical, result: {...result, sourceToken: capacityHash(inputCanonical), observedAt: clock.observed}, workers: []};
  }
  const workerIds = workers.map(worker => worker.id);
  const sources = await loadCapacitySourcesBatch(client, req, workers, startsOn, endsOn);
  const entries = workerIds.length ? (await client.query(`select x.*,to_char(x.work_date,'YYYY-MM-DD') work_date,trim_scale(x.hours)::text hours,t.employee_id,t.status
    from timesheet_entries x join timesheets t on t.id=x.timesheet_id where t.organization_id=$1 and t.legal_entity_id=$2 and t.employee_id=any($3::text[]) and x.project_id=$4 and x.work_date between $5::date and $6::date order by x.work_date,x.id limit ${maxEntries + 1}`,
  [organizationId, legalEntityId, workerIds, projectId, startsOn, endsOn])).rows : [];
  const headerIds = [...new Set(entries.map(entry => entry.timesheet_id))];
  const submissions = headerIds.length ? (await client.query(`select s.* from unnest($1::uuid[]) h(id) cross join lateral (select id,timesheet_id,sequence,entries from work_submission_evidence where timesheet_id=h.id and organization_id=$2 and legal_entity_id=$3 order by sequence desc limit 1) s order by s.timesheet_id`, [headerIds, organizationId, legalEntityId])).rows : [];
  const decisions = submissions.length ? (await client.query(`select d.* from unnest($1::text[]) s(id) cross join lateral (select id,submission_id,status from work_submission_decisions where submission_id=s.id order by created_at desc,id desc limit 1) d order by d.submission_id`, [submissions.map(submission => submission.id)])).rows : [];
  const sourceLimited = entries.length > maxEntries || submissions.reduce((count, submission) => count + submission.entries.length, 0) > maxEntries;
  const submissionByHeader = new Map(submissions.map(submission => [submission.timesheet_id, submission]));
  const decisionBySubmission = new Map(decisions.map(decision => [decision.submission_id, decision]));
  const workByEmployee = new Map(workerIds.map(id => [id, []]));
  if (!sourceLimited) for (const entry of entries) {
    const submission = submissionByHeader.get(entry.timesheet_id);
    workByEmployee.get(entry.employee_id).push({id: entry.id, date: entry.work_date, status: entry.status, hoursExact: canonicalHours(entry.hours), ...approvedWorkDisposition(entry, submission, submission && decisionBySubmission.get(submission.id))});
  }
  const inputs = workers.map(worker => ({employeeId: worker.id, capacity: calculateWorkerCapacity(sources.get(worker.id), startsOn, endsOn), rows: workByEmployee.get(worker.id)}));
  const result = calculateProjectContribution({projectId, startsOn, endsOn, workers: inputs, periodIsActual, sourceLimited});
  const inputCanonical = capacityCanonical({calculationVersion: PROJECT_CONTRIBUTION_VERSION, organizationId, legalEntityId, projectId, startsOn, endsOn, periodIsActual, capacity: [...sources], entries, submissions, decisions, sourceLimited});
  return {project, inputCanonical, result: {...result, sourceToken: capacityHash(inputCanonical), observedAt: clock.observed}, workers: sourceLimited ? [] : workers.map(({id, code, name}) => ({id, code, name}))};
};
