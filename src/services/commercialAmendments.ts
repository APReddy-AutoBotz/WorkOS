import {api, ApiClientError} from './apiClient';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
import {
  assertCommercialDraftingContext, captureCommercialDraftingContext, isCommercialDraftingContextCurrent,
  normalizeCommercialContract, ENGAGEMENT_MODELS,
  type CommercialDraftingContext, type ContractTerms, type EngagementModel,
} from './commercialDrafting';
import {normalizeLifecycleEvent, type LifecycleEntityType, type LifecycleEvent} from './commercialLifecycle';

export type CommercialAmendmentContext = CommercialDraftingContext;
export const captureCommercialAmendmentContext = (isCurrent = () => true): CommercialAmendmentContext | null => {
  const context = captureCommercialDraftingContext(isCurrent);
  if (!context) return null;
  const user = authService.getCurrentUser();
  const permissions = user ? getEffectivePermissions(user) : [];
  return {...context, canManage: permissions.includes('commercial.lifecycle.manage') && permissions.includes('commercial.amendments.manage')};
};
export const isCommercialAmendmentContextCurrent = isCommercialDraftingContextCurrent;
export const assertCommercialAmendmentContext = (context: CommercialAmendmentContext | null, manage = false) => {
  const owner = assertCommercialDraftingContext(context);
  if (manage && (!owner.canManage || !captureCommercialAmendmentContext()?.canManage)) {
    throw new ApiClientError('Commercial amendment and lifecycle manage access are required.', {status: 403});
  }
  return owner;
};

export type AmendmentTerms = {contractVersionId: string; startsOn: string; endsOn: string; budget: string; laborCostBudget?:string};
export type AmendmentEvent = AmendmentTerms & {
  id: string; sequence: number; effectiveOn: string; reason: string; approvalReference: string;
  actorId: string; activeRole: string; correlationId: string; operationId: string;
};
export type AmendmentWorkspace = {
  asOf: string; entityType: LifecycleEntityType; entityId: string; lifecycle: LifecycleEvent; sequence: number;
  currentTerms: AmendmentTerms; activationTerms: AmendmentTerms;
  identity: {name: string; model: EngagementModel; currency: string; clientId: string | null};
  latestContractVersion: number; versions: ContractTerms[]; history: AmendmentEvent[]; pending: boolean;
};
export type AmendmentInput = AmendmentTerms & {
  expectedSequence: number; expectedLifecycleSequence: number; expectedContractVersion: number;
  effectiveOn: string; reason: string; approvalReference: string;
};
export type AmendmentPreview = {
  previewToken: string; asOf: string; entityType: LifecycleEntityType; entityId: string;
  before: AmendmentTerms; after: AmendmentTerms; effectiveOn: string;
  dependencies: {projects: number}; warnings: string[];
};

const invalid = () => new ApiClientError('Commercial amendment response could not be confirmed.', {status: 502});
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {if (typeof value !== 'string' || !value.trim()) throw invalid(); return value;};
const integer = (value: unknown, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
};
const flag = (value: unknown) => {if (typeof value !== 'boolean') throw invalid(); return value;};
const date = (value: unknown) => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString().slice(0, 10) !== result) throw invalid();
  return result;
};
const decimal = (value: unknown) => {
  const result = text(value); if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(result)) throw invalid(); return result;
};
const currency = (value: unknown) => {const result = text(value); if (!/^[A-Z]{3}$/.test(result)) throw invalid(); return result;};
const member = <T extends string>(value: unknown, choices: readonly T[]): T => {
  if (!choices.includes(value as T)) throw invalid(); return value as T;
};
const rows = <T>(value: unknown, normalize: (row: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > 200) throw invalid(); return value.map(normalize);
};
const unique = <T extends {id: string}>(items: T[]) => {
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid(); return items;
};
const token = (value: unknown) => {const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) throw invalid(); return result;};
export const normalizeAmendmentTerms = (value: unknown): AmendmentTerms => {
  const item = object(value); const startsOn = date(item.startsOn); const endsOn = date(item.endsOn);
  if (endsOn < startsOn) throw invalid();
  return {contractVersionId: text(item.contractVersionId), startsOn, endsOn, budget: decimal(item.budget),
    ...(item.laborCostBudget===undefined?{}:{laborCostBudget:decimal(item.laborCostBudget)})};
};
const amountKey = (value: string) => {const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(4, '0')}`;};
export const sameAmendmentTerms = (left: AmendmentTerms, right: AmendmentTerms) => left.contractVersionId === right.contractVersionId
  && left.startsOn === right.startsOn && left.endsOn === right.endsOn && amountKey(left.budget) === amountKey(right.budget)
  && (left.laborCostBudget===undefined || right.laborCostBudget===undefined
    ? left.laborCostBudget===right.laborCostBudget : amountKey(left.laborCostBudget)===amountKey(right.laborCostBudget));
export const normalizeAmendmentEvent = (value: unknown): AmendmentEvent => {
  const item = object(value); const reason = text(item.reason); const approvalReference = text(item.approvalReference);
  if (reason.trim().length < 3 || reason.length > 1000 || approvalReference.length > 200) throw invalid();
  return {...normalizeAmendmentTerms(item), id: text(item.id), sequence: integer(item.sequence, 1, 200), effectiveOn: date(item.effectiveOn),
    reason, approvalReference, actorId: text(item.actorId), activeRole: text(item.activeRole), correlationId: text(item.correlationId), operationId: text(item.operationId)};
};
export const normalizeCommercialAmendmentWorkspace = (value: unknown): AmendmentWorkspace => {
  const item = object(value); const identity = object(item.identity); const asOf = date(item.asOf);
  const lifecycle = normalizeLifecycleEvent(item.lifecycle); const sequence = integer(item.sequence, 0, 200);
  const latestContractVersion = integer(item.latestContractVersion, 1, 200);
  const currentTerms = normalizeAmendmentTerms(item.currentTerms); const activationTerms = normalizeAmendmentTerms(item.activationTerms);
  const entityType = member(item.entityType, ['Contract', 'Engagement', 'Project'] as const);
  const normalizedIdentity = {name: text(identity.name), model: member(identity.model, ENGAGEMENT_MODELS), currency: currency(identity.currency),
    clientId: identity.clientId === null ? null : text(identity.clientId)};
  const versions = unique(normalizeCommercialContract({id: 'amendment-contract', number: 'amendment-contract', clientId: 'amendment-client',
    latestVersion: latestContractVersion, versions: item.versions}).versions);
  if (versions.some(version => version.version > latestContractVersion || version.effectiveFrom < version.startsOn || version.effectiveFrom > version.endsOn
    || version.model !== normalizedIdentity.model || version.currency !== normalizedIdentity.currency)
    || [...versions].sort((a, b) => a.version - b.version).some((version, index, sorted) => index > 0 && version.effectiveFrom <= sorted[index - 1].effectiveFrom)) throw invalid();
  const history = unique(rows(item.history, normalizeAmendmentEvent)); const pending = flag(item.pending);
  // History is newest first, with strictly later effective dates at the top.
  if (lifecycle.effectiveOn > asOf || lifecycle.contractVersionId !== activationTerms.contractVersionId || history.length !== sequence
    || history.some((event, index) => event.sequence !== sequence - index || (index > 0 && event.effectiveOn >= history[index - 1].effectiveOn))) throw invalid();
  if (activationTerms.laborCostBudget!==undefined ||
    ((entityType!=='Engagement' || normalizedIdentity.model!=='fixed_fee') &&
      [currentTerms,...history].some(terms=>terms.laborCostBudget!==undefined))) throw invalid();
  const future = history.filter(event => event.effectiveOn > asOf);
  const effective = history.find(event => event.effectiveOn <= asOf);
  if (future.length > 1 || pending !== Boolean(future.length) || !sameAmendmentTerms(currentTerms, effective || activationTerms)
    || [activationTerms, currentTerms, ...history].some(terms => !versions.some(version => version.id === terms.contractVersionId))) throw invalid();
  const versionFor = (terms: AmendmentTerms) => versions.find(version => version.id === terms.contractVersionId)!;
  if (history.some((event, index) => event.effectiveOn < event.startsOn || event.effectiveOn > event.endsOn
    || event.effectiveOn < versionFor(event).effectiveFrom || event.effectiveOn < versionFor(event).startsOn || event.endsOn > versionFor(event).endsOn
    || versionFor(event).version <= versionFor(history[index + 1] || activationTerms).version
    || (entityType !== 'Contract' && event.startsOn !== activationTerms.startsOn))
    || (entityType === 'Contract' && [activationTerms, ...history].some(terms => !sameAmendmentTerms(terms, {
      contractVersionId: versionFor(terms).id, startsOn: versionFor(terms).startsOn, endsOn: versionFor(terms).endsOn, budget: versionFor(terms).value})))) throw invalid();
  return {asOf, entityType, entityId: text(item.entityId), lifecycle, sequence,
    currentTerms, activationTerms, latestContractVersion, versions, history, pending,
    identity: normalizedIdentity};
};
export const normalizeCommercialAmendmentPreview = (value: unknown): AmendmentPreview => {
  const item = object(value); const dependencies = object(item.dependencies);
  const asOf = date(item.asOf); const effectiveOn = date(item.effectiveOn); const before = normalizeAmendmentTerms(item.before); const after = normalizeAmendmentTerms(item.after);
  if (effectiveOn < asOf || effectiveOn < after.startsOn || effectiveOn > after.endsOn || before.contractVersionId === after.contractVersionId) throw invalid();
  return {previewToken: token(item.previewToken), asOf, entityType: member(item.entityType, ['Contract', 'Engagement', 'Project'] as const),
    entityId: text(item.entityId), before, after, effectiveOn,
    dependencies: {projects: integer(dependencies.projects, 0, Number.MAX_SAFE_INTEGER)}, warnings: rows(item.warnings, text)};
};

const PREFIX = '/api/v1/commercial-drafting/amendments';
const request = async <T>(context: CommercialAmendmentContext | null, method: 'GET' | 'POST', path: string, body: unknown, normalize: (value: unknown) => T) => {
  const owner = assertCommercialAmendmentContext(context, method === 'POST');
  const result = await api.requestWithContext<unknown>(method, `${PREFIX}${path}`, body, owner.request);
  assertCommercialAmendmentContext(owner, method === 'POST');
  return normalize(result);
};
const entityPath = (type: LifecycleEntityType, id: string) => {
  member(type, ['Contract', 'Engagement', 'Project'] as const); return `/${type}/${encodeURIComponent(text(id))}`;
};
// Commands contain only approved material fields and concurrency guards, never
// client-provided scope, identity, model, currency, billing state or audit data.
const commandBody = (input: AmendmentInput) => ({expectedSequence: input.expectedSequence, expectedLifecycleSequence: input.expectedLifecycleSequence,
  expectedContractVersion: input.expectedContractVersion, contractVersionId: input.contractVersionId, effectiveOn: input.effectiveOn,
  startsOn: input.startsOn, endsOn: input.endsOn, budget: input.budget, ...(input.laborCostBudget===undefined?{}:{laborCostBudget:input.laborCostBudget}), reason: input.reason, approvalReference: input.approvalReference});
export const commercialAmendmentService = {
  getWorkspace: (type: LifecycleEntityType, id: string, context: CommercialAmendmentContext | null) =>
    request(context, 'GET', entityPath(type, id), undefined, value => {
      const result = normalizeCommercialAmendmentWorkspace(value);
      if (result.entityType !== type || result.entityId !== id) throw invalid(); return result;
    }),
  preview: (type: LifecycleEntityType, id: string, input: AmendmentInput, context: CommercialAmendmentContext | null) =>
    request(context, 'POST', `${entityPath(type, id)}/preview`, commandBody(input), value => {
      const result = normalizeCommercialAmendmentPreview(value);
      if (result.entityType !== type || result.entityId !== id || result.effectiveOn !== input.effectiveOn || !sameAmendmentTerms(result.after, input)) throw invalid();
      return result;
    }),
  apply: (type: LifecycleEntityType, id: string, input: AmendmentInput & {previewToken: string}, context: CommercialAmendmentContext | null) =>
    request(context, 'POST', entityPath(type, id), {...commandBody(input), previewToken: input.previewToken}, value => {
      const result = normalizeAmendmentEvent(value);
      if (result.sequence !== input.expectedSequence + 1 || result.effectiveOn !== input.effectiveOn || !sameAmendmentTerms(result, input)
        || result.reason !== input.reason || result.approvalReference !== input.approvalReference) throw invalid();
      return result;
    }),
};
