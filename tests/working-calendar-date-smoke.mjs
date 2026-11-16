import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import express from 'express';
import pg from 'pg';
import {registerOrganizationSetupRoutes} from '../server/organization-setup.mjs';
const source = readFileSync(new URL('../server/organization-setup.mjs',import.meta.url),'utf8');
const calendarGet = source.match(/router\.get\('\/calendars'[\s\S]*?(?=\n  router\.post\('\/calendars')/)?.[0];
const holidayGet = source.match(/router\.get\('\/calendars\/:id\/holidays'[\s\S]*?(?=\n  const mutateHoliday)/)?.[0];
assert.match(calendarGet, /select c\.\*,c\.effective_from::text effective_from,c\.effective_to::text effective_to from working_calendars c/);
assert.match(holidayGet, /select h\.\*,h\.holiday_date::text holiday_date,h\.effective_from::text effective_from,h\.effective_to::text effective_to from working_calendar_holidays h/);
assert.match(calendarGet,/order by c\.code,c\.effective_from desc limit \$4/);
assert.match(holidayGet,/order by h\.holiday_date,h\.label limit \$4/);
const zones = ['UTC','Asia/Kolkata','America/Los_Angeles'];
const expected = {UTC:'"2026-10-20T00:00:00.000Z"','Asia/Kolkata':'"2026-10-19T18:30:00.000Z"','America/Los_Angeles':'"2026-10-20T07:00:00.000Z"'};
if (!process.env.WORKOS_CALENDAR_DATE_CHILD) {
  for (const TZ of zones) {
    const run = spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,TZ,WORKOS_CALENDAR_DATE_CHILD:'true'},encoding:'utf8',timeout:60000});
    assert.equal(run.status,0,`${TZ}: ${run.error?.message || ''}\n${run.stdout}\n${run.stderr}`);process.stdout.write(run.stdout);
  }
} else {
  assert(zones.includes(process.env.TZ));
  assert.equal(JSON.stringify(pg.types.getTypeParser(1082)('2026-10-20')),expected[process.env.TZ]);
  assert.equal(pg.types.getTypeParser(25)('2026-10-20'),'2026-10-20');
  const databaseUrl = process.env.WORKOS_TEST_DATABASE_URL;
  if (!databaseUrl) {
    assert(!process.env.CI || ['false','0'].includes(process.env.CI.toLowerCase()),'CI calendar date acceptance requires disposable PostgreSQL, never a silent skip');
    console.log(`Working calendar DATE driver/SQL witnesses passed in ${process.env.TZ}; actual PostgreSQL GET route acceptance NOT RUN locally (no disposable database).`);
  } else {
    const url = new URL(databaseUrl);
    assert(['postgres:','postgresql:'].includes(url.protocol));assert(['localhost','127.0.0.1','postgres','::1','[::1]'].includes(url.hostname));
    const db = new pg.Client({connectionString:databaseUrl});await db.connect();let server;
    try {
      await db.query(`create temporary table legal_entities(id text,organization_id text,country_code text);
        create temporary table organization_catalog_items(id text,organization_id text,legal_entity_id text);
        create temporary table working_calendars(id text,organization_id text,legal_entity_id text,applicability_type text,country_code text,country_authority_legal_entity_id text,worker_group_id text,code text,name text,timezone text,working_days integer[],hours_per_day numeric,effective_from date,effective_to date,active boolean);
        create temporary table working_calendar_holidays(id text,holiday_id text,calendar_id text,organization_id text,holiday_date date,label text,holiday_type text,effective_from date,effective_to date,active boolean);
        insert into legal_entities values('legal-a','org-a','IN'),('legal-b','org-a','US'),('legal-c','org-a','IN'),('legal-foreign','org-foreign','IN');
        insert into organization_catalog_items values('group-version-a','org-a',null),('group-version-b','org-a','legal-b');
        insert into working_calendars values
          ('calendar-a','org-a','legal-a','legal_entity',null,null,null,'A_LEGAL','Synthetic legal calendar','Asia/Kolkata','{1,2,3,4,5}',7.5,'2020-01-01','2030-10-20',false),
          ('calendar-country','org-a',null,'country','IN','legal-c',null,'B_COUNTRY','Synthetic country calendar','UTC','{0,1,2,3,4}',8,'2020-01-01',null,true),
          ('calendar-group','org-a',null,'worker_group',null,null,'group-version-a','C_GROUP','Synthetic group calendar','America/Los_Angeles','{1,2,3}',6,'2020-01-01',null,true),
          ('calendar-other-legal','org-a','legal-b','legal_entity',null,null,null,'D_OTHER','Other legal','UTC','{1}',8,'2020-01-01',null,true),
          ('calendar-other-group','org-a',null,'worker_group',null,null,'group-version-b','E_OTHER','Other group','UTC','{1}',8,'2020-01-01',null,true),
          ('calendar-future','org-a','legal-a','legal_entity',null,null,null,'F_FUTURE','Future','UTC','{1}',8,'2999-01-01',null,true),
          ('calendar-past','org-a','legal-a','legal_entity',null,null,null,'G_PAST','Past','UTC','{1}',8,'2000-01-01','2001-01-01',false),
          ('calendar-foreign','org-foreign','legal-foreign','legal_entity',null,null,null,'H_FOREIGN','Foreign','UTC','{1}',8,'2020-01-01',null,true);
        insert into working_calendar_holidays values
          ('holiday-version-a','holiday-a','calendar-a','org-a','2026-10-20','Synthetic holiday','Public','2020-01-01','2030-10-20',false),
          ('holiday-version-b','holiday-b','calendar-a','org-a','2027-01-01','Future holiday date','Company','2020-01-01',null,true),
          ('holiday-old','holiday-old','calendar-a','org-a','2026-01-01','No longer effective','Public','2000-01-01','2001-01-01',false),
          ('holiday-future','holiday-future','calendar-a','org-a','2027-01-02','Future effective','Company','2999-01-01',null,true),
          ('holiday-unretired-inactive','holiday-inactive','calendar-a','org-a','2026-01-02','Inactive without bounds','Company','2020-01-01',null,false),
          ('holiday-foreign','holiday-foreign','calendar-a','org-foreign','2026-01-03','Foreign owner','Public','2020-01-01',null,true);`);
      const sql = (await db.query("select '2026-10-20'::date raw_date,'2026-10-20'::date::text calendar_date")).rows[0];
      assert.equal(JSON.stringify(sql.raw_date),expected[process.env.TZ]);assert.equal(sql.calendar_date,'2026-10-20');
      const baseline = async () => (await db.query('select (select count(*) from working_calendars) calendars,(select count(*) from working_calendar_holidays) holidays')).rows[0];
      let audits = 0, connects = 0, readPermissionChecks = 0;const requests = [];
      const pool = {async query(query,values) {
        assert.match(query.trim(),/^select\b/i,'explicit no business SQL mutation assertion');requests.push({query,values});
        if (query.includes('from user_organization_scopes s')) {
          const [actor,org,legal] = values;
          return {rows: actor === 'synthetic-calendar-reader' && (!org || org === 'org-a') && (!legal || ['legal-a','legal-b','legal-c'].includes(legal))
            ? [{organization_id:'org-a',legal_entity_id:legal || 'legal-a'}] : []};
        }
        return db.query(query,values);
      },async connect() {connects++;throw new Error('GET cannot open mutation transaction');}};
      const app = express();app.use(express.json());
      registerOrganizationSetupRoutes({app,pool,requireDatabase:(_q,_s,next)=>next(),requireAuth:(req,_res,next)=>{req.user={sub:'synthetic-calendar-reader'};next();},
        requirePermission:permission=>(_req,_res,next)=>{assert.equal(permission,'settings.manage');readPermissionChecks++;next();},audit:()=>{audits++;throw new Error('read cannot audit mutation');}});
      server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const endpoint=`http://127.0.0.1:${server.address().port}/api/organization-setup/calendars`;
      const get = (suffix='',headers={}) => fetch(`${endpoint}${suffix}${suffix.includes('?') ? '&' : '?'}asOf=2026-10-20`,{headers});
      const before = await baseline();
      let res=await get();assert.equal(res.status,200);let calendars=await res.json();
      assert.deepEqual(calendars.map(row=>row.id),['calendar-a','calendar-country','calendar-group']);
      assert.equal(calendars[0].effective_from,'2020-01-01');assert.equal(calendars[0].effective_to,'2030-10-20');assert.equal(calendars[0].active,false);
      assert.equal(calendars[1].country_authority_legal_entity_id,'legal-c');assert.equal(calendars[2].worker_group_id,'group-version-a');
      res=await get('/calendar-a/holidays');assert.equal(res.status,200);let holidays=await res.json();
      assert.deepEqual(holidays.map(row=>row.id),['holiday-version-a','holiday-version-b']);
      assert.equal(holidays[0].holiday_date,'2026-10-20');assert.equal(holidays[0].effective_from,'2020-01-01');assert.equal(holidays[0].effective_to,'2030-10-20');assert.equal(holidays[0].active,false);
      assert.equal(holidays[1].holiday_date,'2027-01-01','holiday date need not equal effective date or current year');
      res=await get('/calendar-group/holidays');assert.deepEqual(await res.json(),[]);
      for (const id of ['calendar-foreign','calendar-other-legal','calendar-other-group','unknown-calendar']) {res=await get(`/${id}/holidays`);assert.equal(res.status,404);assert.deepEqual(await res.json(),{error:'Working calendar not found'});}
      for (const headers of [{'x-organization-id':'org-foreign'},{'x-legal-entity-id':'legal-foreign'}]) {
        for (const suffix of ['', '/calendar-a/holidays']) {res=await get(suffix,headers);assert.equal(res.status,403);assert.equal((await res.json()).code,'ORG_SCOPE_DENIED');}
      }
      res=await get('',{'x-legal-entity-id':'legal-b'});assert.deepEqual((await res.json()).map(row=>row.id),['calendar-group','calendar-other-legal','calendar-other-group']);
      assert.deepEqual(await baseline(),before);assert.equal(audits,0);assert.equal(connects,0);assert.ok(readPermissionChecks>0,'calendar inspection requires protected settings permission');
      await db.query(`insert into working_calendars select 'cap-calendar-'||n,'org-a','legal-a','legal_entity',null,null,null,'Z_CAP_'||lpad(n::text,3,'0'),'Synthetic capped calendar','UTC','{1}'::int[],8,'2020-01-01',null,true from generate_series(1,205) n;
        insert into working_calendar_holidays select 'cap-holiday-'||n,'cap-logical-'||n,'calendar-group','org-a','2026-10-20'::date,'Synthetic capped holiday '||lpad(n::text,3,'0'),'Public','2020-01-01',null,true from generate_series(1,205) n;`);
      res=await get();calendars=await res.json();assert.equal(calendars.length,200);assert.equal(calendars[0].id,'calendar-a');
      res=await get('/calendar-group/holidays');holidays=await res.json();assert.equal(holidays.length,200);assert.equal(holidays[0].label,'Synthetic capped holiday 001');
      for (const request of requests.filter(item=>item.values?.length===4 && !item.query.includes('user_organization_scopes'))) assert.equal(request.values.at(-1),200);
      assert.equal(audits,0);assert.equal(connects,0);assert.ok(readPermissionChecks>0,'calendar inspection requires protected settings permission');
      console.log(`Working calendar actual PostgreSQL GET dates/applicability/ownership/holiday bounds/inactive/empty/cap/no-mutation acceptance passed in ${process.env.TZ}.`);
    } finally {if(server) await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.end();}
  }
}
