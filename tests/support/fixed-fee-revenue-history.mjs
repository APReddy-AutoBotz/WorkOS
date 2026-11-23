import assert from 'node:assert/strict';
import {earnedRevenue} from '../../server/modules/commercial-drafting/fixed-fee-earned-revenue.mjs';

// A private historical fixture exercises multi-year boundaries without waiting for UTC dates to pass.
// The API journey independently verifies writes against the real ledger constraints.
export async function checkElapsedHistory(pool,organizationId,legalEntityId,engagementId,through) {
  const client=await pool.connect();
  const args=[organizationId,legalEntityId,engagementId,through];
  try {
    await client.query('begin');
    await client.query('set local search_path to pg_temp, public');
    await client.query('create temporary table commercial_amendments on commit drop as select * from public.commercial_amendments');
    await client.query('create temporary table commercial_lifecycle_events on commit drop as select * from public.commercial_lifecycle_events');
    await client.query('create temporary table commercial_fixed_fee_elapsed_values on commit drop as select * from public.commercial_fixed_fee_elapsed_values where false');
    await client.query(`update pg_temp.commercial_amendments set starts_on=$1::date-500,ends_on=$1::date-1,effective_on=$1::date-400
      where entity_type='Engagement' and entity_id=$2`,[through,engagementId]);
    await client.query('update pg_temp.commercial_lifecycle_events set effective_on=$1::date-500',[through]);
    await client.query(`insert into pg_temp.commercial_lifecycle_events
      (id,organization_id,legal_entity_id,entity_type,entity_id,state,sequence,effective_on)
      values ('synthetic-hold',$1,$2,'Engagement',$3,'On Hold',2,$4::date-200),
             ('synthetic-resume',$1,$2,'Engagement',$3,'Active',3,$4::date-190)`,args);
    const initial=await earnedRevenue(client,args,'GBP','130');
    assert.deepEqual(initial,{applicableDays:390,missingDays:390,staleDays:0,earnedAmount:null,remainingRevenue:null});
    await client.query(`insert into pg_temp.commercial_fixed_fee_elapsed_values (organization_id,legal_entity_id,engagement_id,service_day,version,report)
      select $1,$2,$3,$4::date-i,1,r from generate_series(0,500) i cross join lateral
      fixed_fee_elapsed_report($1,$2,$3,$4::date-i) r where r is not null`,args);
    const {rows:[oracle]}=await client.query(`select count(*)::int days,trim_scale(sum((report->>'amount')::numeric))::text amount,
      trim_scale(130-sum((report->>'amount')::numeric))::text remaining from pg_temp.commercial_fixed_fee_elapsed_values`);
    assert.equal(oracle.days,390);
    assert.deepEqual(await earnedRevenue(client,args,'GBP','130'),{applicableDays:390,missingDays:0,staleDays:0,earnedAmount:oracle.amount,remainingRevenue:oracle.remaining});
  } finally {
    try {await client.query('rollback');} finally {client.release();}
  }
}
