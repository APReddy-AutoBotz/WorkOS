import {z} from 'zod';
import {assertCommercialAuthority} from '../commercial-drafting/service.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';

export function registerPoCommitments(router,{handle,parse,batch,authorize,envelope,audit,fail}) {
  const path='/batches/:id/lines/:lineId/purchase-order';
  const command=z.object({expectedOwnerKey:z.string().regex(/^[a-f0-9]{64}$/),
    number:z.string().trim().min(1).max(200),reason:z.string().trim().min(3).max(1000)}).strict();
  const receipt=async (c,lineId) => (await c.query(
    `select p.number,p.currency,p.value::text as "orderValue",l.amount::text amount,
      balance.committed::text committed,balance.consumed::text consumed,balance.remaining::text remaining,
      balance.warning,p.warning_threshold_percent::text as "warningPercent",a.actor_id as "actorId",
      a.active_role as "activeRole",a.reason
     from commercial_po_line_commitments a join commercial_purchase_orders p on p.id=a.purchase_order_id
     join invoice_draft_lines l on l.id=a.line_id cross join lateral commercial_po_balance(p.id) balance
     where a.line_id=$1`,[lineId])).rows[0] ?? null;
  const access=async(c,r,lock) => {
    const id=parse(z.string().uuid(),r.params.id), lineId=parse(z.string().uuid(),r.params.lineId);
    await authorize(c,r);
    for(const key of ['commercial.contracts.manage','commercial.purchase_orders.release','commercial.invoice_drafts.prepare'])
      await assertCommercialAuthority(c,r,key);
    const {row,source}=await batch(c,r,id,lock,true);
    if(['MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT'].includes(row.source_type)) {
      await assertCommercialAuthority(c,r,row.source_type==='FIXED_FEE_INSTALLMENT' ? 'commercial.fixed_fee_eligibility.issue' : 'commercial.milestone_billing.view');
      const hidden=await c.query(`select 1 from invoice_draft_lines l where batch_id=$1 and
        invoice_source_historical_visible($2,$3,l,$4,$5) is not true limit 1`,
        [id,row.organization_id,row.legal_entity_id,r.user.sub,r.user.activeRole]);
      if(hidden.rowCount)throw fail(404,'PO_LINE_UNAVAILABLE','This invoice line is unavailable.');
    }
    if(!['TM_SNAPSHOT','MILESTONE_ACCEPTANCE','FIXED_FEE_INSTALLMENT'].includes(row.source_type) || !source.lines.some(l=>l.lineId===lineId))
      throw fail(404,'PO_LINE_UNAVAILABLE','This invoice line is unavailable.');
    return {id,lineId,row};
  };
  router.get(path,handle(false,async(c,r)=>{
    parse(z.object({}).strict(),r.query);
    const {id,lineId}=await access(c,r,false);
    return {...await envelope(c,r),batchId:id,lineId,commitment:await receipt(c,lineId)};
  }));
  router.post(path,handle(true,async(c,r)=>{
    const data=parse(command,r.body);
    if(data.expectedOwnerKey!==workApprovalOwner(r)) throw fail(403,'PO_AUTHORITY_CHANGED','Reload the current scope.');
    const {id,lineId,row}=await access(c,r,true);
    const prior=await receipt(c,lineId);
    if(prior) {
      if(prior.number!==data.number || prior.reason!==data.reason || prior.actorId!==r.user.sub || prior.activeRole!==r.user.activeRole)
        throw fail(409,'PO_LINE_ASSIGNED','This line already has a purchase order.');
      return {...await envelope(c,r),batchId:id,lineId,commitment:prior,replayed:true};
    }
    const args=[row.organization_id,row.legal_entity_id];
    const po=(await c.query(`select p.id from commercial_purchase_orders p
      join commercial_purchase_order_releases rel on rel.purchase_order_id=p.id
      where p.organization_id=$1 and p.legal_entity_id=$2 and p.contract_id=$3 and p.number=$4 for update of p`,
      [...args,row.contract_id,data.number])).rows[0];
    if(!po)throw fail(404,'PO_UNAVAILABLE','A released order for this contract is required.');
    await c.query("select set_config('workos.po_commit_operation',$1,true)",[r.operationId]);
    try {
      await c.query(`insert into commercial_po_line_commitments
        (line_id,batch_id,purchase_order_id,organization_id,legal_entity_id,actor_id,active_role,reason,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[lineId,id,po.id,...args,r.user.sub,r.user.activeRole,data.reason,r.operationId]);
    } catch(e) {
      if(e.code==='POC01')throw fail(409,'PO_LIMIT_EXCEEDED','This charge exceeds the available purchase order balance.');
      throw e;
    }
    await audit(c,r,'Commit purchase order',lineId,{lineId,batchId:id});
    return {...await envelope(c,r),batchId:id,lineId,commitment:await receipt(c,lineId),replayed:false};
  }));
}
