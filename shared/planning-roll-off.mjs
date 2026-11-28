// The planning report counts an assignment ending on the report date or in the next 45 days.
export function rollsOffSoon(asOfDate, endDate) {
  if (!asOfDate || !endDate) return false;
  const elapsed = Date.parse(endDate.slice(0, 10) + 'T00:00:00Z') - Date.parse(asOfDate + 'T00:00:00Z');
  return elapsed >= 0 && elapsed <= 45 * 86400000;
}
