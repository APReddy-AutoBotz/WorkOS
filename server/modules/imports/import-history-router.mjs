import {Router} from 'express';

const importHistoryQuery = `select * from import_export_logs
  where organization_id=$1 and legal_entity_id=$2
  order by created_at desc limit 100`;

export const createImportHistoryRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function'
      || ![requireDatabase, requireAuth, requirePermission].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Import history routes require a database, identity guards, permission guard, and error logger.');
  }

  const router = Router();
  router.get('/import-export-logs', requireDatabase, requireAuth, requirePermission('employees.manage'), async (req, res) => {
    try {
      const result = await pool.query(importHistoryQuery, [
        req.organizationScope.organizationId,
        req.organizationScope.legalEntityId,
      ]);
      res.json(result.rows);
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Database operation failed'});
    }
  });
  return router;
};
