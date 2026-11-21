import {getRetainerConsumption} from './retainer-consumption.mjs';
import {fixedFeeRegister,fixedFeeGrant,installmentCommand} from './fixed-fee-eligibility.mjs';
import {purchaseOrderRelease,purchaseOrderBalance,releaseSchema} from './purchase-order-release.mjs';
import {amendmentPreviewSchema,amendmentCommandSchema} from './amendment-contracts.mjs';
import {getAmendmentWorkspace,previewAmendment,appendAmendment} from './amendment-service.mjs';
import {lockCommercialLifecycle} from './project-mutation.mjs';
import {lifecycleTransitionSchema,projectBindingSchema,lifecycleQuerySchema} from './lifecycle-contracts.mjs';
import {transitionLifecycle,createGovernedProject,getLifecycleWorkspace,getLifecycleHistory,getClosureReadiness} from './lifecycle-service.mjs';
import {Router} from 'express';
import {CommercialDraftError,createContractSchema,appendContractSchema,createEngagementSchema,createPurchaseOrderSchema,createMilestoneSchema,workspaceQuerySchema} from './contracts.mjs';
import {assertCommercialAuthority,getWorkspace,getContract,createContract,appendContractVersion,createEngagement,createPurchaseOrder,createMilestone} from './service.mjs';

export const createCommercialDraftingRouter = ({pool,requireDatabase,requireAuth,buildEmployeeScopeWhere,audit,logError=error=>console.error('Commercial drafting request failed',error?.code||'UNKNOWN')}) => {
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
      if(write)await lockCommercialLifecycle(client,req.organizationScope);
      // A mutation also requires view permission, preventing write-only clients
      // from receiving confidential result DTOs through a command response.
      await assertCommercialAuthority(client,req,'commercial.contracts.view');
      if(write)await assertCommercialAuthority(client,req,permission);
      if(write && permission==='commercial.amendments.manage')await assertCommercialAuthority(client,req,'commercial.lifecycle.manage');
      const result=await command(client,req,parsed.data);
      await client.query('commit');begun=false;res.status(write?201:200).json(result);
    }catch(error){
      if(begun)await client.query('rollback').catch(()=>{});
      if(error instanceof CommercialDraftError || ['ORG_SCOPE_DENIED','ORG_SCOPE_UNAVAILABLE'].includes(error?.code)){
        res.status(error.statusCode||403).json({error:{code:error.code,message:error.message}});
      }else if(error?.code==='23505')res.status(409).json({error:{code:'COMMERCIAL_DUPLICATE',message:'This commercial identifier or version already exists in the selected scope.'}});
      else if(error?.code==='23514' && error.constraint==='retainer_periods_valid') res.status(422).json({error:{
        code:'COMMERCIAL_RETAINER_PERIODS_INVALID',message:'Retainer periods need positive included hours and ordered, non-overlapping dates within the contract term.'}});
      else if(error?.code==='23514' && error.constraint==='fixed_fee_installments_valid') res.status(422).json({error:{
        code:'COMMERCIAL_INSTALLMENTS_INVALID',message:'Fixed-fee installments require positive amounts, dates in contract order and an exact match to the contract value.'}});
      else if(['23503','23514','22003','22007'].includes(error?.code))res.status(422).json({error:{code:'COMMERCIAL_CONSTRAINT',message:'The scoped references, dates or decimal values are not valid.'}});
      else{logError(error);res.status(503).json({error:{code:'COMMERCIAL_UNAVAILABLE',message:'Commercial drafts are unavailable. No successful save is confirmed.'}});}
    }finally{client?.release();}
  };
  router.get('/fixed-fee-schedules/:id/register',handle(lifecycleQuerySchema,false,(c,r)=>fixedFeeRegister(c,r,null)));
  router.post('/fixed-fee-schedules/:id/register',handle(installmentCommand,true,(c,r,data)=>fixedFeeRegister(c,r,data,audit),fixedFeeGrant));
  router.get('/amendments/:type/:id',handle(lifecycleQuerySchema,false,(client,req)=>getAmendmentWorkspace(client,req,req.params.type,req.params.id)));
  router.post('/amendments/:type/:id/preview',handle(amendmentPreviewSchema,true,(client,req,data)=>previewAmendment(client,req,req.params.type,req.params.id,data),'commercial.amendments.manage'));
  router.post('/amendments/:type/:id',handle(amendmentCommandSchema,true,(client,req,data)=>appendAmendment(client,req,req.params.type,req.params.id,data,audit),'commercial.amendments.manage'));
  router.get('/lifecycle/workspace',handle(lifecycleQuerySchema,false,(client,req)=>getLifecycleWorkspace(client,req)));
  router.get('/lifecycle/:type/:id/readiness',handle(lifecycleQuerySchema,false,(client,req)=>getClosureReadiness(client,req,req.params.type,req.params.id)));
  router.get('/lifecycle/:type/:id/history',handle(lifecycleQuerySchema,false,(client,req)=>getLifecycleHistory(client,req,req.params.type,req.params.id)));
  router.post('/lifecycle/:type/:id/transitions',handle(lifecycleTransitionSchema,true,(client,req,data)=>transitionLifecycle(client,req,req.params.type,req.params.id,data,audit),'commercial.lifecycle.manage'));
  router.post('/lifecycle/projects',handle(projectBindingSchema,true,(client,req,data)=>createGovernedProject(client,req,data,audit),'commercial.lifecycle.manage'));
  router.get('/workspace',handle(workspaceQuerySchema,false,(client,req,data)=>getWorkspace(client,req,data)));
  router.get('/contracts/:id/versions/:versionId/retainer-consumption',handle(lifecycleQuerySchema,false,
    (client,req)=>getRetainerConsumption(client,req,buildEmployeeScopeWhere)));
  router.get('/contracts/:id',handle(workspaceQuerySchema,false,(client,req)=>getContract(client,req,req.params.id)));
  router.post('/contracts',handle(createContractSchema,true,(client,req,data)=>createContract(client,req,data,audit)));
  router.post('/contracts/:id/versions',handle(appendContractSchema,true,(client,req,data)=>appendContractVersion(client,req,req.params.id,data,audit)));
  router.post('/engagements',handle(createEngagementSchema,true,(client,req,data)=>createEngagement(client,req,data,audit)));
  router.get('/purchase-orders/:id/balance',handle(lifecycleQuerySchema,false,(client,req)=>purchaseOrderBalance(client,req)));
  router.get('/purchase-orders/:id/release',handle(lifecycleQuerySchema,false,(client,req)=>purchaseOrderRelease(client,req,null)));
  router.post('/purchase-orders/:id/release',handle(releaseSchema,true,(client,req,data)=>purchaseOrderRelease(client,req,data,audit),'commercial.purchase_orders.release'));
  router.post('/purchase-orders',handle(createPurchaseOrderSchema,true,(client,req,data)=>createPurchaseOrder(client,req,data,audit)));
  router.post('/milestones',handle(createMilestoneSchema,true,(client,req,data)=>createMilestone(client,req,data,audit)));
  return router;
};
