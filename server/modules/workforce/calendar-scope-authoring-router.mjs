import {Router} from 'express';
import {z} from 'zod';
import {validCalendarScopeCommand} from '../../../shared/calendar-scope-authoring.mjs';
import {calendarScopeContext,listScopedCalendars,listCalendarAuthorities,readScopedCalendar,readScopedCalendarCommand,appendScopedCalendar} from './calendar-scope-authoring-service.mjs';
export const createCalendarScopeAuthoringRouter=o=>{
 if(typeof o.hasActiveAssignedRole!=='function')throw new TypeError('Calendar authoring requires current held-role validation.');
 const router=Router(),uuid=z.string().uuid();router.use(o.requireDatabase,o.requireAuth,o.requirePermission('settings.manage'));
 const handle=(write,fn)=>async(req,res)=>{let c,begun=false;try{c=await o.pool.connect();await c.query(write?'begin isolation level read committed':'begin isolation level repeatable read read only');begun=true;if(!await o.hasActiveAssignedRole(c,req.user.sub,req.user.activeRole)){await c.query('rollback');begun=false;res.status(403).json({error:'Current account no longer holds this active role. Reload through normal sign-in.',code:'CALENDAR_SCOPE_ROLE_UNAVAILABLE'});return;}
  const result=await fn(c,req);await c.query('commit');begun=false;res.status(write&&!result.replayed?201:200).json(result);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});if(e.statusCode)res.status(e.statusCode).json({error:e.message,code:e.code});else if(['SCA01','SCA02','SCA03','SCA04','SCA05','23505','23P01','40001','40P01'].includes(e.code))res.status(409).json({error:'Calendar source, authority or exact command changed. Reconcile the original request and reload history before another command.',code:'CALENDAR_SCOPE_CONFLICT'});else{o.logError?.(e);res.status(503).json({error:'Calendar operation could not be confirmed. Read the original request receipt before retrying; do not create a replacement key.',code:'CALENDAR_SCOPE_UNCONFIRMED'});}}finally{c?.release();}};
 const parse=(schema,value)=>{const v=schema.safeParse(value);if(!v.success){const e=new Error('Check explicit calendar fields, complete holiday list and bound request/source identifiers.');e.statusCode=400;e.code='CALENDAR_SCOPE_INVALID';throw e;}return v.data;};
 router.get('/context',handle(false,(c,req)=>{parse(z.object({}).strict(),req.query);return calendarScopeContext(c,req);}));
 router.get('/lineages',handle(false,(c,req)=>{const q=parse(z.object({type:z.enum(['country','worker_group']),after:uuid.optional()}).strict(),req.query);return listScopedCalendars(c,req,q.type,q.after??null);}));
 router.get('/authorities',handle(false,(c,req)=>{const q=parse(z.object({type:z.enum(['country','worker_group']),effectiveFrom:z.string().date(),after:z.string().min(1).max(200).optional()}).strict(),req.query);return listCalendarAuthorities(c,req,q.type,q.effectiveFrom,q.after??null);}));
 router.get('/lineages/:id',handle(false,(c,req)=>{const id=parse(uuid,req.params.id),q=parse(z.object({before:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),req.query);return readScopedCalendar(c,req,id,q.before??null);}));
 router.get('/commands/:id',handle(false,(c,req)=>{parse(z.object({}).strict(),req.query);return readScopedCalendarCommand(c,req,parse(uuid,req.params.id));}));
 router.post('/commands',handle(true,(c,req)=>{parse(z.object({}).strict(),req.query);return appendScopedCalendar(c,req,parse(z.unknown().refine(validCalendarScopeCommand),req.body),o.audit);}));
 return router;
};
