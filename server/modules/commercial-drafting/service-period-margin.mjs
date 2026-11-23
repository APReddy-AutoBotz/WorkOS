import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

const monthStart=z.string().date().regex(/-01$/);
const thresholdPercent=z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);
function hundredths(value) {
  const [whole,fraction='']=value.replace(/^-/, '').split('.');
  const magnitude=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return value.startsWith('-')?-magnitude:magnitude;
}
export const marginQuery=z.object({monthStart,version:z.coerce.number().int().positive().max(2147483647).optional(),thresholdPercent:thresholdPercent.optional()}).strict().refine(input=>input.thresholdPercent===undefined || input.version!==undefined);
export const marginCommand=z.object({monthStart,expectedToken:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export const marginRecordGrant='commercial.service_margin.record';
export async function servicePeriodMargin(client,req,input,buildEmployeeScopeWhere,audit) {
  for (const grant of ['employees.view','reports.view_utilization','commercial.service_cost.view','commercial.cost_candidates.view','commercial.service_margin.view'])
    await assertCommercialAuthority(client,req,grant);
  const coverage={entityWide:false};
  buildEmployeeScopeWhere(req,[],'worker',coverage);
  if (!coverage.entityWide) fail(403,'MARGIN_DENIED','Engagement-wide worker visibility is required.');
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,input.monthStart];
  const {rows:[saved]}=await client.query(`select id,version,report,(select max(v.version) from commercial_service_margin_versions v where v.organization_id=$1 and v.legal_entity_id=$2 and v.engagement_id=$3 and v.month_start=$4) latest from commercial_service_margin_versions
    where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and month_start=$4 and ($5::integer is null or version=$5)
    order by version desc limit 1`,[...args,input.version??null]);
  if (input.version && !saved) fail(404,'MARGIN_UNAVAILABLE','The selected financial period version is unavailable.');
  const report=input.version?saved.report:(await client.query(`select service_margin_report($1,$2,$3,$4::date) report
    where $4::date<=(now() at time zone 'UTC')::date`,args)).rows[0]?.report;
  if (!report) fail(404,'MARGIN_UNAVAILABLE','The selected financial period is unavailable.');
  const ctx={organizationId,legalEntityId,actorId:req.user.sub,activeRole:req.user.activeRole};
  const {rows:[scope]}=await client.query(`select not exists(select from unnest($1::text[]) w
    where not rate_candidate_worker_visible($2::jsonb,w)) visible`,[report.workers,JSON.stringify(ctx)]);
  if (!scope.visible) fail(403,'MARGIN_DENIED','Current access to all contributing workers is required.');
  const token=createHash('sha256').update(JSON.stringify([...args,report])).digest('hex');
  const data={engagementId:req.params.id,monthStart:input.monthStart,report,token};
  if (input.thresholdPercent!==undefined) {
    const actual=report.marginPercent;
    const status=actual===null?'Unavailable':hundredths(actual)<hundredths(input.thresholdPercent)?'Below':'AtOrAbove';
    data.thresholdComparison={thresholdPercent:input.thresholdPercent,status};
  }
  if (input.expectedToken && input.expectedToken!==token) fail(409,'MARGIN_CHANGED','Financial evidence changed. Inspect the period again.');
  if (saved && JSON.stringify(saved.report)===JSON.stringify(report)) return {...data,version:saved.version,latestVersion:saved.latest};
  if (!input.expectedToken) return {...data,version:null,latestVersion:saved?.version??0};
  if (!report.work.length && !report.receipts.length && !report.billingEvents.length) fail(409,'MARGIN_EMPTY','There is no financial evidence to retain.');
  const id=randomUUID(),version=(saved?.version??0)+1;
  await client.query(`insert into commercial_service_margin_versions
    (organization_id,legal_entity_id,engagement_id,month_start,id,version,report,actor_id,active_role,operation_id)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,[...args,id,version,JSON.stringify(report),req.user.sub,req.user.activeRole,req.operationId]);
  await audit(client,req,{module:'Commercial Drafting',action:'Retain Margin',entityType:'Service Period Margin',entityId:id,
    oldValue:null,newValue:{engagementId:req.params.id,monthStart:input.monthStart,version},source:'Web',details:'Retained managed-service financial period.'});
  return {...data,version,latestVersion:version};
}
