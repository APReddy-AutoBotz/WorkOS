import { approvalEventIdentity, renderApprovalTemplate } from '../../../shared/work-approval.mjs';

export async function reversalReviewInboxRows(c, r, { after = null, id = null } = {}) {
  if (!(await c.query("select to_regclass('public.invoice_reversal_reviews') available")).rows[0].available) return [];
  const { rows } = await c.query(
    `select s.id,s.id as "instanceId",l.batch_id as "batchId",s.request_id as request,p.definition,
       s.policy_id as "templateId",s.operation_id as "operationId",s.delivery_id as "deliveryId",
       s.created_at as "createdAt",rd.read_at as "readAt"
     from invoice_reversal_reviews s join invoice_batch_approval_policies p on p.id=s.policy_id
     join invoice_line_reversal_requests req on req.id=s.request_id join invoice_draft_lines l on l.id=req.line_id
     left join invoice_reversal_review_reads rd on rd.recipient_id=s.id and rd.user_id=s.reviewer_id
     where s.reviewer_id=$1 and s.reviewer_role=$2 and s.organization_id=$3 and s.legal_entity_id=$4
       and ($5::uuid is null or s.id>$5) and ($6::uuid is null or s.id=$6)
       and invoice_batch_approval_actor_valid($3,$4,$1,$2,'decider')
       and not exists(select 1 from invoice_draft_lines x where x.batch_id=l.batch_id and
         invoice_source_line_visible($3,$4,x.batch_id,x.item_id,$1,$2) is not true)
     order by s.id limit 21`,
    [r.user.sub,r.user.activeRole,r.organizationScope.organizationId,r.organizationScope.legalEntityId,after,id],
  );
  return rows.map(({ definition, request, ...row }) => {
    const eventKey = 'approval.action_required';
    const template = definition.templates.find(t => t.key === eventKey);
    return { ...row, ...renderApprovalTemplate(template, {
      sourceRef: 'invoice-line-reversal/' + request, stageNumber: '1', decisionReason: '', workerCode: '',
    }), kind: 'invoice-reversal-review', locale: definition.locale, transitionSequence: 0, eventKey,
      eventId: approvalEventIdentity(row.id, 0, eventKey, row.operationId).replace(/^work-approval\//,'invoice-reversal-review/'),
      policyClass: 'ACTION_REQUIRED', reasons: ['current_stage_approver'], channelDecision: 'Required', deliveryStatus: 'Delivered' };
  });
}
