import {Router} from 'express';
import {redactAuditHistoryRows} from './scoped-history-view.mjs';

const auditHistoryQuery = `select * from audit_logs
  where organization_id=$1 and legal_entity_id=$2
  order by created_at desc limit 500`;
const deploymentAuditPermission = 'audit.deployment.view';
const deploymentAuditHistoryQuery = `select al.* from audit_logs al
  where al.organization_id is null and al.legal_entity_id is null
    and exists (
      select 1 from users u
      join user_roles ur on ur.user_id=u.id
      join roles r on r.id=ur.role_id
      join user_permission_grants upg on upg.user_id=u.id
      where u.id::text=$1 and u.status='Active' and r.name=$2 and upg.permission_key=$3
    )
  order by al.created_at desc limit 500`;

export const createAuditHistoryRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function'
      || ![requireDatabase, requireAuth, requireIdentity, requirePermission].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Audit history routes require a database, identity guards, permission guard, and error logger.');
  }

  const router = Router();
  const requireExplicitDeploymentAuditGrant = async (req, res, next) => {
    try {
      const result = await pool.query(`select 1 from user_permission_grants
        where user_id=$1 and permission_key=$2`, [req.user.sub, deploymentAuditPermission]);
      if (result.rowCount === 0) {
        res.status(403).json({error: 'Insufficient permission privileges'});
        return;
      }
      next();
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Permission check failed'});
    }
  };
  const requireActiveAssignedRole = async (req, res, next) => {
    try {
      const result = await pool.query(`select 1 from users u
        join user_roles ur on ur.user_id=u.id
        join roles r on r.id=ur.role_id
        where u.id::text=$1 and u.status='Active' and r.name=$2`, [req.user.sub, req.user.activeRole]);
      if (result.rowCount === 0) {
        res.status(403).json({error: 'Insufficient permission privileges'});
        return;
      }
      next();
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Permission check failed'});
    }
  };

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

  router.get('/deployment-audit-logs', requireDatabase, requireIdentity,
    requireActiveAssignedRole, requirePermission(deploymentAuditPermission), requireExplicitDeploymentAuditGrant,
    async (_req, res) => {
      try {
        const result = await pool.query(deploymentAuditHistoryQuery, [
          _req.user.sub,
          _req.user.activeRole,
          deploymentAuditPermission,
        ]);
        res.json(redactAuditHistoryRows(result.rows));
      } catch (error) {
        logError(error);
        res.status(500).json({error: 'Database operation failed'});
      }
    });

  return router;
};
