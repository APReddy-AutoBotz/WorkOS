import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialReferences,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
await withCommercialDatabase(async ({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool); await seedCommercialReferences(pool);
  const identities=await seedCommercialIdentities(pool);
  await pool.query("insert into country_directors(id,name,region) values ('director-new','Synthetic new director','Synthetic region')");
  const worker={id:'synthetic-director-worker',employee_id:'SYNTHETIC-DIRECTOR',name:'Synthetic director',email:'synthetic-director@example.test',designation:'Country Director',department:'Regional Leadership',country:'US',primary_country_director_id:'director-commercial',status:'Active'};
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'org-default','legal-default')`,Object.values(worker));
  const password=randomBytes(24).toString('base64url')+'!Synthetic92',salt=randomBytes(16).toString('hex');
  await pool.query('update users set employee_record_id=$1,employee_id=$2,password_hash=$3 where id=$4',[worker.id,worker.employee_id,`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`,identities.reader.id]);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='CountryDirector'",[identities.reader.id]);
  await withCommercialApi({databaseUrl,identities},async ({request,tokenFor})=>{
    const login=async()=>{const r=await request('/api/auth/login',{authenticated:false,method:'POST',body:{username:identities.reader.username,password,requestedRole:'CountryDirector'}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.token;};
    const old=await login();
    const read=token=>request('/api/employees',{headers:{Authorization:`Bearer ${token}`}});
    const cookieRead=()=>request('/api/employees',{authenticated:false,headers:{Cookie:`workos_session=${old}`}});
    const before=await read(old);assert.equal(before.status,200);assert.ok(before.body.some(e=>e.id==='employee-commercial-owner'));
    const update=await request('/api/employees',{method:'POST',body:{...worker,primary_country_director_id:'director-new'}});assert.equal(update.status,200,JSON.stringify(update.body));
    const after=await read(old),fresh=await read(await login());assert.equal(after.status,200);assert.equal(fresh.status,200);
    assert.ok(!after.body.some(e=>e.id==='employee-commercial-owner'),'retained token loses prior workforce immediately');
    assert.ok(!fresh.body.some(e=>e.id==='employee-commercial-owner'),'fresh token loses prior workforce');
    assert.ok(after.body.some(e=>e.id===worker.id),'retained session can see its current director workforce');
    const cookieAfter=await cookieRead();assert.equal(cookieAfter.status,200);
    assert.deepEqual(cookieAfter.body.map(e=>e.id),after.body.map(e=>e.id),'cookie and bearer use identical current bindings');
    const changedDesignation=await request('/api/employees',{method:'POST',body:{...worker,designation:'Consultant',department:'Delivery',primary_country_director_id:'director-new'}});
    assert.equal(changedDesignation.status,200,JSON.stringify(changedDesignation.body));
    assert.deepEqual((await read(old)).body,[],'retained role alone cannot preserve a removed director qualification');
    assert.deepEqual((await cookieRead()).body,[]);
    // Direct fixture mutation exercises removal of identity linkage, without
    // claiming an unsupported public identity-transfer command exists.
    await pool.query('update users set employee_record_id=null,employee_id=null where id=$1',[identities.reader.id]);
    const stale=tokenFor({...identities.reader,role:'CountryDirector',employeeRecordId:worker.id,employeeId:worker.employee_id,countryDirectorId:'director-commercial'});
    assert.deepEqual((await read(stale)).body,[],'signed historical bindings cannot override a null current binding');
    const scope=await request('/api/employees',{headers:{Authorization:`Bearer ${old}`,'x-legal-entity-id':'legal-commercial-other'}});
    assert.equal(scope.status,403,'live binding does not grant another legal entity');
    await pool.query('update users set employee_id=$1 where id=$2',[worker.employee_id,identities.reader.id]);
    await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name in ('TeamLead','ProjectManager') on conflict do nothing",[identities.reader.id]);
    for(const role of ['Employee','TeamLead','ProjectManager']) {
      const legacy=tokenFor({...identities.reader,role,employeeRecordId:'employee-commercial-owner',employeeId:'SYNTHETIC-COMMERCIAL-LOCAL'});
      const visible=await read(legacy);assert.equal(visible.status,200,JSON.stringify(visible.body));
      assert.deepEqual(visible.body,[],`${role} cannot infer a canonical worker from a legacy code alone`);
    }
    await pool.query('update users set employee_record_id=$1 where id=$2',[worker.id,identities.reader.id]);
    for(const role of ['Employee','TeamLead','ProjectManager']) {
      const current=await read(tokenFor({...identities.reader,role,employeeRecordId:'employee-commercial-owner',employeeId:'SYNTHETIC-COMMERCIAL-LOCAL'}));
      assert.equal(current.status,200);assert.deepEqual(current.body.map(e=>e.id),[worker.id]);
    }
    await pool.query("update employees set employee_id='SYNTHETIC-DIRECTOR-RENAMED' where id=$1",[worker.id]);
    for(const path of ['/api/auth/me','/api/v1/auth/me']) {
      const refreshed=await request(path,{headers:{Authorization:`Bearer ${old}`}});
      assert.equal(refreshed.status,200);
      const body=refreshed.body.data || refreshed.body;
      assert.equal(body.employeeId,'SYNTHETIC-DIRECTOR-RENAMED','refresh uses canonical current worker code rather than users legacy copy');
      assert.equal(body.employeeRecordId,worker.id);
      assert.equal(body.countryDirectorId,null);
    }
    await pool.query("delete from user_roles where user_id=$1 and role_id=(select id from roles where name='CountryDirector')",[identities.reader.id]);
    await pool.query("insert into entra_group_role_mappings(id,group_id,group_name,role_name,active) values('synthetic-director-map','synthetic-director-group','Synthetic director group','CountryDirector',true)");
    const mapped=tokenFor({...identities.reader,countryDirectorId:'director-commercial'},'CountryDirector',{identityProvider:'entra',entraGroups:['synthetic-director-group']});
    assert.deepEqual((await read(mapped)).body,[],'provider-mapped role does not confer removed director qualification');
    const unlinkedAdmin=await request('/api/auth/me');
    assert.equal(unlinkedAdmin.status,200,'unlinked Admin retains legitimate account authority');
    assert.equal(unlinkedAdmin.body.employeeRecordId,null);
    console.log('Current workforce binding PostgreSQL acceptance passed: issued token loses prior director scope after supported reassignment.');
  });
});
