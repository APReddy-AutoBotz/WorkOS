import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertCommercialAuthority} from './service.mjs';
import {fail} from './contracts.mjs';

export const elapsedGrant='commercial.fixed_fee_elapsed.record';
const day=z.object({serviceDay:z.string().date()});
export const elapsedQuery=day.extend({version:z.coerce.number().int().positive().optional()}).strict();
export const elapsedCommand=day.extend({parentLifecycleId:z.string().min(1).max(200),lifecycleId:z.string().min(1).max(200),policyVersion:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative()}).strict();

export async function fixedFeeElapsed(client,req,input,scope,audit) {
  for (const permission of ['commercial.fixed_fee_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization'])
    await assertCommercialAuthority(client,req,permission);
  const coverage={entityWide:false};
  scope(req,[],'worker',coverage);
  if (!coverage.entityWide) fail(403,'ELAPSED_SCOPE_DENIED','Engagement-wide financial scope is required.');
  if (['Employee','TeamLead','CountryDirector','ProjectManager'].includes(req.user.activeRole)) fail(403,'ELAPSED_SCOPE_DENIED','Financial scope is required.');
  const {organizationId,legalEntityId}=req.organizationScope;
  const args=[organizationId,legalEntityId,req.params.id,input.serviceDay];
  const where='organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and service_day=$4';
  const {rows:[{report}]}=await client.query('select fixed_fee_elapsed_report($1,$2,$3,$4::date) report',args);
  const {rows:[latest]}=await client.query(`select id,version,report from commercial_fixed_fee_elapsed_values where ${where} order by version desc limit 1`,args);
  let saved=latest??null;
  if (audit) {
    if (!report || report.policyVersion!==input.policyVersion || report.lifecycleId!==input.lifecycleId || report.parentLifecycleId!==input.parentLifecycleId) fail(409,'ELAPSED_POLICY_CHANGED','Inspect the approved policy and service date again.');
    if (saved?.report.policyVersion!==report.policyVersion || saved.report.lifecycleId!==report.lifecycleId || saved.report.parentLifecycleId!==report.parentLifecycleId) {
      if ((saved?.version??0)!==input.expectedVersion) fail(409,'ELAPSED_VERSION_CHANGED','Inspect the latest retained version.');
      const id=randomUUID(),version=input.expectedVersion+1;
      await client.query(`insert into commercial_fixed_fee_elapsed_values
        (organization_id,legal_entity_id,engagement_id,service_day,id,version,report,actor_id,active_role,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...args,id,version,report,req.user.sub,req.user.activeRole,req.operationId]);
      await audit(client,req,{module:'Commercial Drafting',entityType:'Fixed Fee Elapsed Value',entityId:id,action:'Recorded',
        oldValue:saved?{id:saved.id,version:saved.version}:null,newValue:{engagementId:req.params.id,serviceDay:input.serviceDay,policyVersion:report.policyVersion},
        source:'Web',details:'Retained daily operational earned-management value.'});
      saved={id,version,report};
    }
    return {report,saved,latestVersion:saved.version};
  }
  if (input.version && input.version!==latest?.version) {
    ({rows:[saved]}=await client.query(`select id,version,report from commercial_fixed_fee_elapsed_values where ${where} and version=$5`,[...args,input.version]));
    if (!saved) fail(404,'ELAPSED_VERSION_UNAVAILABLE','Retained version unavailable.');
  }
  return {report,saved,latestVersion:latest?.version??0};
}
