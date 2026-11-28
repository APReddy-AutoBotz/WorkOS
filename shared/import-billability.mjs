const billableTokens = new Map([
  ['true', true], ['1', true], ['yes', true], ['y', true],
  ['false', false], ['0', false], ['no', false], ['n', false],
]);

export class InvalidImportBillability extends Error {
  constructor(rowNumber) {
    super(`Billable${rowNumber === undefined ? '' : ` on row ${rowNumber}`} must be true/false, yes/no, y/n, 1/0 or blank.`);
    this.code = 'INVALID_IMPORT_BILLABLE';
  }
}

/** Blank values use the existing default for the import channel or saved record. */
export function parseImportBillable(value, fallback, rowNumber = undefined) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (!token) return fallback;
    if (billableTokens.has(token)) return billableTokens.get(token);
  }
  throw new InvalidImportBillability(rowNumber);
}

export function validateImportBillability(rows, rowNumbers) {
  rows.forEach((row, index) => parseImportBillable(row.billable, false, rowNumbers?.[index] ?? index + 2));
}
