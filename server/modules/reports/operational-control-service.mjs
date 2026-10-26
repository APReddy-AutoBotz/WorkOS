import {OPERATIONAL_CONTROL_VERSION,OPERATIONAL_PAGE_SIZE,OPERATIONAL_PENDING_CAP,OPERATIONAL_KINDS,operationalConfidence} from '../../../shared/operational-control.mjs';
import {capacityCanonical,capacityHash,capacityFailure} from '../planning/worker-capacity-service.mjs';
import {calculateScopedActualWork} from '../planning/actual-work-service.mjs';
import {calculateScopedNativeForecast} from '../planning/native-forecast-service.mjs';
import {approvalDueSource} from '../notifications/approval-due-service.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';
const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const canRead=(req,kind)=>['approvals.view',...(kind==='Work'?['timesheets.submit']:kind==='Leave'?['leave.self_service']:['projects.view','allocations.view'])].every(p=>req.user.permissions.includes(p));
const pendingForWorker=async(c,req,workerId,o)=>{
 const groups=[];
 for(const kind of OPERATIONAL_KINDS){
  if(!canRead(req,kind)){groups.push({kind,state:'not_permitted',items:null});continue;}
  const p=[...scope(req),workerId,kind],project=o.buildProjectScopeWhere(req,p,'p');
  const rows=(await c.query(`select s.instance_id id,s.stage,s.source_token "sourceToken",s.source_event_id "sourceEventId",s.activated_at "pendingAt" from approval_due_source_events s left join projects p on p.id=s.project_id where s.organization_id=$1 and s.legal_entity_id=$2 and s.employee_id=$3 and s.origin=$4 and(s.project_id is null or ${project})and approval_due_current(s.origin,s.instance_id,s.stage)order by s.instance_id limit ${OPERATIONAL_PENDING_CAP+1}`,p)).rows;
  const items=[];let unavailable=false;
  for(const r of rows.slice(0,OPERATIONAL_PENDING_CAP)){
   try{
    const source=await approvalDueSource(c,req,kind,r.id,o);if(source.worker.id!==workerId||source.state.status!=='Pending'||source.state.currentStage!==r.stage||source.sourceToken!==r.sourceToken){unavailable=true;break;}
    // Work read authority is worker-scoped; the control workspace also refuses
    // project drilldown if a retained source includes a currently hidden project.
    if(kind==='Work'){
     const ids=[...new Set((source.v.source?.entries??[]).map(e=>e.projectId).filter(Boolean))];if(ids.length>200){unavailable=true;break;}
     if(ids.length){const q=[ids],where=o.buildProjectScopeWhere(req,q,'p');if((await c.query(`select p.id from projects p where p.id=any($1::text[])and ${where}`,q)).rowCount!==ids.length){unavailable=true;break;}}
    }
    items.push({kind,id:r.id,stage:r.stage,sourceToken:r.sourceToken,sourceEventId:r.sourceEventId,pendingAt:r.pendingAt.toISOString(),decisionAuthority:'RequiresFreshReview'});
   }catch(e){if(e.statusCode&&e.statusCode>=400&&e.statusCode<500){unavailable=true;break;}throw e;}
  }
  groups.push({kind,state:unavailable?'unavailable':rows.length>OPERATIONAL_PENDING_CAP?'limited':'available',items:unavailable?null:items});
 }
 return groups;
};
export const calculateOperationalControl=async(c,req,selection,after,expectedRosterToken,o)=>{
 const p=[],where=o.buildEmployeeScopeWhere(req,p,'e'),active=`${where} and e.status='Active'`;
 // Count and digest only the authorized active roster, before pagination.
 // The aggregate is not returned as a list and contains no private worker fields.
 const aggregate=(await c.query(`select count(*)::integer total,encode(digest(coalesce(string_agg(jsonb_build_array(e.id,e.employee_id,e.name,e.status)::text,'|'order by e.id collate "C"),''),'sha256'),'hex')stamp from employees e where ${active}`,p)).rows[0];
 const ownerKey=workApprovalOwner(req),rosterToken=capacityHash({version:OPERATIONAL_CONTROL_VERSION,scope:scope(req),actorId:req.user.sub,activeRole:req.user.activeRole,permissions:[...req.user.permissions].sort(),selection,aggregate});
 if(expectedRosterToken&&rosterToken!==expectedRosterToken)capacityFailure('OPERATIONAL_ROSTER_CHANGED','Roster, context or selected periods changed. Refresh from the first page.',409);
 if(after){const q=[...p,after];if(!(await c.query(`select e.id from employees e where ${active} and e.id=$${q.length}`,q)).rowCount)capacityFailure('OPERATIONAL_CURSOR_CHANGED','The selected continuation is unavailable. Refresh from the first page.',409);}
 const q=[...p,after??null],rows=(await c.query(`select e.id,e.employee_id code,e.name,e.status from employees e where ${active} and($${q.length}::text is null or e.id collate "C">$${q.length} collate "C")order by e.id collate "C" limit ${OPERATIONAL_PAGE_SIZE+1}`,q)).rows;
 const workers=[];
 for(const worker of rows.slice(0,OPERATIONAL_PAGE_SIZE)){
  const actual=(await calculateScopedActualWork(c,req,worker.id,selection.startsOn,selection.endsOn,o.buildEmployeeScopeWhere)).result;
  const forecast=(await calculateScopedNativeForecast(c,req,worker.id,selection.forecastStartsOn,selection.forecastEndsOn,selection.months,o.buildEmployeeScopeWhere,o.buildProjectScopeWhere)).result;
  const pending=await pendingForWorker(c,req,worker.id,o),row={worker,actual,forecast,pending};workers.push({...row,confidence:operationalConfidence(row)});
 }
 const clock=(await c.query("select to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD')today,clock_timestamp()observed")).rows[0];
 const view={contractVersion:OPERATIONAL_CONTROL_VERSION,organizationId:scope(req)[0],legalEntityId:scope(req)[1],ownerKey,actorUserId:req.user.sub,activeRole:req.user.activeRole,selection,roster:{totalActive:aggregate.total,sourceToken:rosterToken,nextAfter:rows.length>OPERATIONAL_PAGE_SIZE?rows[OPERATIONAL_PAGE_SIZE-1].id:null},coverage:'CurrentPage',workers,today:clock.today};
 return{...view,sourceToken:capacityHash(capacityCanonical(view)),observedAt:clock.observed.toISOString()};
};
