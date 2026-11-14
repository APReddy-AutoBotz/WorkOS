import {PROJECT_CONTRIBUTION_VERSION} from '../../shared/project-contribution.mjs';
import {validateProjectContributionCsv} from '../../shared/project-contribution-artifact.mjs';
import {validCapacityRange} from '../../shared/worker-capacity.mjs';
import {api, ApiClientError} from './apiClient';
import {decodeProjectContributionResult, isProjectContributionContextCurrent, type ProjectContributionContext, type ProjectContributionSelection, type ProjectContributionResult} from './projectContribution';

export type ProjectEvidence = {id: string; requestId: string; createdAt: string; activeRole: string; source: 'Web'; reason: string;
  result: ProjectContributionResult; artifact: {fileName: string; sha256: string; bytes: number}};
export type ProjectRetentionIntent = {requestId: string; expectedSourceToken: string; reason: string};
const invalid = (): never => {throw new ApiClientError('Retained report response could not be confirmed. Reconcile the original request.', {status: 503});};
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(','));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const owner = (context: ProjectContributionContext | null) => {
  if (!context || !context.canExport || !isProjectContributionContextCurrent(context)) throw new ApiClientError('Report export access changed. Reload for the current account and scope.', {status: 403});
  return context;
};
const selectionValid = (selection: ProjectContributionSelection) => {
  if (!selection.projectId || selection.projectId.length > 200 || !validCapacityRange(selection.startsOn, selection.endsOn)) invalid();
};
const intentValid = (intent: ProjectRetentionIntent) => {
  if (!uuid(intent.requestId) || !hash(intent.expectedSourceToken) || typeof intent.reason !== 'string' || !intent.reason.trim() || intent.reason.trim().length > 1000) invalid();
};
const evidence = (raw: unknown, selection: ProjectContributionSelection): ProjectEvidence => {
  if (!keys(raw, ['id', 'requestId', 'createdAt', 'activeRole', 'source', 'reason', 'result', 'artifact'])) return invalid();
  if (!uuid(raw.id) || !uuid(raw.requestId) || typeof raw.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt)) ||
    typeof raw.activeRole !== 'string' || !raw.activeRole || raw.activeRole.length > 100 || raw.source !== 'Web' ||
    typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 1000 ||
    !keys(raw.artifact, ['fileName', 'sha256', 'bytes']) || raw.artifact.fileName !== `project-contribution-${raw.id}.csv` ||
    !hash(raw.artifact.sha256) || !Number.isSafeInteger(raw.artifact.bytes) || Number(raw.artifact.bytes) < 1) return invalid();
  return {...raw, result: decodeProjectContributionResult(raw.result, selection)} as ProjectEvidence;
};
const request = async (method: 'GET' | 'POST', suffix: string, selection: ProjectContributionSelection, context: ProjectContributionContext | null, extra: string[], body?: unknown) => {
  const captured = owner(context); selectionValid(selection);
  const raw = await api.requestWithContext<unknown>(method, '/api/v1/project-contribution/projects/' + encodeURIComponent(selection.projectId) + suffix, body, captured);
  owner(captured);
  if (!keys(raw, ['contractVersion', 'organizationId', 'legalEntityId', 'projectId', ...extra]) || raw.contractVersion !== PROJECT_CONTRIBUTION_VERSION || raw.projectId !== selection.projectId) return invalid();
  if (raw.organizationId !== captured.scope.organizationId || raw.legalEntityId !== captured.scope.legalEntityId) throw new ApiClientError('Retained report scope changed.', {status: 403});
  return raw;
};
const matchIntent = (saved: ProjectEvidence, intent: ProjectRetentionIntent) => {
  if (saved.requestId !== intent.requestId || saved.reason !== intent.reason.trim() || saved.result.sourceToken !== intent.expectedSourceToken) invalid();
};
const artifact = async (raw: Record<string, unknown>, selection: ProjectContributionSelection, context: ProjectContributionContext) => {
  const saved = evidence(raw.evidence, selection);
  if (typeof raw.csv !== 'string') return invalid();
  try {validateProjectContributionCsv(context.scope, saved.result, raw.csv);} catch {return invalid();}
  const bytes = new TextEncoder().encode(raw.csv);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
  if (bytes.length !== saved.artifact.bytes || digest !== saved.artifact.sha256) return invalid();
  owner(context);
  return {evidence: saved, csv: raw.csv};
};
export const projectContributionEvidenceService = {
  retain: async (selection: ProjectContributionSelection, intent: ProjectRetentionIntent, context: ProjectContributionContext | null) => {
    const captured = owner(context); intentValid(intent);
    const raw = await request('POST', '/evidence', selection, captured, ['evidence', 'csv', 'replayed'], {startsOn: selection.startsOn, endsOn: selection.endsOn, ...intent, reason: intent.reason.trim()});
    if (typeof raw.replayed !== 'boolean') return invalid();
    const out = await artifact(raw, selection, captured); matchIntent(out.evidence, intent);
    return {...out, replayed: raw.replayed};
  },
  reconcile: async (selection: ProjectContributionSelection, intent: ProjectRetentionIntent, context: ProjectContributionContext | null) => {
    intentValid(intent);
    const raw = await request('GET', '/requests/' + encodeURIComponent(intent.requestId), selection, context, ['evidence']);
    const saved = evidence(raw.evidence, selection); matchIntent(saved, intent); return saved;
  },
  history: async (selection: ProjectContributionSelection, before: string | null, context: ProjectContributionContext | null) => {
    if (before !== null && !uuid(before)) return invalid();
    const query = new URLSearchParams({startsOn: selection.startsOn, endsOn: selection.endsOn, ...(before ? {before} : {})});
    const raw = await request('GET', '/evidence?' + query, selection, context, ['startsOn', 'endsOn', 'evidence', 'nextBefore']);
    if (raw.startsOn !== selection.startsOn || raw.endsOn !== selection.endsOn || !Array.isArray(raw.evidence) || raw.evidence.length > 10 || raw.nextBefore !== null && !uuid(raw.nextBefore)) return invalid();
    const rows = raw.evidence.map(row => evidence(row, selection));
    if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => row.id === before) || raw.nextBefore !== null && (rows.length !== 10 || raw.nextBefore !== rows[9].id)) return invalid();
    return {evidence: rows, nextBefore: raw.nextBefore as string | null};
  },
  artifact: async (selection: ProjectContributionSelection, retained: ProjectEvidence, context: ProjectContributionContext | null) => {
    const captured = owner(context); evidence(retained, selection);
    const raw = await request('GET', '/evidence/' + encodeURIComponent(retained.id) + '/artifact', selection, captured, ['evidence', 'csv']);
    const out = await artifact(raw, selection, captured);
    if (out.evidence.id !== retained.id || out.evidence.artifact.sha256 !== retained.artifact.sha256 || out.evidence.result.sourceToken !== retained.result.sourceToken) return invalid();
    return out;
  },
};
