import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validInvoiceConfirmationCommand,
  invoiceConfirmationAllowed,
} from '../shared/invoice-billing-confirmation.mjs';
const command = {
    requestId: randomUUID(),
    batchId: randomUUID(),
    artifactId: randomUUID(),
    artifactVersion: 1,
    artifactSha256: 'a'.repeat(64),
    currency: 'USD',
    total: '125.15',
    reference: 'SYNTHETIC-EXTERNAL-REFERENCE',
    reason: 'Synthetic manual attestation',
  },
  source = {
    state: 'Exported',
    batchId: command.batchId,
    artifactId: command.artifactId,
    artifactVersion: 1,
    artifactSha256: command.artifactSha256,
    currency: command.currency,
    total: command.total,
  },
  actor = { active: true, heldRole: true, scopedSourceAccess: true, confirmationPermission: true };
assert(validInvoiceConfirmationCommand(command));
assert(invoiceConfirmationAllowed(command, source, actor));
for (const change of [
  { ...command, total: '125.1500' },
  { ...command, total: '0' },
  { ...command, reference: '' },
  { ...command, reference: '\u0001unsafe' },
  { ...command, reference: 'Synthetic\nreference' },
  { ...command, artifactVersion: 2 },
  { ...command, currency: 'usd' },
  { ...command, amount: '10' },
])
  assert.equal(validInvoiceConfirmationCommand(change), false);
for (const changed of [
  { ...source, state: 'Approved' },
  { ...source, state: 'Billed/Confirmed' },
  { ...source, total: '125.16' },
  { ...source, artifactSha256: 'b'.repeat(64) },
  { ...source, artifactId: randomUUID() },
])
  assert.equal(invoiceConfirmationAllowed(command, changed, actor), false);
for (const k of Object.keys(actor))
  assert.equal(invoiceConfirmationAllowed(command, source, { ...actor, [k]: false }), false);
console.log(
  'Scoped manual confirmation pins exact exported artifact and native totals without claiming provider verification.',
);
