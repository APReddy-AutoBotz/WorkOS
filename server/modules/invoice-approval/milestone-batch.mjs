import {assertCommercialAuthority} from '../commercial-drafting/service.mjs';

const fail=(statusCode,code,message)=>Object.assign(new Error(message),{statusCode,code});
export const milestoneBatchModel=async(c,r,batchId)=>{
 const row=(await c.query('select e.model from invoice_draft_batches b join commercial_engagements e on e.id=b.engagement_id and e.organization_id=b.organization_id and e.legal_entity_id=b.legal_entity_id where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3',[batchId,r.organizationScope.organizationId,r.organizationScope.legalEntityId])).rows[0];
 if(!row)throw fail(404,'INVOICE_APPROVAL_SOURCE','Scoped invoice batch unavailable.');
 return row.model==='milestone';
};
export const loadMilestoneApprovalBatch=async(c,r,batchId,lock=false)=>{
 await assertCommercialAuthority(c,r,'commercial.milestone_billing.view');
 const b=(await c.query(`select b.*,b.period_start::text period_start,b.period_end::text period_end,invoice_batch_governed_state(b.id) state,milestone_invoice_batch_source_current(b,$4,$5) current,milestone_invoice_lineage_hash(b.id) lineage_hash from invoice_draft_batches b join commercial_engagements e on e.id=b.engagement_id and e.organization_id=b.organization_id and e.legal_entity_id=b.legal_entity_id where b.id=$1 and b.organization_id=$2 and b.legal_entity_id=$3 and e.model='milestone'${lock?' for update of b':''}`,[batchId,r.organizationScope.organizationId,r.organizationScope.legalEntityId,r.user.sub,r.user.activeRole])).rows[0];
 if(!b||b.source_type!=='MILESTONE_ACCEPTANCE')throw fail(404,'INVOICE_APPROVAL_SOURCE','Scoped milestone batch unavailable.');
 const lines=(await c.query("select l.id,l.sequence,l.item_id,l.item_version,l.event_id,l.snapshot_id,l.source_type,l.currency,l.amount::text,l.billing_evidence from invoice_draft_lines l where l.batch_id=$1 and l.source_type='MILESTONE_ACCEPTANCE' order by l.sequence",[b.id])).rows;
 const sum=(await c.query('select count(*)::int n,trim_scale(coalesce(sum(amount),0))::text total from invoice_draft_lines where batch_id=$1',[b.id])).rows[0];
 if(lines.length!==sum.n)throw fail(409,'INVOICE_APPROVAL_SOURCE','Batch contains an unsupported source.');
 return{row:b,lines,sum};
};
