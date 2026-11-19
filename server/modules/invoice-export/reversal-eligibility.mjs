import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';

const uuid = z.string().uuid();
const command = z.object({
  expectedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/), reviewId: uuid, decisionId: uuid,
  confirmationId: uuid.nullable(), eligibleOn: z.string().date(), reason: z.string().trim().min(3).max(1000),
}).strict();
const fail = (statusCode, message) => Object.assign(new Error(message), {statusCode, code:'REVERSAL_ELIGIBILITY'});

export function registerReversalEligibility(router, { path, handle, inspect, envelope, audit }) {
  const route = path + '/eligibility';
  const load = async (c,r,write) => {
    const { existing, row } = await inspect(c,r,write,write ? 'issue-reversal' : 'reversal');
    if (!existing) throw fail(404,'Reversal request unavailable.');
    const source = (await c.query(
      `select s.id as "reviewId",v.final_decision as "decisionId",v.original_event as "originalEventId",v.confirmation as "confirmationId",
        v.currency,trim_scale(v.amount)::text amount from invoice_reversal_reviews s cross join lateral full_line_reversal_source(s.id) v
        where s.request_id=$1 and s.organization_id=$2 and s.legal_entity_id=$3`,[existing.id,row.organization_id,row.legal_entity_id],
    )).rows[0] ?? null;
    const receipt = source ? (await c.query(
      `select ev.id as "eventId",item.id as "itemId",ev.eligible_on::text as "eligibleOn",ev.currency,trim_scale(ev.amount)::text amount,
        ev.reversal_decision_id as "decisionId",ev.reverses_event_id as "originalEventId",ev.billing_evidence->>'confirmationId' as "confirmationId",
        ev.actor_id as "actorId",ev.active_role as "activeRole",a.reason
        from billing_eligibility_events ev join approved_unbilled_items item on item.event_id=ev.id
        join audit_logs a on a.entity_id=ev.id::text and a.operation_id=ev.operation_id and a.action='Issue Full Line Reversal'
        where ev.reversal_decision_id=$1 and ev.organization_id=$2 and ev.legal_entity_id=$3`,
      [source.decisionId,row.organization_id,row.legal_entity_id])).rows[0] ?? null : null;
    return { existing,row,source,receipt };
  };
  router.get(route,handle(false,async(c,r)=>{
    const {existing,source,receipt}=await load(c,r,false);
    return {...await envelope(c,r),requestId:existing.id,source,receipt};
  }));
  router.post(route,handle(true,async(c,r)=>{
    const parsed=command.safeParse(r.body);
    if (!parsed.success) throw fail(400,'Inspect the approved reversal and supply an issuance reason.');
    const d=parsed.data;
    if(d.expectedOwnerKey!==workApprovalOwner(r)) throw fail(409,'Account or scope changed.');
    const {existing,row,source,receipt}=await load(c,r,true);
    if(!source || source.reviewId!==d.reviewId || source.decisionId!==d.decisionId) throw fail(409,'Final reversal approval unavailable.');
    const context=await envelope(c,r);
    if(receipt){
      if(receipt.actorId!==r.user.sub || receipt.activeRole!==r.user.activeRole || receipt.reason!==d.reason ||
        receipt.eligibleOn!==d.eligibleOn || receipt.confirmationId!==d.confirmationId) throw fail(409,'A different issuance is recorded. Retrieve its receipt.');
      return {...context,requestId:existing.id,source,receipt,replayed:true};
    }
    if(context.serverDate!==d.eligibleOn || source.confirmationId!==d.confirmationId) throw fail(409,'Billing evidence or UTC eligibility date changed.');
    await c.query("select set_config('workos.reversal_issue_context',$1,true)",[JSON.stringify({
      actorId:r.user.sub,role:r.user.activeRole,org:row.organization_id,legal:row.legal_entity_id,operationId:r.operationId,
    })]);
    const eventId=randomUUID();
    await c.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,engagement_id,source_type,
      version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id,reverses_event_id,reversal_decision_id)
      select $1,organization_id,legal_entity_id,client_id,contract_id,engagement_id,'FULL_LINE_REVERSAL',1,$2,currency,amount,evidence,
      $3,$4,$5,original_event,final_decision from full_line_reversal_source($6)`,
      [eventId,d.eligibleOn,r.user.sub,r.user.activeRole,r.operationId,source.reviewId]);
    const itemId=(await c.query('select id from approved_unbilled_items where event_id=$1',[eventId])).rows[0].id;
    await audit(c,r,{module:'Invoice Corrections',action:'Issue Full Line Reversal',entityType:'Billing Eligibility Event',entityId:eventId,
      reason:d.reason,newValue:{itemId,decisionId:d.decisionId,originalEventId:source.originalEventId,currency:source.currency,amount:source.amount,eligibleOn:d.eligibleOn},
      details:'Issued an approved-unbilled credit against the original retained line.'});
    return {...context,requestId:existing.id,source,receipt:{eventId,itemId,eligibleOn:d.eligibleOn,currency:source.currency,amount:source.amount,
      decisionId:d.decisionId,originalEventId:source.originalEventId,confirmationId:d.confirmationId,actorId:r.user.sub,activeRole:r.user.activeRole,reason:d.reason},replayed:false};
  }));
}
