import {createHash,randomUUID} from 'node:crypto';
import {fail} from './contracts.mjs';
import {getContract} from './service.mjs';
import {getLifecycle} from './lifecycle-service.mjs';
import {lockCommercialLifecycle} from './project-mutation.mjs';
import {resolveAmendedTerms,applyAmendedSnapshot} from './amendment-terms.mjs';
const scope=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const where='organization_id=$1 and legal_entity_id=$2';
const today=async client=>(await client.query("select (clock_timestamp() at time zone 'UTC')::date::text today")).rows[0].today;
const units=value=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));};
const eventDto=row=>({id:row.id,sequence:row.sequence,effectiveOn:row.effective_on,contractVersionId:row.contract_version_id,
 startsOn:row.starts_on,endsOn:row.ends_on,budget:row.budget,
 ...(row.after_value?.terms?.laborCostBudget!==undefined?{laborCostBudget:row.after_value.terms.laborCostBudget}:{}),reason:row.reason,approvalReference:row.approval_reference,
 actorId:row.actor_id,activeRole:row.active_role,correlationId:row.correlation_id,operationId:row.operation_id,
 before:row.before_value,after:row.after_value});
const readRoot=async(client,req,type,id)=>{
 const table={Contract:'commercial_contracts',Engagement:'commercial_engagements',Project:'commercial_project_bindings'}[type];
 if(!table)fail(404,'COMMERCIAL_NOT_FOUND','The scoped amendment record was not found.');
 const root=(await client.query(`select *${type==='Contract'?'':',starts_on::text,ends_on::text,'+(type==='Project'?'budget_allocation':'budget')+'::text'} from ${table} where ${where} and ${type==='Project'?'project_id':'id'}=$3`,[...scope(req),id])).rows[0];
 if(!root || (type!=='Contract' && (!root.contract_id || root.origin==='legacy-neutral')))fail(404,'COMMERCIAL_NOT_FOUND','A governed commercial contract record is required. Internal and neutral records are not amended here.');
 const lifecycle=await getLifecycle(client,req,type,id);
 if(!lifecycle)fail(409,'COMMERCIAL_AMENDMENT_NOT_GOVERNED','Activate the immutable draft before proposing governed amendments.');
 const contract=await getContract(client,req,type==='Contract'?id:root.contract_id);
 const activation=type==='Contract'?contract.versions.find(x=>x.id===lifecycle.contractVersionId):null;
 const activationTerms=type==='Contract'?{contractVersionId:activation.id,startsOn:activation.startsOn,endsOn:activation.endsOn,budget:activation.value}:
  {contractVersionId:root.contract_version_id,startsOn:root.starts_on,endsOn:root.ends_on,budget:type==='Project'?root.budget_allocation:root.budget};
 const history=(await client.query(`select *,effective_on::text,starts_on::text,ends_on::text,budget::text from commercial_amendments where ${where} and entity_type=$3 and entity_id=$4 order by sequence desc limit 200`,[...scope(req),type,id])).rows.map(eventDto);
 return {root,lifecycle,contract,activationTerms,history};
};
export const getAmendmentWorkspace=async(client,req,type,id)=>{
 const {root,lifecycle,contract,activationTerms,history}=await readRoot(client,req,type,id);const date=await today(client);
 return {asOf:date,entityType:type,entityId:id,lifecycle,sequence:history[0]?.sequence||0,
  currentTerms:await resolveAmendedTerms(client,req,type,id,activationTerms,date),activationTerms,
  identity:{name:type==='Contract'?contract.number:root.name,model:type==='Contract'?contract.versions[0].model:root.model,
   currency:type==='Contract'?contract.versions[0].currency:root.currency,clientId:contract.clientId},
  latestContractVersion:contract.latestVersion,versions:contract.versions,history,pending:Boolean(history[0]&&history[0].effectiveOn>date)};
};
const parentTerms=async(client,req,type,id,date)=>{
 const parent=await readRoot(client,req,type,id);
 if(parent.lifecycle.state!=='Active')fail(409,'COMMERCIAL_PARENT_NOT_ACTIVE','The parent must currently be Active. No state or child terms change implicitly.');
 if(parent.history.some(x=>x.effectiveOn>date))fail(409,'COMMERCIAL_AMENDMENT_PARENT_TERMS','A later pending parent amendment must take effect first, or adopt the parent target on or after its effective date.');
 return {terms:await resolveAmendedTerms(client,req,type,id,parent.activationTerms,date),lifecycle:parent.lifecycle,history:parent.history};
};
const dependencySnapshot=async(client,req,type,id,effectiveOn)=>{
 let engagements=[];let projects=[];
 if(type==='Contract')engagements=(await client.query(`select e.*,e.starts_on::text,e.ends_on::text,e.budget::text from commercial_engagements e where e.organization_id=$1 and e.legal_entity_id=$2 and e.contract_id=$3 and exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=e.id) order by e.id limit 201`,[...scope(req),id])).rows;
 if(type!=='Project')projects=(await client.query(`select *,starts_on::text,ends_on::text,budget_allocation::text from commercial_project_bindings where ${where} and ${type==='Contract'?'contract_id':'engagement_id'}=$3 order by project_id limit 201`,[...scope(req),id])).rows;
 if(engagements.length>200||projects.length>200)fail(409,'COMMERCIAL_AMENDMENT_LIMIT','The complete dependency set exceeds this bounded amendment command. No partial amendment is allowed.');
 for(let i=0;i<engagements.length;i++)engagements[i]=await applyAmendedSnapshot(client,req,'Engagement',engagements[i].id,engagements[i],effectiveOn);
 for(let i=0;i<projects.length;i++)projects[i]=await applyAmendedSnapshot(client,req,'Project',projects[i].project_id,projects[i],effectiveOn);
 return {engagements,projects};
};
const validate=async(client,req,type,id,input)=>{
 await lockCommercialLifecycle(client,req.organizationScope);
 const data=await readRoot(client,req,type,id);const {root,lifecycle,contract,activationTerms,history}=data;const date=await today(client);
 if(input.expectedSequence!==(history[0]?.sequence||0)||input.expectedLifecycleSequence!==lifecycle.sequence||input.expectedContractVersion!==contract.latestVersion)
  fail(409,'COMMERCIAL_AMENDMENT_CONFLICT','Commercial terms or lifecycle changed. Reload and preview again.');
 if(input.effectiveOn<date || (history[0] && (history[0].effectiveOn>=input.effectiveOn||history[0].effectiveOn>date)))
  fail(409,'COMMERCIAL_AMENDMENT_DATE_CONFLICT','Use a current or future UTC date later than prior amendments. Only one pending amendment is permitted.');
 const before=await resolveAmendedTerms(client,req,type,id,activationTerms,input.effectiveOn);
 const oldTerm=contract.versions.find(x=>x.id===before.contractVersionId);const target=contract.versions.find(x=>x.id===input.contractVersionId);
 if(!target || target.version<=oldTerm.version)fail(409,'COMMERCIAL_AMENDMENT_PIN_CONFLICT','Select a newer immutable version of this same scoped contract.');
 if(target.model!==oldTerm.model || target.currency!==oldTerm.currency || (type!=='Contract'&&(target.model!==root.model||target.currency!==root.currency||contract.clientId!==root.client_id&&type==='Engagement')))
  fail(422,'COMMERCIAL_TERMS_MISMATCH','Amendments cannot replace the client, commercial model, currency or scoped contract identity.');
 if(input.effectiveOn<target.effectiveFrom||input.effectiveOn<target.startsOn||input.endsOn>target.endsOn)
  fail(422,'COMMERCIAL_TERMS_MISMATCH','The amendment effective date and remaining term must fit the selected immutable contract version.');
 let parent=null;
 if(type==='Contract'){
  if(input.startsOn!==target.startsOn||input.endsOn!==target.endsOn||units(input.budget)!==units(target.value))fail(422,'COMMERCIAL_TERMS_MISMATCH','Contract adoption must use the exact selected immutable version dates and value.');
 }else{
  if(input.startsOn!==before.startsOn)fail(422,'COMMERCIAL_AMENDMENT_HISTORY_CONFLICT','The historical start is immutable. Amend only remaining dates and budget from the effective date.');
  parent=await parentTerms(client,req,type==='Engagement'?'Contract':'Engagement',type==='Engagement'?root.contract_id:root.engagement_id,input.effectiveOn);
  if(parent.terms.contractVersionId!==input.contractVersionId || input.effectiveOn<parent.terms.startsOn || input.endsOn>parent.terms.endsOn)
   fail(409,'COMMERCIAL_AMENDMENT_PARENT_TERMS','The parent must explicitly adopt this version and cover the remaining term first.');
  const owner=(await client.query(`select id from employees where ${where} and id=$3 and status='Active' and (joining_date is null or joining_date<=$4) and (exit_date is null or exit_date>=$5) for share`,[...scope(req),type==='Project'?root.manager_id:root.owner_id,input.effectiveOn,input.endsOn])).rows[0];
  if(!owner)fail(422,'COMMERCIAL_OWNER_UNAVAILABLE','An active scoped owner must cover the remaining amended term.');
 }
 const activeClient=(await client.query(`select id from clients where ${where} and id=$3 and status='Active' for share`,[...scope(req),contract.clientId])).rows[0];
 if(!activeClient)fail(422,'COMMERCIAL_REFERENCE_NOT_FOUND','An active scoped client is required.');
 const dependencies=await dependencySnapshot(client,req,type,id,input.effectiveOn);
 const children=type==='Contract'?dependencies.engagements:dependencies.projects;
 if(children.some(x=>x.ends_on>input.endsOn && x.ends_on>=input.effectiveOn))fail(409,'COMMERCIAL_AMENDMENT_DEPENDENCIES','Remaining governed child dates must fit the amended parent. No child is rewritten implicitly.');
 const allocation=children.filter(x=>x.ends_on>=input.effectiveOn).reduce((n,x)=>n+units(type==='Contract'?x.budget:x.budget_allocation),0n);
 if(allocation>units(input.budget))fail(422,'COMMERCIAL_AMENDMENT_BUDGET_EXCEEDED','Existing remaining child allocations exceed the proposed budget. This is allocation, not consumption or billing.');
 // New child adoption must fit all sibling current/pending allocation envelopes,
 // not just its own children. Conservative maxima do not invent consumption or
 // release allocation before a scheduled reduction actually takes effect.
 if(type!=='Contract'){
  const project=type==='Project';const siblingType=project?'Project':'Engagement';
  const siblings=(await client.query(`select *,starts_on::text,ends_on::text,${project?'budget_allocation':'budget'}::text from ${project?'commercial_project_bindings':'commercial_engagements'} where ${where} and ${project?'engagement_id':'contract_id'}=$3 and ${project?'project_id':'id'}<>$4${project?'':" and origin='manual' and exists(select 1 from commercial_lifecycle_events l where l.entity_type='Engagement' and l.entity_id=commercial_engagements.id)"} order by ${project?'project_id':'id'} limit 201`,[...scope(req),project?root.engagement_id:root.contract_id,id])).rows;
  if(siblings.length>200)fail(409,'COMMERCIAL_AMENDMENT_LIMIT','The complete sibling set exceeds this bounded amendment command.');
  let total=units(input.budget);const siblingSnapshots=[];
  for(const sibling of siblings){
   const sid=project?sibling.project_id:sibling.id;const current=await applyAmendedSnapshot(client,req,siblingType,sid,sibling,input.effectiveOn);
   const pending=(await client.query(`select *,effective_on::text,starts_on::text,ends_on::text,budget::text from commercial_amendments where ${where} and entity_type=$3 and entity_id=$4 and effective_on>$5 order by sequence`,[...scope(req),siblingType,sid,input.effectiveOn])).rows;
   siblingSnapshots.push(current);
   let reserved=current.ends_on>=input.effectiveOn?units(project?current.budget_allocation:current.budget):0n;
   for(const event of pending)if(units(event.budget)>reserved)reserved=units(event.budget);
   total+=reserved;dependencies.siblingAmendments??=[];dependencies.siblingAmendments.push(...pending);
  }
  if(total>units(parent.terms.budget))fail(422,'COMMERCIAL_AMENDMENT_BUDGET_EXCEEDED','Remaining current or pending sibling allocations exceed the explicitly adopted parent budget.');
  dependencies.siblings=siblingSnapshots;
 }
 const descendantIds=[...dependencies.engagements.map(x=>x.id),...dependencies.projects.map(x=>x.project_id)];
 if(descendantIds.length && (await client.query(`select 1 from commercial_amendments where ${where} and entity_id=any($3::text[]) and effective_on>$4 limit 1`,[...scope(req),descendantIds,input.effectiveOn])).rowCount)
  fail(409,'COMMERCIAL_AMENDMENT_DEPENDENCIES','A later pending child amendment must take effect before replacing this parent term. No pending child snapshot is overwritten.');
 const engagementIds=type==='Engagement'?[id]:dependencies.engagements.map(x=>x.id);
 if((await client.query(`select 1 from commercial_milestones where ${where} and engagement_id=any($3::text[]) and due_on>$4 and due_on>=$5 limit 1`,[...scope(req),engagementIds,input.endsOn,input.effectiveOn])).rowCount)
  fail(409,'COMMERCIAL_AMENDMENT_DEPENDENCIES','An existing future milestone extends beyond the proposed remaining term.');
 const projectIds=type==='Project'?[id]:dependencies.projects.map(x=>x.project_id);
 const blocked=(await client.query(`select exists(select 1 from project_allocations where organization_id=$1 and legal_entity_id=$2 and project_id=any($3::text[]) and end_date>$4 and end_date>=$5 and status<>'Completed') or exists(select 1 from timesheet_entries e join timesheets t on t.id=e.timesheet_id where t.organization_id=$1 and t.legal_entity_id=$2 and e.project_id=any($3::text[]) and e.work_date>$4 and e.work_date>=$5) blocked`,[...scope(req),projectIds,input.endsOn,input.effectiveOn])).rows[0];
 if(blocked.blocked)fail(409,'COMMERCIAL_AMENDMENT_DEPENDENCIES','Existing future assignments or work extend beyond the proposed remaining term.');
 if (input.laborCostBudget!==undefined && (type!=='Engagement' || root.model!=='fixed_fee'))
  fail(422,'COMMERCIAL_TERMS_MISMATCH','A labor-cost budget requires a fixed-fee engagement.');
 const laborCostBudget=input.laborCostBudget??before.laborCostBudget;
 const after={...(laborCostBudget===undefined?{}:{laborCostBudget}),contractVersionId:input.contractVersionId,startsOn:input.startsOn,endsOn:input.endsOn,budget:input.budget};
 const preview={asOf:date,entityType:type,entityId:id,before,after,effectiveOn:input.effectiveOn,dependencies:{projects:dependencies.projects.length},
  warnings:['No child terms, immutable activation pin, accepted work, valuation, PO consumption or billing is changed. Work-date and assignment-policy enforcement is a separate workstream.']};
 const token=createHash('sha256').update(JSON.stringify({scope:scope(req),actor:req.user.sub,role:req.user.activeRole,input,preview,lifecycle,parent,dependencies,contractVersion:contract.latestVersion,target})).digest('hex');
 return {preview:{previewToken:token,...preview},data,target,dependencies};
};
export const previewAmendment=async(client,req,type,id,input)=>(await validate(client,req,type,id,input)).preview;
export const appendAmendment=async(client,req,type,id,input,audit)=>{
 const {previewToken,...fields}=input;const {preview,data,target}=await validate(client,req,type,id,fields);
 if(previewToken!==preview.previewToken)fail(409,'COMMERCIAL_AMENDMENT_PREVIEW_CONFLICT','The authoritative preview changed or is invalid. Preview again before confirming.');
 const eventId=`amendment-${randomUUID()}`;
 const row=(await client.query(`insert into commercial_amendments(id,organization_id,legal_entity_id,entity_type,entity_id,contract_id,contract_version_id,sequence,lifecycle_sequence,contract_version,effective_on,starts_on,ends_on,budget,before_value,after_value,reason,approval_reference,actor_id,active_role,correlation_id,operation_id)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22) returning *,effective_on::text,starts_on::text,ends_on::text,budget::text`,
 [eventId,...scope(req),type,id,data.contract.id,input.contractVersionId,input.expectedSequence+1,data.lifecycle.sequence,data.contract.latestVersion,input.effectiveOn,input.startsOn,input.endsOn,input.budget,
 JSON.stringify({terms:preview.before,contractTerms:data.contract.versions.find(x=>x.id===preview.before.contractVersionId),lifecycle:data.lifecycle,activationTerms:data.activationTerms}),JSON.stringify({terms:preview.after,contractTerms:target,preview}),input.reason,input.approvalReference,req.user.sub,req.user.activeRole,req.correlationId,req.operationId])).rows[0];
 await audit(client,req,{module:'Commercial Amendments',action:'Append Amendment',entityType:type,entityId:id,oldValue:{commercialEventId:eventId,snapshot:'before'},
  newValue:{commercialEventId:eventId,snapshot:'after'},reason:'Commercial amendment; protected material evidence retained.',source:'Web',details:'Opaque amendment pointer only. Commercial access is required for material evidence.'});
 return eventDto(row);
};
