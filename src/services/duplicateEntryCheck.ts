import {canonicalHours} from '../../shared/work-hours.mjs';
import type {DuplicateEntryCheck,DuplicateEntryCheckSummary} from '../types';
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const nullableText=(value:unknown)=>value===null||typeof value==='string';
export const normalizeDuplicateEntryCheck=(value:unknown):DuplicateEntryCheck|undefined=>{
 if(!object(value)||value.version!=='exact-entry-content/1'||!Array.isArray(value.groups))return undefined;
 const groups:DuplicateEntryCheck['groups']=[],keys=new Set<string>(),ids=new Set<string>();
 for(const item of value.groups){
  if(!object(item)||typeof item.key!=='string'||!/^[a-f0-9]{64}$/.test(item.key)||keys.has(item.key)
   ||typeof item.workDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(item.workDate)
   ||typeof item.workType!=='string'||!['Project Work','Client Misc Task','Non-client Work'].includes(item.workType)||!Array.isArray(item.entryIds)||item.entryIds.length<2
   ||item.entryIds.some(id=>typeof id!=='string'||!id||ids.has(id))||new Set(item.entryIds).size!==item.entryIds.length
   ||!nullableText(item.projectId)||!nullableText(item.clientName)||!nullableText(item.category)||typeof item.hoursExact!=='string')return undefined;
  let hoursExact:string;
  try{if(new Date(`${item.workDate}T00:00:00Z`).toISOString().slice(0,10)!==item.workDate)return undefined;hoursExact=canonicalHours(item.hoursExact);}catch{return undefined;}
  keys.add(item.key);for(const id of item.entryIds)ids.add(id as string);
  groups.push({key:item.key,workDate:item.workDate,workType:item.workType as import('../types').WorkType,entryIds:[...item.entryIds] as string[],
   hoursExact,projectId:item.projectId as string|null,clientName:item.clientName as string|null,category:item.category as string|null});
 }
 return {version:'exact-entry-content/1',groups};
};
export const normalizeDuplicateCheckSummary=(value:unknown,entryCount:number):DuplicateEntryCheckSummary|undefined=>
 object(value)&&value.version==='exact-entry-content/1'&&Number.isInteger(value.groupCount)&&Number(value.groupCount)>=0&&Number(value.groupCount)<=Math.floor(entryCount/2)
 ?{version:'exact-entry-content/1',groupCount:Number(value.groupCount)}:undefined;
