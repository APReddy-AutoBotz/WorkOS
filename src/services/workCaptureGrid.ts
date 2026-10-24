import type {TimesheetEntry} from '../types';
import {canonicalHours,compareHours} from '../../shared/work-hours.mjs';

export const captureCalendarDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

export const canonicalCaptureHourInput = (value: string): string | null => {
  if (value === '') return '0';
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const normalized = (value.startsWith('.') ? `0${value}` : value).replace(/\.$/, '');
  try {
    const quantity = canonicalHours(normalized);
    return compareHours(quantity, '24') <= 0 ? quantity : null;
  } catch { return null; }
};
// Numbers are display previews only. Persistence retains the original exact text.
export const parseCaptureHourInput = (value: string): number | null => {
  const quantity = canonicalCaptureHourInput(value);
  return quantity === null ? null : Number(quantity);
};

// The compatibility grid still displays five days. Never overwrite duplicate
// same-day entries or silently drop weekend/out-of-grid/zero-quantity evidence.
export const hydrateWorkCaptureGrid = (entries: TimesheetEntry[], startsOn: string, dayCount = 5) => {
  const rows: Array<Record<string, any>> = [];
  const preservedEntries: TimesheetEntry[] = [];
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  for (const entry of entries) {
    const day = (Date.parse(`${entry.date}T00:00:00Z`) - start) / 86400000;
    const quantity=canonicalHours(entry.hoursExact??entry.hours);
    if (!Number.isInteger(day) || day < 0 || day >= dayCount || compareHours(quantity,'0') <= 0) {
      preservedEntries.push({...entry}); continue;
    }
    const hours = Array(dayCount).fill(0), exactHours=Array(dayCount).fill('0'), remarks = Array(dayCount).fill(''), evidenceUrls = Array(dayCount).fill(null), workReferences=Array(dayCount).fill(null),sourceIdentities=Array(dayCount).fill(null),sourceIdentityRecorded=Array(dayCount).fill(false);
    hours[day] = Number(quantity);exactHours[day]=quantity; remarks[day] = entry.remark || '';evidenceUrls[day]=entry.evidenceUrl??null;workReferences[day]=entry.workReference??null;sourceIdentities[day]=entry.sourceIdentity??null;sourceIdentityRecorded[day]=Boolean(entry.sourceIdentity);
    rows.push({id: `retained-${entry.id}`, workType: entry.workType, projectId: entry.projectId,
      projectName: entry.projectName, clientName: entry.clientName, category: entry.category,
      categoryCodes:Array.from({length:dayCount},(_,i)=>i===day?entry.categoryCode??null:null),categoryReferences:Array.from({length:dayCount},(_,i)=>i===day?entry.categoryReference??null:null),categoryLabels:Array.from({length:dayCount},(_,i)=>i===day?entry.category??null:null),billables:Array.from({length:dayCount},(_,i)=>i===day?entry.billable:null),
      hours, exactHours, remarks, evidenceUrls, workReferences, sourceIdentities,sourceIdentityRecorded,rowRemark: '', billable: entry.billable});
  }
  return {rows, preservedEntries};
};

export const captureHeaderMonday=(date:string)=>{
  const next=new Date(`${date}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(next.getTime())||next.toISOString().slice(0,10)!==date)throw new Error('Invalid capture date.');
  const day=next.getUTCDay();next.setUTCDate(next.getUTCDate()+(day===6?2:day===0?1:1-day));return next.toISOString().slice(0,10);
};
export const captureUtcDate=(date:Date)=>date.toISOString().slice(0,10);
export const captureCellText=(row:any,index:number,drafts:Record<string,string>)=>
  drafts[`${row.id}:${index}`]??row.exactHours?.[index]??String(row.hours[index]);
export const captureCellHours=(row:any,index:number,drafts:Record<string,string>)=>
  canonicalCaptureHourInput(captureCellText(row,index,drafts))??canonicalHours(row.exactHours?.[index]??row.hours[index]);
export const setCaptureRowHours=(row:any,index:number,value:string)=>{
  const quantity=canonicalCaptureHourInput(value);if(quantity===null)return row;
  return {...row,hours:row.hours.map((hour:number,day:number)=>day===index?Number(quantity):hour),
    exactHours:row.hours.map((hour:number,day:number)=>day===index?quantity:row.exactHours?.[day]??String(hour))};
};
export const captureCellPresent=(row:any,index:number,drafts:Record<string,string>)=>{
  const raw=drafts[`${row.id}:${index}`];
  return (raw!==undefined&&raw!=='')||compareHours(captureCellHours(row,index,drafts),'0')>0||Boolean(row.remarks[index])||Boolean(row.evidenceUrls?.[index])||Boolean(row.workReferences?.[index])||Boolean(row.sourceIdentities?.[index])||Boolean(row.categoryCodes?.[index])||Boolean(row.categoryReferences?.[index]);
};
const clearCells=(row:any,indices:number[])=>({...row,
  ...Object.fromEntries(['categoryCodes','categoryReferences','categoryLabels','billables'].map(key=>[key,row.hours.map((_:number,index:number)=>indices.includes(index)?null:row[key]?.[index]??null)])),
  sourceIdentities:row.hours.map((_:number,index:number)=>indices.includes(index)?null:row.sourceIdentities?.[index]??null),
  sourceIdentityRecorded:row.hours.map((_:number,index:number)=>indices.includes(index)?false:row.sourceIdentityRecorded?.[index]??false),
  hours:row.hours.map((value:number,index:number)=>indices.includes(index)?0:value),
  exactHours:row.hours.map((value:number,index:number)=>indices.includes(index)?'0':row.exactHours?.[index]??String(value)),
  remarks:row.remarks.map((value:string,index:number)=>indices.includes(index)?'':value),
  evidenceUrls:row.hours.map((_:number,index:number)=>indices.includes(index)?null:row.evidenceUrls?.[index]??null),
  workReferences:row.hours.map((_:number,index:number)=>indices.includes(index)?null:row.workReferences?.[index]??null),
});
// A row can contain several unsaved dates. Context/removal applies only to the
// visible dates; split invisible values and raw (including invalid) drafts first.
export const patchVisibleCaptureRow=(rows:any[],drafts:Record<string,string>,rowId:string,visible:number[],patch:Record<string,unknown>,newId:string)=>{
  const row=rows.find(item=>item.id===rowId);if(!row)return {rows,drafts};
  const hidden=row.hours.map((_:number,index:number)=>index).filter((index:number)=>!visible.includes(index));
  if(!hidden.some((index:number)=>captureCellPresent(row,index,drafts)))return {rows:rows.map(item=>item.id===rowId?{...item,...patch}:item),drafts};
  const nextDrafts={...drafts};
  for(const index of hidden){const key=`${rowId}:${index}`;if(nextDrafts[key]!==undefined){nextDrafts[`${newId}:${index}`]=nextDrafts[key];delete nextDrafts[key];}}
  const retained={...clearCells(row,visible),id:newId},edited={...clearCells(row,hidden),...patch};
  return {rows:rows.flatMap(item=>item.id===rowId?[edited,retained]:[item]),drafts:nextDrafts};
};
export const removeVisibleCaptureRow=(rows:any[],drafts:Record<string,string>,rowId:string,visible:number[])=>{
  const row=rows.find(item=>item.id===rowId);if(!row)return {rows,drafts};
  const hidden=row.hours.map((_:number,index:number)=>index).filter((index:number)=>!visible.includes(index));
  const retain=hidden.some((index:number)=>captureCellPresent(row,index,drafts)),nextDrafts={...drafts};
  for(const index of row.hours.map((_:number,index:number)=>index))if(!retain||visible.includes(index))delete nextDrafts[`${rowId}:${index}`];
  return {rows:rows.flatMap(item=>item.id!==rowId?[item]:retain?[clearCells(item,visible)]:[]),drafts:nextDrafts};
};
