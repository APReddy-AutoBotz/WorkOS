import { Router } from 'express';
import { z } from 'zod';

export const MAX_SETUP_ROWS = 200;
export const MAX_DEPENDENCIES = 100;
export const MAX_HISTORY_ROWS = 100;

const catalogTypes = ['business_unit', 'department', 'cost_centre', 'practice', 'location', 'region', 'worker_type'];
const scopeHeaders = request => ({
  organizationId: String(request.headers['x-organization-id'] || '').trim(),
  legalEntityId: String(request.headers['x-legal-entity-id'] || '').trim(),
});

export const resolveOrganizationScope = async (database, request) => {
  const requested = scopeHeaders(request);
  const result = await database.query(`
    select s.organization_id, s.legal_entity_id
    from user_organization_scopes s
    join legal_entities le on le.id=s.legal_entity_id and le.organization_id=s.organization_id
    join organizations o on o.id=s.organization_id
    where s.user_id=$1 and s.active=true and o.status='Active' and le.status='Active'
      and ($2::text='' or s.organization_id=$2)
      and ($3::text='' or s.legal_entity_id=$3)
    order by s.organization_id, s.legal_entity_id limit 2`,
  [request.user.sub, requested.organizationId, requested.legalEntityId]);
  if (result.rows.length !== 1) {
    const error = new Error(result.rows.length ? 'Organization scope is ambiguous' : 'Organization scope is not authorized');
    error.statusCode = 403;
    error.code = 'ORG_SCOPE_DENIED';
    throw error;
  }
  return { organizationId: result.rows[0].organization_id, legalEntityId: result.rows[0].legal_entity_id };
};

const asOfPredicate = (alias, parameter) =>
  `${alias}.effective_from <= ${parameter} and (${alias}.effective_to is null or ${alias}.effective_to >= ${parameter})`;
const dateOnly = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

export const registerOrganizationSetupRoutes = ({ app, pool, requireDatabase, requireAuth, requirePermission, audit }) => {
  const router = Router();
  router.use(requireDatabase, requireAuth, async (req, res, next) => {
    try {
      req.organizationScope = await resolveOrganizationScope(pool, req);
      next();
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, code: error.code || 'ORG_SCOPE_FAILED' });
    }
  });

  router.get('/context', async (req, res) => {
    const { organizationId, legalEntityId } = req.organizationScope;
    const result = await pool.query(`select o.id organization_id,o.code organization_code,o.name organization_name,
      le.id legal_entity_id,le.code legal_entity_code,le.name legal_entity_name
      from organizations o join legal_entities le on le.organization_id=o.id
      where o.id=$1 and le.id=$2`, [organizationId, legalEntityId]);
    res.json(result.rows[0]);
  });

  router.get('/catalogs/:type', async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error: 'Unknown organization catalog' });
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    const result = await pool.query(`select * from organization_catalog_items i where i.organization_id=$1
      and i.catalog_type=$2 and (i.legal_entity_id is null or i.legal_entity_id=$3)
      and ${asOfPredicate('i', '$4')} order by i.name, i.code, i.effective_from desc limit $5`,
    [req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId, asOf, MAX_SETUP_ROWS]);
    res.json(result.rows);
  });

  router.post('/catalogs/:type', requirePermission('settings.manage'), async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error: 'Unknown organization catalog' });
    const parsed = z.object({ code:z.string().trim().min(1).max(50), name:z.string().trim().min(1).max(150),
      parentId:z.string().nullable().optional(), effectiveFrom:z.string().date(), legalEntityId:z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const legalEntityId = parsed.data.legalEntityId || req.organizationScope.legalEntityId;
    if (legalEntityId !== req.organizationScope.legalEntityId) return res.status(403).json({ error:'Legal entity scope is not authorized', code:'LEGAL_SCOPE_DENIED' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))',
        [`${req.organizationScope.organizationId}:${legalEntityId}:${req.params.type}:${parsed.data.code}`]);
      if (parsed.data.parentId) {
        const parent = await client.query(`select 1 from organization_catalog_items where id=$1 and organization_id=$2
          and catalog_type=$3 and active=true and (legal_entity_id is null or legal_entity_id=$4)`,
        [parsed.data.parentId, req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId]);
        if (!parent.rowCount) { await client.query('rollback'); return res.status(409).json({ error:'Parent is unavailable in this scope', code:'INVALID_CATALOG_PARENT' }); }
      }
      const latest = (await client.query(`select effective_from,effective_to from organization_catalog_items
        where organization_id=$1 and catalog_type=$2 and code=$3 and legal_entity_id=$4
        order by effective_from desc limit 1 for update`,
      [req.organizationScope.organizationId, req.params.type, parsed.data.code, legalEntityId])).rows[0];
      if (latest && parsed.data.effectiveFrom <= dateOnly(latest.effective_from)) {
        await client.query('rollback');
        return res.status(409).json({ error:'Catalog versions must be added after the latest version', code:'CATALOG_VERSION_CONFLICT' });
      }
      if (latest?.effective_to && parsed.data.effectiveFrom <= dateOnly(latest.effective_to)) {
        await client.query('rollback');
        return res.status(409).json({ error:'Catalog version overlaps existing history', code:'CATALOG_VERSION_CONFLICT' });
      }
      if (latest?.effective_to == null && latest) {
        await client.query(`update organization_catalog_items set effective_to=$4::date-1,updated_at=now()
          where organization_id=$1 and catalog_type=$2 and code=$3 and legal_entity_id=$5 and effective_to is null`,
        [req.organizationScope.organizationId, req.params.type, parsed.data.code, parsed.data.effectiveFrom, legalEntityId]);
      }
      const result = await client.query(`insert into organization_catalog_items
        (organization_id,legal_entity_id,catalog_type,code,name,parent_id,effective_from)
        values($1,$2,$3,$4,$5,$6,$7) returning *`, [req.organizationScope.organizationId, legalEntityId,
        req.params.type, parsed.data.code, parsed.data.name, parsed.data.parentId || null, parsed.data.effectiveFrom]);
      await audit(client, req, { module:'Organization Setup', action:'Create Catalog Item', entityType:req.params.type,
        entityId:result.rows[0].id, newValue:result.rows[0], details:'Created organization-scoped catalog item' });
      await client.query('commit'); res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('rollback');
      if (['23P01','23505','23514'].includes(error.code)) return res.status(409).json({ error:'Catalog version conflicts with existing history', code:'CATALOG_VERSION_CONFLICT' });
      console.error(error); res.status(500).json({ error:'Catalog item creation failed' });
    } finally { client.release(); }
  });

  router.post('/catalogs/:type/:id/retire', requirePermission('settings.manage'), async (req, res) => {
    if (!catalogTypes.includes(req.params.type)) return res.status(404).json({ error:'Unknown organization catalog' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      const item = (await client.query(`select * from organization_catalog_items where id=$1 and organization_id=$2
        and catalog_type=$3 and (legal_entity_id is null or legal_entity_id=$4) for update`,
      [req.params.id, req.organizationScope.organizationId, req.params.type, req.organizationScope.legalEntityId])).rows[0];
      if (!item) { await client.query('rollback'); return res.status(404).json({ error:'Catalog item not found' }); }
      const dependencies = await client.query(`select 'child' dependency,id from organization_catalog_items
        where parent_id=$1 and active=true and organization_id=$2 and (legal_entity_id is null or legal_entity_id=$3)
        union all select 'worker',employee_id from worker_profiles where worker_type_id=$1 and organization_id=$2
          and legal_entity_id=$3 and lifecycle_status in ('Active','On Leave') limit $4`,
      [item.id, req.organizationScope.organizationId, req.organizationScope.legalEntityId, MAX_DEPENDENCIES + 1]);
      if (dependencies.rows.length) { await client.query('rollback'); return res.status(409).json({ error:'Active dependencies prevent retirement', code:'CATALOG_IN_USE', dependencies:dependencies.rows.slice(0,MAX_DEPENDENCIES), truncated:dependencies.rows.length>MAX_DEPENDENCIES }); }
      const result = await client.query('update organization_catalog_items set active=false,effective_to=coalesce(effective_to,current_date),updated_at=now() where id=$1 returning *',[item.id]);
      await audit(client,req,{module:'Organization Setup',action:'Retire Catalog Item',entityType:req.params.type,entityId:item.id,oldValue:item,newValue:result.rows[0],details:'Retired catalog item after dependency analysis'});
      await client.query('commit'); res.json(result.rows[0]);
    } catch(error) { await client.query('rollback'); console.error(error); res.status(500).json({error:'Catalog retirement failed'}); } finally { client.release(); }
  });

  router.get('/calendars', async (req,res) => {
    const asOf=String(req.query.asOf||new Date().toISOString().slice(0,10));
    const result=await pool.query(`select * from working_calendars c where c.organization_id=$1
      and (c.legal_entity_id is null or c.legal_entity_id=$2) and ${asOfPredicate('c','$3')} order by code limit $4`,
    [req.organizationScope.organizationId,req.organizationScope.legalEntityId,asOf,MAX_SETUP_ROWS]);
    res.json(result.rows);
  });
  router.get('/reporting-periods', async (req,res) => {
    const result=await pool.query(`select * from reporting_periods where organization_id=$1
      and (legal_entity_id is null or legal_entity_id=$2) order by starts_on desc limit $3`,
    [req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_SETUP_ROWS]); res.json(result.rows);
  });
  router.get('/terminology', async (req,res) => {
    const asOf=String(req.query.asOf||new Date().toISOString().slice(0,10));
    const result=await pool.query(`select terms,effective_from,effective_to from terminology_versions t where t.organization_id=$1 and ${asOfPredicate('t','$2')} order by effective_from desc limit 1`,[req.organizationScope.organizationId,asOf]);
    res.json(result.rows[0]||{terms:{}});
  });

  router.get('/readiness', async (req,res) => {
    const org=req.organizationScope.organizationId;
    const facts=await pool.query(`select
      exists(select 1 from organizations where id=$1 and status='Active') organization,
      exists(select 1 from legal_entities where id=$2 and organization_id=$1 and status='Active') legal_entity,
      exists(select 1 from organization_catalog_items where organization_id=$1 and catalog_type='worker_type' and active
        and (legal_entity_id is null or legal_entity_id=$2)) worker_type,
      exists(select 1 from working_calendars where organization_id=$1 and active
        and (legal_entity_id is null or legal_entity_id=$2)) calendar,
      exists(select 1 from reporting_periods where organization_id=$1
        and (legal_entity_id is null or legal_entity_id=$2)) reporting_period`,[org,req.organizationScope.legalEntityId]);
    const checks=facts.rows[0];
    res.json({ organizationId:org, legalEntityId:req.organizationScope.legalEntityId, checks,
      ready:Object.values(checks).every(Boolean), authority:'persisted-server-state' });
  });

  router.get('/workers/:id/dependencies', async (req,res) => {
    const e=(await pool.query('select id from employees where id=$1 and organization_id=$2 and legal_entity_id=$3',
      [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
    if(!e) return res.status(404).json({error:'Worker not found'});
    const result=await pool.query(`select kind,id from (
      select 'active_assignment' kind,a.id from project_allocations a join projects p on p.id=a.project_id and p.organization_id=a.organization_id
        where a.employee_id=$1 and a.status='Active' and p.organization_id=$2 and p.legal_entity_id=$3
      union all select 'pending_approval',id::text from approval_records where subject_employee_id=$1 and status='Pending'
      union all select 'open_work',id::text from timesheets where employee_id=$1 and organization_id=$2 and status in ('Draft','Submitted')
      union all select 'project_owner',id from projects where manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Proposed','Active','On Hold')
      union all select 'direct_report',id from employees where reporting_manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status<>'Exited'
    ) d limit $4`,[req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_DEPENDENCIES+1]);
    res.json({dependencies:result.rows.slice(0,MAX_DEPENDENCIES),truncated:result.rows.length>MAX_DEPENDENCIES});
  });

  router.post('/workers/:id/transition', requirePermission('employees.manage'), async (req,res) => {
    const parsed=z.object({status:z.enum(['Active','On Leave','Disabled','Exited']),effectiveFrom:z.string().date(),reason:z.string().trim().min(1).max(500),idempotencyKey:z.string().trim().min(8).max(100)}).safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:parsed.error.flatten()});
    const client=await pool.connect();
    try {
      await client.query('begin'); await client.query('select pg_advisory_xact_lock(hashtext($1))',[`worker:${req.params.id}`]);
      const worker=(await client.query(`select e.*,wp.lifecycle_status from employees e join worker_profiles wp on wp.employee_id=e.id
        where e.id=$1 and e.organization_id=$2 and e.legal_entity_id=$3 and wp.organization_id=$2 and wp.legal_entity_id=$3 for update`,
      [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0];
      if(!worker){await client.query('rollback');return res.status(404).json({error:'Worker not found'});}
      const replay=await client.query("select snapshot from worker_history where employee_id=$1 and snapshot->>'idempotencyKey'=$2",[worker.id,parsed.data.idempotencyKey]);
      if(replay.rowCount){await client.query('rollback');return res.json({worker:replay.rows[0].snapshot,replayed:true});}
      const latestHistory=(await client.query(`select effective_from from worker_history where employee_id=$1
        and organization_id=$2 order by effective_from desc limit 1 for update`,[worker.id,req.organizationScope.organizationId])).rows[0];
      if(latestHistory && parsed.data.effectiveFrom <= dateOnly(latestHistory.effective_from)) {
        await client.query('rollback');
        return res.status(409).json({error:'Worker transition conflicts with existing history',code:'WORKER_VERSION_CONFLICT'});
      }
      if(['Disabled','Exited'].includes(parsed.data.status)) {
        const deps=await client.query(`select kind,id from (select 'active_assignment' kind,a.id from project_allocations a
          join projects p on p.id=a.project_id and p.organization_id=a.organization_id
          where a.employee_id=$1 and a.status='Active' and p.organization_id=$2 and p.legal_entity_id=$3
          union all select 'pending_approval',id::text from approval_records where subject_employee_id=$1 and status='Pending'
          union all select 'open_work',id::text from timesheets where employee_id=$1 and organization_id=$2 and status in ('Draft','Submitted')
          union all select 'project_owner',id from projects where manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status in ('Proposed','Active','On Hold')
          union all select 'direct_report',id from employees where reporting_manager_id=$1 and organization_id=$2 and legal_entity_id=$3 and status<>'Exited') d limit $4`,
        [worker.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_DEPENDENCIES+1]);
        if(deps.rowCount){await client.query('rollback');return res.status(409).json({error:'Worker has active dependencies',code:'WORKER_DEPENDENCY_CONFLICT',dependencies:deps.rows.slice(0,MAX_DEPENDENCIES),truncated:deps.rows.length>MAX_DEPENDENCIES});}
      }
      await client.query('update worker_history set effective_to=$2::date-1 where employee_id=$1 and effective_to is null',[worker.id,parsed.data.effectiveFrom]);
      const snapshot={status:parsed.data.status,reason:parsed.data.reason,idempotencyKey:parsed.data.idempotencyKey};
      await client.query('insert into worker_history(employee_id,organization_id,effective_from,status,snapshot,actor_id) values($1,$2,$3,$4,$5,$6)',[worker.id,req.organizationScope.organizationId,parsed.data.effectiveFrom,parsed.data.status,JSON.stringify(snapshot),req.user.sub]);
      await client.query('update worker_profiles set lifecycle_status=$2,effective_from=$3,updated_at=now() where employee_id=$1',[worker.id,parsed.data.status,parsed.data.effectiveFrom]);
      await client.query('update employees set status=$2,exit_date=case when $2=\'Exited\' then $3 else exit_date end,updated_at=now() where id=$1',[worker.id,parsed.data.status==='Disabled'?'Exited':parsed.data.status,parsed.data.effectiveFrom]);
      await audit(client,req,{module:'Workforce',action:'Worker Lifecycle Transition',entityType:'Employee',entityId:worker.id,oldValue:{status:worker.lifecycle_status},newValue:snapshot,reason:parsed.data.reason,details:'Applied dependency-safe worker transition'});
      await client.query('commit');res.json({worker:snapshot,replayed:false});
    } catch(error){await client.query('rollback');if(['23P01','23505','23514'].includes(error.code))return res.status(409).json({error:'Worker transition conflicts with existing history',code:'WORKER_VERSION_CONFLICT'});console.error(error);res.status(500).json({error:'Worker transition failed'});}finally{client.release();}
  });

  router.get('/workers/:id/history', async(req,res)=>{const result=await pool.query(`select h.* from worker_history h
    join employees e on e.id=h.employee_id and e.organization_id=h.organization_id
    where h.employee_id=$1 and h.organization_id=$2 and e.legal_entity_id=$3 order by h.effective_from desc limit $4`,
  [req.params.id,req.organizationScope.organizationId,req.organizationScope.legalEntityId,MAX_HISTORY_ROWS]);res.json(result.rows);});
  app.use('/api/organization-setup',router);
};
