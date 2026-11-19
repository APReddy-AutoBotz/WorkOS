import assert from 'node:assert/strict';
import {commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedDirectory} from './support/workforce-directory-test.mjs';
const path='/api/v1/workforce-directory',ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const fx=await seedDirectory(pool),ids=fx.identities;
 await withCommercialApi({databaseUrl,identities:ids,onServerError:s=>process.stderr.write(s)},async({request})=>{
  const read=(q={},identity=ids.denied)=>request(path+'?'+new URLSearchParams({contractVersion:'workforce-directory/2',...q}),{identity}),all=async(identity,q={})=>{let p=ok(await read(q,identity)),rows=[...p.workers];while(p.nextAfter){p=ok(await read({...q,after:p.nextAfter,expectedRosterToken:p.rosterToken},identity));rows.push(...p.workers);}return rows;};
  const tables=['employees','users','user_roles','role_permissions','project_allocations','timesheets','leave_requests','workforce_capability_versions','worker_capacity_versions','worker_capacity_evidence','audit_logs'],snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await pool.query('select to_jsonb(t)v from '+t+' t order by to_jsonb(t)::text')).rows]))),before=await snapshot();
  const legacy=ok(await request(path,{identity:ids.denied}));
  assert.equal(legacy.contractVersion,'workforce-directory/1');
  assert.ok(legacy.workers.every(w=>!Object.hasOwn(w,'workerType')));
  const typed=async()=>ok(await read({search:'Synthetic visiting fellow'}));
  assert.deepEqual((await typed()).workers.map(w=>[w.id,w.workerType]),[[f.ownerId,'Synthetic visiting fellow']]);
  const prior=ok(await read());
  for(const [field,value,restore] of [['active',false,true],['legal_entity_id',f.otherLegalEntityId,f.legalEntityId],
    ['catalog_type','department','worker_type'],['effective_from','2099-01-01','2000-01-01']]){
   await pool.query('update organization_catalog_items set '+field+'=$1 where id=$2',[value,'directory-kind']);
   assert.equal((await typed()).totalMatching,0);
   assert.equal(ok(await read({parentId:f.ownerId})).parent.workerType,null);
   assert.equal((await read({after:prior.nextAfter,expectedRosterToken:prior.rosterToken})).status,409);
   await pool.query('update organization_catalog_items set '+field+'=$1 where id=$2',[restore,'directory-kind']);
  }
  await pool.query("update worker_profiles set effective_to=current_date-1 where employee_id=$1",[f.ownerId]);
  assert.equal((await typed()).totalMatching,0);
  await pool.query("update worker_profiles set effective_to=null where employee_id=$1",[f.ownerId]);
  assert.equal(ok(await read({parentId:f.ownerId})).parent.workerType,'Synthetic visiting fellow');
  const first=ok(await read());assert.equal(first.workers.length,20);assert.equal(first.totalMatching,25);const visible=await all(ids.denied);assert.equal(visible.length,25);assert.equal(new Set(visible.map(w=>w.id)).size,25);assert(!JSON.stringify(visible).includes(fx.root));assert(!JSON.stringify(visible).includes(fx.other));assert(!JSON.stringify(visible).includes(fx.unrelated));assert.equal(visible.find(w=>w.id===f.ownerId).manager,null);assert.equal(visible.find(w=>w.id===f.ownerId).visibleDirectReports,23);
  const direct=ok(await read({parentId:f.ownerId,expectedRosterToken:first.rosterToken}));assert.equal(direct.parent.id,f.ownerId);assert.equal(direct.totalMatching,23);assert.equal(direct.parent.manager,null);assert(direct.workers.every(w=>w.manager.id===f.ownerId));assert.equal((await all(ids.denied,{parentId:f.ownerId})).length,23);
  const nested=ok(await read({parentId:fx.children[0]}));assert.equal(nested.parent.manager.id,f.ownerId);assert.equal(nested.totalMatching,1);assert.equal(nested.workers[0].id,fx.grandchild);assert.equal((await read({parentId:fx.root})).status,404);assert.equal((await read({parentId:fx.other})).status,404);
  for(const search of['100%_','雪']){const p=ok(await read({search}));assert.equal(p.totalMatching,1);assert.equal(p.workers[0].id,fx.children[0]);}assert.equal(ok(await read({search:'%'})).totalMatching,1,'Wildcard is literal');assert.equal(ok(await read({search:'not-present'})).totalMatching,0);
  const employee=await all(ids.reader);assert.deepEqual(employee.map(w=>w.id),[f.ownerId]);assert.equal(employee[0].visibleDirectReports,0);assert.equal(employee[0].manager,null);assert.equal((await read({parentId:fx.children[0]},ids.reader)).status,404);
  const pm=await all(ids.pm);assert.deepEqual(new Set(pm.map(w=>w.id)),new Set([f.ownerId,fx.children[0]]));assert.equal(pm.find(w=>w.id===f.ownerId).visibleDirectReports,1);
  const director=await all(ids.director);assert(director.some(w=>w.id===fx.unrelated));assert(!director.some(w=>w.id===fx.other));const hr=await all(ids.hr),admin=await all(ids.manager);assert.equal(hr.length,admin.length);assert(admin.some(w=>w.id===fx.root));assert(!admin.some(w=>w.id===fx.other));
  assert.deepEqual(await snapshot(),before,'All reads are neutral across business sources, identity, permissions, retained evidence and audit');assert(!JSON.stringify(first).includes('email'));assert(!JSON.stringify(first).includes('leave'));assert(!JSON.stringify(first).includes('cost'));
  for(const q of[{after:first.nextAfter},{employeeId:fx.unrelated},{organizationId:f.otherOrganizationId},{role:'Admin'},{search:' x '},{search:'x'.repeat(101)},{parentId:''}])assert.equal((await read(q)).status,400);
  await pool.query('update employees set reporting_manager_id=$1 where id=$2',[fx.other,fx.unrelated]);
  assert.equal((await read({parentId:fx.unrelated})).status,404,'A manager chain may not cross legal entities and re-enter this roster');
  await pool.query('update employees set reporting_manager_id=null where id=$1',[fx.unrelated]);
  const old=first.rosterToken;await pool.query("update employees set name=name||' changed'where id=$1",[fx.children[0]]);assert.equal((await read({after:first.nextAfter,expectedRosterToken:old})).status,409);assert.equal((await read({parentId:f.ownerId,expectedRosterToken:old})).status,409);
  const renewed=ok(await read());await pool.query('update employees set reporting_manager_id=$1 where id=$2',[fx.children[1],fx.grandchild]);assert.equal((await read({after:renewed.nextAfter,expectedRosterToken:renewed.rosterToken})).status,409);
  await pool.query("update role_permissions set enabled=false where role_name='TeamLead'and permission_key='employees.view'");assert.equal((await read()).status,403);await pool.query("update role_permissions set enabled=true where role_name='TeamLead'and permission_key='employees.view'");
  assert.equal((await request(path,{identity:ids.reader,role:'Admin'})).status,403,'Existing held-role guard rejects an unheld signed active role');await pool.query('delete from user_roles where user_id=$1',[ids.denied.id]);assert.equal((await read()).status,403);await pool.query("insert into user_roles(user_id,role_id)select $1,id from roles where name='TeamLead'",[ids.denied.id]);
  await pool.query("update users set status='Inactive'where id=$1",[ids.denied.id]);assert.equal((await read()).status,403);await pool.query("update users set status='Active'where id=$1",[ids.denied.id]);
  for(const scope of[{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId},{organizationId:f.otherOrganizationId,legalEntityId:f.foreignLegalEntityId}])assert.equal((await request(path,{identity:ids.denied,scope})).status,403);
  assert.equal((await request(path,{authenticated:false})).status,401);assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  console.log('Scoped directory PostgreSQL/API receipt:',JSON.stringify({visibleTeamLead:25,directReports:23,nestedTraversal:true,employeeSelfOnly:true,projectManagerRelationshipOnly:true,directorAndHrScope:true,hiddenManagerNoIdentifier:true,literalUnicodeWildcardSearch:true,readNeutral:true,changedRoster409:true,heldRoleAndCurrentPermission403:true,noNewMigration:true}));
 });
});
