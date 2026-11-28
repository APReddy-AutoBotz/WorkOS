import {approvalKeys, approvalUuid, approvalText} from './work-approval.mjs';
import {compareCapabilityIds} from './workforce-capabilities.mjs';

export const DELEGATION_KINDS = Object.freeze(['Creation', 'Leave', 'Material', 'Work']);

export function delegationInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function validDelegationDefinition(definition) {
  if (!approvalKeys(definition, ['delegateUserId','role','workerIds','sourceKinds','clockBasis','cohort','startsAt','endsAt'])) return false;
  const {delegateUserId,role,workerIds,sourceKinds,clockBasis,cohort,startsAt,endsAt} = definition;
  return approvalUuid(delegateUserId) && approvalText(role,100)
    && Array.isArray(workerIds) && workerIds.length > 0 && workerIds.length <= 200
    && workerIds.every((id,i) => approvalText(id) && (i === 0 || compareCapabilityIds(workerIds[i-1],id) < 0))
    && Array.isArray(sourceKinds) && sourceKinds.length > 0 && sourceKinds.length <= DELEGATION_KINDS.length
    && sourceKinds.every((kind,i) => DELEGATION_KINDS.includes(kind) && (i === 0 || sourceKinds[i-1] < kind))
    && clockBasis === 'UTC' && cohort === 'NewInstances'
    && delegationInstant(startsAt) && delegationInstant(endsAt) && startsAt < endsAt;
}

export function validDelegationBindings(bindings,stages) {
  if (!Array.isArray(bindings) || !Array.isArray(stages) || bindings.length === 0 || bindings.length > 10) return false;
  const seen = new Set();
  return bindings.every(binding => {
    if (!approvalKeys(binding,['id','delegationId','stage','delegatorUserId','delegateUserId','role','startsAt','endsAt','revokedAt','eligible'])) return false;
    const {id,delegationId,stage,delegatorUserId,delegateUserId,role,startsAt,endsAt,revokedAt,eligible} = binding;
    if (!Number.isInteger(stage) || !stages[stage] || seen.has(stage)) return false;
    seen.add(stage);
    return approvalUuid(id) && approvalUuid(delegationId)
      && stages[stage].userId === delegatorUserId && stages[stage].role === role
      && approvalUuid(delegateUserId) && delegateUserId !== delegatorUserId
      && delegationInstant(startsAt) && delegationInstant(endsAt) && startsAt < endsAt
      && (revokedAt === null || delegationInstant(revokedAt))
      && typeof eligible === 'boolean' && (!eligible || revokedAt === null);
  });
}

// Historical receipts identify their exact binding even after eligibility ends.
export function stageActorAllowed(stages,bindings,stage,actor,role,bindingId=null,historical=false) {
  const named = stages?.[stage];
  if (!named || named.role !== role) return false;
  if (named.userId === actor) return bindingId === null;
  if (!validDelegationBindings(bindings,stages)) return false;
  return bindings.some(binding => binding.stage === stage && binding.delegateUserId === actor
    && (historical ? binding.id === bindingId : binding.eligible));
}
