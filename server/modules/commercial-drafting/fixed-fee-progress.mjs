import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sumHours} from '../../../shared/work-hours.mjs';
import {fixedFeeWorkRows} from './fixed-fee-effort.mjs';
import {assertElapsedReadScope} from './fixed-fee-elapsed.mjs';
import {fail} from './contracts.mjs';

export const progressGrant='commercial.fixed_fee_progress.record';
const asOf=z.object({through:z.string().date()});
export const progressQuery=asOf.extend({version:z.coerce.number().int().positive().optional()}).strict();
export const progressCommand=asOf.extend({expectedVersion:z.number().int().nonnegative(),expectedToken:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

export async function fixedFeeProgress(client,req,input,scope,audit) {
  await assertElapsedReadScope(client,req,scope);
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,input.through];
  const {rows:[{basis}]}=await client.query('select fixed_fee_progress_basis($1,$2,$3,$4::date) basis',args);
  const where='organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and through_date=$4';
  const fields='id,version,report,source_token';
  const {rows:[latest]}=await client.query(`select ${fields} from commercial_fixed_fee_progress_values where ${where} order by version desc limit 1`,args);
  const sources=[];
  let report=null,token=null,saved=latest??null;
  if (basis) {
    let after=null,unresolved=0;
    do {
      const page=await fixedFeeWorkRows(client,req,{through:input.through,startsOn:basis.startsOn,after},scope);
      for (const entry of page.verified) sources.push({entryId:entry.id,workerId:entry.employee_id,workDate:entry.work_date,
        submissionId:entry.submission_id,decisionId:entry.decision_id,hours:entry.hours,billable:entry.billable});
      unresolved+=page.unresolvedEntries;after=page.next;
    } while (after);
    const billableHours=sumHours(sources.filter(s=>s.billable).map(s=>s.hours));
    const nonBillableHours=sumHours(sources.filter(s=>!s.billable).map(s=>s.hours));
    const verifiedHours=sumHours([billableHours,nonBillableHours]);
    const amount=unresolved?null:(await client.query('select fixed_fee_progress_amount($1,$2,$3,$4)::text amount',
      [basis.allocation,verifiedHours,basis.budgetHours,basis.precision])).rows[0].amount;
    report={...basis,billableHours,nonBillableHours,verifiedHours,entries:sources.length,unresolved,amount};
    token=createHash('sha256').update(JSON.stringify([report,sources])).digest('hex');
  }
  if (audit) {
    if (report?.amount==null || token!==input.expectedToken) fail(409,'PROGRESS_SOURCE_CHANGED','Inspect the approved policy and complete delivery evidence.');
    if (latest?.source_token!==token) {
      if ((latest?.version??0)!==input.expectedVersion) fail(409,'PROGRESS_VERSION_CHANGED','Inspect the latest progress version.');
      const version=input.expectedVersion+1,id=randomUUID();
      await client.query(`insert into commercial_fixed_fee_progress_values
        (organization_id,legal_entity_id,engagement_id,through_date,id,version,report,source_token,sources,actor_id,active_role,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [...args,id,version,report,token,JSON.stringify(sources),req.user.sub,req.user.activeRole,req.operationId]);
      await audit(client,req,{module:'Commercial Drafting',entityType:'Fixed Fee Progress Value',entityId:id,action:'Recorded',
        oldValue:latest?{id:latest.id,version:latest.version}:null,newValue:{engagementId:req.params.id,through:input.through,version,sourceToken:token},
        source:'Web',details:'Retained cumulative fixed-fee effort value.'});
      saved={id,version,report};
    }
  } else if (input.version && input.version!==latest?.version) {
    ({rows:[saved]}=await client.query(`select ${fields} from commercial_fixed_fee_progress_values where ${where} and version=$5`,[...args,input.version]));
    if (!saved) fail(404,'PROGRESS_VERSION_UNAVAILABLE','Retained progress version unavailable.');
  }
  return {report,token,latestVersion:Math.max(latest?.version??0,saved?.version??0),saved:saved?{id:saved.id,version:saved.version,report:saved.report}:null};
}
