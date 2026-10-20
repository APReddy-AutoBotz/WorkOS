import {authService} from './authService';
import {api, ApiClientError, getOrganizationScope, getToken, type ApiRequestContext} from './apiClient';
import {getEffectivePermissions} from './permissions';

export type BillingContact = {name: string; email: string};
export type UnitProfileFields = {effectiveFrom: string; legalName: string | null; displayName: string | null; defaultCurrency: string | null; billingContacts: BillingContact[]};
export type ClientProfileFields = UnitProfileFields & {parentClientId: string | null};
export type UnitProfile = UnitProfileFields & {id: string; version: number};
export type ClientProfile = ClientProfileFields & {id: string; version: number};
export type ClientProfileSummary = {id: string; operationalName: string; industry: string | null; status: string; accountOwnerId: string | null;
  code: string | null; latestVersion: number; currentProfile: ClientProfile | null; latestProfile: ClientProfile | null};
export type ClientBillingUnit = {id: string; clientId: string; code: string; kind: 'billing_entity' | 'business_unit'; latestVersion: number; currentProfile: UnitProfile | null; versions: UnitProfile[]};
export type ClientProfilesWorkspace = {asOf: string; clients: ClientProfileSummary[]; limit: 200; truncated: boolean};
export type ClientProfileDetail = ClientProfileSummary & {asOf: string; versions: ClientProfile[]; billingUnits: ClientBillingUnit[]; limit: 200; truncated: boolean};
export type AppendClientProfileInput = ClientProfileFields & {expectedVersion: number; code: string; reason: string};
export type CreateBillingUnitInput = UnitProfileFields & {code: string; kind: ClientBillingUnit['kind']; reason: string};
export type AppendBillingUnitVersionInput = UnitProfileFields & {expectedVersion: number; reason: string};
export type ClientProfilesContext = Readonly<{request: ApiRequestContext; identityKey: string; canManage: boolean; isCurrent: () => boolean}>;
const session = () => {
  // Explicit session only: never enter the legacy browser-local fallback.
  try { return sessionStorage.getItem('workos_session') ? authService.getCurrentUser() : null; } catch { return null; }
};
export const captureClientProfilesContext = (isCurrent = () => true): ClientProfilesContext | null => {
  const user = session(); const scope = getOrganizationScope();
  if (user && (typeof user.id !== 'string' || !user.id.trim() || typeof user.employeeId !== 'string' || !user.employeeId.trim()
    || typeof user.role !== 'string' || (user.permissions !== undefined && (!Array.isArray(user.permissions) || user.permissions.some(permission => typeof permission !== 'string' || !permission.trim()))))) return null;
  if (!user || !scope || typeof scope.organizationId !== 'string' || !scope.organizationId.trim()
    || typeof scope.legalEntityId !== 'string' || !scope.legalEntityId.trim()) return null;
  const permissions = getEffectivePermissions(user);
  if (!permissions.includes('commercial.clients.view')) return null;
  return {request: {scope: {...scope}, token: getToken()}, identityKey: JSON.stringify([user.id, user.employeeId, user.role, user.permissionRole, [...permissions].sort()]),
    canManage: permissions.includes('commercial.clients.manage'), isCurrent};
};
export const isClientProfilesContextCurrent = (context: ClientProfilesContext) => {
  const now = captureClientProfilesContext();
  return Boolean(context.isCurrent() && now && context.identityKey === now.identityKey && context.request.token === now.request.token && context.canManage === now.canManage
    && context.request.scope.organizationId === now.request.scope.organizationId && context.request.scope.legalEntityId === now.request.scope.legalEntityId);
};
export const assertClientProfilesContext = (context: ClientProfilesContext | null, manage = false) => {
  if (!context || !isClientProfilesContextCurrent(context) || (manage && !context.canManage)) {
    throw new ApiClientError('Client profile access changed. Reload for the current scope.', {status: 403});
  }
  return context;
};
const invalid = () => new ApiClientError('Client profile response could not be confirmed.', {status: 502});
const object = (value: unknown): Record<string, unknown> => {if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();return value as Record<string, unknown>;};
const text = (value: unknown, max = 200) => {if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();return value;};
const nullable = (value: unknown, normalize = text): string | null => value === null ? null : normalize(value);
const integer = (value: unknown, min = 0, max = 200) => {if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();return value;};
const flag = (value: unknown) => {if (typeof value !== 'boolean') throw invalid();return value;};
const date = (value: unknown) => {const result = text(value);if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw invalid();return result;};
const code = (value: unknown) => {const result = text(value, 80);if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(result)) throw invalid();return result;};
const currency = (value: unknown) => {const result = text(value, 3);if (!/^[A-Z]{3}$/.test(result)) throw invalid();return result;};
const rows = <T>(value: unknown, normalize: (row: unknown) => T, max = 200): T[] => {if (!Array.isArray(value) || value.length > max) throw invalid();return value.map(normalize);};
const unique = <T extends {id: string}>(values: T[]) => {if (new Set(values.map(value => value.id)).size !== values.length) throw invalid();return values;};
const fields = (item: Record<string, unknown>): UnitProfileFields => ({effectiveFrom: date(item.effectiveFrom), legalName: nullable(item.legalName), displayName: nullable(item.displayName),
  defaultCurrency: nullable(item.defaultCurrency, currency), billingContacts: rows(item.billingContacts, value => {
    const contact = object(value);const email = text(contact.email, 254);if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid();
    return {name: text(contact.name), email};
  }, 10)});
const unitProfile = (value: unknown): UnitProfile => {const item = object(value);return {id: text(item.id), version: integer(item.version, 1), ...fields(item)};};
const profile = (value: unknown): ClientProfile => {const item = object(value);return {...unitProfile(item), parentClientId: nullable(item.parentClientId)};};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const summary = (value: unknown, asOf: string): ClientProfileSummary => {
  const item = object(value);const latestVersion = integer(item.latestVersion);const currentProfile = item.currentProfile === null ? null : profile(item.currentProfile);
  const latestProfile = item.latestProfile === null ? null : profile(item.latestProfile);const id = text(item.id);const clientCode = nullable(item.code, code);
  if ((latestVersion === 0) !== (latestProfile === null) || (latestVersion === 0) !== (clientCode === null)
    || (latestProfile && latestProfile.version !== latestVersion) || (currentProfile && (currentProfile.version > latestVersion || currentProfile.effectiveFrom > asOf))
    || (latestProfile && latestProfile.effectiveFrom <= asOf && !same(latestProfile, currentProfile))
    || (latestProfile && latestProfile.effectiveFrom > asOf && currentProfile?.version === latestVersion)
    || currentProfile?.parentClientId === id || latestProfile?.parentClientId === id) throw invalid();
  return {id, operationalName: text(item.operationalName), industry: nullable(item.industry), status: text(item.status), accountOwnerId: nullable(item.accountOwnerId),
    code: clientCode, latestVersion, currentProfile, latestProfile};
};
const versions = <T extends UnitProfile>(value: unknown, normalize: (row: unknown) => T, latestVersion: number, current: T | null, asOf: string) => {
  const result = unique(rows(value, normalize));const sorted = [...result].sort((a, b) => a.version - b.version);
  if (sorted.length !== latestVersion || sorted.some((item, index) => item.version !== index + 1 || (index > 0 && item.effectiveFrom <= sorted[index - 1].effectiveFrom))) throw invalid();
  const effective = [...sorted].reverse().find(item => item.effectiveFrom <= asOf) || null;
  if (!same(effective, current)) throw invalid();return result;
};
const limit = (item: Record<string, unknown>) => {if (item.limit !== 200) throw invalid();return {limit: 200 as const, truncated: flag(item.truncated)};};
export const normalizeClientProfilesWorkspace = (value: unknown): ClientProfilesWorkspace => {
  const item = object(value);const asOf = date(item.asOf);return {asOf, clients: unique(rows(item.clients, value => summary(value, asOf))), ...limit(item)};
};
export const normalizeClientProfileDetail = (value: unknown): ClientProfileDetail => {
  const item = object(value);const asOf = date(item.asOf);const client = summary(item, asOf);
  const history = versions(item.versions, profile, client.latestVersion, client.currentProfile, asOf);
  const latest = history.find(value => value.version === client.latestVersion) || null;
  if (!same(latest, client.latestProfile) || history.some(value => value.parentClientId === client.id)) throw invalid();
  const billingUnits = unique(rows(item.billingUnits, value => {
    const unit = object(value);const latestVersion = integer(unit.latestVersion, 1);const currentProfile = unit.currentProfile === null ? null : unitProfile(unit.currentProfile);
    if (unit.clientId !== client.id || !['billing_entity', 'business_unit'].includes(String(unit.kind))) throw invalid();
    return {id: text(unit.id), clientId: text(unit.clientId), code: code(unit.code), kind: unit.kind as ClientBillingUnit['kind'], latestVersion, currentProfile,
      versions: versions(unit.versions, unitProfile, latestVersion, currentProfile, asOf)};
  }));
  if ((client.latestVersion === 0 && billingUnits.length > 0) || new Set(billingUnits.map(unit => unit.code)).size !== billingUnits.length) throw invalid();
  return {...client, asOf, versions: history, billingUnits, ...limit(item)};
};
const PREFIX = '/api/v1/client-profiles';
const query = (asOf?: string) => {
  if (asOf === undefined) return '';
  try {return `?asOf=${encodeURIComponent(date(asOf))}`;} catch {throw new ApiClientError('Select a valid as-of date.', {status: 400});}
};
const clientPath = (id: string) => `/clients/${encodeURIComponent(text(id))}`;
const request = async <T>(context: ClientProfilesContext | null, method: 'GET' | 'POST', path: string, body: unknown, normalize: (value: unknown) => T) => {
  const owner = assertClientProfilesContext(context, method === 'POST');
  const result = await api.requestWithContext<unknown>(method, `${PREFIX}${path}`, body, owner.request);
  assertClientProfilesContext(owner, method === 'POST');return normalize(result);
};
// Rebuild nested allowlists. No scope/actor/role, operational labels or version ids
// may be smuggled into the protected full-snapshot command.
const fieldsBody = (input: UnitProfileFields) => ({effectiveFrom: input.effectiveFrom, legalName: input.legalName, displayName: input.displayName,
  defaultCurrency: input.defaultCurrency, billingContacts: input.billingContacts.map(contact => ({name: contact.name, email: contact.email}))});
const assertFields = (returned: UnitProfileFields, input: UnitProfileFields) => {
  const expected = fieldsBody(input);const actual = fieldsBody(returned);
  // The server trims controlled names/contact details, never infers missing data.
  const clean = (value: UnitProfileFields) => ({...value, legalName: value.legalName?.trim() ?? null, displayName: value.displayName?.trim() ?? null,
    billingContacts: value.billingContacts.map(contact => ({name: contact.name.trim(), email: contact.email.trim()}))});
  if (!same(clean(actual), clean(expected))) throw invalid();
};
export const clientProfilesService = {
  getWorkspace: (context: ClientProfilesContext | null, asOf?: string) => request(context, 'GET', `/workspace${query(asOf)}`, undefined, value => {
    const result = normalizeClientProfilesWorkspace(value);if (asOf !== undefined && result.asOf !== asOf) throw invalid();return result;
  }),
  getClient: (id: string, context: ClientProfilesContext | null, asOf?: string) => request(context, 'GET', `${clientPath(id)}${query(asOf)}`, undefined, value => {
    const result = normalizeClientProfileDetail(value);if (result.id !== id || (asOf !== undefined && result.asOf !== asOf)) throw invalid();return result;
  }),
  appendClientProfile: (id: string, input: AppendClientProfileInput, context: ClientProfilesContext | null) => request(context, 'POST', `${clientPath(id)}/profiles`, {
    ...fieldsBody(input), expectedVersion: input.expectedVersion, code: input.code, parentClientId: input.parentClientId, reason: input.reason,
  }, value => {
    const result = normalizeClientProfileDetail(value);const latest = result.latestProfile;
    if (result.id !== id || result.latestVersion !== input.expectedVersion + 1 || result.code !== input.code.trim() || !latest || latest.parentClientId !== (input.parentClientId?.trim() ?? null)) throw invalid();
    assertFields(latest, input);return result;
  }),
  createBillingUnit: (id: string, input: CreateBillingUnitInput, context: ClientProfilesContext | null) => request(context, 'POST', `${clientPath(id)}/billing-units`, {
    ...fieldsBody(input), code: input.code, kind: input.kind, reason: input.reason,
  }, value => {
    const result = normalizeClientProfileDetail(value);const unit = result.billingUnits.find(unit => unit.code === input.code.trim());
    if (result.id !== id || !unit || unit.kind !== input.kind || unit.latestVersion !== 1) throw invalid();
    assertFields(unit.versions[0], input);return result;
  }),
  appendBillingUnitVersion: (id: string, unitId: string, input: AppendBillingUnitVersionInput, context: ClientProfilesContext | null) => request(context, 'POST', `${clientPath(id)}/billing-units/${encodeURIComponent(text(unitId))}/versions`, {
    ...fieldsBody(input), expectedVersion: input.expectedVersion, reason: input.reason,
  }, value => {
    const result = normalizeClientProfileDetail(value);const unit = result.billingUnits.find(unit => unit.id === unitId);
    if (result.id !== id || !unit || unit.latestVersion !== input.expectedVersion + 1) throw invalid();
    assertFields(unit.versions.find(version => version.version === unit.latestVersion)!, input);return result;
  }),
};
