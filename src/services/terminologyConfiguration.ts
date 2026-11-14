import {getConfiguredTerminologyValue, legacyPluralize, type TerminologyKey, type TerminologyValue} from '../config/productConfig';
import {ApiClientError} from './apiClient';
import type {OrganizationProfileContext} from './organizationProfileScope';
import {isOrganizationProfileContextCurrent} from './organizationProfileScope';

export const TERMINOLOGY_KEYS = Object.freeze(['employee', 'manager', 'teamLead', 'businessUnit', 'region', 'regionalOwner', 'engagement', 'project', 'worklog'] as const);
export type TerminologyConfiguration = {terms: Record<TerminologyKey, TerminologyValue>; effectiveFrom: string; effectiveTo?: string};
const invalid = () => new ApiClientError('Terminology response could not be confirmed.', {status: 502});
const calendarDate = (value: unknown) => {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/.test(value) ? value.slice(0, 10) : '';
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw invalid();
  return date;
};
export const normalizeTerminologyConfiguration = (raw: Record<string, unknown>): TerminologyConfiguration => {
  const values = raw.terms;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid();
  const entries = Object.entries(values);
  if (entries.some(([key]) => !TERMINOLOGY_KEYS.includes(key as TerminologyKey))) throw invalid();
  const terms = Object.fromEntries(TERMINOLOGY_KEYS.map(key => {
    const value = (values as Record<string, unknown>)[key];
    // A successful empty/partial legacy dictionary uses centralized configured
    // defaults for missing keys. A failed GET never creates an editable draft.
    if (value === undefined) return [key, {...getConfiguredTerminologyValue(key)}];
    const structured = typeof value === 'string' ? {singular: value, plural: legacyPluralize(value.trim()), helpText: ''} : value;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) throw invalid();
    const {singular, plural, helpText} = structured as Record<string, unknown>;
    if (typeof singular !== 'string' || !singular.trim() || singular.trim().length > 100
      || typeof plural !== 'string' || !plural.trim() || plural.trim().length > 100
      || typeof helpText !== 'string' || helpText.trim().length > 500) throw invalid();
    return [key, {singular: singular.trim(), plural: plural.trim(), helpText: helpText.trim()}];
  })) as Record<TerminologyKey, TerminologyValue>;
  const effectiveFrom = raw.effective_from === undefined && entries.length === 0 ? new Date().toISOString().slice(0, 10) : calendarDate(raw.effective_from);
  return {terms, effectiveFrom, ...(raw.effective_to ? {effectiveTo: calendarDate(raw.effective_to)} : {})};
};

// A one-use, in-memory result survives the existing runtime child remount. It
// contains no draft and is never persisted across sessions or applied globally.
let feedback: {identityKey: string; token: string | null; organizationId: string; legalEntityId: string; message: string} | undefined;
export const rememberTerminologySave = (context: OrganizationProfileContext, saved: TerminologyConfiguration) => {
  if (!isOrganizationProfileContextCurrent(context)) return;
  feedback = {identityKey: context.identityKey, token: context.token, ...context.scope,
    message: saved.effectiveFrom > new Date().toISOString().slice(0, 10)
      ? `Terminology scheduled for ${saved.effectiveFrom}. Currently effective labels remain in use until that date and a runtime reload.`
      : 'Terminology saved. Runtime labels refresh from the currently effective server version.'};
};
export const takeTerminologyFeedback = (context: OrganizationProfileContext | null, consume = true) => {
  const result = feedback;
  if (consume) feedback = undefined;
  return context && result && isOrganizationProfileContextCurrent(context) && result.identityKey === context.identityKey
    && result.token === context.token && result.organizationId === context.scope.organizationId
    && result.legalEntityId === context.scope.legalEntityId ? result.message : undefined;
};
