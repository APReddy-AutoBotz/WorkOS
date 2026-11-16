import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
const initialPassword = randomBytes(24).toString('base64url').concat('Aa!9');
const replacementPassword = randomBytes(24).toString('base64url').concat('Aa!9');
import {withCommercialDatabase, migrateCommercialDatabase, seedCommercialIdentities, seedCommercialReferences, withCommercialApi} from './support/commercial-drafting-test.mjs';

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  await seedCommercialReferences(pool);
  const identities = await seedCommercialIdentities(pool);
  for (const key of ['employees.manage','employees.view','employees.password_reset','integrations.identity','imports.manage']) {
    await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values ('Employee',$1,true),('Admin',$1,true)
      on conflict(role_name,permission_key) do update set enabled=true`, [key]);
  }
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled) values ('Admin','permissions.manage',true)
    on conflict(role_name,permission_key) do update set enabled=true`);
  await withCommercialApi({databaseUrl, identities}, async ({request}) => {
    const base = {employee_id:'ADMIN-SYNTHETIC', name:'Synthetic worker', email:'worker@example.test', designation:'Analyst', department:'Delivery',
      country:'US', primary_country_director_id:'director-commercial', initial_password:initialPassword};
    const save = (body, identity=identities.reader) => request('/api/employees', {method:'POST', identity, body});
    const roles = async id => (await pool.query(`select r.name from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where u.employee_record_id=$1 order by r.name`,[id])).rows.map(r=>r.name);
    const created = await save(base);
    assert.equal(created.status,200,JSON.stringify(created.body));
    const employeeId=created.body.id;
    assert.deepEqual(await roles(employeeId),['Employee'],'Employee codes never grant security roles');
    const {initial_password: _password,...profile}=base;
    const target=(await pool.query('select id,password_hash from users where employee_record_id=$1',[employeeId])).rows[0];
    const ordinary = await save({...base,employee_id:'SYNTHETIC-RESET',email:'reset@example.test'});
    assert.equal(ordinary.status,200);
    const ordinaryUser=(await pool.query('select id from users where employee_record_id=$1',[ordinary.body.id])).rows[0];
    await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[ordinaryUser.id]);
    await pool.query("insert into organization_audit_grants(organization_id,user_id,granted_by_active_role) values ('org-default',$1,'Admin')",[ordinaryUser.id]);
    for (const [index,path] of ['/api/employees','/api/imports/employees/apply','/api/v1/imports/employees/apply'].entries()) {
      const code=`SYNTHETIC-COLLISION-${index}`,username=code.toLowerCase();
      await pool.query('update users set username=$1 where id=$2',[`${username}-org-default-legal-default`,ordinaryUser.id]);
      await pool.query("insert into users(username,email,password_hash,status) values ($1,$2,'synthetic-unusable-hash','Active')",[username,`reserved-${index}@example.test`]);
      const before=(await pool.query('select id,username,employee_record_id,password_hash from users where id=$1',[ordinaryUser.id])).rows[0];
      const body=path==='/api/employees'?{...base,employee_id:code,email:`collision-${index}@example.test`}
        :{fileName:'synthetic.csv',...(path.includes('/v1/')?{schemaVersion:'employee-master/1',dryRun:false}:{}),
          rows:[{employeeId:code,name:'Synthetic collision',email:`collision-${index}@example.test`,primaryCountryDirectorId:'director-commercial',initialPassword:initialPassword}]};
      const collision=await request(path,{method:'POST',identity:identities.reader,headers:{'Idempotency-Key':randomUUID()},body});
      assert.equal(collision.status,409,'A new worker must not overwrite an existing fallback username');
      assert.deepEqual((await pool.query('select id,username,employee_record_id,password_hash from users where id=$1',[ordinaryUser.id])).rows[0],before);
      assert.deepEqual(await roles(ordinary.body.id),['Admin','Employee']);
      assert.equal((await pool.query('select 1 from organization_audit_grants where user_id=$1',[ordinaryUser.id])).rowCount,1);
      assert.equal((await pool.query("select 1 from user_organization_scopes where user_id=$1 and organization_id='org-default' and legal_entity_id='legal-default' and active",[ordinaryUser.id])).rowCount,1);
      assert.equal((await pool.query('select 1 from employees where employee_id=$1',[code])).rowCount,0);
    }
    await pool.query("delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Admin')",[ordinaryUser.id]);
    await pool.query('delete from organization_audit_grants where user_id=$1',[ordinaryUser.id]);
    const resetOrdinary=()=>request(`/api/users/${ordinaryUser.id}/password-reset`,{method:'POST',identity:identities.reader,body:{newPassword:replacementPassword}});
    assert.equal((await resetOrdinary()).status,200,'Ordinary unbound Employee reset remains available');
    const resetHash=async()=>(await pool.query('select password_hash from users where id=$1',[ordinaryUser.id])).rows[0].password_hash;
    const protectedHash=await resetHash();
    await pool.query("insert into organization_audit_grants(organization_id,user_id,granted_by_active_role) values ('org-default',$1,'Admin')",[ordinaryUser.id]);
    assert.equal((await resetOrdinary()).status,403,'Organization audit grants protect an Employee-only account');
    assert.equal(await resetHash(),protectedHash);
    await pool.query('delete from organization_audit_grants where user_id=$1',[ordinaryUser.id]);
    for (const status of ['Linked','Disabled','Pending']) {
      await pool.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,status)
        values ('synthetic-reset-binding',$1,'entra','synthetic-reset-subject',$2)
        on conflict(employee_id,provider) do update set status=excluded.status`,[ordinary.body.id,status]);
      assert.equal((await resetOrdinary()).status,403,'Entra-bound accounts require security administration regardless of link state');
      assert.equal(await resetHash(),protectedHash);
    }
    await pool.query('delete from identity_provider_links where employee_id=$1',[ordinary.body.id]);
    for (const table of ['users','employees']) {
      const id=table==='users'?ordinaryUser.id:ordinary.body.id;
      await pool.query(`update ${table} set entra_object_id='synthetic-legacy-reset-subject' where id=$1`,[id]);
      assert.equal((await resetOrdinary()).status,403,'Legacy Entra bindings also protect credentials');
      assert.equal(await resetHash(),protectedHash);
      await pool.query(`update ${table} set entra_object_id=null where id=$1`,[id]);
    }
    await pool.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,status)
      values ('synthetic-reset-authorized',$1,'entra','synthetic-authorized-reset-subject','Linked')`,[ordinary.body.id]);
    assert.equal((await request(`/api/users/${ordinaryUser.id}/password-reset`,{method:'POST',identity:identities.manager,body:{newPassword:replacementPassword}})).status,200,
      'Security administrator can reset a protected target');
    await pool.query('delete from identity_provider_links where employee_id=$1',[ordinary.body.id]);
    let result=await save({...profile,roles:['Admin']});
    assert.equal(result.status,403,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Employee']);
    result=await save({...profile,roles:['Admin']},identities.manager);
    assert.equal(result.status,200,JSON.stringify(result.body));
    result=await save({...profile,name:'Synthetic updated worker'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin'],'Omitted roles preserve existing assignment');
    result=await save({...profile,initial_password:replacementPassword});
    assert.equal(result.status,422,JSON.stringify(result.body));
    assert.equal((await pool.query('select password_hash from users where id=$1',[target.id])).rows[0].password_hash,target.password_hash);
    result=await request(`/api/users/${target.id}/password-reset`,{method:'POST',identity:identities.reader,body:{newPassword:replacementPassword}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    result=await save({...profile,entra_object_id:'synthetic-attacker-subject'});
    assert.equal(result.status,403,JSON.stringify(result.body));
    assert.equal((await pool.query('select entra_object_id from employees where id=$1',[employeeId])).rows[0].entra_object_id,null);
    result=await request('/api/integrations/identity-links',{method:'POST',identity:identities.reader,body:{employee_id:employeeId,provider_subject:'synthetic-attacker-subject'}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    result=await request('/api/integrations/entra-role-mappings',{method:'POST',identity:identities.reader,body:{group_id:'synthetic-elevation',group_name:'Synthetic group',role_name:'Admin'}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    result=await request('/api/integrations/entra-role-mappings',{method:'POST',identity:identities.manager,body:{group_id:'synthetic-approved',group_name:'Synthetic group',role_name:'Employee'}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    const importRow={employeeId:profile.employee_id,name:profile.name,email:profile.email,primaryCountryDirectorId:profile.primary_country_director_id};
    result=await request('/api/imports/employees/apply',{method:'POST',identity:identities.reader,body:{fileName:'synthetic.csv',rows:[{...importRow,roles:'Employee'}]}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin']);
    result=await request('/api/imports/employees/apply',{method:'POST',identity:identities.reader,body:{fileName:'synthetic.csv',rows:[importRow]}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin'],'Import omission preserves roles');
    await pool.query('delete from user_roles where user_id=$1',[ordinaryUser.id]);
    await pool.query(`insert into identity_provider_links(id,employee_id,provider,provider_subject,status)
      values ('synthetic-mapped-only',$1,'entra','synthetic-mapped-only-subject','Linked')`,[ordinary.body.id]);
    await pool.query(`insert into entra_group_role_mappings(id,group_id,group_name,role_name,active)
      values ('synthetic-maintenance-map','synthetic-maintenance-group','Synthetic maintenance group','Employee',true)`);
    result=await save({...profile,employee_id:'SYNTHETIC-RESET',email:'reset@example.test',name:'Synthetic mapped-only worker'});
    assert.equal(result.status,200,'Omitted roles preserve mapped-only accounts with no local roles');
    assert.deepEqual(await roles(ordinary.body.id),[]);
    result=await save({...profile,employee_id:'SYNTHETIC-RESET',email:'reset@example.test',roles:[]},identities.manager);
    assert.equal(result.status,422,'Explicit empty assignments remain invalid');
    for (const path of ['/api/imports/employees/apply','/api/v1/imports/employees/apply']) {
      result=await request(path,{method:'POST',identity:identities.reader,headers:{'Idempotency-Key':randomUUID()},
        body:{fileName:'synthetic.csv',...(path.includes('/v1/')?{schemaVersion:'employee-master/1',dryRun:false}:{}),
          rows:[{employeeId:'SYNTHETIC-RESET',name:'Synthetic mapped-only imported',email:'reset@example.test',primaryCountryDirectorId:'director-commercial'}]}});
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual(await roles(ordinary.body.id),[]);
    }
    const beforeName=(await pool.query('select name from employees where id=$1',[ordinary.body.id])).rows[0].name;
    for (const path of ['/api/imports/employees/apply','/api/v1/imports/employees/apply']) {
      const versioned=path.includes('/v1/');
      const importBody={fileName:'synthetic.csv',rows:[
        {employeeId:'SYNTHETIC-RESET',name:'Synthetic rolled back change',email:'reset@example.test',primaryCountryDirectorId:'director-commercial'},
        {...importRow,roles:'Employee'},
      ],...(versioned?{schemaVersion:'employee-master/1',dryRun:false}:{})};
      result=await request(path,{method:'POST',identity:identities.reader,headers:{'Idempotency-Key':randomUUID()},body:importBody});
      assert.equal(result.status,403,JSON.stringify(result.body));
      assert.equal((await pool.query('select name from employees where id=$1',[ordinary.body.id])).rows[0].name,beforeName,
        'Forbidden security mutation rolls back earlier import rows');
      assert.deepEqual(await roles(employeeId),['Admin']);
      result=await request(path,{method:'POST',identity:identities.reader,headers:{'Idempotency-Key':randomUUID()},
        body:{...importBody,rows:[{...importRow,entraObjectId:'synthetic-import-binding'}]}});
      assert.equal(result.status,403,JSON.stringify(result.body));
      assert.equal((await pool.query('select entra_object_id from employees where id=$1',[employeeId])).rows[0].entra_object_id,null);
      result=await request(path,{method:'POST',identity:identities.reader,headers:{'Idempotency-Key':randomUUID()},body:{...importBody,rows:[importRow]}});
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual(await roles(employeeId),['Admin']);
    }
    const weakPassword = randomUUID().concat('SYNTHETIC-WEAK');
    result=await save({...base,employee_id:'SYNTHETIC-WEAK',email:'weak@example.test',initial_password:weakPassword});
    assert.equal(result.status,422,JSON.stringify(result.body));
    assert.equal((await pool.query("select 1 from employees where employee_id='SYNTHETIC-WEAK'")).rowCount,0,'Rejected account creation rolls back profile writes');
    await pool.query("delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Admin')",[identities.manager.id]);
    const targetIdentity={id:target.id,username:profile.employee_id.toLowerCase(),role:'Admin'};
    result=await save({...profile,roles:['Employee']},targetIdentity);
    assert.equal(result.status,422,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin'],'Last assigned administrator removal is refused');

  });
});
console.log('Protected identity administration: role escalation, code prefix, omitted roles, credential replacement, privileged reset/binding, mapping authority and password policy passed.');
