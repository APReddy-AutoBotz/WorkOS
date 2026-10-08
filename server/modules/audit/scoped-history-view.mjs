const sensitiveIdentityKeys = new Set([
  'entraobjectid',
  'providersubject',
  'providerupn',
  'teamstenantid',
  'teamsupn',
  'teamsuserid',
  'upn',
]);
const sensitiveHistoryKeys = new Set(['actionurl']);

const normalizeKey = key => key.toLowerCase().replaceAll('_', '').replaceAll('-', '');

export const redactIdentityFields = value => {
  if (Array.isArray(value)) return value.map(redactIdentityFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => {
      const normalizedKey = normalizeKey(key);
      return !sensitiveIdentityKeys.has(normalizedKey) && !sensitiveHistoryKeys.has(normalizedKey);
    })
    .map(([key, child]) => [key, redactIdentityFields(child)]));
};

export const redactAuditHistoryRows = rows => rows.map(row => ({
  ...row,
  old_value: redactIdentityFields(row.old_value),
  new_value: redactIdentityFields(row.new_value),
}));

export const redactIntegrationHistoryRows = rows => rows.map(row => ({
  ...row,
  entity_id: row.event_type === 'EntraLoginRejected' ? null : row.entity_id,
  request_payload: redactIdentityFields(row.request_payload),
  response_payload: redactIdentityFields(row.response_payload),
}));
