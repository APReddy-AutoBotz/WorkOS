import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { setWorkApprovalContext, workApprovalOwner } from '../approvals/work-approval-service.mjs';

const uuid = z.string().uuid();
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode, code: 'REVERSAL_DECISION' });
const command = z.object({ expectedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/), expectedSequence: z.number().int().min(0).max(9),
  policyId: uuid, confirmationId: uuid.nullable(), decision: z.enum(['Approved','Rejected']), reason: z.string().trim().min(3).max(1000) }).strict();

async function inspect(c, r, write) {
  if (!uuid.safeParse(r.params.id).success || Object.keys(r.query).length) throw fail(400, 'Choose a reversal review.');
  const args = [r.params.id,r.organizationScope.organizationId,r.organizationScope.legalEntityId,r.user.sub,r.user.activeRole];
  const { rows } = await c.query(
    `select s.id,s.policy_id as "policyId",p.definition->'stages' as stages,s.request_id as "requestId",
      l.batch_id as "batchId",l.id as "lineId",l.item_id as "itemId",l.source_type as "sourceType",l.currency,
      to_jsonb(r)->>'adjustment_kind' as kind,trim_scale(coalesce((to_jsonb(r)->>'requested_amount')::numeric,l.amount))::text amount,r.reason as "requestReason",a.id as "artifactId",a.sha256,
      cf.id as "confirmationId",cf.external_reference as "externalReference",
      reversal_review_actor_visible(s.id,$4,$5,true) as "deciderAuthority"
     from invoice_reversal_reviews s join invoice_batch_approval_policies p on p.id=s.policy_id
     join invoice_line_reversal_requests r on r.id=s.request_id join invoice_draft_lines l on l.id=r.line_id
     join invoice_csv_artifacts a on a.id=r.artifact_id left join invoice_batch_confirmations cf on cf.artifact_id=a.id
     where s.id=$1 and s.organization_id=$2 and s.legal_entity_id=$3 and (
       (s.reviewer_id=$4 and s.reviewer_role=$5 and reversal_review_actor_visible(s.id,$4,$5,true)) or exists (
        select 1 from invoice_reversal_decision_notices n join invoice_reversal_decisions d on d.id=n.decision_id
        where d.review_id=s.id and n.recipient_id=$4 and n.channel in ('Required','Enabled')
        and (n.required_role is null or n.required_role=$5) and reversal_review_actor_visible(s.id,$4,$5,n.required_role is not null)))
     ` + (write ? 'for update of s' : ''), args);
  if (!rows.length) throw fail(404, 'Review unavailable in this role and scope.');
  const { stages, deciderAuthority, ...source } = rows[0];
  const decisions = (await c.query(
    'select id,sequence,decision,actor_id as "actorId",active_role as "activeRole",reason,confirmation_id as "confirmationId",created_at as "createdAt" from invoice_reversal_decisions where review_id=$1 order by sequence',
    [source.id])).rows;
  const status = decisions.some(d => d.decision === 'Rejected') ? 'Rejected' : decisions.length === stages.length ? 'Approved' : 'Pending';
  const next = stages[decisions.length];
  const assigned = Boolean(status === 'Pending' && deciderAuthority && next?.userId.toLowerCase() === r.user.sub.toLowerCase() && next.role === r.user.activeRole);
  const canDecide = assigned && (!['RETAINER_PERIOD','MANAGED_SERVICE_UNIT','MANAGED_SERVICE_PERIOD','FIXED_FEE_INSTALLMENT'].includes(source.sourceType) || (await c.query(
    `select invoice_reversal_participants_valid(b.source_type,i) and s.retainer_link_generations=invoice_review_link_generations(i) as current
     from invoice_reversal_reviews s join invoice_draft_batches b on b.id=$2
     cross join lateral retainer_reversal_participants(b,s.actor_id,s.active_role,s.policy_id) i where s.id=$1`,
    [source.id,source.batchId],
  )).rows[0]?.current === true);
  return { ...source, decisions, status, canDecide, stageCount: stages.length };
}

export function registerReversalDecisions(router, { handle, requirePermission, audit }) {
  const path = '/reversal-reviews/:id';
  router.get(path, requirePermission('notifications.view'), handle(false, async (c, r) => ({ review: await inspect(c, r, false) })));
  router.post(path + '/decisions', requirePermission('notifications.view'), requirePermission('approvals.view'),
    requirePermission('commercial.invoice_approval.decide'), handle(true, async (c, r) => {
    const parsed = command.safeParse(r.body);
    if (!parsed.success) throw fail(400, 'Inspect the reversal and enter a decision and reason.');
    const d = parsed.data;
    if (d.expectedOwnerKey !== workApprovalOwner(r)) throw fail(409, 'Account or scope changed.');
    const review = await inspect(c, r, true);
    if (review.policyId !== d.policyId) throw fail(409, 'Review policy changed.');
    const previous = review.decisions[d.expectedSequence];
    if (previous) {
      if (previous.actorId !== r.user.sub || previous.activeRole !== r.user.activeRole || previous.reason !== d.reason ||
        previous.decision !== d.decision || previous.confirmationId !== d.confirmationId) throw fail(409, 'This stage already has a different decision.');
      return { review, replayed: true };
    }
    if (!review.canDecide || review.decisions.length !== d.expectedSequence || review.confirmationId !== d.confirmationId)
      throw fail(409, 'Stage or billing evidence changed. Inspect again.');
    await setWorkApprovalContext(c, r);
    const decisionId = randomUUID(), sequence = d.expectedSequence + 1;
    await c.query('insert into invoice_reversal_decisions(id,review_id,sequence,decision,actor_id,active_role,reason,confirmation_id,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [decisionId,review.id,sequence,d.decision,r.user.sub,r.user.activeRole,d.reason,d.confirmationId,r.operationId]);
    await audit(c, r, { module: 'Invoice Corrections', action: review.kind ? 'Decide Charge Adjustment' : 'Decide Full Line Reversal', entityType: 'Invoice Reversal Decision',
      entityId: decisionId,reason:d.reason,newValue:{reviewId:review.id,sequence,decision:d.decision,confirmationId:d.confirmationId},
      details:'Recorded an independent reversal decision against the inspected export.' });
    return { status:201,body:{ review: await inspect(c,r,false), replayed:false } };
  }));
}
