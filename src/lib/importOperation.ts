export type ImportRowError = {rowNumber: number};

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
