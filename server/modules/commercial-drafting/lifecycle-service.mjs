import {randomUUID} from 'node:crypto';
import {fail,COMMERCIAL_PAGE_SIZE} from './contracts.mjs';
import {getContract,validateEngagementReferences} from './service.mjs';
import {lockCommercialLifecycle} from './project-mutation.mjs';

const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const where='organization_id=$1 and legal_entity_id=$2';
const today=async client=>(await client.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
const lifecycleDto=row=>row?({id:row.id,sequence:row.sequence,state:row.state,effectiveOn:row.effective_on,
  contractVersionId:row.contract_version_id,reason:row.reason,approvalReference:row.approval_reference,
  actorId:row.actor_id,activeRole:row.active_role,correlationId:row.correlation_id,operationId:row.operation_id}):null;
export const getLifecycle=async(client,req,type,id)=>lifecycleDto((await client.query(`select *,effective_on::text from commercial_lifecycle_events where ${where} and entity_type=$3 and entity_id=$4 order by sequence desc limit 1`,[...scope(req),type,id])).rows[0]);
const scopedEntity=async(client,req,type,id,{lock=true}={})=>{
  const table={Contract:'commercial_contracts',Engagement:'commercial_engagements',Project:'commercial_project_bindings'}[type];
  if(!table)fail(404,'COMMERCIAL_NOT_FOUND','The scoped lifecycle record was not found.');
  const row=(await client.query(`select *,${type==='Contract'?'created_at::text':'starts_on::text,ends_on::text'} from ${table} where ${where} and ${type==='Project'?'project_id':'id'}=$3${lock?' for update':''}`,[...scope(req),id])).rows[0];
  if(!row || row.origin==='legacy-neutral')fail(404,'COMMERCIAL_NOT_FOUND','The scoped lifecycle record was not found.');
  return row;
};
const assertOwner=async(client,req,id,starts,ends)=>{
  const row=(await client.query(`select id,name from employees where ${where} and id=$3 and status='Active' and (joining_date is null or joining_date<=$4) and (exit_date is null or exit_date>=$5) for share`,[...scope(req),id,starts,ends])).rows[0];
  if(!row)fail(422,'COMMERCIAL_OWNER_UNAVAILABLE','An active scoped owner covering the dates is required.');return row;
};
const assertActive=async(client,req,type,id,versionId)=>{
  const state=await getLifecycle(client,req,type,id);
  if(state?.state!=='Active' || state.contractVersionId!==versionId)fail(409,'COMMERCIAL_PARENT_NOT_ACTIVE','The parent must be active on the exact pinned immutable contract version.');
};
const validateEngagementSnapshot=async(client,req,root)=>{
  await validateEngagementReferences(client,req,{model:root.model,ownerId:root.owner_id,startsOn:root.starts_on,endsOn:root.ends_on,
    currency:root.currency,clientId:root.client_id,contractId:root.contract_id,contractVersionId:root.contract_version_id,attributionId:root.attribution_id});
  if(root.contract_id)await assertActive(client,req,'Contract',root.contract_id,root.contract_version_id);
};
const assertNoActiveChildren=async(client,req,type,id)=>{
  const sql=type==='Contract'?`select e.id from commercial_engagements e where e.organization_id=$1 and e.legal_entity_id=$2 and e.contract_id=$3 and
    (select l.state from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id order by l.sequence desc limit 1)='Active' limit 1`:
    `select p.project_id from commercial_project_bindings p where p.organization_id=$1 and p.legal_entity_id=$2 and p.engagement_id=$3 and
    (select l.state from commercial_lifecycle_events l where l.entity_type='Project' and l.entity_id=p.project_id order by l.sequence desc limit 1)='Active' limit 1`;
  if(type!=='Project' && (await client.query(sql,[...scope(req),id])).rowCount)fail(409,'COMMERCIAL_ACTIVE_DEPENDENCIES','Put active governed children on hold first. No child state is changed implicitly.');
};
const auditPointer=async(audit,client,req,type,id,event,before)=>audit(client,req,{module:'Commercial Lifecycle',action:'Append Lifecycle',entityType:type,entityId:id,
  oldValue:before?{commercialEventId:event.id,snapshot:'before'}:null,newValue:{commercialEventId:event.id,snapshot:'after'},
  reason:'Commercial lifecycle operation; protected evidence retained.',source:'Web',details:'Opaque lifecycle pointer only. Commercial access is required for material evidence.'});
const append=async(client,req,type,id,root,input,before,audit)=>{
  const eventId=`lifecycle-${randomUUID()}`;
  const after={entityId:id,state:input.state,sequence:(before?.sequence||0)+1,effectiveOn:await today(client),contractVersionId:input.contractVersionId};
  const row=(await client.query(`insert into commercial_lifecycle_events(id,organization_id,legal_entity_id,entity_type,entity_id,sequence,state,contract_id,contract_version_id,before_value,after_value,reason,approval_reference,actor_id,active_role,correlation_id,operation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17) returning *,effective_on::text`,
    [eventId,...scope(req),type,id,after.sequence,input.state,type==='Contract'?id:root.contract_id,input.contractVersionId,
      before?JSON.stringify(before):null,JSON.stringify({lifecycle:after,snapshot:root}),input.reason,input.approvalReference,req.user.sub,req.user.activeRole,req.correlationId,req.operationId])).rows[0];
  await auditPointer(audit,client,req,type,id,row,before);return lifecycleDto(row);
};
export const transitionLifecycle=async(client,req,type,id,input,audit)=>{
  await lockCommercialLifecycle(client,req.organizationScope);
  const root=await scopedEntity(client,req,type,id);
  const before=await getLifecycle(client,req,type,id);
  if(input.expectedSequence!==(before?.sequence||0))fail(409,'COMMERCIAL_LIFECYCLE_CONFLICT','Lifecycle changed. Reload before acting.');
  if(before?.state===input.state || (!before && input.state!=='Active'))fail(409,'COMMERCIAL_INVALID_TRANSITION','First activate the draft; subsequent transitions alternate Active and On Hold.');
  if(before && input.contractVersionId!==before.contractVersionId)fail(409,'COMMERCIAL_PIN_CONFLICT','Lifecycle transitions cannot replace immutable pinned terms. A separately governed amendment is required.');
  const date=await today(client);
  if(type==='Contract'){
    const contract=await getContract(client,req,id);
    const term=contract.versions.find(x=>x.id===input.contractVersionId);
    if(!term)fail(422,'COMMERCIAL_PIN_CONFLICT','Choose an immutable version belonging to this scoped contract.');
    if(input.state==='Active'){
      const applicable=contract.versions.find(x=>x.effectiveFrom<=date);
      if(!before && applicable?.id!==term.id)fail(409,'COMMERCIAL_TERMS_SUPERSEDED','Initial activation requires the version effective on the current UTC date.');
      if(date<term.startsOn || date>term.endsOn || date<term.effectiveFrom)fail(409,'COMMERCIAL_INACTIVE_DATES','The pinned contract terms do not cover the current UTC date.');
      const activeClient=(await client.query(`select id from clients where ${where} and id=$3 and status='Active' for share`,[...scope(req),contract.clientId])).rows[0];
      if(!activeClient)fail(422,'COMMERCIAL_REFERENCE_NOT_FOUND','An active scoped client is required.');
    }
  }else{
    if(input.contractVersionId!==root.contract_version_id)fail(409,'COMMERCIAL_PIN_CONFLICT','The command must name the snapshot\'s exact contract version, or null for internal work.');
    if(input.state==='Active'){
      if(date<root.starts_on || date>root.ends_on)fail(409,'COMMERCIAL_INACTIVE_DATES','The immutable dates do not cover the current UTC date.');
      if(type==='Engagement'){
        await validateEngagementSnapshot(client,req,root);
      }else{
        await assertOwner(client,req,root.manager_id,root.starts_on,root.ends_on);
        await assertActive(client,req,'Engagement',root.engagement_id,root.contract_version_id);
        await validateEngagementSnapshot(client,req,await scopedEntity(client,req,'Engagement',root.engagement_id));
      }
    }
  }
  if(input.state==='On Hold')await assertNoActiveChildren(client,req,type,id);
  return append(client,req,type,id,root,input,before,audit);
};
const projectDto=row=>({id:row.project_id,bindingId:row.id,engagementId:row.engagement_id,code:row.code,name:row.name,managerId:row.manager_id,
  startsOn:row.starts_on,endsOn:row.ends_on,model:row.model,currency:row.currency,budgetAllocation:row.budget_allocation,
  billable:row.billable,contractVersionId:row.contract_version_id,attributionId:row.attribution_id,origin:row.origin});
export const createGovernedProject=async(client,req,input,audit)=>{
  await lockCommercialLifecycle(client,req.organizationScope);
  const engagement=await scopedEntity(client,req,'Engagement',input.engagementId);
  await assertActive(client,req,'Engagement',engagement.id,engagement.contract_version_id);
  await validateEngagementSnapshot(client,req,engagement);
  if(input.startsOn<engagement.starts_on || input.endsOn>engagement.ends_on)fail(422,'COMMERCIAL_TERMS_MISMATCH','Project dates must fit the immutable engagement.');
  if(!engagement.billable && input.billable)fail(422,'COMMERCIAL_INTERNAL_POLICY','Internal and pre-sales projects remain non-billable.');
  if(!engagement.billable && !/^0(?:\.0{1,4})?$/.test(input.budgetAllocation))fail(422,'COMMERCIAL_INTERNAL_POLICY','Non-billable project commercial budget allocation must be zero.');
  const manager=await assertOwner(client,req,input.managerId,input.startsOn,input.endsOn);
  const date=await today(client);if(date<input.startsOn || date>input.endsOn)fail(409,'COMMERCIAL_INACTIVE_DATES','New governed projects activate now; dates must cover the current UTC date.');
  const total=(await client.query(`select coalesce(sum(budget_allocation),0)+$4::numeric <= $5::numeric allowed from commercial_project_bindings where ${where} and engagement_id=$3`,[...scope(req),engagement.id,input.budgetAllocation,engagement.budget])).rows[0];
  if(!total.allowed)fail(422,'COMMERCIAL_PROJECT_BUDGET_EXCEEDED','Project allocations cannot exceed the engagement budget. This is not consumption or billing.');
  let project;let origin='manual';
  if(input.projectId){
    project=(await client.query(`select *,start_date::text,end_date::text from projects where ${where} and id=$3 for update`,[...scope(req),input.projectId])).rows[0];
    if(!project)fail(404,'COMMERCIAL_NOT_FOUND','The scoped legacy project was not found.');
    if((await client.query(`select 1 from commercial_project_bindings where project_id=$1`,[project.id])).rowCount)fail(409,'COMMERCIAL_PROJECT_ALREADY_GOVERNED','This project already has an immutable engagement binding.');
    if(project.status!=='Proposed' || project.project_code!==input.code || project.name!==input.name || project.manager_id!==input.managerId || project.start_date!==input.startsOn || project.end_date!==input.endsOn || project.client_id!==engagement.client_id || project.billable!==input.billable)
      fail(409,'COMMERCIAL_LEGACY_PROMOTION_MISMATCH','Explicit promotion requires an unchanged Proposed project with exact code, name, manager, dates, client and billability.');
    const dependencies=(await client.query(`select exists(select 1 from project_allocations where project_id=$1) or exists(select 1 from timesheet_entries where project_id=$1) used`,[project.id])).rows[0];
    if(dependencies.used)fail(409,'COMMERCIAL_LEGACY_HISTORY_PRESENT','A project with assignment or work history needs a later governed conversion, not silent promotion.');
    // Current Proposed status cannot erase earlier operational use. Only the
    // transactional project writers supply creation provenance; client-reported
    // Export/Import/Notify audit events are not authority. Missing or ambiguous
    // legacy evidence requires conversion, including pre-scope audit history.
    const provenance=(await client.query(`with history as (
      select * from audit_logs where entity_type='Project' and entity_id=$3
        and action in('Create Project','Update Project','Update Project Status','Import Create Project','Import Update Project')
    ) select
      count(*) filter(where action in('Create Project','Import Create Project'))=1
      and count(*) filter(where old_value is null and new_value->>'id'=$3 and new_value->>'status'='Proposed'
        and ((action='Create Project' and source='Web') or (action='Import Create Project' and source='Project Master CSV' and import_processing_result='Success')))=1
      and coalesce(bool_and(organization_id=$1 and legal_entity_id=$2
        and new_value->>'id'=$3 and new_value->>'status'='Proposed'
        and (old_value is null or (old_value->>'id'=$3 and old_value->>'status'='Proposed'))),false)
      and not exists(select 1 from history where organization_id is null or legal_entity_id is null
        or new_value->>'id' is null or new_value->>'status' is null
        or (old_value is not null and (old_value->>'id' is null or old_value->>'status' is null)))
      and not exists(select 1 from project_engagement_mappings where project_id=$3
        and (source_snapshot->>'status' is distinct from 'Proposed')) as eligible from history`,[...scope(req),project.id])).rows[0];
    if(!provenance.eligible)fail(409,'COMMERCIAL_LEGACY_PROVENANCE_REQUIRED','Promotion requires scoped creation evidence and exclusively Proposed history. Previously operational or unverifiable records need a separately governed conversion.');
    origin='explicit-legacy-promotion';
  }else{
    const clientName=engagement.client_id?(await client.query(`select name from clients where ${where} and id=$3 and status='Active'`,[...scope(req),engagement.client_id])).rows[0]?.name:null;
    if(engagement.client_id && !clientName)fail(422,'COMMERCIAL_REFERENCE_NOT_FOUND','An active scoped client is required.');
    project=(await client.query(`insert into projects(id,organization_id,legal_entity_id,project_code,name,client_id,client,manager_id,manager_name,project_type,billable,start_date,end_date,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Proposed') returning *,start_date::text,end_date::text`,
      [`p-${randomUUID()}`,...scope(req),input.code,input.name,engagement.client_id,clientName||'Internal initiative',manager.id,manager.name,engagement.model,input.billable,input.startsOn,input.endsOn])).rows[0];
  }
  const row=(await client.query(`insert into commercial_project_bindings(organization_id,legal_entity_id,project_id,engagement_id,contract_id,contract_version_id,code,name,manager_id,starts_on,ends_on,model,currency,budget_allocation,billable,attribution_id,origin,source_snapshot,reason,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20) returning *,starts_on::text,ends_on::text,budget_allocation::text`,
    [...scope(req),project.id,engagement.id,engagement.contract_id,engagement.contract_version_id,input.code,input.name,manager.id,input.startsOn,input.endsOn,engagement.model,engagement.currency,input.budgetAllocation,input.billable,engagement.attribution_id,origin,JSON.stringify(project),input.reason,req.user.sub])).rows[0];
  const lifecycle=await append(client,req,'Project',project.id,row,{state:'Active',contractVersionId:row.contract_version_id,reason:input.reason,approvalReference:null},null,audit);
  return {...projectDto(row),lifecycle};
};
export const getLifecycleHistory=async(client,req,type,id)=>{
  await scopedEntity(client,req,type,id,{lock:false});
  const events=(await client.query(`select *,effective_on::text from commercial_lifecycle_events where ${where} and entity_type=$3 and entity_id=$4 order by sequence desc limit 200`,[...scope(req),type,id])).rows.map(lifecycleDto);
  return {entityType:type,entityId:id,events,limit:200};
};
export const getLifecycleWorkspace=async(client,req)=>{
  const truncated={};const bounded=async(key,sql)=>{const rows=(await client.query(sql,scope(req))).rows;truncated[key]=rows.length>COMMERCIAL_PAGE_SIZE;return rows.slice(0,COMMERCIAL_PAGE_SIZE);};
  const contracts=await bounded('contracts',`select c.id,c.number,c.client_id "clientId",v.id "contractVersionId",v.name,v.starts_on::text "startsOn",v.ends_on::text "endsOn" from commercial_contracts c join lateral(select * from commercial_contract_versions where contract_id=c.id and effective_from<=(now() at time zone 'UTC')::date order by effective_from desc limit 1)v on true where c.organization_id=$1 and c.legal_entity_id=$2 order by c.created_at desc,c.id limit 201`);
  const engagements=await bounded('engagements',`select id,code,name,contract_version_id "contractVersionId",starts_on::text "startsOn",ends_on::text "endsOn",billable,model,client_id "clientId",owner_id "managerId",currency from commercial_engagements where ${where} and origin='manual' order by created_at desc,id limit 201`);
  const projects=(await bounded('projects',`select *,starts_on::text,ends_on::text,budget_allocation::text from commercial_project_bindings where ${where} order by created_at desc,id limit 201`)).map(projectDto);
  const legacyProjects=await bounded('legacyProjects',`select p.id,p.project_code code,p.name,p.client_id "clientId",p.manager_id "managerId",p.start_date::text "startsOn",p.end_date::text "endsOn",p.billable,exists(select 1 from project_engagement_mappings m where m.project_id=p.id) "neutralMapped" from projects p where p.organization_id=$1 and p.legal_entity_id=$2 and p.status='Proposed' and length(trim(p.project_code))>0 and length(trim(p.name))>0 and exists(select 1 from employees manager where manager.id=p.manager_id and manager.organization_id=p.organization_id and manager.legal_entity_id=p.legal_entity_id and manager.status='Active') and not exists(select 1 from commercial_project_bindings b where b.project_id=p.id) order by p.project_code,p.id limit 201`);
  const owners=await bounded('owners',`select id,name from employees where ${where} and status='Active' order by name,id limit 201`);
  const ids=[...contracts,...engagements,...projects].map(row=>row.id);
  const events=(await client.query(`select distinct on(entity_type,entity_id) *,effective_on::text from commercial_lifecycle_events where ${where} and entity_id=any($3::text[]) order by entity_type,entity_id,sequence desc`,[...scope(req),ids])).rows;
  const byId=new Map(events.map(x=>[`${x.entity_type}:${x.entity_id}`,lifecycleDto(x)]));
  for(const [type,rows] of [['Contract',contracts],['Engagement',engagements],['Project',projects]])for(const row of rows)row.lifecycle=byId.get(`${type}:${row.id}`)||null;
  return {asOf:await today(client),contracts,engagements,projects,choices:{legacyProjects,owners},limits:{pageSize:COMMERCIAL_PAGE_SIZE,truncated},
    closure:{available:false,unavailableEvidence:['approved-unbilled register','commercial balances and PO consumption','milestone acceptance and settlement'],message:'Terminal close/delete is not available. Missing evidence is unknown, never assumed zero.'}};
};

// Informative only, never a close decision. Actual existing evidence is counted;
// planned billing/settlement domains remain explicitly unavailable, not zero.
export const getClosureReadiness=async(client,req,type,id)=>{
  const root=await scopedEntity(client,req,type,id,{lock:false});
  let engagementIds=[];let projectIds=[];
  if(type==='Contract')engagementIds=(await client.query(`select id from commercial_engagements where ${where} and contract_id=$3`,[...scope(req),id])).rows.map(x=>x.id);
  else engagementIds=[type==='Engagement'?id:root.engagement_id];
  projectIds=type==='Project'?[id]:(await client.query(`select project_id from commercial_project_bindings where ${where} and engagement_id=any($3::text[])`,[...scope(req),engagementIds])).rows.map(x=>x.project_id);
  const result=(await client.query(`select
    (select count(*)::int from project_allocations where organization_id=$1 and legal_entity_id=$2 and project_id=any($3::text[]) and status<>'Completed') "openAssignments",
    (select count(*)::int from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.organization_id=$1 and t.legal_entity_id=$2 and e.project_id=any($3::text[]) and t.status in('Draft','Submitted')) "draftSubmittedWorkLines",
    (select count(distinct a.id)::int from approval_records a join timesheets t on a.entity_type='Timesheet' and a.entity_id=t.id::text join timesheet_entries e on e.timesheet_id=t.id where t.organization_id=$1 and t.legal_entity_id=$2 and e.project_id=any($3::text[]) and a.status='Pending') "pendingTimesheetApprovals",
    (select count(*)::int from commercial_milestones where organization_id=$1 and legal_entity_id=$2 and engagement_id=any($4::text[])) "unacceptedMilestones",
    (select count(*)::int from commercial_purchase_orders where organization_id=$1 and legal_entity_id=$2 and contract_id=$5) "draftPurchaseOrders"`,
    [...scope(req),projectIds,engagementIds,type==='Contract'?id:root.contract_id])).rows[0];
  const ownerId=type==='Contract'?null:(type==='Engagement'?root.owner_id:root.manager_id);
  const ownerActive=ownerId?Boolean((await client.query(`select 1 from employees where ${where} and id=$3 and status='Active' and (joining_date is null or joining_date<=$4) and (exit_date is null or exit_date>=$5)`,[...scope(req),ownerId,root.starts_on,root.ends_on])).rowCount):null;
  return {entityType:type,entityId:id,available:false,checkedOn:await today(client),evidence:{...result,ownerActive},
    unavailableEvidence:['approved-unbilled register','commercial balances and PO consumption','milestone acceptance and settlement'],
    message:'Terminal close/delete is unavailable even when existing counts are zero. Missing domains are unknown, not zero; counts do not authorize closure.'};
};
