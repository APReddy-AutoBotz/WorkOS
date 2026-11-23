import {z} from 'zod';
import {validServiceEffort} from '../../shared/service-unit-effort.mjs';
import {canonicalHours,decimalQuantity,formatQuantity,sumHours as sumExactAmounts} from '../../shared/work-hours.mjs';
import {authService} from './authService';
import {api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext} from './apiClient';
import {getEffectivePermissions} from './permissions';

const costDecimal=z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const fixedFeeCostEntry=z.object({
  entryId:z.string().uuid(),workerId:z.string().min(1),workDate:z.string().date(),hours:costDecimal,
  priority:z.number().int().min(0).max(1000).nullable(),snapshotId:z.string().uuid().nullable(),decisionId:z.string().min(1).nullable(),adoptionId:z.string().uuid().nullable(),
  candidateId:z.string().uuid().nullable(),effectiveFrom:z.string().date().nullable(),effectiveTo:z.string().date().nullable(),
  currency:z.string().regex(/^[A-Z]{3}$/).nullable(),hourlyRate:costDecimal.nullable(),amount:costDecimal.nullable(),
}).strict().refine(row=>{
  const fields=[row.priority,row.decisionId,row.adoptionId,row.candidateId,row.effectiveFrom,row.effectiveTo,row.currency,row.hourlyRate,row.amount];
  if (fields.every(x=>x===null)) return row.snapshotId===null;
  if (fields.some(x=>x===null) || row.workDate<row.effectiveFrom! || row.workDate>row.effectiveTo!) return false;
  const a=decimalQuantity(row.hours),b=decimalQuantity(row.hourlyRate!);
  return formatQuantity({units:a.units*b.units,scale:a.scale+b.scale})===row.amount;
});

const costSource=z.object({
  evidenceId:z.string().uuid(),reviewId:z.string().uuid(),adoptionId:z.string().uuid(),candidateId:z.string().uuid(),
  effectiveFrom:z.string().date(),effectiveTo:z.string().date(),serviceDate:z.string().date(),currency:z.string().regex(/^[A-Z]{3}$/),
  priority:z.number().int().min(0).max(1000),resolutionRule:z.literal('worker-hourly-priority/1'),
  hours:z.string().refine(validServiceEffort),hourlyRate:z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/),
  amount:z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/),
}).strict();
const costState=z.object({snapshot:costSource.extend({id:z.string().uuid()}).nullable(),preview:costSource.nullable()}).strict();

export const COMMERCIAL_CONTRACT_MODELS = ['time_and_materials', 'fixed_fee', 'milestone', 'retainer', 'managed_service'] as const;
export const ENGAGEMENT_MODELS = [...COMMERCIAL_CONTRACT_MODELS, 'internal', 'pre_sales'] as const;
export type ContractModel = typeof COMMERCIAL_CONTRACT_MODELS[number];
export type EngagementModel = typeof ENGAGEMENT_MODELS[number];
export type CommercialDocument = {name: string; url: string};
export const retainerRoundingModes={HALF_UP:'Half up',HALF_EVEN:'Half even',DOWN:'Round down'} as const;
export type RetainerRounding={precision:number;mode:keyof typeof retainerRoundingModes};
export const retainerOverageLabels = {
  no_charge:'No charge for excess hours',
  contract_hourly_at_period_end:'Adopted contract hourly rate effective on the period end date',
} as const;
export type RetainerOveragePolicy = keyof typeof retainerOverageLabels;
export const retainerPolicyLabels = {
  billable_expire: 'Billable hours · unused hours expire',
  all_expire: 'All approved hours · unused hours expire',
  billable_rollover: 'Billable hours · carry unused hours to the next service period',
  all_rollover: 'All approved hours · carry unused hours to the next service period',
} as const;
export type RetainerCapacityPolicy = keyof typeof retainerPolicyLabels;
export type ServiceDimension = {code:string;label:string;precision:number;unitPrice?:string;billingPrecision?:number};
export type ServicePeriodCharge = {startsOn:string; endsOn:string; amount:string};
export type RetainerPeriod = {startsOn: string; endsOn: string; includedHours: string; baseFee: string};
export type ContractTermsInput = {
  name: string; model: ContractModel; startsOn: string; endsOn: string; effectiveFrom: string;
  retainerRounding?: RetainerRounding | null;
  retainerOveragePolicy?: RetainerOveragePolicy | null;
  retainerCapacityPolicy?: RetainerCapacityPolicy | null;
  servicePeriodCharges?: ServicePeriodCharge[];
  serviceDimensions?: ServiceDimension[];
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
  request: ApiRequestContext; identityKey: string; canManage: boolean; canSetServicePolicy?:boolean; canValueUnits?:boolean; canViewEffortCost?:boolean; canRecordEffortCost?:boolean; canReconcileEffort?:boolean; canViewServiceMargin?:boolean; canViewFixedFeeEffort?:boolean; canViewFixedFeeCost?:boolean; canViewFixedFeeRisk?:boolean; canRecordFixedFeeForecast?:boolean; canRecordFixedFeeCost?:boolean; canRetainServiceMargin?:boolean; canIssueServiceUnits?:boolean; canValuePeriods?: boolean; canIssuePeriods?: boolean; canReviewPeriods?: boolean; canReviewUnits?: boolean; canCaptureUnits?: boolean; canReleasePurchaseOrder?: boolean; canIssueInstallment?: boolean; isCurrent: () => boolean;
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
    canSetServicePolicy: permissions.includes('commercial.service_units.policy'),
    canIssueServiceUnits: permissions.includes('commercial.service_units.issue'),
    canRecordFixedFeeForecast:permissions.includes('commercial.fixed_fee_forecast.record'),
    canViewFixedFeeRisk:!['Employee','TeamLead','ProjectManager','CountryDirector'].includes(user.role) &&
      ['employees.view','reports.view_utilization','commercial.cost_candidates.view','commercial.fixed_fee_cost.view'].every(k=>permissions.includes(k)),
    canViewFixedFeeCost:['employees.view','reports.view_utilization','commercial.cost_candidates.view','commercial.fixed_fee_cost.view'].every(k=>permissions.includes(k)),
    canRecordFixedFeeCost:permissions.includes('commercial.fixed_fee_cost.record'),
    canViewFixedFeeEffort:['employees.view','reports.view_utilization'].every(k=>permissions.includes(k)),
    canViewServiceMargin:!['Employee','TeamLead','ProjectManager','CountryDirector'].includes(user.role) &&
      ['commercial.service_margin.view','commercial.service_cost.view','commercial.cost_candidates.view','employees.view','reports.view_utilization'].every(k=>permissions.includes(k)),
    canRetainServiceMargin:permissions.includes('commercial.service_margin.record'),
    canReconcileEffort:['commercial.service_units.decide','employees.view','reports.view_utilization'].every(k=>permissions.includes(k)),
    canRecordEffortCost:permissions.includes('commercial.service_cost.record'),
    canViewEffortCost:['commercial.service_cost.view','commercial.cost_candidates.view','employees.view'].every(k=>permissions.includes(k)),
    canValueUnits: permissions.includes('commercial.service_units.value'),
    canValuePeriods: permissions.includes('commercial.service_periods.value'),
    canIssuePeriods: permissions.includes('commercial.service_periods.issue'),
    canReviewPeriods: permissions.includes('commercial.service_periods.decide'),
    canReviewUnits: permissions.includes('commercial.service_units.decide'),
    canCaptureUnits: permissions.includes('commercial.service_units.capture'),
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
const registerMoney = (value: unknown) => {
  const result=text(value);
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(result)) throw invalid();
  return result;
};
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
const normalizeRounding = (value:unknown):RetainerRounding => {
  const r=object(value),precision=integer(r.precision);
  if (precision>4) throw invalid();
  return {precision,mode:model(r.mode,['HALF_UP','HALF_EVEN','DOWN'] as const)};
};
const normalizeServiceDimensions = (value:unknown, contractModel:unknown): ServiceDimension[] => {
  if (contractModel !== 'managed_service' || !Array.isArray(value) || value.length>50) throw invalid();
  const seen=new Set<string>();
  return rows(value,entry=>{
    const unit=object(entry), code=text(unit.code), label=text(unit.label), precision=integer(unit.precision);
    if (Object.keys(unit).some(key=>!['code','label','precision','unitPrice','billingPrecision'].includes(key)) || !/^[A-Z][A-Z0-9_]{0,39}$/.test(code) || seen.has(code) ||
        !label || label!==label.trim() || [...label].length>80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(label) || precision>4) throw invalid();
    seen.add(code);
    if (unit.unitPrice!==undefined && (typeof unit.unitPrice!=='string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(unit.unitPrice))) throw invalid();
    const billingPrecision=unit.billingPrecision===undefined?undefined:integer(unit.billingPrecision);
    if (billingPrecision!==undefined && (unit.unitPrice===undefined || billingPrecision>4)) throw invalid();
    return {code,label,precision,...(billingPrecision!==undefined?{billingPrecision}:{}),...(typeof unit.unitPrice==='string'?{unitPrice:unit.unitPrice}:{})};
  });
};
const normalizeServicePeriodCharges = (contract: Record<string, unknown>): ServicePeriodCharge[] => {
  const terms = contract.servicePeriodCharges;
  if (contract.model !== 'managed_service' || !Array.isArray(terms) || terms.length > 120) throw invalid();
  let previousEnd = '';
  return rows(terms, value => {
    const term = object(value), startsOn = date(term.startsOn), endsOn = date(term.endsOn), amount = decimal(term.amount);
    if (Object.keys(term).length !== 3 || startsOn < date(contract.startsOn) || endsOn > date(contract.endsOn) ||
        startsOn > endsOn || startsOn <= previousEnd || !/[1-9]/.test(amount)) throw invalid();
    previousEnd = endsOn;
    return {startsOn, endsOn, amount};
  });
};
const normalizeTerms = (value: unknown): ContractTerms => {
  const item = object(value);
  return {id: text(item.id), version: integer(item.version, 1), name: text(item.name), model: model(item.model, COMMERCIAL_CONTRACT_MODELS),
    startsOn: date(item.startsOn), endsOn: date(item.endsOn), effectiveFrom: date(item.effectiveFrom), currency: currency(item.currency),
    value: decimal(item.value), billingTerms: text(item.billingTerms), documents: documents(item.documents),
    ...(item.retainerRounding == null ? {} : {retainerRounding:normalizeRounding(item.retainerRounding)}),
    ...(item.retainerOveragePolicy == null ? {} : {retainerOveragePolicy:model(item.retainerOveragePolicy,Object.keys(retainerOverageLabels) as RetainerOveragePolicy[])}),
    ...(item.retainerCapacityPolicy == null ? {} : {retainerCapacityPolicy:model(item.retainerCapacityPolicy,Object.keys(retainerPolicyLabels) as RetainerCapacityPolicy[])}),
    ...(item.servicePeriodCharges === undefined ? {} : {servicePeriodCharges:normalizeServicePeriodCharges(item)}),
    ...(item.serviceDimensions === undefined ? {} : {serviceDimensions:normalizeServiceDimensions(item.serviceDimensions,item.model)}),
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
const request = async <T>(context: CommercialDraftingContext | null, method: 'GET' | 'POST', path: string, body: unknown, normalize: (value: unknown) => T, manage=method==='POST') => {
  const owner = assertCommercialDraftingContext(context, manage);
  const result = await api.requestWithContext<unknown>(method, `${PREFIX}${path}`, body, owner.request);
  assertCommercialDraftingContext(owner, manage);
  return normalize(result);
};
// Explicit allowlists keep strict commands free of response/actor/scope fields.
const termsBody = (input: ContractTermsInput) => ({name: input.name, model: input.model, startsOn: input.startsOn,
  endsOn: input.endsOn, effectiveFrom: input.effectiveFrom, currency: input.currency, value: input.value,
  ...(input.retainerRounding !== undefined && {retainerRounding:input.retainerRounding}),
  ...(input.retainerOveragePolicy !== undefined && {retainerOveragePolicy:input.retainerOveragePolicy}),
  ...(input.retainerCapacityPolicy !== undefined && {retainerCapacityPolicy:input.retainerCapacityPolicy}),
  ...(input.servicePeriodCharges && {servicePeriodCharges:input.servicePeriodCharges.map(({startsOn,endsOn,amount})=>({startsOn,endsOn,amount}))}),
  ...(input.serviceDimensions && {serviceDimensions:input.serviceDimensions.map(({code,label,precision,unitPrice,billingPrecision})=>({code,label,precision,...(billingPrecision!==undefined?{billingPrecision}:{}),...(unitPrice!==undefined?{unitPrice}:{})}))}),
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
    dueOn:date(r.dueOn), currency:currency(r.currency), amount:decimal(r.amount),identityCurrent:flag(r.identityCurrent)};
});
const statementHash=(v:unknown)=>{const s=text(v);if (!/^[a-f0-9]{64}$/.test(s)) throw invalid();return s;};
const statementReceipt=(value:unknown)=>{
  const r=object(value);
  const d=r.review==null ? null : object(r.review);
  if (d && d.statementId!==r.id) throw invalid();
  const review=d && {id:text(d.id),decision:model(d.decision,['Approved','Rejected'] as const),reason:text(d.reason),
    actorId:text(d.actorId),activeRole:text(d.activeRole),createdAt:text(d.createdAt)};
  return {review,currentPreparer:r.currentPreparer===true,id:text(r.id),sequence:integer(r.sequence,1),previousId:nullableText(r.previousId),sourceHash:statementHash(r.sourceHash),
    actorId:text(r.actorId),activeRole:text(r.activeRole),createdAt:text(r.createdAt),reason:text(r.reason)};
};
const statementEvidence=(value:unknown,contractId:string,version:ContractTerms,startsOn:string)=>{
  const e=object(value),p=object(e.price),price=object(p.periodPrice),rounding=normalizeRounding(e.rounding);
  if (e.format!=='retainer-statement/1' || e.contractId!==contractId || e.versionId!==version.id || p.startsOn!==startsOn ||
      e.currency!==version.currency || rounding.mode!==version.retainerRounding?.mode || rounding.precision!==version.retainerRounding?.precision) throw invalid();
  const quantity=(v:unknown)=>{const s=text(v);if (!/^\d+(?:\.\d+)?$/.test(s)) throw invalid();return s;};
  const periods=rows(e.periods,item=>{
    const r=object(item),entries=rows(r.entries,item=>{const w=object(item);return {entryId:text(w.entryId),decisionId:text(w.decisionId),
      workerId:text(w.workerId),submissionId:text(w.submissionId),projectId:text(w.projectId),engagementId:text(w.engagementId),workDate:date(w.workDate),hours:quantity(w.hours),billable:flag(w.billable)};});
    const entryCount=integer(r.entryCount); if (entryCount<entries.length) throw invalid();
    return {entryCount,startsOn:date(r.startsOn),endsOn:date(r.endsOn),entries};
  });
  const source=p.source ? object(p.source) : null;
  const totalEntries=integer(e.totalEntries),entryOffset=integer(e.entryOffset),nextOffset=e.nextOffset===null?null:integer(e.nextOffset);
  if (totalEntries!==periods.reduce((n,p)=>n+p.entryCount,0) || entryOffset>totalEntries ||
    periods.reduce((n,p)=>n+p.entries.length,0)!==Math.min(100,totalEntries-entryOffset) ||
    nextOffset!==(entryOffset+100<totalEntries?entryOffset+100:null)) throw invalid();
  return {periods,entryOffset,nextOffset,totalEntries,closed:flag(e.closed),baseFee:quantity(price.baseFee),overage:quantity(price.overage),total:quantity(price.total),
    adoptionId:source ? text(source.adoptionId) : null,approvalId:source ? text(source.approvalId) : null,
    rate:source ? quantity(source.hourlyRate) : null};
};
export type ServiceUnitInput = {versionId:string;serviceDate:string;dimensionCode:string;quantity:string;sourceReference:string;effortHours?:string};
type UnitDecision='Accepted'|'Rejected';
const normalizeUnitReview=(value:unknown,evidenceId:string)=>{
  const r=object(value);
  if(r.evidenceId!==evidenceId) throw invalid();
  return {id:text(r.id),decision:model(r.decision,['Accepted','Rejected'] as const),reason:text(r.reason),createdAt:text(r.createdAt)};
};
const unitPolicy=(value:unknown)=>{
  const r=object(value),profile=model(r.profile,['accepted_unit','approved_period','disabled'] as const);
  const precision=r.precision===null?null:integer(r.precision);
  if ((profile==='disabled')!==(precision===null) || (precision!==null && precision>4)) throw invalid();
  return {id:text(r.id),effectiveFrom:date(r.effectiveFrom),profile,precision,reason:text(r.reason),ownerId:text(r.ownerId)};
};
const unitValue=(value:unknown,evidenceId:string)=>{
  const r=object(value);
  if(r.evidenceId!==evidenceId) throw invalid();
  const amount=text(r.amount);
  if(!/^\d+(?:\.\d{1,4})?$/.test(amount)) throw invalid();
  return {id:text(r.id),reviewId:text(r.reviewId),policyId:text(r.policyId),versionId:text(r.versionId),quantity:text(r.quantity),unitPrice:decimal(r.unitPrice),currency:currency(r.currency),amount};
};
const effortReconciliationLabels:Record<string,string>={
  matched:'Recorded effort matches approved work.', hours_differ:'Recorded and approved hours differ.',
  no_recorded_effort:'No effort was recorded.', pending_review:'Service evidence awaits review.', rejected:'Service evidence was rejected.',
  ambiguous_reference:'Multiple service receipts share this work reference.', no_approved_work:'No approved work has this reference.',
  unverified_work:'Approved work could not be verified against the retained submission and contract terms.'
};
const serviceEngPath=(id:string)=>'/engagements/'+encodeURIComponent(id);
const serviceValuePath=(eng:string,id:string)=>serviceEngPath(eng)+'/service-unit-evidence/'+encodeURIComponent(id)+'/valuation';
export const commercialDraftingService = {
  serviceRegister(eng:string,id:string,reviewId:string,context:CommercialDraftingContext,command?:{reason:string},source:'unit'|'period'='unit') {
    if(source==='period' && !assertCommercialDraftingContext(context).canIssuePeriods) throw invalid();
    const collection=source==='period'?'/service-period-reviews/':'/service-unit-evidence/';
    return request(context,command?'POST':'GET',serviceEngPath(eng)+collection+encodeURIComponent(id)+'/billing',command && {reviewId,reason:command.reason},v=>{
      const r=object(v);
      const charge=r.charge===null?null:object(r.charge),receipt=r.receipt===null?null:object(r.receipt);
      if ((charge && charge.reviewId!==reviewId) || (receipt && receipt.reviewId!==reviewId) || (charge && receipt)) throw invalid();
      const money=(row:Record<string,unknown>)=>{const amount=text(row.amount);if (!/^\d{1,16}(?:\.\d{1,4})?$/.test(amount)) throw invalid();return {amount,currency:currency(row.currency)};};
      return {charge:charge && money(charge),receipt:receipt && {...money(receipt),itemId:text(receipt.itemId),eventId:text(receipt.eventId),eligibleOn:date(receipt.eligibleOn)}};
    },false);
  },
  servicePeriodReview(contractId:string,version:ContractTerms,term:ServicePeriodCharge,context:CommercialDraftingContext,command?:{decision:'Approved'|'Rejected';reason:string}) {
    if (command && !assertCommercialDraftingContext(context).canReviewPeriods) throw invalid();
    const path='/contracts/'+encodeURIComponent(contractId)+'/versions/'+encodeURIComponent(version.id)+'/service-periods/'+term.startsOn+'/review';
    return request(context,command?'POST':'GET',path,command,value=>{
      const result=object(value);
      if (result.review===null && !command) return null;
      const r=object(result.review), decision=model(r.decision,['Approved','Rejected'] as const);
      const amount=decimal(r.amount), reason=text(r.reason);
      const canonical=(n:string)=>n.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
      if (r.contractId!==contractId || r.versionId!==version.id || r.startsOn!==term.startsOn || r.endsOn!==term.endsOn ||
          r.currency!==version.currency || canonical(amount)!==canonical(term.amount) || (command && (decision!==command.decision || reason!==command.reason.trim()))) throw invalid();
      return {id:text(r.id),decision,reason};
    },false);
  },
  fixedFeeForecast(eng:string,through:string,context:CommercialDraftingContext,options:{version?:number;command?:{
    remainingHours:string;remainingCost:string;reason:string;expectedToken:string;expectedVersion:number;requestId:string}}={}) {
    const current=assertCommercialDraftingContext(context),cmd=options.command;
    if (!current.canViewFixedFeeRisk || (cmd && !current.canRecordFixedFeeForecast)) throw invalid();
    const path=serviceEngPath(eng)+'/fixed-fee-forecast',query=new URLSearchParams({through});
    if (options.version) query.set('version',String(options.version));
    return request(context,cmd?'POST':'GET',cmd?path:path+'?'+query,cmd?{...cmd,through}:undefined,value=>{
      const baseline=z.object({engagementId:z.literal(eng),through:z.literal(through),currency:z.string().regex(/^[A-Z]{3}$/),
        contractVersionId:z.string().min(1),amendmentId:z.string().min(1).nullable(),approvedEntries:z.number().int().nonnegative(),
        costedEntries:z.number().int().nonnegative(),hoursComplete:z.boolean(),costComplete:z.boolean(),
        actualHours:costDecimal,actualCost:costDecimal,budgetHours:costDecimal.nullable(),budgetCost:costDecimal.nullable()}).strict();
      const snapshot=z.object({id:z.string().uuid(),version:z.number().int().positive(),reason:z.string().min(3),createdAt:z.string().datetime(),
        report:baseline.extend({remainingHours:costDecimal,remainingCost:costDecimal,estimatedHours:costDecimal.nullable(),estimatedCost:costDecimal.nullable()}).strict()}).strict();
      const data=z.object({baseline,latestVersion:z.number().int().nonnegative(),token:z.string().regex(/^[0-9a-f]{64}$/),saved:snapshot.nullable()}).strict().parse(value);
      const saved=data.saved,r=saved?.report;
      if (!!saved!==(data.latestVersion>0) || (saved && saved.version>data.latestVersion) ||
        (options.version && saved?.version!==options.version) || (cmd && (saved?.version!==cmd.expectedVersion+1 ||
          r?.remainingHours!==cmd.remainingHours || r?.remainingCost!==cmd.remainingCost || saved.reason!==cmd.reason.trim()))) throw invalid();
      if (r && (r.estimatedHours!==(r.hoursComplete?sumExactAmounts([r.actualHours,r.remainingHours]):null) ||
          r.estimatedCost!==(r.costComplete?sumExactAmounts([r.actualCost,r.remainingCost]):null))) throw invalid();
      return data;
    },false);
  },
  fixedFeeRisk(eng:string,through:string,context:CommercialDraftingContext) {
    if (!assertCommercialDraftingContext(context).canViewFixedFeeRisk) throw invalid();
    return request(context,'GET',serviceEngPath(eng)+'/fixed-fee-risk?'+new URLSearchParams({through}),undefined,value=>{
      const signed=z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
      const states=z.enum(['no_work','incomplete','remaining','exhausted','exceeded']);
      const report=z.object({engagementId:z.literal(eng),through:z.literal(through),currency:z.string().regex(/^[A-Z]{3}$/),
        contractVersionId:z.string().min(1),amendmentId:z.string().min(1).nullable(),allocation:costDecimal,retainedCost:costDecimal,
        effortBudget:z.object({budgetHours:costDecimal,verifiedHours:costDecimal,remainingHours:signed,
          unresolvedEntries:z.number().int().nonnegative(),status:states}).strict().nullable(),
        remainingAllocation:signed,status:states,laborCostBudget:costDecimal.nullable(),remainingLaborBudget:signed.nullable(),laborBudgetStatus:states.nullable(),
        approvedEntries:z.number().int().nonnegative(),costedEntries:z.number().int().nonnegative(),complete:z.boolean()}).strict().parse(value);
      if (report.complete && (report.approvedEntries===0 || report.costedEntries!==report.approvedEntries)) throw invalid();
      const check=(budget:string,remaining:string|null,state:string|null,actual=report.retainedCost,
        noWork=report.approvedEntries===0 && report.costedEntries===0,complete=report.complete)=>{
        const a=decimalQuantity(budget),c=decimalQuantity(actual),scale=Math.max(a.scale,c.scale);
        const difference=a.units*10n**BigInt(scale-a.scale)-c.units*10n**BigInt(scale-c.scale);
        const expected=(difference<0n?'-':'')+formatQuantity({units:difference<0n?-difference:difference,scale});
        const status=difference<0n?'exceeded':noWork?'no_work':!complete?'incomplete':difference===0n?'exhausted':'remaining';
        if (remaining!==expected || state!==status) throw invalid();
      };
      check(report.allocation,report.remainingAllocation,report.status);
      if (report.laborCostBudget!==null) check(report.laborCostBudget,report.remainingLaborBudget,report.laborBudgetStatus);
      else if (report.remainingLaborBudget!==null || report.laborBudgetStatus!==null) throw invalid();
      const effort=report.effortBudget;
      if (effort) {
        if (effort.unresolvedEntries>report.approvedEntries) throw invalid();
        check(effort.budgetHours,effort.remainingHours,effort.status,effort.verifiedHours,report.approvedEntries===0,effort.unresolvedEntries===0);
      }
      return report;
    },false);
  },
  fixedFeeCosts(eng:string,monthStart:string,context:CommercialDraftingContext,cmd?:{entryId:string;adoptionId:string;decisionId:string}) {
    if (!assertCommercialDraftingContext(context).canViewFixedFeeCost || (cmd && !context.canRecordFixedFeeCost)) throw invalid();
    const path=serviceEngPath(eng)+'/fixed-fee-costs';
    return request(context,cmd?'POST':'GET',cmd?path:path+'?'+new URLSearchParams({monthStart}),cmd?{...cmd,monthStart}:undefined,value=>{
      const data=z.object({engagementId:z.literal(eng),monthStart:z.literal(monthStart),unresolvedEntries:z.number().int().nonnegative(),
        entries:z.array(fixedFeeCostEntry),complete:z.boolean(),retainedTotals:z.array(z.object({currency:z.string().regex(/^[A-Z]{3}$/),amount:costDecimal}).strict())}).strict().parse(value);
      if (data.entries.some(e=>e.workDate.slice(0,7)!==monthStart.slice(0,7)) || new Set(data.entries.map(e=>e.entryId)).size!==data.entries.length) throw invalid();
      const amounts=new Map<string,string[]>();
      for (const row of data.entries) {
        if (!row.snapshotId || !row.currency || row.amount===null) continue;
        const bucket=amounts.get(row.currency);
        if (bucket) bucket.push(row.amount);
        else amounts.set(row.currency,[row.amount]);
      }
      if (data.retainedTotals.length!==amounts.size || new Set(data.retainedTotals.map(t=>t.currency)).size!==amounts.size ||
        data.retainedTotals.some(t=>!amounts.has(t.currency) || sumExactAmounts(amounts.get(t.currency)!)!==t.amount) ||
        (data.complete && (!data.entries.length || data.unresolvedEntries!==0 || data.entries.some(e=>!e.snapshotId)))) throw invalid();
      if (cmd && (data.entries.length!==1 || !data.entries[0].snapshotId || data.entries[0].entryId!==cmd.entryId ||
        data.entries[0].adoptionId!==cmd.adoptionId || data.entries[0].decisionId!==cmd.decisionId)) throw invalid();
      return data;
    },false);
  },
  fixedFeeEffort(eng:string,monthStart:string,context:CommercialDraftingContext) {
    if (!assertCommercialDraftingContext(context).canViewFixedFeeEffort) throw invalid();
    return request(context,'GET',serviceEngPath(eng)+'/fixed-fee-effort?'+new URLSearchParams({monthStart}),undefined,value=>{
      const r=object(value);
      const count=(n:unknown)=>{if (typeof n!=='number' || !Number.isSafeInteger(n) || n<0) throw invalid();return n;};
      const hours=(v:unknown)=>{const h=text(v);if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(h)) throw invalid();return h;};
      if (r.engagementId!==eng || r.monthStart!==monthStart) throw invalid();
      return {verifiedEntries:count(r.verifiedEntries),unresolvedEntries:count(r.unresolvedEntries),
        billableHours:hours(r.billableHours),nonBillableHours:hours(r.nonBillableHours)};
    },false);
  },
  serviceMargin(eng:string,monthStart:string,context:CommercialDraftingContext,options:{version?:number;expectedToken?:string}={}) {
    if (!assertCommercialDraftingContext(context).canViewServiceMargin || (options.expectedToken && !context.canRetainServiceMargin)) throw invalid();
    const query=new URLSearchParams({monthStart});
    if (options.version) query.set('version',String(options.version));
    const path=serviceEngPath(eng)+'/service-period-margin';
    return request(context,options.expectedToken?'POST':'GET',options.expectedToken?path:path+'?'+query,
      options.expectedToken?{monthStart,expectedToken:options.expectedToken}:undefined,value=>{
        const r=object(value), p=object(r.report);
        if (r.engagementId!==eng || r.monthStart!==monthStart || p.calculationVersion!=='managed-service-month/1' ||
          !/^[A-Z]{3}$/.test(text(p.currency)) || !/^[0-9a-f]{64}$/.test(text(r.token))) throw invalid();
        const exact=(v:unknown)=>{const s=text(v);if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) throw invalid();return s;};
        return {version:r.version===null?null:integer(r.version,1),latestVersion:integer(r.latestVersion),token:text(r.token),
          currency:text(p.currency),billable:exact(p.billable),cost:exact(p.retainedCost),margin:p.margin===null?null:exact(p.margin),
          percent:p.marginPercent===null?null:exact(p.marginPercent),hours:exact(p.approvedHours),entries:integer(p.approvedEntries),
          verified:integer(p.verifiedEntries),pending:integer(p.pending),missing:integer(p.missingCosts),unresolved:integer(p.unresolvedReceipts),
          receipts:z.array(z.unknown()).parse(p.receipts).length,billingEvents:z.array(z.string().uuid()).parse(p.billingEvents).length};
      },false);
  },
  reconcileEffort(eng:string,id:string,c:CommercialDraftingContext) {
    if (!assertCommercialDraftingContext(c).canReconcileEffort) throw invalid();
    return request(c,'GET',serviceEngPath(eng)+'/service-unit-evidence/'+encodeURIComponent(id)+'/reconciliation',undefined,value=>{
      const r=object(value);
      const status=text(r.status);
      if (r.evidenceId!==id || !Object.hasOwn(effortReconciliationLabels,status)) throw invalid();
      const verified=status==='matched' || status==='hours_differ';
      if (verified && !(Number.isInteger(r.entryCount) && Number(r.entryCount)>0 && Number(r.entryCount)<=100)) throw invalid();
      if (!verified && (r.approvedHours!==null || r.entryCount!==null)) throw invalid();
      return {label:effortReconciliationLabels[status],approvedHours:verified?decimal(r.approvedHours):null,entryCount:verified?Number(r.entryCount):null};
    },false);
  },
  periodValue(engagementId:string,reviewId:string,version:ContractTerms,term:ServicePeriodCharge,context:CommercialDraftingContext,policyId?:string) {
    if (!assertCommercialDraftingContext(context).canValuePeriods) throw invalid();
    const receipt=(value:unknown)=>{
      const r=object(value);
      if (r.reviewId!==reviewId || r.engagementId!==engagementId || r.versionId!==version.id || r.currency!==version.currency || r.endsOn!==term.endsOn ||
        decimal(r.sourceAmount)!==term.amount.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'') || (policyId && r.policyId!==policyId)) throw invalid();
      const amount=text(r.amount);
      if (!/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/.test(amount)) throw invalid();
      return {id:text(r.id),amount,currency:currency(r.currency),policyId:text(r.policyId)};
    };
    return request(context,policyId?'POST':'GET',serviceEngPath(engagementId)+'/service-period-reviews/'+encodeURIComponent(reviewId)+'/valuation',
      policyId?{policyId}:undefined,v=>{
        if (policyId) return {valuation:receipt(v),policy:null};
        const r=object(v); return {valuation:r.valuation===null?null:receipt(r.valuation),policy:r.policy===null?null:unitPolicy(r.policy)};
      },false);
  },
  effortCost(eng:string,id:string,reviewId:string,c:CommercialDraftingContext,adoptionId?:string) {
    if (!assertCommercialDraftingContext(c).canViewEffortCost || (adoptionId && !c.canRecordEffortCost)) throw new ApiClientError('Worker cost access changed.',{status:403});
    return request(c,adoptionId?'POST':'GET','/engagements/'+encodeURIComponent(eng)+'/service-unit-evidence/'+encodeURIComponent(id)+'/effort-cost',
      adoptionId?{reviewId,adoptionId}:undefined,v=>{
        const state=costState.parse(v),source=state.snapshot??state.preview;
        if (state.snapshot && state.preview || adoptionId && state.snapshot?.adoptionId!==adoptionId) throw invalid();
        if (source) {
          const h=decimalQuantity(source.hours),r=decimalQuantity(source.hourlyRate);
          if (source.evidenceId!==id || source.reviewId!==reviewId || source.effectiveFrom>source.serviceDate || source.effectiveTo<source.serviceDate ||
              source.amount!==formatQuantity({units:h.units*r.units,scale:h.scale+r.scale})) throw invalid();
        }
        return state;
      },false);
  },
  servicePolicy(eng:string,c:CommercialDraftingContext) {
    return request(c,'GET',serviceEngPath(eng)+'/service-valuation-policy',undefined,v=>{
      const r=object(v);return {latest:r.latest===null?null:unitPolicy(r.latest),effective:r.effective===null?null:unitPolicy(r.effective)};
    });
  },
  setServicePolicy(eng:string,command:{previousId:string|null;profile:'accepted_unit'|'approved_period'|'disabled';effectiveFrom:string;precision:number|null;reason:string},c:CommercialDraftingContext) {
    return request(c,'POST',serviceEngPath(eng)+'/service-valuation-policy',command,unitPolicy,false);
  },
  inspectServiceValue(eng:string,id:string,c:CommercialDraftingContext) {
    return request(c,'GET',serviceValuePath(eng,id),undefined,v=>{
      const r=object(v);return {policy:r.policy===null?null:unitPolicy(r.policy),valuation:r.valuation===null?null:unitValue(r.valuation,id)};
    });
  },
  recordServiceValue(eng:string,id:string,reviewId:string,policyId:string,c:CommercialDraftingContext) {
    return request(c,'POST',serviceValuePath(eng,id),{reviewId,policyId},v=>{
      const result=unitValue(v,id);if (result.reviewId!==reviewId || result.policyId!==policyId) throw invalid();return result;
    },false);
  },
  reviewUnits(engagementId:string,evidenceId:string,decision:UnitDecision,reason:string,context:CommercialDraftingContext) {
    if (!assertCommercialDraftingContext(context).canReviewUnits) throw new ApiClientError('Service review access changed.',{status:403});
    return request(context,'POST','/engagements/'+encodeURIComponent(engagementId)+'/service-unit-evidence/'+encodeURIComponent(evidenceId)+'/review',
      {decision,reason},value=>{
        const review=normalizeUnitReview(value,evidenceId);
        if (review.decision!==decision || review.reason!==reason) throw invalid();
        return review;
      },false);
  },
  serviceUnitHistory(engagementId:string,versionId:string,before:string|null,context:CommercialDraftingContext) {
    const query=new URLSearchParams({versionId});if (before) query.set('before',before);
    return request(context,'GET','/engagements/'+encodeURIComponent(engagementId)+'/service-unit-evidence?'+query,undefined,value=>{
      const r=object(value);
      return {before:nullableText(r.before),records:rows(r.records,item=>{
        const e=object(item);
        if(e.engagementId!==engagementId || e.versionId!==versionId) throw invalid();
        if (e.effortHours!=null && !validServiceEffort(e.effortHours)) throw invalid();
        return {effortHours:e.effortHours==null?null:text(e.effortHours),review:e.review==null?null:normalizeUnitReview(e.review,text(e.id)),id:text(e.id),serviceDate:date(e.serviceDate),dimensionCode:text(e.dimensionCode),quantity:text(e.quantity),sourceReference:text(e.sourceReference)};
      })};
    });
  },
  captureUnits(engagementId:string,input:ServiceUnitInput,context:CommercialDraftingContext) {
    if (!assertCommercialDraftingContext(context).canCaptureUnits) throw new ApiClientError('Service capture access changed.',{status:403});
    return request(context,'POST','/engagements/'+encodeURIComponent(engagementId)+'/service-unit-evidence',input,value=>{
      const r=object(value);
      if (r.engagementId!==engagementId || r.versionId!==input.versionId || r.serviceDate!==input.serviceDate ||
          r.dimensionCode!==input.dimensionCode || r.quantity!==input.quantity || r.sourceReference!==input.sourceReference ||
          (r.effortHours??null)!==(input.effortHours===undefined?null:canonicalHours(input.effortHours))) throw invalid();
      return text(r.id);
    },false);
  },
  retainerStatement: (contractId:string,version:ContractTerms,startsOn:string,context:CommercialDraftingContext,
    action?: {statementId?:string;entriesOffset?:number}|{sourceHash:string;previousId:string|null;reason:string;renewReviewIdentity?:true}|
      {sourceHash:string;statementId:string;decision:'Approved'|'Rejected';reason:string},reviewOnly=false)=>{
    const reviewing=!!(action && 'decision' in action);
    const selected=!reviewing && action && 'statementId' in action ? action.statementId : null;
    const query=new URLSearchParams();
    if (selected) query.set('statementId',selected);
    if (action && 'entriesOffset' in action) query.set('entriesOffset',String(action.entriesOffset));
    const command=action && 'sourceHash' in action ? action : undefined;
    const path=`/contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(version.id)}/retainer-statements/${encodeURIComponent(startsOn)}`;
    return request(context,command?'POST':'GET',path+(reviewOnly||reviewing?'/review':'')+(query.size?'?'+query.toString():''),command,value=>{
      const row=object(value);
      if (row.contractId!==contractId || row.versionId!==version.id || row.startsOn!==startsOn) throw invalid();
      if (selected || command) {
        const record=statementReceipt(row.record);
        if (selected && record.id!==selected || command && record.sourceHash!==command.sourceHash) throw invalid();
        if (action && 'decision' in action && (record.id!==action.statementId || record.review?.decision!==action.decision || record.review?.reason!==action.reason)) throw invalid();
        return {record,evidence:selected ? statementEvidence(object(row.record).evidence,contractId,version,startsOn) : null,
          sourceHash:null,history:[]};
      }
      const hash=row.sourceHash===null ? null : statementHash(row.sourceHash);
      if (Boolean(hash)!==Boolean(row.evidence)) throw invalid();
      return {record:null,evidence:hash ? statementEvidence(row.evidence,contractId,version,startsOn) : null,
        sourceHash:hash,history:rows(row.history,statementReceipt)};
    },Boolean(command && !reviewing));
  },
  retainerRegister: (contractId:string, version:ContractTerms, startsOn:string, context:CommercialDraftingContext,
    command?:{statementId:string;reviewId:string;engagementId:string;reason:string}) =>
    request(context,command?'POST':'GET',`/contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(version.id)}/retainer-statements/${encodeURIComponent(startsOn)}/register`,command,value=>{
      const row=object(value),r=row.receipt===null?null:object(row.receipt),s=row.statement===null?null:object(row.statement);
      const receipt=r && {eventId:text(r.eventId),itemId:text(r.itemId),engagementId:text(r.engagementId),statementId:text(r.statementId),
        reviewId:text(r.reviewId),amount:registerMoney(r.amount),currency:currency(r.currency),eligibleOn:date(r.eligibleOn)};
      if (command && (!receipt || receipt.engagementId!==command.engagementId || receipt.statementId!==command.statementId || receipt.reviewId!==command.reviewId)) throw invalid();
      if ((receipt && receipt.currency!==version.currency) || (s && s.currency!==version.currency)) throw invalid();
      return {receipt,statement:s && {statementId:text(s.statementId),reviewId:text(s.reviewId),amount:registerMoney(s.amount),currency:currency(s.currency)},
        engagements:rows(row.engagements,entry=>{const e=object(entry);return {id:text(e.id),name:text(e.name)};})};
    },false),
  installmentRegister: (versionId:string, context:CommercialDraftingContext,
    command?:{installment:number; engagementId:string; reason:string}) =>
    request(context,command?'POST':'GET',`/fixed-fee-schedules/${encodeURIComponent(versionId)}/register`,command,installmentReceipts),
  retainerOveragePreview: (contractId:string,version:ContractTerms,context:CommercialDraftingContext) =>
    request(context,'GET',`/contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(version.id)}/retainer-overage-preview`,undefined,value=>{
      const row=object(value);
      if (row.contractId!==contractId || row.versionId!==version.id || row.currency!==version.currency) throw invalid();
      const exact=(v:unknown)=>{const s=text(v); if (!/^\d+(?:\.\d+)?$/.test(s)) throw invalid(); return s;};
      return rows(row.periods,entry=>{
        const p=object(entry), startsOn=date(p.startsOn), endsOn=date(p.endsOn);
        if (!version.retainerPeriods?.some(term=>term.startsOn===startsOn && term.endsOn===endsOn)) throw invalid();
        const hours=exact(p.hours);
        const status=model(p.status,['priced','missing','conflict','no_charge','no_excess'] as const);
        const amount=p.amount==null ? null : exact(p.amount);
        if ((status==='no_charge')!==(version.retainerOveragePolicy==='no_charge') ||
          ((status==='missing'||status==='conflict')!==(amount===null)) ||
          ((status==='no_charge'||status==='no_excess') && amount!=='0')) throw invalid();
        const src=status==='priced' ? object(p.source) : null;
        const source=src && {adoptionId:text(src.adoptionId),candidateId:text(src.candidateId),approvalId:text(src.approvalId),
          effectiveFrom:date(src.effectiveFrom),effectiveTo:date(src.effectiveTo),hourlyRate:exact(src.hourlyRate)};
        if (source && (endsOn<source.effectiveFrom || endsOn>source.effectiveTo)) throw invalid();
        const price=p.periodPrice==null ? null : object(p.periodPrice);
        if (Boolean(price)!==Boolean(version.retainerRounding && amount!==null)) throw invalid();
        const money=(v:unknown)=>{
          const s=exact(v);
          if ((s.split('.')[1]?.length ?? 0)!==version.retainerRounding?.precision) throw invalid();
          return s;
        };
        const periodPrice=price && {baseFee:money(price.baseFee),overage:money(price.overage),total:money(price.total)};
        return {startsOn,endsOn,hours,status,amount,source,periodPrice};
      });
    }),
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
