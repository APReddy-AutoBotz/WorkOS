import {canonicalHours,compareHours} from './work-hours.mjs';
import {validCapabilityDate,capabilityLabel as validCapabilityLabel} from './workforce-capabilities.mjs';
export const ASSIGNMENT_VERSION='assignment-version/1';
export const validAssignmentQuantity=v=>{try{return typeof v==='string'&&v.length<=100&&canonicalHours(v)===v&&compareHours(v,'0')>=0&&compareHours(v,'200')<=0;}catch{return false;}};
export const validAssignmentDefinition=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v))&&Object.keys(v).sort().join(',')===['role','quantityUnit','quantityExact','startsOn','endsOn','billable','status','comment'].sort().join(',')
 &&(v.role===null||validCapabilityLabel(v.role))&&v.quantityUnit==='percentage'&&validAssignmentQuantity(v.quantityExact)&&validCapabilityDate(v.startsOn)&&validCapabilityDate(v.endsOn)&&v.endsOn>=v.startsOn&&typeof v.billable==='boolean'&&['Active','Paused','Completed'].includes(v.status)
 &&(v.comment===null||typeof v.comment==='string'&&v.comment.length>0&&v.comment.length<=3000&&v.comment.trim()===v.comment&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v.comment));
export const assignmentActivePercentage=(snapshot,date)=>snapshot.status==='Active'&&snapshot.startsOn<=date&&date<=snapshot.endsOn?snapshot.quantityExact:'0';
