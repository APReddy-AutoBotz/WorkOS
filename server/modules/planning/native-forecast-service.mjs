import {calculateNativeForecast,nativeCheckpoint,validNativeThresholds,NATIVE_FORECAST_VERSION} from '../../../shared/native-forecast.mjs';
import {distributeFixedHours} from '../../../shared/assignment-version.mjs';
import {capacityDateCount,shiftCapacityDate,multiplyCapacity} from '../../../shared/worker-capacity.mjs';
import {canonicalHours,sumHours} from '../../../shared/work-hours.mjs';
import {calculateScopedCapacity,capacityCanonical,capacityHash} from './worker-capacity-service.mjs';
import {resolveProjectDate} from '../work-capture/assignment-work-policy.mjs';
const limit=1000;
// Only dated operating authority is loaded. No rates, prices, comments or private
// commercial terms are projected or used to calculate this native quantity.
export const loadForecastProjects=async(c,req,ids)=>{
 const scope=[req.organizationScope.organizationId,req.organizationScope.legalEntityId],p=[...scope,ids];
 const projects=(await c.query('select id,status,start_date::text,end_date::text,billable from projects where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[]) order by id',p)).rows;
 const bindings=(await c.query(`select id,project_id,engagement_id,contract_id,contract_version_id,starts_on::text,ends_on::text,billable,model from commercial_project_bindings where organization_id=$1 and legal_entity_id=$2 and project_id=any($3::text[]) order by id limit ${limit+1}`,p)).rows;
 const engagements=(await c.query(`select id,contract_id,contract_version_id,starts_on::text,ends_on::text,billable,model from commercial_engagements where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[]) order by id limit ${limit+1}`,[...scope,bindings.map(b=>b.engagement_id)])).rows;
 const entityIds=[...ids,...engagements.map(e=>e.id),...bindings.map(b=>b.contract_id).filter(Boolean)];
 const lifecycle=(await c.query(`select id,entity_type,entity_id,sequence,state,effective_on::text,contract_version_id from commercial_lifecycle_events where organization_id=$1 and legal_entity_id=$2 and entity_id=any($3::text[]) order by entity_type,entity_id,sequence limit ${limit+1}`,[...scope,entityIds])).rows;
 const amendments=(await c.query(`select id,entity_type,entity_id,sequence,effective_on::text,contract_version_id,starts_on::text,ends_on::text from commercial_amendments where organization_id=$1 and legal_entity_id=$2 and entity_id=any($3::text[]) order by entity_type,entity_id,sequence limit ${limit+1}`,[...scope,entityIds])).rows;
 const contracts=(await c.query(`select id,contract_id,starts_on::text,ends_on::text,effective_from::text from commercial_contract_versions where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[]) order by id limit ${limit+1}`,[...scope,lifecycle.filter(l=>l.entity_type==='Contract').map(l=>l.contract_version_id).filter(Boolean)])).rows;
 const loaded=projects.map(project=>{const binding=bindings.find(b=>b.project_id===project.id)??null,engagement=bindings.length&&engagements.find(e=>e.id===binding?.engagement_id),entities=binding?[{type:'Project',id:project.id,root:binding},{type:'Engagement',id:binding.engagement_id,root:engagement&&engagement.contract_id===binding.contract_id?engagement:null},...(binding.contract_id?[{type:'Contract',id:binding.contract_id,root:null}]:[])]:[];for(const e of entities){e.lifecycle=lifecycle.filter(l=>l.entity_type===e.type&&l.entity_id===e.id);e.amendments=amendments.filter(a=>a.entity_type===e.type&&a.entity_id===e.id);if(e.type==='Contract'){const pin=e.lifecycle[0]?.contract_version_id;e.root=contracts.find(v=>v.id===pin&&v.contract_id===e.id);if(e.root)e.root={...e.root,contract_version_id:pin};}}return{project,binding,entities};});
 return{loaded,source:{projects,bindings,engagements,lifecycle,amendments,contracts},limited:[bindings,engagements,lifecycle,amendments,contracts].some(a=>a.length>limit)};
};
export const forecastProjectState=(loaded,date)=>{
 if(!loaded)return'unavailable';
 if(loaded.binding&&loaded.entities.some(e=>!e.root||!e.lifecycle.some(l=>l.effective_on<=date)))return'unavailable';
 try{resolveProjectDate(loaded,date,{assignment:true});return'included';}catch(e){return['WORK_PROJECT_INACTIVE','WORK_PROJECT_DATES','WORK_LIFECYCLE_INACTIVE','WORK_TERMS_DATES'].includes(e.code)?'excluded':'unavailable';}
};
// Fixed totals use the whole assignment range, including dates between checkpoints.
async function fixedCheckpointPlan(rows, assignments, result, readCapacity) {
 const included = (a, point, i) => a.status==='Active' && a.startsOn<=point.date && a.endsOn>=point.date && a.states[i]==='included';
 const fixed = rows.filter((row,i)=>row.fixed_hours!==null && result.points.some((point,j)=>included(assignments[i],point,j)));
 const fixedTotals = rows.filter(row=>row.fixed_hours!==null).map(row=>({assignmentId:row.id,hours:row.fixed_hours}));
 const dayMap = new Map(), capacityTokens=[];
 if(fixed.length){
  const first=fixed.map(row=>row.start_date).sort()[0], last=fixed.map(row=>row.end_date).sort().at(-1);
  for(let from=first;;){
   const end=capacityDateCount(from,last)>366?shiftCapacityDate(from,365):last;
   const capacity=await readCapacity(from,end);
   capacityTokens.push(capacity.result.sourceToken);
   for(const day of capacity.result.days)dayMap.set(day.date,day);
   if(end===last)break;
   from=shiftCapacityDate(end,1);
  }
 }
 const plans=new Map();
 for(const row of fixed){
  const days=Array.from({length:capacityDateCount(row.start_date,row.end_date)},(_,i)=>dayMap.get(shiftCapacityDate(row.start_date,i)));
  plans.set(row.id,distributeFixedHours(row.fixed_hours,days));
 }
 const plannedHours=result.points.map((point,j)=>{
  if(point.declaredPercentageExact===null || point.capacity.status!=='available')return null;
  const hours=[];
  for(const a of assignments??[]){
   if(!included(a,point,j))continue;
   if(plans.has(a.id)){
    const daily=plans.get(a.id);
    if(!daily)return null;
    hours.push(daily[capacityDateCount(a.startsOn,point.date)-1]);
   }else hours.push(multiplyCapacity(point.capacity.totals.availableHoursExact,a.quantityExact,true));
  }
  return sumHours(hours);
 });
 return {fixedTotals,plannedHours,capacityTokens};
}
export const calculateScopedNativeForecast=async(c,req,employeeId,startsOn,endsOn,months,buildEmployeeScopeWhere,buildProjectScopeWhere)=>{
 const capacities=[];let worker;const capacityInputs=[];
 for(let i=0;i<=months;i++){const date=nativeCheckpoint(startsOn,i),v=await calculateScopedCapacity(c,req,employeeId,date,date,buildEmployeeScopeWhere);worker=v.worker;capacityInputs.push(JSON.parse(v.inputCanonical));const day=v.result.days[0],profile=v.sources.profiles.find(p=>p.id===day.sourceRefs.profileId);capacities.push({status:v.result.status,eligible:day.reasonCodes.includes('WORKER_INACTIVE')?false:typeof profile?.definition.utilizationEligible==='boolean'?profile.definition.utilizationEligible:null,totals:v.result.totals,sourceToken:v.result.sourceToken,reasonCodes:v.result.reasonCodes});}
 const p=[],pw=buildProjectScopeWhere(req,p,'p');p.push(employeeId,req.organizationScope.organizationId,req.organizationScope.legalEntityId,startsOn,endsOn);const n=p.length,condition=`a.employee_id=$${n-4} and a.organization_id=$${n-3} and a.legal_entity_id=$${n-2} and a.start_date<=$${n}::date and a.end_date>=$${n-1}::date`;
 const hidden=(await c.query(`select exists(select 1 from project_allocations a where ${condition} and not exists(select 1 from projects p where p.id=a.project_id and p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id and ${pw})) hidden`,p)).rows[0].hidden;
 const rows=hidden?[]:(await c.query(`select a.id,a.project_id,trim_scale(a.percentage)::text percentage,trim_scale(a.fixed_hours)::text fixed_hours,a.start_date::text,a.end_date::text,a.status,resource_assignment_revision(a) revision,p.project_code,p.name,v.id version_id,coalesce(v.sequence,0) sequence,v.source_revision from project_allocations a join projects p on p.id=a.project_id and p.organization_id=a.organization_id and p.legal_entity_id=a.legal_entity_id left join lateral(select id,sequence,source_revision from assignment_versions where assignment_id=a.id and organization_id=a.organization_id and legal_entity_id=a.legal_entity_id order by sequence desc limit 1)v on true where ${pw} and ${condition} order by a.id collate "C" limit ${limit+1}`,p)).rows;
 const projects=await loadForecastProjects(c,req,[...new Set(rows.slice(0,limit).map(a=>a.project_id))]),settings=(await c.query("select key,value from system_settings where key=any($1::text[]) order by key",[['benchThreshold','utilizationThresholdLow','utilizationThresholdHigh']])).rows;
 let thresholds=null;try{const values=Object.fromEntries(settings.map(s=>[s.key,s.value])),t={bench:canonicalHours(values.benchThreshold),low:canonicalHours(values.utilizationThresholdLow),high:canonicalHours(values.utilizationThresholdHigh)};if(validNativeThresholds(t))thresholds=t;}catch{/* Absent/invalid buyer values never receive fallback thresholds. */}
 const sourceReason=hidden?'SCOPED_SOURCE_UNAVAILABLE':rows.length>limit||projects.limited?'FORECAST_SOURCE_LIMIT':null;
 const assignments=sourceReason?null:rows.map(a=>({id:a.id,projectId:a.project_id,projectCode:a.project_code,projectName:a.name,revision:a.revision,versionId:a.version_id,sequence:a.sequence,quantityUnit:'percentage',quantityExact:a.percentage,startsOn:a.start_date,endsOn:a.end_date,status:a.status,states:capacities.map((_,i)=>a.version_id&&a.source_revision!==a.revision?'unavailable':forecastProjectState(projects.loaded.find(v=>v.project.id===a.project_id),nativeCheckpoint(startsOn,i)))}));
 const result=calculateNativeForecast({employeeId,startsOn,endsOn,months,thresholds,assignments,capacities,sourceReason});
 const plan=await fixedCheckpointPlan(sourceReason?[]:rows,assignments,result,(from,to)=>calculateScopedCapacity(c,req,employeeId,from,to,buildEmployeeScopeWhere));
 const inputCanonical=capacityCanonical({calculationVersion:NATIVE_FORECAST_VERSION,organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,employeeId,startsOn,endsOn,months,capacityInputs,fixedRangeCapacityTokens:plan.capacityTokens,rows:sourceReason?null:rows,projectAuthority:sourceReason?null:projects.source,settings,sourceReason}),observed=(await c.query("select to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')observed")).rows[0].observed;
 return{worker,inputCanonical,plannedHours:plan.plannedHours,fixedTotals:plan.fixedTotals,result:{...result,sourceToken:capacityHash(inputCanonical),observedAt:observed}};
};
