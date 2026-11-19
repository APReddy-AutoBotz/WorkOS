import { approvalEventIdentity, renderApprovalTemplate } from '../../../shared/work-approval.mjs';
export async function reversalDecisionInboxRows(c,r,{after=null,id=null}={}) {
  if (!(await c.query("select to_regclass('public.invoice_reversal_decision_notices') available")).rows[0]?.available) return [];
  const {rows}=await c.query(`select n.id,s.id as "instanceId",l.batch_id as "batchId",d.sequence as "transitionSequence",n.event_key as "eventKey",
    s.policy_id as "templateId",d.operation_id as "operationId",n.reasons,n.channel as "channelDecision",n.delivery_id as "deliveryId",
    d.created_at as "createdAt",rd.read_at as "readAt",s.request_id,p.definition
    from invoice_reversal_decision_notices n join invoice_reversal_decisions d on d.id=n.decision_id
    join invoice_reversal_reviews s on s.id=d.review_id join invoice_line_reversal_requests req on req.id=s.request_id
    join invoice_draft_lines l on l.id=req.line_id join invoice_batch_approval_policies p on p.id=s.policy_id
    left join invoice_reversal_decision_reads rd on rd.recipient_id=n.id and rd.user_id=$1
    where n.recipient_id=$1 and (n.required_role is null or n.required_role=$2) and s.organization_id=$3 and s.legal_entity_id=$4
      and n.channel in ('Required','Enabled') and reversal_decision_notice_visible(n,$1,$2)
      and ($5::uuid is null or n.id>$5) and ($6::uuid is null or n.id=$6) order by n.id limit 21`,
    [r.user.sub,r.user.activeRole,r.organizationScope.organizationId,r.organizationScope.legalEntityId,after,id]);
  return rows.map(({definition,request_id,...row})=>({
    ...row, reasons:row.reasons.sort(),kind:'invoice-reversal-decision',locale:definition.locale,deliveryStatus:'Delivered',
    policyClass:row.eventKey==='approval.completed'?'INFORMATIONAL':'ACTION_REQUIRED',
    eventId:approvalEventIdentity(row.instanceId,row.transitionSequence,row.eventKey,row.operationId).replace(/^work-approval\//,'invoice-reversal-decision/'),
    ...renderApprovalTemplate(definition.templates.find(t=>t.key===row.eventKey),{sourceRef:'invoice-line-reversal/'+request_id,
      stageNumber:String(row.transitionSequence+(row.eventKey==='approval.action_required'?1:0)),workerCode:'',decisionReason:''}),
  }));
}
