// Preserve the existing literal-text convention for spreadsheet-facing CSV.
// Quoting alone does not prevent formula interpretation. Test headers as well
// as values, including prefixes some spreadsheet importers trim or normalize.
const formulaPrefix = /^[\s\u0000-\u001f\u007f]*[=+\-@＝＋－＠]/u;
const controlPrefix = /^[\u0000-\u001f\u007f]/u;

export const quoteCsvCell = value => {
  const text = String(value ?? '');
  const literal = formulaPrefix.test(text) || controlPrefix.test(text) ? "'" + text : text;
  return '"' + literal.replaceAll('"', '""') + '"';
};
