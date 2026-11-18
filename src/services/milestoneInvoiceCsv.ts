import { z } from 'zod';
import { invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
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
export const verifyMilestoneInvoiceCsv = async (a: {
  schemaVersion: string;
  batchId: string;
  payloadBase64: string;
  sha256: string;
  lineCount: number;
  currency: string;
  total: string;
}) => {
  if (
    a.schemaVersion !== 'workos.invoice-milestone-csv/1' ||
    !uuid.safeParse(a.batchId).success ||
    !Number.isInteger(a.lineCount) ||
    a.lineCount < 1 ||
    !/^[A-Z]{3}$/.test(a.currency) ||
    !money.safeParse(a.total).success
  )
    throw Error('Invalid milestone artifact metadata');
  const bytes = decode(a.payloadBase64),
    digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  if (digest !== a.sha256) throw Error('Checksum mismatch');
  const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\r\n');
  if (rows[0] !== header || rows.at(-1) !== '' || rows.length !== a.lineCount + 2)
    throw Error('Invalid milestone CSV shape');
  const seen = new Set<string>(),
    amounts: string[] = [];
  let sourceIdentity: string | null = null;
  for (const [n, row] of rows.slice(1, -1).entries()) {
    const c = row.split(',');
    if (
      c.length !== 19 ||
      c[0] !== a.schemaVersion ||
      c[1] !== a.batchId ||
      !uuid.safeParse(c[2]).success ||
      c[3] !== String(n + 1) ||
      !uuid.safeParse(c[4]).success ||
      c[5] !== '1' ||
      !uuid.safeParse(c[6]).success ||
      c[7] !== 'MILESTONE_ACCEPTANCE' ||
      seen.has(c[4]) ||
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
      throw Error('Invalid milestone line');
    seen.add(c[4]);
    const milestone = field(c[8]),
      e = milestoneInvoiceEvidence.safeParse(JSON.parse(field(c[9]))),
      client = field(c[10]),
      contract = field(c[11]),
      engagement = field(c[12]);
    if (
      !e.success ||
      !id.safeParse(milestone).success ||
      !id.safeParse(client).success ||
      !id.safeParse(contract).success ||
      !id.safeParse(engagement).success ||
      e.data.milestoneId !== milestone ||
      !milestoneEvidenceMatches(e.data, engagement, c[14], c[15])
    )
      throw Error('Milestone evidence mismatch');
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
