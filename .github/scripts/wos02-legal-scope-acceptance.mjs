import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const express = requireFromTarget('express');
const pg = requireFromTarget('pg');
const { registerOrganizationSetupRoutes } = await import(pathToFileURL(path.join(targetRoot, 'server/organization-setup.mjs')).href);
const pool = new pg.Pool({ connectionString: databaseUrl });
const userId = '00000000-0000-0000-0000-000000000301';
const headers = { 'x-organization-id': 'org-scope', 'x-legal-entity-id': 'legal-a' };
const failures = [];

const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error?.message || String(error), stack: error?.stack }); console.error(`FAIL ${name}: ${error?.stack || error}`); }
};

await pool.query(`insert into country_directors(id,name,region) values('cd-scope','Scope Director','Test') on conflict (id) do nothing`);
await pool.query(`insert into users(id,username,email,status) values($1,'scope-user','scope-user@example.test','Active') on conflict (id) do nothing`, [userId]);
await pool.query(`insert into organizations(id,code,name,effective_from) values('org-scope','ORG-SCOPE','Scope Organization','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values
  ('legal-a','org-scope','LEGAL-A','Legal A','2026-01-01'),
  ('legal-b-scope','org-scope','LEGAL-B','Legal B','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,'org-scope','legal-a',true) on conflict do nothing`, [userId]);
await pool.query(`insert into organization_catalog_items(id,organization_id,legal_entity_id,catalog_type,code,name,effective_from) values
  ('cat-a','org-scope','legal-a','department','DEPT-A','Department A','2026-01-01'),
  ('cat-b','org-scope','legal-b-scope','department','DEPT-B','Department B','2026-01-01'),
  ('cat-shared','org-scope',null,'department','DEPT-SHARED','Shared Department','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into working_calendars(id,organization_id,legal_entity_id,code,name,effective_from) values
  ('cal-a','org-scope','legal-a','CAL-A','Calendar A','2026-01-01'),
  ('cal-b','org-scope','legal-b-scope','CAL-B','Calendar B','2026-01-01'),
  ('cal-shared','org-scope',null,'CAL-SHARED','Shared Calendar','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on) values
  ('period-a','org-scope','legal-a','P-A','Period A','2026-01-01','2026-01-31'),
  ('period-b','org-scope','legal-b-scope','P-B','Period B','2026-01-01','2026-01-31'),
  ('period-shared','org-scope',null,'P-SHARED','Shared Period','2026-01-01','2026-01-31') on conflict (id) do nothing`);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values
  ('worker-a','W-A','Worker A','worker-a@example.test','Engineer','Delivery','Test','cd-scope','Active','org-scope','legal-a'),
  ('worker-b','W-B','Worker B','worker-b@example.test','Engineer','Delivery','Test','cd-scope','Active','org-scope','legal-b-scope') on conflict (id) do nothing`);
await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,lifecycle_status,effective_from) values
  ('worker-a','org-scope','legal-a','Active','2026-01-01'),
  ('worker-b','org-scope','legal-b-scope','Active','2026-01-01') on conflict (employee_id) do nothing`);
await pool.query(`insert into worker_history(employee_id,organization_id,effective_from,status,snapshot) values
  ('worker-a','org-scope','2026-01-01','Active','{"seed":true}'::jsonb),
  ('worker-b','org-scope','2026-01-01','Active','{"seed":true}'::jsonb) on conflict do nothing`);

const app = express();
app.use(express.json());
registerOrganizationSetupRoutes({
  app,
  pool,
  requireDatabase: (_req, _res, next) => next(),
  requireAuth: (req, _res, next) => { req.user = { sub: userId, name: 'Scope User', role: 'Admin' }; next(); },
  requirePermission: () => (_req, _res, next) => next(),
  audit: async () => {},
});
const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload; try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};
const onlyAuthorizedLegalRows = rows => rows.every(row => row.legal_entity_id == null || row.legal_entity_id === 'legal-a');
const denied = response => [403,404].includes(response.status);

try {
  await check('catalog list does not leak same-organization foreign legal entity', async () => {
    const response = await call('GET', '/api/organization-setup/catalogs/department?asOf=2026-02-01');
    assert.equal(response.status, 200);
    assert.equal(response.body.some(row => row.id === 'cat-b'), false);
    assert.equal(onlyAuthorizedLegalRows(response.body), true);
  });

  await check('calendar list does not leak same-organization foreign legal entity', async () => {
    const response = await call('GET', '/api/organization-setup/calendars?asOf=2026-02-01');
    assert.equal(response.status, 200);
    assert.equal(response.body.some(row => row.id === 'cal-b'), false);
    assert.equal(onlyAuthorizedLegalRows(response.body), true);
  });

  await check('reporting period list does not leak same-organization foreign legal entity', async () => {
    const response = await call('GET', '/api/organization-setup/reporting-periods');
    assert.equal(response.status, 200);
    assert.equal(response.body.some(row => row.id === 'period-b'), false);
    assert.equal(onlyAuthorizedLegalRows(response.body), true);
  });

  await check('worker dependency endpoint denies same-organization foreign legal entity', async () => {
    const response = await call('GET', '/api/organization-setup/workers/worker-b/dependencies');
    assert.equal(denied(response), true, `expected 403/404, got ${response.status}`);
  });

  await check('worker history endpoint denies same-organization foreign legal entity', async () => {
    const response = await call('GET', '/api/organization-setup/workers/worker-b/history');
    assert.equal(denied(response), true, `expected 403/404, got ${response.status}`);
  });

  await check('worker transition denies same-organization foreign legal entity with no write', async () => {
    const before = await pool.query(`select lifecycle_status from worker_profiles where employee_id='worker-b'`);
    const historyBefore = await pool.query(`select count(*)::int count from worker_history where employee_id='worker-b'`);
    const response = await call('POST', '/api/organization-setup/workers/worker-b/transition', {
      status: 'On Leave', effectiveFrom: '2026-02-01', reason: 'Cross-legal negative', idempotencyKey: 'cross-legal-worker-001',
    });
    assert.equal(denied(response), true, `expected 403/404, got ${response.status}`);
    const after = await pool.query(`select lifecycle_status from worker_profiles where employee_id='worker-b'`);
    const historyAfter = await pool.query(`select count(*)::int count from worker_history where employee_id='worker-b'`);
    assert.equal(after.rows[0].lifecycle_status, before.rows[0].lifecycle_status);
    assert.equal(historyAfter.rows[0].count, historyBefore.rows[0].count);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'passed', checks: 6 }, null, 2));
