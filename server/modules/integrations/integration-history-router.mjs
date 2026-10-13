import {Router} from 'express';
import {redactIntegrationHistoryRows} from '../audit/scoped-history-view.mjs';

const integrationHistoryQuery = `select * from integration_event_logs
  where organization_id=$1 and legal_entity_id=$2
  order by created_at desc limit 300`;
const deploymentAuditPermission = 'audit.deployment.view';
const deploymentIntegrationHistoryQuery = `select iel.* from integration_event_logs iel
  where iel.organization_id is null and iel.legal_entity_id is null
    and exists (
      select 1 from users u
      join user_roles ur on ur.user_id=u.id
      join roles r on r.id=ur.role_id
      join user_permission_grants upg on upg.user_id=u.id
      where u.id::text=$1 and u.status='Active' and r.name=$2 and upg.permission_key=$3
    )
  order by iel.created_at desc limit 300`;

export const createIntegrationHistoryRouter = ({
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
    throw new TypeError('Integration history routes require a database, identity guards, permission guard, and error logger.');
  }

  const router = Router();
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

  router.get('/deployment-integration-events', requireDatabase, requireIdentity,
    requireActiveAssignedRole, requirePermission(deploymentAuditPermission), requireExplicitDeploymentAuditGrant,
    async (req, res) => {
      try {
        const result = await pool.query(deploymentIntegrationHistoryQuery, [
          req.user.sub,
          req.user.activeRole,
          deploymentAuditPermission,
        ]);
        res.json(redactIntegrationHistoryRows(result.rows));
      } catch (error) {
        logError(error);
        res.status(500).json({error: 'Database operation failed'});
      }
    });
  return router;
};
