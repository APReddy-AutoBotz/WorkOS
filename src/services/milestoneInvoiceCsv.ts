import {fixedFeeLine,retainerInvoiceEvidence,serviceUnitInvoiceEvidence,servicePeriodInvoiceEvidence} from './invoiceDrafts';
import { z } from 'zod';
import { createInvoiceLineageCheck, invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
import { canonicalHours } from '../../shared/work-hours.mjs';
import { milestoneInvoiceEvidence, milestoneEvidenceMatches } from './milestoneInvoiceContracts';

const uuid = z.string().uuid(),
  date = z.string().date(),
  id = z.string().trim().min(1).max(200),
  money = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
const header =
  'schema_version,batch_id,line_id,line_sequence,item_id,item_version,event_id,source_type,milestone_id_b64,billing_evidence_b64,client_id_b64,contract_id_b64,engagement_id_b64,eligible_date,currency,amount,period_start,period_end,period_basis';
const decode = (value: string) => {
  const raw = atob(value);
  if (btoa(raw) !== value) throw Error('Noncanonical base64');
  return Uint8Array.from(raw, (x) => x.charCodeAt(0));
};
const field = (value: string) => {
  if (!value.startsWith('b64:') || value.length === 4) throw Error('Missing encoded field');
  return new TextDecoder('utf-8', { fatal: true }).decode(decode(value.slice(4)));
};

// This verifies retained bytes and their declared controls, not server authority.
type ArtifactMetadata = {
  schemaVersion: string;
  batchId: string;
  payloadBase64: string;
  sha256: string;
  lineCount: number;
  currency: string;
  total: string;
};
const contractFormats = {
  milestone: { schema: 'workos.invoice-milestone-csv/1', header, source: 'MILESTONE_ACCEPTANCE' },
  retainer: { schema: 'workos.invoice-retainer-csv/1', header: header.replace('milestone_id_b64', 'statement_id') + ',event_version', source: 'RETAINER_PERIOD' },
  fixed_fee: {schema:'workos.invoice-fixed-fee-csv/2',header:header.replace('milestone_id_b64','contract_version_id_b64')+',event_version',source:'FIXED_FEE_INSTALLMENT'},
  service_period: { schema:'workos.invoice-service-period-csv/1', header: header.replace('milestone_id_b64','period_review_id')+',event_version', source:'MANAGED_SERVICE_PERIOD' },
  service_unit: { schema: 'workos.invoice-service-unit-csv/1', header: header.replace('milestone_id_b64', 'evidence_id') + ',event_version', source: 'MANAGED_SERVICE_UNIT' },
} as const;

const scaledToFourPlaces = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(4, '0'));
};

const verifyContractCsv = async (a: ArtifactMetadata, kind: keyof typeof contractFormats) => {
  const format = contractFormats[kind];
  const hasEventVersion = kind !== 'milestone';
  if (
    a.schemaVersion !== format.schema ||
    !uuid.safeParse(a.batchId).success ||
    !Number.isInteger(a.lineCount) ||
    a.lineCount < 1 ||
    !/^[A-Z]{3}$/.test(a.currency) ||
    !money.safeParse(a.total).success
  )
    throw Error('Invalid invoice artifact metadata');
  const bytes = decode(a.payloadBase64),
    digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  if (digest !== a.sha256) throw Error('Checksum mismatch');
  const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\r\n');
  if (rows[0] !== format.header || rows.at(-1) !== '' || rows.length !== a.lineCount + 2)
    throw Error('Invalid invoice CSV shape');
  const acceptLineage = createInvoiceLineageCheck(kind === 'milestone' ? 'milestoneId' : null),
    amounts: string[] = [];
  let sourceIdentity: string | null = null;
  for (const [n, row] of rows.slice(1, -1).entries()) {
    const c = row.split(',');
    if (
      c.length !== (hasEventVersion ? 20 : 19) || (hasEventVersion && c[19] !== '1') ||
      c[0] !== a.schemaVersion ||
      c[1] !== a.batchId ||
      !uuid.safeParse(c[2]).success ||
      c[3] !== String(n + 1) ||
      !uuid.safeParse(c[4]).success ||
      c[5] !== '1' ||
      !uuid.safeParse(c[6]).success ||
      c[7] !== format.source ||
      !date.safeParse(c[13]).success ||
      c[14] !== a.currency ||
      !money.safeParse(c[15]).success ||
      !date.safeParse(c[16]).success ||
      !date.safeParse(c[17]).success ||
      c[16] > c[17] ||
      c[18] !== 'ELIGIBLE_DATE' ||
      c[13] < c[16] ||
      c[13] > c[17]
    )
      throw Error('Invalid invoice line');
    const milestone = kind === 'milestone' ? field(c[8]) : null;
    if (!acceptLineage({lineId: c[2], itemId: c[4], eventId: c[6], milestoneId: milestone}))
      throw Error('Repeated invoice lineage');
    const rawEvidence=JSON.parse(field(c[9])),client=field(c[10]),contract=field(c[11]),engagement=field(c[12]);
    if (![client,contract,engagement].every(value=>id.safeParse(value).success)) throw Error('Invalid contract scope');
    if (kind === 'fixed_fee') {
      const e=fixedFeeLine.shape.evidence.parse(rawEvidence);
      if (e.contractVersionId!==field(c[8]) || e.engagementId!==engagement || e.dueOn>c[13] ||
          e.currency!==c[14] || canonicalHours(e.amount)!==canonicalHours(c[15])) throw Error('Installment evidence mismatch');
    } else if (kind === 'service_period') {
      const e=servicePeriodInvoiceEvidence.extend({contractualAmount:money,contractualCurrency:z.string().regex(/^[A-Z]{3}$/)}).parse(rawEvidence);
      if (e.reviewId!==c[8] || e.engagementId!==engagement || e.startsOn>e.endsOn || e.endsOn>=c[13] ||
          e.contractualCurrency!==c[14] || canonicalHours(e.contractualAmount)!==canonicalHours(c[15]))
        throw Error('Fixed-period contract evidence mismatch');
    } else if (kind === 'service_unit') {
      const e=serviceUnitInvoiceEvidence.parse(rawEvidence);
      const divisor=10n**BigInt(8-e.billingPrecision);
      const rounded=(scaledToFourPlaces(e.unitPrice)*scaledToFourPlaces(e.quantity)+divisor/2n)/divisor;
      if(e.evidenceId!==c[8] || e.engagementId!==engagement || e.priceEffectiveFrom>e.serviceDate || e.serviceDate>c[13] ||
        rounded*10n**BigInt(4-e.billingPrecision)!==scaledToFourPlaces(c[15])) throw Error('Service charge evidence mismatch');
    } else if (kind === 'retainer') {
      const e=retainerInvoiceEvidence.parse(rawEvidence);
      const components=[e.periodPrice.baseFee,e.periodPrice.overage].filter(v=>/[1-9]/.test(v));
      if (e.statementId!==c[8] || e.engagementId!==engagement || e.startsOn>e.endsOn || e.endsOn>=c[13] ||
        invoiceDraftTotal(components).amount!==canonicalHours(c[15]) || canonicalHours(e.periodPrice.total)!==canonicalHours(c[15]))
        throw Error('Retainer evidence mismatch');
    } else {
      const e=milestoneInvoiceEvidence.parse(rawEvidence);
      if (!id.safeParse(milestone).success || e.milestoneId!==milestone || !milestoneEvidenceMatches(e,engagement,c[14],c[15]))
        throw Error('Milestone evidence mismatch');
    }
    const identity = JSON.stringify([client, contract, engagement, ...c.slice(16, 19)]);
    if (sourceIdentity !== null && sourceIdentity !== identity) throw Error('Mixed source scope');
    sourceIdentity = identity;
    amounts.push(c[15]);
  }
  const total = invoiceDraftTotal(amounts);
  if (total.lineCount !== a.lineCount || canonicalHours(total.amount) !== canonicalHours(a.total))
    throw Error('Control total mismatch');
  return bytes;
};

export const verifyMilestoneInvoiceCsv=(a:ArtifactMetadata)=>verifyContractCsv(a,'milestone');
export const verifyRetainerInvoiceCsv=(a:ArtifactMetadata)=>verifyContractCsv(a,'retainer');

export const verifyServiceInvoiceCsv=(a:ArtifactMetadata)=>verifyContractCsv(a,'service_unit');

export const verifyFixedFeeInvoiceCsv=(a:ArtifactMetadata)=>verifyContractCsv(a,'fixed_fee');
export const verifyPeriodInvoiceCsv=(a:ArtifactMetadata)=>verifyContractCsv(a,'service_period');
