import {createHash,randomUUID} from 'node:crypto';
import {decimalDifference,sumHours} from '../../../shared/work-hours.mjs';
import {calculateLaborMargin} from '../../../shared/labor-margin.mjs';
import {z} from 'zod';
import {decimalAmount,fail} from './contracts.mjs';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';
import {earnedRevenue} from './fixed-fee-earned-revenue.mjs';
import {fixedFeeRisk,riskQuery} from './fixed-fee-risk.mjs';

export const forecastGrant='commercial.fixed_fee_forecast.record';
const forecastView=riskQuery.extend({view:z.enum(['labor_margin','budget_comparison','revenue_reconciliation','margin_reconciliation']).optional()});
export const forecastQuery=forecastView.extend({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
export const forecastCommand=forecastView.extend({expectedVersion:z.number().int().nonnegative().max(2147483646),
  expectedToken:z.string().regex(/^[0-9a-f]{64}$/),requestId:z.string().uuid(),remainingHours:decimalAmount,remainingCost:decimalAmount,
  expectedTotalRevenue:decimalAmount.optional(),
  reason:z.string().trim().min(3).max(1000)}).strict();
const fields='id,version,report,evidence_token,reason,created_at as "createdAt"';
export async function fixedFeeForecast(client,req,input,scope,audit) {
  const {organizationId,legalEntityId}=req.organizationScope;
  const engagementId=req.params.id,through=input.through;
  const args=[organizationId,legalEntityId,engagementId,through];
  const includeRevenue=['revenue_reconciliation','margin_reconciliation'].includes(input.view);
  const marginAllowed=input.view && !['Employee','TeamLead','CountryDirector','ProjectManager'].includes(req.user.activeRole) &&
    (await client.query("select invoice_notice_actor_has($1,$2,$3,$4,'commercial.fixed_fee_margin.view') allowed",
      [organizationId,legalEntityId,req.user.sub,req.user.activeRole])).rows[0].allowed===true;
  if (input.view==='margin_reconciliation' && !marginAllowed) fail(403,'MARGIN_DENIED','Fixed-fee margin access is required.');
  if (includeRevenue) await assertElapsedReadScope(client,req,scope);
  const risk=await fixedFeeRisk(client,req,{through},scope,true);
  const {verifiedHours,unresolved,workToken,costToken}=risk.forecastEvidence;
  const baseline={engagementId,through,currency:risk.currency,contractVersionId:risk.contractVersionId,amendmentId:risk.amendmentId,
    approvedEntries:risk.approvedEntries,costedEntries:risk.costedEntries,actualHours:verifiedHours,actualCost:risk.retainedCost,
    hoursComplete:unresolved===0,costComplete:risk.complete || (risk.approvedEntries===0 && risk.costedEntries===0),
    budgetHours:risk.effortBudget?.budgetHours??null,budgetCost:risk.laborCostBudget};
  const token=createHash('sha256').update(JSON.stringify([baseline,workToken,costToken])).digest('hex');
  const where='organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and through_date=$4';
  const {rows:[latest]}=await client.query(`select ${fields} from commercial_fixed_fee_forecasts where ${where} order by version desc limit 1`,args);
  const latestVersion=latest?.version??0;
  let saved=latest??null;
  async function response(saved, latestVersion) {
    const {evidence_token,...snapshot}=saved??{};
    const result={baseline,token,latestVersion,saved:saved?snapshot:null};
    if (input.view) {
      const report=saved?.report;
      result.laborMargin=marginAllowed && report?.expectedTotalRevenue!==undefined && report.estimatedCost!=null
        ? calculateLaborMargin(report.expectedTotalRevenue,report.estimatedCost) : null;
    }
    if (input.view==='budget_comparison' || includeRevenue) {
      const report=saved?.report;
      result.budgetVariance={
        hours:report?.budgetHours!=null && report.estimatedHours!=null ? decimalDifference(report.estimatedHours,report.budgetHours) : null,
        laborCost:report?.budgetCost!=null && report.estimatedCost!=null ? decimalDifference(report.estimatedCost,report.budgetCost) : null,
      };
    }
    if (includeRevenue) result.revenue=await earnedRevenue(client,args,baseline.currency,saved?.report.expectedTotalRevenue);
    if (input.view==='margin_reconciliation') {
      const {earnedAmount,remainingRevenue}=result.revenue;
      const actual=earnedAmount!==null && baseline.hoursComplete && baseline.costComplete
        ? calculateLaborMargin(earnedAmount,baseline.actualCost) : null;
      const current=saved!=null && evidence_token===token;
      let remaining=null;
      if (current && actual && remainingRevenue!==null) {
        remaining=remainingRevenue.startsWith('-')
          ? {amount:'-'+sumHours([remainingRevenue.slice(1),saved.report.remainingCost]),percent:null}
          : calculateLaborMargin(remainingRevenue,saved.report.remainingCost);
      }
      result.marginComparison={actual,remaining,forecastCurrent:current};
    }
    return result;
  }
  if (audit) {
    const {rows:[prior]}=await client.query(`select ${fields} from commercial_fixed_fee_forecasts
      where ${where} and actor_id=$5 and request_id=$6`,[...args,req.user.sub,input.requestId]);
    if (prior) {
      if (prior.evidence_token!==input.expectedToken || prior.version!==input.expectedVersion+1 || prior.reason!==input.reason ||
        prior.report.expectedTotalRevenue!==input.expectedTotalRevenue || prior.report.remainingHours!==input.remainingHours || prior.report.remainingCost!==input.remainingCost)
        fail(409,'FORECAST_CONFLICT','This request already recorded different forecast assumptions.');
      return response(prior,latestVersion);
    }
    if (latestVersion!==input.expectedVersion || token!==input.expectedToken) fail(409,'FORECAST_CONFLICT','Inspect the current actuals and latest forecast again.');
    const {rows:[estimate]}=await client.query(`select case when $1::boolean then trim_scale($2::numeric+$3::numeric)::text end as "estimatedHours",
      case when $4::boolean then trim_scale($5::numeric+$6::numeric)::text end as "estimatedCost"`,
      [baseline.hoursComplete,baseline.actualHours,input.remainingHours,baseline.costComplete,baseline.actualCost,input.remainingCost]);
    const report={...baseline,remainingHours:input.remainingHours,remainingCost:input.remainingCost,expectedTotalRevenue:input.expectedTotalRevenue,...estimate};
    const id=randomUUID(),version=latestVersion+1;
    ({rows:[saved]}=await client.query(`insert into commercial_fixed_fee_forecasts
      (organization_id,legal_entity_id,engagement_id,through_date,id,version,request_id,evidence_token,report,reason,actor_id,active_role,operation_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${fields}`,
      [...args,id,version,input.requestId,token,report,input.reason,req.user.sub,req.user.activeRole,req.operationId]));
    await audit(client,req,{module:'Commercial Drafting',entityType:'Fixed Fee Completion Forecast',entityId:id,action:'Recorded',
      oldValue:latest?{forecastId:latest.id,version:latestVersion}:null,newValue:{engagementId,through,version},source:'Web',details:'Retained reviewed remaining effort and labor cost estimates.'});
    return response(saved,version);
  }
  if (input.version && input.version!==latestVersion) {
    ({rows:[saved]}=await client.query(`select ${fields} from commercial_fixed_fee_forecasts where ${where} and version=$5`,[...args,input.version]));
    if (!saved) fail(404,'FORECAST_UNAVAILABLE','Forecast version unavailable for the selected date.');
  }
  return response(saved,latestVersion);
}
