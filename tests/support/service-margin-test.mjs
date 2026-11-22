import assert from 'node:assert/strict';
import {adoptHourlyRate} from './adopt-hourly-rate.mjs';

export async function verifyServiceMargin({pool,request,post,capture,review,receipt,accepted,base,identities,today,end,engagement,workerId}) {
  const path='/engagements/'+engagement.id+'/service-period-margin';
  const monthStart=today.slice(0,7)+'-01',query=path+'?monthStart='+monthStart;
  const read=async(suffix='')=>{const r=await request(query+suffix);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const retain=token=>post(path,{monthStart,expectedToken:token});
  assert.equal((await request(query)).status,403);
  const grants=['commercial.service_margin.view','commercial.service_margin.record','commercial.service_cost.view','commercial.service_cost.record',
    'commercial.cost_candidates.manage','commercial.cost_candidates.view','commercial.cost_approvals.decide','commercial.service_units.issue','approvals.view'];
  for (const role of ['Admin','Employee']) await pool.query(`insert into role_permissions(role_name,permission_key,enabled)
    select $1,k,true from unnest($2::text[]) k on conflict(role_name,permission_key) do update set enabled=true`,[role,grants]);
  assert.equal((await request(query,{identity:identities.reader})).status,403);
  assert.equal((await request(path+'?monthStart=2200-01-01')).status,404);
  const initial=await read();
  assert.equal(initial.report.margin,null);
  assert.equal(initial.report.missingCosts,1);
  assert.equal(initial.report.verifiedEntries,2);
  assert.equal(initial.report.approvedEntries,3);
  const v1=await retain(initial.token);assert.equal(v1.version,1);
  const other=await capture('CALL','OPS-43','0.75');
  const secondReview=await review(other.id,'Accepted');
  const rate=await adoptHourlyRate({request,ids:identities,workerId,today,end,currency:'GBP'},'cost','12.3456');
  for (const [source,decision] of [[receipt,accepted],[other,secondReview]]) {
    await post(base+'/'+source.id+'/effort-cost',{reviewId:decision.id,adoptionId:rate.id});
  }
  const costsOnly=(await read()).report;
  assert.deepEqual([costsOnly.margin,costsOnly.marginPercent],['-55.5552',null]);
  for (const [source,decision] of [[receipt,accepted],[other,secondReview]]) {
    await post(base+'/'+source.id+'/billing',{reviewId:decision.id,reason:'Register synthetic verified delivery'});
  }
  assert.equal((await request(path,{method:'POST',body:{monthStart,expectedToken:initial.token}})).status,409);
  const preview=await read(),p=preview.report;
  assert.deepEqual([p.approvedHours,p.verifiedEntries,p.billable,p.retainedCost,p.margin,p.marginPercent],
    ['4.5',3,'100','55.5552','44.4448','44.44']);
  const [a,b]=await Promise.all([retain(preview.token),retain(preview.token)]);
  assert.equal(a.version,2);assert.deepEqual(a,b);
  assert.deepEqual((await read('&version=1')).report,v1.report);
  assert.deepEqual((await read()).report,p);
  assert.equal((await pool.query('select count(*)::int n from commercial_service_margin_versions')).rows[0].n,2);
  await assert.rejects(pool.query('delete from commercial_service_margin_versions'));
  await pool.query("update role_permissions set enabled=false where role_name='Admin' and permission_key='commercial.cost_candidates.view'");
  assert.equal((await request(query+'&version=1')).status,403);
}
