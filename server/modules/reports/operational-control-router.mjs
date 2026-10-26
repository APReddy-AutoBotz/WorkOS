import {Router} from 'express';
import {z} from 'zod';
import {OPERATIONAL_REQUIRED,operationalSelection} from '../../../shared/operational-control.mjs';
import {validCapabilityDate} from '../../../shared/workforce-capabilities.mjs';
import {capacityFailure} from '../planning/worker-capacity-service.mjs';
import {calculateOperationalControl} from './operational-control-service.mjs';
const hash=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().refine(validCapabilityDate);
export const createOperationalControlRouter=o=>{
 const router=Router();router.use(o.requireDatabase,o.requireAuth,...OPERATIONAL_REQUIRED.map(p=>o.requirePermission(p)));
 router.get('/snapshot',async(req,res)=>{let c,begun=false;try{
  const parsed=z.object({startsOn:date,endsOn:date,forecastStartsOn:date,months:z.coerce.number().int().min(1).max(3),after:z.string().trim().min(1).max(200).optional(),expectedRosterToken:hash.optional()}).strict().refine(v=>Boolean(v.after)===Boolean(v.expectedRosterToken)).safeParse(req.query);
  if(!parsed.success)capacityFailure('OPERATIONAL_INVALID','Choose explicit actual dates and forecast horizon; use only the returned continuation.',400);
  const q=parsed.data;let selection;try{selection=operationalSelection(q.startsOn,q.endsOn,q.forecastStartsOn,q.months);}catch{capacityFailure('OPERATIONAL_INVALID','Actual period or forecast horizon is invalid.',400);}
  c=await o.pool.connect();await c.query('begin isolation level repeatable read read only');begun=true;const result=await calculateOperationalControl(c,req,selection,q.after??null,q.expectedRosterToken??null,o);await c.query('commit');begun=false;res.json(result);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});if(e.statusCode)res.status(e.statusCode).json({error:e.message,code:e.code});else{o.logError?.(e);res.status(503).json({error:'Operational snapshot could not be confirmed. Refresh explicitly.',code:'OPERATIONAL_UNAVAILABLE'});}}finally{c?.release();}});
 return router;
};
