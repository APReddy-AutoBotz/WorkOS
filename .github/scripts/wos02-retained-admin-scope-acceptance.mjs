import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const pg = requireFromTarget('pg');
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
const hashPassword = async password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
  return `scrypt$${salt}$${key}`;
};

const adminPassword = 'WOS-Admin-Scope-42!';
const adminUserId = '00000000-0000-0000-0000-000000000941';
const userAId = '00000000-0000-0000-0000-000000000942';
const userBId = '00000000-0000-0000-0000-000000000943';
const port = 4341;
const origin = `http://127.0.0.1:${port}`;
const scopeA = { 'x-organization-id': 'org-admin-scope', 'x-legal-entity-id': 'legal-admin-a' };

await pool.query(`insert into country_directors(id,name,region) values('cd-admin-scope','Admin Scope Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values
 ('org-admin-scope','ORG-ADMIN-SCOPE','Admin Scope Org','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values
 ('legal-admin-a','org-admin-scope','LEGAL-ADMIN-A','Admin Legal A','2026-01-01'),
 ('legal-admin-b','org-admin-scope','LEGAL-ADMIN-B','Admin Legal B','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into legal_entity_profile_versions(
  legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from,effective_to,authority_effective_to
) values
 ('legal-admin-a','org-admin-scope','Admin Legal A','US','Active','USD','{"line1":"Synthetic acceptance","city":"Synthetic","countryCode":"US"}'::jsonb,'2026-01-01',null,null),
 ('legal-admin-b','org-admin-scope','Admin Legal B','US','Active','USD','{"line1":"Synthetic acceptance","city":"Synthetic","countryCode":"US"}'::jsonb,'2026-01-01',null,null)
 on conflict(legal_entity_id,effective_from) do update set
  organization_id=excluded.organization_id,legal_name=excluded.legal_name,country_code=excluded.country_code,
  status=excluded.status,reporting_currency=excluded.reporting_currency,address=excluded.address,
  effective_to=excluded.effective_to,authority_effective_to=excluded.authority_effective_to`);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values
 ('admin-scope-actor','ADMIN-SCOPE-ACTOR','Admin Scope Actor','admin-scope-actor@example.test','System Administrator','Administration','Synthetic','cd-admin-scope','Active','org-admin-scope','legal-admin-a'),
 ('admin-scope-employee-a','ADMIN-EMP-A','Admin Employee A','admin-employee-a@example.test','Engineer','Delivery','Synthetic','cd-admin-scope','Active','org-admin-scope','legal-admin-a'),
 ('admin-scope-employee-b','ADMIN-EMP-B','Admin Employee B','admin-employee-b@example.test','Engineer','Delivery','Synthetic','cd-admin-scope','Active','org-admin-scope','legal-admin-b')
 on conflict(id) do nothing`);

const adminHash = await hashPassword(adminPassword);
const userAHash = await hashPassword('Employee-A-Start-42!');
const userBHash = await hashPassword('Employee-B-Start-42!');
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status) values
 ($1,'admin-scope-actor','ADMIN-SCOPE-ACTOR','admin-scope-actor','admin-scope-actor@example.test',$2,'Active'),
 ($3,'admin-employee-a','ADMIN-EMP-A','admin-scope-employee-a','admin-employee-a@example.test',$4,'Active'),
 ($5,'admin-employee-b','ADMIN-EMP-B','admin-scope-employee-b','admin-employee-b@example.test',$6,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`,
[adminUserId, adminHash, userAId, userAHash, userBId, userBHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [adminUserId, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values
 ($1,'org-admin-scope','legal-admin-a',true),($1,'org-admin-scope','legal-admin-b',true)
 on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [adminUserId]);

await pool.query(`insert into clients(id,name,industry,status,organization_id,legal_entity_id) values
 ('admin-client-a','Admin Client A','Synthetic','Active','org-admin-scope','legal-admin-a'),
 ('admin-client-b','Admin Client B','Synthetic','Active','org-admin-scope','legal-admin-b')
 on conflict(id) do nothing`);
await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,start_date,end_date,status,billable,organization_id,legal_entity_id) values
 ('admin-project-a','ADMIN-P-A','Admin Project A','admin-client-a','Admin Client A','admin-scope-employee-a','Admin Employee A','2026-01-01','2026-12-31','Active',true,'org-admin-scope','legal-admin-a'),
 ('admin-project-b','ADMIN-P-B','Admin Project B','admin-client-b','Admin Client B','admin-scope-employee-b','Admin Employee B','2026-01-01','2026-12-31','Active',true,'org-admin-scope','legal-admin-b')
 on conflict(id) do nothing`);
await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,status,billable,organization_id,legal_entity_id) values
 ('admin-allocation-a','admin-scope-employee-a','admin-project-a',50,'2026-01-01','2026-12-31','Active',true,'org-admin-scope','legal-admin-a'),
 ('admin-allocation-b','admin-scope-employee-b','admin-project-b',50,'2026-01-01','2026-12-31','Active',true,'org-admin-scope','legal-admin-b')
 on conflict(id) do nothing`);
await pool.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,provider_upn,status) values
 ('admin-identity-b','admin-scope-employee-b','entra','entra-b-original','admin-employee-b@example.test','Linked')
 on conflict(employee_id,provider) do update set id=excluded.id,provider_subject=excluded.provider_subject,provider_upn=excluded.provider_upn,status=excluded.status`);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    API_SESSION_SECRET: 'wos02-retained-admin-scope-acceptance-secret',
    API_PORT: String(port),
    PORT: String(port),
    APP_MODE: 'test',
    ALLOW_TEST_FALLBACK: 'false',
    LOCAL_LOGIN_ENABLED: 'true',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { serverLog += chunk; process.stderr.write(chunk); });
const waitReady = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready: ${serverLog}`);
};
await waitReady();
const call = async (method, route, { token, scope, body } = {}) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(scope || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};

let token = '';
try {
  await check('admin scope login succeeds', async () => {
    const response = await call('POST', '/api/auth/login', { body: { username: 'admin-scope-actor', password: adminPassword, requestedRole: 'Admin' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    token = response.body.token;
    assert.ok(token);
  });

  await check('password reset same-scope positive updates only authorized user', async () => {
    const beforeB = (await pool.query('select password_hash from users where id=$1', [userBId])).rows[0].password_hash;
    const response = await call('POST', `/api/users/${userAId}/password-reset`, { token, scope: scopeA, body: { newPassword: 'Employee-A-Reset-84!', mustChangePassword: true } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.notEqual((await pool.query('select password_hash from users where id=$1', [userAId])).rows[0].password_hash, userAHash);
    assert.equal((await pool.query('select password_hash from users where id=$1', [userBId])).rows[0].password_hash, beforeB);
  });

  await check('password reset same-org cross-legal target returns 404 with no credential write', async () => {
    const before = (await pool.query('select password_hash,must_change_password from users where id=$1', [userBId])).rows[0];
    const response = await call('POST', `/api/users/${userBId}/password-reset`, { token, scope: scopeA, body: { newPassword: 'Cross-Legal-Reset-84!', mustChangePassword: false } });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    const after = (await pool.query('select password_hash,must_change_password from users where id=$1', [userBId])).rows[0];
    assert.deepEqual(after, before);
  });

  await check('project status same-org cross-legal target returns 404 with no project or allocation cascade', async () => {
    const beforeProject = (await pool.query(`select status,end_date::text from projects where id='admin-project-b'`)).rows[0];
    const beforeAllocation = (await pool.query(`select status,end_date::text from project_allocations where id='admin-allocation-b'`)).rows[0];
    const response = await call('PATCH', '/api/projects/admin-project-b/status', { token, scope: scopeA, body: { status: 'Completed', reason: 'scope negative' } });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.deepEqual((await pool.query(`select status,end_date::text from projects where id='admin-project-b'`)).rows[0], beforeProject);
    assert.deepEqual((await pool.query(`select status,end_date::text from project_allocations where id='admin-allocation-b'`)).rows[0], beforeAllocation);
  });

  await check('project status same-scope positive completes project and allocation cascade', async () => {
    const response = await call('PATCH', '/api/projects/admin-project-a/status', { token, scope: scopeA, body: { status: 'Completed', reason: 'scope positive' } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await pool.query(`select status from projects where id='admin-project-a'`)).rows[0].status, 'Completed');
    assert.equal((await pool.query(`select status from project_allocations where id='admin-allocation-a'`)).rows[0].status, 'Completed');
  });

  await check('client deactivation same-org cross-legal target returns 404 before dependency or target mutation', async () => {
    const before = (await pool.query(`select status from clients where id='admin-client-b'`)).rows[0].status;
    const response = await call('DELETE', '/api/clients/admin-client-b', { token, scope: scopeA });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal((await pool.query(`select status from clients where id='admin-client-b'`)).rows[0].status, before);
    assert.equal((await pool.query(`select status from projects where id='admin-project-b'`)).rows[0].status, 'Active');
  });

  await check('client deactivation same-scope positive persists Inactive after completed dependency', async () => {
    const response = await call('DELETE', '/api/clients/admin-client-a', { token, scope: scopeA });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await pool.query(`select status from clients where id='admin-client-a'`)).rows[0].status, 'Inactive');
  });

  await check('identity link listing excludes same-org cross-legal employee links', async () => {
    const response = await call('GET', '/api/integrations/identity-links', { token, scope: scopeA });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body), JSON.stringify(response.body));
    assert.equal(response.body.some(row => row.id === 'admin-identity-b' || row.employee_id === 'admin-scope-employee-b'), false, JSON.stringify(response.body));
  });

  await check('identity link cross-legal employee target returns 404 with no identity or employee mutation', async () => {
    const beforeLink = (await pool.query(`select provider_subject,provider_upn,status from identity_provider_links where id='admin-identity-b'`)).rows[0];
    const beforeEmployee = (await pool.query(`select entra_object_id from employees where id='admin-scope-employee-b'`)).rows[0];
    const response = await call('POST', '/api/integrations/identity-links', { token, scope: scopeA, body: {
      employee_id: 'admin-scope-employee-b', provider: 'entra', provider_subject: 'entra-b-hijack', provider_upn: 'hijack@example.test', status: 'Linked',
    } });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.deepEqual((await pool.query(`select provider_subject,provider_upn,status from identity_provider_links where id='admin-identity-b'`)).rows[0], beforeLink);
    assert.deepEqual((await pool.query(`select entra_object_id from employees where id='admin-scope-employee-b'`)).rows[0], beforeEmployee);
  });

  await check('identity link foreign ID cannot be rebound to an authorized employee', async () => {
    const before = (await pool.query(`select employee_id,provider_subject,provider_upn,status from identity_provider_links where id='admin-identity-b'`)).rows[0];
    const response = await call('POST', '/api/integrations/identity-links', { token, scope: scopeA, body: {
      id: 'admin-identity-b', employee_id: 'admin-scope-employee-a', provider: 'entra', provider_subject: 'entra-a-hijack', provider_upn: 'admin-employee-a@example.test', status: 'Linked',
    } });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.deepEqual((await pool.query(`select employee_id,provider_subject,provider_upn,status from identity_provider_links where id='admin-identity-b'`)).rows[0], before);
    assert.equal((await pool.query(`select count(*)::int count from identity_provider_links where employee_id='admin-scope-employee-a' and provider='entra'`)).rows[0].count, 0);
  });

  await check('identity link same-scope positive persists link and employee identity', async () => {
    const response = await call('POST', '/api/integrations/identity-links', { token, scope: scopeA, body: {
      id: 'admin-identity-a', employee_id: 'admin-scope-employee-a', provider: 'entra', provider_subject: 'entra-a-authorized', provider_upn: 'admin-employee-a@example.test', status: 'Linked',
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.id, 'admin-identity-a');
    assert.equal((await pool.query(`select provider_subject from identity_provider_links where id='admin-identity-a'`)).rows[0].provider_subject, 'entra-a-authorized');
    assert.equal((await pool.query(`select entra_object_id from employees where id='admin-scope-employee-a'`)).rows[0].entra_object_id, 'entra-a-authorized');
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log('WOS-02 retained Admin/HR scope-integrity P1 acceptance passed (10 checks)');
