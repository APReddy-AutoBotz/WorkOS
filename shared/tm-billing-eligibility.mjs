import {
  approvalKeys,
  approvalText,
  approvalUuid,
  validWorkApprovalPolicy,
  approvalState,
  renderApprovalTemplate,
} from './work-approval.mjs';
import { validCapabilityDate } from './workforce-capabilities.mjs';

// A prospective, explicitly configured engagement policy. This helper does not
// select approvers, grant permissions, or authorize a billing event.
export const validTmEligibilityPolicy = (d) => {
  if (
    !approvalKeys(d, ['entityType', 'engagementId', 'stages', 'locale', 'templates', 'completionInApp']) ||
    d.entityType !== 'TmBillingEligibility' ||
    !approvalText(d.engagementId)
  )
    return false;
  const { entityType: _entity, engagementId: _engagement, ...shared } = d;
  return (
    validWorkApprovalPolicy({ ...shared, entityType: 'Timesheet', workerIds: [] }) &&
    d.templates.every((t) =>
      [t.subject, t.body].every((s) => !s.includes('{{decisionReason}}') && !s.includes('{{workerCode}}')),
    )
  );
};

export const tmEligibilityState = (policy, transitions) => {
  if (!validTmEligibilityPolicy(policy)) throw new TypeError('Invalid T&M eligibility policy.');
  return approvalState(policy.stages, transitions);
};

// Inputs to this check must be established by the current locked server/DB
// observation; a caller cannot assert active status, role, scope or permission.
export const tmEligibilityActorAllowed = (
  policy,
  transitions,
  sourceCurrent,
  actor,
  requesterUserId,
  affectedWorkerUserId = null,
) => {
  if (
    sourceCurrent !== true ||
    !validTmEligibilityPolicy(policy) ||
    !approvalUuid(requesterUserId) ||
    (affectedWorkerUserId !== null && !approvalUuid(affectedWorkerUserId)) ||
    !approvalKeys(actor, [
      'userId',
      'role',
      'active',
      'heldRole',
      'scopedSourceAccess',
      'decisionPermission',
      'inboxPermission',
    ]) ||
    !approvalUuid(actor.userId) ||
    typeof actor.role !== 'string' ||
    actor.userId === requesterUserId ||
    actor.userId === affectedWorkerUserId ||
    !['active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission'].every(
      (k) => actor[k] === true,
    )
  )
    return false;
  try {
    const state = tmEligibilityState(policy, transitions);
    const stage = state.status === 'Pending' && policy.stages[state.currentStage];
    return Boolean(stage && stage.userId === actor.userId && stage.role === actor.role);
  } catch {
    return false;
  }
};

export const renderTmEligibilityNotice = (template, snapshotId, stage) => {
  if (
    !approvalUuid(snapshotId) ||
    !Number.isInteger(stage) ||
    stage < 1 ||
    stage > 10 ||
    [template?.subject, template?.body].some(
      (s) => typeof s !== 'string' || s.includes('{{decisionReason}}') || s.includes('{{workerCode}}'),
    )
  ) {
    throw new TypeError('Invalid T&M eligibility notification.');
  }
  return renderApprovalTemplate(template, {
    workerCode: '',
    sourceRef: `tm-eligibility/${snapshotId}`,
    stageNumber: String(stage),
    decisionReason: '',
  });
};

// Billing-only projection of a server-loaded retained snapshot. Source approval,
// current scope and event authority must be independently established by the
// caller in its transaction; this function cannot establish eligibility.
export const tmBillingEvidence = (snapshot) => {
  const source = snapshot?.sourceEvidence,
    result = snapshot?.result;
  if (
    !approvalUuid(snapshot?.id) ||
    !approvalText(snapshot?.engagementId) ||
    !approvalUuid(snapshot?.policyId) ||
    !approvalText(snapshot?.submissionId) ||
    !approvalText(snapshot?.decisionId) ||
    !approvalUuid(snapshot?.entryId) ||
    !approvalUuid(snapshot?.billingAdoptionId) ||
    !source ||
    !result ||
    source.submissionId !== snapshot.submissionId ||
    source.decisionId !== snapshot.decisionId ||
    source.entryId !== snapshot.entryId ||
    source.policyId !== snapshot.policyId ||
    source.billingAdoptionId !== snapshot.billingAdoptionId ||
    !approvalText(source.projectId) ||
    !approvalText(source.bindingId) ||
    !Array.isArray(source.references) ||
    source.references.length !== 3 ||
    new Set(source.references.map((x) => x?.entityType)).size !== 3 ||
    !source.references.every(
      (x) =>
        ['Project', 'Engagement', 'Contract'].includes(x?.entityType) &&
        approvalText(x.entityId) &&
        approvalText(x.lifecycleEventId) &&
        approvalText(x.contractVersionId) &&
        (x.amendmentId === null || approvalText(x.amendmentId)),
    ) ||
    source.references.find((x) => x.entityType === 'Project')?.entityId !== source.projectId ||
    source.references.find((x) => x.entityType === 'Engagement')?.entityId !== snapshot.engagementId ||
    new Set(source.references.map((x) => x.contractVersionId)).size !== 1 ||
    !validCapabilityDate(source.workDate) ||
    !['governed-tm/1','governed-tm/2'].includes(result.version) ||
    !/^[A-Z]{3}$/.test(result.currency) ||
    result.unit !== 'HOUR' ||
    typeof result.billableValue !== 'string' ||
    !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(result.billableValue) ||
    !/[1-9]/.test(result.billableValue)
  )
    throw new TypeError('Retained billing evidence unavailable.');
  return {
    snapshotId: snapshot.id,
    engagementId: snapshot.engagementId,
    policyId: snapshot.policyId,
    submissionId: snapshot.submissionId,
    decisionId: snapshot.decisionId,
    entryId: snapshot.entryId,
    billingAdoptionId: snapshot.billingAdoptionId,
    projectId: source.projectId,
    bindingId: source.bindingId,
    workDate: source.workDate,
    references: source.references.map((x) => ({
      entityType: x.entityType,
      entityId: x.entityId,
      lifecycleEventId: x.lifecycleEventId,
      contractVersionId: x.contractVersionId,
    })),
    currency: result.currency,
    amount: result.billableValue,
  };
};

// Compare pins only after the server has locked and independently revalidated
// the source, explicit owner and effective policy in the current transaction.
export const tmEligibilitySourceCurrent = (pin, current) => {
  const keys = ['snapshotId', 'policyId', 'ownerUserId', 'ownerRole'];
  return (
    approvalKeys(pin, keys) &&
    approvalUuid(pin.snapshotId) &&
    approvalUuid(pin.policyId) &&
    approvalUuid(pin.ownerUserId) &&
    approvalText(pin.ownerRole, 100) &&
    approvalKeys(current, [...keys, 'sourceEligible', 'ownerEligible']) &&
    current.sourceEligible === true &&
    current.ownerEligible === true &&
    keys.every((k) => pin[k] === current[k])
  );
};
