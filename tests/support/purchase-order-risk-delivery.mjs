import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {processPurchaseOrderRisks} from '../../server/modules/commercial-drafting/purchase-order-risk-worker.mjs';

export async function verifyPurchaseOrderNotices({pool,request,ids,roots,orderId,scope,today,work,open}) {
  const assignment='/purchase-orders/'+orderId+'/risk-assignments', policy='/purchase-orders/'+orderId+'/risk-policy';
  const post=(path,body)=>request(path,{method:'POST',identity:ids.requester,body});
  const state=()=>pool.query(`select e.id,d.failure,d.attempts,d.delivered_at from po_risk_events e join po_risk_dispatch d on d.event_id=e.id
    where e.purchase_order_id=$1 and e.kind='threshold'`,[orderId]).then(r=>r.rows[0]);
  await Promise.all([processPurchaseOrderRisks(pool),processPurchaseOrderRisks(pool)]);
  const unused=await pool.query(`select p.id,p.ends_on::text from commercial_purchase_orders p
    where p.number='SYN-PO-79' and not exists(select from commercial_po_line_commitments c where c.purchase_order_id=p.id)`);
  assert.equal(unused.rowCount,1);
  for (const [days,expected] of [[0,0],[1,1]]) {
    const expired=await pool.query('select * from po_expiry_risk_sources($1::date+$2::int) where purchase_order_id=$3',[unused.rows[0].ends_on,days,unused.rows[0].id]);
    assert.equal(expired.rowCount,expected);
  }
  for (const [before,after,kinds] of [[100,0,['exhaustion','threshold']],[20,0,['exhaustion']],[19,18,[]]]) {
    const signals=await pool.query('select kind from po_commitment_risk_kinds(100,80,$1,$2) order by kind',[before,after]);
    assert.deepEqual(signals.rows.map(x=>x.kind),kinds);
  }
  const pending=await state();
  assert.equal(pending.failure,'POLICY_UNAVAILABLE');
  assert.equal(pending.attempts,1);
  assert.equal((await request(policy,{identity:ids.requester})).status,403);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin','commercial.po_risk.configure',true) on conflict(role_name,permission_key) do update set enabled=true");
  const saved=await post(assignment,{expectedVersion:0,engagementIds:[roots.engagement.id],reason:'Route the shared order explicitly'});
  assert.equal(saved.status,201,JSON.stringify(saved.body));
  // Use the employee account already linked to the engagement owner, if present.
  let owner=(await pool.query('select id,username from users where employee_record_id=$1',[scope.ownerId])).rows[0];
  if (!owner) {
    owner={id:randomUUID(),username:'synthetic-order-risk-owner'};
    await pool.query("insert into users(id,username,email,status,employee_record_id) values($1,$2,$3,'Active',$4)",[owner.id,owner.username,owner.username+'@example.test',scope.ownerId]);
  }
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Admin' on conflict do nothing",[owner.id]);
  await pool.query('insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active) values($1,$2,$3,true) on conflict do nothing',[owner.id,scope.organizationId,scope.legalEntityId]);
  const named={userId:owner.id,role:'Admin'}, command={expectedVersion:0,effectiveFrom:today,manager:named,finance:named,
    locale:'en-GB',title:'Review this purchase order',body:'A released purchase order needs attention.',reason:'Synthetic scoped mandatory recipients'};
  const configured=await post(policy,command);
  assert.equal(configured.status,201,JSON.stringify(configured.body));
  assert.deepEqual((await post(policy,command)).body,configured.body);
  const clear=await post(assignment,{expectedVersion:1,engagementIds:[],reason:'Review removed engagement assignment'});
  assert.equal(clear.status,201);
  const retry=async()=>{await pool.query('update po_risk_dispatch set next_attempt=now() where event_id=$1',[pending.id]);await processPurchaseOrderRisks(pool);};
  await retry();
  assert.equal((await state()).failure,'RECIPIENTS_UNAVAILABLE');
  assert.equal((await pool.query('select * from po_risk_inbox where event_id=$1',[pending.id])).rowCount,0);
  assert.equal((await post(assignment,{expectedVersion:2,engagementIds:[roots.engagement.id],reason:'Confirm the current engagement'})).status,201);
  await retry();
  assert.equal((await state()).attempts,3);
  assert((await state()).delivered_at);
  const {rows:[receipt]}=await pool.query('select id,user_id,reasons from po_risk_inbox where event_id=$1',[pending.id]);
  assert.equal(receipt.user_id,owner.id);
  assert.deepEqual(receipt.reasons,['commercial_manager','engagement_owner','finance_billing_owner']);
  const identity={...owner,role:'Admin'},inbox=await request(work+'/inbox',{identity});
  assert.equal(inbox.status,200,JSON.stringify(inbox.body));
  const viewer=await open(identity);
  const panel=viewer.p.getByRole('region',{name:'Canonical work approval notifications'});
  const loadPage=viewer.p.waitForResponse(r=>r.url().includes(work+'/inbox') && r.request().method()==='GET');
  await panel.getByRole('button',{name:'Load my governed notifications'}).click();
  assert.equal((await loadPage).status(),200);
  const article=panel.getByRole('article',{name:'Governed notification '+receipt.id});
  while (await article.count()===0 && await panel.getByRole('button',{name:'More governed notifications'}).count()) {
    const more=viewer.p.waitForResponse(r=>r.url().includes(work+'/inbox?'));
    await panel.getByRole('button',{name:'More governed notifications'}).click();
    await more;
    await panel.getByRole('button',{name:'Load my governed notifications'}).waitFor();
  }
  await article.getByText('Purchase order '+orderId+' · threshold').waitFor();
  const acknowledging=viewer.p.waitForResponse(r=>r.url().endsWith('/inbox/'+receipt.id+'/read'));
  await article.getByRole('button',{name:'Mark governed notification read '+receipt.id}).click();
  assert.equal((await acknowledging).status(),200);
  const read=await request(work+'/inbox/'+receipt.id+'/read',{identity,method:'POST',body:{expectedOwnerKey:inbox.body.ownerKey}});
  assert.equal(read.status,200,JSON.stringify(read.body));
  assert.equal(read.body.notification.orderId,orderId);
  assert.equal(read.body.notification.metric,'threshold');
  assert(read.body.notification.readAt);
  const status=await request('/purchase-orders/'+orderId+'/risk-deliveries',{identity:ids.requester});
  assert.equal(status.status,200);
  assert.equal(status.body.events.find(e=>e.id===pending.id).history.length,3);
  const unrelated=await request(work+'/inbox/'+receipt.id+'/read',{identity:ids.second,method:'POST',
    body:{expectedOwnerKey:(await request(work+'/inbox',{identity:ids.second})).body.ownerKey}});
  assert.equal(unrelated.status,404);
  await processPurchaseOrderRisks(pool);
  assert.equal((await state()).attempts,3);
  assert.deepEqual((await pool.query('select failure from po_risk_delivery_attempts where event_id=$1 order by attempt',[pending.id])).rows.map(x=>x.failure),
    ['POLICY_UNAVAILABLE','RECIPIENTS_UNAVAILABLE',null]);
}
