import { z } from 'zod';
import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';

const filters = z.object({
  engagementId: z.string().trim().min(1).max(200),
  after: z.string().uuid().optional(),
}).strict();

export function registerIssuedCredits(router, { handle, authorize, envelope }) {
  router.get('/issued-credits', handle(false, async (client, req) => {
    await authorize(client, req, 'reversal');
    const query = filters.safeParse(req.query);
    if (!query.success) throw Object.assign(new Error('Select an engagement and valid credit cursor.'), { statusCode: 400, code: 'CREDIT_REGISTER_FILTER' });
    const { engagementId, after } = query.data;
    const { organizationId, legalEntityId } = req.organizationScope;
    const engagement = (await client.query(
      'select model from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=$3',
      [organizationId, legalEntityId, engagementId],
    )).rows[0];
    if (!engagement) throw Object.assign(new Error('Engagement unavailable.'), {statusCode:404, code:'CREDIT_REGISTER_SCOPE'});
    if (engagement.model === 'milestone') await assertCommercialAuthority(client, req, 'commercial.milestone_billing.view');
    const credits = (await client.query(
      `select item.id as "itemId", credit.id as "eventId", credit.eligible_on::text as "eligibleOn",
        credit.billing_evidence->>'adjustmentKind' as kind,credit.currency,trim_scale(credit.amount)::text amount, original.id as "originalEventId",
        line.id as "lineId", line.batch_id as "batchId", credit.reversal_decision_id as "decisionId", occ.batch_id as "correctionBatchId", case when occ.batch_id is not null then invoice_batch_governed_state(occ.batch_id) end as "correctionState",
        (select i.id from invoice_batch_approval_instances i where i.batch_id=occ.batch_id order by i.sequence desc limit 1) as "correctionReviewId"
       from billing_eligibility_events credit
       join approved_unbilled_items item on item.event_id=credit.id and item.source_type=credit.source_type
       left join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
       join billing_eligibility_events original on original.id=credit.reverses_event_id
       join invoice_draft_lines line on line.id=(credit.billing_evidence->>'originalLineId')::uuid and line.event_id=original.id
       where credit.organization_id=$1 and credit.legal_entity_id=$2 and credit.engagement_id=$3
         and credit.source_type in ('FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and ($6::uuid is null or item.id>$6)
         and not exists(select 1 from invoice_draft_lines member where member.batch_id=line.batch_id
           and invoice_source_line_visible($1,$2,member.batch_id,member.item_id,$4,$5) is not true)
       order by item.id limit 51`,
      [organizationId,legalEntityId,engagementId,req.user.sub,req.user.activeRole,after ?? null],
    )).rows;
    const page = credits.slice(0,50);
    return { ...await envelope(client,req), engagementId, credits:page.map(({kind,...credit})=>kind?{...credit,kind}:credit), nextAfter:credits.length>50 ? page.at(-1).itemId : null };
  }));
}
