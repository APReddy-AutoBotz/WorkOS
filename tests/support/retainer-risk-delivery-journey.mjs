import assert from 'node:assert/strict';
import {processRetainerRisks} from '../../server/modules/commercial-drafting/retainer-risk-worker.mjs';

export async function verifyRetainerRiskDelivery({pool,request,manager,finance,contract,versionId,engagement,otherEngagementId,
  siblingInput,createContext,baseUrl}) {
  const prefix='/retainer-versions/'+versionId;
  const assignments=prefix+'/risk-assignments',policy=prefix+'/risk-policy';
  const post=(path,body)=>request(path,{method:'POST',body});
  const grant='commercial.retainer_risk.configure';
  const body={expectedVersion:0,engagementIds:[engagement.id],reason:'Assign the delivery engagement before use'};
  assert.equal((await post(assignments,body)).status,403);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Admin',$1,true),('Admin','notifications.view',true),($2,'notifications.view',true) on conflict(role_name,permission_key) do update set enabled=true",[grant,finance.role]);
  const gaps='/retainer-capacity-risks?view=routing';
  assert((await request(gaps)).body.findings.some(f=>f.versionId===versionId && f.kind==='missing_assignments'));
  const invalid=await post(assignments,{...body,engagementIds:[otherEngagementId]});
  assert.equal(invalid.status,409,JSON.stringify(invalid.body));
  assert.equal((await post(assignments,{...body,engagementIds:[engagement.id,engagement.id]})).status,400);
  assert.equal((await request(assignments,{headers:{'x-legal-entity-id':'other-synthetic-entity'}})).status,403);

  await Promise.all([processRetainerRisks(pool),processRetainerRisks(pool)]);
  const state=async()=>(await pool.query(`select e.id,e.kind,e.hours::text,d.attempts,d.failure,d.delivered_at from retainer_risk_events e
    join retainer_risk_dispatch d on d.event_id=e.id where e.version_id=$1`,[versionId])).rows;
  const [event]=await state();
  assert(event,JSON.stringify((await pool.query('select failure from retainer_risk_scans where version_id=$1',[versionId])).rows));
  assert.equal(event.kind,'expiry');
  assert.equal(event.hours,'40.125');
  assert.equal(event.failure,'POLICY_UNAVAILABLE');
  assert.equal(event.attempts,1);
  const sibling=await post('/engagements',siblingInput);
  assert.equal(sibling.status,201,JSON.stringify(sibling.body));
  const viewer=await createContext(manager,['commercial.contracts.view','commercial.contracts.manage','employees.view','reports.view_utilization',grant]);
  await viewer.page.goto(baseUrl+'/tests/fixtures/commercial-drafting.html?live=1');
  await viewer.page.getByRole('button',{name:'Inspect '+contract.number,exact:true}).click();
  const edit=viewer.page.getByRole('group',{name:'Retainer version alert assignments'});
  await edit.getByRole('button',{name:'Review alert assignments'}).click();
  await edit.getByText('No engagements assigned for alerts.').waitFor();
  for (const name of [engagement.name,sibling.body.name]) await edit.getByLabel(name,{exact:true}).check();
  await edit.getByLabel('Assignment reason').fill(body.reason);
  await edit.getByRole('button',{name:'Save alert assignments'}).click();
  await edit.getByText('Assignment version 1').waitFor();
  const both=[engagement.id,sibling.body.id].sort();
  const replay=await post(assignments,{...body,engagementIds:both});
  assert.equal(replay.status,201);
  assert.deepEqual(replay.body.assignments.map(a=>[a.engagementId,a.ownerAvailable]),both.map(id=>[id,true]));
  assert.equal((await post(assignments,body)).status,409);
  assert(!(await request(gaps)).body.findings.some(f=>f.versionId===versionId));
  const config=viewer.page.getByRole('region',{name:'Retainer risk recipients'});
  await config.getByRole('button',{name:'Review retainer risk recipients'}).click();
  for (const [label,value] of [['Commercial manager user ID',manager.id],['Commercial manager role',manager.role],
    ['Finance or billing owner user ID',manager.id],['Finance or billing owner role',manager.role],['Template locale','en-GB'],
    ['Notification title','Review expired retainer capacity'],['Notification body','Inspect the observed retainer period.'],
    ['Reason for change','Configure mandatory retainer relationships']]) await config.getByLabel(label,{exact:true}).fill(value);
  const saving=viewer.page.waitForResponse(r=>r.url().endsWith(policy) && r.request().method()==='POST');
  await config.getByRole('button',{name:'Save notice policy'}).click();
  const saved=await saving;
  assert.equal(saved.status(),201,await saved.text());
  assert.equal((await post(assignments,{...body,expectedVersion:1,engagementIds:[]})).status,201);
  const retry=async()=>{await pool.query('update retainer_risk_dispatch set next_attempt=now() where event_id=$1',[event.id]);await processRetainerRisks(pool);};
  await retry();
  assert.equal((await state())[0].failure,'RECIPIENTS_UNAVAILABLE');
  assert.equal((await pool.query('select from retainer_risk_inbox where event_id=$1',[event.id])).rowCount,0);
  assert.equal((await post(assignments,{...body,expectedVersion:2,engagementIds:both})).status,201);
  await retry();
  assert((await state())[0].delivered_at);
  const receipts=(await pool.query('select id,user_id,reasons from retainer_risk_inbox where event_id=$1',[event.id])).rows;
  assert.equal(receipts.length,2);
  assert.deepEqual(receipts.find(r=>r.user_id===manager.id).reasons,['commercial_manager','engagement_owner','finance_billing_owner']);
  const ownerReceipt=receipts.find(r=>r.user_id===finance.id);
  assert.deepEqual(ownerReceipt.reasons,['engagement_owner']);
  const inbox='/api/v1/work-approvals/inbox';
  const read=async()=>request(inbox+'/'+ownerReceipt.id+'/read',{method:'POST',identity:finance,
    body:{expectedOwnerKey:(await request(inbox,{identity:finance})).body.ownerKey}});
  const recipient=await createContext(finance,['notifications.view','employees.view']);
  await recipient.page.goto(baseUrl+'/tests/fixtures/commercial-approval-inbox.html');
  const panel=recipient.page.getByRole('region',{name:'Canonical work approval notifications'});
  const loading=recipient.page.waitForResponse(r=>r.url().includes(inbox) && r.request().method()==='GET');
  await panel.getByRole('button',{name:'Load my governed notifications'}).click();
  let page=await loading;
  for (;;) {
    const payload=await page.json();
    if (payload.notifications.some(n=>n.id===ownerReceipt.id)) break;
    assert(payload.nextAfter);
    const more=recipient.page.waitForResponse(r=>r.url().includes(inbox+'?'));
    await panel.getByRole('button',{name:'More governed notifications'}).click();
    page=await more;
  }
  const article=panel.getByRole('article',{name:'Governed notification '+ownerReceipt.id});
  await article.getByText('Retainer version '+versionId+' · 2020-01-01 through 2020-12-31 · expiry').waitFor();
  const acknowledging=recipient.page.waitForResponse(r=>r.url().endsWith(inbox+'/'+ownerReceipt.id+'/read'));
  await article.getByRole('button',{name:'Mark governed notification read '+ownerReceipt.id}).click();
  assert.equal((await acknowledging).status(),200);
  await recipient.context.close();
  const seen=await read();
  assert.equal(seen.status,200,JSON.stringify(seen.body));
  assert.equal(seen.body.notification.versionId,versionId);
  assert.equal(seen.body.notification.kind,'retainer-risk');
  await config.getByRole('button',{name:'Check retainer alert deliveries'}).click();
  await config.getByText(/expiry.*Delivered/).waitFor();
  const status=(await request(prefix+'/risk-deliveries')).body;
  assert.deepEqual(status.events[0].history.map(h=>h.failure),[null,'RECIPIENTS_UNAVAILABLE','POLICY_UNAVAILABLE']);
  assert.equal((await post(assignments,{...body,expectedVersion:3})).status,201);
  assert.equal((await read()).status,404);
  await viewer.context.close();
}
