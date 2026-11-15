import {decimalQuantity,compareHours} from '../../shared/work-hours.mjs';
export type SubmissionDeadlineRule={anchor:'weekly-end-date';timezone:'UTC';daysAfterPeriodEnd:number;time:string;graceMinutes:number;lateTreatment:'warn'|'block'};
import {api, checkBackend, ApiClientError} from './apiClient';
import {assertOrganizationProfileContext, type OrganizationProfileContext} from './organizationProfileScope';

export type OvertimeCaptureRule={action:'warn'|'block';dailyThreshold:string|null;weeklyThreshold:string|null};
export type CapturePolicy = {
  id: string; sequence: number; policyVersion: 'work-capture-rules/1';
  effectiveFrom: string; minimumIncrement: string; dailyMaximum: string | null;
  weeklyMaximum: string | null; commentRequired: boolean; evidenceRequired: boolean; overtime:OvertimeCaptureRule|null;submissionDeadline:SubmissionDeadlineRule|null;
};
export type CapturePolicyWorkspace = {
  organizationId: string; legalEntityId: string; serverDate: string; latestId: string | null;
  versions: CapturePolicy[]; truncated: boolean; activationDates: string[];
};
export type CapturePolicyDraft = Pick<CapturePolicy, 'effectiveFrom' | 'minimumIncrement' | 'dailyMaximum' | 'weeklyMaximum' | 'commentRequired'> & {expectedLatestId: string | null; evidenceRequired?: boolean;overtime?:OvertimeCaptureRule|null;submissionDeadline?:SubmissionDeadlineRule|null};
const hasOvertimeRule = (value: unknown) => {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  if ((rule.action !== 'warn' && rule.action !== 'block')
    || Object.keys(rule).sort().join(',') !== 'action,dailyThreshold,weeklyThreshold'
    || (rule.dailyThreshold === null && rule.weeklyThreshold === null)) return false;
  return [['dailyThreshold', '24'], ['weeklyThreshold', '168']].every(([key, maximum]) => {
    const threshold = rule[key];
    if (threshold === null) return true;
    if (typeof threshold !== 'string') return false;
    try { const quantity = decimalQuantity(threshold); return quantity.units > 0n && quantity.scale <= 4 && compareHours(threshold, maximum) <= 0; }
    catch { return false; }
  });
};
const hasSubmissionDeadlineRule = (value: unknown) => {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return Object.keys(rule).sort().join(',') === 'anchor,daysAfterPeriodEnd,graceMinutes,lateTreatment,time,timezone'
    && rule.anchor === 'weekly-end-date' && rule.timezone === 'UTC'
    && typeof rule.daysAfterPeriodEnd === 'number' && Number.isInteger(rule.daysAfterPeriodEnd) && rule.daysAfterPeriodEnd >= 0 && rule.daysAfterPeriodEnd <= 366
    && typeof rule.graceMinutes === 'number' && Number.isInteger(rule.graceMinutes) && rule.graceMinutes >= 0 && rule.graceMinutes <= 527040
    && typeof rule.time === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(rule.time)
    && (rule.lateTreatment === 'warn' || rule.lateTreatment === 'block');
};
const hasEvidencePolicy = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof (value as Record<string, unknown>).evidenceRequired === 'boolean'
  && hasOvertimeRule((value as Record<string, unknown>).overtime)
  && hasSubmissionDeadlineRule((value as Record<string, unknown>).submissionDeadline);
const invalidPolicyResponse = () => new ApiClientError('Capture policy response could not be verified. Reload before making another change.', {status: 503});
export const workCapturePolicyService = {
  get: async (context: OrganizationProfileContext | null): Promise<CapturePolicyWorkspace> => {
    const owner = assertOrganizationProfileContext(context);
    if (!await checkBackend()) throw new ApiClientError('Capture policy requires the server.', {status: 503});
    assertOrganizationProfileContext(owner);
    const result = await api.requestWithContext<CapturePolicyWorkspace>('GET', '/api/v1/work-capture-policy', undefined, owner);
    assertOrganizationProfileContext(owner);
    if (result.organizationId !== owner.scope.organizationId || result.legalEntityId !== owner.scope.legalEntityId) throw new ApiClientError('Capture policy scope changed. Reload.', {status: 403});
    // Missing evidence, overtime or deadline configuration is unknown, never an implicit opt-out.
    if (!Array.isArray(result.versions) || !result.versions.every(hasEvidencePolicy)
      || result.latestId !== (result.versions[0]?.id ?? null)) throw invalidPolicyResponse();
    return result;
  },
  append: async (input: CapturePolicyDraft, context: OrganizationProfileContext | null): Promise<CapturePolicy> => {
    const owner = assertOrganizationProfileContext(context);
    const {expectedLatestId, effectiveFrom, minimumIncrement, dailyMaximum, weeklyMaximum, commentRequired, evidenceRequired, overtime, submissionDeadline} = input;
    const result = await api.requestWithContext<CapturePolicy>('POST', '/api/v1/work-capture-policy', {expectedLatestId, effectiveFrom,
      minimumIncrement, dailyMaximum, weeklyMaximum, commentRequired, evidenceRequired, overtime, submissionDeadline}, owner);
    assertOrganizationProfileContext(owner);
    if (!hasEvidencePolicy(result)) throw invalidPolicyResponse();
    return result;
  },
};
