import {Router} from 'express';
import {z} from 'zod';
import {OWN_WORKSPACE_REQUIRED,ownWorkspaceSelection,ownLeaveCursor,ownBalanceCursor} from '../../../shared/own-workspace.mjs';
import {readOwnWorkspace} from './own-workspace-service.mjs';
export const createOwnWorkspaceRouter=({pool,requireDatabase,requireAuth,requirePermission,buildEmployeeScopeWhere,hasActiveAssignedRole,logError=e=>console.error('Own workspace read failed',e?.code||'UNKNOWN',e?.position||'NONE')})=>{
 if(typeof hasActiveAssignedRole!=='function')throw new TypeError('Own workspace requires the existing current assigned-role guard.');
 const router=Router(),hash=z.string().regex(/^[a-f0-9]{64}$/);
 router.use(requireDatabase,requireAuth,...OWN_WORKSPACE_REQUIRED.map(p=>requirePermission(p)));
 router.get('/',async(req,res)=>{let c,begun=false;try{
  const parsed=z.object({startsOn:z.string(),endsOn:z.string(),beforeLeave:z.string().refine(ownLeaveCursor).optional(),beforeBalance:z.string().refine(ownBalanceCursor).optional(),expectedBindingKey:hash.optional(),expectedSourceToken:hash.optional()}).strict().refine(v=>Boolean(ownWorkspaceSelection(v.startsOn,v.endsOn))&&(!(v.beforeLeave||v.beforeBalance)||Boolean(v.expectedBindingKey&&v.expectedSourceToken))).safeParse(req.query);
  if(!parsed.success){res.status(400).json({error:'Choose explicit dates of at most366 days and bound page cursors.',code:'OWN_WORKSPACE_INVALID'});return;}
  c=await pool.connect();await c.query('begin isolation level repeatable read read only');begun=true;
  if(!await hasActiveAssignedRole(c,req.user.sub,req.user.activeRole)){await c.query('rollback');begun=false;res.status(403).json({error:'The active account no longer holds this role. Reload the session through the normal sign-in process.',code:'OWN_WORKSPACE_ROLE_UNAVAILABLE'});return;}
  const result=await readOwnWorkspace(c,req,parsed.data,buildEmployeeScopeWhere);await c.query('commit');begun=false;res.json(result);
 }catch(e){if(begun)await c.query('rollback').catch(()=>{});if(!e.statusCode)logError(e);res.status(e.statusCode||503).json({error:e.statusCode?e.message:'The own workspace could not be confirmed. Refresh explicitly.',code:e.statusCode?e.code:'OWN_WORKSPACE_READ_UNAVAILABLE'});}finally{c?.release();}});
 return router;
};
