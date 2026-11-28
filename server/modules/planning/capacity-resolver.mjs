import {WORKER_CAPACITY_VERSION,validCapacityProfile,validCapacityRange,capacityDateCount,shiftCapacityDate,multiplyCapacity} from '../../../shared/worker-capacity.mjs';
import {exactCapacityQuantity} from '../../../shared/worker-capacity.mjs';
import {calendarLeaveFraction} from '../../../shared/calendar-leave.mjs';
import {canonicalHours,compareHours,sumHours} from '../../../shared/work-hours.mjs';
const inRange=(d,r)=>r.effectiveFrom<=d&&(!r.effectiveTo||d<=r.effectiveTo);
const active=(d,r)=>r.active&&inRange(d,r);
export const validCapacityCalendar=c=>{try{new Intl.DateTimeFormat('en',{timeZone:c.timezone}).format();return Array.isArray(c.workingDays)&&c.workingDays.length>0&&c.workingDays.length<=7&&new Set(c.workingDays).size===c.workingDays.length&&c.workingDays.every(d=>Number.isInteger(d)&&d>=0&&d<=6)&&exactCapacityQuantity(c.hoursPerDayExact,'24',true);}catch{return false;}};
const legalAt=(sources,id,day)=>{const rows=sources.legalAuthorities.filter(r=>r.legalEntityId===id&&inRange(day,r)&&r.legalEntityEffectiveFrom<=day&&(!r.authorityEffectiveTo||day<=r.authorityEffectiveTo));return rows.length===1&&rows[0].status==='Active'?rows[0]:null;};
const groupAt=(sources,id,day)=>sources.groups.find(g=>g.id===id&&g.catalogType==='business_unit'&&(g.legalEntityId===null||g.legalEntityId===sources.worker.legalEntityId)&&active(day,g));
const calendarApplies=(sources,c,day,legal)=>active(day,c)&&(c.applicabilityType==='legal_entity'?c.legalEntityId===sources.worker.legalEntityId:c.applicabilityType==='worker_group'?Boolean(groupAt(sources,c.workerGroupId,day)):c.applicabilityType==='country'&&c.countryCode===legal.countryCode&&legalAt(sources,c.countryAuthorityLegalEntityId,day)?.countryCode===c.countryCode);
export const resolveCapacityCalendar=(sources,profile,day)=>{
 const legal=legalAt(sources,sources.worker.legalEntityId,day);if(!legal)return{reason:'LEGAL_ENTITY_AUTHORITY_UNAVAILABLE'};
 if(profile.definition.calendarOverrideId!==null){const c=sources.calendars.find(c=>c.id===profile.definition.calendarOverrideId);return c&&calendarApplies(sources,c,day,legal)?{calendar:c,tier:'override'}:{reason:'CALENDAR_OVERRIDE_UNAVAILABLE'};}
 const group=profile.definition.workerGroupId;if(group!==null&&!groupAt(sources,group,day))return{reason:'WORKER_GROUP_UNAVAILABLE'};
 const tiers=[['worker_group',c=>group!==null&&c.applicabilityType==='worker_group'&&c.workerGroupId===group],['legal_entity',c=>c.applicabilityType==='legal_entity'&&c.legalEntityId===sources.worker.legalEntityId],['country',c=>c.applicabilityType==='country'&&c.countryCode===legal.countryCode]];
 for(const[tier,predicate]of tiers){const rows=sources.calendars.filter(c=>predicate(c)&&calendarApplies(sources,c,day,legal));if(rows.length>1)return{reason:'CALENDAR_AMBIGUOUS'};if(rows.length===1)return{calendar:rows[0],tier};}
 return{reason:'CALENDAR_NOT_CONFIGURED'};
};
const applicableProfile=(profiles,day)=>{const before=profiles.filter(p=>p.effectiveFrom<=day).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));if(!before.length)return null;const found=before.filter(p=>p.effectiveFrom===before.at(-1).effectiveFrom);return found.length===1?found[0]:null;};
const workerState=(sources,day)=>{
 const w=sources.worker;if((w.joiningDate&&day<w.joiningDate)||(w.exitDate&&day>w.exitDate))return{inactive:true,historyId:null};
 const state=(status,historyId)=>['Active','On Leave'].includes(status)?{inactive:false,historyId}:['Exited','Disabled','Draft'].includes(status)?{inactive:true,historyId}:{reason:'WORKER_LIFECYCLE_UNAVAILABLE',historyId};
 if(!sources.workerHistory.length)return state(w.status,null);
 const rows=sources.workerHistory.filter(r=>inRange(day,r));return rows.length===1?state(rows[0].status,rows[0].id):{reason:'WORKER_LIFECYCLE_UNAVAILABLE',historyId:null};
};
const emptyDay=(date,profile,reason,refs={})=>({date,status:'unavailable',scheduledHoursExact:null,holidayReductionHoursExact:null,leaveReductionHoursExact:null,availableHoursExact:null,eligibleHoursExact:profile?.definition.utilizationEligible===false?'0':null,reasonCodes:[reason],calendarTier:null,sourceRefs:{profileId:profile?.id??null,calendarId:null,workerHistoryId:null,holidaySourceCount:0,approvedAbsenceSourceCount:0,...refs}});
const knownDay=(date,profile,scheduled,holiday,leave,available,refs,tier,reasons=[])=>({date,status:'available',scheduledHoursExact:scheduled,holidayReductionHoursExact:holiday,leaveReductionHoursExact:leave,availableHoursExact:available,eligibleHoursExact:profile.definition.utilizationEligible?available:'0',reasonCodes:reasons,calendarTier:tier,sourceRefs:refs});
const absenceFraction=leave=>{
 try{const amount=canonicalHours(leave.totalDaysExact),count=capacityDateCount(leave.startsOn,leave.endsOn);if(amount.length>900)return null;if(compareHours(amount,'0')===0)return'0';if(count===1&&compareHours(amount,'1')<=0)return amount;if(count>1&&compareHours(amount,String(count))===0)return'1';}catch{}
 return null;
};
const subtract=(a,b)=>{const scale=Math.max((a.split('.')[1]??'').length,(b.split('.')[1]??'').length);const n=v=>BigInt(v.replace('.',''))*10n**BigInt(scale-(v.split('.')[1]??'').length);const raw=(n(a)-n(b)).toString().padStart(scale+1,'0');return canonicalHours(scale?raw.slice(0,-scale)+'.'+raw.slice(-scale):raw);};
export const calculateWorkerCapacity=(sources,startsOn,endsOn)=>{
 if(!validCapacityRange(startsOn,endsOn))throw new TypeError('Capacity range must contain at most366 valid business dates.');
 const days=[], profileValidity=new Map(), calendarValidity=new Map();
 const dayCount=capacityDateCount(startsOn,endsOn);
 for(let i=0;i<dayCount;i++){
  const date=shiftCapacityDate(startsOn,i),profile=applicableProfile(sources.profiles,date);
  if(sources.limitExceeded){days.push(emptyDay(date,null,'CAPACITY_SOURCE_LIMIT'));continue;}
  if(!profile){days.push(emptyDay(date,null,'CAPACITY_PROFILE_NOT_ADOPTED'));continue;}
  if(!profileValidity.has(profile))profileValidity.set(profile,validCapacityProfile(profile.definition));
  if(!profileValidity.get(profile)){days.push(emptyDay(date,profile,'CAPACITY_PROFILE_INVALID'));continue;}
  const state=workerState(sources,date),baseRefs={profileId:profile.id,calendarId:null,workerHistoryId:state.historyId,holidaySourceCount:0,approvedAbsenceSourceCount:0};
  if(state.reason){days.push(emptyDay(date,profile,state.reason,baseRefs));continue;}
  if(state.inactive){days.push(knownDay(date,profile,'0','0','0','0',baseRefs,null,['WORKER_INACTIVE']));continue;}
  const picked=resolveCapacityCalendar(sources,profile,date);if(picked.reason){days.push(emptyDay(date,profile,picked.reason,baseRefs));continue;}
  const c=picked.calendar,weekday=new Date(date+'T00:00:00Z').getUTCDay(),scheduled=profile.definition.hoursByWeekdayExact[weekday],refs={...baseRefs,calendarId:c.id};
  if(!calendarValidity.has(c))calendarValidity.set(c,validCapacityCalendar(c));
  if(!calendarValidity.get(c)){days.push(emptyDay(date,profile,'CALENDAR_INVALID',refs));continue;}
  if((!c.workingDays.includes(weekday)&&compareHours(scheduled,'0')>0)||compareHours(scheduled,c.hoursPerDayExact)>0){days.push(emptyDay(date,profile,'CALENDAR_SCHEDULE_CONFLICT',refs));continue;}
  const holidays=sources.holidays.filter(h=>h.calendarId===c.id&&h.holidayDate===date&&active(date,h)),leaves=sources.approvedAbsences.filter(l=>l.startsOn<=date&&l.endsOn>=date);refs.holidaySourceCount=holidays.length;refs.approvedAbsenceSourceCount=leaves.length;
  if(holidays.length||scheduled==='0'){days.push(knownDay(date,profile,scheduled,holidays.length?scheduled:'0','0','0',refs,picked.tier,holidays.length?['HOLIDAY']:[]));continue;}
  const fractions=leaves.map(leave=>{const exact=calendarLeaveFraction(leave,date);return exact===undefined?absenceFraction(leave):exact;});if(fractions.includes('1')){days.push(knownDay(date,profile,scheduled,'0',scheduled,'0',refs,picked.tier,['APPROVED_FULL_ABSENCE']));continue;}
  const partial=fractions.filter(f=>f!==null&&f!=='0');
  if(fractions.includes(null)||partial.length>1){const d=emptyDay(date,profile,fractions.includes(null)?'LEGACY_ABSENCE_ALLOCATION_UNAVAILABLE':'PARTIAL_ABSENCE_OVERLAP_UNAVAILABLE',refs);d.scheduledHoursExact=scheduled;d.holidayReductionHoursExact='0';d.calendarTier=picked.tier;days.push(d);continue;}
  const reduction=partial.length?multiplyCapacity(scheduled,partial[0]):'0';days.push(knownDay(date,profile,scheduled,'0',reduction,subtract(scheduled,reduction),refs,picked.tier,partial.length?['APPROVED_PARTIAL_ABSENCE']:[]));
 }
 const totals=Object.fromEntries(['scheduledHoursExact','holidayReductionHoursExact','leaveReductionHoursExact','availableHoursExact','eligibleHoursExact'].map(k=>[k,days.some(d=>d[k]===null)?null:sumHours(days.map(d=>d[k]))]));
 return{calculationVersion:WORKER_CAPACITY_VERSION,employeeId:sources.worker.id,startsOn,endsOn,status:days.some(d=>d.status==='unavailable')?'unavailable':'available',totals,days,profileIds:[...new Set(days.map(d=>d.sourceRefs.profileId).filter(Boolean))],reasonCodes:[...new Set(days.flatMap(d=>d.reasonCodes))].sort()};
};
