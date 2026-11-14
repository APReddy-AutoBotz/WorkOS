import assert from 'node:assert/strict';
import {commercialFixture as f, withCommercialDatabase, migrateCommercialDatabase, withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedActualWork, adoptActualInputs, actualEntries, actualCapacityDefinition} from './support/actual-work-test.mjs';
import {calculateScopedProjectContribution} from '../server/modules/planning/project-contribution-service.mjs';
import {loadCapacitySourcesBatch, loadCapacitySources} from '../server/modules/planning/worker-capacity-service.mjs';
import {readProjectContributionResult} from '../shared/project-contribution.mjs';

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const {identities, today, next} = await seedActualWork(pool);
  const req = {organizationScope: {organizationId: f.organizationId, legalEntityId: f.legalEntityId}};
  const scopeWhere = (_req, params, alias) => {
    const organization = params.push(f.organizationId), legal = params.push(f.legalEntityId);
    return `${alias}.organization_id=$${organization} and ${alias}.legal_entity_id=$${legal}`;
  };
  const boundaries = {buildProjectScopeWhere: scopeWhere, buildEmployeeScopeWhere: scopeWhere};
  const read = async (overrides = {}, from = today, to = today, project = f.projectId) => {
    const client = await pool.connect(); let queries = 0;
    try {
      await client.query('begin isolation level repeatable read');
      const counted = {query: (...args) => { queries++; return client.query(...args); }};
      const report = await calculateScopedProjectContribution(counted, req, project, from, to, {...boundaries, ...overrides});
      readProjectContributionResult(report.result, project, from, to);
      await client.query('commit');
      return {...report, queries};
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  };
  await withCommercialApi({databaseUrl, identities}, async ({request}) => {
    await adoptActualInputs(request, today);
    const work = await request('/api/timesheets', {method: 'POST', identity: identities.reader, body: {employee_id: f.ownerId, week_ending: today, status: 'Submitted', entries: actualEntries(today)}});
    assert.equal(work.status, 200, JSON.stringify(work.body));
    assert.equal((await request(`/api/timesheets/${work.body.id}/status`, {method: 'PATCH', body: {status: 'Approved'}})).status, 200);
    const first = await read();
    assert.equal(first.result.status, 'available');
    assert.equal(first.result.workerCount, 1);
    assert.equal(first.result.includedHoursExact, '2', 'non-project work cannot enter project numerator');
    assert.equal(first.result.eligibleAvailableHoursExact, '8');
    assert.equal(first.result.percentage.displayPercent, '25');
    assert.equal(first.queries, 13);
    const endpoint = '/api/v1/project-contribution/projects/' + f.projectId + '/period?' + new URLSearchParams({startsOn: today, endsOn: today});
    let response = await request(endpoint);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual({...response.body.result, observedAt: first.result.observedAt}, first.result);
    assert.equal(response.body.inputCanonical, undefined);
    assert.equal((await request(endpoint, {authenticated: false})).status, 401);
    assert.equal((await request(endpoint, {identity: identities.reader})).status, 403);
    assert.equal((await request(endpoint, {scope: {organizationId: f.organizationId, legalEntityId: f.otherLegalEntityId}})).status, 403);
    assert.equal((await request(endpoint + '&employeeId=' + f.foreignOwnerId)).status, 400);
    assert.equal((await request(endpoint.replace(f.projectId, f.foreignClientId))).status, 404);
    for (const permission of ['projects.view', 'employees.view', 'reports.view_utilization']) {
      await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key=$1", [permission]);
      assert.equal((await request(endpoint)).status, 403, permission + ' must be checked live');
      await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key=$1", [permission]);
    }
    assert.doesNotMatch(JSON.stringify(first.result), /Synthetic included|remark|evidence_url|cost_rate|margin/);
    await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)values('synthetic-project-duplicate',$1,$2,0,$3,$3,true,'Active',$4,$5)`, [f.ownerId, f.projectId, today, f.organizationId, f.legalEntityId]);
    const duplicate = await read();
    assert.equal(duplicate.result.workerCount, 1);
    assert.equal(duplicate.result.percentage.displayPercent, '25');
    const secondId = 'synthetic-project-second';
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values($1,$1,'Synthetic second worker','second-project@example.test','Consultant','Delivery','US','director-commercial','Active',$2,$3)`, [secondId, f.organizationId, f.legalEntityId]);
    const partTimeProfile = await request('/api/v1/worker-capacity/workers/' + secondId + '/profiles', {method: 'POST', body: {expectedLatestId: null, effectiveFrom: today, definition: {...actualCapacityDefinition, partTimePercentExact: '50', hoursByWeekdayExact: Array(7).fill('4')}, reason: 'Synthetic explicit part-time project capacity'}});
    assert.equal(partTimeProfile.status, 201, JSON.stringify(partTimeProfile.body));
    const partTimeAssignment = await request('/api/allocations', {method: 'POST', body: {employee_id: secondId, project_id: f.projectId, percentage: 20, start_date: today, end_date: today, billable: true, status: 'Active'}});
    assert.equal(partTimeAssignment.status, 200, JSON.stringify(partTimeAssignment.body));
    const second = await read();
    assert.equal(second.result.workerCount, 2);
    assert.equal(second.result.eligibleAvailableHoursExact, '12');
    assert.equal(second.result.percentage.displayPercent, '16.67');
    assert.equal(second.result.percentage.numeratorExact, '50');
    assert.equal(second.result.percentage.denominatorExact, '3');
    assert.equal(second.queries, first.queries, 'queries must not grow with the worker cohort');
    const ownWhere = (request, params, alias) => { const where = scopeWhere(request, params, alias); return `${where} and ${alias}.id=$${params.push(f.ownerId)}`; };
    const own = await read({buildEmployeeScopeWhere: ownWhere});
    assert.equal(own.result.workerCount, 1);
    assert.equal(own.result.percentage.displayPercent, '25');
    assert.equal(own.workers.some(worker => worker.id === secondId), false);
    const empty = await read({buildEmployeeScopeWhere: () => 'false'});
    assert.equal(empty.result.status, 'not_applicable');
    assert.deepEqual(empty.result.reasonCodes, ['NO_VISIBLE_COHORT']);
    await assert.rejects(read({buildProjectScopeWhere: () => 'false'}), {statusCode: 404});
    await assert.rejects(read({}, today, today, 'missing-project'), {statusCode: 404});
    await assert.rejects(read({}, 'invalid', today), {statusCode: 400});
    assert.equal((await read({}, today, next)).result.status, 'unavailable');
    const workers = (await pool.query(`select id,status,legal_entity_id "legalEntityId",null::text "joiningDate",null::text "exitDate" from employees where id=any($1::text[]) order by id`, [[f.ownerId, secondId]])).rows;
    let batchQueries = 0;
    const batch = await loadCapacitySourcesBatch({query: (...args) => {batchQueries++; return pool.query(...args);}}, req, workers, today, today);
    assert.equal(batchQueries, 7);
    for (const worker of workers) assert.deepEqual(batch.get(worker.id), await loadCapacitySources(pool, req, worker, today, today));
    await assert.rejects(loadCapacitySourcesBatch(pool, req, [{...workers[0], legalEntityId: f.otherLegalEntityId}], today, today), {statusCode: 400});
    await assert.rejects(loadCapacitySourcesBatch(pool, req, [workers[0], workers[0]], today, today), {statusCode: 400});
    // Explicit existing approved absence fixture, not an intake/approval API
    // journey: the real clock can fall on a weekend rejected by legacy intake.
    await pool.query(`insert into leave_requests(id,employee_id,leave_type_id,start_date,end_date,total_days,status,reason)values('synthetic-project-half-absence',$1,'leave-type-annual',$2,$2,0.5,'Approved','Synthetic existing per-date absence')`, [secondId, today]);
    const absent = await read();
    assert.equal(absent.result.eligibleAvailableHoursExact, '10');
    assert.equal(absent.result.percentage.displayPercent, '20');
    assert.notEqual(absent.result.sourceToken, second.result.sourceToken);
    await pool.query(`insert into working_calendar_holidays(id,organization_id,calendar_id,holiday_date,label,holiday_type,active,effective_from)values('synthetic-project-holiday',$1,'synthetic-actual-calendar',$2,'Synthetic project holiday','Company',true,'1970-01-01')`, [f.organizationId, today]);
    const holidaySources = await loadCapacitySources(pool, req, workers.find(worker => worker.id === secondId), today, today);
    const {calculateWorkerCapacity} = await import('../server/modules/planning/capacity-resolver.mjs');
    const holidayCapacity = calculateWorkerCapacity(holidaySources, today, today);
    assert.equal(holidayCapacity.totals.holidayReductionHoursExact, '4');
    assert.equal(holidayCapacity.totals.leaveReductionHoursExact, '0', 'holiday and approved leave must reduce capacity only once');
    const holiday = await read();
    assert.equal(holiday.result.status, 'not_applicable');
    assert.equal(holiday.result.eligibleAvailableHoursExact, '0');
    assert.equal(holiday.result.percentage, null);
    assert.equal(holiday.result.includedHoursExact, '2');
    // Real draft source overflow must withhold the roster as well as totals.
    // Do not mutate approved evidence to construct the boundary fixture.
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) select 'synthetic-cohort-'||n,'SYN-COHORT-'||n,'Synthetic cohort worker','cohort-'||n||'@example.test','Consultant','Delivery','US','director-commercial','Active',$1,$2 from generate_series(1,499)n`, [f.organizationId, f.legalEntityId]);
    await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id) select 'synthetic-cohort-assignment-'||n,'synthetic-cohort-'||n,$1,0,$2,$2,true,'Active',$3,$4 from generate_series(1,498)n`, [f.projectId, today, f.organizationId, f.legalEntityId]);
    // Keep each header small: deferred work guards revalidate the full header
    // for each entry. The real project still exceeds the unchanged 10000 limit.
    const overflowWorkers = [secondId, ...Array.from({length: 498}, (_, index) => 'synthetic-cohort-' + (index + 1))];
    const overflowHeaders = (await pool.query(`insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
      select id,$2,'Draft',0,0,$3,$4 from unnest($1::text[]) worker(id) returning id`, [overflowWorkers, today, f.organizationId, f.legalEntityId])).rows.map(row => row.id);
    await pool.query(`insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,remark,billable,category_code)
      select id,$2,'Project Work',$3::date,0,'Synthetic bounded-source fixture',true,'BILL' from unnest($1::uuid[]) header(id) cross join generate_series(1,21)n order by id,n limit 10001`, [overflowHeaders, f.projectId, today]);
    const overflow = await request(endpoint);
    assert.equal(overflow.status, 200, JSON.stringify(overflow.body));
    readProjectContributionResult(overflow.body.result, f.projectId, today, today);
    assert.deepEqual(overflow.body.result.reasonCodes, ['PROJECT_SOURCE_LIMIT']);
    assert.equal(overflow.body.result.rows, null);
    assert.equal(overflow.body.result.controls, null);
    assert.equal(overflow.body.result.workerCount, null);
    assert.deepEqual(overflow.body.workers, [], 'source-limited reports must not expose a partial roster');
    await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id) values('synthetic-cohort-assignment-499','synthetic-cohort-499',$1,0,$2,$2,true,'Active',$3,$4)`, [f.projectId, today, f.organizationId, f.legalEntityId]);
    const limited = await read();
    assert.equal(limited.result.status, 'unavailable');
    assert.deepEqual(limited.result.reasonCodes, ['PROJECT_SOURCE_LIMIT']);
    assert.equal(limited.result.workerCount, null);
    assert.equal(limited.result.percentage, null);
    assert.deepEqual(limited.workers, []);
    assert.equal(limited.queries, 3, 'oversize cohort must stop before capacity and work reads');
  });
});
console.log('Project contribution real PostgreSQL evidence, scoped cohort, duplicate assignments, exact project-only totals, denied/missing/empty/future cases and constant batch query counts passed.');
