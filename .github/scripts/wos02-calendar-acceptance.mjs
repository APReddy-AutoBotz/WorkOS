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
const gbScope = { ...scope, 'x-legal-entity-id': LEGAL_GB };
const otherScope = { ...scope, 'x-organization-id': OTHER_ORG, 'x-legal-entity-id': OTHER_LEGAL };

await pool.query(`insert into country_directors(id,name,region) values('cd-calendar','Calendar Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,status,effective_from) values
  ($1,'ORG-CALENDAR','Calendar Org','Active','2026-01-01'),($2,'ORG-CALENDAR-OTHER','Other Calendar Org','Active','2026-01-01') on conflict(id) do update set status='Active'`, [ORG, OTHER_ORG]);
await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values
  ($1,$2,'LEGAL-CALENDAR','Calendar Legal','US','Active','2026-01-01'),
  ($3,$2,'LEGAL-CALENDAR-GB','Calendar Legal GB','GB','Active','2026-01-01'),
  ($4,$5,'LEGAL-CALENDAR-OTHER','Other Calendar Legal','US','Active','2026-01-01')
  on conflict(id) do update set status='Active',country_code=excluded.country_code`, [LEGAL, ORG, LEGAL_GB, OTHER_LEGAL, OTHER_ORG]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
  values($1,'ADMIN-CALENDAR','Calendar Admin','calendar-admin@example.test','Administrator','Administration','Synthetic','cd-calendar','Active',$2,$3)
  on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`, [EMPLOYEE, ORG, LEGAL]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'calendar-admin','ADMIN-CALENDAR',$2,'calendar-admin@example.test','Active')
  on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`, [USER, EMPLOYEE]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole);
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`, [USER, adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values
  ($1,$2,$3,true),($1,$2,$4,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`, [USER, ORG, LEGAL, LEGAL_GB]);
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
const calendarCount = code => count('working_calendars', 'organization_id=$1 and code=$2', [ORG, code]);
const holidayCount = calendarId => count('working_calendar_holidays', 'organization_id=$1 and calendar_id=$2', [ORG, calendarId]);
const calendarState = async calendarId => (await pool.query(`select id,active,effective_from::text,effective_to::text,applicability_type,legal_entity_id,country_code,worker_group_id from working_calendars where id=$1`, [calendarId])).rows[0];
const holidayState = async holidayId => (await pool.query(`select id,holiday_id,calendar_id,holiday_date::text,label,holiday_type,active,effective_from::text,effective_to::text from working_calendar_holidays where holiday_id=$1 order by effective_from,id`, [holidayId])).rows;
const calendarBody = (code, extra = {}) => ({
  code, name: `${code} Calendar`, timezone: 'America/New_York', workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8,
  effectiveFrom: '2026-01-01', applicability: { type: 'legal_entity' }, ...extra,
});
const listCalendars = async (asOf, headers = scope) => {
  const response = await request('GET', `/api/organization-setup/calendars?asOf=${encodeURIComponent(asOf)}`, undefined, headers);
  expect(response, 200);
  return response.body;
};
const calendarFromList = async (code, asOf, headers = scope) => (await listCalendars(asOf, headers)).find(row => row.code === code);
const expectDbError = async (expectedCode, fn) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    let caught;
    try { await fn(client); } catch (error) { caught = error; }
    assert.ok(caught, `expected PostgreSQL error ${expectedCode}`);
    assert.equal(caught.code, expectedCode, caught.stack || String(caught));
    await client.query('rollback');
  } finally { client.release(); }
};

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
let currentLegalCalendar;
let countryCalendar;
let groupCalendar;
try {
  await check('migration 029 ledger and named database scope/non-overlap/foreign-key authority', async () => {
    assert.equal(await count('schema_migrations', `id='029_wos02_working_calendar_authority'`), 1);
    const names = ['working_calendars_applicability_check','working_calendars_country_authority_fk','working_calendars_worker_group_fk','working_calendar_versions_no_overlap','working_calendar_holiday_date_authority_no_overlap'];
    const constraints = await pool.query(`select conname,contype from pg_constraint where conname=any($1::text[])`, [names]);
    const byName = new Map(constraints.rows.map(row => [row.conname, row.contype]));
    assert.equal(byName.get('working_calendars_applicability_check'), 'c');
    assert.equal(byName.get('working_calendars_country_authority_fk'), 'f');
    assert.equal(byName.get('working_calendars_worker_group_fk'), 'f');
    assert.equal(byName.get('working_calendar_versions_no_overlap'), 'x');
    assert.equal(byName.get('working_calendar_holiday_date_authority_no_overlap'), 'x');
    await expectDbError('23503', client => client.query(`insert into working_calendars(id,organization_id,applicability_type,country_code,country_authority_legal_entity_id,code,name,timezone,working_days,hours_per_day,effective_from)
      values('calendar-bad-country-fk',$1,'country','GB',$2,'CAL-BAD-FK','Bad FK','UTC',array[1,2,3,4,5],8,'2026-01-01')`, [ORG, LEGAL]));
    await expectDbError('23514', client => client.query(`insert into working_calendars(id,organization_id,applicability_type,worker_group_id,code,name,timezone,working_days,hours_per_day,effective_from)
      values('calendar-bad-worker-group',$1,'worker_group','calendar-wrong-type','CAL-BAD-GROUP','Bad Group','UTC',array[1,2,3,4,5],8,'2026-01-01')`, [ORG]));
  });

  await check('existing legal-entity applicability remains valid and exact legal scoped', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-LEGAL'));
    expect(created, 201); legalCalendar = created.body.id; currentLegalCalendar = legalCalendar; assert.ok(legalCalendar);
    assert.equal((await calendarFromList('CAL-LEGAL', '2026-02-01', scope))?.id, legalCalendar);
    assert.equal(await calendarFromList('CAL-LEGAL', '2026-02-01', gbScope), undefined);
    const crossOrg = await request('GET', '/api/organization-setup/calendars?asOf=2026-02-01', undefined, otherScope);
    assert.equal(crossOrg.status, 403, JSON.stringify(crossOrg.body));
  });

  await check('country applicability uses persisted selected-legal country and spoof/cross-scope writes fail closed', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-US', { applicability: { type: 'country', countryCode: 'US' } }));
    expect(created, 201); countryCalendar = created.body.id; assert.ok(countryCalendar);
    assert.equal((await calendarFromList('CAL-US', '2026-02-01', scope))?.id, countryCalendar);
    assert.equal(await calendarFromList('CAL-US', '2026-02-01', gbScope), undefined);
    const before = await calendarCount('CAL-US');
    const mismatch = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-US', { applicability: { type: 'country', countryCode: 'GB' }, effectiveFrom: '2026-07-01' }));
    expect(mismatch, 404); assert.equal(await calendarCount('CAL-US'), before);
    const crossLegal = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-US-GB-DENIED', { applicability: { type: 'country', countryCode: 'US' } }), gbScope);
    expect(crossLegal, 404); assert.equal(await calendarCount('CAL-US-GB-DENIED'), 0);
    const spoof = await request('POST', '/api/organization-setup/calendars', { ...calendarBody('CAL-US-SPOOF', { applicability: { type: 'country', countryCode: 'US' } }), organizationId: OTHER_ORG });
    expect(spoof, 400); assert.equal(await calendarCount('CAL-US-SPOOF'), 0);
    const crossOrg = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-US-OTHER', { applicability: { type: 'country', countryCode: 'US' } }), otherScope);
    expect(crossOrg, 403); assert.equal(await calendarCount('CAL-US-OTHER'), 0);
  });

  await check('worker-group applicability accepts only active compatible organization-owned business units', async () => {
    const created = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-GROUP', { applicability: { type: 'worker_group', workerGroupId: 'calendar-group' } }));
    expect(created, 201); groupCalendar = created.body.id; assert.ok(groupCalendar);
    for (const workerGroupId of ['calendar-wrong-type', 'calendar-group-inactive', 'calendar-cross-legal', 'calendar-cross-org', 'missing-group']) {
      const code = `CAL-GROUP-BAD-${workerGroupId.replace(/[^A-Za-z0-9]/g, '-').toUpperCase()}`;
      const denied = await request('POST', '/api/organization-setup/calendars', calendarBody(code, { applicability: { type: 'worker_group', workerGroupId } }));
      expect(denied, 404); assert.equal(await calendarCount(code), 0);
    }
  });

  await check('effective versions preserve history/as-of authority and stale/overlapping writes fail closed', async () => {
    const successor = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-LEGAL', { name: 'Legal Calendar Successor', hoursPerDay: 7.5, effectiveFrom: '2026-07-01' }));
    expect(successor, 201); currentLegalCalendar = successor.body.id; assert.ok(currentLegalCalendar); assert.notEqual(currentLegalCalendar, legalCalendar);
    const old = await calendarFromList('CAL-LEGAL', '2026-06-30'); assert.ok(old); assert.equal(old.id, legalCalendar); assert.equal(Number(old.hours_per_day), 8);
    const current = await calendarFromList('CAL-LEGAL', '2026-07-01'); assert.ok(current); assert.equal(current.id, currentLegalCalendar); assert.equal(Number(current.hours_per_day), 7.5);
    const original = await calendarState(legalCalendar); assert.equal(original.effective_to, '2026-06-30');
    const currentState = await calendarState(currentLegalCalendar); assert.equal(currentState.effective_to, null);
    const before = await calendarCount('CAL-LEGAL');
    const stale = await request('POST', '/api/organization-setup/calendars', calendarBody('CAL-LEGAL', { effectiveFrom: '2026-06-01' }));
    expect(stale, 409); assert.equal(await calendarCount('CAL-LEGAL'), before);
    await expectDbError('23P01', client => client.query(`insert into working_calendars(organization_id,applicability_type,legal_entity_id,code,name,timezone,working_days,hours_per_day,effective_from,effective_to)
      values($1,'legal_entity',$2,'CAL-LEGAL','Overlapping Calendar','UTC',array[1,2,3,4,5],8,'2026-03-01','2026-08-01')`, [ORG, LEGAL]));
    const audits = await pool.query(`select entity_id,new_value,user_id,active_role from audit_logs where entity_id=any($1::text[]) and action='Version Calendar'`, [[legalCalendar, currentLegalCalendar]]);
    assert.equal(audits.rowCount, 2); assert.ok(audits.rows.every(row => String(row.user_id) === USER && row.active_role && row.new_value));
  });

  await check('work-week validation rejects duplicate/invalid weekdays and invalid daily hours without mutation', async () => {
    for (const [index, patch] of [{ workingDays: [1, 1, 2] }, { workingDays: [0, 8] }, { hoursPerDay: 0 }, { hoursPerDay: 24.01 }].entries()) {
      const code = `CAL-GROUP-INVALID-${index}`;
      const denied = await request('POST', '/api/organization-setup/calendars', calendarBody(code, { ...patch, applicability: { type: 'worker_group', workerGroupId: 'calendar-group' }, effectiveFrom: '2026-07-01' }));
      expect(denied, 400); assert.equal(await calendarCount(code), 0);
    }
  });

  let publicHoliday;
  let companyHoliday;
  await check('public/company holiday create/read/version/retire paths are transactionally audited', async () => {
    let response = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays`, { holidayType: 'Public', label: 'Synthetic Public Holiday', holidayDate: '2026-11-01', effectiveFrom: '2026-07-01' });
    expect(response, 201); publicHoliday = response.body.holiday_id; assert.ok(publicHoliday);
    response = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays`, { holidayType: 'Company', label: 'Synthetic Company Holiday', holidayDate: '2026-12-01', effectiveFrom: '2026-07-01' });
    expect(response, 201); companyHoliday = response.body.holiday_id; assert.ok(companyHoliday);
    let list = await request('GET', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays?asOf=2026-07-15`); expect(list, 200);
    assert.ok(list.body.some(row => row.holiday_id === publicHoliday)); assert.ok(list.body.some(row => row.holiday_id === companyHoliday));
    response = await request('PUT', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays/${companyHoliday}`, { holidayType: 'Company', label: 'Synthetic Company Holiday Updated', holidayDate: '2026-12-02', effectiveFrom: '2026-08-01' }); expect(response, 200);
    list = await request('GET', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays?asOf=2026-08-15`); expect(list, 200);
    assert.equal(list.body.find(row => row.holiday_id === companyHoliday)?.holiday_date, '2026-12-02');
    response = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays/${companyHoliday}/retire`, { reason: 'Synthetic retirement' }); expect(response, 200);
    const audits = await pool.query(`select action,old_value,new_value,user_id,active_role,source from audit_logs where entity_id in ($1,$2) order by created_at`, [publicHoliday, companyHoliday]);
    assert.ok(audits.rowCount >= 4, JSON.stringify(audits.rows)); assert.ok(audits.rows.every(row => String(row.user_id) === USER && row.active_role && row.source)); assert.ok(audits.rows.some(row => row.old_value && row.new_value));
  });

  await check('holiday overlap and same-org cross-legal/cross-org access fail deterministically without write', async () => {
    const beforeCount = await holidayCount(currentLegalCalendar);
    const beforePublic = await holidayState(publicHoliday);
    const overlap = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays`, { holidayType: 'Company', label: 'Conflicting Holiday', holidayDate: '2026-11-01', effectiveFrom: '2026-07-01' }); expect(overlap, 409);
    assert.equal(await holidayCount(currentLegalCalendar), beforeCount); assert.deepEqual(await holidayState(publicHoliday), beforePublic);
    const crossLegal = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays`, { holidayType: 'Company', label: 'Cross Legal Holiday', holidayDate: '2026-10-15', effectiveFrom: '2026-07-01' }, gbScope);
    expect(crossLegal, 404); assert.equal(await holidayCount(currentLegalCalendar), beforeCount);
    const crossOrg = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/holidays/${publicHoliday}/retire`, { reason: 'Spoof' }, otherScope);
    expect(crossOrg, 403); assert.deepEqual(await holidayState(publicHoliday), beforePublic);
  });

  await check('concurrent duplicate calendar and holiday writes yield one unambiguous authority', async () => {
    const duplicate = calendarBody('CAL-CONCURRENT');
    const calendars = await Promise.all([request('POST', '/api/organization-setup/calendars', duplicate), request('POST', '/api/organization-setup/calendars', duplicate)]);
    assert.deepEqual(calendars.map(value => value.status).sort((a,b) => a-b), [201, 409]);
    const id = calendars.find(value => value.status === 201).body.id; assert.ok(id); assert.equal(await calendarCount('CAL-CONCURRENT'), 1);
    const holiday = { holidayType: 'Public', label: 'Concurrent Holiday', holidayDate: '2026-10-01', effectiveFrom: '2026-01-01' };
    const holidays = await Promise.all([request('POST', `/api/organization-setup/calendars/${id}/holidays`, holiday), request('POST', `/api/organization-setup/calendars/${id}/holidays`, holiday)]);
    assert.deepEqual(holidays.map(value => value.status).sort((a,b) => a-b), [201, 409]);
    assert.equal(await count('working_calendar_holidays', 'calendar_id=$1 and holiday_date=$2', [id, '2026-10-01']), 1);
  });

  await check('calendar retirement fails CALENDAR_IN_USE for active worker and current holiday dependencies', async () => {
    await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,lifecycle_status,effective_from,working_calendar_id) values($1,$2,$3,'Active','2026-01-01',$4)
      on conflict(employee_id) do update set working_calendar_id=excluded.working_calendar_id,lifecycle_status='Active'`, [EMPLOYEE, ORG, LEGAL, currentLegalCalendar]);
    const before = await calendarState(currentLegalCalendar);
    let denied = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/retire`, { reason: 'Synthetic retirement' }); expect(denied, 409); assert.equal(denied.body.code, 'CALENDAR_IN_USE'); assert.deepEqual(await calendarState(currentLegalCalendar), before);
    await pool.query(`update worker_profiles set working_calendar_id=null where employee_id=$1`, [EMPLOYEE]);
    denied = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/retire`, { reason: 'Synthetic retirement' }); expect(denied, 409); assert.equal(denied.body.code, 'CALENDAR_IN_USE'); assert.deepEqual(await calendarState(currentLegalCalendar), before);
    const crossLegal = await request('POST', `/api/organization-setup/calendars/${currentLegalCalendar}/retire`, { reason: 'Cross legal spoof' }, gbScope); expect(crossLegal, 404); assert.deepEqual(await calendarState(currentLegalCalendar), before);
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 200));
  await pool.end();
}
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('WOS-02 working-calendar authority acceptance complete');
