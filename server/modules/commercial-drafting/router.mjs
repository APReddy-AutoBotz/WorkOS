import {lockCommercialLifecycle} from './project-mutation.mjs';
import {lifecycleTransitionSchema,projectBindingSchema,lifecycleQuerySchema} from './lifecycle-contracts.mjs';
import {transitionLifecycle,createGovernedProject,getLifecycleWorkspace,getLifecycleHistory,getClosureReadiness} from './lifecycle-service.mjs';
import {Router} from 'express';
import {CommercialDraftError,createContractSchema,appendContractSchema,createEngagementSchema,createPurchaseOrderSchema,createMilestoneSchema,workspaceQuerySchema} from './contracts.mjs';
import {assertCommercialAuthority,getWorkspace,getContract,createContract,appendContractVersion,createEngagement,createPurchaseOrder,createMilestone} from './service.mjs';

export const createCommercialDraftingRouter = ({pool,requireDatabase,requireAuth,audit,logError=error=>console.error('Commercial drafting request failed',error?.code||'UNKNOWN')}) => {
  if(!pool?.connect || ![requireDatabase,requireAuth,audit,logError].every(value=>typeof value==='function'))throw new TypeError('Commercial drafting requires database, scope guards and transactional audit.');
  const router=Router();
  router.use(requireDatabase,requireAuth);
  const handle=(schema,write,command,permission='commercial.contracts.manage')=>async(req,res)=>{
    const parsed=schema.safeParse(write?req.body:req.query);
    if(!parsed.success){res.status(400).json({error:{code:'COMMERCIAL_INVALID_REQUEST',message:'Commercial input is invalid; check fields, decimal strings and dates.'}});return;}
    let client;let begun=false;
    try{
      client=await pool.connect();
      await client.query(write?'begin':'begin isolation level repeatable read');begun=true;
      if(write && permission==='commercial.lifecycle.manage')await lockCommercialLifecycle(client,req.organizationScope);
      // A mutation also requires view permission, preventing write-only clients
      // from receiving confidential result DTOs through a command response.
      await assertCommercialAuthority(client,req,'commercial.contracts.view');
      if(write)await assertCommercialAuthority(client,req,permission);
      const result=await command(client,req,parsed.data);
      await client.query('commit');begun=false;res.status(write?201:200).json(result);
    }catch(error){
      if(begun)await client.query('rollback').catch(()=>{});
      if(error instanceof CommercialDraftError || ['ORG_SCOPE_DENIED','ORG_SCOPE_UNAVAILABLE'].includes(error?.code)){
        res.status(error.statusCode||403).json({error:{code:error.code,message:error.message}});
      }else if(error?.code==='23505')res.status(409).json({error:{code:'COMMERCIAL_DUPLICATE',message:'This commercial identifier or version already exists in the selected scope.'}});
      else if(['23503','23514','22003','22007'].includes(error?.code))res.status(422).json({error:{code:'COMMERCIAL_CONSTRAINT',message:'The scoped references, dates or decimal values are not valid.'}});
      else{logError(error);res.status(503).json({error:{code:'COMMERCIAL_UNAVAILABLE',message:'Commercial drafts are unavailable. No successful save is confirmed.'}});}
    }finally{client?.release();}
  };
  router.get('/lifecycle/workspace',handle(lifecycleQuerySchema,false,(client,req)=>getLifecycleWorkspace(client,req)));
  router.get('/lifecycle/:type/:id/readiness',handle(lifecycleQuerySchema,false,(client,req)=>getClosureReadiness(client,req,req.params.type,req.params.id)));
  router.get('/lifecycle/:type/:id/history',handle(lifecycleQuerySchema,false,(client,req)=>getLifecycleHistory(client,req,req.params.type,req.params.id)));
  router.post('/lifecycle/:type/:id/transitions',handle(lifecycleTransitionSchema,true,(client,req,data)=>transitionLifecycle(client,req,req.params.type,req.params.id,data,audit),'commercial.lifecycle.manage'));
  router.post('/lifecycle/projects',handle(projectBindingSchema,true,(client,req,data)=>createGovernedProject(client,req,data,audit),'commercial.lifecycle.manage'));
  router.get('/workspace',handle(workspaceQuerySchema,false,(client,req,data)=>getWorkspace(client,req,data)));
  router.get('/contracts/:id',handle(workspaceQuerySchema,false,(client,req)=>getContract(client,req,req.params.id)));
  router.post('/contracts',handle(createContractSchema,true,(client,req,data)=>createContract(client,req,data,audit)));
  router.post('/contracts/:id/versions',handle(appendContractSchema,true,(client,req,data)=>appendContractVersion(client,req,req.params.id,data,audit)));
  router.post('/engagements',handle(createEngagementSchema,true,(client,req,data)=>createEngagement(client,req,data,audit)));
  router.post('/purchase-orders',handle(createPurchaseOrderSchema,true,(client,req,data)=>createPurchaseOrder(client,req,data,audit)));
  router.post('/milestones',handle(createMilestoneSchema,true,(client,req,data)=>createMilestone(client,req,data,audit)));
  return router;
};
