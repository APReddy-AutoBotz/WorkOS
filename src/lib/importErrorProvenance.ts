export type ImportProvenanceChannel = 'employees' | 'clients' | 'projects' | 'allocations' | 'timesheets';
export type ImportProvenanceRow = Record<string, string>;
export type ImportProvenanceError = {
  rowNumber: number;
  field?: string;
  message: string;
  sourceIdentifier?: string | null;
};

export const MAX_IMPORT_ERROR_SOURCE_IDENTIFIER_LENGTH = 200;

const sourceIdentifierField: Record<ImportProvenanceChannel, string | null> = {
  employees: 'employeeId',
  clients: 'id',
  projects: 'projectCode',
  allocations: 'id',
  timesheets: null,
};

export const isSafeImportErrorSourceIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_IMPORT_ERROR_SOURCE_IDENTIFIER_LENGTH
  && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);

const sourceIdentifierForRow = (channel: ImportProvenanceChannel, row?: ImportProvenanceRow): string | null => {
  const field = sourceIdentifierField[channel];
  const value = field && row ? row[field] : '';
  return isSafeImportErrorSourceIdentifier(value) ? value : null;
};

/**
 * Attach a bounded source identifier to a preflight error while the complete
 * original CSV row array is still available. Row numbers include the header,
 * so row 2 maps to index 0; never index a filtered validRows array here.
 */
export const attachPreflightSourceIdentifiers = (
  channel: ImportProvenanceChannel,
  originalRows: ImportProvenanceRow[],
  errors: ImportProvenanceError[],
): ImportProvenanceError[] => errors.map(error => ({
  ...error,
  sourceIdentifier: error.rowNumber >= 2
    ? sourceIdentifierForRow(channel, originalRows[error.rowNumber - 2])
    : null,
}));
