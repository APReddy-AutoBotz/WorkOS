import {canonicalHours,compareHours} from '../../shared/work-hours.mjs';
import type {OvertimeWarning} from '../types';
export type ImportOvertimeWarnings={employeeId:string;weekEnding:string;warnings:OvertimeWarning[]};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export const normalizeOvertimeWarnings=(value:unknown):OvertimeWarning[]|undefined=>{
 if(!Array.isArray(value))return undefined;const result:OvertimeWarning[]=[],seen=new Set();
 for(const raw of value){
  if(!object(raw)||raw.version!=='overtime-capture/1'||(raw.action!=='warn'&&raw.action!=='block')||(raw.kind!=='daily'&&raw.kind!=='weekly')||typeof raw.policyId!=='string'||!raw.policyId||typeof raw.periodCode!=='string'||!raw.periodCode||typeof raw.threshold!=='string'
   ||(raw.kind==='daily'?!date(raw.workDate):raw.workDate!==null))return undefined;
  let threshold;try{threshold=canonicalHours(raw.threshold);if(compareHours(threshold,'0')<=0||compareHours(threshold,raw.kind==='daily'?'24':'168')>0)return undefined;}catch{return undefined;}
  const key=JSON.stringify([raw.policyId,raw.periodCode,raw.kind,raw.workDate]);if(seen.has(key))return undefined;seen.add(key);
  result.push({version:'overtime-capture/1',policyId:raw.policyId,periodCode:raw.periodCode,kind:raw.kind,workDate:raw.workDate,action:raw.action,threshold} as OvertimeWarning);
 }return result;
};
export const normalizeImportOvertimeWarnings=(value:unknown):ImportOvertimeWarnings[]|undefined=>{
 if(!Array.isArray(value))return undefined;const result:ImportOvertimeWarnings[]=[],seen=new Set();
 for(const group of value){if(!object(group)||typeof group.employeeId!=='string'||!group.employeeId||!date(group.weekEnding))return undefined;const warnings=normalizeOvertimeWarnings(group.warnings);if(!warnings)return undefined;const key=JSON.stringify([group.employeeId,group.weekEnding]);if(seen.has(key))return undefined;seen.add(key);result.push({employeeId:group.employeeId,weekEnding:group.weekEnding as string,warnings});}return result;
};
export const importOvertimeNotice=(groups:ImportOvertimeWarnings[]|undefined)=>{
 const count=groups?.reduce((n,group)=>n+group.warnings.length,0)||0;
 return count?` Configured overtime warnings: ${count} threshold conditions. Hours and billability are unchanged; review the affected work periods.`:'';
};
