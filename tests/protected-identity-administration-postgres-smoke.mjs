import assert from 'node:assert/strict';
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
      country:'US', primary_country_director_id:'director-commercial', initial_password:'Synthetic!Passphrase98'};
    const save = (body, identity=identities.reader) => request('/api/employees', {method:'POST', identity, body});
    const roles = async id => (await pool.query(`select r.name from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where u.employee_record_id=$1 order by r.name`,[id])).rows.map(r=>r.name);
    const created = await save(base);
    assert.equal(created.status,200,JSON.stringify(created.body));
    const employeeId=created.body.id;
    assert.deepEqual(await roles(employeeId),['Employee'],'Employee codes never grant security roles');
    const {initial_password: _password,...profile}=base;
    const target=(await pool.query('select id,password_hash from users where employee_record_id=$1',[employeeId])).rows[0];
    let result=await save({...profile,roles:['Admin']});
    assert.equal(result.status,403,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Employee']);
    result=await save({...profile,roles:['Admin']},identities.manager);
    assert.equal(result.status,200,JSON.stringify(result.body));
    result=await save({...profile,name:'Synthetic updated worker'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin'],'Omitted roles preserve existing assignment');
    result=await save({...profile,initial_password:'Replacement!Passphrase98'});
    assert.equal(result.status,422,JSON.stringify(result.body));
    assert.equal((await pool.query('select password_hash from users where id=$1',[target.id])).rows[0].password_hash,target.password_hash);
    result=await request(`/api/users/${target.id}/password-reset`,{method:'POST',identity:identities.reader,body:{newPassword:'Replacement!Passphrase98'}});
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
    result=await save({...base,employee_id:'SYNTHETIC-WEAK',email:'weak@example.test',initial_password:'SYNTHETIC-WEAK-password'});
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
