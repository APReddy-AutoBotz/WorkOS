import { calculateActualWork, actualControls, actualPercent, validActualControls, WORK_STATES } from './actual-work.mjs';
import { sumHours, canonicalHours } from './work-hours.mjs';
import { validCapacityRange } from './worker-capacity.mjs';

export const PROJECT_CONTRIBUTION_VERSION = 'project-contribution/1';

// Inputs are already scoped and evidence-classified by the server. Each worker
// appears once; capacity covers the complete selected period, not assignment FTE.
export const calculateProjectContribution = ({projectId, startsOn, endsOn, workers, periodIsActual = true, sourceLimited = false}) => {
  if (typeof projectId !== 'string' || !projectId || !validCapacityRange(startsOn, endsOn) || !Array.isArray(workers)) {
    throw new TypeError('Project contribution requires a project and valid explicit period.');
  }
  const ids = new Set();
  for (const worker of workers) {
    if (typeof worker.employeeId !== 'string' || !worker.employeeId || ids.has(worker.employeeId)) {
      throw new TypeError('Project contribution requires distinct workers.');
    }
    ids.add(worker.employeeId);
    if (!Array.isArray(worker.rows) || worker.rows.some(row => row.date < startsOn || row.date > endsOn)) {
      throw new TypeError('Project work must belong to the selected period.');
    }
  }
  const reasonCodes = new Set();
  if (!periodIsActual) reasonCodes.add('FUTURE_ACTUAL_PERIOD');
  if (sourceLimited) reasonCodes.add('PROJECT_SOURCE_LIMIT');
  const rows = sourceLimited ? null : workers.map(worker => {
    const result = calculateActualWork({...worker, startsOn, endsOn, periodIsActual});
    for (const reason of result.reasonCodes) if (reason !== 'ZERO_ELIGIBLE_CAPACITY') reasonCodes.add(reason);
    return {employeeId: worker.employeeId, status: result.status, includedHoursExact: result.includedHoursExact,
      eligibleAvailableHoursExact: result.eligibleAvailableHoursExact, percentage: result.percentage,
      controls: result.controls, reasonCodes: result.reasonCodes};
  });
  const controls = sourceLimited ? null : actualControls(workers.flatMap(worker => worker.rows));
  const includedHoursExact = controls && controls.unresolvedApprovedEntryCount === 0 ? controls.knownIncludedHoursExact : null;
  const eligibleAvailableHoursExact = rows && rows.every(row => row.eligibleAvailableHoursExact !== null)
    ? sumHours(rows.map(row => row.eligibleAvailableHoursExact)) : null;
  let status = reasonCodes.size ? 'unavailable' : 'available';
  if (status === 'available' && eligibleAvailableHoursExact === '0') {
    status = 'not_applicable';
    reasonCodes.add(workers.length ? 'ZERO_ELIGIBLE_CAPACITY' : 'NO_VISIBLE_COHORT');
  }
  return {calculationVersion: PROJECT_CONTRIBUTION_VERSION, projectId, startsOn, endsOn, status,
    cohortRule: 'visible-period-assignment-or-work/1', inclusionRule: 'retained-category.includeInUtilization/1',
    denominatorRule: 'distinct-worker-full-period-eligible-capacity/1', workerCount: sourceLimited ? null : workers.length,
    includedHoursExact, eligibleAvailableHoursExact, controls, rows,
    percentage: status === 'available' ? actualPercent(includedHoursExact, eligibleAvailableHoursExact) : null,
    reasonCodes: [...reasonCodes].sort()};
};

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const exact = value => {try {return typeof value === 'string' && value.length <= 2000 && canonicalHours(value) === value;} catch {return false;}};
const reasons = value => Array.isArray(value) && value.length <= 50 && value.every(reason => typeof reason === 'string' && /^[A-Z][A-Z0-9_]*$/.test(reason)) && value.join(',') === [...new Set(value)].sort().join(',');
const invalid = () => {throw new TypeError('Project contribution response is incomplete or inconsistent. Reload explicitly.');};
const validateMeasure = value => {
  if (!['available', 'unavailable', 'not_applicable'].includes(value.status) || !reasons(value.reasonCodes) || value.includedHoursExact !== null && !exact(value.includedHoursExact) || value.eligibleAvailableHoursExact !== null && !exact(value.eligibleAvailableHoursExact)) invalid();
  if (value.controls !== null) {
    if (!validActualControls(value.controls) || value.includedHoursExact !== (value.controls.unresolvedApprovedEntryCount ? null : value.controls.knownIncludedHoursExact)) invalid();
  } else if (value.status !== 'unavailable' || value.includedHoursExact !== null) invalid();
  if (value.status === 'available') {
    if (value.reasonCodes.length || value.includedHoursExact === null || value.eligibleAvailableHoursExact === null || value.eligibleAvailableHoursExact === '0' || !keys(value.percentage, ['numeratorExact', 'denominatorExact', 'displayPercent'])) invalid();
    const expected = actualPercent(value.includedHoursExact, value.eligibleAvailableHoursExact);
    if (Object.keys(expected).some(key => value.percentage[key] !== expected[key])) invalid();
  } else {
    if (value.percentage !== null || !value.reasonCodes.length) invalid();
    if (value.status === 'not_applicable' && (value.eligibleAvailableHoursExact !== '0' || value.includedHoursExact === null || value.reasonCodes.length !== 1 || !['ZERO_ELIGIBLE_CAPACITY', 'NO_VISIBLE_COHORT'].includes(value.reasonCodes[0]))) invalid();
  }
};

// Validate the server's acknowledgement and reconcile its supplied controls.
// This does not replace source authorization or calculate an authoritative UI value.
export const readProjectContributionResult = (value, projectId, startsOn, endsOn) => {
  if (!keys(value, ['calculationVersion', 'projectId', 'startsOn', 'endsOn', 'status', 'cohortRule', 'inclusionRule', 'denominatorRule', 'workerCount', 'includedHoursExact', 'eligibleAvailableHoursExact', 'controls', 'rows', 'percentage', 'reasonCodes', 'sourceToken', 'observedAt']) || value.calculationVersion !== PROJECT_CONTRIBUTION_VERSION || value.projectId !== projectId || value.startsOn !== startsOn || value.endsOn !== endsOn || !validCapacityRange(startsOn, endsOn) || value.cohortRule !== 'visible-period-assignment-or-work/1' || value.inclusionRule !== 'retained-category.includeInUtilization/1' || value.denominatorRule !== 'distinct-worker-full-period-eligible-capacity/1' || typeof value.sourceToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceToken) || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value.observedAt) || Number.isNaN(Date.parse(value.observedAt))) invalid();
  validateMeasure(value);
  if (value.rows === null) {
    if (value.status !== 'unavailable' || !value.reasonCodes.includes('PROJECT_SOURCE_LIMIT') || value.workerCount !== null || value.controls !== null || value.eligibleAvailableHoursExact !== null) invalid();
    return value;
  }
  if (!Array.isArray(value.rows) || value.rows.length > 500 || value.workerCount !== value.rows.length || !value.controls || value.reasonCodes.includes('PROJECT_SOURCE_LIMIT')) invalid();
  const ids = new Set();
  for (const row of value.rows) {
    if (!keys(row, ['employeeId', 'status', 'includedHoursExact', 'eligibleAvailableHoursExact', 'percentage', 'controls', 'reasonCodes']) || typeof row.employeeId !== 'string' || !row.employeeId || ids.has(row.employeeId) || !row.controls || row.reasonCodes?.includes('NO_VISIBLE_COHORT')) invalid();
    ids.add(row.employeeId);
    validateMeasure(row);
  }
  const counts = ['entryCount', 'approvedEntryCount', 'includedApprovedEntryCount', 'excludedApprovedEntryCount', 'unresolvedApprovedEntryCount'];
  const hours = ['knownIncludedHoursExact', 'knownExcludedHoursExact', 'unresolvedApprovedHoursExact'];
  if (counts.some(key => value.rows.reduce((total, row) => total + row.controls[key], 0) !== value.controls[key]) || hours.some(key => sumHours(value.rows.map(row => row.controls[key])) !== value.controls[key]) || WORK_STATES.some(state => sumHours(value.rows.map(row => row.controls.hoursByStatus[state])) !== value.controls.hoursByStatus[state])) invalid();
  const capacity = value.rows.every(row => row.eligibleAvailableHoursExact !== null) ? sumHours(value.rows.map(row => row.eligibleAvailableHoursExact)) : null;
  if (value.eligibleAvailableHoursExact !== capacity) invalid();
  const expectedReasons = new Set(value.rows.flatMap(row => row.reasonCodes).filter(reason => reason !== 'ZERO_ELIGIBLE_CAPACITY'));
  if (endsOn > value.observedAt.slice(0, 10)) expectedReasons.add('FUTURE_ACTUAL_PERIOD');
  if (!expectedReasons.size && capacity === '0') expectedReasons.add(value.rows.length ? 'ZERO_ELIGIBLE_CAPACITY' : 'NO_VISIBLE_COHORT');
  if (value.reasonCodes.join(',') !== [...expectedReasons].sort().join(',')) invalid();
  const expectedStatus = expectedReasons.size === 0 ? 'available' : expectedReasons.size === 1 && ['ZERO_ELIGIBLE_CAPACITY', 'NO_VISIBLE_COHORT'].includes([...expectedReasons][0]) ? 'not_applicable' : 'unavailable';
  if (value.status !== expectedStatus) invalid();
  return value;
};
