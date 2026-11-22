import {runMigrations} from '../server/migration-runner.mjs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {commercialFixture as f,withCommercialDatabase,withCommercialMigrationsThrough,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedDirectory} from './support/workforce-directory-test.mjs';
const path='/api/v1/workforce-directory',ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await withCommercialMigrationsThrough(71,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));const fx=await seedDirectory(pool),ids=fx.identities;
 assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts', '082l_wos06_retainer_invoice_approval', '082m_wos06_retainer_invoice_csv', '082n_wos06_retainer_billing_confirmation', '082o_wos06_retainer_reversal_review', '082p_wos06_retainer_credit', '082q_wos08_archive_constraint_resolution', '082r_wos06_managed_service_dimensions', '082s_wos06_service_unit_evidence', '082t_wos06_service_unit_reviews', '082u_wos06_service_unit_contract_prices', '082v_wos06_accepted_unit_valuation', '082w_wos06_service_unit_eligibility', '082x_wos06_service_unit_invoice_drafts', '082y_wos06_service_unit_invoice_approval', '082z_wos06_service_unit_invoice_export']);
 assert.equal((await pool.query('select count(*)::int n from worker_type_assignments')).rows[0].n,0);
 await withCommercialApi({databaseUrl,identities:ids,onServerError:s=>process.stderr.write(s)},async({request})=>{
  const read=(q={},identity=ids.denied)=>request(path+'?'+new URLSearchParams({contractVersion:'workforce-directory/2',...q}),{identity}),all=async(identity,q={})=>{let p=ok(await read(q,identity)),rows=[...p.workers];while(p.nextAfter){p=ok(await read({...q,after:p.nextAfter,expectedRosterToken:p.rosterToken},identity));rows.push(...p.workers);}return rows;};
  // Shared labels are readable in this entity but entity-scoped setup cannot retire them.
  await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Admin','settings.manage',true) on conflict(role_name,permission_key)do update set enabled=true");
  await pool.query(`insert into organization_catalog_items(id,organization_id,legal_entity_id,catalog_type,code,name,effective_from)
    values('shared-worker-kind',$1,null,'worker_type','SYN-SHARED','Shared visiting fellow',current_date-3),
          ('local-worker-kind',$1,$2,'worker_type','SYN-LOCAL','Local visiting fellow',current_date-3)`,[f.organizationId,f.legalEntityId]);
  const catalog='/api/v1/organization-setup/catalogs/worker_type';
  const retire=id=>request(catalog+'/'+id+'/retire',{method:'POST',body:{}});
  const catalogRows=ok(await request(catalog));
  assert.ok(catalogRows.some(x=>x.id==='shared-worker-kind'));
  assert.equal((await retire('shared-worker-kind')).status,404);
  assert.equal((await retire('directory-kind')).status,409);
  assert.equal(ok(await retire('local-worker-kind')).active,false);
  assert.ok(ok(await request(catalog)).some(x=>x.id==='shared-worker-kind' && x.active));
  assert.equal((await pool.query("select count(*)::int n from audit_logs where action='Retire Catalog Item' and entity_id='shared-worker-kind'")).rows[0].n,0);
  const parent=await request(catalog,{method:'POST',body:{code:'PARENT',name:'Synthetic parent type',effectiveFrom:'2020-01-01'}});
  assert.equal(parent.status,201,JSON.stringify(parent.body));
  const [child,retirement]=await Promise.all([
    request(catalog,{method:'POST',body:{code:'CHILD',name:'Synthetic child type',parentId:parent.body.id,effectiveFrom:'2020-01-01'}}),
    retire(parent.body.id),
  ]);
  assert.deepEqual([child.status,retirement.status],child.status===201?[201,409]:[409,200]);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled)values('Admin','employees.manage',true) on conflict(role_name,permission_key)do update set enabled=true");
  const worker=fx.children[0],types=path+'/workers/'+worker+'/type-assignments';
  const list=ok(await request(types+'?on='+fx.today));
  assert.ok(list.options.some(o=>o.id==='shared-worker-kind'));
  assert.equal((await request(types+'?on='+fx.today,{identity:ids.reader})).status,403);
  assert.equal((await request(path+'/workers/'+fx.other+'/type-assignments?on='+fx.today)).status,404);
  const assignment={expectedOwnerKey:list.ownerKey,requestId:randomUUID(),expectedLatestId:null,effectiveFrom:fx.today,
    workerTypeId:'shared-worker-kind',reason:'Synthetic current classification'};
  const save=(changes={})=>request(types,{method:'POST',body:{...assignment,...changes}});
  assert.equal((await save({effectiveFrom:'2000-01-01'})).status,409);
  assert.equal((await save({workerTypeId:'local-worker-kind'})).status,409);
  assert.equal((await save({expectedOwnerKey:'0'.repeat(64)})).status,409);
  await pool.query("create function refuse_type_audit() returns trigger language plpgsql as $$begin raise exception 'Synthetic audit refusal';end$$; create trigger refuse_type_audit before insert on audit_logs for each row when(new.action='Schedule Worker Type') execute function refuse_type_audit()");
  assert.equal((await save()).status,503);
  assert.equal(ok(await request(types+'?on='+fx.today)).latestId,null);
  await pool.query('drop trigger refuse_type_audit on audit_logs');
  const writes=await Promise.all([save(),save()]);
  assert.deepEqual(writes.map(r=>r.status).sort(),[200,201],JSON.stringify(writes));
  assert.equal((await save({reason:'Different request'})).status,409);
  assert.equal(ok(await read({parentId:worker})).parent.workerType,'Shared visiting fellow');
  const next={requestId:randomUUID(),expectedLatestId:assignment.requestId,effectiveFrom:fx.monday,workerTypeId:null};
  assert.equal((await save({...next,expectedLatestId:null})).status,409);
  assert.equal((await save(next)).status,201);
  const history=ok(await request(types+'?on='+fx.monday)).history;
  assert.deepEqual(history.map(v=>v.label),[null,'Shared visiting fellow']);
  assert.equal(ok(await read({parentId:worker})).parent.workerType,'Shared visiting fellow');
  await assert.rejects(pool.query('delete from worker_type_assignments where id=$1',[next.requestId]));
  const futureType=await request(catalog,{method:'POST',body:{code:'SCHEDULED',name:'Synthetic scheduled classification',effectiveFrom:fx.today}});
  assert.equal(futureType.status,201);
  const scheduled={expectedLatestId:next.requestId,requestId:randomUUID(),effectiveFrom:fx.dates[1],workerTypeId:futureType.body.id};
  assert.equal((await save(scheduled)).status,201);
  assert.equal((await retire(futureType.body.id)).status,409);
  assert.equal((await save({...scheduled,requestId:randomUUID(),expectedLatestId:scheduled.requestId})).status,409);
  assert.equal((await pool.query("select count(*)::int n from audit_logs where action='Schedule Worker Type' and entity_id=$1",[worker])).rows[0].n,3);
  await assert.rejects(pool.query(`insert into worker_type_assignments(organization_id,legal_entity_id,employee_id,previous_id,
    effective_from,actor_id,active_role,reason) select organization_id,legal_entity_id,employee_id,id,effective_from+1,actor_id,
    active_role,'Synthetic missing audit' from worker_type_assignments where id=$1`,[scheduled.requestId]),e=>e.code==='WKT03');
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
  await pool.query("update worker_profiles set effective_to=(current_timestamp at time zone 'UTC')::date-1 where employee_id=$1",[f.ownerId]);
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
  console.log('Scoped directory PostgreSQL/API receipt:',JSON.stringify({visibleTeamLead:25,directReports:23,nestedTraversal:true,employeeSelfOnly:true,projectManagerRelationshipOnly:true,directorAndHrScope:true,hiddenManagerNoIdentifier:true,literalUnicodeWildcardSearch:true,readNeutral:true,changedRoster409:true,heldRoleAndCurrentPermission403:true,populatedUpgrade:true,scheduledClassification:true}));
 });
});
