import {z} from 'zod';
import {Router} from 'express';
// Explicit supported profile only. No browser/worker timezone or buyer value is inferred.
export const submissionDeadlineInput=z.object({anchor:z.literal('weekly-end-date'),timezone:z.literal('UTC'),daysAfterPeriodEnd:z.number().int().min(0).max(366),time:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),graceMinutes:z.number().int().min(0).max(527040),lateTreatment:z.enum(['warn','block'])}).strict();
export const DEADLINE_OFF={enabled:false};
export const submissionDeadlineRule=value=>{if(value==null)return null;if(value.enabled===false){if(Object.keys(value).join(',')!=='enabled')throw Error('Invalid disabled deadline profile');return null;}return submissionDeadlineInput.parse(value);};
export const readSubmissionTiming=async(client,req,dates)=>{
 const {organizationId,legalEntityId}=req.organizationScope;
 return(await client.query('select work_submission_timing($1,$2,$3::date[]) checks',[organizationId,legalEntityId,[...new Set(dates.map(date=>date instanceof Date?date.toISOString().slice(0,10):String(date).slice(0,10)))].sort()])).rows[0].checks;
};
export const assertSubmissionTiming=checks=>{
 if(checks===null){const error=new Error('Submission timing requires unambiguous Weekly period authority.');error.code='WDL02';throw error;}
 if(checks.some(check=>check.state==='overdue'&&check.lateTreatment==='block')){const error=new Error('The configured submission deadline and grace period have elapsed. Save a Draft or follow the authorized policy process.');error.code='WDL01';throw error;}
};
export const createSubmissionDeadlineRouter=({pool,requireDatabase,requireAuth,requirePermission})=>{
 const router=Router();router.get('/',requireDatabase,requireAuth,requirePermission('timesheets.submit'),async(req,res)=>{
  const parsed=z.string().transform(value=>value.split(',')).pipe(z.array(z.string().date()).min(1).max(101)).safeParse(req.query.dates);
  if(!parsed.success){res.status(400).json({error:'Select valid work-period dates.',code:'WORK_DEADLINE_QUERY_INVALID'});return;}
  try{const checks=await readSubmissionTiming(pool,req,parsed.data);res.json({organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,checks});}
  catch{res.status(503).json({error:'Submission timing is unavailable.',code:'WORK_DEADLINE_UNAVAILABLE'});}
 });return router;
};
