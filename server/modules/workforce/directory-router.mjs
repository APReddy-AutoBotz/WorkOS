import {Router} from 'express';
import {z} from 'zod';
import {directoryId,directorySearch} from '../../../shared/workforce-directory.mjs';
import {readWorkforceDirectory} from './directory-service.mjs';
export const createWorkforceDirectoryRouter=({pool,requireDatabase,requireAuth,requirePermission,buildEmployeeScopeWhere,hasActiveAssignedRole,logError=e=>console.error('Workforce directory read failed',e?.code||'UNKNOWN')})=>{
 if(typeof hasActiveAssignedRole!=='function')throw new TypeError('Directory requires the existing assigned-role guard.');
 const router=Router();router.use(requireDatabase,requireAuth,requirePermission('employees.view'));
 router.get('/',async(req,res)=>{let c,begun=false;try{
  const p=z.object({contractVersion:z.literal('workforce-directory/2').optional(),search:z.string().refine(directorySearch).default(''),parentId:z.string().refine(directoryId).optional(),after:z.string().refine(directoryId).optional(),expectedRosterToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().refine(v=>!v.after||Boolean(v.expectedRosterToken)).safeParse(req.query);
  if(!p.success){res.status(400).json({error:'Use a literal search of at most100 characters and only returned bound continuation fields.',code:'DIRECTORY_INVALID'});return;}
  c=await pool.connect();await c.query('begin isolation level repeatable read read only');begun=true;
  if(!await hasActiveAssignedRole(c,req.user.sub,req.user.activeRole)){await c.query('rollback');begun=false;res.status(403).json({error:'The current account no longer holds this active role. Reload through normal sign-in.',code:'DIRECTORY_ROLE_UNAVAILABLE'});return;}
  const out=await readWorkforceDirectory(c,req,p.data,buildEmployeeScopeWhere);await c.query('commit');begun=false;res.json(out);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});if(!e.statusCode)logError(e);res.status(e.statusCode||503).json({error:e.statusCode?e.message:'The directory could not be confirmed. Reload explicitly.',code:e.statusCode?e.code:'DIRECTORY_UNAVAILABLE'});}finally{c?.release();}});
 return router;
};
