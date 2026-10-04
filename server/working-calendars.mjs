import { z } from 'zod';

const timeZone = value => {
  try { new Intl.DateTimeFormat('en', { timeZone:value }).format(); return true; } catch { return false; }
};
const uniqueWeekdays = days => new Set(days).size === days.length;

const applicabilitySchema = z.discriminatedUnion('type', [
  z.object({ type:z.literal('legal_entity') }).strict(),
  z.object({ type:z.literal('country'), countryCode:z.string().trim().regex(/^[A-Z]{2}$/) }).strict(),
  z.object({ type:z.literal('worker_group'), workerGroupId:z.string().trim().min(1).max(100) }).strict(),
]);

const calendarSchema = z.object({
  code:z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,49}$/),
  name:z.string().trim().min(1).max(150),
  timezone:z.string().trim().min(1).max(80).refine(timeZone),
  workingDays:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(uniqueWeekdays),
  hoursPerDay:z.number().positive().max(24),
  effectiveFrom:z.string().date(),
  applicability:applicabilitySchema,
}).strict();

const holidaySchema = z.object({
  holidayDate:z.string().date(), label:z.string().trim().min(1).max(150),
  holidayType:z.enum(['Public','Company']), effectiveFrom:z.string().date(),
}).strict();

export const validateWorkingCalendar = input => calendarSchema.safeParse(input);
export const validateWorkingCalendarHoliday = input => holidaySchema.safeParse(input);

export const calendarScopeValues = (applicability, legalEntityId) => ({
  applicabilityType:applicability.type,
  legalEntityId:applicability.type === 'legal_entity' ? legalEntityId : null,
  countryCode:applicability.type === 'country' ? applicability.countryCode : null,
  countryAuthorityLegalEntityId:applicability.type === 'country' ? legalEntityId : null,
  workerGroupId:applicability.type === 'worker_group' ? applicability.workerGroupId : null,
});
