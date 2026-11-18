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
