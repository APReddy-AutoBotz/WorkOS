import {approvalKeys,approvalUuid} from './work-approval.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
export const CALENDAR_AUTHORING_VERSION='calendar-authoring/1';
export const CALENDAR_AUTHORING_PAGE_SIZE=20;
export const calendarCode=v=>typeof v==='string'&&/^[A-Z0-9][A-Z0-9_-]{0,49}$/.test(v);
export const calendarLabel=(v,max)=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const calendarHours=v=>typeof v==='string'&&/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/.test(v)&&Number(v)>0&&Number(v)<=24;
export const validCalendarDefinition=d=>{
 if(!approvalKeys(d,['name','timezone','workingDays','hoursPerDayExact','holidays'])||!calendarLabel(d.name,150)||!calendarLabel(d.timezone,80)||!calendarHours(d.hoursPerDayExact)||!Array.isArray(d.workingDays)||d.workingDays.length<1||d.workingDays.length>7||!Array.isArray(d.holidays)||d.holidays.length>200)return false;
 try{new Intl.DateTimeFormat('en',{timeZone:d.timezone}).format();}catch{return false;}
 let previous=-1;for(const day of d.workingDays){if(!Number.isInteger(day)||day<0||day>6||day<=previous)return false;previous=day;}
 let date=null;for(const h of d.holidays){if(!approvalKeys(h,['date','label','type'])||!validCapabilityDate(h.date)||!calendarLabel(h.label,150)||!['Public','Company'].includes(h.type)||date!==null&&h.date<=date)return false;date=h.date;}
 return true;
};
export const validCalendarCommand=c=>approvalKeys(c,['requestId','lineageId','expectedLatestId','code','effectiveFrom','definition','reason'])&&approvalUuid(c.requestId)&&(c.lineageId===null||approvalUuid(c.lineageId))&&(c.expectedLatestId===null||approvalUuid(c.expectedLatestId))&&Boolean(c.lineageId)===Boolean(c.expectedLatestId)&&calendarCode(c.code)&&validCapabilityDate(c.effectiveFrom)&&validCalendarDefinition(c.definition)&&c.definition.holidays.every(h=>h.date>=c.effectiveFrom)&&calendarLabel(c.reason,1000);
export const calendarCommandCanonical=v=>JSON.stringify(v,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
