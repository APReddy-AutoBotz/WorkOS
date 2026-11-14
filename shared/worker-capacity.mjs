import {canonicalHours,compareHours,decimalQuantity,formatQuantity,sumHours} from './work-hours.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
export const WORKER_CAPACITY_VERSION='worker-capacity/1';
export const exactCapacityQuantity=(v,max='168',positive=false)=>{try{return typeof v==='string'&&v.length<=100&&canonicalHours(v)===v&&(positive?compareHours(v,'0')>0:compareHours(v,'0')>=0)&&compareHours(v,max)<=0;}catch{return false;}};
export const multiplyCapacity=(a,b,percent=false)=>{const x=decimalQuantity(a),y=decimalQuantity(b);return formatQuantity({units:x.units*y.units,scale:x.scale+y.scale+(percent?2:0)});};
const object=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const nullableId=v=>v===null||typeof v==='string'&&v.length>0&&v.length<=200&&v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const validCapacityProfile=v=>object(v)&&Object.keys(v).sort().join(',')===['fullTimeWeeklyHoursExact','partTimePercentExact','hoursByWeekdayExact','utilizationEligible','workerGroupId','calendarOverrideId'].sort().join(',')
 &&exactCapacityQuantity(v.fullTimeWeeklyHoursExact,'168',true)&&exactCapacityQuantity(v.partTimePercentExact,'100')
 &&Array.isArray(v.hoursByWeekdayExact)&&v.hoursByWeekdayExact.length===7&&v.hoursByWeekdayExact.every(q=>exactCapacityQuantity(q,'24'))
 &&sumHours(v.hoursByWeekdayExact)===multiplyCapacity(v.fullTimeWeeklyHoursExact,v.partTimePercentExact,true)
 &&typeof v.utilizationEligible==='boolean'&&nullableId(v.workerGroupId)&&nullableId(v.calendarOverrideId);
export const capacityWeeklyHours=profile=>sumHours(profile.hoursByWeekdayExact);
export const shiftCapacityDate=(day,by)=>new Date(Date.parse(day+'T00:00:00Z')+by*86400000).toISOString().slice(0,10);
export const capacityDateCount=(from,to)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1;
export const validCapacityRange=(from,to)=>validCapabilityDate(from)&&validCapabilityDate(to)&&to>=from&&capacityDateCount(from,to)<=366;
