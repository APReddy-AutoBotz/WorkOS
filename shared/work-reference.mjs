// Descriptive text only: no provider lookup, URL handling or business authority.
export const normalizeWorkReference = value => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error('Use a single-line task, ticket or milestone reference without control characters.');
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > 200) throw new Error('Use at most 200 characters for the work reference.');
  return text;
};
export const workReferenceIsValid = value => {
  try { normalizeWorkReference(value); return true; } catch { return false; }
};
