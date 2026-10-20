import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import express from 'express';
import pg from 'pg';
import {registerOrganizationSetupRoutes} from '../server/organization-setup.mjs';

const source = readFileSync(new URL('../server/organization-setup.mjs', import.meta.url), 'utf8');
const profileSelect = source.match(/const profileSelect = `([\s\S]*?)`;/)?.[1];
assert(profileSelect);
assert.match(profileSelect, /p\.effective_from::text profile_effective_from,p\.effective_to::text profile_effective_to/);
assert.match(source, /select \*,effective_from::text effective_from,effective_to::text effective_to from organization_profile_versions where organization_id=\$1 order by organization_profile_versions\.effective_from desc limit 1 for update/,
  'locked latest-profile comparison and audit must use calendar dates, not process-timezone Date objects');

if (!process.env.WORKOS_PROFILE_DATE_CHILD) {
  for (const timezone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {...process.env, TZ: timezone, WORKOS_PROFILE_DATE_CHILD: 'true'}, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(run.status, 0, `${timezone}: ${run.stdout}\n${run.stderr}`);
    process.stdout.write(run.stdout);
  }
} else {
  // A real driver witness proves why the profile SELECT casts are required.
  const driverDate = pg.types.getTypeParser(1082)('2026-10-20');
  if (process.env.TZ === 'Asia/Kolkata') assert.equal(JSON.stringify(driverDate), '"2026-10-19T18:30:00.000Z"');
  assert.equal(pg.types.getTypeParser(25)('2026-10-20'), '2026-10-20');
  const databaseUrl = process.env.WORKOS_TEST_DATABASE_URL;
  if (!databaseUrl) {
    assert.notEqual(process.env.CI, 'true', 'hosted date acceptance requires disposable PostgreSQL');
    console.log(`Profile date driver/SQL contract passed in ${process.env.TZ}; PostgreSQL route acceptance NOT RUN locally (no disposable database).`);
  } else {
    const url = new URL(databaseUrl);
    assert(['postgres:', 'postgresql:'].includes(url.protocol));
    assert(['localhost', '127.0.0.1', 'postgres', '::1', '[::1]'].includes(url.hostname), 'use only disposable local CI PostgreSQL');
    const database = new pg.Client({connectionString: databaseUrl});
    await database.connect();
    const audits = [];
    let guardChecks = 0;
    let server;
    try {
      // Connection-local temporary tables exercise the actual route SQL and
      // transaction without changing the retained schema or any other tests.
      await database.query(`create temporary table organizations (id text primary key,code text,name text,updated_at timestamptz);
        create temporary table organization_profile_versions (
          id uuid primary key default gen_random_uuid(),organization_id text,name text,legal_name text,product_display_name text,
          support_contact text,default_locale text,default_time_zone text,base_currency text,fiscal_year_start text,
          default_week_start integer,effective_from date,effective_to date,created_by text,unique(organization_id,effective_from));
        insert into organizations values('profile-date-org','SYN-DATE','Synthetic date organization',now());`);
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const earlier = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const profile = {organizationId: 'profile-date-org',name: 'Synthetic date organization',legalName: 'Synthetic legal name',
        productDisplayName: 'Synthetic date workspace',supportContact: 'support@example.invalid',defaultLocale: 'en-US',
        defaultTimeZone: 'UTC',baseCurrency: 'USD',fiscalYearStart: '01-01',defaultWeekStart: 1,effectiveFrom: today};
      await database.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,
        default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from,created_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'synthetic-date-actor')`, Object.values(profile));
      const pool = {
        query: (sql, values) => sql.includes('from user_organization_scopes s')
          ? Promise.resolve({rows: [{organization_id: 'profile-date-org',legal_entity_id: 'profile-date-legal'}]})
          : database.query(sql, values),
        connect: async () => ({query: (sql, values) => database.query(sql, values),release() {}}),
      };
      const app = express();
      app.use(express.json());
      registerOrganizationSetupRoutes({app,pool,requireDatabase: (_req,_res,next) => next(),
        requireAuth: (req,_res,next) => {req.user = {sub: 'synthetic-date-actor',activeRole: 'Admin'};next();},
        requirePermission: permission => (_req,_res,next) => {assert.equal(permission,'settings.manage');guardChecks += 1;next();},
        audit: async (_client,_req,event) => {audits.push(event);},
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve,reject) => {server.once('listening',resolve);server.once('error',reject);});
      const endpoint = `http://127.0.0.1:${server.address().port}/api/organization-setup/profile`;
      const send = value => fetch(endpoint, {method: 'PUT',headers: {'Content-Type': 'application/json'},body: JSON.stringify(value)});
      let response = await fetch(endpoint);
      assert.equal(response.status,200);
      assert.equal((await response.json()).profile_effective_from,today,'GET returns the actual calendar date in every process timezone');
      response = await send({...profile,name: 'Synthetic same-day edit'});
      assert.equal(response.status,200,'same-date update must not accidentally close a prior-day profile');
      const saved = await response.json();
      assert.equal(saved.profile_effective_from,today);
      assert.equal(saved.profile_effective_to,null);
      assert.equal(audits.length,1);
      assert.equal(audits[0].oldValue.effective_from,today,'latest locked profile audit preserves the calendar date');
      response = await send({...profile,effectiveFrom: earlier});
      assert.equal(response.status,409,'earlier date remains a stable no-write conflict');
      assert.equal(audits.length,1);
      response = await send({...profile,name: 'Synthetic scheduled name',effectiveFrom: future});
      assert.equal(response.status,200);
      assert.equal((await response.json()).profile_effective_from,future,'scheduled response date is not shifted');
      response = await fetch(endpoint);
      const current = await response.json();
      assert.equal(current.profile_effective_from,today);
      assert.equal(current.organization_name,'Synthetic same-day edit','future date does not replace current version early');
      const expectedEnd = new Date(`${future}T00:00:00.000Z`);expectedEnd.setUTCDate(expectedEnd.getUTCDate()-1);
      assert.equal(current.profile_effective_to,expectedEnd.toISOString().slice(0,10));
      response = await fetch(`${endpoint}?asOf=${future}`);
      assert.equal((await response.json()).profile_effective_from,future);
      assert.equal(guardChecks,3);
      console.log(`Profile actual PostgreSQL GET/same-date PUT/earlier409/future/current/asOf/audit acceptance passed in ${process.env.TZ}.`);
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      await database.end();
    }
  }
}
