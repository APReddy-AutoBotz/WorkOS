import {dispatchEngagementRisk,processRiskTransaction} from './fixed-fee-risk-worker.mjs';

export async function processMonthEndMarginAlerts(pool) {
  // Discovery and initial scheduling commit together. Competing workers share a version key.
  await pool.query(`with observed as (
    insert into commercial_service_margin_alerts(margin_version_id,amendment_id)
    select b.margin_version_id,b.amendment_id from commercial_service_margin_breaches b
    where not exists(select from commercial_service_margin_alerts a where a.margin_version_id=b.margin_version_id)
    order by b.ends_on,b.margin_version_id limit 100 on conflict do nothing returning margin_version_id
  ) insert into service_margin_risk_dispatch(event_id) select margin_version_id from observed`);
  for (let n=0;n<10;n++) {
    if (!await processRiskTransaction(pool,client=>dispatchEngagementRisk(client,'managed_service'))) break;
  }
}
