import {PROJECT_CONTRIBUTION_VERSION, readProjectContributionResult} from '../../shared/project-contribution.mjs';
import {validCapacityRange} from '../../shared/worker-capacity.mjs';
import {api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext} from './apiClient';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
import type {ActualControls} from './actualWork';

type Percentage = {numeratorExact: string; denominatorExact: string; displayPercent: string};
type Measure = {status: 'available' | 'unavailable' | 'not_applicable'; includedHoursExact: string | null; eligibleAvailableHoursExact: string | null; percentage: Percentage | null; controls: ActualControls | null; reasonCodes: string[]};
export type ProjectContributionResult = Measure & {calculationVersion: 'project-contribution/1'; projectId: string; startsOn: string; endsOn: string; cohortRule: string; inclusionRule: string; denominatorRule: string; workerCount: number | null; rows: Array<Measure & {employeeId: string}> | null; sourceToken: string; observedAt: string};
export type ProjectContributionReport = {project: {id: string; name: string}; workers: Array<{id: string; code: string; name: string}>; result: ProjectContributionResult};
export type ProjectContributionSelection = {projectId: string; startsOn: string; endsOn: string};
export type ProjectContributionContext = ApiRequestContext & {identityKey: string; canExport: boolean; isCurrent: () => boolean};

const required = ['projects.view', 'employees.view', 'reports.view_utilization'];
const identity = () => {const user = authService.getCurrentUser(); return user && JSON.stringify([user.id, user.employeeId, user.role, user.permissionRole, [...getEffectivePermissions(user)].sort()]);};
export const captureProjectContributionContext = (isCurrent = () => true): ProjectContributionContext | null => {
  const user = authService.getCurrentUser(), scope = getOrganizationScope(), permissions = getEffectivePermissions(user);
  if (!user || !scope?.organizationId || !scope.legalEntityId || !required.every(permission => permissions.includes(permission))) return null;
  return {scope: {...scope}, token: getToken(), identityKey: identity()!, canExport: permissions.includes('reports.export'), isCurrent};
};
export const isProjectContributionContextCurrent = (context: ProjectContributionContext) => {
  const current = captureProjectContributionContext();
  return Boolean(context.isCurrent() && current && current.identityKey === context.identityKey && current.token === context.token && current.scope.organizationId === context.scope.organizationId && current.scope.legalEntityId === context.scope.legalEntityId);
};
const owner = (context: ProjectContributionContext | null) => {
  if (!context || !isProjectContributionContextCurrent(context)) throw new ApiClientError('Project reporting access changed. Reload for the current account and scope.', {status: 403});
  return context;
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const invalid = (): never => {throw new ApiClientError('Project contribution response could not be confirmed. Reload explicitly.', {status: 503});};
export const decodeProjectContributionResult = (value: unknown, selection: ProjectContributionSelection): ProjectContributionResult => {
  try {return readProjectContributionResult(value, selection.projectId, selection.startsOn, selection.endsOn) as ProjectContributionResult;} catch {return invalid();}
};
export const projectContributionService = {
  period: async (selection: ProjectContributionSelection, context: ProjectContributionContext | null): Promise<ProjectContributionReport> => {
    const captured = owner(context);
    if (!selection.projectId || selection.projectId.length > 200 || !validCapacityRange(selection.startsOn, selection.endsOn)) invalid();
    const query = new URLSearchParams({startsOn: selection.startsOn, endsOn: selection.endsOn});
    const raw = await api.requestWithContext<unknown>('GET', '/api/v1/project-contribution/projects/' + encodeURIComponent(selection.projectId) + '/period?' + query, undefined, captured);
    owner(captured);
    if (!keys(raw, ['contractVersion', 'organizationId', 'legalEntityId', 'project', 'workers', 'result']) || raw.contractVersion !== PROJECT_CONTRIBUTION_VERSION) invalid();
    const envelope = raw as Record<string, unknown>;
    if (envelope.organizationId !== captured.scope.organizationId || envelope.legalEntityId !== captured.scope.legalEntityId) throw new ApiClientError('Project report scope changed. Reload explicitly.', {status: 403});
    if (!keys(envelope.project, ['id', 'name']) || envelope.project.id !== selection.projectId || !text(envelope.project.name) || !Array.isArray(envelope.workers) || envelope.workers.length > 500) invalid();
    const workers = (envelope.workers as unknown[]).map(worker => {
      if (!keys(worker, ['id', 'code', 'name']) || !text(worker.id) || !text(worker.code) || !text(worker.name)) invalid();
      return worker as {id: string; code: string; name: string};
    });
    if (new Set(workers.map(worker => worker.id)).size !== workers.length) invalid();
    const result = decodeProjectContributionResult(envelope.result, selection);
    if (result.rows === null && workers.length !== 0) invalid();
    if (result.rows && (workers.length !== result.rows.length || workers.some((worker, index) => worker.id !== result.rows![index].employeeId))) invalid();
    return {project: envelope.project as {id: string; name: string}, workers, result};
  }
};
