import {authService} from './authService';
import {api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext} from './apiClient';
import {getEffectivePermissions} from './permissions';

export const COMMERCIAL_CONTRACT_MODELS = ['time_and_materials', 'fixed_fee', 'milestone', 'retainer', 'managed_service'] as const;
export const ENGAGEMENT_MODELS = [...COMMERCIAL_CONTRACT_MODELS, 'internal', 'pre_sales'] as const;
export type ContractModel = typeof COMMERCIAL_CONTRACT_MODELS[number];
export type EngagementModel = typeof ENGAGEMENT_MODELS[number];
export type CommercialDocument = {name: string; url: string};
export const retainerPolicyLabels = {
  billable_expire: 'Billable hours · unused hours expire',
  all_expire: 'All approved hours · unused hours expire',
  billable_rollover: 'Billable hours · carry unused hours to the next service period',
  all_rollover: 'All approved hours · carry unused hours to the next service period',
} as const;
export type RetainerCapacityPolicy = keyof typeof retainerPolicyLabels;
export type RetainerPeriod = {startsOn: string; endsOn: string; includedHours: string; baseFee: string};
export type ContractTermsInput = {
  name: string; model: ContractModel; startsOn: string; endsOn: string; effectiveFrom: string;
  retainerCapacityPolicy?: RetainerCapacityPolicy | null;
  retainerPeriods?: RetainerPeriod[];
  installments?: {dueOn: string; amount: string}[];
  currency: string; value: string; billingTerms: string; documents: CommercialDocument[];
};
export type ContractTerms = ContractTermsInput & {id: string; version: number};
export type ContractSummary = {id: string; number: string; clientId: string; latestVersion: number; terms: ContractTerms; currentTerms: ContractTerms | null};
export type ContractDetail = {id: string; number: string; clientId: string; latestVersion: number; versions: ContractTerms[]};
export type CreateContractInput = ContractTermsInput & {number: string; clientId: string; reason: string};
export type AppendContractVersionInput = ContractTermsInput & {expectedVersion: number; reason: string};
export type CreateEngagementInput = {
  code: string; name: string; model: EngagementModel; ownerId: string; startsOn: string; endsOn: string;
  currency: string; budget: string; contractId: string | null; contractVersionId: string | null;
  clientId: string | null; attributionId: string | null; reason: string;
};
export type Engagement = Omit<CreateEngagementInput, 'reason'> & {id: string; status: 'Draft'; billable: boolean; origin: 'manual' | string};
export type CreatePurchaseOrderInput = {
  contractId: string; contractVersionId: string; number: string; value: string; currency: string;
  startsOn: string; endsOn: string; warningThresholdPercent: string; reason: string;
};
export type PurchaseOrder = Omit<CreatePurchaseOrderInput, 'reason'> & {id: string; status: 'Draft'};
export type CreateMilestoneInput = {engagementId: string; code: string; name: string; dueOn: string; amount: string; currency: string; reason: string};
export type Milestone = Omit<CreateMilestoneInput, 'reason'> & {id: string; status: 'Draft'; billingEligible: false};
export type CommercialChoice = {id: string; name: string};
export type CommercialAttribution = CommercialChoice & {code: string; catalogType: string};
export type CommercialWorkspace = {
  asOf: string; contracts: ContractSummary[]; engagements: Engagement[]; purchaseOrders: PurchaseOrder[]; milestones: Milestone[];
  choices: {clients: CommercialChoice[]; owners: CommercialChoice[]; attributions: CommercialAttribution[]};
  limits: {pageSize: number; truncated: Record<'contracts' | 'engagements' | 'purchaseOrders' | 'milestones' | 'clients' | 'owners' | 'attributions', boolean>};
  legacyMappings: {totalProjects: number; mappedProjects: number};
};

export type CommercialDraftingContext = Readonly<{
  request: ApiRequestContext; identityKey: string; canManage: boolean; canReleasePurchaseOrder?: boolean; canIssueInstallment?: boolean; isCurrent: () => boolean;
}>;
const currentSession = () => {
  // Do not enter authService's legacy localStorage fallback for this workspace.
  try { return sessionStorage.getItem('workos_session') ? authService.getCurrentUser() : null; } catch { return null; }
};
const identityKey = () => {
  const user = currentSession();
  return user && JSON.stringify([user.id, user.employeeId, user.role, user.permissionRole, [...getEffectivePermissions(user)].sort()]);
};
// This lease protects frontend state only. API permissions and resolved row scope
// remain authoritative; no client-supplied actor or ownership is sent in bodies.
export const captureCommercialDraftingContext = (isCurrent = () => true): CommercialDraftingContext | null => {
  const user = currentSession();
  const scope = getOrganizationScope();
  if (!user || !scope || typeof scope.organizationId !== 'string' || !scope.organizationId.trim()
    || typeof scope.legalEntityId !== 'string' || !scope.legalEntityId.trim()) return null;
  const permissions = getEffectivePermissions(user);
  if (!permissions.includes('commercial.contracts.view')) return null;
  return {request: {scope: {...scope}, token: getToken()}, identityKey: identityKey()!,
    canIssueInstallment: permissions.includes('commercial.fixed_fee_eligibility.issue'),
    canReleasePurchaseOrder: permissions.includes('commercial.purchase_orders.release'),
    canManage: permissions.includes('commercial.contracts.manage'), isCurrent};
};
export const isCommercialDraftingContextCurrent = (context: CommercialDraftingContext) => {
  const current = captureCommercialDraftingContext();
  return Boolean(context.isCurrent() && current && context.identityKey === current.identityKey
    && context.request.token === current.request.token
    && context.request.scope.organizationId === current.request.scope.organizationId
    && context.request.scope.legalEntityId === current.request.scope.legalEntityId);
};
export const assertCommercialDraftingContext = (context: CommercialDraftingContext | null, manage = false) => {
  if (!context || !isCommercialDraftingContextCurrent(context) || (manage && !context.canManage)) {
    throw new ApiClientError('Commercial drafting access changed. Reload for the current scope.', {status: 403});
  }
  return context;
};

const invalid = () => new ApiClientError('Commercial drafting response could not be confirmed.', {status: 502});
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw invalid();
  return value;
};
const nullableText = (value: unknown) => value === null ? null : text(value);
const integer = (value: unknown, min = 0) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw invalid();
  return value;
};
const flag = (value: unknown) => { if (typeof value !== 'boolean') throw invalid(); return value; };
const date = (value: unknown) => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString().slice(0, 10) !== result) throw invalid();
  return result;
};
const currency = (value: unknown) => { const result = text(value); if (!/^[A-Z]{3}$/.test(result)) throw invalid(); return result; };
const decimal = (value: unknown) => { const result = text(value); if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(result)) throw invalid(); return result; };
const percent = (value: unknown) => { const result = text(value); if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(result) || Number(result) > 100) throw invalid(); return result; };
const model = <T extends string>(value: unknown, allowed: readonly T[]): T => { if (!allowed.includes(value as T)) throw invalid(); return value as T; };
const rows = <T>(value: unknown, normalize: (row: unknown) => T): T[] => {
  if (!Array.isArray(value)) throw invalid();
  return value.map(normalize);
};
const documents = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 10) throw invalid();
  return rows(value, row => {
  const item = object(row); const url = text(item.url);
  let parsed: URL; try { parsed = new URL(url); } catch { throw invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw invalid();
  return {name: text(item.name), url};
  });
};
const normalizeTerms = (value: unknown): ContractTerms => {
  const item = object(value);
  return {id: text(item.id), version: integer(item.version, 1), name: text(item.name), model: model(item.model, COMMERCIAL_CONTRACT_MODELS),
    startsOn: date(item.startsOn), endsOn: date(item.endsOn), effectiveFrom: date(item.effectiveFrom), currency: currency(item.currency),
    value: decimal(item.value), billingTerms: text(item.billingTerms), documents: documents(item.documents),
    ...(item.retainerCapacityPolicy == null ? {} : {retainerCapacityPolicy:model(item.retainerCapacityPolicy,Object.keys(retainerPolicyLabels) as RetainerCapacityPolicy[])}),
    ...(item.retainerPeriods === undefined ? {} : {retainerPeriods: rows(item.retainerPeriods, value => {
      const period = object(value);
      return {startsOn: date(period.startsOn), endsOn: date(period.endsOn), includedHours: decimal(period.includedHours), baseFee: decimal(period.baseFee)};
    })}),
    ...(item.installments === undefined ? {} : {installments: rows(item.installments, value => {
      const installment = object(value);
      return {dueOn: date(installment.dueOn), amount: decimal(installment.amount)};
    })})};
};
const normalizeContractSummary = (value: unknown): ContractSummary => {
  const item = object(value);
  const latestVersion = integer(item.latestVersion, 1);
  const terms = normalizeTerms(item.terms);
  const currentTerms = item.currentTerms === null ? null : normalizeTerms(item.currentTerms);
  if (terms.version !== latestVersion || (currentTerms && currentTerms.version > latestVersion)) throw invalid();
  return {id: text(item.id), number: text(item.number), clientId: text(item.clientId), latestVersion, terms, currentTerms};
};
export const normalizeCommercialContract = (value: unknown): ContractDetail => {
  const item = object(value); const versions = rows(item.versions, normalizeTerms); const latestVersion = integer(item.latestVersion, 1);
  if (!versions.length || versions.length !== latestVersion || latestVersion > 200 || !versions.some(version => version.version === latestVersion)
    || new Set(versions.map(version => version.version)).size !== versions.length) throw invalid();
  return {id: text(item.id), number: text(item.number), clientId: text(item.clientId), latestVersion, versions};
};
const normalizeEngagement = (value: unknown): Engagement => {
  const item = object(value);
  if (item.status !== 'Draft' || item.origin !== 'manual'
    || (['internal', 'pre_sales'].includes(String(item.model)) && item.billable !== false)) throw invalid();
  return {id: text(item.id), code: text(item.code), name: text(item.name), model: model(item.model, ENGAGEMENT_MODELS),
    ownerId: text(item.ownerId), startsOn: date(item.startsOn), endsOn: date(item.endsOn), currency: currency(item.currency), budget: decimal(item.budget),
    contractId: nullableText(item.contractId), contractVersionId: nullableText(item.contractVersionId), clientId: nullableText(item.clientId),
    attributionId: nullableText(item.attributionId), status: 'Draft', billable: flag(item.billable), origin: text(item.origin)};
};
const normalizePurchaseOrder = (value: unknown): PurchaseOrder => {
  const item = object(value); if (item.status !== 'Draft') throw invalid();
  return {id: text(item.id), contractId: text(item.contractId), contractVersionId: text(item.contractVersionId), number: text(item.number),
    value: decimal(item.value), currency: currency(item.currency), startsOn: date(item.startsOn), endsOn: date(item.endsOn),
    warningThresholdPercent: percent(item.warningThresholdPercent), status: 'Draft'};
};
const normalizeMilestone = (value: unknown): Milestone => {
  const item = object(value); if (item.status !== 'Draft' || item.billingEligible !== false) throw invalid();
  return {id: text(item.id), engagementId: text(item.engagementId), code: text(item.code), name: text(item.name), dueOn: date(item.dueOn),
    amount: decimal(item.amount), currency: currency(item.currency), status: 'Draft', billingEligible: false};
};
const normalizeChoice = (value: unknown): CommercialChoice => { const item = object(value); return {id: text(item.id), name: text(item.name)}; };
export const normalizeCommercialWorkspace = (value: unknown): CommercialWorkspace => {
  const item = object(value); const choices = object(item.choices); const limits = object(item.limits); const truncated = object(limits.truncated);
  const mappings = object(item.legacyMappings);
  if (limits.pageSize !== 200 || ['contracts', 'engagements', 'purchaseOrders', 'milestones'].some(key => !Array.isArray(item[key]) || (item[key] as unknown[]).length > 200)
    || ['clients', 'owners', 'attributions'].some(key => !Array.isArray(choices[key]) || (choices[key] as unknown[]).length > 200)
    || integer(mappings.mappedProjects) > integer(mappings.totalProjects)) throw invalid();
  return {asOf: date(item.asOf), contracts: rows(item.contracts, normalizeContractSummary), engagements: rows(item.engagements, normalizeEngagement),
    purchaseOrders: rows(item.purchaseOrders, normalizePurchaseOrder), milestones: rows(item.milestones, normalizeMilestone),
    choices: {clients: rows(choices.clients, normalizeChoice), owners: rows(choices.owners, normalizeChoice), attributions: rows(choices.attributions, row => {
      const choice = normalizeChoice(row); const attribution = object(row); return {...choice, code: text(attribution.code), catalogType: model(attribution.catalogType, ['business_unit', 'cost_centre'])};
    })},
    limits: {pageSize: integer(limits.pageSize, 1), truncated: {
      contracts: flag(truncated.contracts), engagements: flag(truncated.engagements), purchaseOrders: flag(truncated.purchaseOrders), milestones: flag(truncated.milestones),
      clients: flag(truncated.clients), owners: flag(truncated.owners), attributions: flag(truncated.attributions)}},
    legacyMappings: {totalProjects: integer(mappings.totalProjects), mappedProjects: integer(mappings.mappedProjects)}};
};

const PREFIX = '/api/v1/commercial-drafting';
const request = async <T>(context: CommercialDraftingContext | null, method: 'GET' | 'POST', path: string, body: unknown, normalize: (value: unknown) => T) => {
  const owner = assertCommercialDraftingContext(context, method === 'POST');
  const result = await api.requestWithContext<unknown>(method, `${PREFIX}${path}`, body, owner.request);
  assertCommercialDraftingContext(owner, method === 'POST');
  return normalize(result);
};
// Explicit allowlists keep strict commands free of response/actor/scope fields.
const termsBody = (input: ContractTermsInput) => ({name: input.name, model: input.model, startsOn: input.startsOn,
  endsOn: input.endsOn, effectiveFrom: input.effectiveFrom, currency: input.currency, value: input.value,
  ...(input.retainerCapacityPolicy !== undefined && {retainerCapacityPolicy:input.retainerCapacityPolicy}),
  ...(input.retainerPeriods && {retainerPeriods: input.retainerPeriods.map(({startsOn, endsOn, includedHours, baseFee}) => ({startsOn, endsOn, includedHours, baseFee}))}),
  ...(input.installments && {installments: input.installments.map(({dueOn, amount}) => ({dueOn, amount}))}),
  billingTerms: input.billingTerms, documents: input.documents.map(document => ({name: document.name, url: document.url}))});
export type PurchaseOrderRelease = {actorId:string; activeRole:string; approvalReference:string; reason:string; releasedAt:string};
const releaseResponse = (value:unknown, order:PurchaseOrder): PurchaseOrderRelease | null => {
  const row=object(value);
  if (row.orderId !== order.id || row.contractVersionId !== order.contractVersionId) throw invalid();
  if (row.release === null) return null;
  const release=object(row.release);
  const releasedAt=text(release.releasedAt);
  if (!Number.isFinite(Date.parse(releasedAt))) throw invalid();
  return {actorId:text(release.actorId), activeRole:text(release.activeRole), approvalReference:text(release.approvalReference),
    reason:text(release.reason), releasedAt};
};
const installmentReceipts = (value: unknown) => rows(object(value).receipts, entry => {
  const r = object(entry);
  return {eventId:text(r.eventId), itemId:text(r.itemId), installment:integer(r.installment,1),
    contractVersionId:text(r.contractVersionId), engagementId:text(r.engagementId), eligibleOn:date(r.eligibleOn),
    dueOn:date(r.dueOn), currency:currency(r.currency), amount:decimal(r.amount)};
});
export const commercialDraftingService = {
  installmentRegister: (versionId:string, context:CommercialDraftingContext,
    command?:{installment:number; engagementId:string; reason:string}) =>
    request(context,command?'POST':'GET',`/fixed-fee-schedules/${encodeURIComponent(versionId)}/register`,command,installmentReceipts),
  retainerConsumption: (contractId:string, version:ContractTerms, context:CommercialDraftingContext) =>
    request(context,'GET',`/contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(version.id)}/retainer-consumption`,undefined,value=>{
      const row=object(value);
      if (row.contractId!==contractId || row.versionId!==version.id) throw invalid();
      const periods=rows(row.periods, item=>{
        const p=object(item);
        const quantity=(v:unknown)=>{const s=text(v); if (!/^\d+(?:\.\d+)?$/.test(s)) throw invalid(); return s;};
        const c=p.capacity===undefined ? null : object(p.capacity);
        if (c && !version.retainerCapacityPolicy) throw invalid();
        const capacity=c && {carriedIn:quantity(c.carriedIn),consumed:quantity(c.consumed),remaining:quantity(c.remaining),
          overage:quantity(c.overage),carriedOut:quantity(c.carriedOut),expired:quantity(c.expired)};
        return {capacity,startsOn:date(p.startsOn),endsOn:date(p.endsOn),billableHours:quantity(p.billableHours),nonBillableHours:quantity(p.nonBillableHours)};
      });
      const expected=version.retainerPeriods ?? [];
      if (periods.length!==expected.length || periods.some((p,i)=>p.startsOn!==expected[i].startsOn || p.endsOn!==expected[i].endsOn)) throw invalid();
      return periods;
    }),
  purchaseOrderBalance: (order:PurchaseOrder, context:CommercialDraftingContext) =>
    request(context,'GET','/purchase-orders/'+encodeURIComponent(order.id)+'/balance',undefined,value=>{
      const row=object(value);
      if(row.orderId!==order.id || row.contractVersionId!==order.contractVersionId || row.currency!==order.currency) throw invalid();
      return {committed:decimal(row.committed),consumed:decimal(row.consumed),remaining:decimal(row.remaining),warning:flag(row.warning)};
    }),
  purchaseOrderRelease: (order:PurchaseOrder, context:CommercialDraftingContext, command?:{approvalReference:string;reason:string}) =>
    request(context, command?'POST':'GET','/purchase-orders/'+encodeURIComponent(order.id)+'/release',
      command?{contractVersionId:order.contractVersionId,...command}:undefined,value=>{
        const release=releaseResponse(value,order);
        if (command && (!release || release.approvalReference!==command.approvalReference || release.reason!==command.reason)) throw invalid();
        return release;
      }),

  getWorkspace: (context: CommercialDraftingContext | null) => request(context, 'GET', '/workspace', undefined, normalizeCommercialWorkspace),
  getContract: (id: string, context: CommercialDraftingContext | null) => request(context, 'GET', `/contracts/${encodeURIComponent(id)}`, undefined, value => {
    const contract = normalizeCommercialContract(value); if (contract.id !== id) throw invalid(); return contract;
  }),
  createContract: (input: CreateContractInput, context: CommercialDraftingContext | null) => request(context, 'POST', '/contracts',
    {...termsBody(input), number: input.number, clientId: input.clientId, reason: input.reason}, normalizeCommercialContract),
  appendContractVersion: (id: string, input: AppendContractVersionInput, context: CommercialDraftingContext | null) => request(context, 'POST', `/contracts/${encodeURIComponent(id)}/versions`,
    {...termsBody(input), expectedVersion: input.expectedVersion, reason: input.reason}, value => {
      const contract = normalizeCommercialContract(value);
      if (contract.id !== id || contract.latestVersion !== input.expectedVersion + 1) throw invalid();
      return contract;
    }),
  createEngagement: (input: CreateEngagementInput, context: CommercialDraftingContext | null) => request(context, 'POST', '/engagements', {
    code: input.code, name: input.name, model: input.model, ownerId: input.ownerId, startsOn: input.startsOn, endsOn: input.endsOn, currency: input.currency,
    budget: input.budget, contractId: input.contractId, contractVersionId: input.contractVersionId, clientId: input.clientId, attributionId: input.attributionId, reason: input.reason,
  }, normalizeEngagement),
  createPurchaseOrder: (input: CreatePurchaseOrderInput, context: CommercialDraftingContext | null) => request(context, 'POST', '/purchase-orders', {
    contractId: input.contractId, contractVersionId: input.contractVersionId, number: input.number, value: input.value, currency: input.currency,
    startsOn: input.startsOn, endsOn: input.endsOn, warningThresholdPercent: input.warningThresholdPercent, reason: input.reason,
  }, normalizePurchaseOrder),
  createMilestone: (input: CreateMilestoneInput, context: CommercialDraftingContext | null) => request(context, 'POST', '/milestones', {
    engagementId: input.engagementId, code: input.code, name: input.name, dueOn: input.dueOn, amount: input.amount, currency: input.currency, reason: input.reason,
  }, normalizeMilestone),
};
