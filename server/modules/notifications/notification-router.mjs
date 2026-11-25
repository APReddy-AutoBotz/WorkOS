import {teamsReleased} from '../module-releases.mjs';
import {Router} from 'express';
import {z} from 'zod';
import {safeNotificationMetadata, safeNotificationProvider} from './delivery-diagnostics.mjs';

export const createNotificationRouter = ({
  pool,
  run,
  requireDatabase,
  requireAuth,
  requirePermission,
  buildEmployeeScopeWhere,
  audit,
  sendNotification,
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || typeof run !== 'function' || typeof buildEmployeeScopeWhere !== 'function'
      || typeof audit !== 'function' || typeof sendNotification !== 'function'
      || ![requireDatabase, requireAuth, requirePermission].every(value => typeof value === 'function')
      || typeof logError !== 'function') {
    throw new TypeError('Notification routes require a database, identity guards, scope resolver, audit writer, and delivery adapter.');
  }

  const router = Router();
  router.get('/notifications', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
    const params = [];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    await run(res, `
      select ne.*, e.name as recipient_name
      from notification_events ne
      left join employees e on e.id = ne.recipient_employee_id
      where ${where}
      order by ne.created_at desc
      limit 300
    `, params);
  });

  router.patch('/notifications/:id/read', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
    try {
      const params = [req.params.id];
      const where = buildEmployeeScopeWhere(req, params, 'e');
      const result = await pool.query(`
        update notification_events ne
        set read_at = coalesce(read_at, now())
        from employees e
        where ne.id = $1 and e.id = ne.recipient_employee_id and ${where}
        returning ne.*
      `, params);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Notification not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch (error) {
      logError(error);
      res.status(500).json({ error: 'Notification read update failed' });
    }
  });

  router.get('/notification-templates', requireDatabase, requireAuth, requirePermission('notifications.manage'), (_req, res) => {
    run(res, 'select * from notification_templates order by event_type, channel');
  });

  router.post('/notification-templates', requireDatabase, requireAuth, requirePermission('notifications.manage'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      event_type: z.string().min(1),
      channel: z.enum(['InApp', 'Email', 'Teams']),
      subject: z.string().min(1),
      body: z.string().min(1),
      active: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const previous = parsed.data.id ? (await client.query('select * from notification_templates where id = $1', [parsed.data.id])).rows[0] : null;
      const result = await client.query(`
        insert into notification_templates (id, event_type, channel, subject, body, active)
        values (coalesce($1, 'notification-template-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
        on conflict (event_type, channel) do update set
          subject = excluded.subject,
          body = excluded.body,
          active = excluded.active,
          updated_at = now()
        returning *
      `, [parsed.data.id || null, parsed.data.event_type, parsed.data.channel, parsed.data.subject, parsed.data.body, parsed.data.active]);
      await audit(client, req, {
        module: 'Notifications',
        action: previous ? 'Update Notification Template' : 'Create Notification Template',
        entityType: 'NotificationTemplate',
        entityId: result.rows[0].id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `${previous ? 'Updated' : 'Created'} notification template ${result.rows[0].event_type}`,
        organizationScope: null,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      logError(error);
      res.status(500).json({ error: 'Notification template save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/notification-preferences', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
    const params = [];
    const where = buildEmployeeScopeWhere(req, params, 'e');
    await run(res, `
      select np.*, e.name as employee_name
      from notification_preferences np
      join employees e on e.id = np.employee_id
      where ${where}
      order by e.name, np.event_type
    `, params);
  });

  router.post('/notification-preferences', requireDatabase, requireAuth, requirePermission('notifications.view'), async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      employee_id: z.string().min(1),
      event_type: z.string().min(1),
      in_app: z.boolean().default(true),
      email: z.boolean().default(false),
      teams: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (req.user.activeRole === 'Employee' && parsed.data.employee_id !== req.user.employeeRecordId && parsed.data.employee_id !== req.user.employeeId) {
      res.status(403).json({ error: 'Employees can update only their own notification preferences' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const scopeParams = [parsed.data.employee_id];
      const scopeWhere = buildEmployeeScopeWhere(req, scopeParams, 'e');
      const targetEmployee = (await client.query(`
        select e.*
        from employees e
        where (e.id = $1 or e.employee_id = $1) and ${scopeWhere}
        limit 1
      `, scopeParams)).rows[0];
      if (!targetEmployee) {
        await client.query('rollback');
        res.status(403).json({ error: 'Notification preference is outside active-role data scope' });
        return;
      }
      const previous = (await client.query('select * from notification_preferences where employee_id = $1 and event_type = $2', [targetEmployee.id, parsed.data.event_type])).rows[0];
      const result = await client.query(`
        insert into notification_preferences (id, employee_id, event_type, in_app, email, teams)
        values (coalesce($1, 'notification-preference-' || gen_random_uuid()::text), $2, $3, $4, $5, $6)
        on conflict (employee_id, event_type) do update set
          in_app = excluded.in_app,
          email = excluded.email,
          teams = excluded.teams,
          updated_at = now()
        returning *
      `, [parsed.data.id || null, targetEmployee.id, parsed.data.event_type, parsed.data.in_app, parsed.data.email, parsed.data.teams]);
      await audit(client, req, {
        module: 'Notifications',
        action: 'Update Notification Preference',
        entityType: 'NotificationPreference',
        entityId: result.rows[0].id,
        oldValue: previous,
        newValue: result.rows[0],
        details: `Updated notification preference ${result.rows[0].event_type}`,
      });
      await client.query('commit');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      logError(error);
      res.status(500).json({ error: 'Notification preference save failed' });
    } finally {
      client.release();
    }
  });

  router.get('/notification-delivery-attempts', requireDatabase, requireAuth, requirePermission('notifications.manage'), async (req, res) => {
    try {
      const params = [];
      const where = buildEmployeeScopeWhere(req, params, 'e');
      const result = await pool.query(`select nda.id, nda.notification_id, nda.channel, nda.provider,
        nda.status, nda.attempted_at, nda.response_metadata
        from notification_delivery_attempts nda
        join notification_events ne on ne.id=nda.notification_id
        join employees e on e.id=ne.recipient_employee_id
        where ${where} order by nda.attempted_at desc, nda.id desc limit 300`,params);
      res.json(result.rows.map(row => ({...row, provider: safeNotificationProvider(row.provider),
        response_metadata:safeNotificationMetadata(row.response_metadata,row.status==='Failed')})));
    } catch (error) {
      logError(error);
      res.status(500).json({error:'Notification delivery history unavailable'});
    }
  });

  router.post('/notifications/test-delivery', requireDatabase, requireAuth, requirePermission('notifications.manage'), async (req, res) => {
    const schema = z.object({
      employee_id: z.string().min(1),
      channels: z.array(z.enum(['InApp', 'Email', 'Teams'])).min(1).default(['InApp']),
      title: z.string().min(1).default('Configured product notification test'),
      body: z.string().min(1).default('This validates configured notification delivery from Configured product.'),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const scopeParams = [parsed.data.employee_id];
      const scopeWhere = buildEmployeeScopeWhere(req, scopeParams, 'e');
      const targetEmployee = (await client.query(`
        select e.*
        from employees e
        where (e.id = $1 or e.employee_id = $1) and ${scopeWhere}
        limit 1
      `, scopeParams)).rows[0];
      if (!targetEmployee) {
        await client.query('rollback');
        res.status(403).json({ error: 'Notification test recipient is outside active-role data scope' });
        return;
      }
      if (parsed.data.channels.includes('Teams') && !await teamsReleased(client, targetEmployee.organization_id)) {
        await client.query('rollback');
        return res.status(403).json({error:'Teams is disabled for this organization and environment',code:'MODULE_DISABLED'});
      }
      const event = await sendNotification(client, req, {
        recipientEmployeeId: targetEmployee.id,
        eventType: 'TestDelivery',
        title: parsed.data.title,
        body: parsed.data.body,
        entityType: 'NotificationTest',
        entityId: targetEmployee.id,
        severity: 'Info',
        channels: parsed.data.channels,
        actionUrl: process.env.APP_URL || null,
      });
      await client.query('commit');
      res.json(event);
    } catch (error) {
      await client.query('rollback');
      logError(error);
      res.status(500).json({ error: 'Notification test delivery failed' });
    } finally {
      client.release();
    }
  });
  return router;
};
