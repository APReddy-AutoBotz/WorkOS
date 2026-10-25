import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commercialFixture as f} from './commercial-drafting-test.mjs';
import {stagedDefinition,readApprovalOwner} from './work-approval-test.mjs';
export const LEAVE_APPROVAL_BASE='/api/v1/work-approvals/leave';
export const leaveOk=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
export const leaveDefinition=(ids,workers=[f.ownerId])=>({...stagedDefinition(ids),entityType:'LeaveRequest',workerIds:workers,templates:[{key:'approval.action_required',subject:'Review {{sourceRef}}',body:'Worker {{workerCode}} needs leave stage {{stageNumber}}.'},{key:'approval.rejected_or_correction_required',subject:'Leave decision {{sourceRef}}',body:'Worker {{workerCode}}: {{decisionReason}}'},{key:'approval.completed',subject:'Completed {{sourceRef}}',body:'Worker {{workerCode}} completed leave stage {{stageNumber}}.'}]});
export const adoptLeavePolicy=async(request,fx,definition=leaveDefinition(fx.identities),latest=null,effectiveFrom=fx.today)=>leaveOk(await request(LEAVE_APPROVAL_BASE+'/policies',{method:'POST',body:{expectedOwnerKey:await readApprovalOwner(request,fx.identities.manager),expectedLatestId:latest,effectiveFrom,definition,reason:'Synthetic explicit prospective named leave routing'}}),201).policy;
export const leaveReviews=async(request,id,identity)=>leaveOk(await request(LEAVE_APPROVAL_BASE+'/instances?requestId='+encodeURIComponent(id),{identity})).instances.sort((a,b)=>a.revision-b.revision);
export const currentLeaveReview=async(request,id,identity)=>(await leaveReviews(request,id,identity)).at(-1);
export const readLeaveReview=async(request,id,identity)=>leaveOk(await request(LEAVE_APPROVAL_BASE+'/instances/'+id,{identity})).instance;
export const createLeave=async(request,fx,identity=fx.identities.reader,extra={})=>{
 const employeeId=extra.employee_id??identity.employeeRecordId,query='?startsOn='+fx.today+'&endsOn='+fx.today,quote=leaveOk(await request('/api/v1/leave-calendar/workers/'+employeeId+'/period'+query,{identity})).quote;
 const body={employee_id:employeeId,leave_type_id:'leave-type-annual',start_date:fx.today,end_date:fx.today,total_days:1,expected_calendar_token:quote.sourceToken,reason:'Synthetic private leave source reason',...extra};const leave=leaveOk(await request('/api/leave/requests',{method:'POST',identity,body}));return{leave,quote,instance:await currentLeaveReview(request,leave.id,identity)};
};
export const leaveCommand=async(request,identity,i,decision='Approved',requestId=randomUUID(),reason='Synthetic inspected current leave stage')=>({expectedOwnerKey:await readApprovalOwner(request,identity),expectedSourceToken:i.sourceToken,expectedSequence:i.state.sequence,decision,requestId,reason});
export const decideLeave=async(request,identity,i,decision='Approved',requestId=randomUUID(),reason='Synthetic inspected current leave stage')=>request(LEAVE_APPROVAL_BASE+'/instances/'+i.id+'/decisions',{method:'POST',identity,body:await leaveCommand(request,identity,i,decision,requestId,reason)});
export const leaveCapacity=async(request,today,identity)=>leaveOk(await request('/api/v1/my-work-planning?startsOn='+today+'&endsOn='+today,{identity})).capacity.totals.availableHoursExact;
export const canonicalLeaveInbox=async(request,identity)=>{
 const rows=[];let after=null;do{const page=leaveOk(await request('/api/v1/work-approvals/inbox'+(after?'?after='+after:''),{identity}));rows.push(...page.notifications);after=page.nextAfter;}while(after);return rows.filter(n=>n.kind==='leave-approval');
};
export const proveConfiguredLeaveStages=async({pool,request,fx,id,hooks={}})=>{
 const ids=fx.identities,first=await currentLeaveReview(request,id),before=(await pool.query('select * from leave_approval_instances where id=$1',[first.id])).rows[0];assert(first.current);assert.equal(first.requesterUserId,ids.reader.id);assert.equal(first.state.status,'Pending');assert.equal(await leaveCapacity(request,fx.today,ids.reader),'8');
 for(const identity of [ids.manager,ids.second]){
  const i=await readLeaveReview(request,first.id,identity),reason='Synthetic configured named leave approval',command=await leaveCommand(request,identity,i,'Approved',randomUUID(),reason),out=hooks.decide?await hooks.decide(identity,i,reason):leaveOk(await request(LEAVE_APPROVAL_BASE+'/instances/'+i.id+'/decisions',{method:'POST',identity,body:command}),201);
  command.requestId=out.receipt.requestId;command.reason=out.receipt.reason;const replay=leaveOk(await request(LEAVE_APPROVAL_BASE+'/instances/'+i.id+'/decisions',{method:'POST',identity,body:command}));assert(replay.replayed);assert.deepEqual(replay.receipt,out.receipt);
  assert.equal(await leaveCapacity(request,fx.today,ids.reader),identity===ids.manager?'8':'0');
  if(identity===ids.manager){assert.equal((await pool.query('select status from leave_requests where id=$1',[id])).rows[0].status,'Submitted');const inbox=await canonicalLeaveInbox(request,ids.second);assert(inbox.some(n=>n.instanceId===first.id&&n.transitionSequence===1));}
 }
 const final=await readLeaveReview(request,first.id);assert.equal(final.state.status,'Approved');assert.equal(final.transitions.length,2);assert.deepEqual((await pool.query('select * from leave_approval_instances where id=$1',[first.id])).rows[0],before);
 const inbox=await canonicalLeaveInbox(request,ids.reader);const note=inbox.find(n=>n.instanceId===first.id&&n.eventKey==='approval.completed');assert(note);assert.deepEqual(note.reasons,['affected_worker','requester']);assert(!JSON.stringify(inbox).includes('Synthetic private leave source reason'));
 if(hooks.read)await hooks.read(note);else{const read=leaveOk(await request('/api/v1/work-approvals/inbox/'+note.id+'/read',{method:'POST',identity:ids.reader,body:{expectedOwnerKey:await readApprovalOwner(request,ids.reader)}}));assert(read.notification.readAt);}
 assert((await canonicalLeaveInbox(request,ids.reader)).find(n=>n.id===note.id).readAt);return final;
};
