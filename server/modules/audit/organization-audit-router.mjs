import {Router} from 'express';
import {redactAuditHistoryRows} from './scoped-history-view.mjs';

const organizationAuditPermission = 'audit.organization.view';
const maxAuditRows = 500;

export const createOrganizationAuditRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requireIdentity,
  requirePermission,
  getEffectivePermissionsForUser,
  audit,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || ![requireDatabase, requireAuth, requireIdentity, requirePermission, getEffectivePermissionsForUser, audit].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Organization audit routes require a database, identity guards, permissions, and an audit writer.');
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

  const requireOrganizationAuditGrant = async (req, res, next) => {
    const organizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
    if (!organizationId) {
      res.status(400).json({error: 'An authorized organization must be selected.'});
      return;
    }
    try {
      const result = await pool.query(`select 1 from organization_audit_grants g
        where g.user_id::text=$1 and g.organization_id=$2`, [req.user.sub, organizationId]);
      if (result.rowCount === 0) {
        // Do not disclose whether an ungranted organization or its audit rows exist.
        res.status(404).json({error: 'Organization audit access was not found.'});
        return;
      }
      req.organizationAuditId = organizationId;
      next();
    } catch (error) {
      logError(error);
      res.status(500).json({error: 'Organization audit permission check failed'});
    }
  };

  router.get('/organization-audit-scopes', requireDatabase, requireIdentity,
    requireActiveAssignedRole, requirePermission(organizationAuditPermission), async (req, res) => {
      try {
        const result = await pool.query(`select o.id organization_id,o.code organization_code,o.name organization_name,o.status
          from organization_audit_grants g
          join organizations o on o.id=g.organization_id
          where g.user_id::text=$1
          order by o.code,o.id`, [req.user.sub]);
        res.json(result.rows);
      } catch (error) {
        logError(error);
        res.status(500).json({error: 'Organization audit scopes could not be loaded'});
      }
    });

  router.get('/organization-audit-logs', requireDatabase, requireIdentity,
    requireActiveAssignedRole, requirePermission(organizationAuditPermission), requireOrganizationAuditGrant,
    async (req, res) => {
      try {
        const result = await pool.query(`select al.* from audit_logs al
          where al.organization_id=$1 and al.legal_entity_id is null
            and exists (
              select 1 from users u
              join user_roles ur on ur.user_id=u.id
              join roles r on r.id=ur.role_id
              join organization_audit_grants g on g.user_id=u.id
              where u.id::text=$2 and u.status='Active' and r.name=$3
                and g.organization_id=al.organization_id
            )
          order by al.created_at desc limit ${maxAuditRows}`,
        [req.organizationAuditId, req.user.sub, req.user.activeRole]);
        res.json(redactAuditHistoryRows(result.rows));
      } catch (error) {
        logError(error);
        res.status(500).json({error: 'Organization audit history could not be loaded'});
      }
    });

  router.get('/permissions/organization-audit-grants', requireDatabase, requireAuth,
    requireActiveAssignedRole, requirePermission('permissions.manage'), async (req, res) => {
      const organizationId = req.organizationScope.organizationId;
      try {
        const [eligibleUsers, grants] = await Promise.all([
          pool.query(`select u.id::text id,u.username,u.employee_id,u.status,
              coalesce(e.name,u.username) display_name,
              coalesce(json_agg(r.name order by r.name) filter (where r.name is not null),'[]') roles
            from users u
            join user_organization_scopes s on s.user_id=u.id and s.organization_id=$1 and s.active=true
            join user_roles ur on ur.user_id=u.id
            join roles r on r.id=ur.role_id
            left join employees e on e.id=u.employee_record_id and e.organization_id=$1
            where u.status='Active' and u.id::text<>$2
            group by u.id,e.name
            order by display_name,u.id`, [organizationId, req.user.sub]),
          pool.query(`select g.id,g.organization_id,g.user_id::text user_id,g.granted_by::text granted_by,
              g.granted_by_active_role,g.created_at,u.username,u.employee_id,coalesce(e.name,u.username) display_name
            from organization_audit_grants g
            join users u on u.id=g.user_id
            left join employees e on e.id=u.employee_record_id and e.organization_id=g.organization_id
            where g.organization_id=$1
            order by g.created_at desc,g.id`, [organizationId]),
        ]);
        res.json({organizationId, eligibleUsers: eligibleUsers.rows, grants: grants.rows});
      } catch (error) {
        logError(error);
        res.status(500).json({error: 'Organization audit grants could not be loaded'});
      }
    });

  router.post('/permissions/organization-audit-grants', requireDatabase, requireAuth,
    requireActiveAssignedRole, requirePermission('permissions.manage'), async (req, res) => {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
      if (!userId) {
        res.status(400).json({error: 'A user must be selected.'});
        return;
      }
      const organizationId = req.organizationScope.organizationId;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`organization-audit-grants:${organizationId}`]);
        const managerIsActive = await client.query(`select 1 from users u
          join user_roles ur on ur.user_id=u.id
          join roles r on r.id=ur.role_id
          where u.id::text=$1 and u.status='Active' and r.name=$2
            and exists (select 1 from user_organization_scopes s where s.user_id=u.id
              and s.organization_id=$3 and s.legal_entity_id=$4 and s.active=true)`,
        [req.user.sub, req.user.activeRole, organizationId, req.organizationScope.legalEntityId]);
        if (managerIsActive.rowCount === 0) {
          await client.query('rollback');
          res.status(403).json({error: 'The permission manager active role or selected organization scope is no longer authorized.'});
          return;
        }
        const managerPermissions = await getEffectivePermissionsForUser(client, req.user.sub, req.user.activeRole);
        if (!managerPermissions.includes('permissions.manage')) {
          await client.query('rollback');
          res.status(403).json({error: 'Permission management is no longer authorized.'});
          return;
        }
        const target = (await client.query(`select u.id,u.username,u.status
          from users u
          where u.id::text=$1 and u.status='Active'
            and exists (select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id)
            and exists (select 1 from user_organization_scopes s
              where s.user_id=u.id and s.organization_id=$2 and s.active=true)
          for update`, [userId, organizationId])).rows[0];
        if (!target || target.id.toString() === req.user.sub) {
          await client.query('rollback');
          res.status(422).json({error: 'Organization audit access requires a different active user with a role and active access to this organization.'});
          return;
        }
        const previous = (await client.query(`select * from organization_audit_grants
          where organization_id=$1 and user_id=$2 for update`, [organizationId, target.id])).rows[0] || null;
        if (previous) {
          await client.query('commit');
          res.json(previous);
          return;
        }
        const grant = (await client.query(`insert into organization_audit_grants
          (organization_id,user_id,granted_by,granted_by_active_role)
          values ($1,$2,$3,$4) returning *`, [organizationId, target.id, req.user.sub, req.user.activeRole])).rows[0];
        await audit(client, req, {
          module: 'Permissions',
          action: 'Grant Organization Audit Access',
          entityType: 'OrganizationAuditGrant',
          entityId: grant.id,
          newValue: {organizationId, userId: target.id, grantedByActiveRole: grant.granted_by_active_role},
          details: `Designated ${target.username} as an auditor for organization ${organizationId}`,
          organizationScope: {organizationId, legalEntityId: null},
        });
        await client.query('commit');
        res.status(201).json(grant);
      } catch (error) {
        await client.query('rollback');
        logError(error);
        res.status(500).json({error: 'Organization audit access could not be granted'});
      } finally {
        client.release();
      }
    });

  router.delete('/permissions/organization-audit-grants/:id', requireDatabase, requireAuth,
    requireActiveAssignedRole, requirePermission('permissions.manage'), async (req, res) => {
      const organizationId = req.organizationScope.organizationId;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`organization-audit-grants:${organizationId}`]);
        const managerIsActive = await client.query(`select 1 from users u
          join user_roles ur on ur.user_id=u.id
          join roles r on r.id=ur.role_id
          where u.id::text=$1 and u.status='Active' and r.name=$2
            and exists (select 1 from user_organization_scopes s where s.user_id=u.id
              and s.organization_id=$3 and s.legal_entity_id=$4 and s.active=true)`,
        [req.user.sub, req.user.activeRole, organizationId, req.organizationScope.legalEntityId]);
        if (managerIsActive.rowCount === 0) {
          await client.query('rollback');
          res.status(403).json({error: 'The permission manager active role or selected organization scope is no longer authorized.'});
          return;
        }
        const managerPermissions = await getEffectivePermissionsForUser(client, req.user.sub, req.user.activeRole);
        if (!managerPermissions.includes('permissions.manage')) {
          await client.query('rollback');
          res.status(403).json({error: 'Permission management is no longer authorized.'});
          return;
        }
        const previous = (await client.query(`select * from organization_audit_grants
          where id=$1 and organization_id=$2 for update`, [req.params.id, organizationId])).rows[0];
        if (!previous) {
          await client.query('rollback');
          res.status(404).json({error: 'Organization audit grant was not found.'});
          return;
        }
        await client.query('delete from organization_audit_grants where id=$1 and organization_id=$2', [previous.id, organizationId]);
        await audit(client, req, {
          module: 'Permissions',
          action: 'Revoke Organization Audit Access',
          entityType: 'OrganizationAuditGrant',
          entityId: previous.id,
          oldValue: {organizationId, userId: previous.user_id, grantedByActiveRole: previous.granted_by_active_role},
          details: `Revoked organization audit access for user ${previous.user_id}`,
          organizationScope: {organizationId, legalEntityId: null},
        });
        await client.query('commit');
        res.json({status: 'ok'});
      } catch (error) {
        await client.query('rollback');
        logError(error);
        res.status(500).json({error: 'Organization audit access could not be revoked'});
      } finally {
        client.release();
      }
    });

  return router;
};
