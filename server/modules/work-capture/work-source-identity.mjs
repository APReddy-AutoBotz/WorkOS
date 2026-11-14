import {z} from 'zod';
import {normalizeWorkSourceIdentity,workSourceIdentityIsValid,workSourceIdentityKey} from '../../../shared/work-source-identity.mjs';
import {WorkPolicyError} from './assignment-work-policy.mjs';
export const workSourceIdentityInput=z.unknown().refine(workSourceIdentityIsValid,'Use an exact namespace/worklog ID pair or null.').transform(normalizeWorkSourceIdentity).optional();
export const validateWorkSourceReplacement=async(client,req,employeeId,weekEnding,entries,timesheetId=null,stagedKeys=new Set())=>{
 const keys=entries.map(entry=>workSourceIdentityKey(entry.source_identity)).filter(Boolean);
 if(keys.some(key=>stagedKeys.has(key)))throw new WorkPolicyError('WORK_SOURCE_IDENTITY_CONFLICT','A source identity is already used in this import or authorized scope.',409);
 const {organizationId,legalEntityId}=req.organizationScope;
 const {duplicate,missing,conflict}=(await client.query(`with incoming as(select value entry,value->'source_identity' identity,work_source_payload($3,$4::date,value) payload from jsonb_array_elements($6::jsonb)), linked as(select * from incoming where identity is not null and identity<>'null'::jsonb)
 select exists(select 1 from linked group by identity having count(*)>1) duplicate,
 exists(select 1 from work_entry_source_claims c where c.timesheet_id=$5::uuid and not exists(select 1 from linked i where i.identity->>'namespace'=c.namespace and i.identity->>'externalId'=c.external_id and i.payload=c.payload)) missing,
 exists(select 1 from linked i join work_entry_source_claims c on c.organization_id=$1 and c.legal_entity_id=$2 and c.namespace=i.identity->>'namespace' and c.external_id=i.identity->>'externalId' where c.timesheet_id is distinct from $5::uuid or c.payload<>i.payload) conflict`,
 [organizationId,legalEntityId,employeeId,weekEnding,timesheetId,JSON.stringify(entries.map(({policy,capturePolicyReference,...entry})=>entry))])).rows[0];
 if(duplicate||conflict)throw new WorkPolicyError('WORK_SOURCE_IDENTITY_CONFLICT','The source identity is already captured or its recorded content differs. No matching, rebinding or changed-source amendment is performed.',409);
 if(missing)throw new WorkPolicyError('WORK_SOURCE_IDENTITY_IMMUTABLE','Recorded source-linked work cannot be changed, cleared or removed by replacement. A versioned source amendment is required.',409);
 return keys;
};
