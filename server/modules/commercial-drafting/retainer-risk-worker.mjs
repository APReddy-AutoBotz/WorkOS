import {randomUUID} from 'node:crypto';
import {evaluateRetainerRisks} from './retainer-risk-register.mjs';
import {processRiskTransaction} from './fixed-fee-risk-worker.mjs';

async function evaluateNext(client) {
  const {rows:[v]}=await client.query(`select v.id,v.organization_id,v.legal_entity_id,v.contract_id,c.number,v.version,
    v.retainer_periods,v.retainer_capacity_policy,v.effective_from::text,v.starts_on::text,v.ends_on::text,(now() at time zone 'UTC')::date::text today
    from retainer_risk_scans s join commercial_contract_versions v on v.id=s.version_id join commercial_contracts c on c.id=v.contract_id
    where s.next_check<=now() order by s.next_check,s.version_id limit 1 for update of s skip locked`);
  if (!v) return false;
  await client.query('savepoint retainer_evaluation');
  try {
    const findings=await evaluateRetainerRisks(client,[v.organization_id,v.legal_entity_id],v,v.today,true);
    const {rows:active}=await client.query('select starts_on::text,kind from retainer_risk_events where version_id=$1 and id not in (select event_id from retainer_risk_resolutions where version_id=$1)',[v.id]);
    for (const row of active) {
      if (findings.some(f=>f.startsOn===row.starts_on && f.kind==='assessed') &&
          !findings.some(f=>f.startsOn===row.starts_on && f.kind===row.kind)) {
        await client.query(`insert into retainer_risk_resolutions(event_id,version_id)
          select e.id,e.version_id from retainer_risk_events e where e.version_id=$1 and e.starts_on=$2 and e.kind=$3
          and not exists(select from retainer_risk_resolutions r where r.event_id=e.id)`,[v.id,row.starts_on,row.kind]);
      }
    }
    for (const f of findings) {
      if (!['overconsumption','expiry'].includes(f.kind) || active.some(a=>a.starts_on===f.startsOn && a.kind===f.kind)) continue;
      const id=randomUUID();
      await client.query("select set_config('workos.retainer_risk_observation',$1,true)",[id]);
      await client.query(`with event as (insert into retainer_risk_events(id,organization_id,legal_entity_id,version_id,starts_on,ends_on,kind,hours,included_hours,carried_in,consumed,carried_out)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id) insert into retainer_risk_dispatch(event_id) select id from event`,
        [id,v.organization_id,v.legal_entity_id,v.id,f.startsOn,f.endsOn,f.kind,f.hours,f.evidence.included,f.evidence.carriedIn,f.evidence.consumed,f.evidence.carriedOut]);
    }
    await client.query("update retainer_risk_scans set next_check=now()+interval '5 minutes',failure=null where version_id=$1",[v.id]);
    await client.query('set constraints all immediate');
  } catch {
    await client.query('rollback to savepoint retainer_evaluation');
    await client.query("update retainer_risk_scans set next_check=now()+interval '1 minute',failure='EVALUATION_UNAVAILABLE' where version_id=$1",[v.id]);
  }
  return true;
}

async function dispatchNext(client) {
  const {rows:[event]}=await client.query(`select e.* from retainer_risk_dispatch d join retainer_risk_events e on e.id=d.event_id
    where d.delivered_at is null and d.next_attempt<=now() order by d.next_attempt,d.event_id limit 1 for update of d skip locked`);
  if (!event) return false;
  const scope=[event.organization_id,event.legal_entity_id,event.version_id];
  let failure='DELIVERY_UNAVAILABLE';
  await client.query('savepoint risk_delivery');
  try {
    const {rows:[policy]}=await client.query(`select * from retainer_risk_notice_policies where organization_id=$1
      and legal_entity_id=$2 and version_id=$3 and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1`,scope);
    if (!policy) {failure='POLICY_UNAVAILABLE';throw Error();}
    const recipients=await client.query(`select user_id,array_agg(reason order by reason) reasons from retainer_risk_recipients($1,$2,$3,$4,$5,$6,$7)
      group by user_id order by user_id`,[...scope,policy.manager_id,policy.manager_role,policy.finance_id,policy.finance_role]);
    if (recipients.rowCount===0) {failure='RECIPIENTS_UNAVAILABLE';throw Error();}
    for (const recipient of recipients.rows) {
      await client.query('insert into retainer_risk_inbox(id,event_id,user_id,reasons) values($1,$2,$3,$4)',
        [randomUUID(),event.id,recipient.user_id,recipient.reasons]);
    }
    await client.query('update retainer_risk_dispatch set attempts=attempts+1,policy_id=$2,delivered_at=clock_timestamp(),failure=null where event_id=$1',
      [event.id,policy.id]);
    // The receipt-set constraint requires the final dispatch row and every recipient.
    await client.query('set constraints all immediate');
  } catch {
    await client.query('rollback to savepoint risk_delivery');
    await client.query(`update retainer_risk_dispatch set attempts=attempts+1,failure=$2,
      next_attempt=now()+interval '1 minute'*least(60,power(2,least(6,attempts))) where event_id=$1`,[event.id,failure]);
  }
  return true;
}

export async function processRetainerRisks(pool) {
  await pool.query(`insert into retainer_risk_scans(version_id)
    select v.id from commercial_contract_versions v where v.model='retainer' and v.retainer_capacity_policy is not null
      and v.effective_from<=(now() at time zone 'UTC')::date and not exists(select from retainer_risk_scans s where s.version_id=v.id)
      and (exists(select from commercial_lifecycle_events l where l.organization_id=v.organization_id and l.legal_entity_id=v.legal_entity_id
        and l.entity_type='Contract' and l.entity_id=v.contract_id and l.state='Active' and l.contract_version_id=v.id and l.effective_on<=(now() at time zone 'UTC')::date)
        or exists(select from commercial_amendments a where a.organization_id=v.organization_id and a.legal_entity_id=v.legal_entity_id
          and a.entity_type='Contract' and a.entity_id=v.contract_id and a.contract_version_id=v.id and a.effective_on<=(now() at time zone 'UTC')::date))
    order by v.id limit 100 on conflict do nothing`);
  for (let i=0;i<10;i++) {
    const scanned=await processRiskTransaction(pool,evaluateNext);
    const dispatched=await processRiskTransaction(pool,dispatchNext);
    if (!scanned && !dispatched) break;
  }
}

export function startRetainerRiskWorker(pool,server) {
  let running=false;
  async function tick() {
    if (running) return;
    running=true;
    try {await processRetainerRisks(pool);}
    catch {console.error('Retainer risk processing unavailable.');}
    finally {running=false;}
  }
  const timer=setInterval(tick,30_000);
  timer.unref();
  server.once('close',()=>clearInterval(timer));
}
