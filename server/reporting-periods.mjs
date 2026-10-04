export const REPORTING_PERIOD_STATES = Object.freeze([
  'Planned',
  'Open',
  'Submission Closed',
  'Approval Closed',
  'Financially Locked',
  'Closed',
]);

export const REPORTING_PERIOD_OPERATIONS = Object.freeze({
  CONTENT: 'timesheet-content',
  DECISION: 'timesheet-decision',
});

export const REPORTING_PERIOD_FREQUENCIES = Object.freeze(['Weekly', 'Monthly', 'Fiscal']);
export const MAX_REPORTING_PERIOD_DATES = 100;

const allowedStates = {
  [REPORTING_PERIOD_OPERATIONS.CONTENT]: new Set(['Open']),
  [REPORTING_PERIOD_OPERATIONS.DECISION]: new Set(['Open', 'Submission Closed']),
};

export class ReportingPeriodError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReportingPeriodError';
    this.statusCode = 409;
    this.code = code;
  }
}

export const normalizeReportingDate = value => {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new ReportingPeriodError('Reporting date is invalid', 'REPORTING_PERIOD_INVALID_DATE');
    }
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ReportingPeriodError('Reporting date is invalid', 'REPORTING_PERIOD_INVALID_DATE');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ReportingPeriodError('Reporting date is invalid', 'REPORTING_PERIOD_INVALID_DATE');
  }
  return value;
};

export const assertReportingPeriodAllows = async (database, {
  organizationId,
  legalEntityId,
  relevantDate,
  relevantDates,
  operation,
}) => {
  if (!allowedStates[operation]) throw new Error(`Unknown reporting-period operation: ${operation}`);
  const requestedDates = (relevantDates || [relevantDate]).filter(value => value !== undefined && value !== null);
  const dates = [...new Set(requestedDates.map(normalizeReportingDate))].sort();
  if (dates.length === 0) throw new ReportingPeriodError('At least one reporting date is required', 'REPORTING_PERIOD_MISSING');
  if (dates.length > MAX_REPORTING_PERIOD_DATES) {
    throw new ReportingPeriodError(`Reporting-period checks are limited to ${MAX_REPORTING_PERIOD_DATES} unique dates`, 'REPORTING_PERIOD_DATE_LIMIT');
  }
  const result = await database.query(`select requested.relevant_date,id,code,name,starts_on,ends_on,status,frequency
    from unnest($3::date[]) requested(relevant_date)
    join reporting_periods p on p.organization_id=$1 and p.legal_entity_id=$2
      and requested.relevant_date between p.starts_on and p.ends_on
    order by requested.relevant_date,p.frequency,p.starts_on,p.id
    for share of p`, [organizationId, legalEntityId, dates]);
  const byDate = new Map(dates.map(date => [date, []]));
  for (const period of result.rows) {
    const key = String(period.relevant_date instanceof Date ? period.relevant_date.toISOString().slice(0, 10) : period.relevant_date);
    if (byDate.has(key)) byDate.get(key).push(period);
  }
  for (const [date, periods] of byDate) {
    const byFrequency = new Map();
    for (const period of periods) {
      if (byFrequency.has(period.frequency)) throw new ReportingPeriodError(`Reporting period authority is ambiguous for ${date}`, 'REPORTING_PERIOD_AMBIGUOUS');
      byFrequency.set(period.frequency, period);
    }
    if (!byFrequency.has('Weekly')) throw new ReportingPeriodError(`No authoritative Weekly reporting period covers ${date}`, 'REPORTING_PERIOD_MISSING');
    for (const period of periods) {
      if (!allowedStates[operation].has(period.status)) throw new ReportingPeriodError(`Reporting period ${period.code} does not permit this timesheet operation`, 'REPORTING_PERIOD_CLOSED');
    }
  }
  return result.rows;
};

export const sendReportingPeriodError = (res, error) => {
  if (!(error instanceof ReportingPeriodError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
};

export const canTransitionReportingPeriod = (from, to) => {
  const transitions = {
    Planned: ['Planned', 'Open', 'Closed'],
    Open: ['Open', 'Submission Closed', 'Approval Closed', 'Financially Locked', 'Closed'],
    'Submission Closed': ['Submission Closed', 'Approval Closed', 'Financially Locked', 'Closed'],
    'Approval Closed': ['Approval Closed', 'Financially Locked', 'Closed'],
    'Financially Locked': ['Financially Locked', 'Closed'],
    Closed: ['Closed'],
  };
  return Boolean(transitions[from]?.includes(to));
};
