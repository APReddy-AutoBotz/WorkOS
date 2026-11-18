import {validCapabilityDate} from './workforce-capabilities.mjs';
export const WORK_CATEGORY_VERSION='work-category/1';
export const CATEGORY_KINDS=['billable_client','non_billable_client','internal_delivery','pre_sales','training','administration','buyer_defined'];
export const CATEGORY_CONTEXTS=['client_description','none','project'];
export const validCategoryCode=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v);
const object=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)),keys=(v,k)=>Object.keys(v).sort().join(',')===[...k].sort().join(',');
export const validCategoryDefinition=v=>object(v)&&keys(v,['code','label','kind','active','contexts','billability','includeInUtilization'])&&validCategoryCode(v.code)&&typeof v.label==='string'&&v.label.trim()===v.label&&v.label.length>0&&Array.from(v.label).length<=120&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v.label)&&CATEGORY_KINDS.includes(v.kind)&&typeof v.active==='boolean'&&typeof v.includeInUtilization==='boolean'
 &&Array.isArray(v.contexts)&&v.contexts.length>0&&v.contexts.length<=3&&v.contexts.every(c=>CATEGORY_CONTEXTS.includes(c))&&v.contexts.join(',')===[...new Set(v.contexts)].sort().join(',')&&['project_bound','non_billable'].includes(v.billability)
 &&(v.kind==='billable_client'?v.billability==='project_bound'&&v.contexts.join(',')==='project':v.kind==='buyer_defined'||v.billability==='non_billable')
 &&(v.kind!=='non_billable_client'||!v.contexts.includes('none'))&&(v.billability!=='project_bound'||v.contexts.join(',')==='project');
export const validCategoryCatalog=v=>object(v)&&keys(v,['enabled','categories'])&&typeof v.enabled==='boolean'&&Array.isArray(v.categories)&&v.categories.length<=100&&(v.enabled?v.categories.length>0&&v.categories.some(c=>c.active):v.categories.length===0)&&v.categories.every(validCategoryDefinition)&&new Set(v.categories.map(c=>c.code)).size===v.categories.length;
export const categoryContext=workType=>workType==='Project Work'?'project':workType==='Client Misc Task'?'client_description':workType==='Non-client Work'?'none':null;
export const readCategoryReference=v=>{
 if(v===null||v===undefined)return v;
 if(!object(v)||!keys(v,['code','label','kind','active','contexts','billability','includeInUtilization','contractVersion','catalogId','sequence','effectiveFrom','context'])||v.contractVersion!==WORK_CATEGORY_VERSION||typeof v.catalogId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.catalogId)||!Number.isSafeInteger(v.sequence)||v.sequence<1||!validCapabilityDate(v.effectiveFrom)||v.active!==true||!validCategoryDefinition(Object.fromEntries(['code','label','kind','active','contexts','billability','includeInUtilization'].map(k=>[k,v[k]])))||!v.contexts.includes(v.context))throw new TypeError('Governed category reference is invalid. Reload explicitly.');return v;
};

// Decode canonical metadata together; neither free text nor a client snapshot grants classification.
export const readCategoryEntry=(code,reference,workType,date,billable,label)=>{
 if(code===undefined&&reference===undefined)return {};
 if(code===null&&reference===null)return {categoryCode:null,categoryReference:null};
 const ref=readCategoryReference(reference);
 if(!ref||code!==ref.code||ref.context!==categoryContext(workType)||date<ref.effectiveFrom||label!==ref.label||ref.billability==='non_billable'&&billable||ref.kind==='billable_client'&&!billable)throw new TypeError('Work category acknowledgement does not match its entry. Reload explicitly.');
 return {categoryCode:code,categoryReference:ref};
};

// Legacy import duplicate flags fold their whole key; encode this new exact ASCII
// dimension so case-sensitive buyer codes remain distinct without changing old keys.
export const categoryImportKeySuffix=code=>validCategoryCode(code)?'|category:'+Array.from(code,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(''):'';
