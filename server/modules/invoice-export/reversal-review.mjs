import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';

const command = z.object({
  expectedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
  policyId: z.string().uuid(),
  inspectedState: z.enum(['Exported', 'Billed/Confirmed']),
}).strict();
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode, code: 'REVERSAL_REVIEW' });
const fields = 'id,request_id as "requestId",policy_id as "policyId",confirmation_id as "confirmationId",reviewer_id as "reviewerId",reviewer_role as "reviewerRole",created_at as "createdAt"';

export function registerReversalReview(router, { path, handle, inspect, envelope, audit }) {
  const load = async (c, r, write) => {
    const data = await inspect(c, r, write);
    if (!data.existing) throw fail(404, 'Reversal request unavailable.');
    const saved = await c.query(
      'select ' + fields + `,(select case when bool_or(d.decision='Rejected') then 'Rejected'
        when count(*)=jsonb_array_length(p.definition->'stages') then 'Approved' else 'Pending' end
        from invoice_reversal_decisions d where d.review_id=s.id) as state
       from invoice_reversal_reviews s join lateral (select definition from invoice_batch_approval_policies where id=s.policy_id) p on true
       where s.request_id=$1`, [data.existing.id]);
    return { ...data, review: saved.rows[0] ?? null };
  };
  const canSubmit = async (c, r, row, existing) => existing.actorId === r.user.sub && existing.activeRole === r.user.activeRole &&
    (await c.query("select invoice_batch_approval_actor_valid($1,$2,$3,$4,'submitter') permitted",
      [row.organization_id, row.legal_entity_id, r.user.sub, r.user.activeRole])).rows[0].permitted;
  router.get(path + '/review', handle(false, async (c, r) => {
    const { review, row, existing } = await load(c, r, false);
    return { ...(await envelope(c, r)), requestId: existing.id, review, canSubmit: await canSubmit(c, r, row, existing) };
  }));
  router.post(path + '/review', handle(true, async (c, r) => {
    const parsed = command.safeParse(r.body);
    if (!parsed.success) throw fail(400, 'Inspect the request, billing state and reversal policy.');
    const d = parsed.data;
    if (d.expectedOwnerKey !== workApprovalOwner(r)) throw fail(409, 'Account or scope changed.');
    const { existing, row, artifact, review } = await load(c, r, true);
    if (!await canSubmit(c, r, row, existing))
      throw fail(403, 'The original requester needs current submission authority.');
    if (existing.id !== d.requestId) throw fail(409, 'Reversal request changed.');
    if (review) {
      if (review.policyId !== d.policyId || (review.confirmationId ? 'Billed/Confirmed' : 'Exported') !== d.inspectedState)
        throw fail(409, 'A different submission is recorded. Read the original review.');
      return { ...(await envelope(c, r)), requestId: existing.id, review, replayed: true };
    }
    if ((artifact.confirmation ? 'Billed/Confirmed' : 'Exported') !== d.inspectedState)
      throw fail(409, 'Billing state changed. Inspect the batch again.');
    const deliveryId = randomUUID();
    const result = await c.query(
      `insert into invoice_reversal_reviews(id,organization_id,legal_entity_id,request_id,policy_id,confirmation_id,actor_id,
        active_role,reviewer_id,reviewer_role,delivery_id,operation_id)
       select $1,$2,$3,$4,p.id,$6,$7,$8,(p.definition->'stages'->0->>'userId')::uuid,
        p.definition->'stages'->0->>'role',$9,$10 from invoice_batch_approval_policies p
       where p.id=$5 and p.organization_id=$2 and p.legal_entity_id=$3 and p.engagement_id=$11 returning ` + fields,
      [randomUUID(),row.organization_id,row.legal_entity_id,existing.id,d.policyId,artifact.confirmation,r.user.sub,
        r.user.activeRole,deliveryId,r.operationId,row.engagement_id],
    );
    const submitted = result.rows[0];
    if (!submitted) throw fail(409, 'Review policy unavailable.');
    await audit(c, r, { module: 'Invoice Corrections', entityType: 'Invoice Reversal Review',
      action: 'Submit Full Line Reversal', entityId: submitted.id, reason: existing.reason,
      newValue: { requestId: existing.id, policyId: submitted.policyId, confirmationId: submitted.confirmationId,
        reviewerId: submitted.reviewerId, reviewerRole: submitted.reviewerRole, deliveryId },
      details: 'Submitted the retained reversal request to its first named reviewer.' });
    return { ...(await envelope(c, r)), requestId: existing.id, review: submitted, replayed: false };
  }));
}
