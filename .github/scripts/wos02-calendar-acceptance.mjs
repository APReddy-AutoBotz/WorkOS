// Controller-only PostgreSQL/API acceptance for WOS-ORG-008 working-calendar authority.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!root || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');
const { Pool } = createRequire(path.join(root, 'package.json'))('pg');
const pool = new Pool({ connectionString: databaseUrl });
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error?.stack || String(error) }); console.error(`FAIL ${name}: ${error?.stack || error}`); }
};

const ORG = 'org-calendar';
const LEGAL = 'legal-calendar';
const LEGAL_GB = 'legal-calendar-gb';
const OTHER_ORG = 'org-calendar-other';
const OTHER_LEGAL = 'legal-calendar-other';
const USER = '00000000-0000-0000-0000-000000001181';
const EMPLOYEE = 'calendar-admin';
const SECRET = 'calendar-acceptance-session-secret';
const sign = payload => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const token = sign({ sub: USER, username: 'calendar-admin', activeRole: 'Admin', employeeRecordId: EMPLOYEE, employeeId: 'ADMIN-CALENDAR', exp: Date.now() + 3600000 });
const scope = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-organization-id': ORG, 'x-legal-entity-id': LEGAL };

await pool.query(`insert into country_directors(id,name,region) values('cd-calendar','Calendar Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,status,effective_from) values
  ($1,'ORG-CALENDAR','Calendar Org','Active','2026-01-01'),($2,'ORG-CALENDAR-OTHER','Other Calendar Org','Active','2026-01-01') on conflict(id) do update set status='Active'`, [ORG, OTHER_ORG]);
await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values
  ($1,$2,'LEGAL-CALENDAR','Calendar Legal','US','Active','2026-01-01'),
  ($3,$2,'LEGAL-CALENDAR-GB','Calendar Legal GB','GB','Active','2026-01-01'),
  ($4,$5,'LEGAL-CALENDAR-OTHER','Other Calendar Legal','US','Active','2026-01-01')
  on conflict(id) do update set status='Active'`, [LEGAL, ORG, LEGAL_GB, OTHER_LEGAL, OTHER_ORG]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
  values($1,'ADMIN-CALENDAR','Calendar Admin','calendar-admin@example.test','Administrator','Administration','Synthetic','cd-calendar','Active',$2,$3)
  on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`, [EMPLOYEE, ORG, LEGAL]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'calendar-admin','ADMIN-CALENDAR',$2,'calendar-admin@example.test','Active')
  on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`, [USER, EMPLOYEE]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole);
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [USER, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [USER, ORG, LEGAL]);
await pool.query(`insert into organization_catalog_items(id,organization_id,legal_entity_id,catalog_type,code,name,active,effective_from) values
  ('calendar-group',$1,$2,'business_unit','CAL-GROUP','Calendar Group',true,'2026-01-01'),
  ('calendar-group-inactive',$1,$2,'business_unit','CAL-INACTIVE','Inactive Group',false,'2026-01-01'),
  ('calendar-wrong-type',$1,$2,'worker_type','CAL-WRONG','Wrong Type',true,'2026-01-01'),
  ('calendar-cross-legal',$1,$3,'business_unit','CAL-CROSS-LEGAL','Cross Legal Group',true,'2026-01-01'),
  ('calendar-cross-org',$4,$5,'business_unit','CAL-CROSS-ORG','Cross Org Group',true,'2026-01-01')
  on conflict(id) do update set active=excluded.active`, [ORG, LEGAL, LEGAL_GB, OTHER_ORG, OTHER_LEGAL]);

const port = 4333;
const origin = `http://127.0.0.1:${port}`;
const request = async (method, url, body, headers = scope) => {
  const response = await fetch(origin + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload; try { payload = await response.json(); } catch { payload = await response.text(); }
  return { status: response.status, body: payload };
};
const expect = (response, status) => assert.equal(response.status, status, JSON.stringify(response.body));
const count = async (table, where, args = []) => Number((await pool.query(`select count(*) n from ${table} where ${where}`, args)).rows[0].n);
const snapshot = async calendarId => ({
  calendars: await count('working_calendars', 'id=$1', [calendarId]),
  versions: await count('working_calendar_versions', 'working_calendar_id=$1', [calendarId]),
  holidays: await count('working_calendar_holidays', 'working_calendar_id=$1', [calendarId]),
});
const assertNoWrite = async (before, calendarId) => assert.deepEqual(await snapshot(calendarId), before);
const calendarBody = (code, extra = {}) => ({
  code, name: `${code} Calendar`, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8,
  applicabilityType: 'Legal Entity', effectiveFrom: '2026-01-01', ...extra,
});

const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, API_SESSION_SECRET: SECRET, APP_MODE: 'test', ALLOW_TEST_FALLBACK: 'true', API_PORT: String(port), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', value => { log += value; process.stdout.write(value); });
child.stderr.on('data', value => { log += value; process.stderr.write(value); });
for (let i = 0; i < 120; i++) {
  try { const response = await fetch(`${origin}/api/health`); if (response.status < 500) break; } catch {}
  if (i === 119) throw new Error(`server not ready ${log}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

let legalCalendar;
let countryCalendar;
let groupCalendar;
try {
  await check('migration 029 ledger and database scope/non-overlap/foreign-key authority', async () => {
    assert.equal(await count('schema_migrations', `id='029_wos02_working_calendar_authority'`), 1);
    const constraints = await pool.query(`select conname,contype from pg_constraint where conrelid in ('working_calendars'::regclass,'working_calendar_versions'::regclass,'working_calendar_holidays'::regclass)`);
    assert.ok(constraints.rows.some(row => row.contype === 'x'), JSON.stringify(constraints.rows));
    assert.ok(constraints.rows.filter(row => row.contype === 'f').length >= 4, JSON.stringify(constraints.rows));
    assert.ok(constraints.rows.filter(row => row.contype === 'c').length >= 4, JSON.stringify(constraints.rows));
  });

  await check('existing legal-entity applicability remains valid and scoped', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-LEGAL'));
    expect(created, 201); legalCalendar = created.body.id; assert.ok(legalCalendar);
    const read = await request('GET', `/api/organization-setup/calendars/${legalCalendar}`); expect(read, 200);
    const cross = await request('GET', `/api/organization-setup/calendars/${legalCalendar}`, undefined, { ...scope, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL });
    assert.ok([403, 404].includes(cross.status), JSON.stringify(cross.body));
  });

  await check('country applicability uses persisted legal country and spoofed authority writes fail closed', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-US', { applicabilityType: 'Country', countryCode: 'US' }));
    expect(created, 201); countryCalendar = created.body.id;
    expect(await request('GET', `/api/organization-setup/calendars/${countryCalendar}`), 200);
    const before = await snapshot(countryCalendar);
    const mismatch = await request('PUT', `/api/organization-setup/calendars/${countryCalendar}`, calendarBody('CAL-US', { applicabilityType: 'Country', countryCode: 'GB', effectiveFrom: '2026-07-01', legalEntityId: LEGAL_GB }));
    assert.ok([403, 409].includes(mismatch.status), JSON.stringify(mismatch.body)); await assertNoWrite(before, countryCalendar);
    const cross = await request('PUT', `/api/organization-setup/calendars/${countryCalendar}`, calendarBody('CAL-US', { applicabilityType: 'Country', countryCode: 'US', effectiveFrom: '2026-07-01', organizationId: OTHER_ORG }), { ...scope, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL });
    assert.ok([403, 404].includes(cross.status), JSON.stringify(cross.body)); await assertNoWrite(before, countryCalendar);
  });

  await check('worker-group applicability accepts only active compatible organization-owned business units', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-GROUP', { applicabilityType: 'Worker Group', workerGroupId: 'calendar-group' }));
    expect(created, 201); groupCalendar = created.body.id;
    for (const workerGroupId of ['calendar-wrong-type', 'calendar-group-inactive', 'calendar-cross-legal', 'calendar-cross-org', 'missing-group']) {
      const before = await count('working_calendars', `code='CAL-GROUP-BAD'`);
      const denied = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-GROUP-BAD', { applicabilityType: 'Worker Group', workerGroupId }));
      assert.ok([400, 403, 404, 409].includes(denied.status), `${workerGroupId}: ${JSON.stringify(denied.body)}`);
      assert.equal(await count('working_calendars', `code='CAL-GROUP-BAD'`), before);
    }
  });

  await check('effective versions preserve history and reject stale/overlapping authority', async () => {
    const updated = await request('PUT', `/api/organization-setup/calendars/${legalCalendar}`, calendarBody('CAL-LEGAL', { name: 'Legal Calendar Successor', hoursPerDay: 7.5, effectiveFrom: '2026-07-01' }));
    expect(updated, 200);
    const old = await request('GET', `/api/organization-setup/calendars/${legalCalendar}?asOf=2026-06-30`); expect(old, 200); assert.equal(Number(old.body.hours_per_day ?? old.body.hoursPerDay), 8);
    const current = await request('GET', `/api/organization-setup/calendars/${legalCalendar}?asOf=2026-07-01`); expect(current, 200); assert.equal(Number(current.body.hours_per_day ?? current.body.hoursPerDay), 7.5);
    const before = await snapshot(legalCalendar);
    const stale = await request('PUT', `/api/organization-setup/calendars/${legalCalendar}`, calendarBody('CAL-LEGAL', { effectiveFrom: '2026-06-01' }));
    expect(stale, 409); await assertNoWrite(before, legalCalendar);
  });

  await check('work-week validation rejects duplicate/invalid weekdays and invalid daily hours without mutation', async () => {
    for (const patch of [{ workingDays: [1, 1, 2] }, { workingDays: [0, 8] }, { hoursPerDay: 0 }, { hoursPerDay: 24.01 }]) {
      const before = await snapshot(groupCalendar);
      const denied = await request('PUT', `/api/organization-setup/calendars/${groupCalendar}`, calendarBody('CAL-GROUP', { ...patch, applicabilityType: 'Worker Group', workerGroupId: 'calendar-group', effectiveFrom: '2026-07-01' }));
      expect(denied, 400); await assertNoWrite(before, groupCalendar);
    }
  });

  let publicHoliday;
  let companyHoliday;
  await check('public/company holiday create/read/version/retire paths are transactionally audited', async () => {
    let response = await request('POST', `/api/organization-setup/calendars/${legalCalendar}/holidays`, { holidayType: 'Public', name: 'Synthetic Public Holiday', date: '2026-11-01' });
    expect(response, 201); publicHoliday = response.body.id;
    response = await request('POST', `/api/organization-setup/calendars/${legalCalendar}/holidays`, { holidayType: 'Company', name: 'Synthetic Company Holiday', date: '2026-12-01' });
    expect(response, 201); companyHoliday = response.body.id;
    const list = await request('GET', `/api/organization-setup/calendars/${legalCalendar}/holidays`); expect(list, 200); assert.ok(list.body.some(row => row.id === publicHoliday)); assert.ok(list.body.some(row => row.id === companyHoliday));
    response = await request('PUT', `/api/organization-setup/calendars/${legalCalendar}/holidays/${companyHoliday}`, { holidayType: 'Company', name: 'Synthetic Company Holiday Updated', date: '2026-12-02', effectiveFrom: '2026-07-01' }); expect(response, 200);
    response = await request('DELETE', `/api/organization-setup/calendars/${legalCalendar}/holidays/${companyHoliday}`, { reason: 'Synthetic retirement', effectiveFrom: '2026-08-01' }); expect(response, 200);
    const audits = await pool.query(`select old_value,new_value,user_id,active_role,source from audit_logs where entity_id in ($1,$2) order by created_at`, [publicHoliday, companyHoliday]);
    assert.ok(audits.rowCount >= 4); assert.ok(audits.rows.every(row => String(row.user_id) === USER && row.active_role && row.source)); assert.ok(audits.rows.some(row => row.old_value && row.new_value));
  });

  await check('holiday overlap and cross-scope access fail deterministically without write', async () => {
    const before = await snapshot(legalCalendar);
    const overlap = await request('POST', `/api/organization-setup/calendars/${legalCalendar}/holidays`, { holidayType: 'Company', name: 'Conflicting Holiday', date: '2026-11-01' }); expect(overlap, 409); await assertNoWrite(before, legalCalendar);
    const cross = await request('DELETE', `/api/organization-setup/calendars/${legalCalendar}/holidays/${publicHoliday}`, { reason: 'Spoof' }, { ...scope, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL });
    assert.ok([403, 404].includes(cross.status), JSON.stringify(cross.body)); await assertNoWrite(before, legalCalendar);
  });

  await check('concurrent duplicate calendar and holiday writes yield one unambiguous authority', async () => {
    const duplicate = calendarBody('CAL-CONCURRENT');
    const calendars = await Promise.all([request('POST', '/api/organization-setup/calendars', duplicate), request('POST', '/api/organization-setup/calendars', duplicate)]);
    assert.deepEqual(calendars.map(value => value.status).sort(), [201, 409]);
    const id = calendars.find(value => value.status === 201).body.id;
    const holiday = { holidayType: 'Public', name: 'Concurrent Holiday', date: '2026-10-01' };
    const holidays = await Promise.all([request('POST', `/api/organization-setup/calendars/${id}/holidays`, holiday), request('POST', `/api/organization-setup/calendars/${id}/holidays`, holiday)]);
    assert.deepEqual(holidays.map(value => value.status).sort(), [201, 409]);
    assert.equal(await count('working_calendar_holidays', 'working_calendar_id=$1 and holiday_date=$2', [id, '2026-10-01']), 1);
  });

  await check('calendar retirement fails CALENDAR_IN_USE for worker and holiday dependencies', async () => {
    await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,lifecycle_status,effective_from,working_calendar_id) values($1,$2,$3,'Active','2026-01-01',$4)
      on conflict(employee_id) do update set working_calendar_id=excluded.working_calendar_id,lifecycle_status='Active'`, [EMPLOYEE, ORG, LEGAL, legalCalendar]);
    const before = await snapshot(legalCalendar);
    let denied = await request('DELETE', `/api/organization-setup/calendars/${legalCalendar}`, { reason: 'Synthetic retirement', effectiveFrom: '2026-09-01' }); expect(denied, 409); assert.equal(denied.body.code, 'CALENDAR_IN_USE'); await assertNoWrite(before, legalCalendar);
    await pool.query(`update worker_profiles set working_calendar_id=null where employee_id=$1`, [EMPLOYEE]);
    denied = await request('DELETE', `/api/organization-setup/calendars/${legalCalendar}`, { reason: 'Synthetic retirement', effectiveFrom: '2026-09-01' }); expect(denied, 409); assert.equal(denied.body.code, 'CALENDAR_IN_USE'); await assertNoWrite(before, legalCalendar);
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  await pool.end();
}
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('WOS-02 working-calendar authority acceptance complete');
