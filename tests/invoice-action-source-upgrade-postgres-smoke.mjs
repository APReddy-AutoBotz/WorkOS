import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,copyFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runMigrations} from '../server/migrate.mjs';
import {workApprovalOwner} from '../server/modules/approvals/work-approval-service.mjs';
import {commercialServerDir,commercialFixture as f,withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval} from './support/work-approval-test.mjs';
import {grantAmendmentPermissions,createAmendmentHierarchy} from './support/commercial-amendments-test.mjs';
import {shiftCapacityDate} from '../shared/worker-capacity.mjs';
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
await withCommercialDatabase(async ({pool,databaseUrl})=>{
 const directory=await mkdtemp(join(tmpdir(),'invoice-action-source-upgrade-'));
 try {
  await mkdir(join(directory,'migrations'));
  await copyFile(join(commercialServerDir,'schema.sql'),join(directory,'schema.sql'));
  for(const name of await readdir(join(commercialServerDir,'migrations'))) {
   if(/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name)&&Number(name.slice(0,3))<=95) await copyFile(join(commercialServerDir,'migrations',name),join(directory,'migrations',name));
  }
  await runMigrations({pool,rootDir:directory,logger:{log(){}}});
  const fx=await seedWorkApproval(pool),ids=fx.identities;await grantAmendmentPermissions(pool);
  for(const permission of ['commercial.milestone_billing.view','commercial.tm_billing.view','commercial.invoice_drafts.view','commercial.invoice_drafts.prepare','commercial.invoice_drafts.own','commercial.invoice_approval.manage','commercial.contracts.manage']) {
   await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true) on conflict(role_name,permission_key) do update set enabled=true",[permission]);
  }
  await withCommercialApi({databaseUrl,identities:ids},async ({request})=>{
   const end=shiftCapacityDate(fx.today,30),roots=await createAmendmentHierarchy(request,'SYN-SOURCE-UPGRADE',{contract:{model:'milestone',startsOn:fx.today,endsOn:end,effectiveFrom:fx.today,currency:'USD'},engagement:{startsOn:fx.today,endsOn:end,currency:'USD'},project:{startsOn:fx.today,endsOn:end}});
   // Compute only the context fence from known fixture identity. Authentication
   // still uses the real server; no new-schema inbox is called before upgrade.
   const ownerKey=workApprovalOwner({user:{sub:ids.requester.id,username:ids.requester.username,activeRole:'Admin'},organizationScope:f});
   const route='/api/v1/invoice-action-notices';
   const draft=ok(await request('/api/v1/invoice-drafts/batches',{method:'POST',identity:ids.requester,body:{expectedOwnerKey:ownerKey,requestId:randomUUID(),definition:{clientId:roots.contract.clientId,contractId:roots.contract.id,engagementId:roots.engagement.id,currency:'USD',periodStart:fx.today,periodEnd:fx.today,periodBasis:'ELIGIBLE_DATE',ownerUserId:ids.manager.id,ownerRole:'Admin'},reason:'Synthetic retained milestone draft'}}),201).batch;
   ok(await request(route+'/templates',{method:'POST',identity:ids.requester,body:{expectedOwnerKey:ownerKey,requestId:randomUUID(),expectedLatestId:null,effectiveFrom:fx.today,definition:{entityType:'InvoiceBatch',engagementId:roots.engagement.id,locale:'en-US',key:'invoice_batch.action_required',subject:'Inspect {{sourceRef}}',body:'Review {{sourceRef}}'},reason:'Synthetic retained template'}}),201);
   const source=ok(await request(route+'/sources/'+draft.id,{identity:ids.requester})).source;
   const command={expectedOwnerKey:ownerKey,requestId:randomUUID(),batchId:draft.id,templateId:source.templateId,lineageHash:source.lineageHash,reason:'Synthetic retained notice'};
   const event=ok(await request(route+'/assessments',{identity:ids.requester,method:'POST',body:command}),201).event;
   const tables=['users','user_roles','role_permissions','user_permission_grants','invoice_action_templates','invoice_action_events','invoice_action_recipients','invoice_action_deliveries','invoice_action_reads','invoice_draft_batches','invoice_draft_lines','invoice_draft_occupancies','audit_logs'];
   const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await pool.query('select to_jsonb(t) v from '+table+' t order by to_jsonb(t)::text')).rows])));
   const before=await snapshot();assert.equal(before.invoice_action_events.length,1);assert.equal(before.invoice_action_recipients.length,2);
   assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['096_wos06_invoice_action_source_authority','097_wos07_project_contribution_evidence']);
   assert.deepEqual(await snapshot(),before,'upgrade preserves populated invoice, identity and notice history');
   assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);assert.deepEqual(await snapshot(),before);
   assert.equal(ok(await request(route+'/receipts/'+command.requestId,{identity:ids.requester})).event.id,event.id);
   assert.equal(ok(await request(route+'/assessments',{identity:ids.requester,method:'POST',body:command})).replayed,true);
   assert.ok(ok(await request('/api/v1/work-approvals/inbox')).notifications.some(n=>n.eventId===event.id));
   assert.deepEqual(await snapshot(),before,'retained receipt, replay and inbox reads remain neutral');
   console.log('Populated 095 to 096 upgrade and replay preserve immutable invoice notices, recipients, identities and audit; authorized history remains visible.');
  });
 } finally {await rm(directory,{recursive:true,force:true});}
});
