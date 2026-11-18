import { assertCommercialAuthority } from '../commercial-drafting/service.mjs';
import { milestoneInvoiceItemMatches } from '../../../shared/milestone-invoice-source.mjs';

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
// The invoice command retains its existing authority checks; milestone access
// is an additional requirement, never a substitute for them.
export const loadMilestoneInvoiceItem = async (c, r, batchId, itemId, lock = false) => {
  await assertCommercialAuthority(c, r, 'commercial.milestone_billing.view');
  const x = (
    await c.query(
      `select item.id as "itemId",item.version as "itemVersion",ev.id as "eventId",ev.client_id as "clientId",ev.contract_id as "contractId",ev.engagement_id as "engagementId",ev.currency,ev.eligible_on::text as "eligibleOn",ev.amount::text,ev.billing_evidence as evidence,milestone_invoice_item_current(b,item.id,$4,$5) as current from approved_unbilled_items item join billing_eligibility_events ev on ev.id=item.event_id and ev.source_type=item.source_type join invoice_draft_batches b on b.id=$6 and b.organization_id=item.organization_id and b.legal_entity_id=item.legal_entity_id where item.id=$1 and item.organization_id=$2 and item.legal_entity_id=$3 and item.source_type='MILESTONE_ACCEPTANCE'${lock ? ' for share of item,ev' : ''}`,
      [
        itemId,
        r.organizationScope.organizationId,
        r.organizationScope.legalEntityId,
        r.user.sub,
        r.user.activeRole,
        batchId,
      ],
    )
  ).rows[0];
  if (!x) throw fail(404, 'INVOICE_DRAFT_SOURCE', 'Scoped approved-unbilled milestone item unavailable.');
  return { ...x, sourceType: 'MILESTONE_ACCEPTANCE', snapshotId: null };
};
export const milestoneInvoiceAcquisitionAllowed = (draft, item) =>
  milestoneInvoiceItemMatches(draft, {
    sourceType: item.sourceType,
    itemId: item.itemId,
    itemVersion: item.itemVersion,
    eventId: item.eventId,
    clientId: item.clientId,
    contractId: item.contractId,
    engagementId: item.engagementId,
    currency: item.currency,
    eligibleOn: item.eligibleOn,
    amount: item.amount,
    current: item.current,
    evidence: item.evidence,
  });
