import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
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
    const mappingPath = '/api/integrations/entra-role-mappings';
    const releasePath = '/api/organization-setup/module-releases/entra';
    assert.equal((await request(mappingPath)).body.code,'MODULE_DISABLED');
    const release = (enabled,expectedRevision) => request(releasePath,{method:'PUT',body:{
      enabled, expectedRevision, evidence:'Synthetic identity administration review',
    }});
    assert.equal((await release(true,0)).status,201);
    result=await request('/api/integrations/identity-links',{method:'POST',identity:identities.reader,body:{employee_id:employeeId,provider_subject:'synthetic-attacker-subject'}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    result=await request('/api/integrations/entra-role-mappings',{method:'POST',identity:identities.reader,body:{group_id:'synthetic-elevation',group_name:'Synthetic group',role_name:'Admin'}});
    assert.equal(result.status,403,JSON.stringify(result.body));
    result=await request('/api/integrations/entra-role-mappings',{method:'POST',identity:identities.manager,body:{group_id:'synthetic-approved',group_name:'Synthetic group',role_name:'Employee'}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    // Both requests initially target a new group. Their audit records must form one chain.
    const secondAdmin={...identities.denied,role:'Admin'};
    await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[secondAdmin.id]);
    const groupId='synthetic-concurrent-mapping';
    const writers=[identities.manager,secondAdmin];
    const mappings=['TeamLead','ProjectManager'].map(role=>({group_id:groupId,group_name:'Synthetic '+role,role_name:role,active:true}));
    const barrier=await pool.connect();
    let pending;
    try{
      await barrier.query('begin');
      await barrier.query('lock table entra_group_role_mappings in share mode');
      pending=Promise.all(writers.map((identity,i)=>request(mappingPath,{method:'POST',identity,body:mappings[i]})));
      const deadline=Date.now()+10000;
      for(;;){
        const {rows:[{count}]}=await barrier.query(`select count(distinct pid)::int as count from pg_locks
          where relation='entra_group_role_mappings'::regclass and database=(select oid from pg_database where datname=current_database())
          and not granted`);
        if(count===2)break;
        assert(Date.now()<deadline,'Both administrator saves must be waiting for the mapping table');
        await delay(25);
      }
    }finally{
      try{await barrier.query('rollback');}finally{barrier.release();}
    }
    const replies=await pending;
    for(const [i,reply] of replies.entries()){
      assert.equal(reply.status,200,JSON.stringify(reply.body));
      assert.equal(reply.body.role_name,mappings[i].role_name);
      assert.equal(reply.body.id,replies[0].body.id);
    }
    const entityId=replies[0].body.id;
    const {rows:auditRows}=await pool.query(`select action,user_id,active_role,source,old_value,new_value,organization_id,legal_entity_id
      from audit_logs where entity_type='EntraRoleMapping' and entity_id=$1`,[entityId]);
    assert.equal(auditRows.length,2);
    const created=auditRows.find(row=>row.action==='Create Entra Role Mapping');
    const updated=auditRows.find(row=>row.action==='Update Entra Role Mapping');
    assert.ok(created);
    assert.ok(updated);
    assert.equal(created.old_value,null);
    assert.deepEqual(updated.old_value,created.new_value);
    for(const row of auditRows){
      const i=mappings.findIndex(m=>m.role_name===row.new_value.role_name);
      assert.equal(row.user_id,writers[i].id);
      assert.deepEqual(row.new_value,replies[i].body);
      assert.equal(row.active_role,'Admin');
      assert.equal(row.source,'System');
      assert.equal(row.organization_id,null);
      assert.equal(row.legal_entity_id,null);
    }
    const live=(await pool.query('select role_name from entra_group_role_mappings where group_id=$1',[groupId])).rows[0];
    assert.equal(live.role_name,updated.new_value.role_name);
    const history=async()=>(await pool.query(`select response_payload,organization_id,legal_entity_id
      from integration_event_logs where provider='entra' and event_type='RoleMappingUpserted' and entity_id=$1`,[entityId])).rows;
    const events=await history();
    assert.equal(events.length,2);
    for(const event of events){
      assert.deepEqual(event.response_payload,replies.find(r=>r.body.role_name===event.response_payload.role_name).body);
      assert.equal(event.organization_id,null);
      assert.equal(event.legal_entity_id,null);
    }
    await pool.query(`create function reject_synthetic_mapping_audit() returns trigger language plpgsql as $$
      begin if new.entity_type='EntraRoleMapping' and new.new_value->>'group_id'='synthetic-concurrent-mapping'
        then raise exception 'Synthetic mapping audit unavailable'; end if; return new; end $$;
      create trigger reject_synthetic_mapping_audit before insert on audit_logs for each row execute function reject_synthetic_mapping_audit()`);
    const failed=await request(mappingPath,{method:'POST',body:{...mappings[0],active:false}});
    assert.equal(failed.status,500);
    const retained=(await pool.query('select active,role_name from entra_group_role_mappings where id=$1',[entityId])).rows[0];
    assert.deepEqual(retained,{active:true,role_name:live.role_name});
    assert.equal((await history()).length,2);
    assert.equal((await pool.query("select 1 from audit_logs where entity_type='EntraRoleMapping' and entity_id=$1",[entityId])).rowCount,2);
    assert.equal((await release(false,1)).status,201);
    assert.equal((await request(mappingPath)).body.code,'MODULE_DISABLED');
    assert.equal((await request('/api/auth/me')).status,200);
    const blockedBinding = await save({...profile,entra_object_id:'synthetic-disabled-binding'},identities.manager);
    assert.equal(blockedBinding.status,403);
    assert.equal(blockedBinding.body.code,'MODULE_DISABLED');
    assert.equal((await pool.query('select entra_object_id from employees where id=$1',[employeeId])).rows[0].entra_object_id,null);
    assert.equal((await release(true,2)).status,201);

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
    const unlinkProfile={...profile,employee_id:'SYNTHETIC-UNLINK-CORRECTION',email:'unlink-correction@example.test'};
    const unlinkCreated=await save({...unlinkProfile,initial_password:initialPassword});
    assert.equal(unlinkCreated.status,200);
    for (const legacy of ['both','employee','user']) {
      await pool.query('delete from identity_provider_links where employee_id=$1',[unlinkCreated.body.id]);
      await pool.query('update employees set entra_object_id=$2 where id=$1',[unlinkCreated.body.id,legacy==='user'?null:'synthetic-cleared-subject']);
      await pool.query('update users set entra_object_id=$2 where employee_record_id=$1',[unlinkCreated.body.id,legacy==='employee'?null:'synthetic-cleared-subject']);
      assert.equal((await save(unlinkProfile)).status,200,'Omitted binding leaves legacy identity unchanged');
      assert.equal((await pool.query('select entra_object_id from users where employee_record_id=$1',[unlinkCreated.body.id])).rows[0].entra_object_id,legacy==='employee'?null:'synthetic-cleared-subject');
      assert.equal((await save({...unlinkProfile,entra_object_id:''},identities.manager)).status,200);
      const state=(await pool.query(`select e.entra_object_id as employee_subject,u.entra_object_id as user_subject,l.status,l.provider_subject
        from employees e join users u on u.employee_record_id=e.id left join identity_provider_links l on l.employee_id=e.id and l.provider='entra' where e.id=$1`,[unlinkCreated.body.id])).rows[0];
      assert.deepEqual(state,{employee_subject:null,user_subject:null,status:'Disabled',provider_subject:'synthetic-cleared-subject'},'Explicit clear revokes every legacy representation and persists a Disabled binding');
      const unlinkAudit=(await pool.query(`select user_id,active_role,source,old_value,new_value from audit_logs
        where action='Clear Identity Binding' order by created_at desc limit 1`)).rows[0];
      assert.equal(unlinkAudit.user_id,identities.manager.id);
      assert.equal(unlinkAudit.active_role,'Admin');
      assert.equal(unlinkAudit.source,'Entra');
      assert.deepEqual(unlinkAudit.old_value,{status:'Legacy',hasEmployeeSubject:legacy!=='user',hasUserSubject:legacy!=='employee'});
      assert.deepEqual(unlinkAudit.new_value,{status:'Disabled',hasEmployeeSubject:false,hasUserSubject:false});
      assert.equal(JSON.stringify(unlinkAudit).includes('synthetic-cleared-subject'),false,'Unlink audit uses safe state evidence, not raw provider identity');
    }
    await pool.query("delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Admin')",[identities.manager.id]);
    const targetIdentity={id:target.id,username:profile.employee_id.toLowerCase(),role:'Admin'};
    result=await save({...profile,roles:['Employee']},targetIdentity);
    assert.equal(result.status,422,JSON.stringify(result.body));
    assert.deepEqual(await roles(employeeId),['Admin'],'Last assigned administrator removal is refused');

  });
});
console.log('Protected identity administration: role escalation, code prefix, omitted roles, credential replacement, privileged reset/binding, mapping authority and password policy passed.');
