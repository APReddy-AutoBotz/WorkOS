import {api, ApiClientError} from './apiClient';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
import {
  assertCommercialDraftingContext, captureCommercialDraftingContext, isCommercialDraftingContextCurrent, ENGAGEMENT_MODELS,
  type CommercialDraftingContext, type EngagementModel,
} from './commercialDrafting';

export type CommercialLifecycleContext = CommercialDraftingContext;
export const captureCommercialLifecycleContext = (isCurrent = () => true): CommercialLifecycleContext | null => {
  const context = captureCommercialDraftingContext(isCurrent);
  if (!context) return null;
  // captureCommercialDraftingContext already requires the session-only identity.
  // Lifecycle authority is a separate, explicitly granted permission.
  const user = authService.getCurrentUser();
  return {...context, canManage: Boolean(user && getEffectivePermissions(user).includes('commercial.lifecycle.manage'))};
};
export const isCommercialLifecycleContextCurrent = isCommercialDraftingContextCurrent;
export const assertCommercialLifecycleContext = (context: CommercialLifecycleContext | null, manage = false) => {
  const owner = assertCommercialDraftingContext(context);
  if (manage && (!owner.canManage || !captureCommercialLifecycleContext()?.canManage)) {
    throw new ApiClientError('Commercial lifecycle manage access is required.', {status: 403});
  }
  return owner;
};

export type LifecycleEntityType = 'Contract' | 'Engagement' | 'Project';
export type LifecycleState = 'Active' | 'On Hold';
export type LifecycleEvent = {
  id: string; sequence: number; state: LifecycleState; effectiveOn: string; contractVersionId: string | null;
  reason: string; approvalReference: string | null; actorId: string; activeRole: string; correlationId: string; operationId: string;
};
export type LifecycleContract = {
  id: string; number: string; clientId: string; contractVersionId: string; name: string; startsOn: string; endsOn: string;
  lifecycle: LifecycleEvent | null;
};
export type LifecycleEngagement = {
  id: string; code: string; name: string; contractVersionId: string | null; startsOn: string; endsOn: string; billable: boolean;
  model: EngagementModel; clientId: string | null; managerId: string; currency: string; lifecycle: LifecycleEvent | null;
};
export type GovernedProject = {
  id: string; bindingId: string; engagementId: string; code: string; name: string; managerId: string; startsOn: string; endsOn: string;
  model: EngagementModel; currency: string; budgetAllocation: string; billable: boolean; contractVersionId: string | null;
  attributionId: string | null; origin: 'manual' | 'explicit-legacy-promotion'; lifecycle: LifecycleEvent;
};
export type LegacyProjectChoice = {
  id: string; code: string; name: string; clientId: string | null; managerId: string; startsOn: string; endsOn: string;
  billable: boolean; neutralMapped: boolean;
};
export type LifecycleWorkspace = {
  asOf: string; contracts: LifecycleContract[]; engagements: LifecycleEngagement[]; projects: GovernedProject[];
  choices: {legacyProjects: LegacyProjectChoice[]; owners: {id: string; name: string}[]};
  limits: {pageSize: 200; truncated: Record<'contracts' | 'engagements' | 'projects' | 'legacyProjects' | 'owners', boolean>};
  closure: {available: false; unavailableEvidence: string[]; message: string};
};
export type LifecycleHistory = {entityType: LifecycleEntityType; entityId: string; events: LifecycleEvent[]; limit: 200};
export type LifecycleReadiness = {
  entityType: LifecycleEntityType; entityId: string; available: false; checkedOn: string;
  evidence: {openAssignments: number; draftSubmittedWorkLines: number; pendingTimesheetApprovals: number;
    unacceptedMilestones: number; draftPurchaseOrders: number; ownerActive: boolean | null};
  unavailableEvidence: string[]; message: string;
};
export type LifecycleTransitionInput = {
  expectedSequence: number; state: LifecycleState; contractVersionId: string | null; reason: string; approvalReference: string | null;
};
export type CreateGovernedProjectInput = {
  engagementId: string; projectId: string | null; code: string; name: string; managerId: string; startsOn: string; endsOn: string;
  billable: boolean; budgetAllocation: string; reason: string;
};

const invalid = () => new ApiClientError('Commercial lifecycle response could not be confirmed.', {status: 502});
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || !value.trim()) throw invalid(); return value; };
const nullableText = (value: unknown) => value === null ? null : text(value);
const integer = (value: unknown, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
};
const flag = (value: unknown) => { if (typeof value !== 'boolean') throw invalid(); return value; };
const date = (value: unknown) => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString().slice(0, 10) !== result) throw invalid();
  return result;
};
const dates = (item: Record<string, unknown>) => {
  const startsOn = date(item.startsOn); const endsOn = date(item.endsOn);
  if (endsOn < startsOn) throw invalid();
  return {startsOn, endsOn};
};
const currency = (value: unknown) => { const result = text(value); if (!/^[A-Z]{3}$/.test(result)) throw invalid(); return result; };
const decimal = (value: unknown) => { const result = text(value); if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(result)) throw invalid(); return result; };
const member = <T extends string>(value: unknown, choices: readonly T[]): T => {
  if (!choices.includes(value as T)) throw invalid(); return value as T;
};
const rows = <T>(value: unknown, normalize: (row: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > 200) throw invalid();
  return value.map(normalize);
};
const unique = <T extends {id: string}>(items: T[]) => {
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid(); return items;
};
export const normalizeLifecycleEvent = (value: unknown): LifecycleEvent => {
  const item = object(value); const sequence = integer(item.sequence, 1, 200);
  const state = member(item.state, ['Active', 'On Hold'] as const);
  // The initial event is Active and this slice permits only alternating states.
  if ((sequence % 2 === 1) !== (state === 'Active')) throw invalid();
  return {id: text(item.id), sequence, state, effectiveOn: date(item.effectiveOn), contractVersionId: nullableText(item.contractVersionId),
    reason: text(item.reason), approvalReference: nullableText(item.approvalReference), actorId: text(item.actorId),
    activeRole: text(item.activeRole), correlationId: text(item.correlationId), operationId: text(item.operationId)};
};
const lifecycle = (value: unknown) => value === null ? null : normalizeLifecycleEvent(value);
const normalizeContract = (value: unknown): LifecycleContract => {
  const item = object(value); const event = lifecycle(item.lifecycle);
  if (event && event.contractVersionId === null) throw invalid();
  return {id: text(item.id), number: text(item.number), clientId: text(item.clientId), contractVersionId: text(item.contractVersionId),
    name: text(item.name), ...dates(item), lifecycle: event};
};
const normalizeEngagement = (value: unknown): LifecycleEngagement => {
  const item = object(value); const event = lifecycle(item.lifecycle); const contractVersionId = nullableText(item.contractVersionId);
  const model = member(item.model, ENGAGEMENT_MODELS); const billable = flag(item.billable); const clientId = nullableText(item.clientId);
  const internal = model === 'internal' || model === 'pre_sales';
  if ((event && event.contractVersionId !== contractVersionId) || (internal && (billable || contractVersionId !== null))
    || (!internal && (contractVersionId === null || clientId === null))) throw invalid();
  return {id: text(item.id), code: text(item.code), name: text(item.name), contractVersionId, ...dates(item), billable, model, clientId,
    managerId: text(item.managerId), currency: currency(item.currency), lifecycle: event};
};
export const normalizeGovernedProject = (value: unknown): GovernedProject => {
  const item = object(value); const event = normalizeLifecycleEvent(item.lifecycle); const contractVersionId = nullableText(item.contractVersionId);
  const model = member(item.model, ENGAGEMENT_MODELS); const billable = flag(item.billable); const attributionId = nullableText(item.attributionId);
  const budgetAllocation = decimal(item.budgetAllocation); const internal = model === 'internal' || model === 'pre_sales';
  if (event.contractVersionId !== contractVersionId || (internal && (billable || contractVersionId !== null || attributionId === null || !/^0(?:\.0{1,4})?$/.test(budgetAllocation)))
    || (!internal && (contractVersionId === null || attributionId !== null))) throw invalid();
  return {id: text(item.id), bindingId: text(item.bindingId), engagementId: text(item.engagementId), code: text(item.code), name: text(item.name),
    managerId: text(item.managerId), ...dates(item), model, currency: currency(item.currency), budgetAllocation, billable, contractVersionId, attributionId,
    origin: member(item.origin, ['manual', 'explicit-legacy-promotion'] as const), lifecycle: event};
};
export const normalizeCommercialLifecycleWorkspace = (value: unknown): LifecycleWorkspace => {
  const item = object(value); const choices = object(item.choices); const limits = object(item.limits); const truncated = object(limits.truncated);
  const closure = object(item.closure); const asOf = date(item.asOf);
  if (limits.pageSize !== 200 || closure.available !== false) throw invalid();
  const contracts = unique(rows(item.contracts, normalizeContract)); const engagements = unique(rows(item.engagements, normalizeEngagement));
  const projects = unique(rows(item.projects, normalizeGovernedProject));
  if ([...contracts, ...engagements, ...projects].some(row => row.lifecycle && row.lifecycle.effectiveOn > asOf)) throw invalid();
  return {asOf, contracts, engagements, projects, choices: {
    legacyProjects: unique(rows(choices.legacyProjects, value => {
      const row = object(value);
      return {id: text(row.id), code: text(row.code), name: text(row.name), clientId: nullableText(row.clientId), managerId: text(row.managerId),
        ...dates(row), billable: flag(row.billable), neutralMapped: flag(row.neutralMapped)};
    })),
    owners: unique(rows(choices.owners, value => {const row = object(value); return {id: text(row.id), name: text(row.name)};})),
  }, limits: {pageSize: 200, truncated: {contracts: flag(truncated.contracts), engagements: flag(truncated.engagements), projects: flag(truncated.projects),
    legacyProjects: flag(truncated.legacyProjects), owners: flag(truncated.owners)}},
  closure: {available: false, unavailableEvidence: rows(closure.unavailableEvidence, text), message: text(closure.message)}};
};
export const normalizeCommercialLifecycleHistory = (value: unknown): LifecycleHistory => {
  const item = object(value); const events = unique(rows(item.events, normalizeLifecycleEvent));
  if (item.limit !== 200 || events.some((event, index) => event.sequence !== events.length - index
    || (index > 0 && (event.contractVersionId !== events[0].contractVersionId || event.effectiveOn > events[index - 1].effectiveOn)))) throw invalid();
  return {entityType: member(item.entityType, ['Contract', 'Engagement', 'Project'] as const), entityId: text(item.entityId), events, limit: 200};
};
export const normalizeCommercialLifecycleReadiness = (value: unknown): LifecycleReadiness => {
  const item = object(value); const evidence = object(item.evidence);
  if (item.available !== false) throw invalid();
  const count = (value: unknown) => integer(value, 0, Number.MAX_SAFE_INTEGER);
  return {entityType: member(item.entityType, ['Contract', 'Engagement', 'Project'] as const), entityId: text(item.entityId), available: false,
    checkedOn: date(item.checkedOn), evidence: {openAssignments: count(evidence.openAssignments), draftSubmittedWorkLines: count(evidence.draftSubmittedWorkLines),
      pendingTimesheetApprovals: count(evidence.pendingTimesheetApprovals), unacceptedMilestones: count(evidence.unacceptedMilestones),
      draftPurchaseOrders: count(evidence.draftPurchaseOrders), ownerActive: evidence.ownerActive === null ? null : flag(evidence.ownerActive)},
    unavailableEvidence: rows(item.unavailableEvidence, text), message: text(item.message)};
};
const PREFIX = '/api/v1/commercial-drafting/lifecycle';
const request = async <T>(context: CommercialDraftingContext | null, method: 'GET' | 'POST', path: string, body: unknown, normalize: (value: unknown) => T) => {
  const owner = assertCommercialLifecycleContext(context, method === 'POST');
  const result = await api.requestWithContext<unknown>(method, `${PREFIX}${path}`, body, owner.request);
  assertCommercialLifecycleContext(owner, method === 'POST');
  return normalize(result);
};
const entityPath = (type: LifecycleEntityType, id: string) => {
  member(type, ['Contract', 'Engagement', 'Project'] as const);
  return `/${type}/${encodeURIComponent(text(id))}`;
};
// Only allowlisted command fields cross the service boundary. No caller-supplied
// actor, role, scope, status projection, effective date or immutable terms do.
export const commercialLifecycleService = {
  getWorkspace: (context: CommercialDraftingContext | null) => request(context, 'GET', '/workspace', undefined, normalizeCommercialLifecycleWorkspace),
  getHistory: (type: LifecycleEntityType, id: string, context: CommercialDraftingContext | null) => request(context, 'GET', `${entityPath(type, id)}/history`, undefined, value => {
    const result = normalizeCommercialLifecycleHistory(value);
    if (result.entityType !== type || result.entityId !== id) throw invalid(); return result;
  }),
  getReadiness: (type: LifecycleEntityType, id: string, context: CommercialDraftingContext | null) => request(context, 'GET', `${entityPath(type, id)}/readiness`, undefined, value => {
    const result = normalizeCommercialLifecycleReadiness(value);
    if (result.entityType !== type || result.entityId !== id) throw invalid(); return result;
  }),
  transition: (type: LifecycleEntityType, id: string, input: LifecycleTransitionInput, context: CommercialDraftingContext | null) =>
    request(context, 'POST', `${entityPath(type, id)}/transitions`, {expectedSequence: input.expectedSequence, state: input.state,
      contractVersionId: input.contractVersionId, reason: input.reason, approvalReference: input.approvalReference}, value => {
      const result = normalizeLifecycleEvent(value);
      if (result.sequence !== input.expectedSequence + 1 || result.state !== input.state || result.contractVersionId !== input.contractVersionId) throw invalid();
      return result;
    }),
  createProject: (input: CreateGovernedProjectInput, context: CommercialDraftingContext | null) => request(context, 'POST', '/projects', {
    engagementId: input.engagementId, projectId: input.projectId, code: input.code, name: input.name, managerId: input.managerId,
    startsOn: input.startsOn, endsOn: input.endsOn, billable: input.billable, budgetAllocation: input.budgetAllocation, reason: input.reason,
  }, value => {
    const result = normalizeGovernedProject(value);
    if (result.engagementId !== input.engagementId || (input.projectId !== null && result.id !== input.projectId)
      || result.lifecycle.sequence !== 1 || result.lifecycle.state !== 'Active') throw invalid();
    return result;
  }),
};
