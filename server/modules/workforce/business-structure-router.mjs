import {Router} from 'express';
import {z} from 'zod';
import {BUSINESS_STRUCTURE_TYPES,validBusinessCommand} from '../../../shared/business-structure.mjs';
import {businessStructureContext,listBusinessStructures,readBusinessStructure,listBusinessParents,readBusinessImpact,readBusinessCommand,applyBusinessCommand} from './business-structure-service.mjs';
export const createBusinessStructureRouter=o=>{
 if(typeof o.hasActiveAssignedRole!=='function')throw new TypeError('Business structure requires current held-role validation.');
 const router=Router(),uuid=z.string().uuid();router.use(o.requireDatabase,o.requireAuth,o.requirePermission('settings.manage'));
 const parse=(schema,value)=>{const parsed=schema.safeParse(value);if(!parsed.success){const e=new Error('Check explicit catalog fields, exact parent/source and current request identifiers.');e.statusCode=400;e.code='BUSINESS_STRUCTURE_INVALID';throw e;}return parsed.data;};
 const handle=(write,fn)=>async(req,res)=>{let c,begun=false;try{
  c=await o.pool.connect();await c.query(write?'begin isolation level read committed':'begin isolation level repeatable read read only');begun=true;
  if(!await o.hasActiveAssignedRole(c,req.user.sub,req.user.activeRole)){await c.query('rollback');begun=false;res.status(403).json({error:'Current account no longer holds this active role.',code:'BUSINESS_STRUCTURE_ROLE_UNAVAILABLE'});return;}
  const result=await fn(c,req);await c.query('commit');begun=false;res.status(write&&!result.replayed?201:200).json(result);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});
  if(e.statusCode)res.status(e.statusCode).json({error:e.message,code:e.code});
  else if(/^BSG0[1-5]$/.test(e.code??'')||['23505','23514','23P01','40001','40P01'].includes(e.code))res.status(409).json({error:'Catalog source, parent or dependency changed. Reconcile the original request and reload current sources.',code:'BUSINESS_STRUCTURE_CONFLICT'});
  else{o.logError?.(e);res.status(503).json({error:'Catalog operation could not be confirmed. Read the original actor-owned receipt before any further write.',code:'BUSINESS_STRUCTURE_UNCONFIRMED'});}
 }finally{c?.release();}};
 router.get('/context',handle(false,(c,r)=>{parse(z.object({}).strict(),r.query);return businessStructureContext(c,r);}));
 router.get('/lineages',handle(false,(c,r)=>{const q=parse(z.object({type:z.enum(BUSINESS_STRUCTURE_TYPES),after:uuid.optional()}).strict(),r.query);return listBusinessStructures(c,r,q.type,q.after??null);}));
 router.get('/parents',handle(false,(c,r)=>{const q=parse(z.object({type:z.enum(BUSINESS_STRUCTURE_TYPES),effectiveFrom:z.string().date(),lineageId:uuid.optional(),after:z.string().min(1).max(200).optional()}).strict(),r.query);return listBusinessParents(c,r,q.type,q.effectiveFrom,q.lineageId??null,q.after??null);}));
 router.get('/lineages/:id',handle(false,(c,r)=>{const q=parse(z.object({before:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),r.query);return readBusinessStructure(c,r,parse(uuid,r.params.id),q.before??null);}));
 router.get('/lineages/:id/impact',handle(false,(c,r)=>{parse(z.object({}).strict(),r.query);return readBusinessImpact(c,r,parse(uuid,r.params.id));}));
 router.get('/commands/:id',handle(false,(c,r)=>{parse(z.object({}).strict(),r.query);return readBusinessCommand(c,r,parse(uuid,r.params.id));}));
 router.post('/commands',handle(true,(c,r)=>{parse(z.object({}).strict(),r.query);return applyBusinessCommand(c,r,parse(z.unknown().refine(validBusinessCommand),r.body),o.audit);}));
 return router;
};
