import {assignmentCommand as poRiskAssignments,orderAssignments} from './purchase-order-assignments.mjs';
import {fixedFeeStatement,fixedFeeStatementCommand,fixedFeeStatementGrant,fixedFeeStatementQuery} from './fixed-fee-statement.mjs';
import {fixedFeeProgress,progressCommand,progressGrant,progressQuery} from './fixed-fee-progress.mjs';
import {elapsedPeriodQuery,reconcileElapsedPeriod} from './fixed-fee-elapsed-period.mjs';
import {fixedFeeElapsed,elapsedGrant,elapsedQuery,elapsedCommand} from './fixed-fee-elapsed.mjs';
import {approveFixedFeeTransition,transitionCommand,transitionGrant} from './fixed-fee-transition.mjs';
import {fixedFeeForecast,forecastCommand,forecastQuery,forecastGrant} from './fixed-fee-forecast.mjs';
import {purchaseOrderDeliveryStatus,purchaseOrderRiskPolicy,poRiskConfigureGrant} from './purchase-order-risk-policy.mjs';
import {fixedFeeRiskDeliveryStatus,fixedFeeRiskPolicy,riskConfigureGrant,riskPolicyCommand} from './fixed-fee-risk-notices.mjs';
import {fixedFeeRisk,riskQuery} from './fixed-fee-risk.mjs';
import {fixedFeeCosts,fixedCostCommand,fixedCostGrant} from './fixed-fee-cost.mjs';
import {effortMonth,fixedFeeEffort} from './fixed-fee-effort.mjs';
import {portfolioMargins,portfolioQuery,marginQuery,marginCommand,marginRecordGrant,servicePeriodMargin} from './service-period-margin.mjs';
import {reconcileServiceEffort} from './service-effort-reconciliation.mjs';
import {effortCostCommand,effortCostGrant,serviceEffortCost} from './service-effort-cost.mjs';
import {reviewCommand as serviceReviewCommand,reviewGrant as serviceReviewGrant,reviewServiceUnits} from './service-unit-review.mjs';
import {periodIssueGrant,servicePeriodRegister} from './service-period-eligibility.mjs';
import {serviceIssueGrant,serviceIssueCommand,serviceUnitRegister} from './service-unit-eligibility.mjs';
import {policyGrant,valueGrant,policyCommand,valueCommand,servicePolicy,serviceValue} from './service-unit-valuation.mjs';
import {periodValueCommand,periodValueGrant,servicePeriodValue} from './service-period-valuation.mjs';
import {periodDecision,periodReviewGrant,servicePeriodReview} from './service-period-review.mjs';
import {captureCommand,captureGrant,captureServiceUnits,evidenceQuery,serviceUnitHistory} from './service-unit-evidence.mjs';
import {retainerRegister,retainerIssueGrant,retainerIssueCommand} from './retainer-eligibility.mjs';
import {retainerStatement,statementGrant,statementCommand,statementQuery,reviewGrant,reviewCommand} from './retainer-statement.mjs';
import {retainerAssignments} from './retainer-risk-assignments.mjs';
import {retainerRiskConfigureGrant,retainerRiskPolicy,retainerDeliveryStatus} from './retainer-risk-policy.mjs';
import {retainerRiskQuery,retainerRiskRegister} from './retainer-risk-register.mjs';
import {getRetainerConsumption} from './retainer-consumption.mjs';
import {fixedFeeRegister,fixedFeeGrant,installmentCommand} from './fixed-fee-eligibility.mjs';
import {purchaseOrderRelease,purchaseOrderBalance,purchaseOrderRisks,purchaseOrderRiskQuery,purchaseOrderRiskHistory,purchaseOrderHistoryQuery,releaseSchema} from './purchase-order-release.mjs';
import {amendmentPreviewSchema,amendmentCommandSchema} from './amendment-contracts.mjs';
import {getAmendmentWorkspace,previewAmendment,appendAmendment} from './amendment-service.mjs';
import {commercialLifecycleLockKey,lockCommercialLifecycle} from './project-mutation.mjs';
import {lifecycleTransitionSchema,projectBindingSchema,lifecycleQuerySchema} from './lifecycle-contracts.mjs';
import {transitionLifecycle,createGovernedProject,getLifecycleWorkspace,getLifecycleHistory,getClosureReadiness} from './lifecycle-service.mjs';
import {Router} from 'express';
import {CommercialDraftError,createContractSchema,appendContractSchema,createEngagementSchema,createPurchaseOrderSchema,createMilestoneSchema,workspaceQuerySchema} from './contracts.mjs';
import {assertCommercialAuthority,getWorkspace,getContract,createContract,appendContractVersion,createEngagement,createPurchaseOrder,createMilestone} from './service.mjs';

export const createCommercialDraftingRouter = ({pool,requireDatabase,requireAuth,buildEmployeeScopeWhere,audit,logError=error=>console.error('Commercial drafting request failed',error?.code||'UNKNOWN')}) => {
  if(!pool?.connect || ![requireDatabase,requireAuth,audit,logError].every(value=>typeof value==='function'))throw new TypeError('Commercial drafting requires database, scope guards and transactional audit.');
  const router=Router();
  router.use(requireDatabase,requireAuth);
  const handle=(schema,write,command,permission='commercial.contracts.manage',consistentWrite=false)=>async(req,res)=>{
    const parsed=schema.safeParse(write?req.body:req.query);
    if(!parsed.success){res.status(400).json({error:{code:'COMMERCIAL_INVALID_REQUEST',message:'Commercial input is invalid; check fields, decimal strings and dates.'}});return;}
    const valuationPeriodWrite=write && [progressGrant,elapsedGrant,transitionGrant].includes(permission);
    const periodLocks=[];
    let client;let begun=false;let sessionKey;let discard=false;
    try{
      client=await pool.connect();
      // Establish the repeatable-read snapshot only after prior statement writers have committed.
      if (consistentWrite) {
        sessionKey=commercialLifecycleLockKey(req.organizationScope);
        await client.query('select pg_advisory_lock(hashtextextended($1,0))',[sessionKey]);
      }
      // Acquire calendar-creation locks before taking the repeatable-read snapshot.
      if (valuationPeriodWrite) {
        for (const frequency of ['Fiscal','Monthly','Weekly']) {
          const key='reporting-period:'+req.organizationScope.organizationId+':'+req.organizationScope.legalEntityId+':'+frequency;
          await client.query('select pg_advisory_lock_shared(hashtext($1))',[key]);
          periodLocks.push(key);
        }
      }
      await client.query(write && !consistentWrite?'begin':'begin isolation level repeatable read');begun=true;
      if(write && !consistentWrite)await lockCommercialLifecycle(client,req.organizationScope);
      // A mutation also requires view permission, preventing write-only clients
      // from receiving confidential result DTOs through a command response.
      await assertCommercialAuthority(client,req,'commercial.contracts.view');
      if(write)await assertCommercialAuthority(client,req,permission);
      if(write && permission==='commercial.amendments.manage')await assertCommercialAuthority(client,req,'commercial.lifecycle.manage');
      const result=await command(client,req,parsed.data);
      await client.query('commit');begun=false;res.status(write?201:200).json(result);
    }catch(error){
      if(begun)await client.query('rollback').catch(()=>{});
      if(error instanceof CommercialDraftError || ['ORG_SCOPE_DENIED','ORG_SCOPE_UNAVAILABLE','RATE_AUTHORITY'].includes(error?.code)){
        res.status(error.statusCode||403).json({error:{code:error.code,message:error.message}});
      }else if (['PRA01','RRA01'].includes(error?.code)) res.status(403).json({error:{code:'PO_ASSIGNMENT_DENIED',message:'Current purchase order authority is required.'}});
      else if (['PRA02','RRA02'].includes(error?.code)) res.status(409).json({error:{code:'PO_ASSIGNMENT_INVALID',message:'Review the assignment version and the engagements on this contract.'}});
      else if (['FRN01','PRN01','RRN01'].includes(error?.code)) res.status(403).json({error:{code:'RISK_POLICY_DENIED',message:'Current scoped configuration authority is required.'}});
      else if (['FRN02','FRN03','PRN02','PRN03','RRN02','RRN03'].includes(error?.code)) res.status(409).json({error:{code:'RISK_POLICY_UNAVAILABLE',message:'Review the current recipient relationships, policy version and effective date.'}});
      else if(valuationPeriodWrite && ['CTM04','40001'].includes(error?.code))res.status(409).json({error:{
        code:'FIXED_FEE_PERIOD_UNAVAILABLE',message:'Verify reporting-period coverage and financial locks before recording this value.'}});
      else if(permission===fixedFeeStatementGrant && ['MFS01','40001','23505'].includes(error?.code))res.status(409).json({error:{code:'STATEMENT_CHANGED',message:'Review the locked period and signed versions again.'}});
      else if(error?.code==='MFT01')res.status(409).json({error:{code:'TRANSITION_UNAVAILABLE',message:'Inspect the current transition evidence.'}});
      else if(error?.code==='MGM01')res.status(403).json({error:{code:'MARGIN_DENIED',message:'Current reporting authority is required.'}});
      else if(error?.code==='MGM02')res.status(409).json({error:{code:'MARGIN_CHANGED',message:'Inspect the current period again.'}});
      else if(error?.code==='MEC01')res.status(403).json({error:{code:'SERVICE_COST_DENIED',message:'Current worker cost authority is required.'}});
      else if(error?.code==='MEC02' || ([effortCostGrant,fixedCostGrant].includes(permission) && error?.code==='CTM04'))res.status(409).json({error:{code:'SERVICE_COST_CHANGED',message:'Review accepted effort, the adopted hourly cost and the financial period.'}});
      else if(error?.code==='RBE01')res.status(403).json({error:{code:'RETAINER_REGISTER_DENIED',message:'Current retainer billing authority is required.'}});
      else if(error?.code==='RBE02' || (permission===retainerIssueGrant && error?.code==='CTM04') || error?.constraint==='retainer_period_billed_once')
        res.status(409).json({error:{code:'COMMERCIAL_REGISTER_CONFLICT',message:'Review source eligibility, financial period and existing charges.'}});
      else if(error?.code==='MSU05')res.status(403).json({error:{code:'SERVICE_REVIEW_DENIED',message:'Independent current worker identities are required.'}});
      else if(error?.code==='SBE01')res.status(403).json({error:{code:'SERVICE_BILLING_DENIED',message:'Service billing authority is required.'}});
      else if(error?.code==='SBE02' || ([serviceIssueGrant,periodIssueGrant].includes(permission) && error?.code==='CTM04'))res.status(409).json({error:{code:'SERVICE_BILLING_UNAVAILABLE',message:'Check accepted evidence, billing terms and the issue period.'}});
      else if(error?.code==='MSV01')res.status(403).json({error:{code:'SERVICE_VALUE_DENIED',message:'Current service valuation authority is required.'}});
      else if(error?.code==='MSV02' || ([valueGrant,periodValueGrant].includes(permission) && error?.code==='CTM04'))res.status(409).json({error:{code:'SERVICE_VALUE_UNAVAILABLE',message:'Check effective policy, accepted priced evidence, current identities and financial period.'}});
      else if(error?.code==='MSP01')res.status(409).json({error:{code:'SERVICE_PERIOD_UNAVAILABLE',message:'Review requires a closed period with active terms throughout.'}});
      else if(error?.code==='MSP02')res.status(403).json({error:{code:'SERVICE_PERIOD_DENIED',message:'An independent reviewer with current worker identity is required.'}});
      else if(error?.code==='MSU01')res.status(403).json({error:{code:'SERVICE_UNIT_DENIED',message:'Current service capture permission is required.'}});
      else if(error?.code==='MSU02')res.status(422).json({error:{code:'SERVICE_UNIT_TERMS_INVALID',message:'Check service date, active adopted terms, unit and quantity precision.'}});
      else if(error?.code==='RSR01')res.status(403).json({error:{code:'RETAINER_IDENTITY_DENIED',message:'Current, distinct worker identities are required to review the statement.'}});
      else if(error?.code==='RSR02')res.status(409).json({error:{code:'RETAINER_REVIEW_STALE',message:'Reload the latest retained statement.'}});
      else if(error?.code==='RST01')res.status(403).json({error:{code:'RETAINER_STATEMENT_DENIED',message:'Current statement preparation authority is required.'}});
      else if(error?.code==='RST02' || (consistentWrite && error?.code==='40001'))res.status(409).json({error:{code:'RETAINER_STATEMENT_STALE',message:'Reload and review current statement evidence.'}});
      else if(error?.code==='23505')res.status(409).json({error:{code:'COMMERCIAL_DUPLICATE',message:'This commercial identifier or version already exists in the selected scope.'}});
      else if(error?.code==='23514' && error.constraint==='retainer_rounding_valid') res.status(422).json({error:{
        code:'COMMERCIAL_RETAINER_ROUNDING_INVALID',message:'Retainer rounding requires explicit excess-hour pricing terms.'}});
      else if(error?.code==='23514' && error.constraint==='retainer_overage_policy_valid') res.status(422).json({error:{
        code:'COMMERCIAL_RETAINER_OVERAGE_INVALID',message:'Overage terms require a retainer capacity policy.'}});
      else if(error?.code==='23514' && error.constraint==='retainer_capacity_policy_valid') res.status(422).json({error:{
        code:'COMMERCIAL_RETAINER_POLICY_INVALID',message:'A capacity policy requires a retainer contract with dated service periods.'}});
      else if(error?.code==='23514' && error.constraint==='service_period_charges_valid') res.status(422).json({error:{
        code:'COMMERCIAL_SERVICE_PERIOD_CHARGES_INVALID',message:'Enter positive fixed charges in date order, with non-overlapping periods inside the managed-service contract.'}});
      else if(error?.code==='23514' && error.constraint==='managed_service_dimensions_valid') res.status(422).json({error:{
        code:'COMMERCIAL_SERVICE_DIMENSIONS_INVALID',message:'Managed service units require unique codes, valid labels and supported precision.'}});
      else if(error?.code==='23514' && error.constraint==='retainer_periods_valid') res.status(422).json({error:{
        code:'COMMERCIAL_RETAINER_PERIODS_INVALID',message:'Retainer periods need positive included hours and ordered, non-overlapping dates within the contract term.'}});
      else if(error?.code==='23514' && error.constraint==='fixed_fee_installments_valid') res.status(422).json({error:{
        code:'COMMERCIAL_INSTALLMENTS_INVALID',message:'Fixed-fee installments require positive amounts, dates in contract order and an exact match to the contract value.'}});
      else if(['23503','23514','22003','22007'].includes(error?.code))res.status(422).json({error:{code:'COMMERCIAL_CONSTRAINT',message:'The scoped references, dates or decimal values are not valid.'}});
      else{logError(error);res.status(503).json({error:{code:'COMMERCIAL_UNAVAILABLE',message:'Commercial drafts are unavailable. No successful save is confirmed.'}});}
     }finally{
      for (const key of periodLocks.reverse()) try {
        const unlocked=await client.query('select pg_advisory_unlock_shared(hashtext($1)) as released',[key]);
        if (!unlocked.rows[0]?.released) discard=true;
      } catch {discard=true;}
      if (client && sessionKey) try {
        const unlocked=await client.query('select pg_advisory_unlock(hashtextextended($1,0)) as released',[sessionKey]);
        if (!unlocked.rows[0]?.released) discard=true;
      } catch {discard=true;}
      client?.release(discard);
    }
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
  router.post('/engagements/:id/service-unit-evidence/:evidenceId/review',handle(serviceReviewCommand,true,(c,r,input)=>reviewServiceUnits(c,r,input,audit),serviceReviewGrant));
  const periodValuePath='/engagements/:id/service-period-reviews/:reviewId/valuation';
  router.get(periodValuePath,handle(workspaceQuerySchema,false,(c,r)=>servicePeriodValue(c,r)));
  router.post(periodValuePath,handle(periodValueCommand,true,(c,r,input)=>servicePeriodValue(c,r,input,audit),periodValueGrant));
  const periodBillingPath='/engagements/:id/service-period-reviews/:reviewId/billing';
  router.get(periodBillingPath,handle(workspaceQuerySchema,false,(c,r)=>servicePeriodRegister(c,r)));
  router.post(periodBillingPath,handle(serviceIssueCommand,true,(c,r,input)=>servicePeriodRegister(c,r,input,audit),periodIssueGrant));
  const periodReviewPath='/contracts/:contractId/versions/:versionId/service-periods/:startsOn/review';
  router.get(periodReviewPath,handle(workspaceQuerySchema,false,(c,r)=>servicePeriodReview(c,r)));
  router.post(periodReviewPath,handle(periodDecision,true,(c,r,input)=>servicePeriodReview(c,r,input,audit),periodReviewGrant));
  const serviceRegisterPath='/engagements/:id/service-unit-evidence/:evidenceId/billing';
  router.get(serviceRegisterPath,handle(workspaceQuerySchema,false,(c,r)=>serviceUnitRegister(c,r)));
  router.post(serviceRegisterPath,handle(serviceIssueCommand,true,(c,r,input)=>serviceUnitRegister(c,r,input,audit),serviceIssueGrant));
  const servicePolicyPath='/engagements/:id/service-valuation-policy';
  router.get('/engagements/:id/service-unit-evidence/:evidenceId/reconciliation',handle(workspaceQuerySchema,false,(c,r)=>reconcileServiceEffort(c,r,buildEmployeeScopeWhere)));
  router.get('/engagements/:id/fixed-fee-effort',handle(effortMonth,false,(c,r,input)=>fixedFeeEffort(c,r,input,buildEmployeeScopeWhere)));
  const riskPolicyPath='/engagements/:id/fixed-fee-risk-notice-policy';
  router.get('/engagements/:id/fixed-fee-risk-deliveries',handle(workspaceQuerySchema,false,(c,r)=>fixedFeeRiskDeliveryStatus(c,r)));
  router.get(riskPolicyPath,handle(workspaceQuerySchema,false,(c,r)=>fixedFeeRiskPolicy(c,r)));
  router.post(riskPolicyPath,handle(riskPolicyCommand,true,(c,r,i)=>fixedFeeRiskPolicy(c,r,i,audit),riskConfigureGrant));
  router.get('/engagements/:id/fixed-fee-risk',handle(riskQuery,false,(c,r,i)=>fixedFeeRisk(c,r,i,buildEmployeeScopeWhere)));
  router.get('/engagements/:id/fixed-fee-elapsed-period',handle(elapsedPeriodQuery,false,(c,r,i)=>reconcileElapsedPeriod(c,r,i,buildEmployeeScopeWhere)));
  const progressPath='/engagements/:id/fixed-fee-progress';
  router.get(progressPath,handle(progressQuery,false,(c,r,i)=>fixedFeeProgress(c,r,i,buildEmployeeScopeWhere)));
  router.post(progressPath,handle(progressCommand,true,(c,r,i)=>fixedFeeProgress(c,r,i,buildEmployeeScopeWhere,audit),progressGrant,true));
  const elapsedPath='/engagements/:id/fixed-fee-elapsed';
  router.get(elapsedPath,handle(elapsedQuery,false,(c,r,i)=>fixedFeeElapsed(c,r,i,buildEmployeeScopeWhere)));
  router.post(elapsedPath,handle(elapsedCommand,true,(c,r,i)=>fixedFeeElapsed(c,r,i,buildEmployeeScopeWhere,audit),elapsedGrant,true));
  router.post('/engagements/:id/fixed-fee-transition',handle(transitionCommand,true,(c,r,i)=>approveFixedFeeTransition(c,r,i,buildEmployeeScopeWhere,audit),transitionGrant,true));
  const fixedFeeStatementPath='/engagements/:id/fixed-fee-statement';
  router.get(fixedFeeStatementPath,handle(fixedFeeStatementQuery,false,(c,r,i)=>fixedFeeStatement(c,r,i,buildEmployeeScopeWhere)));
  router.post(fixedFeeStatementPath,handle(fixedFeeStatementCommand,true,(c,r,i)=>fixedFeeStatement(c,r,i,buildEmployeeScopeWhere,audit),fixedFeeStatementGrant,true));
  const forecastPath='/engagements/:id/fixed-fee-forecast';
  router.get(forecastPath,handle(forecastQuery,false,(c,r,i)=>fixedFeeForecast(c,r,i,buildEmployeeScopeWhere)));
  router.post(forecastPath,handle(forecastCommand,true,(c,r,i)=>fixedFeeForecast(c,r,i,buildEmployeeScopeWhere,audit),forecastGrant,true));
  const fixedCostPath='/engagements/:id/fixed-fee-costs';
  router.get(fixedCostPath,handle(effortMonth,false,(c,r,i)=>fixedFeeCosts(c,r,i,buildEmployeeScopeWhere)));
  router.post(fixedCostPath,handle(fixedCostCommand,true,(c,r,i)=>fixedFeeCosts(c,r,i,buildEmployeeScopeWhere,audit),fixedCostGrant));
  router.get('/service-margin-portfolio',handle(portfolioQuery,false,(c,r,q)=>portfolioMargins(c,r,q,buildEmployeeScopeWhere)));
  const marginPath='/engagements/:id/service-period-margin';
  router.get(marginPath,handle(marginQuery,false,(c,r,input)=>servicePeriodMargin(c,r,input,buildEmployeeScopeWhere)));
  router.post(marginPath,handle(marginCommand,true,(c,r,input)=>servicePeriodMargin(c,r,input,buildEmployeeScopeWhere,audit),marginRecordGrant,true));
  const effortCostPath='/engagements/:id/service-unit-evidence/:evidenceId/effort-cost';
  router.get(effortCostPath,handle(workspaceQuerySchema,false,(c,r)=>serviceEffortCost(c,r)));
  router.post(effortCostPath,handle(effortCostCommand,true,(c,r,input)=>serviceEffortCost(c,r,input,audit),effortCostGrant));
  const serviceValuePath='/engagements/:id/service-unit-evidence/:evidenceId/valuation';
  router.get(servicePolicyPath,handle(workspaceQuerySchema,false,(c,r)=>servicePolicy(c,r)));
  router.post(servicePolicyPath,handle(policyCommand,true,(c,r,input)=>servicePolicy(c,r,input,audit),policyGrant));
  router.get(serviceValuePath,handle(workspaceQuerySchema,false,(c,r)=>serviceValue(c,r)));
  router.post(serviceValuePath,handle(valueCommand,true,(c,r,input)=>serviceValue(c,r,input,audit),valueGrant));
  router.get('/engagements/:id/service-unit-evidence',handle(evidenceQuery,false,(c,r,q)=>serviceUnitHistory(c,r,q)));
  router.post('/engagements/:id/service-unit-evidence',handle(captureCommand,true,(c,r,input)=>captureServiceUnits(c,r,input,audit),captureGrant));
  const statementPath='/contracts/:id/versions/:versionId/retainer-statements/:startsOn';
  router.all(statementPath+'/register',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get(statementPath+'/register',handle(lifecycleQuerySchema,false,(c,r)=>retainerRegister(c,r,buildEmployeeScopeWhere)));
  router.post(statementPath+'/register',handle(retainerIssueCommand,true,(c,r,data)=>retainerRegister(c,r,buildEmployeeScopeWhere,data,audit),retainerIssueGrant,true));
  router.all(statementPath+'/review',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get(statementPath+'/review',handle(statementQuery,false,(c,r,q)=>retainerStatement(c,r,buildEmployeeScopeWhere,{query:q,review:true})));
  router.post(statementPath+'/review',handle(reviewCommand,true,(c,r,command)=>retainerStatement(c,r,buildEmployeeScopeWhere,{command,audit,review:true}),reviewGrant,true));
  router.all(statementPath,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get(statementPath,handle(statementQuery,false,(c,r,q)=>retainerStatement(c,r,buildEmployeeScopeWhere,{query:q})));
  router.post(statementPath,handle(statementCommand,true,(c,r,command)=>retainerStatement(c,r,buildEmployeeScopeWhere,{command,audit}),statementGrant,true));
  router.get('/contracts/:id/versions/:versionId/retainer-overage-preview',(req,res,next)=>{res.set('Cache-Control','no-store');next();},handle(lifecycleQuerySchema,false,
    (client,req)=>getRetainerConsumption(client,req,buildEmployeeScopeWhere,true)));
  router.get('/contracts/:id/versions/:versionId/retainer-consumption',handle(lifecycleQuerySchema,false,
    (client,req)=>getRetainerConsumption(client,req,buildEmployeeScopeWhere)));
  router.get('/contracts/:id',handle(workspaceQuerySchema,false,(client,req)=>getContract(client,req,req.params.id)));
  router.post('/contracts',handle(createContractSchema,true,(client,req,data)=>createContract(client,req,data,audit)));
  router.post('/contracts/:id/versions',handle(appendContractSchema,true,(client,req,data)=>appendContractVersion(client,req,req.params.id,data,audit)));
  router.post('/engagements',handle(createEngagementSchema,true,(client,req,data)=>createEngagement(client,req,data,audit)));
  router.get('/purchase-orders/:id/risk-deliveries',handle(workspaceQuerySchema,false,purchaseOrderDeliveryStatus));
  router.get('/purchase-orders/:id/risk-policy',handle(workspaceQuerySchema,false,(c,r)=>purchaseOrderRiskPolicy(c,r)));
  router.post('/purchase-orders/:id/risk-policy',handle(riskPolicyCommand,true,(c,r,i)=>purchaseOrderRiskPolicy(c,r,i,audit),poRiskConfigureGrant));
  router.get('/purchase-orders/:id/risk-assignments',handle(lifecycleQuerySchema,false,(c,r)=>orderAssignments(c,r)));
  router.post('/purchase-orders/:id/risk-assignments',handle(poRiskAssignments,true,(c,r,i)=>orderAssignments(c,r,i,audit),'commercial.purchase_orders.release'));
  router.get('/purchase-orders/:id/risk-history',handle(purchaseOrderHistoryQuery,false,purchaseOrderRiskHistory));
  router.get('/retainer-versions/:id/risk-assignments',handle(lifecycleQuerySchema,false,(c,r)=>retainerAssignments(c,r)));
  router.post('/retainer-versions/:id/risk-assignments',handle(poRiskAssignments,true,(c,r,i)=>retainerAssignments(c,r,i,audit),retainerRiskConfigureGrant));
  router.get('/retainer-versions/:id/risk-deliveries',handle(workspaceQuerySchema,false,retainerDeliveryStatus));
  router.get('/retainer-versions/:id/risk-policy',handle(workspaceQuerySchema,false,(c,r)=>retainerRiskPolicy(c,r)));
  router.post('/retainer-versions/:id/risk-policy',handle(riskPolicyCommand,true,(c,r,i)=>retainerRiskPolicy(c,r,i,audit),retainerRiskConfigureGrant));
  router.get('/retainer-capacity-risks',handle(retainerRiskQuery,false,(c,r,q)=>retainerRiskRegister(c,r,buildEmployeeScopeWhere,q)));
  router.get('/purchase-order-risks',handle(purchaseOrderRiskQuery,false,purchaseOrderRisks));
  router.get('/purchase-orders/:id/balance',handle(lifecycleQuerySchema,false,(client,req)=>purchaseOrderBalance(client,req)));
  router.get('/purchase-orders/:id/release',handle(lifecycleQuerySchema,false,(client,req)=>purchaseOrderRelease(client,req,null)));
  router.post('/purchase-orders/:id/release',handle(releaseSchema,true,(client,req,data)=>purchaseOrderRelease(client,req,data,audit),'commercial.purchase_orders.release'));
  router.post('/purchase-orders',handle(createPurchaseOrderSchema,true,(client,req,data)=>createPurchaseOrder(client,req,data,audit)));
  router.post('/milestones',handle(createMilestoneSchema,true,(client,req,data)=>createMilestone(client,req,data,audit)));
  return router;
};
