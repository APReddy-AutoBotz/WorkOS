import {readProjectContributionResult} from './project-contribution.mjs';
import {WORK_STATES} from './actual-work.mjs';

const columns = [
  'calculation_version', 'scope_reference', 'project_reference', 'row_kind', 'worker_reference',
  'starts_on', 'ends_on', 'observed_at', 'source_token', 'cohort_rule', 'inclusion_rule', 'denominator_rule',
  'worker_count', 'status', 'included_hours_exact', 'eligible_available_hours_exact',
  'percent_numerator_exact', 'percent_denominator_exact', 'percent_rounded_display',
  'draft_hours_exact', 'submitted_hours_exact', 'rejected_hours_exact', 'approved_hours_exact',
  'entry_count', 'approved_entry_count', 'included_approved_entry_count', 'excluded_approved_entry_count',
  'unresolved_approved_entry_count', 'known_included_hours_exact', 'known_excluded_hours_exact',
  'unresolved_approved_hours_exact', 'reason_codes',
];
const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';

// Only the server's validated observation is serialized. Labels and current
// worker names are deliberately absent: references remain stable and no raw
// user-entered value can become a spreadsheet formula or another CSV row.
export const projectContributionCsv = (scope, result) => {
  if (!scope || ['organizationId', 'legalEntityId'].some(key => typeof scope[key] !== 'string' || !scope[key])) {
    throw new TypeError('Project contribution export requires an explicit scope.');
  }
  readProjectContributionResult(result, result.projectId, result.startsOn, result.endsOn);
  const values = (measure, kind, workerId = null) => [
    result.calculationVersion, `scope/${encodeURIComponent(scope.organizationId)}/${encodeURIComponent(scope.legalEntityId)}`,
    `project/${encodeURIComponent(result.projectId)}`, kind, workerId === null ? '' : `worker/${encodeURIComponent(workerId)}`,
    result.startsOn, result.endsOn, result.observedAt, result.sourceToken,
    result.cohortRule, result.inclusionRule, result.denominatorRule,
    kind === 'aggregate' ? result.workerCount : '', measure.status, measure.includedHoursExact, measure.eligibleAvailableHoursExact,
    measure.percentage?.numeratorExact, measure.percentage?.denominatorExact, measure.percentage?.displayPercent,
    ...WORK_STATES.map(state => measure.controls?.hoursByStatus[state]),
    ...['entryCount', 'approvedEntryCount', 'includedApprovedEntryCount', 'excludedApprovedEntryCount',
      'unresolvedApprovedEntryCount', 'knownIncludedHoursExact', 'knownExcludedHoursExact',
      'unresolvedApprovedHoursExact'].map(key => measure.controls?.[key]), measure.reasonCodes.join('|'),
  ];
  // Preserve canonical server row order and unknowns; never invent zero totals
  // or emit a partial worker set when the source bound was exceeded.
  const rows = [columns, values(result, 'aggregate'), ...(result.rows ?? []).map(row => values(row, 'worker', row.employeeId))];
  return rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
};

// Client use is acknowledgement validation only; downloads use retained server bytes.
export const validateProjectContributionCsv = (scope, result, csv) => {
  if (typeof csv !== "string" || csv !== projectContributionCsv(scope, result)) throw new TypeError("Project contribution artifact does not match its retained observation.");
  return csv;
};
