import {createHash} from 'node:crypto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const canonicalizeJson = value => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
};

export const normalizeIdempotencyKey = value => (
  typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null
);

export const stableJsonStringify = value => JSON.stringify(canonicalizeJson(value));

export const hashImportRequest = value => createHash('sha256')
  .update(stableJsonStringify(value))
  .digest('hex');

export const redactCredentialEchoes = (value, credentials) => {
  const secrets = [...new Set((credentials || []).filter(secret => typeof secret === 'string' && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  const redact = item => {
    if (typeof item === 'string') return secrets.reduce((result, secret) => result.split(secret).join(''), item);
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, redact(nested)]));
    }
    return item;
  };
  return redact(value);
};

const EMPLOYEE_IMPORT_ERROR_FIELDS = new Set([
  'employeeId', 'name', 'email', 'designation', 'department', 'country', 'region', 'businessUnit',
  'reportingManagerId', 'primaryCountryDirectorId', 'mappedCountryDirectorIds', 'status',
  'utilizationEligible', 'joiningDate', 'exitDate', 'standardWeeklyHours', 'capacityType',
  'contractType', 'entraObjectId', 'teamsUserId', 'roles', 'initialPassword',
]);

const EMPLOYEE_PREFLIGHT_ERROR_MESSAGE = 'The Employee Master row failed preflight validation.';

/** Keep only bounded structure from untrusted browser diagnostics. */
export const normalizeEmployeeImportClientErrors = clientErrors => (
  Array.isArray(clientErrors)
    ? clientErrors.map(error => ({
      rowNumber: error?.rowNumber,
      ...(EMPLOYEE_IMPORT_ERROR_FIELDS.has(error?.field) ? {field: error.field} : {}),
      message: EMPLOYEE_PREFLIGHT_ERROR_MESSAGE,
      ...(typeof error?.sourceIdentifier === 'string' ? {sourceIdentifier: error.sourceIdentifier} : {}),
    }))
    : []
);

/** Employee retries exclude credentials from durable request identity by design. */
export const hashEmployeeImportRequest = value => {
  const clientErrors = normalizeEmployeeImportClientErrors(value?.clientErrors);
  return hashImportRequest({
    schemaVersion: value?.schemaVersion,
    totalRows: value?.totalRows ?? (Array.isArray(value?.rows) ? value.rows.length : undefined),
    // These row/field observations affect source-row mapping and are safe
    // structured metadata. Free-form messages and source IDs are not identity.
    clientErrors: clientErrors.map(({rowNumber, field}) => ({
      rowNumber,
      ...(field ? {field} : {}),
    })),
    rows: Array.isArray(value?.rows)
      ? value.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'initialPassword')))
      : value?.rows,
  });
};

export const createScopedIdempotencyLockKey = ({
  organizationId,
  legalEntityId,
  actorId,
  channel,
  idempotencyKey,
}) => stableJsonStringify([
  organizationId,
  legalEntityId,
  actorId,
  channel,
  idempotencyKey,
]);

export const createScopedEntityLockKey = ({organizationId, entityType, entityKey}) => stableJsonStringify([
  organizationId,
  entityType,
  entityKey,
]);

export const createProjectCodeLockKey = ({organizationId, projectCode}) => createScopedEntityLockKey({
  organizationId,
  entityType: 'ProjectCode',
  entityKey: String(projectCode).trim().toLowerCase(),
});
