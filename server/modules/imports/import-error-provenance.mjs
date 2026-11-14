import { z } from 'zod';

export const MAX_IMPORT_ERROR_SOURCE_IDENTIFIER_LENGTH = 200;

export const isSafeImportErrorSourceIdentifier = value => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_IMPORT_ERROR_SOURCE_IDENTIFIER_LENGTH
  && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);

export const normalizeImportErrorSourceIdentifier = value => (
  isSafeImportErrorSourceIdentifier(value) ? value : null
);

const importErrorSourceIdentifierSchema = z.string()
  .max(MAX_IMPORT_ERROR_SOURCE_IDENTIFIER_LENGTH)
  .refine(isSafeImportErrorSourceIdentifier, 'Source identifier must be printable and non-empty.');

export const importErrorRowSchema = z.object({
  rowNumber: z.number().int().min(1),
  field: z.string().optional(),
  message: z.string(),
  sourceIdentifier: importErrorSourceIdentifierSchema.nullable().optional(),
});

/**
 * Reconstruct original CSV row numbers for the valid rows sent to the apply
 * endpoint. The browser removes preflight-invalid rows but retains their
 * original row numbers in clientErrors. If the counts do not prove a complete
 * mapping, return the legacy row numbering and mark it unreliable so callers
 * do not attach an identifier to the wrong row.
 */
export const resolveImportApplyRowNumbers = ({rows, totalRows, clientErrors = []}) => {
  const rowCount = rows.length;
  const rejectedDataRows = new Set();
  let clientErrorRowsAreValid = true;

  for (const error of clientErrors) {
    if (error.rowNumber === 1) continue;
    if (!Number.isInteger(error.rowNumber) || error.rowNumber < 2) {
      clientErrorRowsAreValid = false;
      continue;
    }
    rejectedDataRows.add(error.rowNumber);
  }

  const inferredTotalRows = Number.isInteger(totalRows)
    ? totalRows
    : rowCount + rejectedDataRows.size;
  const withinOriginalFile = [...rejectedDataRows].every(rowNumber => rowNumber <= inferredTotalRows + 1);
  const mappingIsReliable = clientErrorRowsAreValid
    && inferredTotalRows >= rowCount
    && withinOriginalFile
    && inferredTotalRows - rejectedDataRows.size === rowCount;

  if (!mappingIsReliable) {
    return {
      rowNumbers: rows.map((_, index) => index + 2),
      mappingIsReliable: false,
    };
  }

  const rowNumbers = Array.from({length: inferredTotalRows}, (_, index) => index + 2)
    .filter(rowNumber => !rejectedDataRows.has(rowNumber));
  return {rowNumbers, mappingIsReliable: true};
};

/**
 * Enrich error rows with only the corresponding identifier field. A route can
 * permit optional, schema-validated IDs on client preflight errors only when
 * that import channel has a real upstream identifier. Apply-time errors are
 * joined through the proven original-row mapping. If counts or preflight row
 * numbers are inconsistent, omit all source IDs rather than retaining a
 * potentially misattributed value.
 */
export const attachImportErrorSourceIdentifiers = ({
  errors,
  clientErrors = [],
  rows,
  rowNumbers,
  mappingIsReliable,
  sourceIdentifierForRow,
  allowClientSourceIdentifiers = true,
}) => {
  const clientErrorCount = clientErrors.length;
  const identifiersByRow = new Map();

  if (mappingIsReliable) {
    rowNumbers.forEach((rowNumber, index) => {
      identifiersByRow.set(
        rowNumber,
        normalizeImportErrorSourceIdentifier(sourceIdentifierForRow(rows[index])),
      );
    });
  }

  return errors.map((error, index) => {
    if (index < clientErrorCount) {
      return {
        ...error,
        sourceIdentifier: allowClientSourceIdentifiers && mappingIsReliable && error.rowNumber >= 2
          ? normalizeImportErrorSourceIdentifier(error.sourceIdentifier)
          : null,
      };
    }

    return {
      ...error,
      sourceIdentifier: identifiersByRow.get(error.rowNumber) ?? null,
    };
  });
};
