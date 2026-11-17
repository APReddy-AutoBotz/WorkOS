import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialIdentities,seedCommercialReferences,withCommercialApi,commercialFixture as f} from './support/commercial-drafting-test.mjs';
await withCommercialDatabase(async({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);await seedCommercialReferences(pool);
 const identities=await seedCommercialIdentities(pool);
 identities.reader.employeeRecordId=f.ownerId;identities.reader.employeeId='SYNTHETIC-COMMERCIAL-LOCAL';
 identities.denied.employeeRecordId='notification-team-lead';identities.denied.employeeId='SYN-NOTICE-LEAD';
 await pool.query('update users set employee_record_id=$1 where id=$2',[f.ownerId,identities.reader.id]);
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values('notification-team-lead','SYN-NOTICE-LEAD','Synthetic notification lead','notice-lead@example.test','Lead','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 await pool.query('update users set employee_record_id=$1 where id=$2',[identities.denied.employeeRecordId,identities.denied.id]);
 await pool.query('update employees set reporting_manager_id=$1 where id=$2',[identities.denied.employeeRecordId,f.ownerId]);
 for(const role of ['Admin','Employee','TeamLead'])await pool.query("insert into role_permissions(role_name,permission_key,enabled) values($1,'notifications.manage',true) on conflict(role_name,permission_key)do update set enabled=true",[role]);
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values('notification-other-local','SYN-NOTICE-OTHER','Synthetic unrelated worker','notice-other@example.test','Analyst','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 for(const [key,worker] of [['own',f.ownerId],['unrelated','notification-other-local'],['legal',f.otherOwnerId],['foreign',f.foreignOwnerId],['orphan',null]]){
  await pool.query("insert into notification_events(id,recipient_employee_id,event_type,title,body)values($1,$2,'SyntheticScope','Synthetic notice','Synthetic body')",['event-'+key,worker]);
  await pool.query("insert into notification_delivery_attempts(id,notification_id,channel,provider,status,response_metadata)values($1,$2,'Email','mock','Delivered',$3)",[key,'event-'+key,JSON.stringify({statusCode:202,mode:'graph',error:'placeholder-private-provider-detail',nested:{credential:'placeholder-private-provider-detail'},recipient:key+'@example.test'})]);
 }
 const privateDetail='placeholder-private-provider-detail';
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','integrations.identity',true),('Admin','audit.view',true) on conflict(role_name,permission_key) do update set enabled=true");
 await pool.query(`insert into notification_delivery_attempts(id,notification_id,channel,provider,status,attempted_at)
 select 'foreign-new-'||i,'event-foreign','Teams','mock','Failed',now()+interval '1 day' from generate_series(1,305) i`);
 await pool.query(`insert into integration_event_logs(id,provider,event_type,entity_type,entity_id,status,request_payload,response_payload,organization_id,legal_entity_id)
 values('synthetic-delivery-history','email','EmailNotificationFailed','NotificationEvent','event-own','Failed',$1,$1,$2,$3)`,[JSON.stringify({error:privateDetail,sender:privateDetail,nested:{token:privateDetail},statusCode:503}),f.organizationId,f.legalEntityId]);
 await pool.query(`insert into audit_logs(user_id,user_name,user_role,module,action,entity_type,entity_id,details,new_value,organization_id,legal_entity_id)
 values($1,'Synthetic administrator','Admin','Notifications','Send Notification','NotificationEvent','event-own','Synthetic notification audit',$2,$3,$4)`,[identities.manager.id,JSON.stringify({title:'Synthetic retained notice',deliveryResults:[{channel:'Email',provider:'graph',status:'Failed',error:privateDetail,nested:{token:privateDetail}}]}),f.organizationId,f.legalEntityId]);
 const retained=async()=>({attempts:(await pool.query('select * from notification_delivery_attempts order by id')).rows,integrations:(await pool.query('select * from integration_event_logs order by id')).rows,audit:(await pool.query('select * from audit_logs order by id')).rows});
 const before=await retained();
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  for(const prefix of ['/api']){
   const read=async(identity,scope)=>{const r=await request(prefix+'/notification-delivery-attempts',{identity,...scope?{scope}:{}});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(JSON.stringify(r.body).includes(privateDetail),false);assert.ok(r.body.every(row=>JSON.stringify(row.response_metadata)===JSON.stringify({mode:'graph',statusCode:202})));return r.body.map(x=>x.id).sort();};
   assert.deepEqual(await read(identities.manager),['own','unrelated'],'Admin history remains in the active legal entity');
   await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)values($1,$2,$3,true)',[identities.manager.id,f.organizationId,f.otherLegalEntityId]);
   assert.deepEqual(await read(identities.manager,{organizationId:f.organizationId,legalEntityId:f.otherLegalEntityId}),['legal'],'Scope switch selects only the newly active legal entity');
   assert.deepEqual(await read(identities.reader),['own'],'Granted notification permission does not widen employee data scope');
   assert.deepEqual(await read(identities.denied),['own'],'TeamLead does not see unrelated workers');
   await pool.query("update employees set reporting_manager_id=$1 where id='notification-other-local'",[identities.denied.employeeRecordId]);
   assert.deepEqual(await read(identities.denied),['own','unrelated'],'Authorized direct report remains visible');
   await pool.query("update employees set reporting_manager_id=null where id='notification-other-local'");
   assert.deepEqual(await read(identities.denied),['own'],'Removed reporting relationship immediately removes delivery history');
   assert.equal((await request(prefix+'/notification-delivery-attempts',{authenticated:false})).status,401);
  }
  for(const path of ['/api/integrations/events','/api/v1/integrations/events','/api/integrations/health','/api/audit-logs','/api/v1/audit-logs']) {
   const result=await request(path);assert.equal(result.status,200,`${path}: ${JSON.stringify(result.body)}`);
   assert.equal(JSON.stringify(result.body).includes(privateDetail),false,`${path} must sanitize historical diagnostic copies`);
   assert.ok(JSON.stringify(result.body).includes('NOTIFICATION_DELIVERY_FAILED'),`${path} retains safe failure evidence`);
  }
  assert.deepEqual(await retained(),before,'Scoped/redacted readers do not rewrite historical records');
  await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key='notifications.manage'");
  assert.equal((await request('/api/notification-delivery-attempts',{identity:identities.reader})).status,403);
 });
 await withCommercialApi({databaseUrl,identities,emailProvider:'synthetic-unsupported-provider'},async({request})=>{
  const result=await request('/api/notifications/test-delivery',{method:'POST',body:{employee_id:f.ownerId,channels:['InApp','Email'],title:'Synthetic provider outcome',body:'Synthetic body'}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const attempts=(await pool.query('select channel,status,response_metadata from notification_delivery_attempts where notification_id=$1 order by channel',[result.body.id])).rows;
  assert.deepEqual(attempts.map(r=>[r.channel,r.status]),[['Email','Failed'],['InApp','Delivered']]);
  assert.equal(attempts[0].response_metadata.errorCode,'NOTIFICATION_DELIVERY_FAILED');
  assert.equal(Object.hasOwn(attempts[0].response_metadata,'error'),false);
  const log=(await pool.query("select response_payload from integration_event_logs where entity_id=$1 and event_type='EmailNotificationFailed' order by created_at desc limit 1",[f.ownerId])).rows[0];
  assert.deepEqual(log.response_payload,{errorCode:'NOTIFICATION_DELIVERY_FAILED'});
  const audit=(await pool.query("select new_value from audit_logs where module='Notifications' and action='Send Notification' and new_value->>'id'=$1",[result.body.id])).rows[0];
  const failed=audit.new_value.deliveryResults.find(r=>r.channel==='Email');
  assert.equal(failed.errorCode,'NOTIFICATION_DELIVERY_FAILED');assert.equal(Object.hasOwn(failed,'error'),false);
 });
});
console.log('Notification delivery history: active entity, own/direct-report scope, orphan exclusion, authentication and permission-loss checks passed.');
