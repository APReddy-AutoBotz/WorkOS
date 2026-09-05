// Controller-only PostgreSQL acceptance for WOS-02 demo-seed ownership, identity and lifecycle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!root || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');
const { Pool } = createRequire(path.join(root, 'package.json'))('pg');
const pool = new Pool({ connectionString: databaseUrl });
const ORG = 'org-default';
const LEGAL = 'legal-default';
const PASSWORD = 'synthetic-demo-seed-password';

const runSeed = ({ reset = false, password = PASSWORD, appMode = 'test', nodeEnv = 'test' } = {}) => {
  const args = ['run', 'api:seed:demo', '--'];
  if (reset) args.push('--reset');
  return spawnSync('npm', args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl, DEMO_SEED_PASSWORD: password, APP_MODE: appMode, NODE_ENV: nodeEnv },
    encoding: 'utf8',
  });
};
const expectSuccess = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const expectFailure = result => assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
const q = (text, params = []) => pool.query(text, params);
const scalar = async (text, params = []) => Number((await q(text, params)).rows[0].n);
const ids = async (text, params = []) => (await q(text, params)).rows.map(row => Object.values(row)[0]).sort();

const assertOwnedReferences = async () => {
  for (const table of ['clients','employees','projects','project_allocations','timesheets']) {
    assert.equal(await scalar(`select count(*) n from ${table} where organization_id<>$1 or legal_entity_id<>$2`, [ORG, LEGAL]), 0, `${table} contains non-demo ownership`);
  }
  assert.equal(await scalar(`select count(*) n from projects p join clients c on c.id=p.client_id where p.organization_id<>c.organization_id or p.legal_entity_id<>c.legal_entity_id`), 0);
  assert.equal(await scalar(`select count(*) n from project_allocations a join employees e on e.id=a.employee_id join projects p on p.id=a.project_id where a.organization_id<>e.organization_id or a.legal_entity_id<>e.legal_entity_id or a.organization_id<>p.organization_id or a.legal_entity_id<>p.legal_entity_id`), 0);
  assert.equal(await scalar(`select count(*) n from timesheets t join employees e on e.id=t.employee_id where t.organization_id<>e.organization_id or t.legal_entity_id<>e.legal_entity_id`), 0);
};

const assertIdentityLifecycle = async () => {
  const employees = (await q(`select id,employee_id,status from employees where organization_id=$1 and legal_entity_id=$2 order by id`, [ORG, LEGAL])).rows;
  assert.ok(employees.length > 0, 'demo employees were not seeded');
  for (const employee of employees) {
    const userRows = (await q(`select id,status,employee_record_id from users where employee_record_id=$1`, [employee.id])).rows;
    assert.equal(userRows.length, 1, `employee ${employee.id} must have one authoritative user`);
    const user = userRows[0];
    assert.equal(user.employee_record_id, employee.id);
    assert.equal(user.status, employee.status === 'Exited' ? 'Disabled' : 'Active');
    const scopes = (await q(`select organization_id,legal_entity_id,active from user_organization_scopes where user_id=$1`, [user.id])).rows;
    assert.deepEqual(scopes, [{ organization_id: ORG, legal_entity_id: LEGAL, active: employee.status !== 'Exited' }]);
    const roles = (await q(`select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1 order by r.name`, [user.id])).rows.map(row => row.name);
    const expected = employee.employee_id === 'ADMIN-1' ? ['Admin']
      : employee.employee_id === 'HR-1' ? ['HR']
      : employee.employee_id.startsWith('CD-') ? ['CountryDirector']
      : employee.employee_id === 'PM-1' ? ['Employee','ProjectManager','TeamLead']
      : employee.employee_id.startsWith('PM-') ? ['Employee','ProjectManager']
      : ['Employee'];
    assert.deepEqual(roles, expected.sort(), `roles mismatch for ${employee.employee_id}`);
    const profiles = (await q(`select organization_id,legal_entity_id,lifecycle_status from worker_profiles where employee_id=$1`, [employee.id])).rows;
    assert.equal(profiles.length, 1, `employee ${employee.id} must have one current profile`);
    assert.equal(profiles[0].organization_id, ORG);
    assert.equal(profiles[0].legal_entity_id, LEGAL);
    assert.equal(profiles[0].lifecycle_status, employee.status === 'Exited' ? 'Exited' : employee.status === 'On Leave' ? 'On Leave' : 'Active');
    const history = (await q(`select organization_id,legal_entity_id,status from worker_history where employee_id=$1 order by effective_from,id`, [employee.id])).rows;
    assert.equal(history.length, 1, `employee ${employee.id} must have exactly one initial history row`);
    assert.equal(history[0].organization_id, ORG);
    assert.equal(history[0].legal_entity_id, LEGAL);
  }
};

const snapshot = async () => ({
  clients: await scalar('select count(*) n from clients'),
  employees: await scalar('select count(*) n from employees'),
  projects: await scalar('select count(*) n from projects'),
  allocations: await scalar('select count(*) n from project_allocations'),
  timesheets: await scalar('select count(*) n from timesheets'),
  users: await scalar('select count(*) n from users'),
  scopes: await scalar('select count(*) n from user_organization_scopes'),
  profiles: await scalar('select count(*) n from worker_profiles'),
  history: await scalar('select count(*) n from worker_history'),
  employeeIds: await ids('select id from employees order by id'),
  clientIds: await ids('select id from clients order by id'),
  projectIds: await ids('select id from projects order by id'),
  allocationIds: await ids('select id from project_allocations order by id'),
});

try {
  const before = await snapshot();
  expectFailure(runSeed({ appMode: 'production', nodeEnv: 'production' }));
  expectFailure(runSeed({ password: '' }));
  assert.deepEqual(await snapshot(), before, 'fail-closed attempts mutated authoritative state');

  const first = runSeed();
  expectSuccess(first);
  await assertOwnedReferences();
  await assertIdentityLifecycle();
  const seeded = await snapshot();
  assert.ok(seeded.employees > 0 && seeded.clients > 0 && seeded.projects > 0 && seeded.allocations > 0 && seeded.timesheets > 0);

  expectSuccess(runSeed());
  await assertOwnedReferences();
  await assertIdentityLifecycle();
  assert.deepEqual(await snapshot(), seeded, 'replay changed demo counts or stable identifiers');

  await q(`insert into organizations(id,code,name,status,effective_from) values('org-demo-sentinel','ORG-DEMO-SENTINEL','Demo Sentinel Org','Active','2026-01-01') on conflict(id) do nothing`);
  await q(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values('legal-demo-sentinel','org-demo-sentinel','LEGAL-DEMO-SENTINEL','Demo Sentinel Legal','ZZ','Active','2026-01-01') on conflict(id) do nothing`);
  await q(`insert into country_directors(id,name,region) values('cd-demo-sentinel','Demo Sentinel Director','Synthetic') on conflict(id) do nothing`);
  await q(`insert into roles(name) values('DemoSentinelRole') on conflict(name) do nothing`);
  await q(`insert into catalog_items(id,catalog_type,name,active,created_at,updated_at) values('demo-sentinel-catalog','sentinel','Demo Sentinel Catalog',true,now(),now()) on conflict(id) do nothing`);

  expectSuccess(runSeed({ reset: true }));
  await assertOwnedReferences();
  await assertIdentityLifecycle();
  const resetState = await snapshot();
  assert.deepEqual(resetState.employeeIds, seeded.employeeIds);
  assert.deepEqual(resetState.clientIds, seeded.clientIds);
  assert.deepEqual(resetState.projectIds, seeded.projectIds);
  assert.deepEqual(resetState.allocationIds, seeded.allocationIds);
  assert.equal(await scalar(`select count(*) n from organizations where id='org-demo-sentinel'`), 1);
  assert.equal(await scalar(`select count(*) n from legal_entities where id='legal-demo-sentinel' and organization_id='org-demo-sentinel'`), 1);
  assert.equal(await scalar(`select count(*) n from country_directors where id='cd-demo-sentinel'`), 1);
  assert.equal(await scalar(`select count(*) n from roles where name='DemoSentinelRole'`), 1);
  assert.equal(await scalar(`select count(*) n from catalog_items where id='demo-sentinel-catalog'`), 1);

  const collisionId = resetState.clientIds[0];
  await q(`delete from timesheet_entries where timesheet_id in (select id from timesheets where organization_id=$1 and legal_entity_id=$2)`, [ORG, LEGAL]);
  await q(`delete from timesheets where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from project_allocations where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from worker_history where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from worker_profiles where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from user_roles where user_id in (select id from users where employee_record_id in (select id from employees where organization_id=$1 and legal_entity_id=$2))`, [ORG, LEGAL]);
  await q(`delete from user_organization_scopes where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from users where employee_record_id in (select id from employees where organization_id=$1 and legal_entity_id=$2)`, [ORG, LEGAL]);
  await q(`delete from projects where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from employees where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`delete from clients where organization_id=$1 and legal_entity_id=$2`, [ORG, LEGAL]);
  await q(`insert into clients(id,name,status,organization_id,legal_entity_id) values($1,'Foreign Collision','Active','org-demo-sentinel','legal-demo-sentinel')`, [collisionId]);
  const cleanBeforeCollision = await snapshot();
  expectFailure(runSeed());
  assert.deepEqual(await snapshot(), cleanBeforeCollision, 'collision failure left partial demo state');
  assert.equal(await scalar(`select count(*) n from clients where id=$1 and organization_id='org-demo-sentinel' and legal_entity_id='legal-demo-sentinel'`, [collisionId]), 1, 'foreign collision was adopted');

  console.log('PASS WOS-02 demo-seed ownership, identity, lifecycle, replay, reset and collision matrix');
} finally {
  await pool.end();
}
