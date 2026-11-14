import {api, ApiClientError, checkBackend} from './apiClient';
import {captureOrganizationProfileContext, isOrganizationProfileContextCurrent, type OrganizationProfileContext} from './organizationProfileScope';

export const CALENDAR_ROW_CAP = 200;
export type CalendarReadContext = OrganizationProfileContext & Readonly<{asOf: string}>;
export type WorkingCalendar = {
  id: string; organizationId: string; code: string; name: string; timezone: string;
  applicabilityType: 'legal_entity' | 'country' | 'worker_group';
  legalEntityId: string | null; countryCode: string | null; countryAuthorityLegalEntityId: string | null; workerGroupId: string | null;
  workingDays: number[]; hoursPerDay: number; effectiveFrom: string; effectiveTo: string | null; active: boolean;
};
export type WorkingCalendarHoliday = {
  id: string; holidayId: string; calendarId: string; organizationId: string; holidayDate: string;
  label: string; holidayType: 'Public' | 'Company'; effectiveFrom: string; effectiveTo: string | null; active: boolean;
};
const invalid = () => new ApiClientError('Calendar response could not be confirmed.', {status: 502});
const text = (value: unknown, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) throw invalid();
  return value;
};
const optionalText = (value: unknown) => value === null ? null : text(value);
const date = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw invalid();
  return value;
};
const range = (row: Record<string, unknown>, asOf: string) => {
  const effectiveFrom = date(row.effective_from);
  const effectiveTo = row.effective_to === null ? null : date(row.effective_to);
  if (effectiveFrom > asOf || (effectiveTo && (effectiveTo < asOf || effectiveTo < effectiveFrom))) throw invalid();
  if (typeof row.active !== 'boolean') throw invalid();
  return {effectiveFrom, effectiveTo, active: row.active};
};
const rows = (raw: unknown) => {
  if (!Array.isArray(raw) || raw.length > CALENDAR_ROW_CAP) throw invalid();
  const ids = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const id = text(item.id);
    if (ids.has(id)) throw invalid();
    ids.add(id);
    return item as Record<string, unknown>;
  });
};
const validScope = (context: OrganizationProfileContext) => {
  try { text(context.scope.organizationId); text(context.scope.legalEntityId); return true; } catch { return false; }
};
export const captureCalendarReadContext = (isCurrent = () => true): CalendarReadContext | null => {
  const context = captureOrganizationProfileContext(isCurrent);
  return context && validScope(context) ? {...context, asOf: new Date().toISOString().slice(0, 10)} : null;
};
export const isCalendarReadContextCurrent = (context: CalendarReadContext) =>
  validScope(context) && isOrganizationProfileContextCurrent(context);
const assertContext = (context: CalendarReadContext | null) => {
  if (!context || !isCalendarReadContextCurrent(context)) throw new ApiClientError('Calendar access changed. Reload for the current scope.', {status: 403});
  date(context.asOf);
  return context;
};
const read = async (path: string, context: CalendarReadContext | null) => {
  const captured = assertContext(context);
  const connected = await checkBackend();
  assertContext(captured);
  if (!connected) throw new ApiClientError('Working calendars require the server.', {status: 503});
  const result = await api.getWithScope<unknown>(`${path}?asOf=${captured.asOf}`, captured.scope);
  assertContext(captured);
  return result;
};
export const workingCalendarInspectorService = {
  getCalendars: async (context: CalendarReadContext | null): Promise<WorkingCalendar[]> => {
    const raw = await read('/api/organization-setup/calendars', context);
    const owner = assertContext(context);
    return rows(raw).map(row => {
      const organizationId = text(row.organization_id);
      if (organizationId !== owner.scope.organizationId) throw invalid();
      const applicabilityType = row.applicability_type;
      const legalEntityId = optionalText(row.legal_entity_id);
      const countryCode = optionalText(row.country_code);
      const countryAuthorityLegalEntityId = optionalText(row.country_authority_legal_entity_id);
      const workerGroupId = optionalText(row.worker_group_id);
      if (applicabilityType === 'legal_entity') {
        if (legalEntityId !== owner.scope.legalEntityId || countryCode || countryAuthorityLegalEntityId || workerGroupId) throw invalid();
      } else if (applicabilityType === 'country') {
        if (legalEntityId || !countryCode || !/^[A-Z]{2}$/.test(countryCode) || !countryAuthorityLegalEntityId || workerGroupId) throw invalid();
      } else if (applicabilityType === 'worker_group') {
        if (legalEntityId || countryCode || countryAuthorityLegalEntityId || !workerGroupId) throw invalid();
      } else throw invalid();
      const timezone = text(row.timezone, 80);
      try { new Intl.DateTimeFormat('en', {timeZone: timezone}).format(); } catch { throw invalid(); }
      if (!Array.isArray(row.working_days) || !row.working_days.length || row.working_days.length > 7
        || row.working_days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
        || new Set(row.working_days).size !== row.working_days.length) throw invalid();
      const hoursPerDay = typeof row.hours_per_day === 'number' || (typeof row.hours_per_day === 'string' && /^\d+(?:\.\d+)?$/.test(row.hours_per_day)) ? Number(row.hours_per_day) : NaN;
      if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0 || hoursPerDay > 24) throw invalid();
      const code = text(row.code, 50);
      if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) throw invalid();
      return {id: text(row.id), organizationId, code, name: text(row.name, 150), timezone,
        applicabilityType, legalEntityId, countryCode, countryAuthorityLegalEntityId, workerGroupId,
        workingDays: [...row.working_days] as number[], hoursPerDay, ...range(row, owner.asOf)};
    });
  },
  getHolidays: async (calendarId: string, context: CalendarReadContext | null): Promise<WorkingCalendarHoliday[]> => {
    text(calendarId);
    const raw = await read(`/api/organization-setup/calendars/${encodeURIComponent(calendarId)}/holidays`, context);
    const owner = assertContext(context);
    return rows(raw).map(row => {
      if (row.organization_id !== owner.scope.organizationId || row.calendar_id !== calendarId
        || typeof row.holiday_type !== 'string' || !['Public', 'Company'].includes(row.holiday_type)) throw invalid();
      return {id: text(row.id), holidayId: text(row.holiday_id), calendarId, organizationId: owner.scope.organizationId,
        holidayDate: date(row.holiday_date), label: text(row.label, 150), holidayType: row.holiday_type as 'Public' | 'Company', ...range(row, owner.asOf)};
    });
  },
};
