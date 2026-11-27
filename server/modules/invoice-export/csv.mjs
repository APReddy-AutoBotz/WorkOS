import { createHash } from 'node:crypto';
import { createTmLineageCheck, invoiceDraftTotal } from '../../../shared/invoice-batch-draft.mjs';
import { validCapabilityDate } from '../../../shared/workforce-capabilities.mjs';
// Every free-form field is UTF-8/base64 with a fixed non-formula prefix. The
// schema preserves bytes reversibly while making spreadsheet interpretation
// independent of leading '=', '+', '-' or '@' in source data.
export const INVOICE_CSV_SCHEMA = 'workos.invoice-tm-csv/1';
const header = [
  'schema_version',
  'batch_id',
  'line_id',
  'line_sequence',
  'item_id',
  'item_version',
  'event_id',
  'snapshot_id',
  'billing_evidence_b64',
  'client_id_b64',
  'contract_id_b64',
  'engagement_id_b64',
  'work_date',
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
  text = (x) => typeof x === 'string' && x.length > 0,
  encoded = (x) => 'b64:' + Buffer.from(x, 'utf8').toString('base64'),
  amount = (x) => typeof x === 'string' && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(x) && /[1-9]/.test(x);
export const invoiceCsvArtifact = (source) => {
  if (
    !source ||
    !uuid(source.batchId) ||
    !text(source.clientId) ||
    !text(source.contractId) ||
    !text(source.engagementId) ||
    !/^[A-Z]{3}$/.test(source.currency) ||
    !validCapabilityDate(source.periodStart) ||
    !validCapabilityDate(source.periodEnd) ||
    source.periodStart > source.periodEnd ||
    !['WORK_DATE', 'ELIGIBLE_DATE'].includes(source.periodBasis) ||
    !Array.isArray(source.lines) ||
    source.lines.length === 0
  )
    throw new TypeError('Current approved invoice source is required.');
  const acceptLineage = createTmLineageCheck(),
    rows = [];
  for (const [index, x] of source.lines.entries()) {
    if (
      !x ||
      !uuid(x.lineId) ||
      !uuid(x.itemId) ||
      !uuid(x.eventId) ||
      !uuid(x.snapshotId) ||
      x.sequence !== index + 1 ||
      x.itemVersion !== 1 ||
      x.currency !== source.currency ||
      !amount(x.amount) ||
      invoiceDraftTotal([x.amount]).amount !== x.amount ||
      !validCapabilityDate(x.workDate) ||
      !validCapabilityDate(x.eligibleDate) ||
      (source.periodBasis === 'WORK_DATE' ? x.workDate : x.eligibleDate) < source.periodStart ||
      (source.periodBasis === 'WORK_DATE' ? x.workDate : x.eligibleDate) > source.periodEnd ||
      !text(x.evidenceJson) ||
      !acceptLineage(x)
    )
      throw new TypeError('Invoice line lineage or native amount is invalid.');
    let evidence;
    try {
      evidence = JSON.parse(x.evidenceJson);
    } catch {
      throw new TypeError('Retained evidence is invalid.');
    }
    if (
      !evidence ||
      evidence.snapshotId !== x.snapshotId ||
      evidence.engagementId !== source.engagementId ||
      evidence.workDate !== x.workDate ||
      evidence.currency !== x.currency ||
      !amount(evidence.amount) ||
      invoiceDraftTotal([evidence.amount]).amount !== invoiceDraftTotal([x.amount]).amount
    )
      throw new TypeError('Retained billing evidence does not match the line.');
    rows.push(
      [
        INVOICE_CSV_SCHEMA,
        source.batchId,
        x.lineId,
        String(x.sequence),
        x.itemId,
        String(x.itemVersion),
        x.eventId,
        x.snapshotId,
        encoded(x.evidenceJson),
        encoded(source.clientId),
        encoded(source.contractId),
        encoded(source.engagementId),
        x.workDate,
        x.eligibleDate,
        x.currency,
        x.amount,
        source.periodStart,
        source.periodEnd,
        source.periodBasis,
      ].join(','),
    );
  }
  const totals = invoiceDraftTotal(source.lines.map((x) => x.amount)),
    bytes = Buffer.from([header.join(','), ...rows, ''].join('\r\n'), 'utf8');
  return {
    schemaVersion: INVOICE_CSV_SCHEMA,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lineCount: totals.lineCount,
    total: totals.amount,
    currency: source.currency,
  };
};
