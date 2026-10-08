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

const collectSensitiveIdentityValues = (value, values = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach(item => collectSensitiveIdentityValues(item, values));
    return values;
  }
  if (!value || typeof value !== 'object') return values;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveIdentityKeys.has(normalizeKey(key)) && typeof child === 'string' && child) values.add(child);
    collectSensitiveIdentityValues(child, values);
  }
  return values;
};

export const redactIdentityFields = value => {
  return redactIdentityFieldsWithValues(value, collectSensitiveIdentityValues(value));
};

const redactIdentityFieldsWithValues = (value, sensitiveValues) => {
  if (Array.isArray(value)) return value.map(item => redactIdentityFieldsWithValues(item, sensitiveValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => {
      const normalizedKey = normalizeKey(key);
      return !sensitiveIdentityKeys.has(normalizedKey)
        && !sensitiveHistoryKeys.has(normalizedKey)
        && !(normalizedKey === 'id' && containsSensitiveIdentityValue(child, sensitiveValues));
    })
    .map(([key, child]) => [key, redactIdentityFieldsWithValues(child, sensitiveValues)]));
};

const containsSensitiveIdentityValue = (reference, sensitiveValues) => {
  if (typeof reference !== 'string' || !reference) return false;
  const normalizedReference = reference.toLowerCase();
  return [...sensitiveValues].some(value => normalizedReference.includes(value.toLowerCase()));
};

export const redactAuditHistoryRows = rows => rows.map(row => {
  const sensitiveValues = collectSensitiveIdentityValues([row.old_value, row.new_value]);
  const redacted = {
    ...row,
    old_value: redactIdentityFieldsWithValues(row.old_value, sensitiveValues),
    new_value: redactIdentityFieldsWithValues(row.new_value, sensitiveValues),
  };
  if (Object.hasOwn(row, 'entity_id')) {
    redacted.entity_id = containsSensitiveIdentityValue(row.entity_id, sensitiveValues) ? null : row.entity_id;
  }
  if (Object.hasOwn(row, 'source_identifier')) {
    redacted.source_identifier = containsSensitiveIdentityValue(row.source_identifier, sensitiveValues)
      ? null
      : row.source_identifier;
  }
  return redacted;
});

export const redactIntegrationHistoryRows = rows => rows.map(row => {
  const sensitiveValues = collectSensitiveIdentityValues([row.request_payload, row.response_payload]);
  return {
    ...row,
    entity_id: row.event_type === 'EntraLoginRejected' || containsSensitiveIdentityValue(row.entity_id, sensitiveValues)
      ? null
      : row.entity_id,
    request_payload: redactIdentityFieldsWithValues(row.request_payload, sensitiveValues),
    response_payload: redactIdentityFieldsWithValues(row.response_payload, sensitiveValues),
  };
});
