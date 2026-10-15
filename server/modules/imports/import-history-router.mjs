import {Router} from 'express';
import {z} from 'zod';
import {importErrorRowSchema} from './import-error-provenance.mjs';

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

  router.post('/import-export-logs', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
    const schema = z.object({
      operation: z.enum(['Import', 'Export']),
      channel: z.string().min(1),
      fileName: z.string().min(1),
      status: z.enum(['Success', 'Partial', 'Failed', 'Dry Run']),
      totalRows: z.number().int().min(0),
      validRows: z.number().int().min(0),
      errorRows: z.number().int().min(0),
      errors: z.array(importErrorRowSchema).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const result = await pool.query(`
        insert into import_export_logs (operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        returning id, operation, channel, file_name, status, total_rows, valid_rows, error_rows,
          errors, user_name, created_at, organization_id, legal_entity_id
      `, [
        parsed.data.operation,
        parsed.data.channel,
        parsed.data.fileName,
        parsed.data.status,
        parsed.data.totalRows,
        parsed.data.validRows,
        parsed.data.errorRows,
        parsed.data.errors ? JSON.stringify(parsed.data.errors) : null,
        req.user.username,
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
