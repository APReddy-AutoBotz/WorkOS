import {Router} from 'express';
import {timesheetReadScope} from './timesheet-read-scope.mjs';
import {canonicalHours} from './work-hours.mjs';
export const WORK_HISTORY_PAGE_SIZE=10;
export const parseHistoryCursor=value=>{
 if(value===undefined)return null;
 if(typeof value!=='string'||! /^(?:[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>2147483647)throw Error('Invalid cursor');
 return Number(value);
};
export const projectHistorySubmission=row=>({
 id:row.id,sequence:row.sequence,createdAt:row.createdAt,activeRole:row.activeRole,source:row.source,
 entries:row.entries.map(entry=>({entryId:entry.entryId,projectId:entry.projectId,workType:entry.workType,workDate:entry.workDate,
  hoursExact:canonicalHours(entry.hours),billable:entry.billable,clientName:entry.clientName,category:entry.category,remark:entry.remark,
  ...(Object.hasOwn(entry,'categoryReference')?{categoryCode:entry.categoryCode,categoryReference:entry.categoryReference}:{}),...(Object.hasOwn(entry,'evidenceUrl')?{evidenceUrl:entry.evidenceUrl}:{}),...(Object.hasOwn(entry,'workReference')?{workReference:entry.workReference}:{}),...(Object.hasOwn(entry,'sourceIdentity')?{sourceIdentity:entry.sourceIdentity}:{})})),
 decision:row.decision,...(row.submissionTiming!=null?{submissionTiming:row.submissionTiming}:{}),
});
export const createWorkHistoryRouter=({pool,requireDatabase,requireAuth,requirePermission,
 logError=error=>console.error('Work history read failed',error?.code||'UNKNOWN')})=>{
 const router=Router();router.use(requireDatabase,requireAuth,requirePermission('timesheets.submit'));
 router.get('/:id/submissions',async(req,res)=>{
  let before;
  try{before=parseHistoryCursor(req.query.beforeSequence);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id))throw Error('Invalid header');}
  catch{res.status(400).json({error:'Work history request is invalid.',code:'WORK_HISTORY_INVALID'});return;}
  try{
   const {params,where}=timesheetReadScope(req);params.push(req.params.id,before);const idParam=params.length-1,cursorParam=params.length;
   const row=(await pool.query(`select t.id,t.employee_id,t.week_ending::text,
    coalesce((select jsonb_agg(page.item order by page.sequence desc) from (
     select w.sequence,jsonb_build_object('id',w.id,'sequence',w.sequence,'createdAt',w.created_at,'activeRole',w.active_role,'source',w.source,'entries',w.entries,'submissionTiming',w.submission_timing,
      'decision',(select jsonb_build_object('status',d.status,'reason',d.reason,'createdAt',d.created_at,'activeRole',d.active_role,'source',d.source)
       from work_submission_decisions d where d.submission_id=w.id)) item
     from work_submission_evidence w where w.timesheet_id=t.id and w.organization_id=t.organization_id and w.legal_entity_id=t.legal_entity_id
      and ($${cursorParam}::int is null or w.sequence<$${cursorParam}) order by w.sequence desc limit ${WORK_HISTORY_PAGE_SIZE+1}
    ) page),'[]'::jsonb) submissions
    from timesheets t join employees e on e.id=t.employee_id ${where} and t.id=$${idParam}::uuid`,params)).rows[0];
   if(!row){res.status(404).json({error:'Work history is unavailable for this work period.',code:'WORK_HISTORY_NOT_FOUND'});return;}
   const more=row.submissions.length>WORK_HISTORY_PAGE_SIZE,submissions=row.submissions.slice(0,WORK_HISTORY_PAGE_SIZE).map(projectHistorySubmission);
   res.json({organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,
    timesheetId:row.id,employeeId:row.employee_id,weekEnding:row.week_ending,submissions,
    nextBeforeSequence:more?submissions.at(-1).sequence:null});
  }catch(error){logError(error);res.status(503).json({error:'Retained work history could not be loaded. Retry for the current work period.',code:'WORK_HISTORY_UNAVAILABLE'});}
 });return router;
};
