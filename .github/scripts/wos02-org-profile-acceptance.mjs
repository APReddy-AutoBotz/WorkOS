// Controller-only exact-head acceptance for WOS-ORG-001/002.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root=process.env.TARGET_ROOT, db=process.env.DATABASE_URL;
if(!root||!db) throw new Error('TARGET_ROOT and DATABASE_URL are required');
const {Pool}=createRequire(path.join(root,'package.json'))('pg');
const pool=new Pool({connectionString:db});
const failures=[];
const check=async(name,fn)=>{try{await fn();console.log(`PASS ${name}`)}catch(error){failures.push({name,error:error?.stack||String(error)});console.error(`FAIL ${name}: ${error?.stack||error}`)}};
const iso=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);

const ORG='org-profile', LEGAL='legal-profile', FUTURE_LEGAL='legal-profile-future', OTHER_ORG='org-profile-other', OTHER_LEGAL='legal-profile-other';
const USER='00000000-0000-0000-0000-000000001081', EMP='admin-profile', SECRET='org-profile-acceptance-session-secret';
const sign=payload=>{const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return `${body}.${crypto.createHmac('sha256',SECRET).update(body).digest('base64url')}`};
const token=sign({sub:USER,username:'profile-admin',activeRole:'Admin',employeeRecordId:EMP,employeeId:'ADMIN-PROFILE',exp:Date.now()+3600000});
const headers={authorization:`Bearer ${token}`,'content-type':'application/json','x-organization-id':ORG,'x-legal-entity-id':LEGAL};
const futureHeaders={...headers,'x-legal-entity-id':FUTURE_LEGAL};

await pool.query(`insert into country_directors(id,name,region) values('cd-profile','Profile Director','Synthetic') on conflict(id) do nothing`);
await pool.query(`insert into organizations(id,code,name,status,effective_from) values($1,'ORG-PROFILE','Profile Org','Active','2026-01-01'),($2,'ORG-OTHER','Other Org','Active','2026-01-01') on conflict(id) do update set status='Active'`,[ORG,OTHER_ORG]);
await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values($1,$2,'LEGAL-PROFILE','Profile Legal','US','Active','2026-01-01'),($3,$2,'LEGAL-FUTURE','Future Authority Legal','US','Active','2026-01-01'),($4,$5,'LEGAL-OTHER','Other Legal','US','Active','2026-01-01') on conflict(id) do update set status='Active'`,[LEGAL,ORG,FUTURE_LEGAL,OTHER_LEGAL,OTHER_ORG]);
await pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from) values($1,'Profile Org','Profile Org LLC','ProfileOS','support@profile.example.test','en-US','UTC','USD','01-01',1,'2026-01-01') on conflict(organization_id,effective_from) do nothing`,[ORG]);
await pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from) values($1,'Other Org','Other Org LLC','OtherOS','support@other.example.test','en-US','UTC','USD','01-01',1,'2026-01-01') on conflict(organization_id,effective_from) do nothing`,[OTHER_ORG]);
const address=JSON.stringify({line1:'1 Profile Street',city:'Profile City',countryCode:'US'});
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,registration_identifier,tax_identifier,reporting_currency,address,effective_from) values($1,$2,'Profile Legal','US','Active','REG-PROFILE','TAX-PROFILE','USD',$3::jsonb,'2026-01-01') on conflict(legal_entity_id,effective_from) do nothing`,[LEGAL,ORG,address]);
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,registration_identifier,tax_identifier,reporting_currency,address,effective_from) values($1,$2,'Future Authority Legal','US','Active','REG-FUTURE','TAX-FUTURE','USD',$3::jsonb,'2026-01-01') on conflict(legal_entity_id,effective_from) do nothing`,[FUTURE_LEGAL,ORG,address]);
await pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,registration_identifier,tax_identifier,reporting_currency,address,effective_from) values($1,$2,'Other Legal','US','Active','REG-OTHER','TAX-OTHER','USD',$3::jsonb,'2026-01-01') on conflict(legal_entity_id,effective_from) do nothing`,[OTHER_LEGAL,OTHER_ORG,address]);
await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values($1,'ADMIN-PROFILE','Profile Admin','profile-admin@example.test','Administrator','Administration','Synthetic','cd-profile','Active',$2,$3) on conflict(id) do update set status='Active',organization_id=excluded.organization_id,legal_entity_id=excluded.legal_entity_id`,[EMP,ORG,LEGAL]);
await pool.query(`insert into users(id,username,employee_id,employee_record_id,email,status) values($1,'profile-admin','ADMIN-PROFILE',$2,'profile-admin@example.test','Active') on conflict(id) do update set employee_record_id=excluded.employee_record_id,status='Active'`,[USER,EMP]);
const admin=(await pool.query(`select id from roles where name='Admin' limit 1`)).rows[0]; assert.ok(admin);
await pool.query(`insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing`,[USER,admin.id]);
for(const legalEntityId of [LEGAL,FUTURE_LEGAL]) await pool.query(`insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict(user_id,organization_id,legal_entity_id) do update set active=true`,[USER,ORG,legalEntityId]);

const port=4332, origin=`http://127.0.0.1:${port}`;
const request=async(method,url,body,h=headers)=>{const response=await fetch(origin+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});let payload;try{payload=await response.json()}catch{payload=await response.text()}return{status:response.status,body:payload}};
const expect=(r,s)=>assert.equal(r.status,s,JSON.stringify(r.body));
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,DATABASE_URL:db,API_SESSION_SECRET:SECRET,APP_MODE:'test',ALLOW_TEST_FALLBACK:'true',API_PORT:String(port),PORT:String(port)},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',x=>{log+=x;process.stdout.write(x)});child.stderr.on('data',x=>{log+=x;process.stderr.write(x)});
for(let i=0;i<120;i++){try{const r=await fetch(origin+'/api/health');if(r.status<500)break}catch{}if(i===119)throw new Error('server not ready '+log);await new Promise(r=>setTimeout(r,250))}

const profile={name:'Profile Org Updated',legalName:'Profile Org Incorporated',productDisplayName:'Profile WorkOS',supportContact:'https://support.profile.example.test',defaultLocale:'en-IN',defaultTimeZone:'Asia/Kolkata',baseCurrency:'INR',fiscalYearStart:'04-01',defaultWeekStart:1,effectiveFrom:'2026-09-01'};
let created;
try{
 await check('migration 028 authority/backfill/non-overlap/scoped identities',async()=>{
  assert.equal(Number((await pool.query(`select count(*) n from schema_migrations where id='028_wos02_organization_legal_entity_profiles'`)).rows[0].n),1);
  assert.equal(Number((await pool.query(`select count(*) n from pg_constraint where conname in ('organization_profile_versions_no_overlap','legal_entity_profile_versions_no_overlap')`)).rows[0].n),2);
  assert.equal(Number((await pool.query(`select count(*) n from pg_indexes where indexname in ('uq_legal_entity_registration_identity','uq_legal_entity_tax_identity')`)).rows[0].n),2);
  assert.equal(Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id='org-default'`)).rows[0].n),1);
  assert.equal(Number((await pool.query(`select count(*) n from legal_entity_profile_versions where legal_entity_id='legal-default'`)).rows[0].n),1);
 });
 await check('database profile overlap and composite ownership fail closed',async()=>{
  await assert.rejects(()=>pool.query(`insert into organization_profile_versions(organization_id,name,legal_name,product_display_name,support_contact,default_locale,default_time_zone,base_currency,fiscal_year_start,default_week_start,effective_from,effective_to) values($1,'Overlap','Overlap','Overlap','overlap@example.test','en-US','UTC','USD','01-01',1,'2026-06-01','2026-06-30')`,[ORG]),e=>['23P01','23505'].includes(e.code));
  await pool.query(`insert into legal_entities(id,organization_id,code,name,country_code,status,effective_from) values('legal-owner-check',$1,'LEGAL-OWNER-CHECK','Owner Check','US','Active','2026-01-01')`,[ORG]);
  await assert.rejects(()=>pool.query(`insert into legal_entity_profile_versions(legal_entity_id,organization_id,legal_name,country_code,status,reporting_currency,address,effective_from) values('legal-owner-check',$1,'Wrong Owner','US','Active','USD',$2::jsonb,'2026-01-01')`,[OTHER_ORG,address]),e=>e.code==='23503');
 });
 await check('exact-scope organization profile read/update/history/audit',async()=>{
  let r=await request('GET','/api/organization-setup/profile');expect(r,200);for(const k of ['organization_name','legal_name','product_display_name','support_contact','default_locale','default_time_zone','base_currency','fiscal_year_start','default_week_start'])assert.ok(Object.hasOwn(r.body,k),k);
  r=await request('PUT','/api/organization-setup/profile',profile);expect(r,200);assert.equal(r.body.organization_name,profile.name);assert.equal(r.body.base_currency,'INR');
  const old=await request('GET','/api/organization-setup/profile?asOf=2026-08-31');expect(old,200);assert.equal(old.body.organization_name,'Profile Org');
  const current=await request('GET','/api/organization-setup/profile?asOf=2026-09-02');expect(current,200);assert.equal(current.body.organization_name,profile.name);
  const versions=await pool.query(`select effective_to from organization_profile_versions where organization_id=$1 order by effective_from`,[ORG]);assert.equal(versions.rowCount,2);assert.equal(iso(versions.rows[0].effective_to),'2026-08-31');
  const audit=(await pool.query(`select user_id,old_value,new_value from audit_logs where action='Update Organization Profile' and entity_id=$1 order by created_at desc limit 1`,[ORG])).rows[0];assert.ok(audit);assert.equal(String(audit.user_id),USER);assert.equal(audit.new_value.name,profile.name);
 });
 await check('profile spoof/cross-org/invalid values no-write and audit rollback atomic',async()=>{
  const before=Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`,[ORG])).rows[0].n);
  expect(await request('PUT','/api/organization-setup/profile',{...profile,organizationId:OTHER_ORG,effectiveFrom:'2026-10-01'}),403);
  expect(await request('GET','/api/organization-setup/profile',undefined,{...headers,'x-organization-id':OTHER_ORG,'x-legal-entity-id':OTHER_LEGAL}),403);
  expect(await request('PUT','/api/organization-setup/profile',{...profile,defaultTimeZone:'Not/AZone',effectiveFrom:'2026-10-01'}),400);
  assert.equal(Number((await pool.query(`select count(*) n from organization_profile_versions where organization_id=$1`,[ORG])).rows[0].n),before);
  const beforeName=(await pool.query(`select name from organizations where id=$1`,[ORG])).rows[0].name;
  await pool.query(`create function reject_profile_audit() returns trigger language plpgsql as $$begin if NEW.action='Update Organization Profile' then raise exception 'reject'; end if; return NEW; end$$;create trigger reject_profile_audit before insert on audit_logs for each row execute function reject_profile_audit()`);
  try{expect(await request('PUT','/api/organization-setup/profile',{...profile,name:'Rollback',effectiveFrom:'2026-10-01'}),500);assert.equal((await pool.query(`select name from organizations where id=$1`,[ORG])).rows[0].name,beforeName)}finally{await pool.query(`drop trigger reject_profile_audit on audit_logs;drop function reject_profile_audit()`)}
 });
 await check('legal-entity list/read is scope bounded',async()=>{
  const list=await request('GET','/api/organization-setup/legal-entities');expect(list,200);assert.ok(list.body.some(x=>x.id===LEGAL));assert.ok(!list.body.some(x=>x.id===OTHER_LEGAL));
  expect(await request('GET',`/api/organization-setup/legal-entities/${LEGAL}`),200);expect(await request('GET',`/api/organization-setup/legal-entities/${OTHER_LEGAL}`),404);
 });
 await check('future-effective inactive legal profile preserves current authority and resolves deterministic as-of history',async()=>{
  const future={code:'LEGAL-FUTURE',legalName:'Future Authority Legal CA',registrationIdentifier:'REG-FUTURE',taxIdentifier:'TAX-FUTURE',reportingCurrency:'CAD',address:{line1:'99 Future Street',city:'Future City',countryCode:'CA'},status:'Inactive',effectiveFrom:'2099-01-01',effectiveTo:'2099-12-31'};
  const beforeBase=(await pool.query(`select name,country_code,status,effective_from,effective_to from legal_entities where id=$1 and organization_id=$2`,[FUTURE_LEGAL,ORG])).rows[0];
  const beforeScope=(await pool.query(`select active from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3`,[USER,ORG,FUTURE_LEGAL])).rows[0];
  const scheduled=await request('PUT',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}`,future,futureHeaders);expect(scheduled,200);
  assert.deepEqual((await pool.query(`select name,country_code,status,effective_from,effective_to from legal_entities where id=$1 and organization_id=$2`,[FUTURE_LEGAL,ORG])).rows[0],beforeBase);
  assert.deepEqual((await pool.query(`select active from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3`,[USER,ORG,FUTURE_LEGAL])).rows[0],beforeScope);
  const current=await request('GET',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}?asOf=2026-09-06`,undefined,futureHeaders);expect(current,200);assert.equal(current.body.name,'Future Authority Legal');assert.equal(current.body.country_code,'US');assert.equal(current.body.status,'Active');
  const futureRead=await request('GET',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}?asOf=2099-06-01`,undefined,futureHeaders);expect(futureRead,200);assert.equal(futureRead.body.name,future.legalName);assert.equal(futureRead.body.country_code,'CA');assert.equal(futureRead.body.status,'Inactive');
  const history=await pool.query(`select legal_name,status,effective_from,effective_to from legal_entity_profile_versions where legal_entity_id=$1 order by effective_from`,[FUTURE_LEGAL]);assert.equal(history.rowCount,2);assert.equal(iso(history.rows[0].effective_to),'2098-12-31');assert.equal(iso(history.rows[1].effective_from),'2099-01-01');
  const context=await request('GET','/api/organization-setup/context?asOf=2026-09-06',undefined,futureHeaders);expect(context,200);assert.equal(context.body.legal_entity_name,'Future Authority Legal');
 });
 await check('future legal profile stale writes conflict and same-effective replay is deterministic',async()=>{
  const snapshot=async()=>JSON.stringify((await pool.query(`select legal_name,country_code,status,effective_from,effective_to from legal_entity_profile_versions where legal_entity_id=$1 order by effective_from`,[FUTURE_LEGAL])).rows);
  const before=await snapshot();
  const stale={code:'LEGAL-FUTURE',legalName:'Stale',registrationIdentifier:'REG-FUTURE',taxIdentifier:'TAX-FUTURE',reportingCurrency:'USD',address:{line1:'Stale',city:'Stale',countryCode:'US'},status:'Active',effectiveFrom:'2025-01-01'};
  const conflict=await request('PUT',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}`,stale,futureHeaders);expect(conflict,409);assert.equal(await snapshot(),before);
  const replay={code:'LEGAL-FUTURE',legalName:'Future Authority Legal Revised',registrationIdentifier:'REG-FUTURE',taxIdentifier:'TAX-FUTURE',reportingCurrency:'CAD',address:{line1:'99 Future Street',city:'Future City',countryCode:'CA'},status:'Inactive',effectiveFrom:'2099-01-01',effectiveTo:'2099-12-31'};
  expect(await request('PUT',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}`,replay,futureHeaders),200);
  assert.equal(Number((await pool.query(`select count(*) n from legal_entity_profile_versions where legal_entity_id=$1 and effective_from='2099-01-01'`,[FUTURE_LEGAL])).rows[0].n),1);
  assert.equal((await pool.query(`select legal_name from legal_entity_profile_versions where legal_entity_id=$1 and effective_from='2099-01-01'`,[FUTURE_LEGAL])).rows[0].legal_name,replay.legalName);
  const audit=(await pool.query(`select old_value,new_value,user_id from audit_logs where action='Update Legal Entity' and entity_id=$1 order by created_at desc limit 1`,[FUTURE_LEGAL])).rows[0];assert.equal(String(audit.user_id),USER);assert.ok(audit.old_value);assert.equal(audit.new_value.profile.legal_name,replay.legalName);
  const current={code:'LEGAL-FUTURE',legalName:'Future Authority Legal Current',registrationIdentifier:'REG-FUTURE',taxIdentifier:'TAX-FUTURE',reportingCurrency:'USD',address:{line1:'1 Profile Street',city:'Profile City',countryCode:'US'},status:'Active',effectiveFrom:'2026-01-01'};
  expect(await request('PUT',`/api/organization-setup/legal-entities/${FUTURE_LEGAL}`,current,futureHeaders),200);
  const base=(await pool.query(`select name,country_code,status from legal_entities where id=$1`,[FUTURE_LEGAL])).rows[0];assert.deepEqual(base,{name:current.legalName,country_code:'US',status:'Active'});
  assert.equal(Number((await pool.query(`select count(*) n from legal_entity_profile_versions where legal_entity_id=$1`,[FUTURE_LEGAL])).rows[0].n),2);
 });
 await check('legal-entity create is atomic with creator scope and audit',async()=>{
  const p={code:'LEGAL-NEW',legalName:'New Legal Entity LLC',registrationIdentifier:'REG-NEW',taxIdentifier:'TAX-NEW',reportingCurrency:'EUR',address:{line1:'10 New Street',city:'New City',countryCode:'DE'},status:'Active',effectiveFrom:'2026-09-01'};
  const r=await request('POST','/api/organization-setup/legal-entities',p);expect(r,201);created=r.body.id;assert.ok(created);assert.equal(r.body.organization_id,ORG);
  assert.equal(Number((await pool.query(`select count(*) n from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active`,[USER,ORG,created])).rows[0].n),1);
  assert.ok((await pool.query(`select 1 from audit_logs where action='Create Legal Entity' and entity_id=$1`,[created])).rowCount);
 });
 await check('legal-entity duplicate identity and concurrent code are deterministic conflicts',async()=>{
  const p=s=>({code:`LEGAL-DUP${s}`,legalName:`Dup ${s}`,registrationIdentifier:'REG-DUP',taxIdentifier:`TAX-DUP-${s}`,reportingCurrency:'USD',address:{line1:'Dup',city:'Dup',countryCode:'US'},status:'Active',effectiveFrom:'2026-09-01'});
  expect(await request('POST','/api/organization-setup/legal-entities',p('A')),201);expect(await request('POST','/api/organization-setup/legal-entities',p('B')),409);
  const c={code:'LEGAL-CONCURRENT',legalName:'Concurrent',registrationIdentifier:null,taxIdentifier:null,reportingCurrency:'USD',address:{line1:'Concurrent',city:'Concurrent',countryCode:'US'},status:'Active',effectiveFrom:'2026-09-01'};
  const rs=await Promise.all([request('POST','/api/organization-setup/legal-entities',c),request('POST','/api/organization-setup/legal-entities',c)]);assert.deepEqual(rs.map(x=>x.status).sort(),[201,409]);
 });
 await check('selected legal-entity update versions/audits and cross-scope mutation denies',async()=>{
  const h={...headers,'x-legal-entity-id':created};
  const p={code:'LEGAL-NEW',legalName:'New Legal Entity Updated',registrationIdentifier:'REG-NEW',taxIdentifier:'TAX-NEW',reportingCurrency:'GBP',address:{line1:'20 New Street',city:'New City',countryCode:'GB'},status:'Active',effectiveFrom:'2026-10-01'};
  const r=await request('PUT',`/api/organization-setup/legal-entities/${created}`,p,h);expect(r,200);assert.equal(r.body.reporting_currency,'GBP');
  const history=await pool.query(`select effective_to from legal_entity_profile_versions where legal_entity_id=$1 order by effective_from`,[created]);assert.equal(history.rowCount,2);assert.equal(iso(history.rows[0].effective_to),'2026-09-30');
  assert.ok((await pool.query(`select 1 from audit_logs where action='Update Legal Entity' and entity_id=$1`,[created])).rowCount);
  expect(await request('PUT',`/api/organization-setup/legal-entities/${created}`,p,headers),404);
  expect(await request('PUT',`/api/organization-setup/legal-entities/${OTHER_LEGAL}`,{...p,code:'LEGAL-OTHER',organizationId:OTHER_ORG},{...h,'x-organization-id':OTHER_ORG,'x-legal-entity-id':OTHER_LEGAL}),403);
 });
 await check('unsafe legal-entity retirement with active dependency fails closed',async()=>{
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id) values('profile-dependent','PROFILE-DEP','Profile Dependent','profile-dependent@example.test','Engineer','Delivery','Synthetic','cd-profile','Active',$1,$2)`,[ORG,created]);
  const p={code:'LEGAL-NEW',legalName:'New Legal Entity Updated',registrationIdentifier:'REG-NEW',taxIdentifier:'TAX-NEW',reportingCurrency:'GBP',address:{line1:'20 New Street',city:'New City',countryCode:'GB'},status:'Inactive',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-01'};
  expect(await request('PUT',`/api/organization-setup/legal-entities/${created}`,p,{...headers,'x-legal-entity-id':created}),409);
  assert.equal((await pool.query(`select status from legal_entities where id=$1`,[created])).rows[0].status,'Active');
 });
 await check('context is backward compatible and resolves historical/current profile facts',async()=>{
  const current=await request('GET','/api/organization-setup/context?asOf=2026-09-02');expect(current,200);assert.equal(current.body.organization_name,profile.name);assert.equal(current.body.organization_legal_name,profile.legalName);assert.equal(current.body.legal_entity_id,LEGAL);assert.ok(current.body.legal_entity_legal_name);
  const historical=await request('GET','/api/organization-setup/context?asOf=2026-08-31');expect(historical,200);assert.equal(historical.body.organization_name,'Profile Org');assert.equal(historical.body.organization_legal_name,'Profile Org LLC');
 });
}finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));await pool.end()}
if(failures.length){console.error(JSON.stringify(failures,null,2));process.exitCode=1}else console.log('WOS-02 organization profile/legal-entity acceptance complete');
