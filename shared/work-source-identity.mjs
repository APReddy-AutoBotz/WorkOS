// Exact self-asserted keys. No provider lookup, case folding or Unicode equivalence.
export const normalizeWorkSourceIdentity=value=>{
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='externalId,namespace')throw Error('Provide an exact namespace and external worklog ID, or null.');
 const {namespace,externalId}=value;
 if(typeof namespace!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(namespace)||typeof externalId!=='string'||!externalId||externalId!==externalId.trim()||Array.from(externalId).length>200||/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(externalId))throw Error('Use an exact namespace and single-line worklog ID without edge whitespace or controls.');
 return {namespace,externalId};
};
export const workSourceIdentityIsValid=value=>{try{normalizeWorkSourceIdentity(value);return true;}catch{return false;}};
export const workSourceIdentityKey=value=>{const identity=normalizeWorkSourceIdentity(value);return identity?JSON.stringify([identity.namespace,identity.externalId]):null;};
// Optional CSV aliases preserve omission; callers must choose one representation.
export const resolveWorkSourceIdentityAliases=row=>{
 const namespace=Object.hasOwn(row,'sourceNamespace'),id=Object.hasOwn(row,'externalWorklogId');
 if(!namespace&&!id)return row.sourceIdentity===undefined?undefined:normalizeWorkSourceIdentity(row.sourceIdentity);
 if(namespace!==id||row.sourceIdentity!==undefined)throw Error('Supply both sourceNamespace and externalWorklogId, or a sourceIdentity object, without mixing forms.');
 if(row.sourceNamespace===''&&row.externalWorklogId==='')return null;
 return normalizeWorkSourceIdentity({namespace:row.sourceNamespace,externalId:row.externalWorklogId});
};
export const sourceIdentityCommandRequiresAcknowledgement=rows=>rows.some(row=>Boolean(row.sourceIdentity||row.source_identity||row.sourceNamespace||row.externalWorklogId));
/** @returns {{version:'work-source/1',linkedEntries:number,mode:'preview'|'apply'}|undefined} */
export const readSourceIdentityCheck=value=>{
 if(!value||typeof value!=='object'||value.version!=='work-source/1'||!Number.isSafeInteger(value.linkedEntries)||value.linkedEntries<0||!['preview','apply'].includes(value.mode))return undefined;
 return {version:'work-source/1',linkedEntries:value.linkedEntries,mode:value.mode};
};
export const sourceIdentityImportNotice=value=>{
 const check=readSourceIdentityCheck(value);return check?.linkedEntries?` Source-linked entries: ${check.linkedEntries} (${check.mode==='preview'?'preview':'applied'}). Recorded linked work is fixed after capture.`:'';
};
