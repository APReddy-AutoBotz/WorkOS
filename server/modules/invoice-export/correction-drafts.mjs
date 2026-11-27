import {cancelInvoiceReview} from '../invoice-drafts/cancel-review.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';

const uuid=z.string().uuid();
const inputs={expectedOwnerKey:z.string().regex(/^[a-f0-9]{64}$/),requestId:uuid,reason:z.string().trim().min(3).max(1000)};
const reserve=z.object({...inputs,itemIds:z.array(uuid).min(1).max(50).refine(ids=>new Set(ids).size===ids.length)}).strict();
const cancel=z.object({...inputs,batchId:uuid,expectedState:z.enum(['Draft','Under Review','Approved']).default('Draft'),expectedReviewId:uuid.optional()}).strict().refine(d=>(d.expectedState==='Under Review')===(d.expectedReviewId!==undefined));
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode,code:'CORRECTION_DRAFT'});
const context=(c,ctx)=>c.query("select set_config('workos.invoice_draft_context',$1,true)",[JSON.stringify(ctx)]);

export function registerCorrectionDrafts(router,{handle,authorize,batch,envelope,audit}){
  const path='/batches/:originalId/correction-drafts';
  const write=(isCancel)=>handle(true,async(c,r)=>{
    const parsed=(isCancel?cancel:reserve).safeParse(r.body);
    if(!parsed.success || !uuid.safeParse(r.params.originalId).success || Object.keys(r.query).length)
      throw fail(400,'Select whole credit items and supply an operation reason.');
    const d=parsed.data;
    if(d.expectedOwnerKey!==workApprovalOwner(r)) throw fail(409,'Account or scope changed.');
    await authorize(c,r,'reversal');
    await assertCommercialAuthority(c,r,'commercial.invoice_drafts.'+(isCancel?'cancel':'own'));
    const {row:orig}=await batch(c,r,r.params.originalId,true);
    if(!['Exported','Billed/Confirmed'].includes(orig.state)) throw fail(409,'A retained export is required.');
    const ctx={organizationId:orig.organization_id,legalEntityId:orig.legal_entity_id,actorId:r.user.sub,activeRole:r.user.activeRole,
      operationId:r.operationId,originalId:orig.id};
    const itemIds=isCancel?null:[...d.itemIds].sort();
    const fingerprint=createHash('sha256').update(JSON.stringify([orig.id,isCancel?d.batchId:itemIds,d.reason,...(d.expectedState==='Under Review'?[d.expectedState,d.expectedReviewId]:d.expectedState==='Approved'?['Approved']:[])])).digest('hex');
    const previous=(await c.query(isCancel?
      `select batch_id as id,request_fingerprint,active_role as role,source_type from invoice_draft_cancellations
       where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and request_id=$4`:
      `select id,request_fingerprint,preparer_role as role,source_type from invoice_draft_batches
       where organization_id=$1 and legal_entity_id=$2 and preparer_user_id=$3 and request_id=$4`,
      [ctx.organizationId,ctx.legalEntityId,ctx.actorId,d.requestId])).rows[0];
    if(previous && (previous.source_type!=='FULL_LINE_REVERSAL' || previous.request_fingerprint!==fingerprint || previous.role!==ctx.activeRole))
      throw fail(409,'Request already used for another operation.');
    const batchId=previous?.id ?? (isCancel?d.batchId:randomUUID());
    const receipt=async()=>{
      const row=(await c.query(`select b.id as "batchId",b.currency,invoice_batch_governed_state(b.id) as state,
        array_agg(l.item_id order by l.item_id) as "itemIds",trim_scale(sum(l.amount))::text total
        from invoice_draft_batches b join invoice_draft_lines l on l.batch_id=b.id
        where b.id=$1 and b.source_type='FULL_LINE_REVERSAL' and b.organization_id=$2 and b.legal_entity_id=$3
        group by b.id having bool_and(l.billing_evidence->>'originalBatchId'=$4)`,[batchId,ctx.organizationId,ctx.legalEntityId,orig.id])).rows[0];
      if(!row) throw fail(404,'Correction batch unavailable.');
      return row;
    };
    if(previous) return {...await envelope(c,r),receipt:await receipt(),originalId:orig.id,replayed:true};
    const cancellationId=isCancel?randomUUID():null;
    await context(c,{...ctx,batchId,cancellationId,expectedState:d.expectedState,expectedReviewId:d.expectedReviewId});
    if(isCancel){
      await c.query('select id from invoice_draft_batches where organization_id=$1 and legal_entity_id=$2 and id=$3 for update',[ctx.organizationId,ctx.legalEntityId,batchId]);
      const before=await receipt();
      if(before.state!==d.expectedState) throw fail(409,'The correction state changed. Inspect the batch again.');
      if (before.state==='Under Review') await cancelInvoiceReview(c,r,batchId,d,fingerprint,audit,d.expectedReviewId);
      await c.query(`insert into invoice_draft_cancellations(id,organization_id,legal_entity_id,batch_id,expected_line_count,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,source_type)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'FULL_LINE_REVERSAL')`,
        [cancellationId,ctx.organizationId,ctx.legalEntityId,batchId,before.itemIds.length,ctx.actorId,ctx.activeRole,d.requestId,fingerprint,d.reason,ctx.operationId]);
      await c.query('delete from invoice_draft_occupancies where batch_id=$1',[batchId]);
    }else{
      const rows=(await c.query(`select i.id,i.version,ev.id event_id,ev.currency,ev.amount::text,ev.billing_evidence,ev.eligible_on::text,
          exists(select 1 from invoice_draft_occupancies o where o.item_id=i.id and o.item_version=i.version) as occupied
        from approved_unbilled_items i join billing_eligibility_events ev on ev.id=i.event_id
        where i.organization_id=$1 and i.legal_entity_id=$2 and ev.billing_evidence->>'originalBatchId'=$3
        and i.id=any($4::uuid[]) and i.source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') order by i.id`,[ctx.organizationId,ctx.legalEntityId,orig.id,itemIds])).rows;
      if(rows.length!==itemIds.length) throw fail(409,'Selected credits unavailable for this export.');
      if(rows.some(row=>row.occupied)) throw fail(409,'A selected credit already belongs to a correction batch. Reload the register.');
      const dates=rows.map(x=>x.eligible_on).sort();
      await c.query(`insert into invoice_draft_batches(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,currency,period_start,period_end,period_basis,
        owner_user_id,owner_role,preparer_user_id,preparer_role,request_id,request_fingerprint,reason,operation_id,source_type)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'ELIGIBLE_DATE',$10,$11,$10,$11,$12,$13,$14,$15,'FULL_LINE_REVERSAL')`,
        [batchId,ctx.organizationId,ctx.legalEntityId,orig.client_id,orig.contract_id,orig.engagement_id,orig.currency,dates[0],dates.at(-1),ctx.actorId,ctx.activeRole,d.requestId,fingerprint,d.reason,ctx.operationId]);
      for(const [index,row] of rows.entries()){
        const lineId=randomUUID();
        await context(c,{...ctx,batchId,lineId});
        await c.query(`insert into invoice_draft_lines(id,organization_id,legal_entity_id,batch_id,sequence,item_id,item_version,event_id,currency,amount,
          billing_evidence,actor_id,active_role,request_id,request_fingerprint,reason,operation_id,source_type)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'FULL_LINE_REVERSAL')`,
          [lineId,ctx.organizationId,ctx.legalEntityId,batchId,index+1,row.id,row.version,row.event_id,row.currency,row.amount,row.billing_evidence,
            ctx.actorId,ctx.activeRole,randomUUID(),fingerprint,d.reason,ctx.operationId]);
        await c.query('insert into invoice_draft_occupancies(item_id,item_version,batch_id,line_id) values($1,$2,$3,$4)',[row.id,row.version,batchId,lineId]);
      }
    }
    const result=await receipt();
    await audit(c,r,{module:'Invoice Corrections',action:isCancel?'Cancel Correction Draft':'Reserve Correction Credits',entityType:'Correction Draft',
      entityId:cancellationId??batchId,reason:d.reason,details:isCancel?'Released all credit reservations.':'Reserved whole credits from the original export.',newValue:{batchId,itemIds:result.itemIds,currency:result.currency,total:result.total}});
    return {...await envelope(c,r),originalId:orig.id,receipt:result,replayed:false};
  });
  router.post(path,write(false));
  router.post(path+'/cancel',write(true));
}
