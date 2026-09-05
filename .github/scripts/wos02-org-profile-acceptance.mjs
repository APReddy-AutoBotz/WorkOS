// Controller-only exact-head acceptance for WOS-ORG-001/002 organization profile and legal-entity administration.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');
const pg = createRequire(path.join(targetRoot, 'package.json'))('pg');
const pool = new pg.Pool({ connectionString: databaseUrl });
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error?.stack || String(error) }); console.error(`FAIL ${name}: ${error?.stack || error}`); }
};

const ORG = 'org-profile';
const LEGAL = 'legal-profile';
const OTHER_ORG = 'org-profile-other';
const OTHER_LEGAL = 'legal-profile-other';
const USER = '00000000-0000-0000-0000-000000001081';
const EMP = 'admin-profile';
const SECRET = 'org-profile-acceptance-session-secret';
const sign = payload => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const token = sign({ sub: USER, username: 'profile-admin', activeRole: 'Admin', employeeRecordId: EMP, employeeId: 'ADMIN-PROFILE', exp: Date.now() + 3600000 });
const baseHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-organization-id': ORG, 'x-legal-entity-id': LEGAL };
const request = async (method, pathname, body, headers = baseHeaders) => {
  const response = await fetch(`${origin}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload; try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};
const expectStatus = (result, status) => assert.equal(result.status, status, JSON.stringify(result.body));
const today = new Date().toISOString().slice(0, 10);

await pool.query(`insert into country_directors(id,name,region) values('cd-profile','Profile Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,status,effective_from) values($1,'ORG-PROFILE','Profile Org','Active','2026-01-01'),($2,'ORG-OTHER','Other Org','Active','2026-01-01') on conflict(id) do update set status='Active'`, [ORG, OTHER_ORG]);
await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values($1,$2,'LEGAL-PROFILE','Profile Legal','US','Active','2026-01-01'),($3,$4,'LEGAL-OTHER','Other Legal','US','Active','2026-01-01') on conflict(id) do update set status='Active'`, [LEGAL, ORG, OTHER_LEGAL, OTHER_ORG]);
await pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from) values($1,'Profile Org','Profile Org LLC','ProfileOS','support@profile.example.test','en-US','UTC','USD','01-01',1,'2026-01-01') on conflict(organization_id,effective_from) do nothing`, [ORG]);
await pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from) values($1,'Other Org','Other Org LLC','OtherOS','support@other.example.test','en-US','UTC','USD','01-01',1,'2026-01-01') on conflict(organization_id,effective_from) do nothing`, [OTHER_ORG]);
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,registration_identifier,tax_identifier,reporting_currency,address,effective_from) values($1,$2,'Profile Legal LLC','REG-PROFILE','TAX-PROFILE','USD',$3::jsonb,'2026-01-01') on conflict(legal_entity_id,effective_from) do nothing`, [LEGAL, ORG, JSON.stringify({ line1: '1 Profile Street', city: 'Profile City', countryCode: 'US' })]);
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,registration_identifier,tax_identifier,reporting_currency,address,effective_from) values($1,$2,'Other Legal LLC','REG-OTHER','TAX-OTHER','USD',$3::jsonb,'2026-01-01') on conflict(legal_entity_id,effective_from) do nothing`, [OTHER_LEGAL, OTHER_ORG, JSON.stringify({ line1: '1 Other Street', city: 'Other City', countryCode: 'US' })]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'ADMIN-PROFILE','Profile Admin','profile-admin@example.test','Administrator','Administration','Synthetic','cd-profile','Active',$2,$3) on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`, [EMP, ORG, LEGAL]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'profile-admin','ADMIN-PROFILE',$2,'profile-admin@example.test','Active') on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`, [USER, EMP]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [USER, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [USER, ORG, LEGAL]);

const port = 4332;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: targetRoot, env: { ...process.env, DATABASE_URL: databaseUrl, API_SESSION_SECRET: SECRET, APP_MODE: 'test', ALLOW_TEST_FALLBACK: 'true', API_PORT: String(port), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
for (let i = 0; i < 120; i++) {
  try { const response = await fetch(`${origin}/api/health`); if (response.status < 500) break; } catch {}
  if (i === 119) throw new Error(`server not ready: ${log}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

const updatedProfile = {
  name: 'Profile Org Updated', legalName: 'Profile Org Incorporated', productDisplayName: 'Profile WorkOS',
  supportContact: 'https://support.profile.example.test', defaultLocale: 'en-IN', defaultTimeZone: 'Asia/Kolkata',
  baseCurrency: 'INR', fiscalYearStart: '04-01', defaultWeekStart: 1, effectiveFrom: '2026-09-01',
};
let createdLegal = null;
try {
  await check('migration 028 schema, backfill constraints and scoped identity indexes exist', async () => {
    assert.equal((await pool.query(`select count(*)::int n from schema_migrations where id='028_wos02_organization_legal_entity_profiles'`)).rows[0].n, 1);
    assert.equal((await pool.query(`select count(*)::int n from information_schema.tables where table_name in ('organization_profile_versions','legal_entity_profile_versions')`)).rows[0].n, 2);
    assert.equal((await pool.query(`select count(*)::int n from pg_constraint where conname in ('organization_profile_versions_no_overlap','legal_entity_profile_versions_no_overlap')`)).rows[0].n, 2);
    assert.equal((await pool.query(`select count(*)::int n from pg_indexes where indexname in ('uq_legal_entity_registration_identity','uq_legal_entity_tax_identity')`)).rows[0].n, 2);
    const defaultProfiles = await pool.query(`select (select count(*) from organization_profile_versions where organization_id='org-default') org_profiles,(select count(*) from legal_entity_profile_versions where legal_entity_id='legal-default') legal_profiles`);
    assert.equal(Number(defaultProfiles.rows[0].org_profiles), 1);
    assert.equal(Number(defaultProfiles.rows[0].legal_profiles), 1);
  });

  await check('profile non-overlap and composite legal ownership fail closed at database authority', async () => {
    await assert.rejects(() => pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from,effective_to) values($1,'Overlap','Overlap','Overlap','overlap@example.test','en-US','UTC','USD','01-01',1,'2026-06-01','2026-06-30')`, [ORG]), error => ['23P01','23505'].includes(error.code));
    await assert.rejects(() => pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,reporting_currency,address,effective_from) values($1,$2,'Wrong Owner','USD',$3::jsonb,'2027-01-01')`, [LEGAL, OTHER_ORG, JSON.stringify({ line1: 'Wrong', city: 'Wrong', countryCode: 'US' })]), error => error.code === '23503');
  });

  await check('exact-scope profile read returns every WOS-ORG-001 field', async () => {
    const result = await request('GET', '/api/organization-setup/profile'); expectStatus(result, 200);
    for (const key of ['organization_name','legal_name','product_display_name','support_contact','default_locale','default_time_zone','base_currency','fiscal_year_start','default_week_start']) assert.ok(Object.hasOwn(result.body, key), `${key} missing`);
    assert.equal(result.body.organization_id, ORG);
  });

  await check('authorized profile update creates effective history and transactional audit', async () => {
    const result = await request('PUT', '/api/organization-setup/profile', updatedProfile); expectStatus(result, 200);
    assert.equal(result.body.organization_name, updatedProfile.name);
    assert.equal(result.body.legal_name, updatedProfile.legalName);
    assert.equal(result.body.base_currency, 'INR');
    const oldRead = await request('GET', '/api/organization-setup/profile?asOf=2026-08-31'); expectStatus(oldRead, 200); assert.equal(oldRead.body.organization_name, 'Profile Org');
    const currentRead = await request('GET', '/api/organization-setup/profile?asOf=2026-09-02'); expectStatus(currentRead, 200); assert.equal(currentRead.body.organization_name, updatedProfile.name);
    const versions = await pool.query(`select effective_from,effective_to,name from organization_profile_versions where organization_id=$1 order by effective_from`, [ORG]);
    assert.equal(versions.rowCount, 2); assert.equal(String(versions.rows[0].effective_to).slice(0,10), '2026-08-31');
    const audit = (await pool.query(`select user_id,active_role,old_value,new_value from audit_logs where module='Organization Setup' and action='Update Organization Profile' and entity_id=$1 order by created_at desc limit 1`, [ORG])).rows[0];
    assert.ok(audit); assert.equal(String(audit.user_id), USER); assert.equal(audit.active_role, 'Admin'); assert.equal(audit.new_value.name, updatedProfile.name);
  });

  await check('caller organization spoof, cross-org scope and invalid profile values are no-write', async () => {
    const before = Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`, [ORG])).rows[0].n);
    const spoof = await request('PUT', '/api/organization-setup/profile', { ...updatedProfile, organizationId: OTHER_ORG, effectiveFrom: '2026-10-01' }); expectStatus(spoof, 403);
    const crossHeaders = { ...baseHeaders, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL };
    const cross = await request('GET', '/api/organization-setup/profile', undefined, crossHeaders); expectStatus(cross, 403);
    const invalid = await request('PUT', '/api/organization-setup/profile', { ...updatedProfile, defaultTimeZone: 'Not/AZone', effectiveFrom: '2026-10-01' }); expectStatus(invalid, 400);
    assert.equal(Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`, [ORG])).rows[0].n), before);
  });

  await check('profile audit failure rolls back complete mutation', async () => {
    const beforeName = (await pool.query(`select name from organizations where id=$1`, [ORG])).rows[0].name;
    const beforeCount = Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`, [ORG])).rows[0].n);
    await pool.query(`create or replace function reject_profile_audit() returns trigger language plpgsql as $$ begin if NEW.action='Update Organization Profile' then raise exception 'synthetic audit rejection'; end if; return NEW; end $$; create trigger reject_profile_audit before insert on audit_logs for each row execute function reject_profile_audit();`);
    try {
      const result = await request('PUT', '/api/organization-setup/profile', { ...updatedProfile, name: 'Should Roll Back', effectiveFrom: '2026-10-01' }); expectStatus(result, 500);
      assert.equal((await pool.query(`select name from organizations where id=$1`, [ORG])).rows[0].name, beforeName);
      assert.equal(Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`, [ORG])).rows[0].n), beforeCount);
    } finally { await pool.query(`drop trigger if exists reject_profile_audit on audit_logs; drop function if exists reject_profile_audit()`); }
  });

  await check('governed legal-entity list/read is persisted-scope bounded', async () => {
    const list = await request('GET', '/api/organization-setup/legal-entities'); expectStatus(list, 200); assert.ok(Array.isArray(list.body)); assert.ok(list.body.some(row => row.id === LEGAL)); assert.ok(!list.body.some(row => row.id === OTHER_LEGAL));
    const read = await request('GET', `/api/organization-setup/legal-entities/${LEGAL}`); expectStatus(read, 200); assert.equal(read.body.organization_id, ORG);
    const denied = await request('GET', `/api/organization-setup/legal-entities/${OTHER_LEGAL}`); expectStatus(denied, 404);
  });

  await check('authorized legal-entity create persists profile, audit and creator scope atomically', async () => {
    const payload = { code: 'LEGAL-NEW', legalName: 'New Legal Entity LLC', registrationIdentifier: 'REG-NEW', taxIdentifier: 'TAX-NEW', reportingCurrency: 'EUR', address: { line1: '10 New Street', city: 'New City', countryCode: 'DE' }, status: 'Active', effectiveFrom: '2026-09-01' };
    const result = await request('POST', '/api/organization-setup/legal-entities', payload); expectStatus(result, 201); createdLegal = result.body.id; assert.ok(createdLegal); assert.equal(result.body.organization_id, ORG); assert.equal(result.body.reporting_currency, 'EUR');
    assert.equal(Number((await pool.query(`select count(*) n from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active=true`, [USER, ORG, createdLegal])).rows[0].n), 1);
    const audit = (await pool.query(`select user_id,new_value from audit_logs where action='Create Legal Entity' and entity_id=$1 order by created_at desc limit 1`, [createdLegal])).rows[0]; assert.ok(audit); assert.equal(String(audit.user_id), USER);
  });

  await check('duplicate/concurrent legal code and scoped identities cannot create ambiguity', async () => {
    const payload = suffix => ({ code: `LEGAL-DUP${suffix}`, legalName: `Dup ${suffix}`, registrationIdentifier: 'REG-DUP', taxIdentifier: `TAX-DUP-${suffix}`, reportingCurrency: 'USD', address: { line1: 'Dup', city: 'Dup', countryCode: 'US' }, status: 'Active', effectiveFrom: '2026-09-01' });
    const identityA = await request('POST', '/api/organization-setup/legal-entities', payload('A')); expectStatus(identityA, 201);
    const identityB = await request('POST', '/api/organization-setup/legal-entities', payload('B')); expectStatus(identityB, 409);
    const concurrent = { code: 'LEGAL-CONCURRENT', legalName: 'Concurrent', registrationIdentifier: null, taxIdentifier: null, reportingCurrency: 'USD', address: { line1: 'Concurrent', city: 'Concurrent', countryCode: 'US' }, status: 'Active', effectiveFrom: '2026-09-01' };
    const results = await Promise.all([request('POST', '/api/organization-setup/legal-entities', concurrent), request('POST', '/api/organization-setup/legal-entities', concurrent)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201,409]);
  });

  await check('exact selected legal-entity update versions profile and audits; cross-legal/cross-org mutation denies', async () => {
    assert.ok(createdLegal);
    const createdHeaders = { ...baseHeaders, 'x-legal-entity-id': createdLegal };
    const payload = { code: 'LEGAL-NEW', legalName: 'New Legal Entity Updated', registrationIdentifier: 'REG-NEW', taxIdentifier: 'TAX-NEW', reportingCurrency: 'GBP', address: { line1: '20 New Street', city: 'New City', countryCode: 'GB' }, status: 'Active', effectiveFrom: '2026-10-01' };
    const update = await request('PUT', `/api/organization-setup/legal-entities/${createdLegal}`, payload, createdHeaders); expectStatus(update, 200); assert.equal(update.body.reporting_currency, 'GBP');
    const history = await pool.query(`select effective_from,effective_to,reporting_currency from legal_entity_profile_versions where legal_entity_id=$1 order by effective_from`, [createdLegal]); assert.equal(history.rowCount, 2); assert.equal(String(history.rows[0].effective_to).slice(0,10), '2026-09-30');
    const audit = (await pool.query(`select old_value,new_value from audit_logs where action='Update Legal Entity' and entity_id=$1 order by created_at desc limit 1`, [createdLegal])).rows[0]; assert.ok(audit?.old_value); assert.ok(audit?.new_value);
    const wrongSelected = await request('PUT', `/api/organization-setup/legal-entities/${createdLegal}`, payload, baseHeaders); expectStatus(wrongSelected, 404);
    const crossHeaders = { ...createdHeaders, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL };
    const cross = await request('PUT', `/api/organization-setup/legal-entities/${OTHER_LEGAL}`, { ...payload, code: 'LEGAL-OTHER', organizationId: OTHER_ORG }, crossHeaders); expectStatus(cross, 403);
  });

  await check('unsafe legal-entity deactivate/effective-end with active dependency fails closed', async () => {
    assert.ok(createdLegal);
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('profile-dependent','PROFILE-DEP','Profile Dependent','profile-dependent@example.test','Engineer','Delivery','Synthetic','cd-profile','Active',$1,$2) on conflict(id) do nothing`, [ORG, createdLegal]);
    const headers = { ...baseHeaders, 'x-legal-entity-id': createdLegal };
    const payload = { code: 'LEGAL-NEW', legalName: 'New Legal Entity Updated', registrationIdentifier: 'REG-NEW', taxIdentifier: 'TAX-NEW', reportingCurrency: 'GBP', address: { line1: '20 New Street', city: 'New City', countryCode: 'GB' }, status: 'Inactive', effectiveFrom: '2026-10-01', effectiveTo: today };
    const result = await request('PUT', `/api/organization-setup/legal-entities/${createdLegal}`, payload, headers); expectStatus(result, 409);
    assert.equal((await pool.query(`select status from legal_entities where id=$1`, [createdLegal])).rows[0].status, 'Active');
  });

  await check('context remains backward compatible and resolves current/historical profile facts', async () => {
    const current = await request('GET', '/api/organization-setup/context?asOf=2026-09-02'); expectStatus(current, 200); assert.equal(current.body.organization_id, ORG); assert.equal(current.body.organization_name, updatedProfile.name); assert.equal(current.body.organization_legal_name, updatedProfile.legalName); assert.equal(current.body.legal_entity_id, LEGAL); assert.ok(current.body.legal_entity_legal_name);
    const historical = await request('GET', '/api/organization-setup/context?asOf=2026-08-31'); expectStatus(historical, 200); assert.equal(historical.body.organization_name, 'Profile Org'); assert.equal(historical.body.organization_legal_name, 'Profile Org LLC');
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else console.log('WOS-02 organization profile/legal-entity acceptance complete');
