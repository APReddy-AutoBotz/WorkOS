import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedWorkApproval,readApprovalOwner} from './support/work-approval-test.mjs';
import {grantAmendmentPermissions,createAmendmentHierarchy} from './support/commercial-amendments-test.mjs';
import {shiftCapacityDate} from '../shared/worker-capacity.mjs';
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
await withCommercialDatabase(async ({pool,databaseUrl})=>{
 await migrateCommercialDatabase(pool);const fx=await seedWorkApproval(pool),ids=fx.identities;
 await grantAmendmentPermissions(pool);
 const generic=['commercial.contracts.view','commercial.tm_billing.view','commercial.invoice_drafts.view','commercial.invoice_drafts.prepare','employees.view','notifications.view'];
 for(const [role,permissions] of [['Admin',[...generic,'commercial.milestone_billing.view','commercial.invoice_drafts.own','commercial.invoice_approval.manage','commercial.contracts.manage']],['TeamLead',generic]]) {
  for(const permission of permissions)await pool.query("insert into role_permissions(role_name,permission_key,enabled) values($1,$2,true) on conflict(role_name,permission_key) do update set enabled=true",[role,permission]);
 }
 await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('TeamLead','commercial.milestone_billing.view',false) on conflict(role_name,permission_key) do update set enabled=false");
 await withCommercialApi({databaseUrl,identities:ids,onServerError:s=>process.stderr.write(s)},async ({request})=>{
  const end=shiftCapacityDate(fx.today,30),roots=await createAmendmentHierarchy(request,'SYN-ACTION-SCOPE',{contract:{model:'milestone',startsOn:fx.today,endsOn:end,effectiveFrom:fx.today,currency:'USD'},engagement:{startsOn:fx.today,endsOn:end,currency:'USD'},project:{startsOn:fx.today,endsOn:end}});
  const ownerKey=await readApprovalOwner(request,ids.requester),drafts='/api/v1/invoice-drafts',route='/api/v1/invoice-action-notices';
  const draft=ok(await request(drafts+'/batches',{method:'POST',identity:ids.requester,body:{expectedOwnerKey:ownerKey,requestId:randomUUID(),definition:{clientId:roots.contract.clientId,contractId:roots.contract.id,engagementId:roots.engagement.id,currency:'USD',periodStart:fx.today,periodEnd:fx.today,periodBasis:'ELIGIBLE_DATE',ownerUserId:ids.manager.id,ownerRole:'Admin'},reason:'Synthetic milestone empty draft'}}),201).batch;
  assert.equal(draft.sourceType,'MILESTONE_ACCEPTANCE');
  const templateCommand={expectedOwnerKey:ownerKey,requestId:randomUUID(),expectedLatestId:null,effectiveFrom:fx.today,definition:{entityType:'InvoiceBatch',engagementId:roots.engagement.id,locale:'en-US',key:'invoice_batch.action_required',subject:'Inspect {{sourceRef}}',body:'Review {{sourceRef}}'},reason:'Synthetic explicit template'};
  const template=ok(await request(route+'/templates',{method:'POST',identity:ids.requester,body:templateCommand}),201).template;
  assert.equal((await request(drafts+'/batches/'+draft.id,{identity:ids.denied})).status,403,'primary loader enforces milestone permission');
  assert.equal((await request(route+'/sources/'+draft.id,{identity:ids.denied})).status,403);
  const allowedSource=ok(await request(route+'/sources/'+draft.id));
  const candidateKey=await readApprovalOwner(request,ids.denied);
  const command={expectedOwnerKey:candidateKey,requestId:randomUUID(),batchId:draft.id,templateId:allowedSource.source.templateId,lineageHash:allowedSource.source.lineageHash,reason:'Synthetic scoped permission validation'};
  assert.equal((await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).status,403);
  for(const table of ['invoice_action_events','invoice_action_recipients','invoice_action_deliveries']) assert.equal((await pool.query('select count(*)::int n from '+table)).rows[0].n,0,'denied assessment leaves no partial state');
  await pool.query("update role_permissions set enabled=true where role_name='TeamLead' and permission_key='commercial.milestone_billing.view'");
  const alternate=ok(await request(route+'/sources/'+draft.id,{identity:ids.denied}));
  assert.equal(alternate.source.batchId,draft.id);assert.equal(alternate.source.lineCount,0);
  // Revoke only the preparer's source permission inside the transaction after
  // event insertion. Generic authority and the independent owner stay valid.
  for(const who of [ids.manager,ids.requester]) await pool.query("insert into user_permission_grants(user_id,permission_key) values($1,'commercial.milestone_billing.view') on conflict do nothing",[who.id]);
  await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.milestone_billing.view'");
  await pool.query(`create function synthetic_action_preparer_loss() returns trigger language plpgsql as $$begin
    delete from user_permission_grants where user_id=(select preparer_user_id from invoice_draft_batches where id=new.batch_id)
      and permission_key='commercial.milestone_billing.view';return new;end$$;
    create trigger synthetic_action_preparer_loss after insert on invoice_action_events for each row execute function synthetic_action_preparer_loss()`);
  assert.equal((await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).status,403,'deferred source check rejects preparer permission loss before commit');
  assert.equal((await pool.query('select count(*)::int n from invoice_action_events')).rows[0].n,0);
  assert.equal((await pool.query("select count(*)::int n from user_permission_grants where user_id=$1 and permission_key='commercial.milestone_billing.view'",[ids.requester.id])).rows[0].n,1,'failed command rolls back permission mutation as well');
  await pool.query('drop trigger synthetic_action_preparer_loss on invoice_action_events;drop function synthetic_action_preparer_loss()');
  await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.milestone_billing.view'");
  await pool.query("delete from user_permission_grants where user_id=any($1::uuid[]) and permission_key='commercial.milestone_billing.view'",[[ids.manager.id,ids.requester.id]]);
  await pool.query(`create function synthetic_action_actor_loss() returns trigger language plpgsql as $$begin
    update role_permissions set enabled=false where role_name='TeamLead' and permission_key='commercial.milestone_billing.view';return new;end$$;
    create trigger synthetic_action_actor_loss after insert on invoice_action_events for each row execute function synthetic_action_actor_loss()`);
  assert.equal((await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).status,403,'new deferred guard rejects initiating actor source permission loss');
  assert.equal((await pool.query('select count(*)::int n from invoice_action_events')).rows[0].n,0);
  await pool.query('drop trigger synthetic_action_actor_loss on invoice_action_events;drop function synthetic_action_actor_loss()');
  await pool.query(`create function synthetic_action_owner_loss() returns trigger language plpgsql as $$begin
    update users set status='Inactive' where id=(select owner_user_id from invoice_draft_batches where id=new.batch_id);return new;end$$;
    create trigger synthetic_action_owner_loss after insert on invoice_action_events for each row execute function synthetic_action_owner_loss()`);
  assert.equal((await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).status,403,'owner loss refuses the entire milestone notice');
  assert.equal((await pool.query('select status from users where id=$1',[ids.manager.id])).rows[0].status,'Active');
  assert.equal((await pool.query('select count(*)::int n from invoice_action_events')).rows[0].n,0);
  await pool.query('drop trigger synthetic_action_owner_loss on invoice_action_events;drop function synthetic_action_owner_loss()');
  const event=ok(await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command}),201).event;
  assert.equal(event.batchId,draft.id);
  assert.equal((await pool.query('select count(*)::int n from invoice_action_recipients where event_id=$1',[event.id])).rows[0].n,2);
  assert.equal(ok(await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).replayed,true);
  ok(await request(route+'/receipts/'+command.requestId,{identity:ids.denied}));
  await pool.query("update role_permissions set enabled=false where role_name='TeamLead' and permission_key='commercial.milestone_billing.view'");
  assert.equal((await request(route+'/receipts/'+command.requestId,{identity:ids.denied})).status,403);
  assert.equal((await request(route+'/assessments',{identity:ids.denied,method:'POST',body:command})).status,403,'exact replay needs current source permission');
  const sql=await pool.connect();
  try {
    await sql.query('begin');
    const eventId=randomUUID(),operationId=randomUUID();
    await sql.query("select set_config('workos.invoice_action_context',$1,true)",[JSON.stringify({eventId,batchId:draft.id,templateId:command.templateId,organizationId:'org-default',legalEntityId:'legal-default',actorId:ids.denied.id,activeRole:'TeamLead',operationId})]);
    await assert.rejects(sql.query(`insert into invoice_action_events select (jsonb_populate_record(null::invoice_action_events,
      to_jsonb(e)||jsonb_build_object('id',$1::text,'request_id',$2::text,'operation_id',$3::text))).*
      from invoice_action_events e where id=$4`,[eventId,randomUUID(),operationId,event.id]),e=>e.code==='IAN01','SQL insert cannot bypass source visibility with an otherwise exact command context');
  } finally {await sql.query('rollback');sql.release();}
  const inbox='/api/v1/work-approvals/inbox';
  const initialInbox=ok(await request(inbox));
  const notice=initialInbox.notifications.find(n=>n.kind==='invoice-action'&&n.eventId===event.id);assert.ok(notice);
  ok(await request(inbox+'/'+notice.id+'/read',{method:'POST',body:{expectedOwnerKey:initialInbox.ownerKey}}));
  await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.milestone_billing.view'");
  const hiddenInbox=ok(await request(inbox));assert.ok(!hiddenInbox.notifications.some(n=>n.eventId===event.id));
  assert.equal((await request(inbox+'/'+notice.id+'/read',{method:'POST',body:{expectedOwnerKey:hiddenInbox.ownerKey}})).status,404,'already-read acknowledgement replay cannot expose revoked source');
  assert.equal((await request(route+'/templates?engagementId='+roots.engagement.id)).status,403);
  assert.equal((await request(route+'/template-receipts/'+templateCommand.requestId,{identity:ids.requester})).status,403);
  for(const body of [templateCommand,{...templateCommand,requestId:randomUUID(),expectedLatestId:template.id}]) {
    assert.equal((await request(route+'/templates',{identity:ids.requester,method:'POST',body})).status,403,'template creation and exact replay require current source visibility');
  }
  const direct=await pool.connect();
  try {
    await direct.query('begin');
    await direct.query("select set_config('workos.invoice_action_read_context',$1,true)",[JSON.stringify({actorId:ids.requester.id,activeRole:'Admin',organizationId:'org-default',legalEntityId:'legal-default'})]);
    const recipient=(await direct.query('select id from invoice_action_recipients where event_id=$1 and user_id=$2',[event.id,ids.requester.id])).rows[0];
    await assert.rejects(direct.query('insert into invoice_action_reads(recipient_id,user_id) values($1,$2)',[recipient.id,ids.requester.id]),e=>e.code==='IAN01','direct SQL read acknowledgement needs current source permission');
  } finally {await direct.query('rollback');direct.release();}
  await pool.query("update role_permissions set enabled=true where role_name='Admin' and permission_key='commercial.milestone_billing.view'");
  await pool.query(`create function synthetic_action_template_loss() returns trigger language plpgsql as $$begin
    update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.milestone_billing.view';return new;end$$;
    create trigger synthetic_action_template_loss after insert on invoice_action_templates for each row execute function synthetic_action_template_loss()`);
  assert.equal((await request(route+'/templates',{identity:ids.requester,method:'POST',body:{...templateCommand,requestId:randomUUID(),expectedLatestId:template.id}})).status,403,'template source authority remains required through commit');
  assert.equal((await pool.query('select count(*)::int n from invoice_action_templates')).rows[0].n,1);
  await pool.query('drop trigger synthetic_action_template_loss on invoice_action_templates;drop function synthetic_action_template_loss()');
  console.log('Milestone action source authority: primary and alternate source denial, authorized assessment and exact required recipients passed.');
 });
});

