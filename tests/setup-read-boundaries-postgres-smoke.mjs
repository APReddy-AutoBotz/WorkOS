import assert from 'node:assert/strict';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialIdentities,seedCommercialReferences,commercialFixture as f,withCommercialApi} from './support/commercial-drafting-test.mjs';
await withCommercialDatabase(async ({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);
 await seedCommercialReferences(pool);
 const identities=await seedCommercialIdentities(pool);
 identities.reader.employeeRecordId=f.ownerId;
 identities.reader.employeeId='SYNTHETIC-COMMERCIAL-LOCAL';
 identities.denied.employeeRecordId='synthetic-setup-lead';
 identities.denied.employeeId='SYNTHETIC-SETUP-LEAD';
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values ('synthetic-setup-lead','SYNTHETIC-SETUP-LEAD','Synthetic scoped lead','setup-lead@example.test','Lead','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 for(const identity of [identities.reader,identities.denied]) await pool.query(
  'update users set employee_record_id=$1,employee_id=$2 where id=$3',[identity.employeeRecordId,identity.employeeId,identity.id]);
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) values ('Employee','employees.view',true),('TeamLead','employees.view',true) on conflict(role_name,permission_key) do update set enabled=true");
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,organization_id,legal_entity_id,status)
 values ('synthetic-unrelated-worker','SYNTHETIC-UNRELATED','Synthetic unrelated worker','unrelated@example.test','Analyst','Delivery','US','director-commercial','org-default','legal-default','Active')`);
 for(const id of [f.ownerId,'synthetic-unrelated-worker']) await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot,actor_id)
 values ($1,'org-default','legal-default','2020-01-01','Active','{"reason":"Synthetic private lifecycle history"}',$2)`,[id,identities.manager.id]);
 await withCommercialApi({databaseUrl,identities},async({request})=>{
  for(const prefix of ['/api','/api/v1']) {
   for(const route of ['/context','/profile','/legal-entities','/legal-entities/legal-default','/terminology']) {
    for(const query of ['asOf=not-a-date','asOf=2026-02-30','asOf=2026-01-01&asOf=2026-01-02','asOf%5Bday%5D=2026-01-01','asOf=']) {
     const r=await request(`${prefix}/organization-setup${route}?${query}`);
     assert.equal(r.status,400,`${route} ${query}: ${JSON.stringify(r.body)}`);
    }
   }
   for(const endpoint of ['history','dependencies']) {
    assert.equal((await request(`${prefix}/organization-setup/workers/${f.ownerId}/${endpoint}`,{identity:identities.reader})).status,200);
    assert.equal((await request(`${prefix}/organization-setup/workers/synthetic-unrelated-worker/${endpoint}`,{identity:identities.reader})).status,404);
    assert.equal((await request(`${prefix}/organization-setup/workers/synthetic-unrelated-worker/${endpoint}`,{identity:identities.denied})).status,404);
    assert.equal((await request(`${prefix}/organization-setup/workers/${f.foreignOwnerId}/${endpoint}`,{identity:identities.manager})).status,404);
    assert.equal((await request(`${prefix}/organization-setup/workers/synthetic-unrelated-worker/${endpoint}`,{identity:identities.manager})).status,200);
   }
   const healthy=await request(`${prefix}/organization-setup/context`);
   assert.equal(healthy.status,200,'API remains available after malformed requests');
  }
  await pool.query("update employees set reporting_manager_id=$1 where id='synthetic-unrelated-worker'",[identities.denied.employeeRecordId]);
  for(const endpoint of ['history','dependencies']) assert.equal((await request(`/api/organization-setup/workers/synthetic-unrelated-worker/${endpoint}`,{identity:identities.denied})).status,200,'TeamLead can read a currently visible direct report');
  await pool.query("update role_permissions set enabled=false where role_name='Employee' and permission_key='employees.view'");
  for(const endpoint of ['history','dependencies']) assert.equal((await request(`/api/organization-setup/workers/${f.ownerId}/${endpoint}`,{identity:identities.reader})).status,403,'Own scope does not bypass required permission');
  await pool.query('alter table terminology_versions rename to synthetic_unavailable_terminology');
  try {
   const failed=await request('/api/organization-setup/terminology');
   assert.equal(failed.status,500);
   assert.equal(failed.body.code,'ORGANIZATION_SETUP_FAILED');
   assert.equal(JSON.stringify(failed.body).includes('synthetic_unavailable'),false,'Internal database details stay private');
   assert.equal((await request('/api/organization-setup/context')).status,200,'Unexpected asynchronous query failure does not kill the API');
  } finally { await pool.query('alter table synthetic_unavailable_terminology rename to terminology_versions'); }
 });
});
console.log('Setup API: malformed dates, async query failure containment, own/direct-report/admin reads, unrelated/cross-scope denial and permission loss passed.');
