import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getRetainerConsumption} from './retainer-consumption.mjs';
import {assertCommercialAuthority} from './service.mjs';
import {authorizeRateCandidate} from '../commercial-rates/router.mjs';
import {fail} from './contracts.mjs';

export const statementGrant='commercial.retainer_statements.prepare';
export const statementCommand=z.object({sourceHash:z.string().regex(/^[0-9a-f]{64}$/),previousId:z.string().uuid().nullable(),
  reason:z.string().trim().min(3).max(1000)}).strict();
export const statementQuery=z.object({statementId:z.string().uuid().optional(),entriesOffset:z.string().regex(/^(0|[1-9]\d{0,9})$/).optional()}).strict();
const fields=`id,sequence,previous_id as "previousId",source_hash as "sourceHash",actor_id as "actorId",
  active_role as "activeRole",reason,created_at as "createdAt"`;

// Keep the full source in the immutable record. Page work references across its ordered periods for inspection.
export function evidencePage(evidence,offsetText) {
  if (!evidence) return null;
  const offset=Number(offsetText ?? 0),limit=100;
  let total=0;
  const periods=evidence.periods.map(p=>{
    const start=total;total+=p.entries.length;
    return {...p,entries:p.entries.slice(Math.max(0,offset-start),Math.max(0,offset+limit-start))};
  });
  if (offset>0 && offset>=total) fail(400,'RETAINER_INVALID_PAGE','This evidence page is outside the statement.');
  return {...evidence,periods,entryOffset:offset,totalEntries:total,nextOffset:offset+limit<total ? offset+limit : null};
}

export async function retainerStatement(client,req,workerScope,{query={},command,audit}) {
  const {id:contractId,versionId,startsOn}=req.params;
  if (!z.string().date().safeParse(startsOn).success) fail(400,'RETAINER_INVALID_DATE','Select a valid service period.');
  await assertCommercialAuthority(client,req,statementGrant);
  await assertCommercialAuthority(client,req,'commercial.contracts.manage');
  const keys=[req.organizationScope.organizationId,req.organizationScope.legalEntityId,contractId,versionId,startsOn];
  const where='organization_id=$1 and legal_entity_id=$2 and contract_id=$3 and version_id=$4 and starts_on=$5';
  if (query.statementId) {
    await authorizeRateCandidate(client,req,'billing');
    for (const grant of ['employees.view','reports.view_utilization']) await assertCommercialAuthority(client,req,grant);
    const coverage={entityWide:false};workerScope(req,[],'worker',coverage);
    if (!coverage.entityWide) fail(403,'RETAINER_STATEMENT_DENIED','Contract-wide worker visibility is required.');
    const {rows:[record]}=await client.query(`select ${fields},evidence from commercial_retainer_statements where ${where} and id=$6`,[...keys,query.statementId]);
    if (!record) fail(404,'COMMERCIAL_NOT_FOUND','The scoped statement was not found.');
    return {contractId,versionId,startsOn,record:{...record,evidence:evidencePage(record.evidence,query.entriesOffset)}};
  }
  const evidence=await getRetainerConsumption(client,req,workerScope,true,startsOn);
  const {rows:history}=await client.query(`select ${fields} from commercial_retainer_statements where ${where} order by sequence desc limit 20`,keys);
  const latest=history[0] ?? null;
  const sourceHash=evidence && (await client.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash",[JSON.stringify(evidence)])).rows[0].hash;
  if (!command) return {contractId,versionId,startsOn,sourceHash,evidence:evidencePage(evidence,query.entriesOffset),history};
  if (latest?.sourceHash===command.sourceHash && latest.previousId===command.previousId && latest.actorId===req.user.sub &&
      latest.activeRole===req.user.activeRole && latest.reason===command.reason) return {contractId,versionId,startsOn,record:latest};
  if (evidence && !evidence.closed) fail(409,'RETAINER_PERIOD_OPEN','The service period must end before its statement can be retained.');
  if (!sourceHash || sourceHash!==command.sourceHash || command.previousId!==(latest?.id ?? null) || sourceHash===latest?.sourceHash)
    fail(409,'RETAINER_STATEMENT_STALE','The reviewed evidence or latest statement changed. Reload the service period.');
  const id=randomUUID();
  await client.query("select set_config('workos.retainer_statement',$1,true)",[JSON.stringify({id,actor:req.user.sub,operation:req.operationId,hash:sourceHash})]);
  const {rows:[record]}=await client.query(`insert into commercial_retainer_statements
    (organization_id,legal_entity_id,contract_id,version_id,starts_on,id,ends_on,sequence,previous_id,evidence,source_hash,actor_id,active_role,reason,operation_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15) returning ${fields}`,
    [...keys,id,evidence.price.endsOn,(latest?.sequence ?? 0)+1,latest?.id ?? null,JSON.stringify(evidence),sourceHash,req.user.sub,req.user.activeRole,command.reason,req.operationId]);
  await audit(client,req,{module:'Commercial Drafting',action:'Prepare',entityType:'Retainer Statement',entityId:id,
    oldValue:latest && {id:latest.id,sourceHash:latest.sourceHash},newValue:{id,versionId,startsOn,sourceHash},source:'Web',
    details:'Prepared scoped retainer period statement. Full source and reason retained in protected statement history.'});
  return {contractId,versionId,startsOn,record};
}
