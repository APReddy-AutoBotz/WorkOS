import {Router} from 'express';
import {z} from 'zod';
import {PROJECT_CONTRIBUTION_VERSION} from '../../../shared/project-contribution.mjs';
import {validCapacityRange} from '../../../shared/worker-capacity.mjs';
import {validCapabilityDate} from '../../../shared/workforce-capabilities.mjs';
import {calculateScopedProjectContribution} from './project-contribution-service.mjs';
import {listProjectEvidence, projectEvidenceView, readProjectEvidenceRequest, retainProjectEvidence, retrieveProjectArtifact} from './project-contribution-evidence.mjs';

const periodQuery = z.object({startsOn: z.string().refine(validCapabilityDate), endsOn: z.string().refine(validCapabilityDate)}).strict().refine(value => validCapacityRange(value.startsOn, value.endsOn));

export const createProjectContributionRouter = ({pool, requireDatabase, requireAuth, requirePermission, buildProjectScopeWhere, buildEmployeeScopeWhere, audit, logError = error => console.error('Project contribution unavailable', error?.code || 'UNKNOWN')}) => {
  const router = Router();
  router.use(requireDatabase, requireAuth, requirePermission('projects.view'), requirePermission('employees.view'), requirePermission('reports.view_utilization'));
  router.get('/projects/:id/period', async (req, res) => {
    const parsed = periodQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({code: 'PROJECT_CONTRIBUTION_RANGE', error: 'Choose an explicit period of at most366 valid business dates.'});
    let client, begun = false;
    try {
      client = await pool.connect();
      await client.query('begin isolation level repeatable read read only');
      begun = true;
      const report = await calculateScopedProjectContribution(client, req, req.params.id, parsed.data.startsOn, parsed.data.endsOn, {buildProjectScopeWhere, buildEmployeeScopeWhere});
      await client.query('commit');
      begun = false;
      return res.json({contractVersion: PROJECT_CONTRIBUTION_VERSION, organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, project: report.project, workers: report.workers, result: report.result});
    } catch (error) {
      if (begun) await client.query('rollback').catch(() => {});
      if (error.statusCode) return res.status(error.statusCode).json({code: error.code, error: error.message});
      logError(error);
      return res.status(503).json({code: 'PROJECT_CONTRIBUTION_UNAVAILABLE', error: 'Project contribution could not be loaded. Retry explicitly.'});
    } finally { client?.release(); }
  });
  const options = {buildProjectScopeWhere, buildEmployeeScopeWhere, audit};
  const uuid = z.string().uuid();
  const retentionInput = z.object({startsOn: z.string().refine(validCapabilityDate), endsOn: z.string().refine(validCapabilityDate),
    expectedSourceToken: z.string().regex(/^[a-f0-9]{64}$/), requestId: uuid, reason: z.string().trim().min(1).max(1000)}).strict()
    .refine(value => validCapacityRange(value.startsOn, value.endsOn));
  const evidenceHandle = (schema, write, operation, query = false) => async (req, res) => {
    const parsed = schema.safeParse(write ? req.body : query ? req.query : req.params.evidenceId ?? req.params.requestId);
    if (!parsed.success || !write && !query && Object.keys(req.query).length) return res.status(400).json({code: 'PROJECT_EVIDENCE_INVALID', error: 'Use explicit valid report and request fields.'});
    let client, begun = false, lock, discard = false;
    try {
      client = await pool.connect();
      // Acquire before opening the repeatable-read snapshot: an exact concurrent
      // retry must see the committed original instead of creating another row.
      if (write) {
        lock = JSON.stringify(['project-evidence', req.organizationScope, req.params.id, req.user.sub, req.user.activeRole, parsed.data.requestId]);
        await client.query('select pg_advisory_lock(hashtextextended($1,0))', [lock]);
      }
      await client.query('begin isolation level repeatable read'); begun = true;
      const output = await operation(client, req, parsed.data);
      await client.query('commit'); begun = false;
      res.status(output.status ?? 200).json({contractVersion: PROJECT_CONTRIBUTION_VERSION,
        organizationId: req.organizationScope.organizationId, legalEntityId: req.organizationScope.legalEntityId, projectId: req.params.id, ...output.body});
    } catch (error) {
      if (begun) await client.query('rollback').catch(() => {});
      if (error.statusCode) res.status(error.statusCode).json({code: error.code, error: error.message});
      else if (['23505', '40001'].includes(error.code)) res.status(409).json({code: 'PROJECT_EVIDENCE_CONFLICT', error: 'Evidence or authority changed. Reconcile the original request before retrying.'});
      else {logError(error); res.status(503).json({code: 'PROJECT_EVIDENCE_UNCONFIRMED', error: 'The result could not be confirmed. Reconcile the original request before another save.'});}
    } finally {
      if (client && lock) try {await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [lock]);} catch {discard = true;}
      client?.release(discard);
    }
  };
  router.post('/projects/:id/evidence', requirePermission('reports.export'), evidenceHandle(retentionInput, true, async (client, req, input) => {
    const {row, replayed} = await retainProjectEvidence(client, req, input, options);
    return {status: replayed ? 200 : 201, body: {evidence: projectEvidenceView(row), csv: row.artifact_csv, replayed}};
  }));
  const historyQuery = z.object({startsOn: z.string().refine(validCapabilityDate), endsOn: z.string().refine(validCapabilityDate), before: uuid.optional()})
    .strict().refine(value => validCapacityRange(value.startsOn, value.endsOn));
  router.get('/projects/:id/evidence', requirePermission('reports.export'), evidenceHandle(historyQuery, false, async (client, req, input) => {
    return {body: {startsOn: input.startsOn, endsOn: input.endsOn, ...await listProjectEvidence(client, req, input, options)}};
  }, true));
  router.get('/projects/:id/requests/:requestId', requirePermission('reports.export'), evidenceHandle(uuid, false, async (client, req, id) => {
    const row = await readProjectEvidenceRequest(client, req, id, options);
    return {body: {evidence: projectEvidenceView(row)}};
  }));
  router.get('/projects/:id/evidence/:evidenceId/artifact', requirePermission('reports.export'), evidenceHandle(uuid, false, async (client, req, id) => {
    const row = await retrieveProjectArtifact(client, req, id, options);
    return {body: {evidence: projectEvidenceView(row), csv: row.artifact_csv}};
  }));
  return router;
};
