import {Router} from 'express';
import {z} from 'zod';
import {validCalendarCommand} from '../../../shared/calendar-authoring.mjs';
import {calendarAuthoringContext,listAuthoredCalendars,readAuthoredCalendar,readCalendarCommand,appendAuthoredCalendar} from './calendar-authoring-service.mjs';
export const createCalendarAuthoringRouter=o=>{
 if(typeof o.hasActiveAssignedRole!=='function')throw new TypeError('Calendar authoring requires current held-role validation.');
 const router=Router(),uuid=z.string().uuid();router.use(o.requireDatabase,o.requireAuth,o.requirePermission('settings.manage'));
 const handle=(write,fn)=>async(req,res)=>{let c,begun=false;try{c=await o.pool.connect();await c.query(write?'begin':'begin isolation level repeatable read read only');begun=true;if(!await o.hasActiveAssignedRole(c,req.user.sub,req.user.activeRole)){await c.query('rollback');begun=false;res.status(403).json({error:'Current account no longer holds this active role. Reload through normal sign-in.',code:'CALENDAR_AUTHORING_ROLE_UNAVAILABLE'});return;}
  const result=await fn(c,req);await c.query('commit');begun=false;res.status(write&&!result.replayed?201:200).json(result);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});if(e.statusCode)res.status(e.statusCode).json({error:e.message,code:e.code});else if(['GCA01','GCA02','GCA03','GCA04','GCA05','23505','23P01','40001','40P01'].includes(e.code))res.status(409).json({error:'Calendar source, authority or exact command changed. Reconcile the original request and reload history before another command.',code:'CALENDAR_AUTHORING_CONFLICT'});else{o.logError?.(e);res.status(503).json({error:'Calendar operation could not be confirmed. Read the original request receipt before retrying; do not create a replacement key.',code:'CALENDAR_AUTHORING_UNCONFIRMED'});}}finally{c?.release();}};
 const parse=(schema,value)=>{const v=schema.safeParse(value);if(!v.success){const e=new Error('Check explicit calendar fields, complete holiday list and bound request/source identifiers.');e.statusCode=400;e.code='CALENDAR_AUTHORING_INVALID';throw e;}return v.data;};
 router.get('/context',handle(false,(c,req)=>{parse(z.object({}).strict(),req.query);return calendarAuthoringContext(c,req);}));
 router.get('/lineages',handle(false,(c,req)=>{const q=parse(z.object({after:uuid.optional()}).strict(),req.query);return listAuthoredCalendars(c,req,q.after??null);}));
 router.get('/lineages/:id',handle(false,(c,req)=>{const id=parse(uuid,req.params.id),q=parse(z.object({before:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),req.query);return readAuthoredCalendar(c,req,id,q.before??null);}));
 router.get('/commands/:id',handle(false,(c,req)=>{parse(z.object({}).strict(),req.query);return readCalendarCommand(c,req,parse(uuid,req.params.id));}));
 router.post('/commands',handle(true,(c,req)=>{parse(z.object({}).strict(),req.query);return appendAuthoredCalendar(c,req,parse(z.unknown().refine(validCalendarCommand),req.body),o.audit);}));
 return router;
};
