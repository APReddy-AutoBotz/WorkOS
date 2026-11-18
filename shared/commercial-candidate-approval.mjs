import {
  approvalKeys,
  approvalUuid,
  validWorkApprovalPolicy,
  approvalState,
  renderApprovalTemplate,
} from './work-approval.mjs';
import { compareCapabilityIds } from './workforce-capabilities.mjs';

// This explicit exact-candidate policy does not adopt a rate or select recipients.
export const validCommercialCandidatePolicy = (d) => {
  if (
    !approvalKeys(d, [
      'entityType',
      'kind',
      'candidateId',
      'stages',
      'locale',
      'templates',
      'completionInApp',
    ]) ||
    d.entityType !== 'CommercialCandidate' ||
    !['billing', 'cost'].includes(d.kind) ||
    !approvalUuid(d.candidateId)
  )
    return false;
  const { entityType: _entity, kind: _kind, candidateId: _candidate, ...shared } = d;
  if (!validWorkApprovalPolicy({ ...shared, entityType: 'Timesheet', workerIds: [] })) return false;
  // Sensitive reason and worker fields are never substituted into this inbox.
  return d.templates.every((t) =>
    [t.subject, t.body].every((s) => !s.includes('{{decisionReason}}') && !s.includes('{{workerCode}}')),
  );
};
export const commercialApprovalState = (policy, transitions) => {
  if (!validCommercialCandidatePolicy(policy)) throw TypeError('Invalid commercial approval policy.');
  return approvalState(policy.stages, transitions);
};
export const commercialApprovalRecipients = (rows) => {
  const allowed = ['current_stage_approver', 'requester', 'commercial_change_owner', 'affected_worker'],
    map = new Map();
  for (const r of rows) {
    if (!approvalKeys(r, ['userId', 'reason']) || !approvalUuid(r.userId) || !allowed.includes(r.reason))
      throw TypeError('Invalid commercial recipient relationship.');
    const reasons = map.get(r.userId) ?? [];
    if (!reasons.includes(r.reason)) reasons.push(r.reason);
    map.set(r.userId, reasons);
  }
  return [...map]
    .sort(([a], [b]) => compareCapabilityIds(a, b))
    .map(([userId, reasons]) => ({ userId, reasons: reasons.sort() }));
};
export const renderCommercialApproval = (template, candidateId, stage) => {
  if (
    !approvalUuid(candidateId) ||
    !Number.isInteger(stage) ||
    stage < 1 ||
    stage > 10 ||
    [template?.subject, template?.body].some(
      (x) => typeof x !== 'string' || x.includes('{{decisionReason}}') || x.includes('{{workerCode}}'),
    )
  )
    throw TypeError('Invalid commercial template or source.');
  return renderApprovalTemplate(template, {
    workerCode: '',
    sourceRef: 'commercial-candidate/' + candidateId,
    stageNumber: String(stage),
    decisionReason: '',
  });
};

// Inputs must come from the current locked server observation, never caller-supplied claims.
export const commercialApprovalSourceCurrent = (pin, current) => {
  const keys = ['candidateId', 'ownerEventId', 'policyId'];
  if (
    !approvalKeys(pin, keys) ||
    !keys.every((k) => approvalUuid(pin[k])) ||
    !approvalKeys(current, [...keys, 'ownerEligible']) ||
    typeof current.ownerEligible !== 'boolean'
  )
    return false;
  return current.ownerEligible && keys.every((k) => current[k] === pin[k]);
};
export const commercialApprovalActorAllowed = (
  policy,
  transitions,
  sourceCurrent,
  actor,
  requesterUserId,
  affectedWorkerUserId = null,
) => {
  if (
    sourceCurrent !== true ||
    !validCommercialCandidatePolicy(policy) ||
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
    !['active', 'heldRole', 'scopedSourceAccess', 'decisionPermission', 'inboxPermission'].every(
      (k) => actor[k] === true,
    ) ||
    actor.userId === requesterUserId ||
    actor.userId === affectedWorkerUserId
  )
    return false;
  try {
    const state = commercialApprovalState(policy, transitions);
    if (state.status !== 'Pending') return false;
    const stage = policy.stages[state.currentStage];
    return stage.userId === actor.userId && stage.role === actor.role;
  } catch {
    return false;
  }
};
