import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {decimalDifference} from '../../../shared/work-hours.mjs';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';
import {policyRevenue} from './fixed-fee-earned-revenue.mjs';
import {fail} from './contracts.mjs';

export const fixedFeeStatementGrant='commercial.fixed_fee_statement.sign';
const selection=z.object({through:z.string().date(),frequency:z.enum(['Weekly','Monthly','Fiscal'])});
export const fixedFeeStatementQuery=selection.extend({version:z.coerce.number().int().positive().optional()}).strict();
export const fixedFeeStatementCommand=selection.extend({expectedToken:z.string().regex(/^[0-9a-f]{64}$/),reason:z.string().trim().min(3).max(1000),reductionExplanation:z.string().trim().min(3).max(1000).optional()}).strict();

async function balance(client,req,scope,args,date,engagement,opening) {
  if (opening && date<engagement.inception) return {date,profile:'before_service',amount:'0',sources:[]};
  const value=await policyRevenue(client,req,scope,[...args,date],engagement.currency,null);
  if (value.earnedAmount===null) return null;
  let sources;
  if (value.profile==='effort') sources=[value.snapshotId];
  else if (value.profile==='transition') sources=[value.preview.approvalId,value.preview.snapshotId];
  else {
    const {rows}=await client.query(`select distinct on(service_day) id from commercial_fixed_fee_elapsed_values
      where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and service_day<=$4::date order by service_day,version desc`,[...args,date]);
    sources=rows.map(row=>row.id);
  }
  return {date,profile:value.profile,amount:value.earnedAmount,sources};
}
const fields='id,version,report,reason,reduction_explanation as "reductionExplanation",actor_id as "actorId",created_at as "signedAt",token';
export async function fixedFeeStatement(client,req,input,scope,audit) {
  await assertElapsedReadScope(client,req,scope);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id];
  const {rows:[engagement]}=await client.query(`select e.currency,least(e.starts_on,(select min(starts_on) from commercial_amendments
    where organization_id=$1 and legal_entity_id=$2 and entity_type='Engagement' and entity_id=$3 and effective_on<=$4::date))::text inception
    from commercial_engagements e where e.organization_id=$1 and e.legal_entity_id=$2 and e.id=$3 and e.model='fixed_fee'`,[...args,input.through]);
  if (!engagement) fail(404,'STATEMENT_ENGAGEMENT_UNAVAILABLE','Fixed-fee engagement unavailable.');
  const {rows:[period]}=await client.query(`select id,revision,status,starts_on::text as "startsOn",ends_on::text as "endsOn",
    (starts_on-1)::text opening,frequency from reporting_periods where organization_id=$1 and legal_entity_id=$2
    and ends_on=$3::date and frequency=$4 and ends_on<=(now() at time zone 'UTC')::date for share`,
    [organizationId,legalEntityId,input.through,input.frequency]);
  const where='organization_id=$1 and legal_entity_id=$2 and engagement_id=$3';
  const {rows:[saved]}=await client.query(`select ${fields} from commercial_fixed_fee_statements where ${where}
    and report->'period'->>'endsOn'=$4 and report->'period'->>'frequency'=$5
    and ($6::int is null or version=$6) order by created_at desc,version desc limit 1`,[...args,input.through,input.frequency,input.version??null]);
  if (input.version && !saved) fail(404,'STATEMENT_VERSION_UNAVAILABLE','Signed statement version unavailable.');
  let status='period_missing',report=null,token=null;
  if (period) {
    status='period_open';
    if (['Financially Locked','Closed'].includes(period.status)) {
      const opening=await balance(client,req,scope,args,period.opening,engagement,true);
      const closing=await balance(client,req,scope,args,input.through,engagement,false);
      status=!opening?'opening_unavailable':!closing?'closing_unavailable':'ready';
      if (opening && closing) {
        const movement=decimalDifference(closing.amount,opening.amount);
        if (movement.startsWith('-')) status='explanation_required';
        report={engagementId:req.params.id,currency:engagement.currency,period,opening,closing,movement};
        token=createHash('sha256').update(JSON.stringify(report)).digest('hex');
      }
    }
  }
  if (!audit) return {status,report,token,saved:saved??null};
  if (saved?.token===input.expectedToken && saved.actorId===req.user.sub && saved.reason===input.reason && saved.reductionExplanation===(input.reductionExplanation??null))
    return {status,report,token,saved};
  if (status==='explanation_required' && !input.reductionExplanation) fail(422,'REDUCTION_EXPLANATION_REQUIRED','Explain the decrease before signing.');
  if (status==='ready' && input.reductionExplanation) fail(422,'REDUCTION_NOT_APPLICABLE','A reduction explanation applies only to negative movement.');
  if (!['ready','explanation_required'].includes(status) || token!==input.expectedToken) fail(409,'STATEMENT_SOURCE_CHANGED','Inspect the locked period and both balances again.');
  const {rows:[prior]}=await client.query(`select id,version,revision from commercial_fixed_fee_statements where ${where} and period_id=$4
    order by version desc limit 1`,[...args,period.id]);
  if (prior?.revision===period.revision) fail(409,'STATEMENT_ALREADY_SIGNED','This period revision already has a signed statement.');
  const id=randomUUID(),version=(prior?.version??0)+1;
  const {rows:[signed]}=await client.query(`insert into commercial_fixed_fee_statements
    (organization_id,legal_entity_id,engagement_id,period_id,revision,version,id,report,token,reason,actor_id,active_role,operation_id,reduction_explanation)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning ${fields}`,
    [...args,period.id,period.revision,version,id,report,token,input.reason,req.user.sub,req.user.activeRole,req.operationId,input.reductionExplanation??null]);
  await audit(client,req,{module:'Commercial Drafting',entityType:'Fixed Fee Period Statement',entityId:id,action:'Signed',source:'Web',
    oldValue:prior??null,newValue:{periodId:period.id,revision:period.revision,version,token,report,reason:input.reason,reductionExplanation:input.reductionExplanation??null},details:'Signed fixed-fee management valuation for the reporting period.'});
  return {status,report,token,saved:signed};
}
