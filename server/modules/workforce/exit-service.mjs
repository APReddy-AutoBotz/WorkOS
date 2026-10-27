import {createHash} from 'node:crypto';
import {WORKER_EXIT_VERSION,workerExitCanonical} from '../../../shared/reviewed-worker-exit.mjs';
import {workApprovalOwner} from '../approvals/work-approval-service.mjs';
const fail=(code,message,status=409)=>{const e=new Error(message);e.code=code;e.statusCode=status;throw e;};
const scope=r=>[r.organizationScope.organizationId,r.organizationScope.legalEntityId];
const context=async(c,r)=>({contractVersion:WORKER_EXIT_VERSION,organizationId:r.organizationScope.organizationId,legalEntityId:r.organizationScope.legalEntityId,ownerKey:workApprovalOwner(r),actorUserId:r.user.sub,activeRole:r.user.activeRole,serverDate:(await c.query("select to_char((clock_timestamp()at time zone'UTC')::date,'YYYY-MM-DD')d")).rows[0].d});
const scopedWorker=async(c,r,id,o,lock=false)=>{
 const args=[],where=o.buildEmployeeScopeWhere(r,args,'e');args.push(id);
 const row=(await c.query(`select e.*,e.exit_date::text exit_date from employees e where ${where} and e.id=$${args.length}${lock?' for update':''}`,args)).rows[0];
 if(!row)fail('WORKER_EXIT_UNAVAILABLE','Worker exit is unavailable in this current scope.',404);return row;
};
const worker=e=>({id:e.id,code:e.employee_id,name:e.name,status:e.status,exitDate:e.exit_date??null});
export const inspectWorkerExit=async(c,r,id,o,lock=false)=>{
 const e=await scopedWorker(c,r,id,o,lock),ctx=await context(c,r);
 const profile=(await c.query('select to_jsonb(p)profile from worker_profiles p where employee_id=$1 and organization_id=$2 and legal_entity_id=$3',[id,...scope(r)])).rows[0]?.profile??null;
 const latest=(await c.query('select to_jsonb(h)history,effective_from::text date from worker_history h where employee_id=$1 and organization_id=$2 and legal_entity_id=$3 order by effective_from desc limit 1',[id,...scope(r)])).rows[0]??null;
 const result=await o.workerExitDependencies(c,id,r.organizationScope),dependencies=result.rows.slice(0,100).map(x=>({kind:x.kind,id:String(x.id)})).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)),truncated=result.rows.length>100;
 const state=e.status==='Exited'?'ALREADY_EXITED':!profile||!latest?'PROFILE_UNAVAILABLE':dependencies.length?'DEPENDENCIES':latest.date>=ctx.serverDate?'HISTORY_DATE':'READY';
 const observationToken=createHash('sha256').update(workerExitCanonical({employee:e,profile,history:latest?.history??null,dependencies,truncated,serverDate:ctx.serverDate})).digest('hex');
 return{...ctx,worker:worker(e),latestHistoryFrom:latest?.date??null,dependencies,truncated,state,observationToken};
};
const owned=async(c,r,id)=>(await c.query("select new_value from audit_logs where organization_id=$1 and legal_entity_id=$2 and user_id=$3 and active_role=$4 and module='Workforce Exit'and action='Reviewed Worker Exit'and entity_type='ReviewedWorkerExit'and entity_id=$5 order by id desc limit 1",[...scope(r),r.user.sub,r.user.activeRole,id])).rows[0]?.new_value??null;
export const reconcileWorkerExit=async(c,r,id,o)=>{
 const found=await owned(c,r,id);if(!found)fail('WORKER_EXIT_UNCONFIRMED','No original receipt is confirmed; the request may still be in flight. Do not replace it.',404);
 await scopedWorker(c,r,found.command.employeeId,o);return{...await context(c,r),...found};
};
export const applyWorkerExit=async(c,r,input,o)=>{
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`reviewed-worker-exit:${scope(r).join(':')}:${r.user.sub}:${input.requestId}`]);
 await o.validateActor(c,r);
 const found=await owned(c,r,input.requestId);
 if(found){await scopedWorker(c,r,found.command.employeeId,o);if(workerExitCanonical(found.command)!==workerExitCanonical(input))fail('WORKER_EXIT_KEY_CONFLICT','This key belongs to different input. Reconcile the original request.');return{...await context(c,r),...found,replayed:true};}
 const observed=await scopedWorker(c,r,input.employeeId,o);
 // Share the canonical employee-write lock; do not introduce a parallel lifecycle authority.
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`employee:${r.organizationScope.organizationId}:${observed.employee_id}`]);
 await o.validateActor(c,r);
 const before=await scopedWorker(c,r,input.employeeId,o,true),assessment=await inspectWorkerExit(c,r,input.employeeId,o);
 if(assessment.observationToken!==input.expectedToken)fail('WORKER_EXIT_STALE','Worker, lifecycle, dependencies or UTC date changed. Inspect again.');
 if(assessment.state!=='READY')fail('WORKER_EXIT_'+assessment.state,'Current canonical dependencies or lifecycle prevent this exit. Inspect again.');
 await o.assertWorkerMayExit(c,before,r.organizationScope,assessment.serverDate);
 await o.synchronizeWorkerExit(c,r,before,assessment.serverDate,input.reason);
 // A PostgreSQL date is a civil date, not a local-midnight JavaScript instant.
 const after=await scopedWorker(c,r,input.employeeId,o);
 const recordedAt=(await c.query("select to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')t")).rows[0].t;
 const receipt={requestId:input.requestId,employeeId:input.employeeId,worker:worker(after),previousStatus:before.status,effectiveFrom:assessment.serverDate,reason:input.reason,actorUserId:r.user.sub,activeRole:r.user.activeRole,source:'Web',recordedAt,operationId:r.operationId};
 const retained={command:input,receipt};
 await o.audit(c,r,{module:'Workforce Exit',action:'Reviewed Worker Exit',entityType:'ReviewedWorkerExit',entityId:input.requestId,oldValue:{worker:worker(before),observationToken:assessment.observationToken,latestHistoryFrom:assessment.latestHistoryFrom},newValue:retained,reason:input.reason,details:'Reviewed current canonical exit dependencies and applied existing terminal lifecycle atomically.'});
 return{...await context(c,r),...retained,replayed:false};
};
