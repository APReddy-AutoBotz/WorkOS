import { invoiceDraftTotal } from './invoice-batch-draft.mjs';

export const CREDIT_CSV_SCHEMA='workos.invoice-credit-csv/1';
const header='schema_version,batch_id,line_id,sequence,item_id,item_version,event_id,event_version,eligible_on,currency,amount,decision_id,original_batch_id,original_artifact_id,original_artifact_sha256,original_line_id,original_event_id,original_item_version,period_start,period_end,client_id_b64,contract_id_b64,engagement_id_b64';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const day=s=>/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
const invalid=()=>{throw new TypeError('Invalid credit export lineage or signed amount.');};

export function renderCreditCsv(batch){
  if(!uuid.test(batch.batchId) || !day(batch.periodStart) || !day(batch.periodEnd) ||
     !Array.isArray(batch.lines) || !batch.lines.length || batch.lines.length>50) invalid();
  const dimensions=[batch.clientId,batch.contractId,batch.engagementId].map(id=>{
    if(typeof id!=='string'||!id.trim()||id.length>200)invalid();
    return 'b64:'+btoa(String.fromCharCode(...new TextEncoder().encode(id)));
  });
  const rows=[header],first=batch.lines[0];
  for(const [index,l] of batch.lines.entries()){
    if(![l.lineId,l.itemId,l.eventId,l.decisionId,l.originalBatchId,l.originalArtifactId,l.originalLineId,l.originalEventId].every(x=>typeof x==='string'&&uuid.test(x))
      || l.sequence!==index+1 || l.itemVersion!==1 || l.eventVersion!==1 || l.originalItemVersion!==1
      || !day(l.eligibleDate) || l.eligibleDate<batch.periodStart || l.eligibleDate>batch.periodEnd || l.currency!==batch.currency
      || !/^[A-Z]{3}$/.test(l.currency) || !/^-(?:0|[1-9]\d{0,15})(?:\.\d{0,3}[1-9])?$/.test(l.amount) || !/[1-9]/.test(l.amount)
      || !/^[a-f0-9]{64}$/.test(l.originalArtifactSha256) || l.originalBatchId!==first.originalBatchId || l.originalArtifactId!==first.originalArtifactId
      || l.originalArtifactSha256!==first.originalArtifactSha256 || l.originalBatchId===batch.batchId) invalid();
    rows.push([CREDIT_CSV_SCHEMA,batch.batchId,l.lineId,l.sequence,l.itemId,l.itemVersion,l.eventId,l.eventVersion,l.eligibleDate,l.currency,l.amount,
      l.decisionId,l.originalBatchId,l.originalArtifactId,l.originalArtifactSha256,l.originalLineId,l.originalEventId,l.originalItemVersion,batch.periodStart,batch.periodEnd,...dimensions].join(','));
  }
  for(const field of ['lineId','itemId','eventId','originalLineId','decisionId']){
    if(new Set(batch.lines.map(x=>x[field])).size!==batch.lines.length)invalid();
  }
  return {text:rows.join('\r\n')+'\r\n',lineCount:batch.lines.length,currency:batch.currency,
    total:'-'+invoiceDraftTotal(batch.lines.map(x=>x.amount.slice(1))).amount};
}

export function verifyCreditCsv(text,artifact){
  const rows=text.split('\r\n');
  if(rows.shift()!==header || rows.pop()!=='' || !rows.length || rows.length>50)invalid();
  const cells=rows.map(row=>row.split(','));
  const lines=cells.map(c=>({
    lineId:c[2],sequence:Number(c[3]),itemId:c[4],itemVersion:Number(c[5]),eventId:c[6],eventVersion:Number(c[7]),eligibleDate:c[8],
    currency:c[9],amount:c[10],decisionId:c[11],originalBatchId:c[12],originalArtifactId:c[13],originalArtifactSha256:c[14],
    originalLineId:c[15],originalEventId:c[16],originalItemVersion:Number(c[17]),
  }));
  const dimensions=cells[0].slice(20).map(value=>{
    if(!value.startsWith('b64:'))invalid();
    return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.slice(4)),c=>c.charCodeAt(0)));
  });
  const checked=renderCreditCsv({batchId:artifact.batchId,clientId:dimensions[0],contractId:dimensions[1],engagementId:dimensions[2],periodStart:cells[0][18],periodEnd:cells[0][19],currency:artifact.currency,lines});
  if(checked.text!==text || checked.total!==artifact.total || checked.lineCount!==artifact.lineCount)invalid();
}
