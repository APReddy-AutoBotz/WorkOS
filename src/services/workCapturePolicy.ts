import {api, checkBackend, ApiClientError} from './apiClient';
import {assertOrganizationProfileContext, type OrganizationProfileContext} from './organizationProfileScope';

export type OvertimeCaptureRule={action:'warn'|'block';dailyThreshold:string|null;weeklyThreshold:string|null};
export type CapturePolicy = {
  id: string; sequence: number; policyVersion: 'work-capture-rules/1';
  effectiveFrom: string; minimumIncrement: string; dailyMaximum: string | null;
  weeklyMaximum: string | null; commentRequired: boolean; evidenceRequired: boolean; overtime:OvertimeCaptureRule|null;
};
export type CapturePolicyWorkspace = {
  organizationId: string; legalEntityId: string; serverDate: string; latestId: string | null;
  versions: CapturePolicy[]; truncated: boolean; activationDates: string[];
};
export type CapturePolicyDraft = Pick<CapturePolicy, 'effectiveFrom' | 'minimumIncrement' | 'dailyMaximum' | 'weeklyMaximum' | 'commentRequired'> & {expectedLatestId: string | null; evidenceRequired?: boolean;overtime?:OvertimeCaptureRule|null};
export const workCapturePolicyService = {
  get: async (context: OrganizationProfileContext | null): Promise<CapturePolicyWorkspace> => {
    const owner = assertOrganizationProfileContext(context);
    if (!await checkBackend()) throw new ApiClientError('Capture policy requires the server.', {status: 503});
    assertOrganizationProfileContext(owner);
    const result = await api.requestWithContext<CapturePolicyWorkspace>('GET', '/api/v1/work-capture-policy', undefined, owner);
    assertOrganizationProfileContext(owner);
    if (result.organizationId !== owner.scope.organizationId || result.legalEntityId !== owner.scope.legalEntityId) throw new ApiClientError('Capture policy scope changed. Reload.', {status: 403});
    return result;
  },
  append: async (input: CapturePolicyDraft, context: OrganizationProfileContext | null): Promise<CapturePolicy> => {
    const owner = assertOrganizationProfileContext(context);
    const {expectedLatestId, effectiveFrom, minimumIncrement, dailyMaximum, weeklyMaximum, commentRequired, evidenceRequired, overtime} = input;
    const result = await api.requestWithContext<CapturePolicy>('POST', '/api/v1/work-capture-policy', {expectedLatestId, effectiveFrom,
      minimumIncrement, dailyMaximum, weeklyMaximum, commentRequired, evidenceRequired, overtime}, owner);
    assertOrganizationProfileContext(owner);
    return result;
  },
};
