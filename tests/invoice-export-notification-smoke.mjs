import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  INVOICE_EXPORT_EVENT_KEYS,
  validInvoiceExportNotificationPolicy,
  invoiceExportRecipients,
  renderInvoiceExportNotice,
} from '../shared/invoice-export-notification.mjs';
const finance = { userId: randomUUID(), role: 'Finance' },
  admin = { userId: randomUUID(), role: 'IntegrationAdmin' },
  owner = { userId: finance.userId, role: 'Finance' },
  policy = {
    entityType: 'InvoiceExport',
    engagementId: 'synthetic-engagement',
    financeOwner: finance,
    integrationAdmin: admin,
    alertRouteId: randomUUID(),
    locale: 'en-US',
    templates: INVOICE_EXPORT_EVENT_KEYS.map((key) => ({
      key,
      subject: 'Invoice {{sourceRef}}',
      body: 'Synthetic status for {{sourceRef}}',
    })),
    completionInApp: false,
  };
assert(validInvoiceExportNotificationPolicy(policy));
const failure = invoiceExportRecipients(INVOICE_EXPORT_EVENT_KEYS[0], owner, policy);
assert.deepEqual(failure.find((x) => x.userId === finance.userId).reasons, [
  'finance_billing_owner',
  'invoice_batch_owner',
]);
assert.deepEqual(failure.find((x) => x.userId === admin.userId).reasons, ['integration_administrator']);
assert.equal(invoiceExportRecipients(INVOICE_EXPORT_EVENT_KEYS[1], owner, policy).length, 1);
assert.equal(
  renderInvoiceExportNotice(policy, INVOICE_EXPORT_EVENT_KEYS[1], randomUUID()).title.startsWith(
    'Invoice invoice-batch/',
  ),
  true,
);
for (const bad of [
  { ...policy, financeOwner: null },
  { ...policy, integrationAdmin: { ...admin, role: '' } },
  { ...policy, alertRouteId: 'https://example.test' },
  { ...policy, templates: [policy.templates[0], policy.templates[0]] },
  { ...policy, templates: policy.templates.map((t) => ({ ...t, body: 'Amount {{amount}}' })) },
  { ...policy, completionInApp: 'false' },
  { ...policy, recipients: [] },
])
  assert.equal(validInvoiceExportNotificationPolicy(bad), false);
assert.throws(() =>
  invoiceExportRecipients(
    INVOICE_EXPORT_EVENT_KEYS[0],
    { userId: randomUUID(), role: 'Finance', email: 'synthetic@example.test' },
    policy,
  ),
);
console.log(
  'Explicit invoice export notification configuration, recipient reasons and sanitized templates passed.',
);
