import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import express from 'express';
import pg from 'pg';
import {registerOrganizationSetupRoutes} from '../server/organization-setup.mjs';
import {createRequestContextMiddleware} from '../server/api/request-context.mjs';
import {recordAuditEvent} from '../server/modules/audit/audit-record.mjs';

// WOS-ORG-006: PostgreSQL DATEs are calendar dates, not process-local instants.
// Source witnesses run without a socket; disposable PostgreSQL exercises the
// actual route, transaction and production audit writer in hosted acceptance.
const source = readFileSync(new URL('../server/organization-setup.mjs', import.meta.url), 'utf8');
const terminologyGet = source.match(/router\.get\('\/terminology'[\s\S]*?(?=\n  router\.post\('\/terminology')/)?.[0];
const terminologyPost = source.match(/router\.post\('\/terminology'[\s\S]*?(?=\n  router\.get\('\/readiness')/)?.[0];
assert(terminologyGet && terminologyPost, 'the established terminology routes remain present');
assert.match(terminologyGet, /select terms,effective_from::text effective_from,effective_to::text effective_to from terminology_versions t/,
  'GET transports DATE columns as calendar text');
assert.match(terminologyGet, /order by t\.effective_from desc/,
  'date selection orders by the underlying DATE, not the text output alias');
assert.match(terminologyPost, /select \*,effective_from::text effective_from,effective_to::text effective_to from terminology_versions where organization_id=\$1 order by terminology_versions\.effective_from desc for update/,
  'locked version comparison and audit use calendar dates in every process timezone');
assert.equal((terminologyPost.match(/returning \*,effective_from::text effective_from,effective_to::text effective_to/g) || []).length, 2,
  'both same-date replacement and inserted-version responses transport DATE columns as text');
assert.match(terminologyPost, /requirePermission\('settings\.manage'\)/);
assert.match(terminologyPost, /organizationScope:\{organizationId:req\.organizationScope\.organizationId,legalEntityId:null\}/,
  'terminology remains organization-wide rather than falsely legal-entity-owned');

const timezones = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'];
const driverDateJson = {
  UTC: '"2026-10-20T00:00:00.000Z"',
  'Asia/Kolkata': '"2026-10-19T18:30:00.000Z"',
  'America/Los_Angeles': '"2026-10-20T07:00:00.000Z"',
};

if (!process.env.WORKOS_TERMINOLOGY_DATE_CHILD) {
  for (const timezone of timezones) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {...process.env, TZ: timezone, WORKOS_TERMINOLOGY_DATE_CHILD: 'true'},
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(run.status, 0, `${timezone}: ${run.error?.message || ''}\n${run.stdout}\n${run.stderr}`);
    process.stdout.write(run.stdout);
  }
} else {
  assert(timezones.includes(process.env.TZ), 'child must run in a defined acceptance timezone');
  // This is the real installed pg parser, not a JavaScript date approximation.
  const driverDate = pg.types.getTypeParser(1082)('2026-10-20');
  assert(driverDate instanceof Date);
  assert.equal(JSON.stringify(driverDate), driverDateJson[process.env.TZ]);
  assert.equal(pg.types.getTypeParser(25)('2026-10-20'), '2026-10-20');
  const databaseUrl = process.env.WORKOS_TEST_DATABASE_URL;
  if (!databaseUrl) {
    assert(!process.env.CI || ['false', '0'].includes(process.env.CI.toLowerCase()),
      'hosted terminology date acceptance requires disposable PostgreSQL; it must not silently skip in CI');
    console.log(`Terminology date driver/SQL contract passed in ${process.env.TZ}; PostgreSQL route/audit acceptance NOT RUN locally (no disposable database).`);
  } else {
    const url = new URL(databaseUrl);
    assert(['postgres:', 'postgresql:'].includes(url.protocol));
    assert(['localhost', '127.0.0.1', 'postgres', '::1', '[::1]'].includes(url.hostname),
      'use only disposable local CI PostgreSQL');
    const database = new pg.Client({connectionString: databaseUrl});
    await database.connect();
    let server;
    try {
      // Temporary connection-local tables shadow retained tables. No migration,
      // retained rows, grants or schema are changed by this acceptance test.
      await database.query(`create temporary table terminology_versions (
        id uuid primary key default gen_random_uuid(),organization_id text not null,terms jsonb not null,
        effective_from date not null,effective_to date,created_by text,
        created_at timestamptz default now(),unique(organization_id,effective_from));
        create temporary table audit_logs (
          id bigint generated always as identity,user_id text,user_name text,user_role text,active_role text,
          source text,module text,action text,entity_type text,entity_id text,old_value jsonb,new_value jsonb,
          details text,reason text,ip_address text,session_id text,correlation_id text,operation_id text,
          import_batch_id text,source_identifier text,import_processing_result text,organization_id text,legal_entity_id text);`);
      const sqlWitness = (await database.query("select '2026-10-20'::date raw_date,'2026-10-20'::date::text calendar_date")).rows[0];
      assert.equal(JSON.stringify(sqlWitness.raw_date), driverDateJson[process.env.TZ]);
      assert.equal(sqlWitness.calendar_date, '2026-10-20', 'real SQL text cast preserves the calendar date');

      const organizationId = 'terminology-date-org';
      const actor = 'synthetic-terminology-date-actor';
      const today = new Date().toISOString().slice(0, 10);
      const offsetDate = days => {
        const date = new Date(`${today}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
      };
      const earlier = offsetDate(-1);
      const future = offsetDate(30);
      const beforeFuture = offsetDate(29);
      const keys = ['employee','manager','teamLead','businessUnit','region','regionalOwner','engagement','project','worklog'];
      const terms = label => Object.fromEntries(keys.map(key => [key, {
        singular: `${label} ${key}`,plural: `${label} ${key} plural`,helpText: `${label} help for ${key}`,
      }]));
      const initialTerms = terms('Synthetic initial');
      const editedTerms = terms('Synthetic edited');
      const scheduledTerms = terms('Synthetic scheduled');
      const editedScheduledTerms = terms('Synthetic scheduled edit');
      await database.query(`insert into terminology_versions(organization_id,terms,effective_from,created_by)
        values($1,$2,$3,$4),('terminology-other-org',$5,$3,'synthetic-other-actor')`,
      [organizationId, JSON.stringify(initialTerms), today, actor, JSON.stringify(terms('Other organization'))]);

      let connections = 0;
      const permissionChecks = [];
      const pool = {
        query(sql, values) {
          if (sql.includes('from user_organization_scopes s')) {
            const [userId, requestedOrganization, requestedLegalEntity] = values;
            const authorized = userId === actor && (!requestedOrganization || requestedOrganization === organizationId)
              && (!requestedLegalEntity || ['terminology-date-legal-a','terminology-date-legal-b'].includes(requestedLegalEntity));
            return Promise.resolve({rows: authorized ? [{organization_id: organizationId,
              legal_entity_id: requestedLegalEntity || 'terminology-date-legal-a'}] : []});
          }
          return database.query(sql, values);
        },
        async connect() {
          connections += 1;
          return {query: (sql, values) => database.query(sql, values),release() {}};
        },
      };
      const app = express();
      let requestId = 0;
      app.use('/api', createRequestContextMiddleware({idFactory: () => `terminology-date-${++requestId}`}));
      app.use(express.json());
      registerOrganizationSetupRoutes({app,pool,requireDatabase: (_req,_res,next) => next(),
        requireAuth: (req,_res,next) => {req.user = {sub: actor,username: 'Synthetic date admin',activeRole: 'Admin'};next();},
        requirePermission: permission => (req,res,next) => {
          assert.equal(permission, 'settings.manage');
          permissionChecks.push(permission);
          if (req.headers['x-settings-manage'] === 'deny') return res.status(403).json({error: 'Settings permission required'});
          next();
        },
        audit: recordAuditEvent,
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve,reject) => {server.once('listening',resolve);server.once('error',reject);});
      const endpoint = `http://127.0.0.1:${server.address().port}/api/organization-setup/terminology`;
      const send = (value, headers = {}) => fetch(endpoint, {method: 'POST',
        headers: {'Content-Type': 'application/json',...headers},body: JSON.stringify(value)});
      const readVersions = async () => (await database.query(`select organization_id,terms,effective_from::text effective_from,
        effective_to::text effective_to,created_by from terminology_versions order by organization_id,effective_from`)).rows;
      const readAudits = async () => (await database.query('select * from audit_logs order by id')).rows;

      let response = await fetch(endpoint);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {terms: initialTerms,effective_from: today,effective_to: null},
        'GET returns only current scoped terminology and unshifted calendar dates');
      assert.equal(permissionChecks.length, 0, 'authorized runtime reads do not acquire settings.manage');

      const beforeDenials = await readVersions();
      response = await send({terms: editedTerms,effectiveFrom: today}, {'x-settings-manage': 'deny'});
      assert.equal(response.status, 403, 'settings.manage denial runs before the mutation transaction');
      response = await send({terms: editedTerms,effectiveFrom: today}, {'x-organization-id': 'terminology-other-org'});
      assert.equal(response.status, 403, 'unresolved cross-organization scope cannot mutate terminology');
      assert.equal((await response.json()).code, 'ORG_SCOPE_DENIED');
      assert.equal(connections, 0);
      assert.equal(permissionChecks.length, 1, 'scope resolution rejects before the permission guard');
      assert.deepEqual(await readVersions(), beforeDenials);
      assert.deepEqual(await readAudits(), []);

      response = await send({terms: editedTerms,effectiveFrom: today});
      assert.equal(response.status, 200, 'same-calendar-date update must replace, not insert or conflict');
      const saved = await response.json();
      assert.equal(saved.organization_id, organizationId);
      assert.equal(saved.effective_from, today);
      assert.equal(saved.effective_to, null);
      assert.deepEqual(saved.terms, editedTerms);
      assert.equal(saved.created_by, actor);
      let audits = await readAudits();
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, 'Update Terminology');
      assert.equal(audits[0].old_value.effective_from, today, 'locked audit before value is a calendar date');
      assert.equal(audits[0].old_value.effective_to, null);
      assert.deepEqual(audits[0].old_value.terms, initialTerms);
      assert.deepEqual(audits[0].new_value.terms, editedTerms);
      assert.equal(audits[0].new_value.effective_from, today, 'persisted audit after value is a calendar date');
      assert.equal(audits[0].correlation_id, response.headers.get('x-correlation-id'));
      assert.equal(audits[0].operation_id, response.headers.get('x-operation-id'));

      const beforeConflict = await readVersions();
      response = await send({terms: initialTerms,effectiveFrom: earlier});
      assert.equal(response.status, 409, 'earlier non-exact date remains a stable conflict');
      assert.equal((await response.json()).code, 'TERMINOLOGY_VERSION_CONFLICT');
      assert.deepEqual(await readVersions(), beforeConflict, '409 rolls back without closing or changing a version');
      assert.equal((await readAudits()).length, 1, 'a rejected version writes no audit');

      response = await send({terms: scheduledTerms,effectiveFrom: future});
      assert.equal(response.status, 201, 'future date creates a scheduled version');
      const scheduled = await response.json();
      assert.equal(scheduled.effective_from, future);
      assert.equal(scheduled.effective_to, null);
      assert.deepEqual(scheduled.terms, scheduledTerms);
      audits = await readAudits();
      assert.equal(audits.length, 2);
      assert.equal(audits[1].action, 'Version Terminology');
      assert.equal(audits[1].old_value, null, 'new versions preserve existing version-audit semantics');
      assert.equal(audits[1].new_value.effective_from, future);

      response = await fetch(endpoint);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {terms: editedTerms,effective_from: today,effective_to: beforeFuture},
        'future save closes the prior date range without activating it early');
      response = await fetch(`${endpoint}?asOf=${beforeFuture}`);
      assert.deepEqual(await response.json(), {terms: editedTerms,effective_from: today,effective_to: beforeFuture},
        'prior version remains effective through its inclusive calendar end date');
      response = await fetch(`${endpoint}?asOf=${future}`, {headers: {'x-legal-entity-id': 'terminology-date-legal-b'}});
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {terms: scheduledTerms,effective_from: future,effective_to: null},
        'asOf switches on the exact future calendar date and terminology is shared by legal entities in the organization');

      response = await send({terms: editedScheduledTerms,effectiveFrom: future});
      assert.equal(response.status, 200, 'same-date scheduled replacement retains established last-writer semantics');
      assert.equal((await response.json()).effective_from, future);
      audits = await readAudits();
      assert.equal(audits.length, 3);
      assert.equal(audits[2].action, 'Update Terminology');
      assert.equal(audits[2].old_value.effective_from, future);
      assert.deepEqual(audits[2].old_value.terms, scheduledTerms);
      assert.equal(audits[2].new_value.effective_from, future);
      assert.deepEqual(audits[2].new_value.terms, editedScheduledTerms);
      for (const audit of audits) {
        assert.equal(audit.user_id, actor);
        assert.equal(audit.user_name, 'Synthetic date admin');
        assert.equal(audit.user_role, 'Admin');
        assert.equal(audit.active_role, 'Admin');
        assert.equal(audit.source, 'Web');
        assert.equal(audit.module, 'Organization Setup');
        assert.equal(audit.entity_type, 'Terminology');
        assert.equal(audit.entity_id, `${organizationId}:${audit.new_value.effective_from}`);
        assert.equal(audit.organization_id, organizationId);
        assert.equal(audit.legal_entity_id, null, 'production audit persists explicit organization-wide scope');
        assert.match(audit.correlation_id, /^terminology-date-\d+$/);
        assert.match(audit.operation_id, /^terminology-date-\d+$/);
        assert.notEqual(audit.correlation_id, audit.operation_id);
        assert.deepEqual(Object.keys(audit.new_value.terms).sort(), [...keys].sort(), 'display edits never alter canonical keys');
      }
      assert.equal(connections, 4, 'only authorized write attempts open the established transaction');
      assert.equal(permissionChecks.length, 5, 'each authorized-scope POST requires settings.manage');
      const versions = await readVersions();
      assert.equal(versions.filter(row => row.organization_id === organizationId).length, 2,
        'same-date replacement does not create an overlapping extra version');
      assert.deepEqual(versions.find(row => row.organization_id === 'terminology-other-org'), beforeDenials.find(row => row.organization_id === 'terminology-other-org'),
        'other organizations remain untouched');
      console.log(`Terminology actual PostgreSQL driver/GET/same-date POST/earlier409/future/current/asOf/persisted audit acceptance passed in ${process.env.TZ}.`);
    } finally {
      if (server) await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
      await database.end();
    }
  }
}
