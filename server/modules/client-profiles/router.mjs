import {Router} from 'express';
import {CommercialDraftError} from '../commercial-drafting/contracts.mjs';
import {assertCommercialAuthority} from '../commercial-drafting/service.mjs';
import {clientProfileSchema,billingUnitSchema,billingUnitVersionSchema,profileQuerySchema} from './contracts.mjs';
import {getClientProfilesWorkspace,getClientProfile,getClientProfileHistory,saveClientProfile,createClientBillingUnit,appendClientBillingUnit} from './service.mjs';

export const createClientProfilesRouter=({pool,requireDatabase,requireAuth,audit,logError=error=>console.error('Client profile request failed',error?.code||'UNKNOWN')})=>{
 if(!pool?.connect||![requireDatabase,requireAuth,audit,logError].every(fn=>typeof fn==='function'))throw new TypeError('Client profiles require database, scope guards and transactional audit.');
 const router=Router();router.use(requireDatabase,requireAuth);
 const handle=(schema,write,command)=>async(req,res)=>{
  const parsed=schema.safeParse(write?req.body:req.query);
  if(!parsed.success){res.status(400).json({error:{code:'CLIENT_PROFILE_INVALID_REQUEST',message:'Client profile input is invalid; check required fields, contacts and dates.'}});return;}
  let client,begun=false;
  try{
   client=await pool.connect();await client.query(write?'begin isolation level read committed':'begin isolation level repeatable read');begun=true;
   await assertCommercialAuthority(client,req,'commercial.clients.view');
   if(write)await assertCommercialAuthority(client,req,'commercial.clients.manage');
   const result=await command(client,req,parsed.data);await client.query('commit');begun=false;res.status(write?201:200).json(result);
  }catch(error){
   if(begun)await client.query('rollback').catch(()=>{});
   if(error instanceof CommercialDraftError||['ORG_SCOPE_DENIED','ORG_SCOPE_UNAVAILABLE'].includes(error?.code))res.status(error.statusCode||403).json({error:{code:error.code,message:error.message}});
   else if(error?.code==='23505')res.status(409).json({error:{code:'CLIENT_PROFILE_DUPLICATE',message:'This scoped customer code or version already exists.'}});
   else if(['WCP01','WCP02','WCP03','WCP04'].includes(error?.code))res.status(409).json({error:{code:{WCP01:'CLIENT_PROFILE_VERSION_CONFLICT',WCP02:'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT',WCP03:'CLIENT_PROFILE_PARENT_CYCLE',WCP04:'CLIENT_PROFILE_ISOLATION_CONFLICT'}[error.code],message:'The profile version, effective date or parent relationship conflicts. Reload before saving.'}});
   else if(['23503','23514','22007','22008'].includes(error?.code))res.status(422).json({error:{code:'CLIENT_PROFILE_CONSTRAINT',message:'The scoped customer references, dates or profile fields are not valid.'}});
   else{logError(error);res.status(503).json({error:{code:'CLIENT_PROFILE_UNAVAILABLE',message:'Client profiles are unavailable. No successful save is confirmed.'}});}
  }finally{client?.release();}
 };
 router.get('/workspace',handle(profileQuerySchema,false,(client,req,data)=>getClientProfilesWorkspace(client,req,data)));
 router.get('/clients/:id',handle(profileQuerySchema,false,(client,req,data)=>getClientProfile(client,req,req.params.id,data)));
 router.get('/clients/:id/history',handle(profileQuerySchema,false,(client,req)=>getClientProfileHistory(client,req,req.params.id)));
 router.post('/clients/:id/profiles',handle(clientProfileSchema,true,(client,req,data)=>saveClientProfile(client,req,req.params.id,data,audit)));
 router.post('/clients/:id/billing-units',handle(billingUnitSchema,true,(client,req,data)=>createClientBillingUnit(client,req,req.params.id,data,audit)));
 router.post('/clients/:id/billing-units/:unitId/versions',handle(billingUnitVersionSchema,true,(client,req,data)=>appendClientBillingUnit(client,req,req.params.id,req.params.unitId,data,audit)));
 return router;
};
