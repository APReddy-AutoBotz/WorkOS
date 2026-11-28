import {createHash} from 'node:crypto';
import {WORKER_CAPACITY_VERSION,validCapacityRange} from '../../../shared/worker-capacity.mjs';
import {calculateWorkerCapacity} from './capacity-resolver.mjs';
const maxSources=1000;
export const capacityCanonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const capacityHash=value=>createHash('sha256').update(typeof value==='string'?value:capacityCanonical(value)).digest('hex');
export const capacityFailure=(code,message,statusCode=422)=>{const e=new Error(message);e.code=code;e.statusCode=statusCode;throw e;};
export const scopedCapacityWorker=async(client,req,id,buildEmployeeScopeWhere,lock=false)=>{
 const params=[],where=buildEmployeeScopeWhere(req,params,'e');params.push(id);const w=(await client.query(`select e.id,e.employee_id code,e.name,e.status,e.legal_entity_id "legalEntityId",to_char(e.joining_date,'YYYY-MM-DD') "joiningDate",to_char(e.exit_date,'YYYY-MM-DD') "exitDate",trim_scale(e.standard_weekly_hours)::text "legacyWeeklyHoursExact",e.utilization_eligible "legacyUtilizationEligible" from employees e where ${where} and e.id=$${params.length} ${lock?'for update of e':''}`,params)).rows[0];if(!w)capacityFailure('WORKER_CAPACITY_NOT_FOUND','Worker capacity is unavailable in this scope.',404);return w;
};
export const capacityProfileView=p=>p&&({id:p.id,sequence:p.sequence,effectiveFrom:p.effectiveFrom,definition:p.definition,weeklyHoursExact:p.weeklyHoursExact,createdAt:p.createdAt,activeRole:p.activeRole,source:p.source,reason:p.reason});
export const loadCapacityProfiles=async(client,req,id)=> (await client.query(`select id,sequence,to_char(effective_from,'YYYY-MM-DD') "effectiveFrom",definition,trim_scale(weekly_hours)::text "weeklyHoursExact",created_at "createdAt",active_role "activeRole",source,reason from worker_capacity_versions where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 order by sequence limit ${maxSources+1}`,[req.organizationScope.organizationId,req.organizationScope.legalEntityId,id])).rows;
// The caller supplies workers already selected in its employee and legal-entity scope.
export async function loadCapacitySourceBatch(client,req,workers,startsOn,endsOn) {
 const {organizationId,legalEntityId}=req.organizationScope;
 const params=[organizationId,legalEntityId,workers.map(worker=>worker.id)];
 const perWorker=async (query,sourceOrder,values=params)=>{
   const {rows}=await client.query(`select w.id as worker_key, source.* from unnest($3::text[]) w(id)
     cross join lateral (${query} limit ${maxSources+1}) source order by w.id, ${sourceOrder}`,values);
   const groups=new Map();
   for(const {worker_key,...row} of rows){
     if(!groups.has(worker_key))groups.set(worker_key,[]);
     groups.get(worker_key).push(row);
   }
   return groups;
 };
 const calendars=(await client.query(`select c.id,c.code,c.timezone,c.applicability_type "applicabilityType",c.legal_entity_id "legalEntityId",c.country_code "countryCode",c.country_authority_legal_entity_id "countryAuthorityLegalEntityId",c.worker_group_id "workerGroupId",c.working_days "workingDays",trim_scale(c.hours_per_day)::text "hoursPerDayExact",to_char(c.effective_from,'YYYY-MM-DD') "effectiveFrom",to_char(c.effective_to,'YYYY-MM-DD') "effectiveTo",c.active from working_calendars c left join organization_catalog_items g on g.id=c.worker_group_id and g.organization_id=c.organization_id where c.organization_id=$1 and ((c.applicability_type='legal_entity' and c.legal_entity_id=$2) or(c.applicability_type='worker_group' and (g.legal_entity_id is null or g.legal_entity_id=$2)) or(c.applicability_type='country' and c.country_code in(select p.country_code from legal_entity_profile_versions p where p.organization_id=$1 and p.legal_entity_id=$2))) order by c.id limit ${maxSources+1}`,[organizationId,legalEntityId])).rows;
 const groups=(await client.query(`select id,catalog_type "catalogType",legal_entity_id "legalEntityId",active,to_char(effective_from,'YYYY-MM-DD') "effectiveFrom",to_char(effective_to,'YYYY-MM-DD') "effectiveTo" from organization_catalog_items where organization_id=$1 and catalog_type='business_unit' and (legal_entity_id is null or legal_entity_id=$2) order by id limit ${maxSources+1}`,[organizationId,legalEntityId])).rows;
 const authorityIds=[...new Set([legalEntityId,...calendars.map(c=>c.countryAuthorityLegalEntityId)].filter(Boolean))];
 const legalAuthorities=(await client.query(`select p.id::text id,p.legal_entity_id "legalEntityId",p.country_code "countryCode",p.status,to_char(p.effective_from,'YYYY-MM-DD') "effectiveFrom",to_char(p.effective_to,'YYYY-MM-DD') "effectiveTo",to_char(p.authority_effective_to,'YYYY-MM-DD') "authorityEffectiveTo",to_char(e.effective_from,'YYYY-MM-DD') "legalEntityEffectiveFrom" from legal_entity_profile_versions p join legal_entities e on e.id=p.legal_entity_id and e.organization_id=p.organization_id where p.organization_id=$1 and p.legal_entity_id=any($2::text[]) order by p.id limit ${maxSources+1}`,[organizationId,authorityIds])).rows;
 const holidays=calendars.length?(await client.query(`select id,calendar_id "calendarId",to_char(holiday_date,'YYYY-MM-DD') "holidayDate",active,to_char(effective_from,'YYYY-MM-DD') "effectiveFrom",to_char(effective_to,'YYYY-MM-DD') "effectiveTo" from working_calendar_holidays where organization_id=$1 and calendar_id=any($2::text[]) and holiday_date between $3::date and $4::date order by id limit ${maxSources+1}`,[organizationId,calendars.map(c=>c.id),startsOn,endsOn])).rows:[];
 const profilesByWorker=await perWorker(`select id,sequence,to_char(effective_from,'YYYY-MM-DD') "effectiveFrom",definition,trim_scale(weekly_hours)::text "weeklyHoursExact" from worker_capacity_versions where organization_id=$1 and legal_entity_id=$2 and employee_id=w.id order by sequence`,'source.sequence');
 const histories=await perWorker(`select id::text id,status,to_char(effective_from,'YYYY-MM-DD') "effectiveFrom",to_char(effective_to,'YYYY-MM-DD') "effectiveTo" from worker_history where employee_id=w.id and organization_id=$1 and legal_entity_id=$2 order by effective_from`,'source."effectiveFrom", source.id');
 const absences=await perWorker(`select lr.id,lr.employee_id "employeeId",lr.calendar_evidence_id "calendarEvidenceId",ce.quote "calendarQuote",to_char(lr.start_date,'YYYY-MM-DD') "startsOn",to_char(lr.end_date,'YYYY-MM-DD') "endsOn",trim_scale(lr.total_days)::text "totalDaysExact",to_char(lr.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') revision from leave_requests lr left join leave_calendar_evidence ce on ce.id=lr.calendar_evidence_id and ce.request_id=lr.id and ce.employee_id=lr.employee_id where lr.employee_id=w.id and lr.status='Approved' and lr.start_date<=$5::date and lr.end_date>=$4::date and exists (select 1 from employees e where e.id=w.id and e.organization_id=$1 and e.legal_entity_id=$2) order by lr.id`,'source.id',[...params,startsOn,endsOn]);
 return new Map(workers.map(worker=>{
   const allProfiles=profilesByWorker.get(worker.id)??[];
   const profiles=allProfiles.filter(p=>p.effectiveFrom<=endsOn);
   const workerHistory=histories.get(worker.id)??[],approvedAbsences=absences.get(worker.id)??[];
   const limited=[allProfiles,calendars,groups,legalAuthorities,workerHistory,holidays,approvedAbsences].some(rows=>rows.length>maxSources);
   return [worker.id,{worker:{id:worker.id,legalEntityId:worker.legalEntityId,status:worker.status,joiningDate:worker.joiningDate,exitDate:worker.exitDate},profiles,calendars,groups,legalAuthorities,workerHistory,holidays,approvedAbsences,limitExceeded:limited}];
 }));
}
export const loadCapacitySources=async(client,req,worker,startsOn,endsOn)=>
 (await loadCapacitySourceBatch(client,req,[worker],startsOn,endsOn)).get(worker.id);
export const calculateScopedCapacity=async(client,req,workerId,startsOn,endsOn,buildEmployeeScopeWhere)=>{
 const worker=await scopedCapacityWorker(client,req,workerId,buildEmployeeScopeWhere);if(!validCapacityRange(startsOn,endsOn))capacityFailure('WORKER_CAPACITY_RANGE_INVALID','Choose at most366 valid business dates.',400);
 const sources=await loadCapacitySources(client,req,worker,startsOn,endsOn),result=calculateWorkerCapacity(sources,startsOn,endsOn),inputCanonical=capacityCanonical({calculationVersion:WORKER_CAPACITY_VERSION,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,startsOn,endsOn,sources}),sourceToken=capacityHash(inputCanonical);
 return{worker,sources,inputCanonical,result:{...result,sourceToken}};
};
export const capacitySummary=result=>({calculationVersion:result.calculationVersion,employeeId:result.employeeId,startsOn:result.startsOn,endsOn:result.endsOn,status:result.status,totals:result.totals,sourceToken:result.sourceToken,profileIds:result.profileIds,reasonCodes:result.reasonCodes});
export const demandCandidateCapacity=async(client,req,workerId,startsOn,endsOn,buildEmployeeScopeWhere)=>{
 if(!validCapacityRange(startsOn,endsOn))return{calculationVersion:WORKER_CAPACITY_VERSION,employeeId:workerId,startsOn,endsOn,status:'unavailable',totals:{scheduledHoursExact:null,holidayReductionHoursExact:null,leaveReductionHoursExact:null,availableHoursExact:null,eligibleHoursExact:null},sourceToken:capacityHash({workerId,startsOn,endsOn,reason:'CAPACITY_RANGE_UNAVAILABLE'}),profileIds:[],reasonCodes:['CAPACITY_RANGE_UNAVAILABLE']};
 return capacitySummary((await calculateScopedCapacity(client,req,workerId,startsOn,endsOn,buildEmployeeScopeWhere)).result);
};
