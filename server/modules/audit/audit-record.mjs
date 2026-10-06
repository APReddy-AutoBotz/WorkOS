const getRequestIp = (req = {}) => String(req.headers?.['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
  .split(',')[0]
  .trim();

export const AUDIT_INSERT_SQL = `
  insert into audit_logs (
    user_id, user_name, user_role, active_role, source, module, action, entity_type, entity_id,
    old_value, new_value, details, reason, ip_address, session_id, correlation_id, operation_id
  )
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
`;

/**
 * Persist the shared production mutation/audit contract. Existing callers may
 * omit request context during system work; newly handled API mutations carry
 * server-generated correlation and operation identifiers.
 */
export const recordAuditEvent = async (client, req = {}, {
  module,
  action,
  entityType,
  entityId,
  oldValue,
  newValue,
  details,
  reason,
  source = 'Web',
}) => {
  await client.query(AUDIT_INSERT_SQL, [
    req.user?.sub || 'system',
    req.user?.username || 'system',
    req.user?.activeRole || 'system',
    req.user?.activeRole || 'system',
    source,
    module,
    action,
    entityType,
    entityId,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
    details,
    reason || null,
    getRequestIp(req) || null,
    req.user?.sub || null,
    req.correlationId || null,
    req.operationId || null,
  ]);
};
