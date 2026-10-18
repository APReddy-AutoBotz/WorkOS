import assert from 'node:assert/strict';
import express from 'express';
import {createAvailabilityReportRouter} from '../server/modules/reports/availability-report-router.mjs';

const events = [];
const queries = [];
let rows = [{
  employee_id: 'employee-a', employee_name: 'Synthetic Employee', standard_weekly_hours: '40.00',
  approved_leave_days: '2', holiday_days: '3', availability_hours: '2040.00',
}];
const guard = (name, status) => (req, res, next) => {
  events.push(name);
  if (req.get('x-deny') === name) return res.status(status).json({error: `${name} denied`});
  if (name === 'auth') {
    req.user = {activeRole: req.get('x-active-role') || 'Employee', employeeRecordId: 'employee-a'};
    req.organizationScope = {organizationId: 'org-a', legalEntityId: 'legal-a'};
  }
  next();
};
const dependencies = {
  requireDatabase: guard('database', 503),
  requireAuth: guard('auth', 401),
  requirePermission: permission => {
    assert.equal(permission, 'leave.self_service');
    return guard('permission', 403);
  },
  buildEmployeeScopeWhere(req, params, alias) {
    events.push('scope');
    assert.equal(alias, 'e');
    assert.deepEqual(req.organizationScope, {organizationId: 'org-a', legalEntityId: 'legal-a'});
    assert.deepEqual(params, []);
    params.push(req.organizationScope.organizationId, req.organizationScope.legalEntityId);
    if (req.user.activeRole === 'Employee') {
      params.push(req.user.employeeRecordId);
      return 'e.organization_id=$1 and e.legal_entity_id=$2 and e.id=$3';
    }
    return 'e.organization_id=$1 and e.legal_entity_id=$2';
  },
  async run(res, sql, params) {
    events.push('query');
    queries.push({sql, params});
    // The application owns database execution and its unchanged legacy failure response.
    if (res.req.get('x-query-failure')) return res.status(500).json({error: 'Database operation failed'});
    res.json(rows);
  },
};

for (const key of Object.keys(dependencies)) {
  for (const invalid of [undefined, null, {}]) {
    assert.throws(() => createAvailabilityReportRouter({...dependencies, [key]: invalid}), TypeError,
      `missing/invalid ${key} must refuse router construction`);
  }
}
const router = createAvailabilityReportRouter(dependencies);
assert.deepEqual(router.stack.map(layer => ({path: layer.route?.path, methods: layer.route?.methods})), [
  {path: '/reports/availability', methods: {get: true}},
], 'the seam exposes exactly the existing read-only route');
const app = express();
app.use('/api', router);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const get = (path = '/api/reports/availability', headers = {}) => fetch(`${baseUrl}${path}`, {
  headers, signal: AbortSignal.timeout(5000),
});

try {
  for (const [name, status, expected] of [
    ['database', 503, ['database']],
    ['auth', 401, ['database', 'auth']],
    ['permission', 403, ['database', 'auth', 'permission']],
  ]) {
    events.length = 0;
    const queryCount = queries.length;
    const response = await get(undefined, {'x-deny': name});
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {error: `${name} denied`});
    assert.deepEqual(events, expected);
    assert.equal(queries.length, queryCount, 'denied requests must not resolve scope or execute a query');
  }

  for (const role of ['Employee', 'Admin']) {
    events.length = 0;
    const beforeYear = new Date().getFullYear();
    const response = await get('/api/reports/availability?year=1900&employee_id=foreign&organizationId=foreign&legalEntityId=foreign', {
      'x-active-role': role,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), rows, 'database row names and numeric strings pass through unchanged');
    assert.deepEqual(events, ['database', 'auth', 'permission', 'scope', 'query']);
    const {sql, params} = queries.at(-1);
    const scopeParams = role === 'Employee' ? ['org-a', 'legal-a', 'employee-a'] : ['org-a', 'legal-a'];
    assert.deepEqual(params.slice(0, -1), scopeParams);
    assert.ok([beforeYear, new Date().getFullYear()].includes(params.at(-1)), 'the server selects the current local-calendar year');
    const yearParameter = `\\$${params.length}`;
    assert.match(sql, new RegExp(`status = 'Approved' and extract\\(year from start_date\\)::int = ${yearParameter}`));
    assert.match(sql, new RegExp(`hc.calendar_year = ${yearParameter}`));
    assert.match(sql, /sum\(total_days\) as approved_leave_days/);
    assert.match(sql, /hc.status = 'Active'/);
    assert.match(sql, /hc.country = e.country or hc.country = 'Global'/);
    assert.match(sql, /where e.status <> 'Exited' and e.organization_id=\$1 and e.legal_entity_id=\$2/);
    assert.match(sql, /greatest\(0, \(e.standard_weekly_hours \* 52\) - \(\(coalesce\(l.approved_leave_days, 0\) \+ coalesce\(h.holiday_days, 0\)\) \* \(e.standard_weekly_hours \/ 5\)\)\)::numeric as availability_hours/);
    assert.match(sql, /order by e.name/);
    assert.doesNotMatch(sql, /1900|foreign|\b(?:insert|update|delete)\b/i);
  }

  rows = [];
  const empty = await get();
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
  const failure = await get(undefined, {'x-query-failure': 'true'});
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), {error: 'Database operation failed'});
  for (const [path, method] of [
    ['/api/v1/reports/availability', 'GET'], ['/api/reports/availability', 'POST'],
  ]) {
    events.length = 0;
    const response = await fetch(`${baseUrl}${path}`, {method, signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 404);
    await response.text();
    assert.deepEqual(events, [], 'no new versioned alias or mutation route is registered');
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('Availability report router: route, guard order, scope plumbing, legacy response and query contracts passed.');
