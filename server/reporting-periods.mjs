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

export const assertReportingPeriodAllows = async (database, {
  organizationId,
  legalEntityId,
  relevantDate,
  operation,
}) => {
  if (!allowedStates[operation]) throw new Error(`Unknown reporting-period operation: ${operation}`);
  const result = await database.query(`select id,code,name,starts_on,ends_on,status
    from reporting_periods
    where organization_id=$1 and legal_entity_id=$2 and $3::date between starts_on and ends_on
    order by starts_on,id limit 2 for share`, [organizationId, legalEntityId, relevantDate]);
  if (result.rows.length === 0) {
    throw new ReportingPeriodError('No authoritative reporting period covers this timesheet date', 'REPORTING_PERIOD_MISSING');
  }
  if (result.rows.length !== 1) {
    throw new ReportingPeriodError('Reporting period authority is ambiguous', 'REPORTING_PERIOD_AMBIGUOUS');
  }
  const period = result.rows[0];
  if (!allowedStates[operation].has(period.status)) {
    throw new ReportingPeriodError(`Reporting period ${period.code} does not permit this timesheet operation`, 'REPORTING_PERIOD_CLOSED');
  }
  return period;
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
