import {submissionDeadlineInput,submissionDeadlineRule} from './submission-deadline.mjs';
import {overtimeInput,overtimeRule,evaluateOvertime,assertOvertimeAllowed} from './overtime-policy.mjs';
import {z} from 'zod';
import {assertReportingPeriodAllows, REPORTING_PERIOD_OPERATIONS} from '../../reporting-periods.mjs';
import {WorkPolicyError} from './assignment-work-policy.mjs';
import {canonicalHours, compareHours, decimalQuantity, isHourMultiple, sumHours} from './work-hours.mjs';

export const CAPTURE_POLICY_VERSION = 'work-capture-rules/1';
const fail = (code, message) => { throw new WorkPolicyError(code, message); };
export const captureHoursInput = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    const result = canonicalHours(value);
    if (compareHours(result, '24') > 0) throw new Error();
    return result;
  } catch {
    context.addIssue({code: 'custom', message: 'Use non-negative decimal hours not exceeding 24.'});
    return z.NEVER;
  }
});
const decimal = z.union([z.string(), z.number()]).transform((value, context) => {
  try {
    const quantity = decimalQuantity(value);
    if (quantity.scale > 4 || quantity.units === 0n || compareHours(value, '168') > 0) throw new Error();
    return canonicalHours(value);
  } catch {
    context.addIssue({code: 'custom', message: 'Use a positive decimal with at most four decimal places.'});
    return z.NEVER;
  }
});
export const capturePolicyInput = z.object({
  expectedLatestId: z.string().min(1).nullable(),
  effectiveFrom: z.string().date(),
  minimumIncrement: decimal.refine(value => compareHours(value, '24') <= 0, 'Increment must not exceed 24 hours.'),
  dailyMaximum: decimal.nullable().refine(value => value === null || compareHours(value, '24') <= 0, 'Daily maximum must not exceed 24 hours.'),
  weeklyMaximum: decimal.nullable(),
  commentRequired: z.boolean(),
  evidenceRequired: z.boolean().optional(),
  overtime: overtimeInput.nullable().optional(),
  submissionDeadline:submissionDeadlineInput.nullable().optional(),
}).strict().superRefine((input, context) => {
  if (input.dailyMaximum !== null && compareHours(input.dailyMaximum, input.minimumIncrement) < 0) context.addIssue({code: 'custom', path: ['dailyMaximum'], message: 'Daily maximum must permit at least one increment.'});
  if (input.weeklyMaximum !== null && compareHours(input.weeklyMaximum, input.minimumIncrement) < 0) context.addIssue({code: 'custom', path: ['weeklyMaximum'], message: 'Weekly maximum must permit at least one increment.'});
});
export const capturePolicyView = row => ({
  id: row.id, sequence: Number(row.sequence), policyVersion: row.policy_version,
  effectiveFrom: row.effective_from, minimumIncrement: canonicalHours(row.minimum_increment),
  dailyMaximum: row.daily_maximum === null ? null : canonicalHours(row.daily_maximum),
  weeklyMaximum: row.weekly_maximum === null ? null : canonicalHours(row.weekly_maximum),
  commentRequired: row.comment_required,
  evidenceRequired: row.evidence_required === true,
  overtime: overtimeRule(row.overtime_rule),
  submissionDeadline:submissionDeadlineRule(row.submission_deadline),
});
export const resolveCapturePolicy = (policies, at) => [...policies].reverse().find(policy => policy.effective_from <= at) || null;
export const validateEntryCaptureRules = (entry, policy) => {
  const hours = canonicalHours(entry.hours);
  if (compareHours(hours, '24') > 0) fail('WORK_HOURS_INVALID', 'A work entry cannot exceed 24 hours.');
  if (policy && !isHourMultiple(hours, policy.minimum_increment)) fail('WORK_CAPTURE_INCREMENT', `Hours must use increments of ${canonicalHours(policy.minimum_increment)} on this work date.`);
  if (policy?.comment_required && compareHours(hours, '0') > 0 && !entry.remark?.trim()) fail('WORK_CAPTURE_COMMENT_REQUIRED', 'A comment is required for each positive work entry on this work date.');
  if (policy?.evidence_required && compareHours(hours, '0') > 0 && !entry.evidence_url) fail('WORK_CAPTURE_EVIDENCE_REQUIRED', 'An evidence URL is required for each positive work entry on this work date.');
  return {...entry, hours, capturePolicyReference: policy ? {id: policy.id, policyVersion: policy.policy_version,...(policy.overtime_rule?{overtime:overtimeRule(policy.overtime_rule)}:{})} : null};
};

export const assertCaptureReplacementPeriods = async (client, req, timesheetId) => {
  if (!timesheetId) return;
  const {organizationId, legalEntityId} = req.organizationScope;
  const dates = (await client.query(`select e.work_date::text from timesheet_entries e join timesheets t on t.id=e.timesheet_id
    where t.id=$1 and t.organization_id=$2 and t.legal_entity_id=$3 order by e.work_date,e.id`, [timesheetId, organizationId, legalEntityId])).rows;
  if (dates.length) await assertReportingPeriodAllows(client, {organizationId, legalEntityId,
    relevantDates: dates.map(row => row.work_date), operation: REPORTING_PERIOD_OPERATIONS.CONTENT});
};

// Resolve limits by authoritative Weekly period, never a caller-supplied rolling
// week_ending. Include every stored worker entry, irrespective of header or state.
// Dry-run replacements overlay exactly the same prospective state as apply.
export const validateCapturePolicy = async (client, req, employeeId, entries, {
  replacementTimesheetId = null, stagedReplacements = [],
} = {}) => {
  const {organizationId, legalEntityId} = req.organizationScope;
  const periods = await assertReportingPeriodAllows(client, {organizationId, legalEntityId,
    relevantDates: entries.map(entry => entry.work_date), operation: REPORTING_PERIOD_OPERATIONS.CONTENT});
  const weeks = [...new Map(periods.filter(period => period.frequency === 'Weekly').map(period => [period.id, period])).values()];
  const startsOn = weeks.map(week => week.starts_on).sort()[0];
  const endsOn = weeks.map(week => week.ends_on).sort().at(-1);
  const policies = (await client.query(`select id,sequence,policy_version,effective_from::text,minimum_increment::text,daily_maximum::text,weekly_maximum::text,comment_required,evidence_required,overtime_rule
    from work_capture_policy_versions where organization_id=$1 and legal_entity_id=$2 and effective_from<=$3::date order by effective_from`, [organizationId, legalEntityId, endsOn])).rows;
  const checked = entries.map(entry => validateEntryCaptureRules(entry, resolveCapturePolicy(policies, entry.work_date)));
  const staged = stagedReplacements.filter(change => change.employeeId === employeeId);
  const excluded = [...new Set([replacementTimesheetId, ...staged.map(change => change.timesheetId)].filter(Boolean))];
  const stored = (await client.query(`select te.work_date::text,te.hours::text from timesheet_entries te
    join timesheets t on t.id=te.timesheet_id where t.organization_id=$1 and t.legal_entity_id=$2 and t.employee_id=$3
    and te.work_date between $4::date and $5::date and not(t.id=any($6::uuid[])) order by te.work_date,te.id`,
  [organizationId, legalEntityId, employeeId, startsOn, endsOn, excluded])).rows;
  const all = [...stored, ...staged.flatMap(change => change.entries), ...checked];
  for (const week of weeks) {
    const weeklyEntries = all.filter(entry => entry.work_date >= week.starts_on && entry.work_date <= week.ends_on);
    const weeklyTotal = sumHours(weeklyEntries.map(entry => entry.hours));
    for (const at of new Set(weeklyEntries.map(entry => entry.work_date))) {
      const policy = resolveCapturePolicy(policies, at);
      if (!policy) continue; // No inferred policy or historical backfill.
      const dailyTotal = sumHours(weeklyEntries.filter(entry => entry.work_date === at).map(entry => entry.hours));
      if (policy.daily_maximum !== null && compareHours(dailyTotal, policy.daily_maximum) > 0) fail('WORK_CAPTURE_DAILY_LIMIT', `All recorded work on ${at} exceeds the configured daily maximum.`);
      if (policy.weekly_maximum !== null && compareHours(weeklyTotal, policy.weekly_maximum) > 0) fail('WORK_CAPTURE_WEEKLY_LIMIT', `All recorded work in Weekly reporting period ${week.code} exceeds the configured weekly maximum.`);
    }
  }
  assertOvertimeAllowed(evaluateOvertime(weeks,policies,all));
  return checked;
};
