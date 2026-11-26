import {z} from 'zod';
import {asyncHandler} from '../api/async-handler.mjs';

const releaseCommand = z.object({
  enabled: z.boolean(),
  evidence: z.string().trim().min(1).max(1000),
  expectedRevision: z.number().int().min(0).max(2147483646),
}).strict();

const releaseFields = 'id, module, revision, enabled, evidence, owner_id, activated_at';

export function releaseEnvironment() {
  const name = process.env.WORKOS_RELEASE_ENVIRONMENT ?? process.env.APP_MODE ?? 'development';
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) throw new Error('Invalid release environment');
  return name;
}

const moduleNames = {teams:'Teams', entra:'Entra administration', planning:'Planning workspace', notifications:'Notification center', leave:'Leave'};

export async function effectiveReleases(client, organizationId) {
  const states = Object.fromEntries(Object.keys(moduleNames).map(module => [module,false]));
  const {rows} = await client.query(`select distinct on (module) module, enabled from module_release_decisions
    where organization_id=$1 and environment=$2 order by module, revision desc`, [organizationId,releaseEnvironment()]);
  for (const row of rows) if (Object.hasOwn(states,row.module)) states[row.module] = row.enabled;
  return states;
}

export async function moduleReleased(client, organizationId, module) {
  if (!organizationId) return false;
  const {rows} = await client.query(`select enabled from module_release_decisions
    where organization_id=$1 and environment=$2 and module=$3 order by revision desc limit 1`,
    [organizationId, releaseEnvironment(), module]);
  return rows[0]?.enabled === true;
}

export function registerModuleReleaseRoutes(router, {pool, requirePermission, audit}) {
  const manage = requirePermission('releases.manage');
  router.get('/module-releases/effective', asyncHandler(async (req,res) => {
    const states = await effectiveReleases(pool,req.organizationScope.organizationId);
    res.set('Cache-Control','no-store').json(states);
  }));
  router.get('/module-releases', manage, asyncHandler(async (req, res) => {
    const environment = releaseEnvironment();
    const {rows} = await pool.query(`select distinct on (module) ${releaseFields}
      from module_release_decisions where organization_id=$1 and environment=$2
      order by module, revision desc`, [req.organizationScope.organizationId, environment]);
    res.set('Cache-Control','no-store').json({environment, decisions: rows});
  }));

  router.put('/module-releases/:module', manage, asyncHandler(async (req, res) => {
    const module = req.params.module;
    if (!Object.hasOwn(moduleNames,module)) return res.status(404).json({error:'Unknown release module'});
    const input = releaseCommand.safeParse(req.body);
    if (!input.success) return res.status(400).json({error:'Supply a state, evidence and the inspected revision'});
    const {enabled, evidence, expectedRevision} = input.data;
    const organizationId = req.organizationScope.organizationId;
    const environment = releaseEnvironment();
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Serialize the first activation as well as later revisions.
      await client.query('select id from organizations where id=$1 for update', [organizationId]);
      const {rows:[previous]} = await client.query(`select ${releaseFields}
        from module_release_decisions where organization_id=$1 and environment=$2 and module=$3
        order by revision desc limit 1`, [organizationId, environment, module]);
      if ((previous?.revision ?? 0) !== expectedRevision) {
        await client.query('rollback');
        if (previous?.revision === expectedRevision + 1 && previous.owner_id === req.user.sub &&
            previous.enabled === enabled && previous.evidence === evidence) return res.json(previous);
        return res.status(409).json({error:'The module release changed. Reload before saving.'});
      }
      const {rows:[decision]} = await client.query(`insert into module_release_decisions
        (organization_id,environment,module,revision,enabled,evidence,owner_id)
        values($1,$2,$3,$4,$5,$6,$7) returning ${releaseFields}`,
        [organizationId, environment, module, expectedRevision+1, enabled, evidence, req.user.sub]);
      await audit(client, req, {module:'Organization Setup', action:'Change module release',
        entityType:'Module release', entityId:decision.id, oldValue:previous ?? null,
        newValue:{...decision,environment}, reason:evidence,
        details:`${moduleNames[module]} release ${enabled ? 'enabled' : 'disabled'} in ${environment}`,
        organizationScope:{organizationId,legalEntityId:null}});
      await client.query('commit');
      return res.status(201).json(decision);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }));
}
