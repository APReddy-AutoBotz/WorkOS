import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const pg = requireFromTarget('pg');
const pool = new pg.Pool({ connectionString: databaseUrl });
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({name, message:error?.message || String(error), stack:error?.stack}); console.error(`FAIL ${name}: ${error?.stack || error}`); }
};

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex'))));
  return `scrypt$${salt}$${key}`;
};
const today = new Date().toISOString().slice(0,10);
const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const adminId = '00000000-0000-0000-0000-000000000701';
const otherUserId = '00000000-0000-0000-0000-000000000702';
const password = 'WOS-Final-Closure-42!';
const scopeA = {'x-organization-id':'org-final','x-legal-entity-id':'legal-a'};
const scopeB = {'x-organization-id':'org-final','x-legal-entity-id':'legal-b'};

await pool.query(`insert into country_directors(id,name,region) values('cd-final','Final Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,effective_from) values
 ('org-final','ORG-FINAL','Final Org','2026-01-01'),
 ('org-other','ORG-OTHER','Other Org','2026-01-01')
 on conflict(id) do nothing`);
await pool.query(`insert into legal_entities(id,organization_id,code,name,effective_from) values
 ('legal-a','org-final','LEGAL-A','Legal A','2026-01-01'),
 ('legal-b','org-final','LEGAL-B','Legal B','2026-01-01'),
 ('legal-future','org-final','LEGAL-FUT','Future Legal','2099-01-01'),
 ('legal-other','org-other','LEGAL-O','Other Legal','2026-01-01')
 on conflict(id) do nothing`);

const adminHash = await hashPassword(password);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
 values('admin-final','ADMIN-FINAL','Final Admin','final-admin@example.test','System Administrator','Administration','Synthetic','cd-final','Active','org-final','legal-a')
 on conflict(id) do nothing`);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
 values($1,'final-admin','ADMIN-FINAL','admin-final','final-admin@example.test',$2,'Active')
 on conflict(id) do update set employee_record_id=excluded.employee_record_id,password_hash=excluded.password_hash,status='Active'`, [adminId, adminHash]);
const adminRole = (await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0];
assert.ok(adminRole, 'Admin role must exist after migrations');
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[adminId,adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values
 ($1,'org-final','legal-a',true),($1,'org-final','legal-b',true),($1,'org-final','legal-future',true)
 on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[adminId]);

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: targetRoot,
  env: {...process.env, DATABASE_URL:databaseUrl, API_SESSION_SECRET:'wos02-final-acceptance-secret', API_PORT:String(port), PORT:String(port), APP_MODE:'test', ALLOW_TEST_FALLBACK:'false', LOCAL_LOGIN_ENABLED:'true', NODE_ENV:'test'},
  stdio:['ignore','pipe','pipe'],
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { serverLog += chunk; process.stderr.write(chunk); });

const waitReady = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${origin}/api/health`); if (r.status < 500) return; } catch {}
    await new Promise(r => setTimeout(r,250));
  }
  throw new Error(`server did not become ready: ${serverLog}`);
};
await waitReady();

const call = async (method, route, {token, scope, body}={}) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers:{
      ...(body===undefined?{}:{'content-type':'application/json'}),
      ...(token?{authorization:`Bearer ${token}`}:{ }),
      ...(scope || {}),
    },
    body: body===undefined?undefined:JSON.stringify(body),
  });
  let payload; try { payload=await response.json(); } catch { payload=await response.text(); }
  return {status:response.status, body:payload};
};

let adminToken = '';
try {
  await check('local synthetic admin login binds employee record identity', async()=>{
    const r=await call('POST','/api/auth/login',{body:{username:'final-admin',password,requestedRole:'Admin'}});
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(r.body.employeeRecordId,'admin-final');
    adminToken=r.body.token;
    assert.ok(adminToken);
  });

  await check('multi-scope discovery excludes future legal entity and supports explicit selection', async()=>{
    const scopes=await call('GET','/api/auth/organization-scopes',{token:adminToken});
    assert.equal(scopes.status,200);
    const keys=scopes.body.map(x=>`${x.organizationId}:${x.legalEntityId}`);
    assert.deepEqual(keys.sort(),['org-final:legal-a','org-final:legal-b']);
    const ambiguous=await call('GET','/api/auth/me',{token:adminToken});
    assert.equal(ambiguous.status,403);
    const selected=await call('GET','/api/auth/me',{token:adminToken,scope:scopeA});
    assert.equal(selected.status,200);
    const future=await call('GET','/api/auth/me',{token:adminToken,scope:{'x-organization-id':'org-final','x-legal-entity-id':'legal-future'}});
    assert.equal(future.status,403);
  });

  await check('canonical employee create/upsert propagates ownership and provisions user scope atomically', async()=>{
    const body={employee_id:'E-SCOPED',name:'Scoped Employee',email:'scoped@example.test',designation:'Engineer',department:'Delivery',country:'Synthetic',primary_country_director_id:'cd-final',mapped_country_director_ids:[],roles:['Employee'],initial_password:'Scoped-User-42!',status:'Active'};
    const first=await call('POST','/api/employees',{token:adminToken,scope:scopeA,body});
    assert.equal(first.status,200,JSON.stringify(first.body));
    const second=await call('POST','/api/employees',{token:adminToken,scope:scopeA,body:{...body,name:'Scoped Employee Updated',initial_password:undefined}});
    assert.equal(second.status,200,JSON.stringify(second.body));
    const e=(await pool.query(`select id,organization_id,legal_entity_id,name from employees where organization_id='org-final' and employee_id='E-SCOPED'`)).rows;
    assert.equal(e.length,1); assert.equal(e[0].organization_id,'org-final'); assert.equal(e[0].legal_entity_id,'legal-a'); assert.equal(e[0].name,'Scoped Employee Updated');
    const u=(await pool.query(`select id,employee_record_id from users where employee_record_id=$1`,[e[0].id])).rows[0];
    assert.ok(u);
    const s=(await pool.query(`select count(*)::int count from user_organization_scopes where user_id=$1 and organization_id='org-final' and legal_entity_id='legal-a' and active`,[u.id])).rows[0];
    assert.equal(s.count,1);
  });

  await check('duplicate employee IDs across organizations use unambiguous employee-record identity and ambiguous employee-code login fails closed', async()=>{
    const otherHash=await hashPassword(password);
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('other-e','E-SCOPED','Other Scoped','other-scoped@example.test','Engineer','Delivery','Synthetic','cd-final','Active','org-other','legal-other')`);
    await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,password_hash,status)
      values($1,'other-user','E-SCOPED','other-e','other-user@example.test',$2,'Active')`,[otherUserId,otherHash]);
    const employeeRole=(await pool.query(`select id from roles where name='Employee' limit 1`)).rows[0];
    await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[otherUserId,employeeRole.id]);
    await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,'org-other','legal-other',true)`,[otherUserId]);
    const named=await call('POST','/api/auth/login',{body:{username:'other-user',password}});
    assert.equal(named.status,200); assert.equal(named.body.employeeRecordId,'other-e');
    const ambiguous=await call('POST','/api/auth/login',{body:{username:'E-SCOPED',password}});
    assert.notEqual(ambiguous.status,200,`ambiguous employee-code login authenticated as ${JSON.stringify(ambiguous.body)}`);
  });

  await check('protected employee read is organization/legal scoped', async()=>{
    const a=await call('GET','/api/employees',{token:adminToken,scope:scopeA});
    assert.equal(a.status,200); assert.equal(a.body.some(x=>x.id==='other-e'),false);
    const b=await call('GET','/api/employees',{token:adminToken,scope:scopeB});
    assert.equal(b.status,200); assert.equal(b.body.some(x=>x.employee_id==='E-SCOPED'),false);
  });

  let workerTypeId;
  await check('governed setup authoring and current-effective readiness', async()=>{
    const wt=await call('POST','/api/organization-setup/catalogs/worker_type',{token:adminToken,scope:scopeA,body:{code:'WT-FINAL',name:'Final Worker',effectiveFrom:'2026-01-01'}});
    assert.equal(wt.status,201,JSON.stringify(wt.body)); workerTypeId=wt.body.id;
    const futureCal=await call('POST','/api/organization-setup/calendars',{token:adminToken,scope:scopeA,body:{code:'CAL-FUTURE',name:'Future Calendar',timezone:'UTC',workingDays:[1,2,3,4,5],hoursPerDay:8,effectiveFrom:'2099-01-01'}});
    assert.equal(futureCal.status,201);
    const oldPeriod=await call('POST','/api/organization-setup/reporting-periods',{token:adminToken,scope:scopeA,body:{code:'PERIOD-OLD',name:'Old Period',startsOn:'2025-01-01',endsOn:'2025-12-31',status:'Closed'}});
    assert.equal(oldPeriod.status,201);
    const before=await call('GET','/api/organization-setup/readiness?ready=true',{token:adminToken,scope:scopeA});
    assert.equal(before.status,200); assert.equal(before.body.ready,false); assert.equal(before.body.authority,'persisted-server-state');
    const cal=await call('POST','/api/organization-setup/calendars',{token:adminToken,scope:scopeA,body:{code:'CAL-CURRENT',name:'Current Calendar',timezone:'UTC',workingDays:[1,2,3,4,5],hoursPerDay:8,effectiveFrom:'2026-01-01'}});
    assert.equal(cal.status,201,JSON.stringify(cal.body));
    const period=await call('POST','/api/organization-setup/reporting-periods',{token:adminToken,scope:scopeA,body:{code:'PERIOD-CURRENT',name:'Current Period',startsOn:'2026-01-01',endsOn:'2026-12-31',status:'Open'}});
    assert.equal(period.status,201,JSON.stringify(period.body));
    const after=await call('GET','/api/organization-setup/readiness',{token:adminToken,scope:scopeA});
    assert.equal(after.status,200); assert.equal(after.body.ready,true,JSON.stringify(after.body));
  });

  await check('terminology is effective-dated at API and wired to a runtime frontend consumer', async()=>{
    const current=await call('POST','/api/organization-setup/terminology',{token:adminToken,scope:scopeA,body:{terms:{employee:'Colleague',project:'Engagement'},effectiveFrom:'2026-01-01'}});
    assert.equal(current.status,201);
    const future=await call('POST','/api/organization-setup/terminology',{token:adminToken,scope:scopeA,body:{terms:{employee:'Future Colleague'},effectiveFrom:'2099-01-01'}});
    assert.equal(future.status,201);
    const now=await call('GET','/api/organization-setup/terminology',{token:adminToken,scope:scopeA});
    assert.equal(now.status,200); assert.equal(now.body.terms.employee,'Colleague');
    const frontendFiles=['src/App.tsx','src/components/Layout/Header.tsx','src/config/productConfig.ts','src/services/apiClient.ts','src/services/api.ts','src/pages/AdminSettings.tsx'];
    const runtimeText=frontendFiles.map(f=>readFileSync(path.join(targetRoot,f),'utf8')).join('\n');
    assert.match(runtimeText,/organization-setup\/terminology/, 'persisted terminology must be consumed by a runtime frontend surface');
  });

  await check('working-calendar overlap is rejected by database constraint', async()=>{
    await assert.rejects(
      ()=>pool.query(`insert into working_calendars(organization_id,legal_entity_id,code,name,timezone,working_days,hours_per_day,effective_from,effective_to)
        values('org-final','legal-a','CAL-CURRENT','Overlap','UTC',array[1,2,3,4,5],8,'2026-06-01','2026-12-31')`),
      e=>e?.code==='23P01'
    );
  });

  const scopedEmployee=(await pool.query(`select id from employees where organization_id='org-final' and employee_id='E-SCOPED'`)).rows[0].id;
  await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,worker_type_id,lifecycle_status,effective_from)
    values($1,'org-final','legal-a',$2,'Active','2026-01-01') on conflict(employee_id) do update set worker_type_id=excluded.worker_type_id,organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id,lifecycle_status='Active',effective_from='2026-01-01'`,[scopedEmployee,workerTypeId]);
  await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)
    values($1,'org-final','legal-a','2026-01-01','Active','{"seed":true}'::jsonb) on conflict do nothing`,[scopedEmployee]);

  await check('future-dated worker transition fails closed without premature current-state mutation', async()=>{
    const r=await call('POST',`/api/organization-setup/workers/${scopedEmployee}/transition`,{token:adminToken,scope:scopeA,body:{status:'Exited',effectiveFrom:'2099-01-01',reason:'future acceptance',idempotencyKey:'future-transition-701'}});
    assert.equal(r.status,409); assert.equal(r.body.code,'FUTURE_TRANSITION_UNSUPPORTED');
    const state=(await pool.query(`select e.status,wp.lifecycle_status from employees e join worker_profiles wp on wp.employee_id=e.id where e.id=$1`,[scopedEmployee])).rows[0];
    assert.equal(state.status,'Active'); assert.equal(state.lifecycle_status,'Active');
  });

  await pool.query(`insert into clients(id,name,status,organization_id,legal_entity_id) values('client-final','Final Client','Active','org-final','legal-a') on conflict(id) do nothing`);
  await pool.query(`insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,billable,start_date,end_date,status,organization_id,legal_entity_id)
    values('project-final','P-FINAL','Final Project','client-final','Final Client','admin-final','Final Admin',true,'2026-01-01','2026-12-31','Active','org-final','legal-a') on conflict(id) do nothing`);

  await check('canonical allocation import creates a scoped allocation', async()=>{
    const r=await call('POST','/api/imports/allocations/apply',{token:adminToken,scope:scopeA,body:{fileName:'synthetic-allocation.csv',rows:[{id:'alloc-import-final',employeeId:scopedEmployee,projectId:'project-final',percentage:50,startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',billable:true}]}});
    assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.status,'Success',JSON.stringify(r.body));
    const row=(await pool.query(`select organization_id from project_allocations where id='alloc-import-final'`)).rows[0];
    assert.equal(row?.organization_id,'org-final');
  });

  await check('canonical timesheet import creates a scoped timesheet', async()=>{
    const r=await call('POST','/api/imports/timesheets/apply',{token:adminToken,scope:scopeA,body:{fileName:'synthetic-timesheet.csv',rows:[{employeeId:scopedEmployee,weekEnding:'2026-09-06',workType:'Project Work',projectId:'project-final',date:'2026-09-01',hours:8,billable:true,status:'Draft'}]}});
    assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.status,'Success',JSON.stringify(r.body));
    const row=(await pool.query(`select organization_id from timesheets where employee_id=$1 and week_ending='2026-09-06'`,[scopedEmployee])).rows[0];
    assert.equal(row?.organization_id,'org-final');
  });

  await check('canonical employee deactivation is blocked by active dependencies with no write', async()=>{
    const before=(await pool.query(`select status from employees where id=$1`,[scopedEmployee])).rows[0].status;
    const r=await call('DELETE',`/api/employees/${scopedEmployee}`,{token:adminToken,scope:scopeA,body:{reason:'dependency acceptance'}});
    assert.equal(r.status,409,JSON.stringify(r.body)); assert.equal(r.body.code,'WORKER_DEPENDENCY_CONFLICT');
    const after=(await pool.query(`select status from employees where id=$1`,[scopedEmployee])).rows[0].status;
    assert.equal(after,before);
  });

  await check('worker history preserves legal ownership across transfer', async()=>{
    await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
      values('worker-transfer','W-TRANSFER','Transfer Worker','transfer@example.test','Engineer','Delivery','Synthetic','cd-final','Active','org-final','legal-a')`);
    await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,worker_type_id,lifecycle_status,effective_from)
      values('worker-transfer','org-final','legal-a',$1,'Active','2026-01-01')`,[workerTypeId]);
    await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,effective_to,status,snapshot)
      values('worker-transfer','org-final','legal-a','2026-01-01','2026-06-30','Active','{"phase":"a"}'::jsonb)`);
    await pool.query(`update employees set legal_entity_id='legal-b' where id='worker-transfer'`);
    await pool.query(`update worker_profiles set legal_entity_id='legal-b',effective_from='2026-07-01' where employee_id='worker-transfer'`);
    await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)
      values('worker-transfer','org-final','legal-b','2026-07-01','Active','{"phase":"b"}'::jsonb)`);
    const history=(await pool.query(`select legal_entity_id from worker_history where employee_id='worker-transfer' order by effective_from`)).rows.map(r=>r.legal_entity_id);
    assert.deepEqual(history,['legal-a','legal-b']);
    const current=await call('GET','/api/organization-setup/workers/worker-transfer/history',{token:adminToken,scope:scopeB});
    assert.equal(current.status,200); assert.deepEqual([...new Set(current.body.map(x=>x.legal_entity_id))],['legal-b']);
  });
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { child.once('exit',resolve); setTimeout(resolve,2000); });
  await pool.end();
}

if (failures.length) {
  console.error(JSON.stringify({status:'failed',failures},null,2));
  process.exit(1);
}
console.log(JSON.stringify({status:'passed',checks:13,today},null,2));
