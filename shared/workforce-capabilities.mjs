export const CAPABILITIES_VERSION = 'workforce-capabilities/1';
// UTF-8/PostgreSQL C ordering for valid Unicode identifiers, including astral text.
export const compareCapabilityIds = (a,b) => {
  const left=[...a],right=[...b];for(let i=0;i<Math.min(left.length,right.length);i++){const d=left[i].codePointAt(0)-right[i].codePointAt(0);if(d)return Math.sign(d);}return Math.sign(left.length-right.length);
};
export const validCapabilityDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value >= '0001-01-01' && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
export const capabilityLabel = value => typeof value === 'string' && value === value.trim() && [...value].length >= 1
  && [...value].length <= 100 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\uD800-\uDFFF]/u.test(value);
export const validCapabilities = value => {
  if (!keys(value, ['skills', 'certifications', 'availabilityNote']) || !Array.isArray(value.skills) || value.skills.length > 50
    || !Array.isArray(value.certifications) || value.certifications.length > 50) return false;
  const skills = new Set(), certificates = new Set();
  for (const item of value.skills) {
    if (!keys(item, ['skill', 'proficiency']) || !capabilityLabel(item.skill) || !(item.proficiency === null || capabilityLabel(item.proficiency)) || skills.has(item.skill)) return false;
    skills.add(item.skill);
  }
  for (const item of value.certifications) {
    if (!keys(item, ['certification', 'validFrom', 'validThrough', 'noExpiry']) || !capabilityLabel(item.certification) || certificates.has(item.certification)
      || !validCapabilityDate(item.validFrom) || typeof item.noExpiry !== 'boolean'
      || (item.noExpiry ? item.validThrough !== null : !validCapabilityDate(item.validThrough) || item.validThrough < item.validFrom)) return false;
    certificates.add(item.certification);
  }
  const note = value.availabilityNote;
  return note === null || typeof note === 'string' && note.trim() === note && [...note].length >= 1 && [...note].length <= 3000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(note);
};
export const validCapabilityCriteria = value => keys(value, ['skill', 'proficiency', 'certification', 'validOn'])
  && [value.skill, value.proficiency, value.certification].every(item => item === null || capabilityLabel(item))
  && (value.proficiency === null || value.skill !== null)
  && (value.certification === null ? value.validOn === null : validCapabilityDate(value.validOn));
export const matchesCapabilities = (profile, criteria) => validCapabilities(profile) && validCapabilityCriteria(criteria)
  && (criteria.skill === null || profile.skills.some(item => item.skill === criteria.skill && (criteria.proficiency === null || item.proficiency === criteria.proficiency)))
  && (criteria.certification === null || profile.certifications.some(item => item.certification === criteria.certification && item.validFrom <= criteria.validOn && (item.noExpiry || item.validThrough >= criteria.validOn)));
