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
const failures = [];

const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error), stack: error?.stack });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
  }
};

const uuid = '00000000-0000-0000-0000-000000000201';
const orgHeaders = (organizationId, legalEntityId) => ({
  'x-organization-id': organizationId,
  'x-legal-entity-id': legalEntityId,
});

await pool.query(`insert into country_directors(id,name,region) values('cd-accept','Acceptance Director','Test') on conflict (id) do nothing`);
await pool.query(`insert into users(id,username,email,status) values($1,'wos02-acceptance','wos02-acceptance@example.test','Active') on conflict (id) do nothing`, [uuid]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,'org-default','legal-default',true) on conflict do nothing`, [uuid]);
await pool.query(`insert into organizations(id,code,name,effective_from) values('org-b','ORG-B','Organization B','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values('legal-b','org-b','LEGAL-B','Legal B','2026-01-01'),('legal-c','org-b','LEGAL-C','Legal C','2026-01-01') on conflict (id) do nothing`);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,'org-b','legal-b',true) on conflict do nothing`, [uuid]);

const app = express();
app.use(express.json());
registerOrganizationSetupRoutes({
  app,
  pool,
  requireDatabase: (_req, _res, next) => next(),
  requireAuth: (req, _res, next) => { req.user = { sub: uuid, name: 'Acceptance User', role: 'Admin' }; next(); },
  requirePermission: () => (_req, _res, next) => next(),
  audit: async () => {},
});
const server = await new Promise(resolve => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, route, { headers = {}, body } = {}) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};

try {
  await check('scope requires deterministic selection when multiple scopes exist', async () => {
    const response = await call('GET', '/api/organization-setup/context');
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ORG_SCOPE_DENIED');
  });

  await check('valid persisted organization/legal-entity scope resolves', async () => {
    const response = await call('GET', '/api/organization-setup/context', { headers: orgHeaders('org-b', 'legal-b') });
    assert.equal(response.status, 200);
    assert.equal(response.body.organization_id, 'org-b');
    assert.equal(response.body.legal_entity_id, 'legal-b');
  });

  await check('caller cannot spoof another organization', async () => {
    const response = await call('GET', '/api/organization-setup/context', { headers: orgHeaders('org-unknown', 'legal-b') });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ORG_SCOPE_DENIED');
  });

  await check('caller cannot spoof another legal entity', async () => {
    const response = await call('POST', '/api/organization-setup/catalogs/department', {
      headers: orgHeaders('org-b', 'legal-b'),
      body: { code: 'LEGAL-SPOOF', name: 'Spoof', effectiveFrom: '2026-01-01', legalEntityId: 'legal-default' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'LEGAL_SCOPE_DENIED');
  });

  await check('readiness ignores caller completion hints and derives persisted facts', async () => {
    const response = await call('GET', '/api/organization-setup/readiness?ready=true&completed=true', { headers: orgHeaders('org-b', 'legal-b') });
    assert.equal(response.status, 200);
    assert.equal(response.body.authority, 'persisted-server-state');
    assert.equal(response.body.ready, false);
    assert.equal(response.body.checks.organization, true);
    assert.equal(response.body.checks.legal_entity, true);
  });

  await check('concurrent same-version catalog creation is deterministic', async () => {
    const request = () => call('POST', '/api/organization-setup/catalogs/department', {
      headers: orgHeaders('org-b', 'legal-b'),
      body: { code: 'DEPT-CONCURRENT', name: 'Concurrent Department', effectiveFrom: '2026-01-01' },
    });
    const results = await Promise.all([request(), request()]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  });

  await check('effective-dated catalog resolution returns the single current version', async () => {
    for (const body of [
      { code: 'DEPT-HISTORY', name: 'Department v1', effectiveFrom: '2026-01-01' },
      { code: 'DEPT-HISTORY', name: 'Department v2', effectiveFrom: '2026-06-01' },
    ]) {
      const response = await call('POST', '/api/organization-setup/catalogs/department', { headers: orgHeaders('org-b', 'legal-b'), body });
      assert.equal(response.status, 201);
    }
    const current = await call('GET', '/api/organization-setup/catalogs/department?asOf=2026-07-01', { headers: orgHeaders('org-b', 'legal-b') });
    assert.equal(current.status, 200);
    const versions = current.body.filter(item => item.code === 'DEPT-HISTORY');
    assert.equal(versions.length, 1, `expected one effective DEPT-HISTORY version, got ${versions.length}`);
    assert.equal(versions[0].name, 'Department v2');
    const prior = await call('GET', '/api/organization-setup/catalogs/department?asOf=2026-03-01', { headers: orgHeaders('org-b', 'legal-b') });
    const priorVersions = prior.body.filter(item => item.code === 'DEPT-HISTORY');
    assert.equal(priorVersions.length, 1);
    assert.equal(priorVersions[0].name, 'Department v1');
  });

  await check('catalog parent cannot cross legal-entity scope', async () => {
    const parent = await pool.query(`insert into organization_catalog_items(organization_id,legal_entity_id,catalog_type,code,name,effective_from) values('org-b','legal-c','department','DEPT-LEGAL-C','Legal C Department','2026-01-01') returning id`);
    const response = await call('POST', '/api/organization-setup/catalogs/department', {
      headers: orgHeaders('org-b', 'legal-b'),
      body: { code: 'DEPT-CHILD', name: 'Child Department', parentId: parent.rows[0].id, effectiveFrom: '2026-01-01' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'INVALID_CATALOG_PARENT');
  });

  await check('retirement route cannot retire a different catalog type', async () => {
    const item = await pool.query(`insert into organization_catalog_items(organization_id,legal_entity_id,catalog_type,code,name,effective_from) values('org-b','legal-b','region','REGION-MISMATCH','Mismatch Region','2026-01-01') returning id`);
    const response = await call('POST', `/api/organization-setup/catalogs/worker_type/${item.rows[0].id}/retire`, { headers: orgHeaders('org-b', 'legal-b') });
    assert.notEqual(response.status, 200, 'wrong catalog-type route must not mutate the item');
    const state = await pool.query('select active from organization_catalog_items where id=$1', [item.rows[0].id]);
    assert.equal(state.rows[0].active, true);
  });

  await check('database enforces legal entity belongs to record organization', async () => {
    const client = await pool.connect();
    let rejected = false;
    try {
      await client.query('begin');
      try {
        await client.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('e-cross-legal','E-CROSS','Cross Legal','cross-legal@example.test','Engineer','Delivery','Test','cd-accept','Active','org-b','legal-default')`);
      } catch (error) {
        rejected = true;
      }
      await client.query('rollback');
    } finally { client.release(); }
    assert.equal(rejected, true, 'cross-organization legal entity assignment must be rejected by database constraints');
  });

  await check('employee identifier uniqueness is organization-scoped', async () => {
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('e-dup-default','E-DUP','Dup Default','dup-default@example.test','Engineer','Delivery','Test','cd-accept','Active','org-default','legal-default')`);
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('e-dup-b','E-DUP','Dup B','dup-b@example.test','Engineer','Delivery','Test','cd-accept','Active','org-b','legal-b')`);
    await assert.rejects(() => pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('e-dup-b2','E-DUP','Dup B2','dup-b2@example.test','Engineer','Delivery','Test','cd-accept','Active','org-b','legal-b')`), error => error?.code === '23505');
  });

  const workerType = await pool.query(`insert into organization_catalog_items(organization_id,legal_entity_id,catalog_type,code,name,effective_from) values('org-b','legal-b','worker_type','WT-DELIVERY','Delivery Worker','2026-01-01') returning id`);

  const seedWorker = async ({ id, employeeId, email, withAllocation = false }) => {
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,$2,$3,$4,'Engineer','Delivery','Test','cd-accept','Active','org-b','legal-b')`, [id, employeeId, id, email]);
    await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,worker_type_id,lifecycle_status,effective_from) values($1,'org-b','legal-b',$2,'Active','2026-01-01')`, [id, workerType.rows[0].id]);
    await pool.query(`insert into worker_history(employee_id,organization_id,effective_from,status,snapshot) values($1,'org-b','2026-01-01','Active',$2::jsonb)`, [id, JSON.stringify({ status: 'Active', seeded: true })]);
    if (withAllocation) {
      const projectId = `p-${id}`;
      await pool.query(`insert into projects(id,project_code,name,client,manager_name,billable,start_date,end_date,status,organization_id,legal_entity_id) values($1,$2,$3,'Synthetic','Acceptance Manager',true,'2026-01-01','2026-12-31','Active','org-b','legal-b')`, [projectId, `P-${employeeId}`, `Project ${employeeId}`]);
      await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id) values($1,$2,$3,100,'2026-01-01','2026-12-31',true,'Active','org-b')`, [`a-${id}`, id, projectId]);
    }
  };

  await seedWorker({ id: 'e-dependency', employeeId: 'E-DEPENDENCY', email: 'dependency@example.test', withAllocation: true });
  await check('worker disable fails closed with active dependencies and no write', async () => {
    const response = await call('POST', '/api/organization-setup/workers/e-dependency/transition', {
      headers: orgHeaders('org-b', 'legal-b'),
      body: { status: 'Disabled', effectiveFrom: '2026-02-01', reason: 'Acceptance dependency test', idempotencyKey: 'dependency-transition-001' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'WORKER_DEPENDENCY_CONFLICT');
    const state = await pool.query(`select lifecycle_status from worker_profiles where employee_id='e-dependency'`);
    assert.equal(state.rows[0].lifecycle_status, 'Active');
    const history = await pool.query(`select count(*)::int count from worker_history where employee_id='e-dependency'`);
    assert.equal(history.rows[0].count, 1);
  });

  await seedWorker({ id: 'e-history', employeeId: 'E-HISTORY', email: 'history@example.test' });
  await check('worker lifecycle history resolves prior version and replay is idempotent', async () => {
    const body = { status: 'On Leave', effectiveFrom: '2026-02-01', reason: 'Acceptance history test', idempotencyKey: 'history-transition-001' };
    const first = await call('POST', '/api/organization-setup/workers/e-history/transition', { headers: orgHeaders('org-b', 'legal-b'), body });
    assert.equal(first.status, 200);
    assert.equal(first.body.replayed, false);
    const second = await call('POST', '/api/organization-setup/workers/e-history/transition', { headers: orgHeaders('org-b', 'legal-b'), body });
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    const history = await pool.query(`select status,effective_from::text,effective_to::text from worker_history where employee_id='e-history' order by effective_from`);
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows[0].effective_to, '2026-01-31');
    assert.equal(history.rows[1].status, 'On Leave');
    assert.equal(history.rows[1].effective_to, null);
  });

  await check('backdated worker transition returns stable conflict with no write', async () => {
    const before = await pool.query(`select count(*)::int count from worker_history where employee_id='e-history'`);
    const response = await call('POST', '/api/organization-setup/workers/e-history/transition', {
      headers: orgHeaders('org-b', 'legal-b'),
      body: { status: 'Active', effectiveFrom: '2025-12-01', reason: 'Stale transition test', idempotencyKey: 'history-transition-stale-001' },
    });
    assert.equal(response.status, 409, `expected stable conflict, got ${response.status}`);
    const after = await pool.query(`select count(*)::int count from worker_history where employee_id='e-history'`);
    assert.equal(after.rows[0].count, before.rows[0].count);
    const profile = await pool.query(`select lifecycle_status from worker_profiles where employee_id='e-history'`);
    assert.equal(profile.rows[0].lifecycle_status, 'On Leave');
  });

  await check('worker-type retirement fails closed while active worker references it', async () => {
    const response = await call('POST', `/api/organization-setup/catalogs/worker_type/${workerType.rows[0].id}/retire`, { headers: orgHeaders('org-b', 'legal-b') });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CATALOG_IN_USE');
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'passed', checks: 16 }, null, 2));
