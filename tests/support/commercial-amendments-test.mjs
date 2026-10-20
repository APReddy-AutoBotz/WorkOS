// Synthetic fixtures for mandatory amendment persistence and real-browser gates.
// Every database is randomized and loopback-only through commercial-drafting-test.
import assert from 'node:assert/strict';
import {commercialFixture as f} from './commercial-drafting-test.mjs';

export const amendmentPermissions=Object.freeze(['commercial.contracts.view','commercial.contracts.manage','commercial.lifecycle.manage','commercial.amendments.manage']);
export const amendmentScope=Object.freeze({organizationId:f.organizationId,legalEntityId:f.legalEntityId});
export const amendmentMarker='SYNTHETIC-PROTECTED-AMENDMENT-984C';
export const amendmentTables=Object.freeze(['commercial_contracts','commercial_contract_versions','commercial_engagements','commercial_project_bindings',
  'commercial_lifecycle_events','commercial_draft_events','project_engagement_mappings','commercial_purchase_orders','commercial_milestones',
  'project_allocations','timesheets','timesheet_entries','approval_records']);
export const amendmentSnapshot=async(pool,tables=amendmentTables)=>{
  const output={};for(const table of tables)output[table]=(await pool.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
  return output;
};
export const amendmentCounts=async pool=>(await pool.query(`select
  (select count(*)::int from commercial_amendments) events,
  (select count(*)::int from audit_logs) audits,
  (select count(*)::int from commercial_lifecycle_events) lifecycle,
  (select count(*)::int from commercial_project_bindings) bindings`)).rows[0];
export const amendmentToday=async pool=>(await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
export const addUtcDays=(date,days)=>{const value=new Date(`${date}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);};
export const amendmentContractInput=(code,overrides={})=>({number:code,clientId:f.clientId,name:'Synthetic governed amendment contract',model:'fixed_fee',
  startsOn:'2020-01-01',endsOn:'2098-12-31',effectiveFrom:'2020-01-01',currency:'GBP',value:'25000.0001',
  billingTerms:`${amendmentMarker} billing metadata`,documents:[{name:'Synthetic private contract metadata',url:'https://example.test/synthetic-amendment.pdf'}],
  reason:`${amendmentMarker} draft setup`,...overrides});
export const amendmentEngagementInput=(code,contract,overrides={})=>({code,name:'Synthetic governed amendment engagement',model:contract.versions[0].model,
  ownerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',currency:contract.versions[0].currency,budget:'10000.0001',
  contractId:contract.id,contractVersionId:contract.versions[0].id,clientId:contract.clientId,attributionId:null,
  reason:`${amendmentMarker} engagement setup`,...overrides});
export const amendmentPost=async(request,path,body,options={})=>{
  const result=await request(path,{method:'POST',body,...options});assert.equal(result.status,201,`${path}: ${JSON.stringify(result.body)}`);return result.body;
};
export const amendmentTransition=async(request,type,id,sequence,pin,state='Active')=>amendmentPost(request,`/lifecycle/${type}/${id}/transitions`,
  {expectedSequence:sequence,state,contractVersionId:pin,reason:`${amendmentMarker} ${state}`,approvalReference:null});
export const grantAmendmentPermissions=async pool=>pool.query(`insert into role_permissions(role_name,permission_key,enabled)
  select 'Admin',key,true from unnest($1::text[]) key on conflict(role_name,permission_key) do update set enabled=true`,[amendmentPermissions]);
export const createAmendmentHierarchy=async(request,code='SYN-AMENDMENT',overrides={})=>{
  const contract=await amendmentPost(request,'/contracts',amendmentContractInput(`${code}-C`,overrides.contract));
  const pin=contract.versions[0].id;
  const engagement=await amendmentPost(request,'/engagements',amendmentEngagementInput(`${code}-E`,contract,overrides.engagement));
  await amendmentTransition(request,'Contract',contract.id,0,pin);
  await amendmentTransition(request,'Engagement',engagement.id,0,pin);
  const project=await amendmentPost(request,'/lifecycle/projects',{engagementId:engagement.id,projectId:null,code:`${code}-P`,
    name:'Synthetic governed amendment project',managerId:f.ownerId,startsOn:'2020-01-01',endsOn:'2098-12-31',billable:true,
    budgetAllocation:'4000.0001',reason:`${amendmentMarker} project setup`,...overrides.project});
  return {contract,engagement,project,pin};
};
// Model an already-published immutable term becoming applicable today. The
// regular revision command intentionally permits only future publications, so
// this fixture inserts a synthetic version after v1 activation, then advances
// only the sequential root pointer in one transaction. It never disables a
// trigger, changes an activation pin, edits history or uses a production DB.
export const seedApplicableAmendmentVersion=async(pool,identity,contract,effectiveFrom,overrides={})=>{
  const old=contract.versions[0];
  const data={...old,version:contract.latestVersion+1,effectiveFrom,endsOn:'2099-12-31',value:'30000.0002',...overrides};
  const client=await pool.connect();
  try{
    await client.query('begin');
    const row=(await client.query(`insert into commercial_contract_versions
      (organization_id,legal_entity_id,contract_id,version,effective_from,name,model,starts_on,ends_on,currency,value,billing_terms,documents,reason,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
      returning id,version,effective_from::text "effectiveFrom",name,model,starts_on::text "startsOn",ends_on::text "endsOn",currency,value::text,billing_terms "billingTerms",documents`,
    [f.organizationId,f.legalEntityId,contract.id,data.version,data.effectiveFrom,data.name,data.model,data.startsOn,data.endsOn,data.currency,data.value,
      data.billingTerms,JSON.stringify(data.documents),`${amendmentMarker} published synthetic version`,identity.id])).rows[0];
    await client.query('update commercial_contracts set latest_version=latest_version+1 where id=$1',[contract.id]);
    await client.query('commit');return row;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};
export const amendmentWorkspace=async(request,type,id,options={})=>{
  const result=await request(`/amendments/${type}/${id}`,options);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
};
export const amendmentInput=(workspace,version,overrides={})=>({expectedSequence:workspace.sequence,expectedLifecycleSequence:workspace.lifecycle.sequence,
  expectedContractVersion:workspace.latestContractVersion,contractVersionId:version.id,effectiveOn:version.effectiveFrom,
  startsOn:workspace.currentTerms.startsOn,endsOn:version.endsOn,budget:workspace.entityType==='Contract'?version.value:workspace.currentTerms.budget,
  reason:`${amendmentMarker} adoption reason`,approvalReference:`${amendmentMarker}-APPROVAL`,...overrides});
export const amendmentPreview=async(request,type,id,input,options={})=>{
  const result=await request(`/amendments/${type}/${id}/preview`,{method:'POST',body:input,...options});
  assert.equal(result.status,201,JSON.stringify(result.body));assert.match(result.body.previewToken,/^[a-f0-9]{64}$/);return result.body;
};
export const amendmentApply=async(request,type,id,input,options={})=>{
  const preview=await amendmentPreview(request,type,id,input,options);
  return amendmentPost(request,`/amendments/${type}/${id}`,{...input,previewToken:preview.previewToken},options);
};
export const assertAmendmentError=(result,status,code)=>{
  assert.equal(result.status,status,JSON.stringify(result.body));if(code)assert.equal(result.body.error?.code,code);
  assert.ok(result.body.error?.message);assert.equal(result.body.id,undefined);
  assert.doesNotMatch(JSON.stringify(result.body),/postgres(?:ql)?:\/\/|insert into|select .* from|constraint .* violates/i,'safe errors do not disclose persistence details');
  if(result.response){assert.ok(result.response.headers.get('x-correlation-id'));assert.equal(result.body.error.correlationId,result.response.headers.get('x-correlation-id'));}
};
