export type ImportRowError = {rowNumber: number};

/** Remove submitted initial-password echoes from Employee import filenames and diagnostics. */
export const redactCredentialEchoes = <T>(value: T, credentials: string[]): T => {
  const secrets = [...new Set(credentials.filter(secret => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return secrets.reduce((result, secret) => result.split(secret).join(''), item);
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, redact(nested)]));
    }
    return item;
  };
  return redact(value) as T;
};

/** Keep only client-approved rows not rejected by the server, using original CSV row numbers. */
export const filterAcceptedImportRows = <TRow extends object>(
  sourceRows: TRow[],
  submittedRows: TRow[],
  errors: ImportRowError[],
): TRow[] => {
  const sourceRowNumbers = new Map(sourceRows.map((row, index) => [row, index + 2]));
  const rejectedRowNumbers = new Set(errors
    .map(error => error.rowNumber)
    .filter(rowNumber => Number.isInteger(rowNumber) && rowNumber >= 2));
  return submittedRows.filter(row => {
    const rowNumber = sourceRowNumbers.get(row);
    return rowNumber !== undefined && !rejectedRowNumbers.has(rowNumber);
  });
};
