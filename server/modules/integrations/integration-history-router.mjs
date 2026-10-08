import {Router} from 'express';
import {redactIntegrationHistoryRows} from '../audit/scoped-history-view.mjs';

const integrationHistoryQuery = `select * from integration_event_logs
  where organization_id=$1 and legal_entity_id=$2
  order by created_at desc limit 300`;

export const createIntegrationHistoryRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function'
      || ![requireDatabase, requireAuth, requirePermission].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Integration history routes require a database, identity guards, permission guard, and error logger.');
  }

  const router = Router();
  router.get('/integrations/events', requireDatabase, requireAuth, requirePermission('integrations.identity'), async (req, res) => {
    try {
      const result = await pool.query(integrationHistoryQuery, [
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      res.json(redactIntegrationHistoryRows(result.rows));
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Database operation failed'});
    }
  });
  return router;
};
