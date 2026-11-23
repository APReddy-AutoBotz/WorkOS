import {processRiskTransaction} from './fixed-fee-risk-worker.mjs';
import {randomUUID} from 'node:crypto';

// Discover verified order events independently of invoice processing. Concurrent
// workers may observe the same source. The database admits one event per source.
export async function collectPurchaseOrderRisks(pool) {
  const result=await pool.query(`
    with created as (insert into po_risk_events(organization_id,legal_entity_id,purchase_order_id,kind,source_id,risk_date,available_before,available_after)
    select s.organization_id,s.legal_entity_id,s.purchase_order_id,s.kind,s.source_id,s.risk_date,s.available_before,s.available_after
    from po_risk_sources s
    where not exists(select from po_risk_events e where (e.purchase_order_id,e.kind,e.source_id)=(s.purchase_order_id,s.kind,s.source_id))
    order by s.risk_date,s.purchase_order_id,s.kind,s.source_id limit 100 on conflict(purchase_order_id,kind,source_id) do nothing returning id) insert into po_risk_dispatch(event_id) select id from created`);
  return result.rowCount;
}

async function dispatchNext(client) {
  const {rows:[event]}=await client.query(`select e.* from po_risk_dispatch d join po_risk_events e on e.id=d.event_id
    where d.delivered_at is null and d.next_attempt<=now() order by d.next_attempt,d.event_id limit 1 for update of d skip locked`);
  if (!event) return false;
  const scope=[event.organization_id,event.legal_entity_id,event.purchase_order_id];
  let failure='DELIVERY_UNAVAILABLE';
  await client.query('savepoint risk_delivery');
  try {
    const {rows:[policy]}=await client.query(`select * from po_risk_notice_policies where organization_id=$1
      and legal_entity_id=$2 and purchase_order_id=$3 and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1`,scope);
    if (!policy) {failure='POLICY_UNAVAILABLE';throw Error();}
    const recipients=await client.query(`select user_id,array_agg(reason order by reason) reasons from po_risk_recipients($1,$2,$3,$4,$5,$6,$7)
      group by user_id order by user_id`,[...scope,policy.manager_id,policy.manager_role,policy.finance_id,policy.finance_role]);
    if (recipients.rowCount===0) {failure='RECIPIENTS_UNAVAILABLE';throw Error();}
    for (const recipient of recipients.rows) {
      await client.query('insert into po_risk_inbox(id,event_id,user_id,reasons) values($1,$2,$3,$4)',
        [randomUUID(),event.id,recipient.user_id,recipient.reasons]);
    }
    await client.query('update po_risk_dispatch set attempts=attempts+1,policy_id=$2,delivered_at=clock_timestamp(),failure=null where event_id=$1',
      [event.id,policy.id]);
    // The receipt-set constraint requires the final dispatch row and every recipient.
    await client.query('set constraints all immediate');
  } catch {
    await client.query('rollback to savepoint risk_delivery');
    await client.query(`update po_risk_dispatch set attempts=attempts+1,failure=$2,
      next_attempt=now()+interval '1 minute'*least(60,power(2,least(6,attempts))) where event_id=$1`,[event.id,failure]);
  }
  return true;
}

export async function processPurchaseOrderRisks(pool) {
  await collectPurchaseOrderRisks(pool);
  for (let i=0;i<10;i++) {
    if (!await processRiskTransaction(pool,dispatchNext)) break;
  }
}

export function startPurchaseOrderRiskWorker(pool,server) {
  let running=false;
  async function tick() {
    if (running) return;
    running=true;
    try {await processPurchaseOrderRisks(pool);}
    catch {console.error('Purchase-order risk processing unavailable.');}
    finally {running=false;}
  }
  const timer=setInterval(tick,30_000);
  timer.unref();
  server.once('close',()=>clearInterval(timer));
}
