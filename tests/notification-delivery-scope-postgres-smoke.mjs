import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialIdentities,seedCommercialReferences,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);
 const identities=await seedCommercialIdentities(pool);
 identities.reader.employeeRecordId=f.ownerId;identities.reader.employeeId='SYNTHETIC-COMMERCIAL-LOCAL';
 identities.denied.employeeRecordId='synthetic-notification-lead';identities.denied.employeeId='SYNTHETIC-NOTIFICATION-LEAD';
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values('synthetic-notification-lead','SYNTHETIC-NOTIFICATION-LEAD','Synthetic notification lead','notice-lead@example.test','Lead','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 for(const identity of [identities.reader,identities.denied])await pool.query('update users set employee_record_id=$1,employee_id=$2 where id=$3',[identity.employeeRecordId,identity.employeeId,identity.id]);
 for(const role of ['Admin','Employee','TeamLead'])await pool.query("insert into role_permissions(role_name,permission_key,enabled) values($1,'notifications.manage',true) on conflict(role_name,permission_key)do update set enabled=true",[role]);
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values('notification-other-local','SYN-NOTICE-OTHER','Synthetic unrelated worker','notice-other@example.test','Analyst','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 for(const [key,worker] of [['own',f.ownerId],['lead',identities.denied.employeeRecordId],['unrelated','notification-other-local'],['legal',f.otherOwnerId],['foreign',f.foreignOwnerId],['orphan',null]]){
  await pool.query("insert into notification_events(id,recipient_employee_id,event_type,title,body)values($1,$2,'SyntheticScope','Synthetic notice','Synthetic body')",['event-'+key,worker]);
  await pool.query("insert into notification_delivery_attempts(id,notification_id,channel,provider,status,response_metadata)values($1,$2,'Email','mock','Delivered',$3)",[key,'event-'+key,JSON.stringify({syntheticRecipient:key+'@example.test'})]);
 }
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  for(const prefix of ['/api']){
   const read=async(identity,scope)=>{const r=await request(prefix+'/notification-delivery-attempts',{identity,...scope?{scope}:{}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.map(x=>x.id).sort();};
   assert.deepEqual(await read(identities.manager),['lead','own','unrelated'],'Admin history remains in the active legal entity');
   await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[identities.manager.id,f.organizationId,f.otherLegalEntityId]);
   assert.deepEqual(await read(identities.manager,{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}),['legal'],'Scope switch selects only the newly active legal entity');
   assert.deepEqual(await read(identities.reader),['own'],'Granted notification permission does not widen employee data scope');
   assert.deepEqual(await read(identities.denied),['lead'],'TeamLead does not see unrelated workers');
   await pool.query("update employees set reporting_manager_id=$1 where id='notification-other-local'",[identities.denied.employeeRecordId]);
   assert.deepEqual(await read(identities.denied),['lead','unrelated'],'Authorized direct report remains visible');
   await pool.query("update employees set reporting_manager_id=null where id='notification-other-local'");
   assert.equal((await request(prefix+'/notification-delivery-attempts',{authenticated:false})).status,401);
  }
  await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key='notifications.manage'");
  assert.equal((await request('/api/notification-delivery-attempts',{identity:identities.reader})).status,403);
 });
});
console.log('Notification delivery history: active entity, own/direct-report scope, orphan exclusion, authentication and permission-loss checks passed.');
