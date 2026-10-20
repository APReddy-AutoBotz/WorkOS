import {randomUUID} from 'node:crypto';
import {fail} from '../commercial-drafting/contracts.mjs';

export const CLIENT_PROFILE_LIMIT=200;
const values=req=>[req.organizationScope.organizationId,req.organizationScope.legalEntityId];
const scope='organization_id=$1 and legal_entity_id=$2';
export const lockClientProfiles=(client,req)=>client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
 [`client-profiles:${req.organizationScope.organizationId}:${req.organizationScope.legalEntityId}`]);
const today=async client=>(await client.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
const profile=row=>row?({id:row.id,version:row.version,effectiveFrom:row.effective_from,legalName:row.legal_name,displayName:row.display_name,
 defaultCurrency:row.default_currency,billingContacts:row.billing_contacts,...('parent_client_id' in row?{parentClientId:row.parent_client_id}:{})}):null;
const root=row=>({id:row.id,operationalName:row.name,industry:row.industry,status:row.status,accountOwnerId:row.account_owner_id,
 code:row.code??null,latestVersion:row.latest_version??0,currentProfile:profile(row.current_profile),latestProfile:profile(row.latest_profile)});
const rootsQuery=`select c.id,c.name,c.industry,c.status,c.account_owner_id,a.code,
 coalesce(latest.version,0) latest_version,to_jsonb(latest) latest_profile,to_jsonb(current_profile) current_profile
 from clients c left join client_profile_accounts a on a.client_id=c.id and a.organization_id=c.organization_id and a.legal_entity_id=c.legal_entity_id
 left join lateral(select v.* from client_profile_versions v where v.client_id=c.id and v.organization_id=c.organization_id and v.legal_entity_id=c.legal_entity_id order by version desc limit 1) latest on true
 left join lateral(select v.* from client_profile_versions v where v.client_id=c.id and v.organization_id=c.organization_id and v.legal_entity_id=c.legal_entity_id and effective_from<=$3::date order by effective_from desc limit 1) current_profile on true
 where c.organization_id=$1 and c.legal_entity_id=$2`;
export const getClientProfilesWorkspace=async(client,req,data={})=>{
 const asOf=data.asOf||await today(client);
 const result=await client.query(`${rootsQuery} order by c.name,c.id limit 201`,[...values(req),asOf]);
 return {asOf,clients:result.rows.slice(0,CLIENT_PROFILE_LIMIT).map(root),limit:CLIENT_PROFILE_LIMIT,truncated:result.rows.length>CLIENT_PROFILE_LIMIT};
};
export const getClientProfile=async(client,req,id,data={})=>{
 const asOf=data.asOf||await today(client);
 const row=(await client.query(`${rootsQuery} and c.id=$4`,[...values(req),asOf,id])).rows[0];
 if(!row)fail(404,'CLIENT_PROFILE_NOT_FOUND','The client profile was not found in the selected scope.');
 const versions=(await client.query(`select *,effective_from::text from client_profile_versions where ${scope} and client_id=$3 order by version desc limit 200`,[...values(req),id])).rows.map(profile);
 const units=(await client.query(`select id,client_id,code,kind from client_billing_units where ${scope} and client_id=$3 order by code,id limit 201`,[...values(req),id])).rows;
 const selected=units.slice(0,CLIENT_PROFILE_LIMIT);
 const unitVersions=selected.length?(await client.query(`select *,effective_from::text from client_billing_unit_versions where ${scope} and client_id=$3 and unit_id=any($4::text[]) order by unit_id,version desc`,[...values(req),id,selected.map(unit=>unit.id)])).rows:[];
 const grouped=new Map();for(const version of unitVersions){if(!grouped.has(version.unit_id))grouped.set(version.unit_id,[]);grouped.get(version.unit_id).push(profile(version));}
 return {...root(row),asOf,versions,billingUnits:selected.map(unit=>{const history=grouped.get(unit.id)||[];return {id:unit.id,clientId:unit.client_id,code:unit.code,kind:unit.kind,
  latestVersion:history[0]?.version||0,currentProfile:history.find(item=>item.effectiveFrom<=asOf)||null,versions:history};}),limit:CLIENT_PROFILE_LIMIT,truncated:units.length>CLIENT_PROFILE_LIMIT};
};
const activeClient=async(client,req,id)=>{
 const result=await client.query(`select id from clients where ${scope} and id=$3 and status='Active' for share`,[...values(req),id]);
 if(result.rowCount!==1)fail(404,'CLIENT_PROFILE_REFERENCE_NOT_FOUND','An active client in the selected scope is required.');
};
const validateDate=async(client,latest,data)=>{
 const current=await today(client);
 if(!latest?data.effectiveFrom<current:data.effectiveFrom<=current||data.effectiveFrom<=latest.effectiveFrom)
  fail(409,'CLIENT_PROFILE_EFFECTIVE_DATE_CONFLICT','The initial profile cannot be backdated; revisions must start after today and the latest effective date.');
};
const record=async(client,req,clientId,type,id,before,after,reason,audit)=>{
 const eventId=`client-profile-event-${randomUUID()}`,action=before?'Append Profile Version':'Create Profile';
 await client.query(`insert into client_profile_events(id,organization_id,legal_entity_id,client_id,entity_type,entity_id,action,before_value,after_value,reason,actor_id,active_role,correlation_id,operation_id)
 values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
 [eventId,...values(req),clientId,type,id,action,before?JSON.stringify(before):null,JSON.stringify(after),reason,req.user.sub,req.user.activeRole,req.correlationId,req.operationId]);
 await audit(client,req,{module:'Client Profiles',action,entityType:type,entityId:id,oldValue:before?{clientProfileEventId:eventId,snapshot:'before'}:null,
  newValue:{clientProfileEventId:eventId,snapshot:'after'},reason:'Client profile operation; protected material evidence retained.',source:'Web',
  details:'Customer profile metadata only; no contract change or billing authority. Material evidence requires client-profile access.'});
};
export const saveClientProfile=async(client,req,id,data,audit)=>{
 await lockClientProfiles(client,req);await activeClient(client,req,id);
 const before=await getClientProfile(client,req,id);
 if(before.latestVersion!==data.expectedVersion)fail(409,'CLIENT_PROFILE_VERSION_CONFLICT','Client profile changed. Reload its latest version before saving.');
 if(before.code && before.code!==data.code)fail(409,'CLIENT_PROFILE_CODE_CONFLICT','Client profile codes are stable. Use the existing code.');
 await validateDate(client,before.latestProfile,data);
 if(data.parentClientId){
  if(data.parentClientId===id)fail(409,'CLIENT_PROFILE_PARENT_CYCLE','A client cannot be its own parent.');
  const parent=await client.query(`select id from clients where ${scope} and id=$3 for share`,[...values(req),data.parentClientId]);
  if(parent.rowCount!==1)fail(404,'CLIENT_PROFILE_REFERENCE_NOT_FOUND','The parent client must belong to the selected scope.');
 }
 if(!before.code)await client.query(`insert into client_profile_accounts(client_id,organization_id,legal_entity_id,code,created_by) values($1,$2,$3,$4,$5)`,[id,...values(req),data.code,req.user.sub]);
 const version=(await client.query(`insert into client_profile_versions(organization_id,legal_entity_id,client_id,version,effective_from,legal_name,display_name,parent_client_id,default_currency,billing_contacts,reason,created_by)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) returning *,effective_from::text`,
 [...values(req),id,before.latestVersion+1,data.effectiveFrom,data.legalName,data.displayName,data.parentClientId,data.defaultCurrency,JSON.stringify(data.billingContacts),data.reason,req.user.sub])).rows[0];
 await record(client,req,id,'ClientProfile',id,before.latestProfile?{code:before.code,profile:before.latestProfile}:null,{code:data.code,profile:profile(version)},data.reason,audit);
 return getClientProfile(client,req,id);
};
export const createClientBillingUnit=async(client,req,id,data,audit)=>{
 await lockClientProfiles(client,req);await activeClient(client,req,id);
 const account=await client.query(`select client_id from client_profile_accounts where ${scope} and client_id=$3`,[...values(req),id]);
 if(!account.rowCount)fail(409,'CLIENT_PROFILE_REQUIRED','Create the client master profile before adding customer billing units.');
 const count=(await client.query(`select count(*)::int count from client_billing_units where ${scope} and client_id=$3`,[...values(req),id])).rows[0].count;
 if(count>=CLIENT_PROFILE_LIMIT)fail(409,'CLIENT_PROFILE_LIMIT','The bounded customer billing-unit limit has been reached.');
 await validateDate(client,null,data);
 const unitId=`client-unit-${randomUUID()}`;
 await client.query(`insert into client_billing_units(id,organization_id,legal_entity_id,client_id,code,kind,created_by) values($1,$2,$3,$4,$5,$6,$7)`,[unitId,...values(req),id,data.code,data.kind,req.user.sub]);
 const result=await insertUnitVersion(client,req,id,unitId,1,data);
 await record(client,req,id,'ClientBillingUnit',unitId,null,{code:data.code,kind:data.kind,profile:result},data.reason,audit);
 return getClientProfile(client,req,id);
};
const insertUnitVersion=async(client,req,id,unitId,version,data)=>profile((await client.query(`insert into client_billing_unit_versions(organization_id,legal_entity_id,client_id,unit_id,version,effective_from,legal_name,display_name,default_currency,billing_contacts,reason,created_by)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) returning *,effective_from::text`,
 [...values(req),id,unitId,version,data.effectiveFrom,data.legalName,data.displayName,data.defaultCurrency,JSON.stringify(data.billingContacts),data.reason,req.user.sub])).rows[0]);
export const appendClientBillingUnit=async(client,req,id,unitId,data,audit)=>{
 await lockClientProfiles(client,req);await activeClient(client,req,id);
 const unit=(await client.query(`select id,code,kind from client_billing_units where ${scope} and client_id=$3 and id=$4`,[...values(req),id,unitId])).rows[0];
 if(!unit)fail(404,'CLIENT_PROFILE_NOT_FOUND','The customer billing unit was not found in this client and scope.');
 const latest=profile((await client.query(`select *,effective_from::text from client_billing_unit_versions where ${scope} and client_id=$3 and unit_id=$4 order by version desc limit 1`,[...values(req),id,unitId])).rows[0]);
 if(!latest||latest.version!==data.expectedVersion)fail(409,'CLIENT_PROFILE_VERSION_CONFLICT','Customer billing profile changed. Reload its latest version before saving.');
 await validateDate(client,latest,data);
 const result=await insertUnitVersion(client,req,id,unitId,latest.version+1,data);
 await record(client,req,id,'ClientBillingUnit',unitId,{code:unit.code,kind:unit.kind,profile:latest},{code:unit.code,kind:unit.kind,profile:result},data.reason,audit);
 return getClientProfile(client,req,id);
};
export const getClientProfileHistory=async(client,req,id)=>{
 await getClientProfile(client,req,id);
 const rows=(await client.query(`select id,entity_type,entity_id,action,before_value,after_value,reason,actor_id,active_role,source,correlation_id,operation_id,created_at::text from client_profile_events where ${scope} and client_id=$3 order by created_at desc,id desc limit 201`,[...values(req),id])).rows;
 return {clientId:id,events:rows.slice(0,CLIENT_PROFILE_LIMIT).map(row=>({id:row.id,entityType:row.entity_type,entityId:row.entity_id,action:row.action,before:row.before_value,after:row.after_value,
  reason:row.reason,actorId:row.actor_id,activeRole:row.active_role,source:row.source,correlationId:row.correlation_id,operationId:row.operation_id,createdAt:row.created_at})),limit:CLIENT_PROFILE_LIMIT,truncated:rows.length>CLIENT_PROFILE_LIMIT};
};
