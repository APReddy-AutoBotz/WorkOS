import {renderCreditCsv,verifyCreditCsv} from '../shared/correction-invoice-csv.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { invoiceCsvArtifact, INVOICE_CSV_SCHEMA } from '../server/modules/invoice-export/csv.mjs';
const batchId = randomUUID(),
  snapshotId = randomUUID(),
  evidence = {
    snapshotId,
    engagementId: '=synthetic-engagement',
    workDate: '2026-10-28',
    currency: 'USD',
    amount: '125.1500',
    source: 'Synthetic, "retained"\nwork',
  },
  line = {
    lineId: randomUUID(),
    sequence: 1,
    itemId: randomUUID(),
    itemVersion: 1,
    eventId: randomUUID(),
    snapshotId,
    currency: 'USD',
    amount: '125.15',
    workDate: '2026-10-28',
    eligibleDate: '2026-10-28',
    evidenceJson: JSON.stringify(evidence),
  },
  source = {
    batchId,
    clientId: '=synthetic-client',
    contractId: '@synthetic-contract',
    engagementId: evidence.engagementId,
    currency: 'USD',
    periodStart: '2026-10-28',
    periodEnd: '2026-10-28',
    periodBasis: 'WORK_DATE',
    lines: [line],
  },
  a = invoiceCsvArtifact(source),
  b = invoiceCsvArtifact(source);
assert.equal(a.schemaVersion, INVOICE_CSV_SCHEMA);
assert.deepEqual(a.bytes, b.bytes);
assert.equal(a.sha256, createHash('sha256').update(a.bytes).digest('hex'));
assert.equal(a.lineCount, 1);
assert.equal(a.total, '125.15');
const records = a.bytes.toString('utf8').split('\r\n');
assert.equal(records.length, 3);
const cells = records[1].split(',');
assert.equal(Buffer.from(cells[8].slice(4), 'base64').toString('utf8'), line.evidenceJson);
assert.equal(Buffer.from(cells[9].slice(4), 'base64').toString('utf8'), source.clientId);
assert(cells.every((x) => !['=', '+', '-', '@'].includes(x[0])));
assert.throws(() => invoiceCsvArtifact({ ...source, lines: [line, { ...line, sequence: 2 }] }));
assert.throws(() => invoiceCsvArtifact({ ...source, lines: [{ ...line, amount: '125.16' }] }));
assert.throws(() => invoiceCsvArtifact({ ...source, lines: [{ ...line, currency: 'EUR' }] }));
assert.throws(() => invoiceCsvArtifact({ ...source, lines: [{ ...line, workDate: '2026-02-30' }] }));
assert.throws(() => invoiceCsvArtifact({ ...source, periodStart: '2026-10-29' }));
assert.throws(() => invoiceCsvArtifact({ ...source, periodBasis: 'UNSPECIFIED' }));
assert.throws(() => invoiceCsvArtifact({ ...source, lines: [] }));
console.log('Deterministic invoice CSV source lineage, exact totals and reversible safe fields passed.');

const creditLine={lineId:randomUUID(),sequence:1,itemId:randomUUID(),itemVersion:1,eventId:randomUUID(),eventVersion:1,
  eligibleDate:'2026-10-28',currency:'USD',amount:'-0.0001',decisionId:randomUUID(),originalBatchId:randomUUID(),
  originalArtifactId:randomUUID(),originalArtifactSha256:'1'.repeat(64),originalLineId:randomUUID(),originalEventId:randomUUID(),originalItemVersion:1};
const credits={batchId:randomUUID(),periodStart:'2026-10-28',periodEnd:'2026-10-28',currency:'USD',clientId:'=Synthetic client',contractId:'Δ,1',engagementId:'Synthetic',lines:[creditLine,
  {...creditLine,sequence:2,lineId:randomUUID(),itemId:randomUUID(),eventId:randomUUID(),decisionId:randomUUID(),originalLineId:randomUUID(),originalEventId:randomUUID(),amount:'-9999999999999999.9999'}]};
const renderedCredit=renderCreditCsv(credits);
assert.equal(renderedCredit.total,'-10000000000000000');
assert.equal(renderedCredit.text.includes(credits.clientId),false);
const expectedCredit={...renderedCredit,batchId:credits.batchId};
verifyCreditCsv(renderedCredit.text,expectedCredit);
for(const changed of [renderedCredit.text.replace('-0.0001','-0.0002'),renderedCredit.text.replace('-0.0001','=1+1'),
  renderedCredit.text.replace(creditLine.originalArtifactSha256,'a'.repeat(64)),renderedCredit.text.replace(creditLine.lineId,'invalid')]){
  assert.throws(()=>verifyCreditCsv(changed,expectedCredit));
}
