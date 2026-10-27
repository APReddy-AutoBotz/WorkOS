import {Router} from 'express';import {z} from 'zod';
import {validWorkerExitCommand} from '../../../shared/reviewed-worker-exit.mjs';
import {inspectWorkerExit,applyWorkerExit,reconcileWorkerExit} from './exit-service.mjs';
export const createReviewedWorkerExitRouter=o=>{
 if(typeof o.hasActiveAssignedRole!=='function'||typeof o.getEffectivePermissionsForUser!=='function')throw new TypeError('Reviewed exit requires the existing current role and permission contracts.');
 const validateActor=async(c,r)=>{
  const permissions=await o.getEffectivePermissionsForUser(c,r.user.sub,r.user.activeRole),s=r.organizationScope;
  if(!await o.hasActiveAssignedRole(c,r.user.sub,r.user.activeRole)||!['employees.view','employees.manage'].every(k=>permissions.includes(k))||!(await c.query('select 1 from user_organization_scopes where user_id=$1 and organization_id=$2 and legal_entity_id=$3 and active',[r.user.sub,s.organizationId,s.legalEntityId])).rowCount){const e=new Error('Current account, held role, permission or scope is unavailable.');e.statusCode=403;e.code='WORKER_EXIT_ROLE_UNAVAILABLE';throw e;}
 };
 const options={...o,validateActor};
 const router=Router();router.use(o.requireDatabase,o.requireAuth,o.requirePermission('employees.view'),o.requirePermission('employees.manage'));
 const parse=(s,v)=>{const p=s.safeParse(v);if(!p.success){const e=new Error('Use the inspected worker, original key, current token and explicit reason.');e.statusCode=400;e.code='WORKER_EXIT_INVALID';throw e;}return p.data;};
 const handle=(write,fn)=>async(r,res)=>{let c,begun=false;try{c=await o.pool.connect();await c.query(write?'begin':'begin isolation level repeatable read read only');begun=true;
  await validateActor(c,r);
  parse(z.object({}).strict(),r.query);const out=await fn(c,r);await c.query('commit');begun=false;res.status(write&&!out.replayed?201:200).json(out);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});const known=e.statusCode||['WORKER_DEPENDENCY_CONFLICT','WORKER_VERSION_CONFLICT','23505','23514','40001','40P01'].includes(e.code);if(!known)o.logError?.(e);res.status(e.statusCode||(known?409:503)).json({error:e.statusCode?e.message:known?'Canonical lifecycle or dependencies changed. Inspect again.':'Exit could not be confirmed. Read the original receipt before another write.',code:e.statusCode?e.code:known?'WORKER_EXIT_CONFLICT':'WORKER_EXIT_UNCONFIRMED'});}finally{c?.release();}};
 router.get('/workers/:id',handle(false,(c,r)=>inspectWorkerExit(c,r,parse(z.string().min(1).max(200),r.params.id),options)));
 router.get('/commands/:id',handle(false,(c,r)=>reconcileWorkerExit(c,r,parse(z.string().uuid(),r.params.id),options)));
 router.post('/commands',handle(true,(c,r)=>applyWorkerExit(c,r,parse(z.unknown().refine(validWorkerExitCommand),r.body),options)));return router;
};
