// Controller-only exact-head readiness acceptance for WOS-ORG-010.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const targetRoot=process.env.TARGET_ROOT;
const databaseUrl=process.env.DATABASE_URL;
if(!targetRoot||!databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');
const pg=createRequire(path.join(targetRoot,'package.json'))('pg');
const pool=new pg.Pool({connectionString:databaseUrl});
const failures=[];
const check=async(name,fn)=>{try{await fn();console.log(`PASS ${name}`);}catch(error){failures.push({name,error:error?.stack||String(error)});console.error(`FAIL ${name}: ${error?.stack||error}`);}};

const ORG='org-ready';
const LEGAL='legal-ready';
const OTHER='legal-ready-other';
const USER='00000000-0000-0000-0000-000000000981';
const EMP='admin-ready';
const OTHER_USER='00000000-0000-0000-0000-000000000982';
const OTHER_EMP='admin-ready-other';
const PROBE_USER='00000000-0000-0000-0000-000000000983';
const SECRET='readiness-acceptance-session-secret';
const safeEnv={DATABASE_URL:databaseUrl,API_SESSION_SECRET:SECRET,NODE_ENV:'production',APP_MODE:'production',ALLOW_TEST_FALLBACK:'false',AUTO_SEED_DEMO:'false',LOCAL_LOGIN_ENABLED:'false',APP_URL:'https://workos-readiness.example.test',IDENTITY_PROVIDER:'entra',ENTRA_TENANT_ID:'synthetic-tenant',ENTRA_CLIENT_ID:'synthetic-client',ENTRA_CLIENT_SECRET:'synthetic-secret',ENTRA_REDIRECT_URI:'https://workos-readiness.example.test/auth/callback'};
const sign=payload=>{const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return `${body}.${crypto.createHmac('sha256',SECRET).update(body).digest('base64url')}`;};
const token=sign({sub:USER,username:'readiness-admin',activeRole:'Admin',employeeRecordId:EMP,employeeId:'ADMIN-READY',exp:Date.now()+3600000});
// A scoped, active user with no employee record lets the readiness endpoint
// report missing initial-user facts without authenticating as a disabled user.
const probeToken=sign({sub:PROBE_USER,username:'readiness-scope-probe',activeRole:'Admin',exp:Date.now()+3600000});

await pool.query(`insert into country_directors(id,name,region) values('cd-ready','Readiness Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,status,effective_from) values($1,'ORG-READY','Readiness Org','Active',current_date-30) on conflict(id) do update set status='Active'`,[ORG]);
await pool.query(`insert into legal_entities(id,organization_id,code,name,status,effective_from) values($1,$2,'LEGAL-READY','Readiness Legal','Active',current_date-30),($3,$2,'LEGAL-OTHER','Readiness Other Legal','Active',current_date-30) on conflict(id) do update set status='Active'`,[LEGAL,ORG,OTHER]);
const readinessAddress=JSON.stringify({line1:'1 Readiness Street',city:'Readiness City',countryCode:'US'});
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from,effective_to) values
  ($1,$2,'Readiness Legal LLC','US','Active','USD',$4::jsonb,current_date-30,'2098-12-31'),
  ($3,$2,'Readiness Other Legal LLC','US','Active','USD',$4::jsonb,current_date-30,'2098-12-31'),
  ($1,$2,'Scheduled Readiness Legal LLC','CA','Inactive','CAD',$4::jsonb,'2099-01-01','2099-12-31'),
  ($3,$2,'Scheduled Other Legal LLC','CA','Inactive','CAD',$4::jsonb,'2099-01-01','2099-12-31')
  on conflict(legal_entity_id,effective_from) do update set legal_name=excluded.legal_name,country_code=excluded.country_code,status=excluded.status,reporting_currency=excluded.reporting_currency,address=excluded.address,effective_to=excluded.effective_to`,[LEGAL,ORG,OTHER,readinessAddress]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'ADMIN-READY','Readiness Admin','readiness-admin@example.test','Administrator','Administration','Synthetic','cd-ready','Active',$2,$3) on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`,[EMP,ORG,LEGAL]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'ADMIN-READY-OTHER','Readiness Other Admin','readiness-other@example.test','Administrator','Administration','Synthetic','cd-ready','Active',$2,$3) on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`,[OTHER_EMP,ORG,OTHER]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'readiness-admin','ADMIN-READY',$2,'readiness-admin@example.test','Active') on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`,[USER,EMP]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'readiness-other','ADMIN-READY-OTHER',$2,'readiness-other@example.test','Active') on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`,[OTHER_USER,OTHER_EMP]);
await pool.query(`insert into users(id,username,email,status) values($1,'readiness-scope-probe','readiness-scope-probe@example.test','Active') on conflict(id) do update set employee_record_id=null,status='Active'`,[PROBE_USER]);
const adminRole=(await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0]; assert.ok(adminRole);
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[USER,adminRole.id]);
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[OTHER_USER,adminRole.id]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[USER,ORG,LEGAL]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[OTHER_USER,ORG,OTHER]);
await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[PROBE_USER,ORG,LEGAL]);
await pool.query(`insert into identity_provider_links(employee_id,provider,provider_subject,status) values($1,'entra','subject-ready','Linked') on conflict(employee_id,provider) do update set status='Linked'`,[EMP]);
await pool.query(`insert into identity_provider_links(employee_id,provider,provider_subject,status) values($1,'entra','subject-ready-other','Linked') on conflict(employee_id,provider) do update set status='Linked'`,[OTHER_EMP]);
await pool.query(`insert into organization_catalog_items(id,organization_id,legal_entity_id,catalog_type,code,name,active,effective_from) values('worker-type-ready',$1,$2,'worker_type','EMP','Employee',true,current_date-30),('worker-type-other',$1,$3,'worker_type','OTHER','Other',true,current_date-30) on conflict(id) do update set active=true`,[ORG,LEGAL,OTHER]);
await pool.query(`insert into working_calendars(id,organization_id,legal_entity_id,applicability_type,code,name,effective_from,active) values('calendar-ready',$1,$2,'legal_entity','CAL-READY','Readiness Calendar',current_date-30,true),('calendar-other',$1,$3,'legal_entity','CAL-OTHER','Other Calendar',current_date-30,true) on conflict(id) do update set active=true`,[ORG,LEGAL,OTHER]);
await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,frequency,starts_on,ends_on,status) values
  ('period-ready',$1,$2,'RP-READY-WEEKLY','Readiness Weekly Period','Weekly',current_date-7,current_date+7,'Open'),
  ('period-ready-monthly',$1,$2,'RP-READY-MONTHLY','Readiness Monthly Period','Monthly',current_date-15,current_date+15,'Open'),
  ('period-ready-fiscal',$1,$2,'RP-READY-FISCAL','Readiness Fiscal Period','Fiscal',current_date-30,current_date+30,'Open'),
  ('period-other',$1,$3,'RP-OTHER-WEEKLY','Other Weekly Period','Weekly',current_date-7,current_date+7,'Open'),
  ('period-other-monthly',$1,$3,'RP-OTHER-MONTHLY','Other Monthly Period','Monthly',current_date-15,current_date+15,'Open'),
  ('period-other-fiscal',$1,$3,'RP-OTHER-FISCAL','Other Fiscal Period','Fiscal',current_date-30,current_date+30,'Open')
  on conflict(id) do update set organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id,code=excluded.code,name=excluded.name,frequency=excluded.frequency,starts_on=excluded.starts_on,ends_on=excluded.ends_on,status='Open'`,[ORG,LEGAL,OTHER]);
const foreignImportId=(await pool.query(`insert into audit_logs(user_id,user_name,user_role,active_role,source,module,action,entity_type,entity_id,new_value,details) values($1,'Readiness Other Admin','Admin','Admin','Acceptance','Import','Apply','Import','readiness-import-other',$2::jsonb,'Synthetic cross-legal readiness import') returning id`,[OTHER_USER,JSON.stringify({organization_id:ORG,legal_entity_id:OTHER})])).rows[0].id;
for(const [key,value] of [['currency','USD'],['expectedWeeklyHours',40],['timesheetPolicyMaxHours',24]]) await pool.query(`insert into system_settings(key,value) values($1,$2::jsonb) on conflict(key) do update set value=excluded.value`,[key,JSON.stringify(value)]);
await pool.query(`insert into notification_preferences(employee_id,event_type,in_app) values($1,'ApprovalRequested',true) on conflict(employee_id,event_type) do update set in_app=true`,[EMP]);
await pool.query(`insert into notification_preferences(employee_id,event_type,in_app) values($1,'ApprovalRequested',true) on conflict(employee_id,event_type) do update set in_app=true`,[OTHER_EMP]);

const helper=await import(pathToFileURL(path.join(targetRoot,'server/setup-readiness.mjs')).href);
const allFacts=Object.fromEntries(helper.REQUIRED_SETUP_CHECKS.filter(k=>k!=='production_readiness').map(k=>[k,true]));

const port=4331, origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server/index.mjs'],{cwd:targetRoot,env:{...process.env,...safeEnv,API_PORT:String(port),PORT:String(port)},stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',c=>{log+=c;process.stdout.write(c)}); child.stderr.on('data',c=>{log+=c;process.stderr.write(c)});
for(let i=0;i<120;i++){try{const r=await fetch(`${origin}/api/health`);if(r.status<500)break;}catch{} if(i===119)throw new Error(`server not ready ${log}`); await new Promise(r=>setTimeout(r,250));}
const headers={authorization:`Bearer ${token}`,'x-organization-id':ORG,'x-legal-entity-id':LEGAL};
const probeHeaders={...headers,authorization:`Bearer ${probeToken}`};
const rawReadiness=async(q='',requestHeaders=headers)=>{const r=await fetch(`${origin}/api/organization-setup/readiness${q}`,{headers:requestHeaders});let body;try{body=await r.json();}catch{body=await r.text();}return {status:r.status,body};};
const readiness=async(q='',requestHeaders=headers)=>{const result=await rawReadiness(q,requestHeaders);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
const probeReadiness=async(q='')=>readiness(q,probeHeaders);
const keys=['organization','legal_entity','calendars','roles','identity','initial_users','imports','commercial_defaults','notifications','production_readiness','worker_type','reporting_period'].sort();
let importId=null;
try{
  await check('cross-legal import evidence cannot satisfy selected scope before selected import exists',async()=>{const s=await readiness();assert.equal(s.checks.imports,false,JSON.stringify(s));assert.equal(s.ready,false);});
  await check('append-only selected import evidence advances only authoritative import readiness',async()=>{const inserted=await pool.query(`insert into audit_logs(user_id,user_name,user_role,active_role,source,module,action,entity_type,entity_id,new_value,details) values($1,'Readiness Admin','Admin','Admin','Acceptance','Import','Apply','Import','readiness-import',$2::jsonb,'Synthetic readiness import') returning id`,[USER,JSON.stringify({organization_id:ORG,legal_entity_id:LEGAL})]);importId=inserted.rows[0].id;const s=await readiness();assert.equal(s.checks.imports,true,JSON.stringify(s));});
  await check('fully configured scope is ready and deterministic',async()=>{const a=await readiness();assert.deepEqual(Object.keys(a.checks).sort(),keys);assert.ok(keys.every(k=>a.checks[k]===true),JSON.stringify(a));assert.equal(a.ready,true);assert.equal(a.authority,'persisted-server-state');assert.equal(a.organizationId,ORG);assert.equal(a.legalEntityId,LEGAL);assert.deepEqual(await readiness(),a);});
  await check('scheduled future inactive legal profile cannot alter current readiness or scope',async()=>{const s=await readiness();assert.equal(s.checks.legal_entity,true,JSON.stringify(s));assert.equal(s.ready,true,JSON.stringify(s));assert.equal((await pool.query(`select active from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3`,[USER,ORG,LEGAL])).rows[0].active,true);assert.equal((await pool.query(`select status from legal_entity_profile_versions where legal_entity_id=$1 and current_date between effective_from and coalesce(effective_to,'infinity'::date)`,[LEGAL])).rows[0].status,'Active');});
  await check('caller spoofing cannot alter readiness',async()=>assert.deepEqual(await readiness('?ready=false&complete=false&completed=false&checks%5Borganization%5D=false'),await readiness()));

  await check('organization false is represented by readiness helper and inactive selected authority is rejected fail-closed',async()=>{const calc=helper.buildSetupReadiness({...allFacts,organization:false},safeEnv);assert.equal(calc.checks.organization,false);assert.equal(calc.ready,false);await pool.query(`update organizations set status='Inactive' where id=$1`,[ORG]);try{const result=await rawReadiness();assert.equal(result.status,403,JSON.stringify(result.body));}finally{await pool.query(`update organizations set status='Active' where id=$1`,[ORG]);}});
  await check('legal entity false is represented by readiness helper and inactive selected authority is rejected fail-closed',async()=>{const calc=helper.buildSetupReadiness({...allFacts,legal_entity:false},safeEnv);assert.equal(calc.checks.legal_entity,false);assert.equal(calc.ready,false);await pool.query(`update legal_entity_profile_versions set status='Inactive' where legal_entity_id=$1 and current_date between effective_from and coalesce(effective_to,'infinity'::date)`,[LEGAL]);try{const result=await rawReadiness();assert.equal(result.status,403,JSON.stringify(result.body));}finally{await pool.query(`update legal_entity_profile_versions set status='Active' where legal_entity_id=$1 and current_date between effective_from and coalesce(effective_to,'infinity'::date)`,[LEGAL]);}});

  const vectors=[
    ['calendars',()=>pool.query(`update working_calendars set active=false where id='calendar-ready'`),()=>pool.query(`update working_calendars set active=true where id='calendar-ready'`)],
    ['roles',()=>pool.query(`delete from user_roles where user_id=$1`,[USER]),()=>pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[USER,adminRole.id])],
    ['identity',()=>pool.query(`update identity_provider_links set status='Disabled' where employee_id=$1`,[EMP]),()=>pool.query(`update identity_provider_links set status='Linked' where employee_id=$1`,[EMP])],
    ['initial_users',()=>pool.query(`update users set status='Disabled' where id=$1`,[USER]),()=>pool.query(`update users set status='Active' where id=$1`,[USER])],
    ['commercial_defaults',()=>pool.query(`delete from system_settings where key='currency'`),()=>pool.query(`insert into system_settings(key,value) values('currency','\"USD\"'::jsonb) on conflict(key) do update set value=excluded.value`)],
    ['notifications',()=>pool.query(`delete from notification_preferences where employee_id=$1`,[EMP]),()=>pool.query(`insert into notification_preferences(employee_id,event_type,in_app) values($1,'ApprovalRequested',true) on conflict(employee_id,event_type) do update set in_app=true`,[EMP])],
    ['worker_type',()=>pool.query(`update organization_catalog_items set active=false where id='worker-type-ready'`),()=>pool.query(`update organization_catalog_items set active=true where id='worker-type-ready'`)],
    ['reporting_period',()=>pool.query(`update reporting_periods set status='Planned' where id='period-ready'`),()=>pool.query(`update reporting_periods set status='Open' where id='period-ready'`)],
  ];
  for(const [key,off,on] of vectors) await check(`${key} prerequisite fails closed and restores`,async()=>{await off();try{if(key==='initial_users'){const denied=await rawReadiness();assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(denied.body.code,'ORG_SCOPE_DENIED');}const read=key==='initial_users'?probeReadiness:readiness;const s=await read();assert.equal(s.checks[key],false,JSON.stringify(s));assert.equal(s.ready,false);}finally{await on();}assert.equal((await readiness()).checks[key],true);});

  await check('cross-legal roles users identity and notifications cannot satisfy selected scope',async()=>{await pool.query(`delete from user_roles where user_id=$1`,[USER]);await pool.query(`update users set status='Disabled' where id=$1`,[USER]);await pool.query(`delete from notification_preferences where employee_id=$1`,[EMP]);try{const denied=await rawReadiness();assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(denied.body.code,'ORG_SCOPE_DENIED');const s=await probeReadiness();assert.equal(s.checks.roles,false,JSON.stringify(s));assert.equal(s.checks.initial_users,false,JSON.stringify(s));assert.equal(s.checks.identity,false,JSON.stringify(s));assert.equal(s.checks.notifications,false,JSON.stringify(s));}finally{await pool.query(`update users set status='Active' where id=$1`,[USER]);await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[USER,adminRole.id]);await pool.query(`insert into notification_preferences(employee_id,event_type,in_app) values($1,'ApprovalRequested',true) on conflict(employee_id,event_type) do update set in_app=true`,[EMP]);}});
  await check('same-org cross-legal calendar worker-type and period cannot satisfy selected scope',async()=>{await pool.query(`update working_calendars set active=false where id='calendar-ready'; update organization_catalog_items set active=false where id='worker-type-ready'; update reporting_periods set status='Planned' where id='period-ready'`);try{const s=await readiness();assert.equal(s.checks.calendars,false);assert.equal(s.checks.worker_type,false);assert.equal(s.checks.reporting_period,false);}finally{await pool.query(`update working_calendars set active=true where id='calendar-ready'; update organization_catalog_items set active=true where id='worker-type-ready'; update reporting_periods set status='Open' where id='period-ready'`);}});

  await check('production environment helper fails closed for every unsafe vector',async()=>{assert.equal(helper.productionReadinessFromEnvironment(safeEnv),true);assert.equal(helper.identityReadinessFromEnvironment(safeEnv),true);for(const patch of [{NODE_ENV:'test'},{APP_MODE:'test'},{ALLOW_TEST_FALLBACK:'true'},{AUTO_SEED_DEMO:'true'},{LOCAL_LOGIN_ENABLED:'true'},{APP_URL:'http://unsafe.example.test'},{API_SESSION_SECRET:'dev-only-change-me'},{IDENTITY_PROVIDER:'local'},{ENTRA_TENANT_ID:''},{ENTRA_CLIENT_ID:''},{ENTRA_CLIENT_SECRET:''},{ENTRA_REDIRECT_URI:''}])assert.equal(helper.productionReadinessFromEnvironment({...safeEnv,...patch}),false,JSON.stringify(patch));});
  await check('final restored authority is fully ready and bounded',async()=>{const s=await readiness();assert.equal(s.ready,true,JSON.stringify(s));assert.deepEqual(Object.keys(s.evidence).sort(),keys);assert.ok(JSON.stringify(s).length<10000);});
}finally{child.kill('SIGTERM');await pool.query(`select $1::uuid,$2::uuid`,[importId,foreignImportId]).catch(()=>{});await pool.end();}
if(failures.length){console.error(JSON.stringify(failures,null,2));process.exit(1);}
