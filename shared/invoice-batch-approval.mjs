import { approvalKeys, approvalText, approvalUuid, validWorkApprovalPolicy, approvalState, renderApprovalTemplate } from './work-approval.mjs';

// Configuration identifies named stages; server and database transactions must
// independently establish current authority, retained source, and scope.
export const validInvoiceBatchApprovalPolicy = d => {
  if (!approvalKeys(d, ['entityType', 'engagementId', 'stages', 'locale', 'templates', 'completionInApp']) ||
      d.entityType !== 'InvoiceBatch' || !approvalText(d.engagementId)) return false;
  const { entityType: _entity, engagementId: _engagement, ...shared } = d;
  return validWorkApprovalPolicy({ ...shared, entityType: 'Timesheet', workerIds: [] }) &&
    d.templates.every(t => [t.subject, t.body].every(s => !s.includes('{{decisionReason}}') && !s.includes('{{workerCode}}')));
};
export const invoiceBatchApprovalState = (policy, transitions) => {
  if (!validInvoiceBatchApprovalPolicy(policy)) throw new TypeError('Invalid invoice batch approval policy.');
  return approvalState(policy.stages, transitions);
};
export const invoiceBatchApprovalActorAllowed = (policy, transitions, sourceCurrent, actor, requesterUserId) => {
  if (sourceCurrent !== true || !validInvoiceBatchApprovalPolicy(policy) || !approvalUuid(requesterUserId) ||
      !approvalKeys(actor, ['userId', 'role', 'active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission']) ||
      !approvalUuid(actor.userId) || typeof actor.role !== 'string' || actor.userId === requesterUserId ||
      !['active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission'].every(k => actor[k] === true)) return false;
  try {
    const state = invoiceBatchApprovalState(policy, transitions);
    const stage = state.status === 'Pending' && policy.stages[state.currentStage];
    return Boolean(stage && stage.userId === actor.userId && stage.role === actor.role);
  } catch { return false; }
};
export const renderInvoiceBatchApprovalNotice = (template, batchId, stage) => {
  if (!approvalUuid(batchId) || !Number.isInteger(stage) || stage < 1 || stage > 10 ||
      [template?.subject, template?.body].some(s => typeof s !== 'string' || s.includes('{{decisionReason}}') || s.includes('{{workerCode}}'))) {
    throw new TypeError('Invalid invoice batch approval notification.');
  }
  return renderApprovalTemplate(template, { workerCode: '', sourceRef: `invoice-batch/${batchId}`, stageNumber: String(stage), decisionReason: '' });
};

// The server supplies relationships resolved from the locked source, never
// arbitrary client recipients. All reasons survive identity deduplication.
export const invoiceBatchApprovalRecipients = relationships => {
  const allowed = ['current_stage_approver', 'requester', 'affected_worker', 'invoice_batch_owner', 'finance_preparer'];
  if (!Array.isArray(relationships) || !relationships.length) throw new TypeError('Protected recipients are required.');
  const users = new Map();
  for (const row of relationships) {
    if (!approvalKeys(row, ['userId', 'reason']) || !approvalUuid(row.userId) || !allowed.includes(row.reason)) throw new TypeError('Invalid protected recipient.');
    const reasons = users.get(row.userId) ?? new Set(); reasons.add(row.reason); users.set(row.userId, reasons);
  }
  return [...users].sort(([a], [b]) => a.localeCompare(b)).map(([userId, reasons]) => ({ userId, reasons: [...reasons].sort() }));
};
