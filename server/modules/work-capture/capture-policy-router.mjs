import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {lockWorkPolicy} from './assignment-work-policy.mjs';
import {CAPTURE_POLICY_VERSION, capturePolicyInput, capturePolicyView} from './capture-policy.mjs';

export const createCapturePolicyRouter = ({pool, requireDatabase, requireAuth, requirePermission, audit,
  logError = error => console.error('Capture policy request failed', error?.code || 'UNKNOWN')}) => {
  const router = Router();
  router.use(requireDatabase, requireAuth, requirePermission('settings.manage'));
  router.get('/', async (req, res) => {
    try {
      const {organizationId, legalEntityId} = req.organizationScope;
      const versions = (await pool.query(`select id,sequence,policy_version,effective_from::text,minimum_increment::text,daily_maximum::text,weekly_maximum::text,comment_required
        from work_capture_policy_versions where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 51`, [organizationId, legalEntityId])).rows;
      const serverDate = (await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
      const starts = (await pool.query(`select starts_on::text from reporting_periods where organization_id=$1 and legal_entity_id=$2 and frequency='Weekly'
        and starts_on>=$3::date and ($4::date is null or starts_on>$4::date) order by starts_on limit 26`, [organizationId, legalEntityId, serverDate, versions[0]?.effective_from || null])).rows;
      res.json({organizationId, legalEntityId, serverDate, latestId: versions[0]?.id || null,
        versions: versions.slice(0, 50).map(capturePolicyView), truncated: versions.length > 50,
        activationDates: starts.map(row => row.starts_on)});
    } catch (error) {
      logError(error); res.status(503).json({error: 'Capture policy is unavailable.', code: 'WORK_CAPTURE_POLICY_UNAVAILABLE'});
    }
  });
  router.post('/', async (req, res) => {
    const parsed = capturePolicyInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({error: 'Check capture policy quantities and effective date.', code: 'WORK_CAPTURE_POLICY_INVALID'}); return; }
    let client, open = false;
    try {
      client = await pool.connect(); await client.query('begin'); open = true;
      await lockWorkPolicy(client, req);
      const {organizationId, legalEntityId} = req.organizationScope;
      const latest = (await client.query('select id,sequence,effective_from::text from work_capture_policy_versions where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1', [organizationId, legalEntityId])).rows[0];
      if ((latest?.id || null) !== parsed.data.expectedLatestId) {
        await client.query('rollback'); open = false;
        res.status(409).json({error: 'The capture policy changed. Reload before appending another version.', code: 'WORK_CAPTURE_POLICY_CONFLICT'}); return;
      }
      const input = parsed.data;
      const row = (await client.query(`insert into work_capture_policy_versions(id,organization_id,legal_entity_id,sequence,policy_version,effective_from,minimum_increment,daily_maximum,weekly_maximum,comment_required,actor_id,active_role,source,correlation_id,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Web',$13,$14) returning *,effective_from::text`,
      [`capture-policy-${randomUUID()}`, organizationId, legalEntityId, Number(latest?.sequence || 0) + 1, CAPTURE_POLICY_VERSION,
        input.effectiveFrom, input.minimumIncrement, input.dailyMaximum, input.weeklyMaximum, input.commentRequired,
        req.user.sub, req.user.activeRole, req.correlationId, req.operationId])).rows[0];
      const result = capturePolicyView(row);
      await audit(client, req, {module: 'Work Capture', action: 'Append Capture Policy', entityType: 'Work Capture Policy', entityId: row.id,
        oldValue: latest || null, newValue: result, details: 'Appended scoped Weekly-boundary capture policy; existing work and evidence remain unchanged.'});
      await client.query('commit'); open = false; res.status(201).json(result);
    } catch (error) {
      if (open) await client.query('rollback').catch(() => {});
      if (['WCR01', 'WCR02', '23505'].includes(error?.code)) res.status(409).json({error: 'Use an available future Weekly period start later than the latest version. Reload before saving.', code: 'WORK_CAPTURE_POLICY_DATE_CONFLICT'});
      else { logError(error); res.status(503).json({error: 'Save could not be confirmed. Reload before trying again.', code: 'WORK_CAPTURE_POLICY_UNAVAILABLE'}); }
    } finally { client?.release(); }
  });
  return router;
};
