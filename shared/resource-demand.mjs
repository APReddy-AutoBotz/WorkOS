import {capabilityLabel,validCapabilityDate,validCapabilityCriteria,matchesCapabilities} from './workforce-capabilities.mjs';
import {canonicalHours,compareHours} from './work-hours.mjs';
export const RESOURCE_DEMAND_VERSION='resource-demand/1';
const object=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const keys=(v,expected)=>object(v)&&Object.keys(v).sort().join(',')===[...expected].sort().join(',');
export const validDemandQuantity=v=>{try{return typeof v==='string'&&v.length<=100&&canonicalHours(v)===v&&compareHours(v,'0')>0;}catch{return false;}};
export const validDemandCriteria=v=>keys(v,['skill','proficiency','certification'])&&validCapabilityCriteria({...v,validOn:v.certification===null?null:'2000-01-01'});
export const validDemandDefinition=v=>keys(v,['title','role','startsOn','endsOn','quantityUnit','quantityExact','status','criteria','note'])
 &&capabilityLabel(v.title)&&capabilityLabel(v.role)&&validCapabilityDate(v.startsOn)&&validCapabilityDate(v.endsOn)&&v.endsOn>=v.startsOn
 &&['percentage','hours'].includes(v.quantityUnit)&&validDemandQuantity(v.quantityExact)&&['Open','Closed','Cancelled'].includes(v.status)&&validDemandCriteria(v.criteria)
 &&(v.note===null||typeof v.note==='string'&&v.note===v.note.trim()&&[...v.note].length>=1&&[...v.note].length<=3000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(v.note));
export const matchesDemandCapabilities=(profile,definition)=>{
 const c=definition.criteria;if(c.skill===null&&c.certification===null)return true;
 return matchesCapabilities(profile,{...c,validOn:c.certification===null?null:definition.startsOn})
  &&matchesCapabilities(profile,{...c,validOn:c.certification===null?null:definition.endsOn});
};
