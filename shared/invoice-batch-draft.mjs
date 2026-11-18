import { approvalKeys, approvalText, approvalUuid } from './work-approval.mjs';
import { validCapabilityDate } from './workforce-capabilities.mjs';
import { decimalQuantity, formatQuantity } from './work-hours.mjs';

// Explicit T&M draft inputs only; there is no default period basis, owner,
// currency, conversion, item selection or invoice/export authority.
export const validInvoiceDraft = (x) =>
  approvalKeys(x, [
    'clientId',
    'contractId',
    'engagementId',
    'currency',
    'periodStart',
    'periodEnd',
    'periodBasis',
    'ownerUserId',
    'ownerRole',
  ]) &&
  ['clientId', 'contractId', 'engagementId'].every((k) => approvalText(x[k])) &&
  typeof x.currency === 'string' &&
  /^[A-Z]{3}$/.test(x.currency) &&
  validCapabilityDate(x.periodStart) &&
  validCapabilityDate(x.periodEnd) &&
  x.periodStart <= x.periodEnd &&
  ['WORK_DATE', 'ELIGIBLE_DATE'].includes(x.periodBasis) &&
  approvalUuid(x.ownerUserId) &&
  approvalText(x.ownerRole, 100);
export const invoiceItemMatches = (draft, item) => {
  if (
    !validInvoiceDraft(draft) ||
    !approvalKeys(item, [
      'itemId',
      'itemVersion',
      'clientId',
      'contractId',
      'engagementId',
      'currency',
      'workDate',
      'eligibleOn',
      'amount',
      'current',
    ]) ||
    !approvalUuid(item.itemId) ||
    item.itemVersion !== 1 ||
    item.current !== true ||
    !validCapabilityDate(item.workDate) ||
    !validCapabilityDate(item.eligibleOn) ||
    typeof item.amount !== 'string' ||
    !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(item.amount) ||
    !/[1-9]/.test(item.amount)
  )
    return false;
  const basis = draft.periodBasis === 'WORK_DATE' ? item.workDate : item.eligibleOn;
  return (
    ['clientId', 'contractId', 'engagementId', 'currency'].every((k) => draft[k] === item[k]) &&
    draft.periodStart <= basis &&
    basis <= draft.periodEnd
  );
};
// Exact native-currency addition; callers supply already-authorized amounts of
// one currency. No rounding, conversion or caller-supplied aggregate is used.
export const invoiceDraftTotal = (amounts) => {
  if (
    !Array.isArray(amounts) ||
    amounts.some(
      (v) => typeof v !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(v) || !/[1-9]/.test(v),
    )
  )
    throw new TypeError('Explicit positive native amounts are required.');
  const sum = amounts.reduce((n, v) => {
    const d = decimalQuantity(v);
    return n + d.units * 10n ** BigInt(4 - d.scale);
  }, 0n);
  return { lineCount: amounts.length, amount: formatQuantity({ units: sum, scale: 4 }) };
};
