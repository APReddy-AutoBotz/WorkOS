import { approvalKeys, approvalUuid, approvalHash, approvalText } from './work-approval.mjs';
import { canonicalHours, compareHours } from './work-hours.mjs';
// A manually supplied reference is an authorized user attestation; it is not a
// provider response, an invoice, a payment or independent external validation.
export function validConfirmationTotal(total, sourceType = 'TM_SNAPSHOT') {
  if (typeof total !== 'string') return false;
  const credit = sourceType === 'FULL_LINE_REVERSAL';
  if (!credit && !['TM_SNAPSHOT', 'MILESTONE_ACCEPTANCE', 'FIXED_FEE_INSTALLMENT'].includes(sourceType)) return false;
  if (credit && !total.startsWith('-')) return false;
  const magnitude = credit ? total.slice(1) : total;
  try {
    return canonicalHours(magnitude) === magnitude && compareHours(magnitude, '0') > 0;
  } catch {
    return false;
  }
}
export const validInvoiceConfirmationCommand = (x, sourceType = 'TM_SNAPSHOT') => {
  try {
    return (
      approvalKeys(x, [
        'requestId',
        'batchId',
        'artifactId',
        'artifactVersion',
        'artifactSha256',
        'currency',
        'total',
        'reference',
        'reason',
      ]) &&
      approvalUuid(x.requestId) &&
      approvalUuid(x.batchId) &&
      approvalUuid(x.artifactId) &&
      x.artifactVersion === 1 &&
      approvalHash(x.artifactSha256) &&
      typeof x.currency === 'string' &&
      /^[A-Z]{3}$/.test(x.currency) &&
      validConfirmationTotal(x.total, sourceType) &&
      approvalText(x.reference, 200) &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(x.reference) &&
      approvalText(x.reason, 1000) &&
      x.reason.length >= 3
    );
  } catch {
    return false;
  }
};
export const invoiceConfirmationAllowed = (command, source, actor, sourceType = 'TM_SNAPSHOT') =>
  validInvoiceConfirmationCommand(command, sourceType) &&
  approvalKeys(source, [
    'state',
    'batchId',
    'artifactId',
    'artifactVersion',
    'artifactSha256',
    'currency',
    'total',
  ]) &&
  source.state === 'Exported' &&
  source.batchId === command.batchId &&
  source.artifactId === command.artifactId &&
  source.artifactVersion === command.artifactVersion &&
  source.artifactSha256 === command.artifactSha256 &&
  source.currency === command.currency &&
  source.total === command.total &&
  approvalKeys(actor, ['active', 'heldRole', 'scopedSourceAccess', 'confirmationPermission']) &&
  Object.values(actor).every((x) => x === true);
