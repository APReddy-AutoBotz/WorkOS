import {randomUUID} from 'node:crypto';
import {calculateWorkerCapacity} from '../planning/capacity-resolver.mjs';
import {scopedCapacityWorker,loadCapacitySources,capacityCanonical,capacityHash,capacityFailure} from '../planning/worker-capacity-service.mjs';
import {CALENDAR_LEAVE_VERSION,calculateCalendarLeave} from '../../../shared/calendar-leave.mjs';
import {validCapacityRange} from '../../../shared/worker-capacity.mjs';
const iso=v=>typeof v==='string'?v.slice(0,10):v.toISOString().slice(0,10);
export const calendarLeaveError=(res,e)=>{if(typeof e.code==='string'&&e.code.startsWith('CALENDAR_LEAVE_')){res.status(e.statusCode||422).json({error:e.message,code:e.code});return true;}return false;};
export const quoteCalendarLeave=async(c,req,id,from,to,scope,legacyDays,lock=false)=>{
 if(!validCapacityRange(from,to)||from.slice(0,4)!==to.slice(0,4))capacityFailure('CALENDAR_LEAVE_RANGE','Choose at most366 valid dates in one calendar year.',400);
 const employee=await scopedCapacityWorker(c,req,id,scope,lock),sources=await loadCapacitySources(c,req,employee,from,to);
 if(req.user.activeRole==='Employee'&&employee.id!==req.user.employeeRecordId&&employee.code!==req.user.employeeId)capacityFailure('CALENDAR_LEAVE_OWN','Employees can quote leave only for themselves.',403);
 let quote,input;
 if(!sources.profiles.length){const e=(await c.query('select * from employees where id=$1',[employee.id])).rows[0],total=await legacyDays(c,from,to,e),holidays=(await c.query("select h.*,c.status,c.country from holidays h join holiday_calendars c on c.id=h.calendar_id where c.status='Active'and(lower(c.country)=lower($1)or lower(c.country)='global')and h.holiday_date between $2::date and $3::date order by h.id",[e.country||'Global',from,to])).rows;quote={calculationVersion:CALENDAR_LEAVE_VERSION,employeeId:id,startsOn:from,endsOn:to,mode:'legacy',status:'available',totalDaysExact:String(total),days:[],reasonCodes:['LEGACY_INTAKE_COMPATIBILITY']};input={version:CALENDAR_LEAVE_VERSION,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,employeeId:id,startsOn:from,endsOn:to,mode:'legacy',country:e.country,holidays,totalDaysExact:String(total)};}
 else{const calendarSources={...sources,approvedAbsences:[]};quote=calculateCalendarLeave(calculateWorkerCapacity(calendarSources,from,to));input={version:CALENDAR_LEAVE_VERSION,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,employeeId:id,startsOn:from,endsOn:to,mode:'calendar',sources:calendarSources};}
 const inputCanonical=capacityCanonical(input);return{quote:{...quote,sourceToken:capacityHash(inputCanonical)},inputCanonical};
};
export const requireCalendarLeaveQuote=(computed,expected)=>{if(expected&&computed.quote.sourceToken!==expected)capacityFailure('CALENDAR_LEAVE_CHANGED','Calendar or schedule changed. Requote your leave dates before saving.',409);if(computed.quote.status!=='available')capacityFailure('CALENDAR_LEAVE_UNAVAILABLE','Calendar leave authority is unavailable: '+computed.quote.reasonCodes.join(', '));return Number(computed.quote.totalDaysExact);};
export const retainCalendarLeave=async(c,req,row,computed)=>{
 if(computed.quote.mode==='legacy'){await c.query('update leave_requests set calendar_evidence_id=null where id=$1',[row.id]);return{...row,calendar_evidence_id:null,calendar_quote:null,calendar_scope:{organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId}};}
 const id=randomUUID(),{organizationId,legalEntityId}=req.organizationScope,sequence=(await c.query('select coalesce(max(sequence),0)+1 n from leave_calendar_evidence where request_id=$1',[row.id])).rows[0].n;
 await c.query("select set_config('workos.calendar_leave_context',$1,true)",[JSON.stringify({actorId:req.user.sub,activeRole:req.user.activeRole,organizationId,legalEntityId,employeeId:row.employee_id})]);
 await c.query("insert into leave_calendar_evidence(id,organization_id,legal_entity_id,employee_id,request_id,sequence,starts_on,ends_on,total_days,input_canonical,source_token,quote,actor_id,active_role,source)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Web')",[id,organizationId,legalEntityId,row.employee_id,row.id,sequence,computed.quote.startsOn,computed.quote.endsOn,computed.quote.totalDaysExact,computed.inputCanonical,computed.quote.sourceToken,JSON.stringify(computed.quote),req.user.sub,req.user.activeRole]);
 await c.query('update leave_requests set calendar_evidence_id=$2 where id=$1',[row.id,id]);return{...row,calendar_evidence_id:id,calendar_quote:computed.quote,calendar_scope:{organizationId,legalEntityId}};
};
export const assertCalendarLeaveDecision=async(c,req,row,status,scope,legacyDays)=>{
 if(status!=='Approved'||!row.calendar_evidence_id)return;
 const prior=(await c.query('select * from leave_calendar_evidence where id=$1 and request_id=$2',[row.calendar_evidence_id,row.id])).rows[0];if(!prior)capacityFailure('CALENDAR_LEAVE_EVIDENCE_UNAVAILABLE','Retained calendar leave evidence is unavailable.');
 const current=await quoteCalendarLeave(c,req,row.employee_id,iso(row.start_date),iso(row.end_date),scope,legacyDays,true);requireCalendarLeaveQuote(current,prior.source_token);if(current.quote.totalDaysExact!==String(Number(row.total_days)))capacityFailure('CALENDAR_LEAVE_CHANGED','Leave quantity changed. Requote before approval.',409);
};
