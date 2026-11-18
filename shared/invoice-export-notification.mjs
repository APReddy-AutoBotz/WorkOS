import { approvalKeys, approvalText, approvalUuid } from './work-approval.mjs';
export const INVOICE_EXPORT_EVENT_KEYS = [
  'invoice_batch.export_failed',
  'invoice_batch.exported_or_billed_confirmed',
];
const named = (x) =>
  approvalKeys(x, ['userId', 'role']) && approvalUuid(x.userId) && approvalText(x.role, 100);
const template = (t) =>
  approvalKeys(t, ['key', 'subject', 'body']) &&
  INVOICE_EXPORT_EVENT_KEYS.includes(t.key) &&
  approvalText(t.subject, 200) &&
  approvalText(t.body, 8000) &&
  [t.subject, t.body].every((s) => !/[{}]/u.test(s.replaceAll('{{sourceRef}}', '')));
// These values describe prospective configuration only. Database and API code
// must still resolve the route and current held, scoped identities independently.
export const validInvoiceExportNotificationPolicy = (d) => {
  try {
    return (
      approvalKeys(d, [
        'entityType',
        'engagementId',
        'financeOwner',
        'integrationAdmin',
        'alertRouteId',
        'locale',
        'templates',
        'completionInApp',
      ]) &&
      d.entityType === 'InvoiceExport' &&
      approvalText(d.engagementId) &&
      named(d.financeOwner) &&
      named(d.integrationAdmin) &&
      approvalUuid(d.alertRouteId) &&
      typeof d.locale === 'string' &&
      Intl.getCanonicalLocales(d.locale)[0] === d.locale &&
      typeof d.completionInApp === 'boolean' &&
      Array.isArray(d.templates) &&
      d.templates.length === 2 &&
      d.templates.every(template) &&
      new Set(d.templates.map((x) => x.key)).size === 2
    );
  } catch {
    return false;
  }
};
export const invoiceExportRecipients = (key, owner, policy) => {
  if (
    !INVOICE_EXPORT_EVENT_KEYS.includes(key) ||
    !named(owner) ||
    !validInvoiceExportNotificationPolicy(policy)
  )
    throw new TypeError('Valid retained relationships and explicit configuration are required.');
  const rows = [
      [owner.userId, 'invoice_batch_owner'],
      [policy.financeOwner.userId, 'finance_billing_owner'],
      ...(key === 'invoice_batch.export_failed'
        ? [[policy.integrationAdmin.userId, 'integration_administrator']]
        : []),
    ],
    map = new Map();
  for (const [userId, reason] of rows) {
    const set = map.get(userId) ?? new Set();
    set.add(reason);
    map.set(userId, set);
  }
  return [...map]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([userId, reasons]) => ({ userId, reasons: [...reasons].sort() }));
};
export const renderInvoiceExportNotice = (policy, key, batchId) => {
  if (
    !validInvoiceExportNotificationPolicy(policy) ||
    !approvalUuid(batchId) ||
    !INVOICE_EXPORT_EVENT_KEYS.includes(key)
  )
    throw new TypeError('Valid invoice event configuration is required.');
  const t = policy.templates.find((x) => x.key === key),
    render = (s) => s.replaceAll('{{sourceRef}}', `invoice-batch/${batchId}`);
  return { title: render(t.subject), body: render(t.body) };
};
