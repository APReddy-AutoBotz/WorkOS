import {randomUUID} from 'node:crypto';
import {fixedFeeScanHours} from './fixed-fee-effort.mjs';
import {budgetWarningStatus,warningSourceAmendments} from './fixed-fee-risk.mjs';

async function evaluate(client,scan) {
  const scope=[scan.organization_id,scan.legal_entity_id,scan.engagement_id],through=scan.through;
  const {rows:[terms]}=await client.query(`select a.after_value->'terms' terms,e.currency from commercial_engagements e
    join lateral(select after_value from commercial_amendments where organization_id=$1 and legal_entity_id=$2
      and entity_type='Engagement' and entity_id=$3 and effective_on<=$4 order by sequence desc limit 1) a on true
    where e.organization_id=$1 and e.legal_entity_id=$2 and e.id=$3 and e.model='fixed_fee'
      and exists(select from commercial_lifecycle_events where organization_id=$1 and legal_entity_id=$2
        and entity_type='Engagement' and entity_id=$3 and state='Active' and effective_on<=$4)`,[...scope,through]);
  const percent=terms?.terms?.budgetWarningPercent;
  if (!percent || percent==='disabled') return;
  const sources=await warningSourceAmendments(client,scope,through);
  const {budgetHours,laborCostBudget}=terms.terms;
  const hours=budgetHours==null?null:await fixedFeeScanHours(client,scope,through);
  const {rows:[cost]}=await client.query(`select coalesce(sum(amount),0)::text actual,bool_and(currency=$5) matching
    from commercial_fixed_fee_work_costs where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and work_date<=$4`,
    [...scope,through,terms.currency]);
  if (cost.matching===false) throw Error('Inconsistent retained cost currency');
  for (const [metric,budget,actual] of [['effort',budgetHours,hours],['laborCost',laborCostBudget,cost.actual]]) {
    if (budgetWarningStatus(actual,budget,percent,false)!=='reached') continue;
    await client.query(`with created as (insert into fixed_fee_risk_events
      (id,organization_id,legal_entity_id,engagement_id,source_id,metric,through_date,actual,budget,percent)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(organization_id,legal_entity_id,engagement_id,metric,source_id)
      do nothing returning id) insert into fixed_fee_risk_dispatch(event_id) select id from created`,
      [randomUUID(),...scope,sources[metric],metric,through,actual,budget,percent]);
  }
}

async function scanNext(client) {
  const {rows:[scan]}=await client.query(`select *,through_date::text through from fixed_fee_risk_scans
    where next_check<=now() and through_date<=(now() at time zone 'UTC')::date order by next_check,through_date,engagement_id
    limit 1 for update skip locked`);
  if (!scan) return false;
  const scope=[scan.organization_id,scan.legal_entity_id,scan.engagement_id];
  await client.query('savepoint risk_evaluation');
  try {
    await evaluate(client,scan);
    await client.query(`update fixed_fee_risk_scans set failure=null,
      next_check=case when through_date<(now() at time zone 'UTC')::date then now() else now()+interval '5 minutes' end,
      through_date=least(through_date+1,(now() at time zone 'UTC')::date)
      where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3`,scope);
    // Validate all pending writes while this evaluation can still be rolled back independently.
    await client.query('set constraints all immediate');
  } catch {
    await client.query('rollback to savepoint risk_evaluation');
    await client.query(`update fixed_fee_risk_scans set failure='EVALUATION_UNAVAILABLE',next_check=now()+interval '1 minute'
      where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3`,scope);
  }
  return true;
}

async function dispatchNext(client) {
  const {rows:[event]}=await client.query(`select e.* from fixed_fee_risk_dispatch d join fixed_fee_risk_events e on e.id=d.event_id
    where d.delivered_at is null and d.next_attempt<=now() order by d.next_attempt,d.event_id limit 1 for update of d skip locked`);
  if (!event) return false;
  const scope=[event.organization_id,event.legal_entity_id,event.engagement_id];
  let failure='DELIVERY_UNAVAILABLE';
  await client.query('savepoint risk_delivery');
  try {
    const {rows:[policy]}=await client.query(`select * from fixed_fee_risk_notice_policies where organization_id=$1
      and legal_entity_id=$2 and engagement_id=$3 and effective_from<=(now() at time zone 'UTC')::date order by version desc limit 1`,scope);
    if (!policy) {failure='POLICY_UNAVAILABLE';throw Error();}
    const recipients=await client.query(`select user_id,array_agg(reason order by reason) reasons from fixed_fee_risk_recipients($1,$2,$3,$4,$5,$6,$7)
      group by user_id order by user_id`,[...scope,policy.manager_id,policy.manager_role,policy.finance_id,policy.finance_role]);
    if (recipients.rows.flatMap(row=>row.reasons).length!==3) {failure='RECIPIENTS_UNAVAILABLE';throw Error();}
    for (const recipient of recipients.rows) {
      await client.query('insert into fixed_fee_risk_inbox(id,event_id,user_id,reasons) values($1,$2,$3,$4)',
        [randomUUID(),event.id,recipient.user_id,recipient.reasons]);
    }
    await client.query('update fixed_fee_risk_dispatch set attempts=attempts+1,policy_id=$2,delivered_at=clock_timestamp(),failure=null where event_id=$1',
      [event.id,policy.id]);
    // The receipt-set constraint requires the final dispatch row and every recipient.
    await client.query('set constraints all immediate');
  } catch {
    await client.query('rollback to savepoint risk_delivery');
    await client.query(`update fixed_fee_risk_dispatch set attempts=attempts+1,failure=$2,
      next_attempt=now()+interval '1 minute'*least(60,power(2,least(6,attempts))) where event_id=$1`,[event.id,failure]);
  }
  return true;
}

export async function processRiskTransaction(pool,work) {
  const client=await pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    const processed=await work(client);
    await client.query('commit');
    return processed;
  } catch (error) {
    await client.query('rollback');
    // A competing worker committed first. Re-select due work with a fresh snapshot.
    if (error.code==='40001') return true;
    throw error;
  }
  finally {client.release();}
}

export async function processFixedFeeWarnings(pool,limit=10) {
  // Discover work separately from approving time, costs or terms. A notification database
  // failure can delay delivery without aborting a commercial approval transaction.
  await pool.query(`insert into fixed_fee_risk_scans(organization_id,legal_entity_id,engagement_id,through_date)
    select a.organization_id,a.legal_entity_id,a.entity_id,min(a.effective_on) from commercial_amendments a
    where a.entity_type='Engagement' and a.after_value->'terms'->>'budgetWarningPercent' ~ '^[1-9][0-9]*$'
      and not exists(select from fixed_fee_risk_scans s where (s.organization_id,s.legal_entity_id,s.engagement_id)
        =(a.organization_id,a.legal_entity_id,a.entity_id)) group by a.organization_id,a.legal_entity_id,a.entity_id
    order by min(a.effective_on),a.entity_id limit 100 on conflict do nothing`);
  for (let n=0;n<limit;n++) {
    const scanned=await processRiskTransaction(pool,scanNext);
    const dispatched=await processRiskTransaction(pool,dispatchNext);
    if (!scanned && !dispatched) break;
  }
}

export function startFixedFeeWarningWorker(pool,server) {
  let running=false;
  const tick=async()=>{
    if (running) return;
    running=true;
    try {await processFixedFeeWarnings(pool);}
    catch {console.error('Fixed-fee risk notification processing unavailable.');}
    finally {running=false;}
  };
  const timer=setInterval(tick,30_000);
  timer.unref();
  server.once('close',()=>clearInterval(timer));
}
