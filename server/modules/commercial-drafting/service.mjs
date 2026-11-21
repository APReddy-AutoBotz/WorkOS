import {applyAmendedSnapshot} from './amendment-terms.mjs';
import {randomUUID} from 'node:crypto';
import {resolveOrganizationScope} from '../../organization-setup.mjs';
import {COMMERCIAL_PAGE_SIZE,fail} from './contracts.mjs';

const scopeValues = req => [req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const scopeWhere = 'organization_id=$1 and legal_entity_id=$2';
const termsProjection = `id,contract_id,version,effective_from::text,name,model,starts_on::text,ends_on::text,currency,value::text,billing_terms,documents`;
export const termsDto = row => row ? ({id:row.id,version:row.version,effectiveFrom:row.effective_from,name:row.name,model:row.model,
  startsOn:row.starts_on,endsOn:row.ends_on,currency:row.currency,value:row.value,billingTerms:row.billing_terms,documents:row.documents,...(row.retainer_overage_policy ? {retainerOveragePolicy:row.retainer_overage_policy} : {}),...(row.retainer_capacity_policy ? {retainerCapacityPolicy:row.retainer_capacity_policy} : {}),...(row.retainer_periods?.length ? {retainerPeriods:row.retainer_periods} : {}),...(row.installments?.length ? {installments:row.installments} : {})}) : null;
const engagementDto = row => ({id:row.id,code:row.code,name:row.name,model:row.model,clientId:row.client_id,contractId:row.contract_id,
  contractVersionId:row.contract_version_id,ownerId:row.owner_id,attributionId:row.attribution_id,startsOn:row.starts_on,endsOn:row.ends_on,
  currency:row.currency,budget:row.budget,billable:row.billable,status:row.status,origin:row.origin});
const purchaseOrderDto = row => ({id:row.id,contractId:row.contract_id,contractVersionId:row.contract_version_id,number:row.number,value:row.value,
  currency:row.currency,startsOn:row.starts_on,endsOn:row.ends_on,warningThresholdPercent:row.warning_threshold_percent,status:row.status});
const milestoneDto = row => ({id:row.id,engagementId:row.engagement_id,code:row.code,name:row.name,dueOn:row.due_on,amount:row.amount,
  currency:row.currency,status:row.status,billingEligible:false});
const engagementProjection = `*,starts_on::text,ends_on::text,budget::text`;
const poProjection = `*,starts_on::text,ends_on::text,value::text,warning_threshold_percent::text`;
const milestoneProjection = `*,due_on::text,amount::text`;

// This new confidential module has explicit opt-in permissions, no role default
// or test fallback. It does not alter any existing identity/audit endpoint.
export const assertCommercialAuthority = async (client,req,permission) => {
  const scope=await resolveOrganizationScope(client,req);
  if (scope.organizationId!==req.organizationScope?.organizationId || scope.legalEntityId!==req.organizationScope?.legalEntityId)
    fail(403,'COMMERCIAL_SCOPE_CHANGED','The selected commercial scope is no longer authorized.');
  const result=await client.query(`select u.id from users u join user_roles ur on ur.user_id=u.id
    join roles r on r.id=ur.role_id where u.id=$1 and u.status='Active' and r.name=$2
    and (exists(select 1 from role_permissions rp where rp.role_name=r.name and rp.permission_key=$3 and rp.enabled=true)
      or exists(select 1 from user_permission_grants g where g.user_id=u.id and g.permission_key=$3))
    for share of u,ur,r`,[req.user.sub,req.user.activeRole,permission]);
  if(result.rowCount!==1) fail(403,'COMMERCIAL_PERMISSION_DENIED','Explicit commercial permission and a currently assigned role are required.');
};
const utcToday = async client => (await client.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
export const getContract = async (client,req,id,{lock=false}={}) => {
  const root=(await client.query(`select id,number,client_id,latest_version,status from commercial_contracts where ${scopeWhere} and id=$3${lock?' for update':''}`,[...scopeValues(req),id])).rows[0];
  if(!root)fail(404,'COMMERCIAL_NOT_FOUND','The scoped commercial record was not found.');
  const versions=(await client.query(`select *,effective_from::text,starts_on::text,ends_on::text,value::text from commercial_contract_versions where ${scopeWhere} and contract_id=$3 order by version desc limit 200`,[...scopeValues(req),id])).rows.map(termsDto);
  return {id:root.id,number:root.number,clientId:root.client_id,latestVersion:root.latest_version,status:root.status,versions};
};
const auditCommand = async (audit,client,req,type,id,before,after,reason) => {
  const eventId=`commercial-event-${randomUUID()}`;
  const action=before?'Append Version':'Create Draft';
  await client.query(`insert into commercial_draft_events
    (id,organization_id,legal_entity_id,actor_id,active_role,source,entity_type,entity_id,action,before_value,after_value,reason,correlation_id,operation_id)
    values($1,$2,$3,$4,$5,'Web',$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
  [eventId,...scopeValues(req),req.user.sub,req.user.activeRole,type,id,action,before?JSON.stringify(before):null,JSON.stringify(after),reason,req.correlationId,req.operationId]);
  // Existing general audit readers intentionally receive no confidential values,
  // descriptions, document URLs or user-entered reasons from this module.
  await audit(client,req,{module:'Commercial Drafting',action,entityType:type,entityId:id,
    oldValue:before?{commercialEventId:eventId,snapshot:'before'}:null,
    newValue:{commercialEventId:eventId,snapshot:'after'},reason:'Commercial operation; protected material evidence retained.',
    source:'Web',details:'Draft only; no acceptance or billing eligibility. Material evidence requires commercial access.'});
};
const insertTerms = async (client,req,id,version,data) => {
  const columns = [], extraValues = [];
  for (const [column, rows] of [['installments', data.installments], ['retainer_periods', data.retainerPeriods]]) {
    if (rows?.length) {
      columns.push(column);
      extraValues.push(JSON.stringify(rows));
    }
  }
  if (data.retainerOveragePolicy) {
    columns.push('retainer_overage_policy');
    extraValues.push(data.retainerOveragePolicy);
  }
  if (data.retainerCapacityPolicy) {
    columns.push('retainer_capacity_policy');
    extraValues.push(data.retainerCapacityPolicy);
  }
  const extraColumns = columns.map(column => ',' + column).join('');
  const extraParameters = columns.map((column, index) => ',$' + (16 + index) + (column.endsWith('_policy') ? '::text' : '::jsonb')).join('');
  const result=await client.query(`insert into commercial_contract_versions
    (organization_id,legal_entity_id,contract_id,version,effective_from,name,model,starts_on,ends_on,currency,value,billing_terms,documents,reason,created_by${extraColumns})
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15${extraParameters}) returning ${termsProjection}`,
  [...scopeValues(req),id,version,data.effectiveFrom,data.name,data.model,data.startsOn,data.endsOn,data.currency,data.value,data.billingTerms,JSON.stringify(data.documents),data.reason,req.user.sub,...extraValues]);
  return termsDto(result.rows[0]);
};
const scopedClient = async (client,req,id) => {
  const result=await client.query(`select id from clients where ${scopeWhere} and id=$3 and status='Active' for share`,[...scopeValues(req),id]);
  if(result.rowCount!==1)fail(404,'COMMERCIAL_REFERENCE_NOT_FOUND','An active client in the selected scope is required.');
};
export const createContract = async (client,req,data,audit) => {
  await scopedClient(client,req,data.clientId);
  const id=`contract-${randomUUID()}`;
  await client.query(`insert into commercial_contracts(id,organization_id,legal_entity_id,client_id,number,created_by) values($1,$2,$3,$4,$5,$6)`,[id,...scopeValues(req),data.clientId,data.number,req.user.sub]);
  await insertTerms(client,req,id,1,data);
  const result=await getContract(client,req,id);
  await auditCommand(audit,client,req,'Contract',id,null,result,data.reason);
  return result;
};
export const appendContractVersion = async (client,req,id,data,audit) => {
  const before=await getContract(client,req,id,{lock:true});
  if(before.latestVersion!==data.expectedVersion)fail(409,'COMMERCIAL_VERSION_CONFLICT','Contract terms changed. Reload the latest version before revising.');
  const latest=before.versions[0];
  if(data.effectiveFrom<=latest.effectiveFrom || data.effectiveFrom<=await utcToday(client))
    fail(409,'COMMERCIAL_EFFECTIVE_DATE_CONFLICT','A revision must start after both the latest version and the current UTC date.');
  if(data.model!==latest.model || data.currency!==latest.currency)
    fail(409,'COMMERCIAL_IDENTITY_CONFLICT','Changing a contract model or currency requires a separate contract, not a draft revision.');
  const installments = data.installments ?? before.versions[0].installments;
  await insertTerms(client,req,id,before.latestVersion+1,{...data,installments,
    retainerOveragePolicy:data.retainerOveragePolicy === undefined ? latest.retainerOveragePolicy : data.retainerOveragePolicy,
    retainerCapacityPolicy:data.retainerCapacityPolicy === undefined ? latest.retainerCapacityPolicy : data.retainerCapacityPolicy,
    retainerPeriods:data.retainerPeriods ?? latest.retainerPeriods});
  await client.query(`update commercial_contracts set latest_version=latest_version+1 where ${scopeWhere} and id=$3`,[...scopeValues(req),id]);
  const result=await getContract(client,req,id);
  await auditCommand(audit,client,req,'Contract',id,before,result,data.reason);
  return result;
};
const contractTerms = async (client,req,data,{requireApplicable=true}={}) => {
  const row=(await client.query(`select ${termsProjection} from commercial_contract_versions where ${scopeWhere} and contract_id=$3 and id=$4`,[...scopeValues(req),data.contractId,data.contractVersionId])).rows[0];
  if(!row)fail(404,'COMMERCIAL_REFERENCE_NOT_FOUND','A contract term version in the selected scope is required.');
  if(row.currency!==data.currency || data.startsOn<row.starts_on || data.endsOn>row.ends_on || data.startsOn<row.effective_from)
    fail(422,'COMMERCIAL_TERMS_MISMATCH','Dates and currency must fit the pinned contract term version.');
  // Resolve the term version at the new draft's start, not merely any historical ID.
  const applicable=(await client.query(`select id from commercial_contract_versions where ${scopeWhere} and contract_id=$3 and effective_from<=$4 order by effective_from desc limit 1`,[...scopeValues(req),data.contractId,data.startsOn])).rows[0];
  if(requireApplicable && applicable?.id!==row.id)fail(409,'COMMERCIAL_TERMS_SUPERSEDED','Select the contract version effective on the draft start date.');
  return row;
};
export const validateEngagementReferences = async (client,req,data,options) => {
  const internal=['internal','pre_sales'].includes(data.model);
  const owner=(await client.query(`select id from employees where ${scopeWhere} and id=$3 and status='Active' and (joining_date is null or joining_date<=$4) and (exit_date is null or exit_date>=$5) for share`,[...scopeValues(req),data.ownerId,data.startsOn,data.endsOn])).rows[0];
  if(!owner)fail(404,'COMMERCIAL_REFERENCE_NOT_FOUND','An active owner in the selected scope and dates is required.');
  if(internal){
    if(data.contractId!==null || data.contractVersionId!==null || !data.attributionId)
      fail(422,'COMMERCIAL_INTERNAL_POLICY','Internal and pre-sales drafts require attribution, no contract, and remain non-billable.');
    if(data.clientId)await scopedClient(client,req,data.clientId);
    const attribution=(await client.query(`select id from organization_catalog_items where organization_id=$1 and (legal_entity_id=$2 or legal_entity_id is null)
      and id=$3 and catalog_type in('business_unit','cost_centre') and active=true and effective_from<=$4 and (effective_to is null or effective_to>=$5) for share`,
    [...scopeValues(req),data.attributionId,data.startsOn,data.endsOn])).rows[0];
    if(!attribution)fail(404,'COMMERCIAL_REFERENCE_NOT_FOUND','An active scoped business unit or cost centre covering the dates is required.');
  }else{
    if(!data.clientId || !data.contractId || !data.contractVersionId || data.attributionId!==null)
      fail(422,'COMMERCIAL_CONTRACT_REQUIRED','Commercial engagement drafts require a client and a pinned contract, without internal attribution.');
    await scopedClient(client,req,data.clientId);
    const term=await contractTerms(client,req,data,options);
    const contract=await getContract(client,req,data.contractId);
    if(contract.clientId!==data.clientId || term.model!==data.model)
      fail(422,'COMMERCIAL_TERMS_MISMATCH','Engagement client and model must match the pinned contract.');
  }
};
export const createEngagement = async (client,req,data,audit) => {
  await validateEngagementReferences(client,req,data);
  const internal=['internal','pre_sales'].includes(data.model);
  const row=(await client.query(`insert into commercial_engagements
    (organization_id,legal_entity_id,code,name,model,client_id,contract_id,contract_version_id,owner_id,attribution_id,starts_on,ends_on,currency,budget,billable,reason,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning ${engagementProjection}`,
  [...scopeValues(req),data.code,data.name,data.model,data.clientId,data.contractId,data.contractVersionId,data.ownerId,data.attributionId,data.startsOn,data.endsOn,data.currency,data.budget,!internal,data.reason,req.user.sub])).rows[0];
  const result=engagementDto(row);await auditCommand(audit,client,req,'Engagement',row.id,null,result,data.reason);return result;
};
export const createPurchaseOrder = async (client,req,data,audit) => {
  await contractTerms(client,req,data);
  const row=(await client.query(`insert into commercial_purchase_orders
    (organization_id,legal_entity_id,contract_id,contract_version_id,number,value,currency,starts_on,ends_on,warning_threshold_percent,reason,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${poProjection}`,
  [...scopeValues(req),data.contractId,data.contractVersionId,data.number,data.value,data.currency,data.startsOn,data.endsOn,data.warningThresholdPercent,data.reason,req.user.sub])).rows[0];
  const result=purchaseOrderDto(row);await auditCommand(audit,client,req,'Purchase Order',row.id,null,result,data.reason);return result;
};
export const createMilestone = async (client,req,data,audit) => {
  const engagement=(await client.query(`select ${engagementProjection} from commercial_engagements where ${scopeWhere} and id=$3 and origin='manual'`,[...scopeValues(req),data.engagementId])).rows[0];
  if(!engagement)fail(404,'COMMERCIAL_REFERENCE_NOT_FOUND','A manual engagement draft in the selected scope is required.');
  const governed=await applyAmendedSnapshot(client,req,'Engagement',engagement.id,engagement,data.dueOn);
  if((await client.query(`select 1 from commercial_amendments where ${scopeWhere} and entity_type='Engagement' and entity_id=$3 and effective_on>$4 limit 1`,[...scopeValues(req),engagement.id,data.dueOn])).rowCount)
    fail(409,'COMMERCIAL_AMENDMENT_PENDING','A later pending parent amendment must take effect before adding this milestone.');
  if(data.currency!==governed.currency || data.dueOn<governed.starts_on || data.dueOn>governed.ends_on)
    fail(422,'COMMERCIAL_TERMS_MISMATCH','Milestone date and currency must fit the explicitly adopted engagement terms.');
  if(!engagement.billable && !/^0(?:\.0{1,4})?$/.test(data.amount))
    fail(422,'COMMERCIAL_INTERNAL_POLICY','Non-billable milestones cannot carry a commercial amount.');
  const row=(await client.query(`insert into commercial_milestones(organization_id,legal_entity_id,engagement_id,code,name,due_on,amount,currency,reason,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${milestoneProjection}`,
  [...scopeValues(req),data.engagementId,data.code,data.name,data.dueOn,data.amount,data.currency,data.reason,req.user.sub])).rows[0];
  const result=milestoneDto(row);await auditCommand(audit,client,req,'Milestone',row.id,null,result,data.reason);return result;
};
export const getWorkspace = async (client,req,{asOf}={}) => {
  const date=asOf||await utcToday(client);const values=scopeValues(req);const truncated={};
  const bounded=async(key,sql,params=values)=>{const rows=(await client.query(sql,params)).rows;truncated[key]=rows.length>COMMERCIAL_PAGE_SIZE;return rows.slice(0,COMMERCIAL_PAGE_SIZE);};
  const roots=await bounded('contracts',`select id,number,client_id,latest_version from commercial_contracts where ${scopeWhere} order by created_at desc,id limit 201`);
  const ids=roots.map(row=>row.id);
  const latest=(await client.query(`select distinct on(contract_id) ${termsProjection} from commercial_contract_versions where ${scopeWhere} and contract_id=any($3::text[]) order by contract_id,version desc`,[...values,ids])).rows;
  const current=(await client.query(`select ${termsProjection} from (select distinct on(contract_id) * from commercial_contract_versions where ${scopeWhere} and contract_id=any($3::text[]) and effective_from<=$4 order by contract_id,effective_from desc) applicable where starts_on<=$4::date and ends_on>=$4::date`,[...values,ids,date])).rows;
  const latestById=new Map(latest.map(row=>[row.contract_id,termsDto(row)]));const currentById=new Map(current.map(row=>[row.contract_id,termsDto(row)]));
  const contracts=roots.map(row=>({id:row.id,number:row.number,clientId:row.client_id,latestVersion:row.latest_version,terms:latestById.get(row.id),currentTerms:currentById.get(row.id)||null}));
  const engagements=(await bounded('engagements',`select ${engagementProjection} from commercial_engagements where ${scopeWhere} and origin='manual' order by created_at desc,id limit 201`)).map(engagementDto);
  const purchaseOrders=(await bounded('purchaseOrders',`select ${poProjection} from commercial_purchase_orders where ${scopeWhere} order by created_at desc,id limit 201`)).map(purchaseOrderDto);
  const milestones=(await bounded('milestones',`select ${milestoneProjection} from commercial_milestones where ${scopeWhere} order by created_at desc,id limit 201`)).map(milestoneDto);
  const clients=await bounded('clients',`select id,name from clients where ${scopeWhere} and status='Active' order by name,id limit 201`);
  const owners=await bounded('owners',`select id,name from employees where ${scopeWhere} and status='Active' order by name,id limit 201`);
  const attributions=await bounded('attributions',`select id,name,code,catalog_type "catalogType" from organization_catalog_items where organization_id=$1 and (legal_entity_id=$2 or legal_entity_id is null)
    and catalog_type in('business_unit','cost_centre') and active=true and effective_from<=$3 and (effective_to is null or effective_to>=$3) order by name,id limit 201`,[...values,date]);
  const counts=(await client.query(`select count(*)::int "totalProjects",count(m.project_id)::int "mappedProjects" from projects p left join project_engagement_mappings m on m.project_id=p.id
    where p.organization_id=$1 and p.legal_entity_id=$2`,values)).rows[0];
  return {asOf:date,contracts,engagements,purchaseOrders,milestones,choices:{clients,owners,attributions},limits:{pageSize:COMMERCIAL_PAGE_SIZE,truncated},legacyMappings:counts};
};
