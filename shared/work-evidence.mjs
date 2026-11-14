// Evidence is a stored reference only. Never resolve, fetch or preview its URL.
export const normalizeEvidenceUrl = value => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Use an absolute HTTP or HTTPS evidence URL.');
  const text = value.trim();
  if (!text) return null;
  if (text.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(text)) throw new Error('Use an absolute HTTP or HTTPS evidence URL of at most 2048 characters.');
  let url;
  try { url = new URL(text); } catch { throw new Error('Use an absolute HTTP or HTTPS evidence URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || !/^https?:\/\//i.test(text))
    throw new Error('Use an absolute HTTP or HTTPS evidence URL without embedded credentials.');
  return text;
};

export const evidenceUrlIsValid = value => {
  try { normalizeEvidenceUrl(value); return true; } catch { return false; }
};
