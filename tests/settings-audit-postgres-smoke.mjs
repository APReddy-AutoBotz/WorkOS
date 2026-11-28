import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {withCommercialDraftingApi} from './support/commercial-drafting-test.mjs';

const hours = rows => rows.find(row => row.key === 'expectedWeeklyHours')?.value;
const settings = count => ({
  expectedWeeklyHours: count, utilizationThresholdHigh: 100, utilizationThresholdLow: 80, benchThreshold: 20,
});

await withCommercialDraftingApi(async ({pool, request, identities, actorId}) => {
  await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    values ('Admin','settings.manage',true),('Employee','settings.manage',false)
    on conflict(role_name,permission_key) do update set enabled=excluded.enabled`);
  const otherAdmin = {...identities.denied,role:'Admin'};
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin'",[otherAdmin.id]);
  const save = (count, identity) => request('/api/settings', {method:'POST', body:settings(count), identity});
  assert.equal((await save(40)).status,200);
  assert.equal((await save(50,identities.reader)).status,403);

  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('begin');
    await blocker.query('lock table system_settings in share mode');
    pending = Promise.allSettled([save(36),save(32,otherAdmin)]);
    const deadline = Date.now()+10000;
    for (;;) {
      const {rows:[{writers}]} = await blocker.query(`select count(distinct pid)::int as writers from pg_locks
        where relation='system_settings'::regclass and database=(select oid from pg_database where datname=current_database()) and not granted`);
      if (writers === 2) break;
      assert(Date.now()<deadline,'Both Settings API requests must be waiting to write');
      await delay(25);
    }
  } finally {
    try { await blocker.query('rollback'); } finally { blocker.release(); }
  }
  const replies = await pending;
  for (const [i,reply] of replies.entries()) {
    assert.equal(reply.status,'fulfilled');
    assert.equal(reply.value.status,200);
    assert.equal(hours(reply.value.body),[36,32][i]);
  }
  const audit = () => pool.query(`select old_value,new_value,user_id,active_role,source,organization_id,legal_entity_id
    from audit_logs where action='Update Settings' and entity_type='SystemSettings' and entity_id='system'`);
  const {rows} = await audit();
  assert.equal(rows.length,3);
  const changes = rows.filter(row => row.new_value.expectedWeeklyHours !== 40);
  const first = changes.find(row => hours(row.old_value) === 40);
  assert(first);
  const second = changes.find(row => row !== first);
  assert.equal(hours(second.old_value),first.new_value.expectedWeeklyHours);
  for (const row of rows) {
    assert.equal(row.user_id,row.new_value.expectedWeeklyHours === 32 ? otherAdmin.id : actorId);
    assert.equal(row.active_role,'Admin');
    assert.equal(row.source,'Web');
    assert.equal(row.organization_id,null);
    assert.equal(row.legal_entity_id,null);
  }
  for (const [path,entity,lockPrefix,fields] of [
    ['/api/catalogs/industries','CatalogItem','catalog-item',{}],
    ['/api/country-directors','CountryDirector','country-director',{region:'Synthetic region'}],
  ]) {
    const id = 'synthetic-concurrent-'+lockPrefix;
    const gate = await pool.connect();
    let saves;
    try {
      await gate.query('begin');
      await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[lockPrefix+':'+id]);
      saves = Promise.allSettled([identities.manager,otherAdmin].map((identity,index) =>
        request(path,{method:'POST',identity,body:{id,...fields,name:'Synthetic revision '+index}})));
      const deadline = Date.now()+10000;
      for (;;) {
        const {rows:[{writers}]} = await gate.query(`select count(*)::int as writers from pg_locks
          where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`);
        if (writers === 2) break;
        assert(Date.now()<deadline,'Both first-time saves must reach the serialization point');
        await delay(25);
      }
    } finally {
      try { await gate.query('rollback'); } finally { gate.release(); }
    }
    const responses = await saves;
    const {rows:events} = await pool.query('select action,user_id,old_value,new_value from audit_logs where entity_type=$1 and entity_id=$2',[entity,id]);
    assert.equal(events.length,2);
    const create = events.find(row => row.action.startsWith('Create '));
    const update = events.find(row => row.action.startsWith('Update '));
    assert.equal(create.old_value,null);
    assert.deepEqual(update.old_value,create.new_value);
    for (const [i,response] of responses.entries()) {
      assert.equal(response.status,'fulfilled');
      assert.equal(response.value.status,200);
      assert.equal(response.value.body.name,'Synthetic revision '+i);
      const event = events.find(row => row.user_id === [actorId,otherAdmin.id][i]);
      assert.deepEqual(event.new_value,response.value.body);
    }
  }
  const permissionKey='projects.view';
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','permissions.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
  await pool.query("delete from role_permissions where role_name='Employee' and permission_key=$1",[permissionKey]);
  const gate=await pool.connect();
  let permissionSaves;
  try {
    await gate.query('begin');
    const lockKey='role-permission:Employee:'+permissionKey;
    await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
    permissionSaves=Promise.allSettled([identities.manager,otherAdmin].map((identity,i)=>
      request('/api/permissions/roles/Employee',{method:'PATCH',identity,body:{permissionKey,enabled:i===0}})));
    const deadline=Date.now()+10000;
    for(;;){
      const {rows:[{writers}]}=await gate.query(`select count(*)::int as writers from pg_locks
        where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())
          and classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
          and objid::bigint=(hashtextextended($1,0)&4294967295)`,[lockKey]);
      if(writers===2)break;
      assert(Date.now()<deadline,'Both permission saves must reach the same first-write boundary');
      await delay(25);
    }
  } finally {
    try {await gate.query('rollback');} finally {gate.release();}
  }
  for(const [i,reply] of (await permissionSaves).entries()){
    assert.equal(reply.status,'fulfilled');
    assert.equal(reply.value.status,200,JSON.stringify(reply.value.body));
    assert.equal(reply.value.body.enabled,i===0);
  }
  const permissionRows=(await pool.query(`select changed_by,old_value,new_value from permission_change_history
    where role_name='Employee' and permission_key=$1`,[permissionKey])).rows;
  const permissionEvents=(await pool.query(`select user_id,old_value,new_value from audit_logs
    where entity_type='RolePermission' and entity_id=$1`,['Employee:'+permissionKey])).rows;
  assert.equal(permissionRows.length,2);
  assert.equal(permissionEvents.length,2);
  const initial=permissionRows.find(row=>row.old_value===null);
  assert(initial,'One history entry must record the initial permission');
  const replacement=permissionRows.find(row=>row!==initial);
  assert.deepEqual(replacement.old_value,initial.new_value);
  const stored=(await pool.query("select * from role_permissions where role_name='Employee' and permission_key=$1",[permissionKey])).rows[0];
  assert.deepEqual(JSON.parse(JSON.stringify(stored)),replacement.new_value);
  for(const row of permissionRows){
    const event=permissionEvents.find(event=>event.user_id===row.changed_by);
    assert.deepEqual(event.old_value,row.old_value);
    assert.deepEqual(event.new_value,row.new_value);
  }
  await pool.query("alter table audit_logs add constraint reject_role_permission_audit check (action <> 'Update Role Permission') not valid");
  const rejected=await request('/api/permissions/roles/Employee',{
    method:'PATCH',body:{permissionKey,enabled:!stored.enabled},
  });
  assert.equal(rejected.status,500);
  const retained=await pool.query("select * from role_permissions where role_name='Employee' and permission_key=$1",[permissionKey]);
  assert.deepEqual(retained.rows,[stored]);
  const history=await pool.query("select count(*)::int as count from permission_change_history where role_name='Employee' and permission_key=$1",[permissionKey]);
  assert.equal(history.rows[0].count,2);
  const before = (await request('/api/settings')).body;
  assert.equal(hours(before),second.new_value.expectedWeeklyHours);
  await pool.query("alter table audit_logs add constraint simulate_audit_failure check (action <> 'Update Settings') not valid");
  assert.equal((await save(42)).status,500);
  assert.deepEqual((await request('/api/settings')).body,before);
  assert.equal((await audit()).rowCount,3);
});
console.log('Concurrent settings, catalog and role-permission audit history, per-save responses and atomic rollback passed.');
