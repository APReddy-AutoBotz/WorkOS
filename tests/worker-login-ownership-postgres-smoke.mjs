import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialIdentities,seedCommercialReferences,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);const identities=await seedCommercialIdentities(pool);
 for(const key of ['employees.manage','imports.manage'])await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Employee',$1,true)on conflict(role_name,permission_key)do update set enabled=true",[key]);
 const snapshot=async id=>({user:(await pool.query('select * from users where id=$1',[id])).rows,roles:(await pool.query('select * from user_roles where user_id=$1',[id])).rows,scopes:(await pool.query('select * from user_organization_scopes where user_id=$1 order by organization_id,legal_entity_id',[id])).rows,grants:(await pool.query('select * from user_permission_grants where user_id=$1',[id])).rows});
 const victims=[];
 for(const [code,worker,org,legal] of [['SAM',f.foreignOwnerId,f.otherOrganizationId,f.foreignLegalEntityId],['SAMIMP',f.otherOwnerId,f.organizationId,f.otherLegalEntityId]]){
  await pool.query("insert into users(username,email,status)values($1,$2,'Active')",[code.toUpperCase(),'occupied-'+code.toLowerCase()+'@example.test']);
  const id=randomUUID(),fallback=code.toLowerCase()+'-'+f.organizationId+'-'+f.legalEntityId;
  await pool.query("insert into users(id,username,email,employee_record_id,employee_id,password_hash,status)values($1,$2,$3,$4,$5,'synthetic-victim-hash','Active')",[id,fallback,'victim-'+code.toLowerCase()+'@example.test',worker,'VICTIM-'+code]);
  await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='Employee'",[id]);
  await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[id,org,legal]);
  await pool.query("insert into user_permission_grants(user_id,permission_key)values($1,'reports.export')",[id]);
  victims.push({id,code,before:await snapshot(id)});
 }
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  for(const [i,victim] of victims.entries()){
   const body={employee_id:victim.code,name:'Synthetic provisioned worker',email:'new-'+victim.code.toLowerCase()+'@example.test',designation:'Analyst',department:'Delivery',country:'US',primary_country_director_id:'director-commercial',initial_password:'Synthetic!Independent98'};
   const result=i===0?await request('/api/employees',{method:'POST',identity:identities.reader,body}):await request('/api/imports/employees/apply',{method:'POST',identity:identities.reader,body:{fileName:'synthetic.csv',rows:[{employeeId:body.employee_id,name:body.name,email:body.email,primaryCountryDirectorId:body.primary_country_director_id,initialPassword:body.initial_password}]}});
   assert.equal(result.status,200,JSON.stringify(result.body));
   assert.deepEqual(await snapshot(victim.id),victim.before,'Provisioning must not overwrite the occupied fallback account or its authority');
   const created=(await pool.query('select u.* from users u join employees e on e.id=u.employee_record_id where e.employee_id=$1 and e.organization_id=$2 and e.legal_entity_id=$3',[victim.code,f.organizationId,f.legalEntityId])).rows[0];
   assert.ok(created);assert.notEqual(created.id,victim.id);assert.notEqual(created.username,victim.before.user[0].username);
   assert.equal((await pool.query('select count(*)::int n from user_organization_scopes where user_id=$1',[created.id])).rows[0].n,1);
   if(i===0){const {initial_password:unused,...edit}=body;const updated=await request('/api/employees',{method:'POST',identity:identities.reader,body:{...edit,name:'Synthetic edited worker'}});assert.equal(updated.status,200,JSON.stringify(updated.body));const after=(await pool.query('select * from users where id=$1',[created.id])).rows[0];assert.equal(after.username,created.username);assert.equal(after.employee_record_id,created.employee_record_id);assert.equal(after.password_hash,created.password_hash);}
  }
  const collisionBody={employee_id:'SYNTHETIC-RACE',name:'Synthetic concurrent worker',designation:'Analyst',department:'Delivery',country:'US',primary_country_director_id:'director-commercial',initial_password:'Synthetic!Independent98'};
  await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[identities.reader.id,f.otherOrganizationId,f.foreignLegalEntityId]);
  const concurrent=await Promise.all([
   request('/api/employees',{method:'POST',identity:identities.reader,body:{...collisionBody,email:'concurrent-a@example.test'}}),
   request('/api/employees',{method:'POST',identity:identities.reader,scope:{organizationId:f.otherOrganizationId,legalEntityId:f.foreignLegalEntityId},body:{...collisionBody,email:'concurrent-b@example.test'}}),
  ]);
  for(const r of concurrent)assert.equal(r.status,200,JSON.stringify(r.body));
  const accounts=(await pool.query("select id,username,employee_record_id from users where employee_id='SYNTHETIC-RACE'")).rows;
  assert.equal(accounts.length,2);assert.equal(new Set(accounts.map(x=>x.username)).size,2);assert.equal(new Set(accounts.map(x=>x.employee_record_id)).size,2);
  const duplicateEmail=await request('/api/employees',{method:'POST',identity:identities.reader,body:{...collisionBody,employee_id:'SYNTHETIC-EMAIL-CONFLICT',email:'occupied-sam@example.test'}});
  assert.equal(duplicateEmail.status,409,JSON.stringify(duplicateEmail.body));
  assert.equal(duplicateEmail.body.code,'WORKER_LOGIN_CONFLICT');
  assert.equal((await pool.query("select 1 from employees where employee_id='SYNTHETIC-EMAIL-CONFLICT'")).rowCount,0,'Conflicting creation rolls back workforce writes');
 });
});
console.log('Worker login ownership: profile/import occupied fallback isolation and existing linked account preservation passed.');
