import {Router} from 'express';
import {redactAuditHistoryRows} from './scoped-history-view.mjs';

const auditHistoryQuery = `select * from audit_logs
  where organization_id=$1 and legal_entity_id=$2
  order by created_at desc limit 500`;

export const createAuditHistoryRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function'
      || ![requireDatabase, requireAuth, requirePermission].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Audit history routes require a database, identity guards, permission guard, and error logger.');
  }

  const router = Router();
  router.get('/audit-logs', requireDatabase, requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
      const result = await pool.query(auditHistoryQuery, [
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      res.json(redactAuditHistoryRows(result.rows));
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Database operation failed'});
    }
  });
  return router;
};
