import { createHash } from 'node:crypto';
import { createInvoiceLineageCheck, invoiceDraftTotal } from '../../../shared/invoice-batch-draft.mjs';
import { milestoneInvoiceItemMatches } from '../../../shared/milestone-invoice-source.mjs';

// A new source-specific schema does not change bytes of historical T&M CSVs.
// Inputs must already be authorized, retained sources from the protected batch.
export const MILESTONE_INVOICE_CSV_SCHEMA = 'workos.invoice-milestone-csv/1';
const header = [
  'schema_version',
  'batch_id',
  'line_id',
  'line_sequence',
  'item_id',
  'item_version',
  'event_id',
  'source_type',
  'milestone_id_b64',
  'billing_evidence_b64',
  'client_id_b64',
  'contract_id_b64',
  'engagement_id_b64',
  'eligible_date',
  'currency',
  'amount',
  'period_start',
  'period_end',
  'period_basis',
];
const uuid = (x) =>
    typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x),
  encoded = (x) => 'b64:' + Buffer.from(x, 'utf8').toString('base64');
export const milestoneInvoiceCsvArtifact = (source) => {
  if (!source || !uuid(source.batchId) || !Array.isArray(source.lines) || !source.lines.length)
    throw new TypeError('Current approved milestone invoice source is required.');
  const acceptLineage = createInvoiceLineageCheck('milestoneId'),
    rows = [];
  for (const [index, line] of source.lines.entries()) {
    let evidence;
    try {
      evidence = JSON.parse(line.evidenceJson);
    } catch {
      throw new TypeError('Retained milestone evidence is invalid.');
    }
    const item = {
      sourceType: line.sourceType,
      itemId: line.itemId,
      itemVersion: line.itemVersion,
      eventId: line.eventId,
      clientId: source.clientId,
      contractId: source.contractId,
      engagementId: source.engagementId,
      currency: line.currency,
      eligibleOn: line.eligibleDate,
      amount: line.amount,
      current: true,
      evidence,
    };
    const draft = {
      clientId: source.clientId,
      contractId: source.contractId,
      engagementId: source.engagementId,
      currency: source.currency,
      periodStart: source.periodStart,
      periodEnd: source.periodEnd,
      periodBasis: source.periodBasis,
      ownerUserId: source.ownerUserId,
      ownerRole: source.ownerRole,
    };
    if (
      !uuid(line.lineId) ||
      line.sequence !== index + 1 ||
      !milestoneInvoiceItemMatches(draft, item) ||
      invoiceDraftTotal([line.amount]).amount !== line.amount ||
      !acceptLineage({lineId: line.lineId, itemId: line.itemId, eventId: line.eventId, milestoneId: evidence.milestoneId})
    )
      throw new TypeError('Milestone line lineage or native amount is invalid.');
    rows.push(
      [
        MILESTONE_INVOICE_CSV_SCHEMA,
        source.batchId,
        line.lineId,
        String(line.sequence),
        line.itemId,
        String(line.itemVersion),
        line.eventId,
        line.sourceType,
        encoded(evidence.milestoneId),
        encoded(line.evidenceJson),
        encoded(source.clientId),
        encoded(source.contractId),
        encoded(source.engagementId),
        line.eligibleDate,
        line.currency,
        line.amount,
        source.periodStart,
        source.periodEnd,
        source.periodBasis,
      ].join(','),
    );
  }
  const totals = invoiceDraftTotal(source.lines.map((x) => x.amount)),
    bytes = Buffer.from([header.join(','), ...rows, ''].join('\r\n'), 'utf8');
  return {
    schemaVersion: MILESTONE_INVOICE_CSV_SCHEMA,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lineCount: totals.lineCount,
    total: totals.amount,
    currency: source.currency,
  };
};
